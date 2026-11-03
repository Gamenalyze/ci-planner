/** Conservative JS/TS workspace discovery. Suggestions never assert complete inputs. */
import path from "node:path";
import { parseDocument } from "yaml";
import { uniqueJSON } from "./json.mjs";
import { patternMatches } from "./planner.mjs";
import { SHA } from "./evidence.mjs";
export { readDependencySnapshot } from "./evidence.mjs";

const excluded =
  /(?:^|\/)(?:node_modules|vendor|fixtures|__fixtures__|\.git)\//;
const source = /\.(?:[cm]?[jt]sx?)$/;
const config =
  /(?:^|\/)(?:tsconfig[^/]*\.json|(?:vite|vitest|webpack|rollup|jest|babel|eslint|next)\.config\.[^/]+|(?:package|turbo|nx)\.json|(?:package-lock|npm-shrinkwrap)\.json|(?:pnpm-lock|pnpm-workspace)\.yaml|yarn\.lock)$/;
const inside = (filename, dir) =>
  !dir || filename === dir || filename.startsWith(dir + "/");

/** Package, literal import, tsconfig reference and build-config edges from one immutable tree. */
export function discoverDependencies({ ref, files }, changes = []) {
  if (
    !SHA.test(ref ?? "") ||
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length > 20000 ||
    !Array.isArray(changes) ||
    changes.length > 20000 ||
    changes.some((p) => typeof p !== "string" || /[\x00-\x1f\\]/.test(p))
  )
    throw Error("Invalid dependency snapshot or changed paths");
  const names = Object.keys(files)
    .filter((n) => !excluded.test(n))
    .sort();
  if (
    names.some(
      (n) =>
        typeof files[n] === "string" &&
        Buffer.byteLength(files[n]) > 256 * 1024,
    ) ||
    names.reduce(
      (sum, n) =>
        sum + (typeof files[n] === "string" ? Buffer.byteLength(files[n]) : 0),
      0,
    ) >
      16 * 1024 * 1024
  )
    throw Error("Dependency source exceeds byte bounds");
  const warnings = [],
    packages = new Map(),
    byName = new Map(),
    edges = new Set();
  const unknown = (file, reason) => {
    if (warnings.length < 2000) warnings.push({ file, reason });
  };
  const json = (name) => {
    try {
      const result = uniqueJSON(files[name]);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw Error();
      return result;
    } catch {
      unknown(name, "unreadable-json-or-jsonc");
      return null;
    }
  };
  for (const name of names.filter((n) => /(?:^|\/)package\.json$/.test(n))) {
    const manifest = json(name);
    if (!manifest) continue;
    const dir =
      path.posix.dirname(name) === "." ? "" : path.posix.dirname(name);
    const pkg = {
      dir,
      manifest,
      name: typeof manifest.name === "string" ? manifest.name : name,
    };
    packages.set(dir, pkg);
    if (byName.has(pkg.name)) unknown(name, "duplicate-package-name");
    else byName.set(pkg.name, pkg);
  }
  if (packages.size > 500)
    throw Error("Dependency discovery exceeds 500 packages");
  const sorted = [...packages.keys()].sort((a, b) => b.length - a.length);
  const owner = (name) => sorted.find((dir) => inside(name, dir));
  const edge = (from, to) => {
    if (from !== undefined && to !== undefined && from !== to)
      edges.add(JSON.stringify([from, to]));
    if (edges.size > 10000) throw Error("Dependency graph exceeds 10000 edges");
  };
  let workspacePatterns = packages.get("")?.manifest.workspaces;
  if (workspacePatterns && !Array.isArray(workspacePatterns))
    workspacePatterns = workspacePatterns.packages;
  if (Object.hasOwn(files, "pnpm-workspace.yaml")) {
    try {
      const doc = parseDocument(files["pnpm-workspace.yaml"], {
        uniqueKeys: true,
      });
      if (doc.errors.length || doc.warnings.length) throw Error();
      workspacePatterns = doc.toJS({ maxAliasCount: 50 }).packages;
    } catch {
      unknown("pnpm-workspace.yaml", "unsupported-workspace-config");
    }
  }
  if (
    workspacePatterns !== undefined &&
    (!Array.isArray(workspacePatterns) || workspacePatterns.length > 200)
  ) {
    unknown("package.json", "unsupported-workspace-patterns");
    workspacePatterns = [];
  }
  for (const pkg of packages.values()) {
    pkg.workspace = pkg.dir === "";
    try {
      pkg.workspace ||=
        workspacePatterns?.some((p) => patternMatches(p, pkg.dir)) ?? false;
    } catch {
      unknown("package.json", "unsupported-workspace-pattern");
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = pkg.manifest[field];
      if (deps && (typeof deps !== "object" || Array.isArray(deps))) {
        unknown(pkg.dir + "/package.json", "invalid-dependencies");
        continue;
      }
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (byName.has(name)) edge(pkg.dir, byName.get(name).dir);
        else if (
          typeof spec === "string" &&
          /^(?:file|link|workspace):/.test(spec)
        ) {
          const target = path.posix.normalize(
            path.posix.join(pkg.dir, spec.replace(/^(?:file|link):/, "")),
          );
          if (packages.has(target)) edge(pkg.dir, target);
          else unknown(pkg.dir + "/package.json", "unresolved-local-package");
        }
      }
    }
  }
  const resolves = (from, spec) => {
    if (spec.startsWith(".")) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(from), spec),
      );
      const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
      const candidates = [
        target,
        ...[
          ".ts",
          ".tsx",
          ".mts",
          ".cts",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".json",
        ].flatMap((ext) => [stem + ext, target + "/index" + ext]),
      ];
      const found = candidates.filter((n) => Object.hasOwn(files, n));
      if (!found.length) unknown(from, "unresolved-relative-import");
      for (const name of found) edge(owner(from), owner(name));
    } else if (!spec.startsWith("node:")) {
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (byName.has(name)) edge(owner(from), byName.get(name).dir);
      else if (
        !packages.get(owner(from))?.manifest.dependencies?.[name] &&
        !packages.get(owner(from))?.manifest.devDependencies?.[name] &&
        !/^(?:fs|path|url|util|assert|crypto|os|stream|events|buffer|module|http|https|child_process)(?:\/|$)/.test(
          name,
        )
      )
        unknown(from, "unresolved-bare-import-or-alias");
    }
  };
  for (const name of names) {
    const text = files[name];
    if ((source.test(name) || config.test(name)) && typeof text !== "string") {
      unknown(name, "unreadable-source-or-config");
      continue;
    }
    if (typeof text !== "string") continue;
    if (source.test(name)) {
      // This is deliberately an over-approximation, not a JavaScript evaluator.
      for (const m of text.matchAll(
        /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"'\r\n]+)["']/g,
      ))
        resolves(name, m[1]);
      if (
        /\b(?:import|require)\s*\(\s*(?!\s*["'])/.test(text) ||
        /import\.meta\.glob|require\.context|\beval\s*\(/.test(text)
      )
        unknown(name, "dynamic-module-or-file-discovery");
      if (/\b(?:readFile|readdir|glob|fetch)\s*\(/.test(text))
        unknown(name, "runtime-file-or-network-input");
    }
    if (/(?:^|\/)tsconfig[^/]*\.json$/.test(name)) {
      const cfg = json(name);
      const targets = [
        cfg?.extends,
        ...(Array.isArray(cfg?.references)
          ? cfg.references.map((r) => r?.path)
          : []),
      ].filter(Boolean);
      for (const target of targets) {
        if (typeof target !== "string") {
          unknown(name, "dynamic-tsconfig-reference");
          continue;
        }
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(name), target),
        );
        edge(owner(name), owner(resolved));
      }
      if (cfg?.compilerOptions?.paths || cfg?.compilerOptions?.baseUrl)
        unknown(name, "typescript-aliases-require-owner-review");
    }
  }
  const linked = [...edges].map((e) => JSON.parse(e)).sort();
  const affected = new Set(changes.map(owner).filter((p) => p !== undefined));
  // Unknown paths and shared root build configuration can affect every workspace.
  if (
    changes.some(
      (name) =>
        owner(name) === undefined || (owner(name) === "" && config.test(name)),
    )
  )
    for (const dir of sorted) affected.add(dir);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [consumer, producer] of linked)
      if (affected.has(producer) && !affected.has(consumer)) {
        affected.add(consumer);
        grew = true;
      }
  }
  const records = [...packages.values()]
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map((pkg) => {
      const dependencies = new Set([pkg.dir]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [from, to] of linked)
          if (dependencies.has(from) && !dependencies.has(to)) {
            dependencies.add(to);
            grew = true;
          }
      }
      return {
        name: pkg.name,
        directory: pkg.dir || ".",
        workspace: pkg.workspace,
        dependencies: [...dependencies]
          .filter((d) => d !== pkg.dir)
          .sort()
          .map((d) => d || "."),
        suggestedInputs: [
          ...new Set(
            [...dependencies].sort().map((d) => (d ? d + "/**" : "**")),
          ),
        ],
        inputsComplete: false,
        affected: affected.has(pkg.dir),
      };
    });
  return {
    schemaVersion: 1,
    mode: "dependency-discovery",
    ref,
    packages: records,
    edges: linked.map(([from, to]) => ({ from: from || ".", to: to || "." })),
    sharedInputs: names.filter((n) => config.test(n) && owner(n) === ""),
    warnings,
    affectedPackages: records.filter((p) => p.affected).map((p) => p.directory),
    limitations: [
      "Static discovery is an over-approximation, not complete JS/TS analysis. Review dynamic imports, aliases, generated files and runtime inputs.",
      "Suggested inputs never enable enforcement or mark a contract complete. Shared config and lockfiles still require owner review.",
    ],
  };
}
