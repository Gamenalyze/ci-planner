/** Bounded immutable Git and JSON readers shared by the optional evidence tools. */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { uniqueJSON } from "./json.mjs";

import { SHA } from "./validation.mjs";
export { SHA } from "./validation.mjs";
export const HASH = /^[0-9a-f]{64}$/;
export const integer = (n) => Number.isSafeInteger(n) && n > 0;
export function gitRead(root, args, maxBuffer = 8 * 1024 * 1024) {
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOBUFS")
      throw Error("Git output exceeds the configured byte limit");
    if (error.code === "ETIMEDOUT") throw Error("Git evidence read timed out");
    throw Error(
      "Git evidence read failed; verify repository, object and path availability",
    );
  }
}
export function readJSONFile(filename, maximum = 4 * 1024 * 1024) {
  if (!filename) throw Error("Expected an input JSON file");
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > maximum)
    throw Error("Input exceeds file bounds");
  const bytes = fs.readFileSync(filename);
  if (bytes.length > maximum) throw Error("Input exceeds file bounds");
  try {
    return uniqueJSON(bytes.toString("utf8"));
  } catch {
    throw Error("Invalid JSON evidence; object keys must be unique");
  }
}
export function commitTree(root, sha) {
  if (
    !SHA.test(sha ?? "") ||
    gitRead(root, ["cat-file", "-t", sha]).trim() !== "commit"
  )
    throw Error("Expected an available full commit SHA");
  return gitRead(root, ["rev-parse", sha + "^{tree}"]).trim();
}
export function trackedText(root, sha, filename) {
  commitTree(root, sha);
  const entry = gitRead(root, ["ls-tree", sha, "--", filename]).trim();
  if (!/^100(?:644|755) blob (?:[0-9a-f]{40}|[0-9a-f]{64})\t/.test(entry))
    throw Error("Expected a regular tracked evidence file");
  return gitRead(root, ["show", sha + ":" + filename], 256 * 1024);
}

/** Read JS/TS and build inputs without running parsers, configs or package scripts from the repo. */
export function readDependencySnapshot({ root = ".", ref = "HEAD" } = {}) {
  if (ref !== "HEAD" && !SHA.test(ref))
    throw Error("Expected HEAD or full commit SHA");
  const sha = gitRead(root, [
    "rev-parse",
    "--verify",
    ref + "^{commit}",
  ]).trim();
  const entries = gitRead(root, [
    "ls-tree",
    "-r",
    "-l",
    "-z",
    "--full-tree",
    sha,
  ])
    .split("\0")
    .filter(Boolean);
  if (entries.length > 20000)
    throw Error("Dependency discovery exceeds 20000 files");
  // Read package/config facts first so a large generated tree cannot consume
  // the bounded budget before workspace relationships are discovered.
  const priority = (entry) => {
    const name = entry.slice(entry.indexOf("\t") + 1);
    if (/(?:^|\/)package\.json$/.test(name)) return 0;
    if (/(?:^|\/)(?:tsconfig[^/]*\.json|pnpm-workspace\.yaml)$/.test(name))
      return 1;
    return /\.(?:[cm]?[jt]sx?)$/.test(name) ? 2 : 3;
  };
  entries.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const files = Object.create(null);
  const unreadable = [];
  let bytes = 0,
    reads = 0;
  for (const line of entries) {
    const m = /^(\d+) (\w+) (?:[0-9a-f]{40}|[0-9a-f]{64})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
    if (!m) throw Error("Invalid Git inventory");
    const [, mode, type, rawSize, name] = m;
    files[name] = null;
    if (/(?:^|\/)(?:node_modules|vendor|\.git)\//.test(name)) continue;
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(name)) continue;
    if (!/^(?:100644|100755)$/.test(mode) || type !== "blob") continue;
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0)
      throw Error("Invalid Git blob size");
    if (size > 256 * 1024) {
      unreadable.push({ file: name, reason: "oversized-text-file", size });
      continue;
    }
    if (reads >= 2000 || bytes + size > 16 * 1024 * 1024) {
      unreadable.push({
        file: name,
        reason: reads >= 2000 ? "text-file-budget" : "source-byte-budget",
        size,
      });
      continue;
    }
    reads++;
    const text = gitRead(root, ["show", sha + ":" + name], 256 * 1024 + 1);
    const decodedBytes = Buffer.byteLength(text);
    if (decodedBytes > 256 * 1024 || bytes + decodedBytes > 16 * 1024 * 1024) {
      unreadable.push({ file: name, reason: "source-byte-budget", size });
      continue;
    }
    bytes += decodedBytes;
    files[name] = text;
  }
  return { ref: sha, files, unreadable };
}
