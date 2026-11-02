/**
 * Owner-invoked, additive CI repair. Writes one new reviewable workflow, never commits,
 * replaces existing checks, changes runner placement or executes repository commands.
 */
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { auditRepositorySnapshot } from "./repository-audit.mjs";
import { uniqueJSON } from "./json.mjs";
const target = ".github/workflows/ci-planner-checks.yml";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const tools = {
  "secret-scan": {
    name: "gitleaks",
    url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
    hash: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    command: "gitleaks dir . --redact --no-banner",
  },
  "workflow-lint": {
    name: "actionlint",
    url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
    hash: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    command: "actionlint",
  },
};
const tasks = {
  tests: ["test", "test:unit"],
  lint: ["lint", "lint:check"],
  typecheck: ["typecheck", "check:types", "typecheck:build"],
  format: ["format:check", "format"],
};

/** Propose only definite gaps with existing verifiable commands; leave ambiguous or placement-sensitive checks alone. */
export function proposeCheckWorkflow(
  snapshot,
  report = auditRepositorySnapshot(snapshot),
) {
  const steps = [
      { uses: CHECKOUT, with: { "persist-credentials": false } },
      { uses: NODE, with: { "node-version": "24" } },
    ],
    added = [],
    notAdded = [],
    installed = new Set();
  const missing = report.checks.filter((check) => check.status === "missing");
  // Scan the checkout before installing packages or running commands that create
  // generated files. Dependency fixtures must not become repository secret findings.
  for (const check of [
    ...missing.filter((check) => tools[check.check]),
    ...missing.filter((check) => !tools[check.check]),
  ]) {
    if (check.check === "pull-request-ci") continue;
    if (tools[check.check]) {
      const tool = tools[check.check],
        run = [
          'tools_dir="$RUNNER_TEMP/ci-planner-tools"',
          'mkdir -p "$tools_dir"',
          'curl -fsSL --retry 3 --max-time 60 -o "$tools_dir/' +
            tool.name +
            '.tgz" ' +
            tool.url,
          'echo "' +
            tool.hash +
            "  $tools_dir/" +
            tool.name +
            '.tgz" | sha256sum --check --strict',
          'tar -xzf "$tools_dir/' +
            tool.name +
            '.tgz" -C "$tools_dir" ' +
            tool.name,
          'echo "$tools_dir" >> "$GITHUB_PATH"',
        ].join("\n");
      steps.push(
        { name: "Install verified " + tool.name, shell: "bash", run },
        { name: check.check, run: tool.command },
      );
      added.push(check.id);
      continue;
    }
    if (!check.package || !Object.hasOwn(snapshot.files, check.package)) {
      notAdded.push({
        id: check.id,
        reason: "Requires owner-selected command, context or runner placement.",
      });
      continue;
    }
    const cwd = path.posix.dirname(check.package),
      prefix = cwd === "." ? "" : cwd + "/";
    if (
      !/^[A-Za-z0-9_./-]+$/.test(check.package) ||
      check.package.split("/").includes("..") ||
      !Object.hasOwn(snapshot.files, prefix + "package-lock.json")
    ) {
      notAdded.push({
        id: check.id,
        reason:
          "Automatic package wiring needs a literal safe path and npm lockfile.",
      });
      continue;
    }
    const manifest = uniqueJSON(snapshot.files[check.package]);
    let command;
    if (check.check === "dependency-audit")
      command = "npm audit --omit=dev --audit-level=high";
    else {
      for (const task of tasks[check.check] ?? []) {
        if (typeof manifest.scripts?.[task] !== "string") continue;
        const script = manifest.scripts[task];
        const native =
          manifest.dependencies?.expo ||
          manifest.dependencies?.["react-native"] ||
          Object.values(manifest.scripts ?? {}).some((s) =>
            /\b(?:eas|gameci|Unity|xcodebuild|fastlane|gradle|expo)\b/.test(s),
          );
        if (
          native ||
          /[;&|\n$\x60]/.test(script) ||
          !/^(?:npx\s+)?(?:node\s+--test|jest|vitest|mocha|ava|tap|playwright|eslint|standard|biome|tsc|vue-tsc|prettier)\b/.test(
            script,
          )
        )
          continue;
        const probe = {
          ...snapshot,
          files: {
            ...snapshot.files,
            [target]:
              "on: pull_request\njobs:\n  probe:\n    defaults:\n      run:\n        working-directory: " +
              cwd +
              "\n    steps:\n      - run: npm run " +
              task +
              "\n",
          },
        };
        const evidence = auditRepositorySnapshot(probe).checks.find(
          (candidate) => candidate.id === check.id,
        );
        if (evidence?.status === "covered") {
          command = "npm run " + task + " --ignore-scripts";
          break;
        }
      }
    }
    if (!command) {
      notAdded.push({
        id: check.id,
        reason:
          "No verified existing command. Build/native/container placement requires owner review.",
      });
      continue;
    }
    if (!installed.has(cwd)) {
      steps.push({
        name: "Install " + check.package,
        "working-directory": cwd,
        run: "npm ci --ignore-scripts --no-audit --no-fund",
      });
      installed.add(cwd);
    }
    steps.push({
      name: check.check + " (" + check.package + ")",
      "working-directory": cwd,
      run: command,
    });
    added.push(check.id);
  }
  if (
    added.length &&
    !report.checks.some((check) => check.check === "workflow-lint")
  ) {
    const tool = tools["workflow-lint"];
    steps.push(
      {
        name: "Install verified actionlint",
        shell: "bash",
        run:
          'tools_dir="$RUNNER_TEMP/ci-planner-tools"\nmkdir -p "$tools_dir"\ncurl -fsSL --retry 3 --max-time 60 -o "$tools_dir/actionlint.tgz" ' +
          tool.url +
          '\necho "' +
          tool.hash +
          '  $tools_dir/actionlint.tgz" | sha256sum --check --strict\ntar -xzf "$tools_dir/actionlint.tgz" -C "$tools_dir" actionlint\necho "$tools_dir" >> "$GITHUB_PATH"',
      },
      { name: "workflow-lint", run: "actionlint" },
    );
    added.push("repository#workflow-lint");
  }
  const entry = report.checks.find(
    (check) => check.check === "pull-request-ci",
  );
  if (entry) {
    if (added.length) added.push(entry.id);
    else
      notAdded.push({
        id: entry.id,
        reason: "No safe executable check could be generated.",
      });
  }
  const workflow = {
    name: "Repository checks (review generated scope)",
    on: "pull_request",
    permissions: { contents: "read" },
    jobs: {
      "repository-checks": {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 15,
        steps,
      },
    },
  };
  return {
    path: target,
    ref: snapshot.ref,
    addedCheckIds: added,
    notAdded,
    content: added.length
      ? "# Generated for review. Preserve existing checks and runner placement.\n" +
        stringify(workflow)
      : null,
  };
}

/** Explicit --add-checks boundary: create one new file exclusively and refuse symlinked parents. */
export function addCheckWorkflow(root, proposal) {
  if (!proposal.content)
    return { ...proposal, content: undefined, written: false };
  const base = fs.realpathSync(root);
  for (const part of [".github", ".github/workflows"]) {
    const full = path.join(base, part);
    if (fs.existsSync(full)) {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw Error("Refuse non-directory or symlinked workflow parent");
    } else fs.mkdirSync(full);
  }
  fs.writeFileSync(path.join(base, target), proposal.content, { flag: "wx" });
  return { ...proposal, content: undefined, written: true };
}
