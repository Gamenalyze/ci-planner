/**
 * Repository-aware completeness audit. No repository commands are executed.
 * Covered means a recognized blocking PR invocation, not successful execution or test quality.
 * Unknown wrappers and conditional checks remain visible as uncertain evidence.
 */
import path from "node:path";
import { gitRead } from "./evidence.mjs";
import { parseDocument } from "../vendor/yaml/dist/index.js";
import { uniqueJSON } from "./json.mjs";
import { SHA, WORKFLOW } from "./validation.mjs";
const WF = (p) => WORKFLOW.test(p);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb)$/;
const TEST = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;
const SETUP =
  /^(?:actions\/(?:checkout|setup-node|setup-python|setup-go|cache|upload-artifact|download-artifact)|pnpm\/action-setup|oven-sh\/setup-bun|docker\/setup-(?:buildx|qemu)-action)@/;
const RULES = {
  tests: /^(?:jest|vitest|mocha|ava|tap|playwright|pytest)$/,
  lint: /^(?:eslint|standard|biome|ruff)$/,
  typecheck: /^(?:tsc|vue-tsc|mypy|pyright)$/,
  build: /^(?:tsc|vite|webpack|rollup|esbuild|next|nest)$/,
  format: /^(?:prettier|biome)$/,
  "secret-scan": /^(?:gitleaks|trufflehog)$/,
  "workflow-lint": /^actionlint$/,
};
const conditionalIf = (value) =>
  value !== undefined &&
  ![
    true,
    "success()",
    "always()",
    String.fromCharCode(36) + "{{ success() }}",
    String.fromCharCode(36) + "{{ always() }}",
  ].includes(value);
function directory(cwd, value) {
  const p = path.posix.normalize(path.posix.join(cwd, value));
  return /[$\x60]/.test(value) ||
    p === ".." ||
    p.startsWith("../") ||
    path.posix.isAbsolute(value)
    ? null
    : p === "."
      ? ""
      : p;
}

/** Analyze a bounded immutable snapshot; retain locations, never raw commands or secret values. */
export function auditRepositorySnapshot({ ref, files }) {
  if (
    !SHA.test(ref ?? "") ||
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length > 20000
  )
    throw Error("Invalid repository snapshot");
  const names = Object.keys(files).sort(),
    packages = new Map(),
    observations = [],
    uncertainties = [],
    warnings = [],
    active = new Set();
  let visits = 0;
  for (const name of names.filter(
    (p) =>
      /(?:^|\/)package\.json$/.test(p) &&
      !/(?:^|\/)(?:node_modules|vendor|fixtures|__fixtures__)\//.test(p),
  )) {
    try {
      const manifest = uniqueJSON(files[name]);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw Error();
      packages.set(
        path.posix.dirname(name) === "." ? "" : path.posix.dirname(name),
        { name, manifest },
      );
    } catch {
      throw Error("Invalid package manifest: " + name);
    }
  }
  const observe = (kind, cwd, location, conditional = false, details = {}) =>
    observations.push({
      kind,
      package: packages.get(cwd)?.name ?? null,
      location,
      conditional,
      scope: cwd,
      ...details,
    });
  const unknown = (location, reason, cwd) =>
    uncertainties.push({
      location,
      reason,
      package: packages.get(cwd)?.name ?? null,
    });
  function yaml(name) {
    if (typeof files[name] !== "string") throw Error();
    const doc = parseDocument(files[name], { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw Error();
    return doc.toJS({ maxAliasCount: 100 });
  }
  function commands(source, cwd, at, weak = false, stack = new Set()) {
    if (typeof source !== "string") {
      unknown(at, "unavailable-command", cwd);
      return;
    }
    const complex =
      /\$(?:\{|[A-Za-z_])|(?:^|[;\n&])\s*false\b|(?:^|[;\n])\s*(?:if|for|while|until|case|function|trap|alias|exec)\b|<<|\x60|\$\(|\|\||\|(?!\|)|(?:^|\s)set\s+\+e\b/.test(
        source,
      );
    for (const raw of source.split(/\n|&&|;|\|(?!\|)/)) {
      const line = raw.trim();
      if (/^[A-Za-z_]\w*=\$\(mktemp(?:\s[^)]*)?\)$/.test(line)) continue;
      if (!line || line.startsWith("#")) continue;
      let tokens =
        line
          .match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)
          ?.map((v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v)) ?? [];
      while (tokens.length && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
      let cmd = tokens.shift();
      if (!cmd) continue;
      if (cmd === "cd") {
        cwd = tokens[0] ? directory(cwd, tokens[0]) : null;
        if (cwd === null) {
          unknown(at, "dynamic-working-directory", "");
          return;
        }
        continue;
      }
      if (cmd === "exit" || cmd === "return") return;
      if (
        [
          "echo",
          "printf",
          "true",
          "false",
          "exit",
          "set",
          "export",
          "mkdir",
          "tar",
          "chmod",
          "curl",
          "sha256sum",
          "git",
          "ls",
          "pwd",
          "which",
          "command",
        ].includes(cmd)
      )
        continue;
      if (tokens.includes("--help") || tokens.includes("--version")) continue;
      if (cmd === "npx" || cmd === "exec") {
        cmd = tokens.shift();
        if (tokens[0] === "--") tokens.shift();
      }
      if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
        if (
          ["ci", "install", "i", "pack"].includes(tokens[0]) &&
          tokens.includes("--ignore-scripts")
        )
          continue;
        let target = cwd;
        const prefix = tokens.findIndex((t) =>
          ["--prefix", "--dir", "-C", "--cwd"].includes(t),
        );
        if (prefix >= 0) {
          target = directory(cwd, tokens[prefix + 1] ?? "");
          tokens.splice(prefix, 2);
        }
        if (
          target === null ||
          tokens.some((t) =>
            /^(?:-w|--workspace|--workspaces|--filter)(?:=|$)/.test(t),
          )
        ) {
          unknown(at, "workspace-selector-needs-review", cwd);
          continue;
        }
        if (
          tokens[0] === "audit" ||
          (tokens[0] === "npm" && tokens[1] === "audit")
        ) {
          observe("dependency-audit", target, at, weak || complex);
          continue;
        }
        if (["ci", "install", "i"].includes(tokens[0])) continue;
        if (
          tokens.some((t) =>
            /^--(?:help|version|listTests|list|showConfig|dry-run)$/.test(t),
          )
        ) {
          unknown(at, "non-validation-arguments", target);
          continue;
        }
        const task = tokens[0] === "run" ? tokens[1] : tokens[0];
        if (tokens[0] === "exec") {
          cmd = tokens[1];
          tokens = tokens.slice(2);
        } else {
          const pkg = packages.get(target),
            script = pkg?.manifest.scripts?.[task],
            key = target + "#" + task;
          if (
            typeof script !== "string" ||
            stack.has(key) ||
            stack.size >= 10
          ) {
            unknown(at, "unresolved-or-cyclic-package-script", target);
            continue;
          }
          const next = new Set(stack);
          next.add(key);
          const tasks =
            cmd === "npm" && !tokens.includes("--ignore-scripts")
              ? ["pre" + task, task, "post" + task]
              : [task];
          for (const name of tasks)
            if (typeof pkg.manifest.scripts?.[name] === "string")
              commands(
                pkg.manifest.scripts[name],
                target,
                { ...at, package: pkg.name, script: name },
                weak || complex,
                next,
              );
          continue;
        }
      }
      if (["bash", "sh", "source", "."].includes(cmd)) {
        const file = tokens.find((t) => !t.startsWith("-")),
          name = file ? directory(cwd, file) : null;
        if (
          !name ||
          typeof files[name] !== "string" ||
          stack.has(name) ||
          stack.size >= 10
        ) {
          unknown(at, "unresolved-shell-wrapper", cwd);
          continue;
        }
        const next = new Set(stack);
        next.add(name);
        commands(
          files[name],
          cwd,
          { ...at, file: name },
          weak || complex,
          next,
        );
        continue;
      }
      if (["python", "python3"].includes(cmd) && tokens[0] === "-m") {
        cmd = tokens[1];
        tokens = tokens.slice(2);
      }
      let recognized = false;
      if (cmd === "go" && ["test", "vet", "build"].includes(tokens[0])) {
        recognized = true;
        if (tokens.some((t) => /^-(?:list|n)(?:=|$)/.test(t)))
          unknown(at, "non-validation-arguments", cwd);
        else
          observe(
            { test: "tests", vet: "lint", build: "build" }[tokens[0]],
            cwd,
            at,
            weak ||
              complex ||
              !tokens.includes("./...") ||
              tokens.some((t) => /^-(?:run|skip|exec)(?:=|$)/.test(t)),
            { language: "go" },
          );
      }
      if (["pip-audit", "govulncheck"].includes(cmd)) {
        recognized = true;
        observe("dependency-audit", cwd, at, weak || complex, {
          language: cmd === "pip-audit" ? "python" : "go",
        });
      }
      if (cmd === "golangci-lint" && tokens[0] === "run") {
        recognized = true;
        observe("lint", cwd, at, weak || complex, { language: "go" });
      }
      if (cmd === "compileall") {
        recognized = true;
        observe("syntax", cwd, at, weak || complex, { language: "python" });
      }
      if (cmd === "hadolint") {
        recognized = true;
        for (const token of tokens.filter((t) => !t.startsWith("-"))) {
          const file = directory(cwd, token);
          if (file && Object.hasOwn(files, file))
            observe("container-lint", cwd, at, weak || complex, { file });
          else unknown(at, "unresolved-dockerfile", cwd);
        }
      }
      if (
        tokens.some((t) =>
          /^--(?:listTests|list|showConfig|dry-run|collect-only|co)$/.test(t),
        )
      ) {
        unknown(at, "non-validation-arguments", cwd);
        continue;
      }
      if (cmd === "node" && tokens.includes("--test")) {
        observe("tests", cwd, at, weak || complex);
        recognized = true;
      }
      if (
        cmd === "node" &&
        (tokens.includes("--check") || tokens.includes("--version"))
      ) {
        recognized = true;
        if (tokens.includes("--check"))
          observe("syntax", cwd, at, weak || complex);
      }
      for (const [kind, pattern] of Object.entries(RULES))
        if (pattern.test(cmd ?? "")) {
          recognized = true;
          if (
            kind === "typecheck" &&
            tokens.some((token) =>
              /^--(?:noCheck|transpileOnly)(?:=true)?$/.test(token),
            )
          )
            continue;
          if (
            kind === "format" &&
            !tokens.some((t) => t === "--check" || t === "check")
          )
            continue;
          if (kind === "build" && cmd !== "tsc" && !tokens.includes("build"))
            continue;
          if (cmd === "ruff" && tokens[0] !== "check") continue;
          observe(
            kind,
            cwd,
            at,
            weak ||
              complex ||
              tokens.some((t) => ["--fix", "--write", "-k", "-m"].includes(t)),
            cmd === "pytest" || ["ruff", "mypy", "pyright"].includes(cmd)
              ? { language: "python" }
              : {},
          );
        }
      if (
        cmd === "docker" &&
        (tokens[0] === "build" ||
          (tokens[0] === "buildx" && tokens[1] === "build"))
      ) {
        const start = tokens[0] === "buildx" ? 2 : 1;
        const opts = tokens.slice(start),
          atFile = opts.findIndex((t) => t === "-f" || t === "--file");
        const inlineFile = opts.find((t) => t.startsWith("--file="));
        const file = directory(
          cwd,
          atFile >= 0
            ? (opts[atFile + 1] ?? "")
            : (inlineFile?.slice(7) ?? "Dockerfile"),
        );
        if (file && Object.hasOwn(files, file))
          observe(
            "container-build",
            cwd,
            at,
            weak ||
              complex ||
              opts.some((t) => t === "--target" || t.startsWith("--target=")) ||
              ![".", cwd].includes(opts.at(-1)),
            { file },
          );
        else unknown(at, "unresolved-dockerfile-or-context", cwd);
        recognized = true;
      }
      if (!recognized) unknown(at, "unresolved-command-or-wrapper", cwd);
    }
  }
  function steps(list, cwd, at, weak, depth) {
    if (!Array.isArray(list)) {
      unknown(at, "missing-steps", cwd);
      return;
    }
    for (const [index, step] of list.entries()) {
      if (++visits > 10000) throw Error("Traversal exceeds 10000 steps");
      if (!step || typeof step !== "object") continue;
      const location = { ...at, step: index + 1 },
        conditional =
          weak ||
          (step["continue-on-error"] !== undefined &&
            step["continue-on-error"] !== false) ||
          conditionalIf(step.if);
      const target = step["working-directory"]
        ? directory("", step["working-directory"])
        : typeof cwd === "string"
          ? directory("", cwd)
          : null;
      if (
        target === null ||
        typeof target !== "string" ||
        /[$\x60]/.test(target)
      ) {
        unknown(location, "dynamic-working-directory", "");
        continue;
      }
      if (typeof step.run === "string")
        commands(step.run, target, location, conditional);
      if (typeof step.uses !== "string") continue;
      const use = step.uses;
      if (use.startsWith("./")) {
        const base = use.slice(2),
          name = [
            base ? base + "/action.yml" : "action.yml",
            base ? base + "/action.yaml" : "action.yaml",
          ].find((n) => Object.hasOwn(files, n)),
          key = "action:" + name;
        if (!name || active.has(key) || depth >= 10) {
          unknown(location, "unresolved-local-action", target);
          continue;
        }
        active.add(key);
        try {
          const action = yaml(name);
          if (action.runs?.using !== "composite") throw Error();
          steps(
            action.runs.steps,
            target,
            { ...location, action: name },
            conditional,
            depth + 1,
          );
        } catch {
          unknown(location, "opaque-local-action", target);
        } finally {
          active.delete(key);
        }
      } else if (
        /^gitleaks\/gitleaks-action@|^trufflesecurity\/trufflehog@/.test(use)
      )
        observe("secret-scan", target, location, conditional);
      else if (/^docker\/build-push-action@/.test(use)) {
        const file = step.with?.file ?? "Dockerfile",
          context = step.with?.context;
        if (
          typeof file === "string" &&
          Object.hasOwn(files, file) &&
          context === "."
        )
          observe(
            "container-build",
            target,
            location,
            conditional || !!step.with?.target,
            { file },
          );
        else unknown(location, "unresolved-dockerfile-or-context", target);
      } else if (/^actions\/dependency-review-action@/.test(use))
        observe("dependency-audit", target, location, true);
      else if (!SETUP.test(use))
        unknown(location, "unresolved-external-action", target);
    }
  }
  function workflow(name, weak = false, depth = 0) {
    if (active.has(name) || depth > 10) {
      unknown({ workflow: name }, "cyclic-or-deep-workflow", "");
      return;
    }
    active.add(name);
    try {
      const doc = yaml(name);
      if (!doc.jobs || typeof doc.jobs !== "object") throw Error();
      // Default needs gating inherits restrictions from prerequisites. Explicit
      // always() can override skipped prerequisites; arbitrary expressions cannot.
      const conditionCache = new Map(),
        visiting = new Set();
      function restricted(id) {
        if (conditionCache.has(id)) return conditionCache.get(id);
        if (visiting.has(id) || !Object.hasOwn(doc.jobs, id)) return true;
        visiting.add(id);
        const job = doc.jobs[id];
        let result =
          conditionalIf(job.if) ||
          (job["continue-on-error"] !== undefined &&
            job["continue-on-error"] !== false) ||
          (typeof job.uses === "string" && !job.uses.startsWith("./"));
        const needs =
          typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
        const always = ["always()", "$" + "{{always()}}"].includes(
          String(job.if ?? "").replace(/\s/g, ""),
        );
        if (
          !Array.isArray(needs) ||
          needs.some((dep) => typeof dep !== "string")
        )
          result = true;
        else if (!always && needs.some(restricted)) result = true;
        visiting.delete(id);
        conditionCache.set(id, result);
        return result;
      }
      for (const [id, job] of Object.entries(doc.jobs)) {
        const at = { workflow: name, job: id },
          conditional = weak || restricted(id),
          cwd =
            job.defaults?.run?.["working-directory"] ??
            doc.defaults?.run?.["working-directory"] ??
            "";
        if (typeof job.uses === "string") {
          if (job.uses.startsWith("./.github/workflows/"))
            workflow(job.uses.slice(2), conditional, depth + 1);
          else unknown(at, "external-reusable-workflow", cwd);
        } else steps(job.steps, cwd, at, conditional, depth);
      }
    } catch {
      unknown({ workflow: name }, "unreadable-workflow", "");
    } finally {
      active.delete(name);
    }
  }
  const definitions = names.filter(WF);
  let entries = 0;
  for (const name of definitions)
    try {
      const doc = yaml(name),
        events =
          typeof doc.on === "string"
            ? [doc.on]
            : Array.isArray(doc.on)
              ? doc.on
              : Object.keys(doc.on ?? {});
      if (events.includes("pull_request")) {
        entries++;
        const trigger = doc.on?.pull_request;
        workflow(
          name,
          !!(
            trigger &&
            typeof trigger === "object" &&
            Object.keys(trigger).some((k) =>
              [
                "branches",
                "branches-ignore",
                "paths",
                "paths-ignore",
                "types",
              ].includes(k),
            )
          ),
        );
      } else if (events.includes("pull_request_target"))
        warnings.push({
          code: "privileged-pr-event",
          workflow: name,
          message:
            "Not counted as unprivileged PR validation; review permissions and checkout.",
        });
    } catch {
      unknown({ workflow: name }, "unreadable-workflow", "");
    }
  const checks = [];
  function check(
    kind,
    pkg,
    evidence,
    recommendation,
    scope = null,
    language = null,
  ) {
    const candidates = observations.filter(
        (o) =>
          o.kind === kind &&
          (pkg === null || o.package === pkg) &&
          (scope === null || o.scope === scope) &&
          (language === null || o.language === language) &&
          (!["container-build", "container-lint"].includes(kind) ||
            o.file === evidence[0]),
      ),
      covered = candidates.some((o) => !o.conditional),
      opaque = uncertainties.filter(
        (u) => u.package === null || pkg === null || u.package === pkg,
      );
    const status = covered
      ? "covered"
      : candidates.length
        ? "conditional"
        : opaque.length
          ? "unverified"
          : "missing";
    checks.push({
      id:
        (scope === null
          ? (pkg ?? "repository")
          : (scope || "root") + ":" + language) +
        "#" +
        kind +
        (kind === "container-build" ? ":" + evidence[0] : ""),
      check: kind,
      ...(language ? { language, scope } : {}),
      package: pkg,
      status,
      repositoryEvidence: evidence,
      ciEvidence: candidates,
      uncertainties: covered ? [] : opaque,
      recommendation,
    });
  }
  if (!entries)
    check(
      "pull-request-ci",
      null,
      definitions,
      "Add an unprivileged pull_request workflow with blocking checks.",
    );
  for (const [cwd, { name, manifest }] of packages) {
    const prefix = cwd ? cwd + "/" : "",
      own = names.filter(
        (p) =>
          p.startsWith(prefix) &&
          ![...packages.keys()].some(
            (other) =>
              other !== cwd &&
              other.startsWith(prefix) &&
              p.startsWith(other + "/"),
          ),
      ),
      scripts = manifest.scripts ?? {},
      deps = { ...manifest.dependencies, ...manifest.devDependencies };
    if (
      own.some((p) => SOURCE.test(p)) ||
      Object.keys(scripts).some((s) => /^test(?::|$)/.test(s))
    )
      check(
        "tests",
        name,
        own.filter((p) => TEST.test(p)).slice(0, 8),
        "Run meaningful package tests on PRs; add a suite first if none exists.",
      );
    if (
      own.some(
        (p) => /\.tsx?$/.test(p) || /(?:^|\/)tsconfig[^/]*\.json$/.test(p),
      )
    )
      check(
        "typecheck",
        name,
        own.filter((p) => /tsconfig/.test(p)).slice(0, 8),
        "Run checked TypeScript compilation, such as tsc --noEmit.",
      );
    if (
      own.some((p) =>
        /(?:^|\/)(?:eslint\.config\.|\.eslintrc|biome\.json)/.test(p),
      ) ||
      deps.eslint ||
      scripts.lint
    )
      check(
        "lint",
        name,
        [name],
        "Run the configured linter without automatic fixes.",
      );
    if (
      deps.prettier ||
      deps["@biomejs/biome"] ||
      own.some((p) => /(?:^|\/)(?:\.prettierrc|prettier\.config)/.test(p))
    )
      check("format", name, [name], "Run the formatter in check mode.");
    if (typeof scripts.build === "string")
      check(
        "build",
        name,
        [name],
        "Run the declared build through its actual tool, not just a matching script name.",
      );
    if (
      Object.keys(deps).length ||
      own.some((p) =>
        /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p),
      )
    )
      check(
        "dependency-audit",
        name,
        [name],
        "Run an appropriate dependency vulnerability check.",
      );
  }
  // Language roots are independent of Node packages, including repositories with no package.json.
  const pythonRoots = names
    .filter((n) =>
      /(?:^|\/)(?:pyproject\.toml|setup\.py|requirements[^/]*\.txt)$/.test(n),
    )
    .map((n) => (path.posix.dirname(n) === "." ? "" : path.posix.dirname(n)));
  if (names.some((n) => n.endsWith(".py")) && !pythonRoots.length)
    pythonRoots.push("");
  const goRoots = names
    .filter((n) => /(?:^|\/)go\.mod$/.test(n))
    .map((n) => (path.posix.dirname(n) === "." ? "" : path.posix.dirname(n)));
  for (const [language, roots, extension] of [
    ["python", pythonRoots, ".py"],
    ["go", goRoots, ".go"],
  ]) {
    for (const cwd of new Set(roots)) {
      const own = names.filter(
        (n) =>
          (!cwd || n.startsWith(cwd + "/")) &&
          !roots.some(
            (other) =>
              other !== cwd &&
              other.startsWith(cwd ? cwd + "/" : "") &&
              n.startsWith(other + "/"),
          ),
      );
      if (!own.some((n) => n.endsWith(extension))) continue;
      for (const kind of [
        "tests",
        "lint",
        "dependency-audit",
        ...(language === "go" ? ["build"] : []),
      ])
        check(
          kind,
          null,
          own.filter((n) => n.endsWith(extension)).slice(0, 8),
          "Run the language's blocking " +
            kind +
            " in this source root; wrappers and partial invocations need owner review.",
          cwd,
          language,
        );
    }
  }
  if (
    names.some(
      (p) => SOURCE.test(p) || /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(p),
    )
  )
    check(
      "secret-scan",
      null,
      ["tracked-source-files"],
      "Add a read-only secret scan or verify equivalent external protection; never print secret values.",
    );
  for (const name of names.filter((p) =>
    /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(p),
  ))
    check(
      "container-build",
      null,
      [name],
      "Validate this Dockerfile and its context/platform; generic build invocations require review.",
    );
  for (const name of names.filter((p) =>
    /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(p),
  ))
    check(
      "container-lint",
      null,
      [name],
      "Lint this Dockerfile with a blocking invocation.",
    );
  if (definitions.length)
    check(
      "workflow-lint",
      null,
      definitions,
      "Run actionlint over workflow definitions.",
    );
  return {
    schemaVersion: 1,
    ref,
    mode: "read-only-repository-audit",
    summary: Object.fromEntries(
      ["covered", "conditional", "unverified", "missing"].map((s) => [
        s,
        checks.filter((c) => c.status === s).length,
      ]),
    ),
    checks,
    warnings,
    limitations: [
      "Static evidence does not prove successful runs, branch protection, test quality or complete matrix/path coverage.",
      "External settings and opaque wrappers require review. No repository commands are executed or secret files read.",
      "Language rules recognize Node/TypeScript, Python, Go and explicit Dockerfile invocations. Covered remains invocation evidence, not completeness or a passing result.",
      "This command edits no workflows and starts no runners.",
    ],
  };
}
/** Read only bounded immutable Git objects; never read dirty files or .env contents. */
export function readRepositorySnapshot({ root = ".", ref = "HEAD" } = {}) {
  if (ref !== "HEAD" && !SHA.test(ref))
    throw Error("Expected HEAD or full commit SHA");
  const git = (args) => gitRead(root, args);
  const sha = git(["rev-parse", "--verify", ref + "^{commit}"]).trim(),
    entries = git(["ls-tree", "-r", "-z", "--full-tree", sha])
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const m =
          /^(\d+) (\w+) ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t([\s\S]+)$/.exec(line);
        if (!m) throw Error("Invalid tree");
        return { mode: m[1], type: m[2], name: m[4] };
      });
  if (entries.length > 20000)
    throw Error("Repository exceeds 20000-file bound");
  const files = {};
  let bytes = 0,
    reads = 0;
  for (const e of entries) {
    files[e.name] = null;
    if (
      !(
        /(?:^|\/)package\.json$|(?:^|\/)action\.ya?ml$|\.sh$/.test(e.name) ||
        WF(e.name)
      ) ||
      /(?:^|\/)(?:node_modules|vendor|\.git)\//.test(e.name) ||
      !["100644", "100755"].includes(e.mode) ||
      e.type !== "blob"
    )
      continue;
    if (++reads > 300) throw Error("Audit exceeds 300 text-file bound");
    const source = git(["show", sha + ":" + e.name]);
    bytes += Buffer.byteLength(source);
    if (Buffer.byteLength(source) > 256 * 1024 || bytes > 8 * 1024 * 1024)
      throw Error("Audit exceeds source-byte bounds");
    files[e.name] = source;
  }
  return { ref: sha, files };
}

/** Run the read-only completeness audit over committed repository state. */
export function auditRepository(options = {}) {
  return auditRepositorySnapshot(readRepositorySnapshot(options));
}
