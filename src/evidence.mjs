/** Bounded immutable Git and JSON readers shared by the optional evidence tools. */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { uniqueJSON } from "./json.mjs";

export const SHA = /^[0-9a-f]{40}$/;
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
  } catch {
    throw Error("Git evidence unavailable; fetch the required commits");
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
  if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry))
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
  const entries = gitRead(root, ["ls-tree", "-r", "-z", "--full-tree", sha])
    .split("\0")
    .filter(Boolean);
  if (entries.length > 20000)
    throw Error("Dependency discovery exceeds 20000 files");
  const files = Object.create(null);
  let bytes = 0,
    reads = 0;
  for (const line of entries) {
    const m = /^(\d+) (\w+) [0-9a-f]{40}\t([\s\S]+)$/.exec(line);
    if (!m) throw Error("Invalid Git inventory");
    const [, mode, type, name] = m;
    files[name] = null;
    if (/(?:^|\/)(?:node_modules|vendor|\.git)\//.test(name)) continue;
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(name)) continue;
    if (!/^(?:100644|100755)$/.test(mode) || type !== "blob") continue;
    if (++reads > 2000)
      throw Error("Dependency discovery exceeds 2000 text files");
    const text = gitRead(root, ["show", sha + ":" + name], 256 * 1024);
    bytes += Buffer.byteLength(text);
    if (bytes > 16 * 1024 * 1024)
      throw Error("Dependency discovery exceeds 16 MiB");
    files[name] = text;
  }
  return { ref: sha, files };
}
