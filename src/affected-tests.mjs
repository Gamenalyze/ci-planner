/** Static JavaScript import selection. Unknown semantics always select the full suite. */
import path from "node:path";
import { parse } from "../vendor/acorn/dist/acorn.mjs";
import { SHA } from "./validation.mjs";
import { uniqueJSON } from "./json.mjs";
const source = /\.(?:[cm]?js|[jt]sx?|[cm]ts)$/;
const testFile =
  /(?:\.(?:test|spec)\.[cm]?js$|(?:^|\/)__tests__\/.*\.[cm]?js$)/;
const excluded = /(?:^|\/)(?:node_modules|vendor|\.git)\//;
const configuration =
  /(?:^|\/)(?:(?:jest|vitest|vite|babel|webpack|rollup|next)\.config\.|\.(?:babelrc|swcrc)|tsconfig|jsconfig|.*(?:setup|globalSetup|globalTeardown)[^.]*\.[cm]?[jt]s)/i;

/** Parse without executing configs, transforms, imports, repository code or npm. */
export function javascriptGraph({ ref, files }) {
  if (
    !SHA.test(ref ?? "") ||
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length > 20000
  )
    throw Error("Invalid affected-test snapshot");
  const names = Object.keys(files)
    .filter((n) => !excluded.test(n))
    .sort();
  if (
    names.some(
      (n) =>
        n.length > 1000 ||
        n.startsWith("/") ||
        n.split("/").includes("..") ||
        /[\\\x00-\x1f]/.test(n),
    )
  )
    throw Error("Invalid source path");
  let bytes = 0;
  for (const name of names)
    if (typeof files[name] === "string") {
      const size = Buffer.byteLength(files[name]);
      bytes += size;
      if (size > 256 * 1024 || bytes > 16 * 1024 * 1024)
        throw Error("Affected-test source exceeds byte bounds");
    }
  const edges = new Map(),
    warnings = [];
  const warn = (file, reason) => {
    if (warnings.length < 2000) warnings.push({ file, reason });
  };
  const manifests = names.filter((n) => /(?:^|\/)package\.json$/.test(n));
  let manifest = {};
  if (manifests.length !== 1 || manifests[0] !== "package.json")
    warn("package.json", "single-root-package-required");
  try {
    manifest = uniqueJSON(files["package.json"]);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw Error();
  } catch {
    warn("package.json", "unreadable-package-manifest");
    manifest = {};
  }
  if (
    manifest.workspaces ||
    manifest.imports ||
    manifest.jest ||
    manifest.vitest ||
    (manifest.type && manifest.type !== "module")
  )
    warn("package.json", "package-resolution-or-test-configuration");
  for (const name of names) {
    if (configuration.test(name)) warn(name, "test-or-transform-configuration");
    if (!source.test(name)) continue;
    edges.set(name, new Set());
    if (!/\.(?:mjs|js)$/.test(name) || typeof files[name] !== "string") {
      warn(name, "unsupported-or-unreadable-source");
      continue;
    }
    let ast;
    try {
      ast = parse(files[name], { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      warn(name, "unsupported-javascript-syntax");
      continue;
    }
    const stack = [ast];
    let visits = 0;
    while (stack.length) {
      if (++visits > 100000) {
        warn(name, "ast-budget");
        break;
      }
      const node = stack.pop();
      if (node.type === "ImportExpression") warn(name, "dynamic-import");
      if (
        node.type === "MemberExpression" &&
        (node.computed ||
          ["constructor", "toMatchSnapshot", "toMatchFileSnapshot"].includes(
            node.property?.name,
          ))
      )
        warn(name, "reflection-or-runtime-snapshot-input");
      if (node.type === "MetaProperty") warn(name, "runtime-module-metadata");
      if (
        node.type === "Identifier" &&
        /^(?:require|eval|Function|process|fetch|XMLHttpRequest|global|globalThis|__dirname|__filename|jest|vi|Reflect)$/.test(
          node.name,
        )
      )
        warn(name, "runtime-file-environment-or-mocking-input");
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
        ].includes(node.type) &&
        node.source
      ) {
        const spec = node.source.value;
        if (typeof spec !== "string") warn(name, "unknown-module-specifier");
        else if (spec.startsWith(".")) {
          const stem = path.posix.normalize(
            path.posix.join(path.posix.dirname(name), spec),
          );
          const matches = [
            stem,
            stem + ".js",
            stem + ".mjs",
            stem + "/index.js",
            stem + "/index.mjs",
          ].filter((n) => Object.hasOwn(files, n));
          if (
            matches.length !== 1 ||
            !/\.[cm]?js$/.test(matches[0]) ||
            excluded.test(matches[0]) ||
            typeof files[matches[0]] !== "string"
          )
            warn(name, "unresolved-or-ambiguous-relative-import");
          else edges.get(name).add(matches[0]);
        } else {
          const pkg = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0];
          if (
            /^(?:node:)?(?:fs|path|os|http|https|net|child_process|module|url|worker_threads)(?:\/|$)/.test(
              spec,
            )
          )
            warn(name, "runtime-file-or-network-module");
          else if (
            !["vitest", "@jest/globals"].includes(pkg) &&
            !/^node:(?:assert|util|events|buffer|string_decoder)$/.test(spec)
          )
            warn(name, "external-module-or-alias-inputs-unmodeled");
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value))
          for (const child of value) {
            if (child && typeof child.type === "string") stack.push(child);
          }
        else if (value && typeof value.type === "string") stack.push(value);
      }
    }
  }
  return {
    edges,
    warnings,
    tests: names.filter((n) => testFile.test(n)),
    manifest,
  };
}

/** A single conservative matrix row, usable without expanding untrusted paths into shell code. */
export function selectAffectedTests(
  snapshot,
  changes,
  { runner = "vitest" } = {},
) {
  if (
    !["jest", "vitest"].includes(runner) ||
    !Array.isArray(changes) ||
    changes.length > 20000 ||
    changes.some(
      (n) =>
        typeof n !== "string" ||
        n.length > 1000 ||
        n.startsWith("/") ||
        n.split("/").includes("..") ||
        /[\\\x00-\x1f]/.test(n),
    )
  )
    throw Error("Invalid runner or changes");
  const graph = javascriptGraph(snapshot),
    reasons = [...graph.warnings];
  for (const name of changes)
    if (!graph.edges.has(name))
      reasons.push({
        file: name,
        reason: Object.hasOwn(snapshot.files, name)
          ? "non-source-or-global-input"
          : "deleted-or-unknown-input",
      });
  if (!graph.tests.length)
    reasons.push({ file: null, reason: "no-recognized-tests" });
  const reverse = new Map();
  for (const [file, deps] of graph.edges)
    for (const dependency of deps) {
      if (!reverse.has(dependency)) reverse.set(dependency, []);
      reverse.get(dependency).push(file);
    }
  const affected = new Set(changes),
    queue = [...changes];
  for (let i = 0; i < queue.length; i++)
    for (const file of reverse.get(queue[i]) ?? [])
      if (!affected.has(file)) {
        affected.add(file);
        queue.push(file);
      }
  let runAll = reasons.length > 0;
  let selected = runAll
    ? graph.tests
    : graph.tests.filter((n) => affected.has(n));
  if (
    !runAll &&
    (selected.length > 1000 ||
      Buffer.byteLength(JSON.stringify(selected)) > 32 * 1024)
  ) {
    runAll = true;
    reasons.push({ file: null, reason: "selected-argument-budget" });
    selected = graph.tests;
  }
  const row = {
    schemaVersion: 1,
    mode: "affected-tests-advisory",
    runner,
    runAll,
    tests: runAll ? [] : selected,
  };
  return {
    schemaVersion: 1,
    mode: "affected-tests-advisory",
    ref: snapshot.ref,
    inputsComplete: false,
    runAll,
    runner,
    tests: selected,
    matrix: { include: [row] },
    reasons: reasons.slice(0, 2000),
    limitations: [
      "Only default single-package JavaScript ESM import graphs are narrowed. TypeScript, JSX, configs, aliases, dynamic/runtime inputs and deleted/unknown paths run all tests.",
      "This report does not authorize planner enforcement. The consumer must run all on missing, failed or unrecognized selection.",
    ],
  };
}
