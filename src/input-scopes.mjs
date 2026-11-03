/** Per-job invocation/import suggestions. Every result remains incomplete. */
import path from "node:path";
import { parseDocument } from "../vendor/yaml/dist/index.js";
import { javascriptGraph } from "./affected-tests.mjs";
import { uniqueJSON } from "./json.mjs";
export function suggestJobInputs(snapshot, graph, fallback) {
  const names = Object.keys(snapshot.files),
    result = {};
  const imports = javascriptGraph(snapshot);
  for (const [key, job] of graph) {
    const inputs = new Set([job.workflow]),
      reasons = [];
    const add = (name) => {
      if (name && !/[\\\x00-\x20?\[\]{}!]/.test(name)) inputs.add(name);
      else reasons.push("unrepresentable-path");
    };
    const visit = (name) => {
      const pending = [name],
        seen = new Set();
      while (pending.length) {
        const next = pending.pop();
        if (seen.has(next)) continue;
        seen.add(next);
        add(next);
        pending.push(...(imports.edges.get(next) ?? []));
      }
      if (imports.warnings.some((w) => seen.has(w.file)))
        reasons.push("unmodeled-runtime-import-inputs");
    };
    const command = (text, cwd, stack = new Set()) => {
      if (typeof text !== "string" || /[|;&\x60\n$<>]/.test(text)) {
        reasons.push("opaque-command");
        return;
      }
      const parts = text.trim().split(/\s+/);
      let cmd = parts.shift();
      const resolve = (p) => path.posix.normalize(path.posix.join(cwd, p));
      if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
        if (["ci", "install"].includes(parts[0])) {
          for (const n of names.filter((n) =>
            /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
              n,
            ),
          ))
            add(n);
          return;
        }
        const script = parts[0] === "run" ? parts[1] : parts[0],
          file = resolve("package.json");
        let pkg;
        try {
          pkg = uniqueJSON(snapshot.files[file]);
        } catch {
          reasons.push("missing-script-manifest");
          return;
        }
        if (
          stack.has(file + "#" + script) ||
          stack.size > 10 ||
          typeof pkg.scripts?.[script] !== "string"
        ) {
          reasons.push("unresolved-package-script");
          return;
        }
        add(file);
        const next = new Set(stack).add(file + "#" + script);
        for (const n of cmd === "npm"
          ? ["pre" + script, script, "post" + script]
          : [script])
          if (pkg.scripts?.[n]) command(pkg.scripts[n], cwd, next);
      } else if (cmd === "node" && parts[0] && !parts[0].startsWith("-")) {
        const file = resolve(parts[0]);
        if (imports.edges.has(file)) visit(file);
        else reasons.push("unresolved-node-entry");
        // Arguments may be runtime files; only known tracked literals are suggested.
        for (const arg of parts.slice(1))
          if (Object.hasOwn(snapshot.files, resolve(arg))) add(resolve(arg));
          else reasons.push("unmodeled-node-argument");
      } else if (
        ["jest", "vitest"].includes(cmd) ||
        (cmd === "node" && parts.includes("--test"))
      ) {
        for (const file of imports.tests) visit(file);
        if (imports.warnings.length || !imports.tests.length)
          reasons.push("incomplete-test-import-graph");
      } else if (["eslint", "prettier", "tsc"].includes(cmd)) {
        const targets = parts.filter((n) => !n.startsWith("-"));
        if (!targets.length || targets.some((n) => n === "." || /[*?]/.test(n)))
          reasons.push("broad-tool-target");
        else
          for (const target of targets) {
            const file = resolve(target);
            if (Object.hasOwn(snapshot.files, file)) add(file);
            else if (names.some((n) => n.startsWith(file + "/")))
              add(file + "/**");
            else reasons.push("unresolved-tool-target");
          }
      } else reasons.push("unmodeled-invocation");
    };
    try {
      const doc = parseDocument(snapshot.files[job.workflow]).toJS({
        maxAliasCount: 100,
      });
      const entry = doc.jobs[job.id];
      if (!Array.isArray(entry.steps)) throw Error();
      for (const step of entry.steps) {
        if (
          step.uses &&
          !/^actions\/(?:checkout|setup-node|cache)@/.test(step.uses)
        )
          reasons.push("opaque-action");
        if (step.run) {
          const cwd =
            step["working-directory"] ??
            entry.defaults?.run?.["working-directory"] ??
            doc.defaults?.run?.["working-directory"] ??
            "";
          if (
            typeof cwd !== "string" ||
            /[$\x60]|(?:^|\/)\.\.(?:\/|$)|^\//.test(cwd)
          )
            reasons.push("dynamic-working-directory");
          else command(step.run, cwd);
        }
      }
      for (const n of names.filter((n) =>
        /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|(?:eslint|jest|vitest|vite|babel)\.config\.[^/]+|pnpm-lock\.yaml|yarn\.lock)$/.test(
          n,
        ),
      ))
        add(n);
    } catch {
      reasons.push("unavailable-job-invocations");
    }
    if (inputs.size > 200) reasons.push("scope-pattern-budget");
    result[key] = {
      inputsComplete: false,
      inputs: reasons.length ? fallback : [...inputs].sort(),
      basis: reasons.length
        ? "inventory-fallback"
        : "invocation-and-static-imports",
      warnings: [...new Set(reasons)],
      requiresOwnerReview: true,
    };
  }
  return result;
}
