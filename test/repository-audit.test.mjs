import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  auditRepositorySnapshot,
  auditRepository,
} from "../src/repository-audit.mjs";
const sha = "a".repeat(40);
const pkg = {
  scripts: {
    test: "vitest run",
    lint: "eslint src",
    typecheck: "tsc --noEmit",
    build: "vite build",
  },
  dependencies: { example: "1.0.0" },
  devDependencies: { eslint: "1", typescript: "1" },
};
const workflow = (run) =>
  "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: " +
  run +
  "\n";
const baseline = (extra = {}) => ({
  "package.json": JSON.stringify(pkg),
  "src/a.ts": null,
  "test/a.test.ts": null,
  "tsconfig.json": "{}",
  "eslint.config.mjs": null,
  ".github/workflows/ci.yml": workflow("npm test"),
  ...extra,
});
const audit = (files) => auditRepositorySnapshot({ ref: sha, files });
const check = (report, kind, packageName = "package.json") =>
  report.checks.find((c) => c.check === kind && c.package === packageName);
test("compares repo-specific tests, types, lint, build and dependency needs with actual CI", () => {
  const r = audit(baseline());
  assert.equal(check(r, "tests").status, "covered");
  for (const kind of ["typecheck", "lint", "build", "dependency-audit"])
    assert.equal(check(r, kind).status, "missing", kind);
  assert.equal(check(r, "secret-scan", null).status, "missing");
  assert.equal(check(r, "workflow-lint", null).status, "missing");
  assert.equal(check(r, "tests").ciEvidence[0].location.script, "test");
});
test("script names, echoes and comments do not count as executed validation", () => {
  const r = audit(
    baseline({
      "package.json": JSON.stringify({
        ...pkg,
        scripts: { test: 'echo \"vitest run\"' },
      }),
      ".github/workflows/ci.yml": workflow("npm test"),
    }),
  );
  assert.notEqual(check(r, "tests").status, "covered");
  const absent = audit(
    baseline({ ".github/workflows/ci.yml": workflow('echo \"npm test\"') }),
  );
  assert.equal(check(absent, "tests").status, "missing");
});
test("traces chained package scripts, shell wrappers and local reusable workflows", () => {
  const manifest = {
    ...pkg,
    scripts: {
      ci: "npm run lint && npm run unit",
      unit: "vitest run",
      lint: "bash scripts/lint.sh",
    },
  };
  const r = audit(
    baseline({
      "package.json": JSON.stringify(manifest),
      "scripts/lint.sh": "eslint src",
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  call:\n    uses: ./.github/workflows/shared.yml\n",
      ".github/workflows/shared.yml": workflow("npm run ci").replace(
        "on: pull_request",
        "on: workflow_call",
      ),
    }),
  );
  assert.equal(check(r, "tests").status, "covered");
  assert.equal(check(r, "lint").status, "covered");
});
test("conditions, tolerated failures, dry runs and shell failure masking never prove blocking coverage", () => {
  for (const value of [
    workflow("npm test").replace(
      "      - run:",
      "      - if: false\n        run:",
    ),
    workflow("npm test").replace(
      "      - run:",
      "      - continue-on-error: true\n        run:",
    ),
    workflow("npm test || true"),
    workflow("npm test | cat"),
    workflow("false && npm test"),
    workflow("npm test -- --help"),
    workflow("npm test").replace(
      "on: pull_request",
      'on:\n  pull_request:\n    paths: [\"src/**\"]',
    ),
  ])
    assert.notEqual(
      check(audit(baseline({ ".github/workflows/ci.yml": value })), "tests")
        .status,
      "covered",
      value,
    );
});
test("root invocations do not prove tests in every monorepo package", () => {
  const files = baseline({
    "packages/a/package.json": JSON.stringify({
      scripts: { test: "vitest run" },
    }),
    "packages/a/src/a.js": null,
    "packages/b/package.json": JSON.stringify({
      scripts: { test: "vitest run" },
    }),
    "packages/b/src/b.js": null,
    ".github/workflows/ci.yml": workflow("npm --prefix packages/a test"),
  });
  const r = audit(files);
  assert.equal(check(r, "tests", "packages/a/package.json").status, "covered");
  assert.equal(check(r, "tests", "packages/b/package.json").status, "missing");
});
test("opaque external workflows and dynamic package selectors are unverified", () => {
  const external = audit(
    baseline({
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  call:\n    uses: owner/repo/.github/workflows/shared.yml@main\n",
    }),
  );
  assert.equal(check(external, "tests").status, "unverified");
  const dynamic = audit(
    baseline({ ".github/workflows/ci.yml": workflow("npm test --workspaces") }),
  );
  assert.equal(check(dynamic, "tests").status, "unverified");
});
test("scheduled-only or privileged workflows do not establish unprivileged PR coverage", () => {
  for (const event of ["schedule", "pull_request_target"]) {
    const r = audit(
      baseline({
        ".github/workflows/ci.yml": workflow("npm test").replace(
          "pull_request",
          event,
        ),
      }),
    );
    assert.equal(check(r, "tests").status, "missing");
    assert(r.checks.some((c) => c.check === "pull-request-ci"));
    if (event === "pull_request_target")
      assert.equal(r.warnings[0].code, "privileged-pr-event");
  }
});
test("reports package-relative cwd and does not leak raw commands or inline secrets", () => {
  const files = baseline({
    "packages/a/package.json": JSON.stringify({
      scripts: { test: "vitest run --token fake-sensitive-value" },
    }),
    "packages/a/src/a.js": null,
    ".github/workflows/ci.yml": workflow("npm test").replace(
      "      - run:",
      "      - working-directory: packages/a\n        run:",
    ),
  });
  const r = audit(files);
  assert.equal(check(r, "tests", "packages/a/package.json").status, "covered");
  assert(!JSON.stringify(r).includes("fake-sensitive-value"));
});
test("local composite action commands can establish coverage without executing the action", () => {
  const r = audit(
    baseline({
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  test:\n    steps:\n      - uses: ./.github/actions/check\n",
      ".github/actions/check/action.yml":
        "runs:\n  using: composite\n  steps:\n    - run: npm test\n      shell: bash\n",
    }),
  );
  assert.equal(check(r, "tests").status, "covered");
});
test("transpile-only builds do not establish a TypeScript check", () => {
  const r = audit(
    baseline({ ".github/workflows/ci.yml": workflow("npx tsc --noCheck") }),
  );
  assert.notEqual(check(r, "typecheck").status, "covered");
});
test("Git audit ignores dirty files and secret files, and stays read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-audit-"));
  const git = (args) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "CI audit fixture"]);
    git(["config", "user.email", "test@example.invalid"]);
    for (const [name, contents] of Object.entries(baseline())) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents ?? "");
    }
    fs.writeFileSync(
      path.join(root, ".env"),
      "PRIVATE_TOKEN=not-a-real-secret",
    );
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const before = git(["status", "--porcelain"]);
    fs.writeFileSync(path.join(root, "package.json"), "not JSON");
    const r = auditRepository({ root });
    assert.equal(check(r, "tests").status, "covered");
    assert(!JSON.stringify(r).includes("not-a-real-secret"));
    assert.equal(git(["status", "--porcelain"]).trim(), "M package.json");
    assert.throws(() => auditRepository({ root, ref: "--bad" }), /HEAD|SHA/);
    assert.equal(before, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("npm lifecycle checks are traced unless lifecycle scripts are disabled", () => {
  const manifest = {
    scripts: { test: "vitest run", pretest: "eslint src" },
    devDependencies: { eslint: "1" },
  };
  const files = baseline({ "package.json": JSON.stringify(manifest) });
  assert.equal(check(audit(files), "lint").status, "covered");
  files[".github/workflows/ci.yml"] = workflow("npm test --ignore-scripts");
  assert.equal(check(audit(files), "lint").status, "missing");
});

test("listing tests is not running tests", () => {
  const files = baseline({
    "package.json": JSON.stringify({
      ...pkg,
      scripts: { test: "vitest --list" },
    }),
  });
  assert.notEqual(check(audit(files), "tests").status, "covered");
});

test("conditional prerequisites make default dependent checks conditional", () => {
  const gated =
    "on: pull_request\njobs:\n  gate:\n    if: github.event.pull_request.draft == false\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n  test:\n    needs: gate\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  assert.equal(
    check(audit(baseline({ ".github/workflows/ci.yml": gated })), "tests")
      .status,
    "conditional",
  );
});

test("unreachable tests after exit are not counted in workflows, scripts or wrappers", () => {
  const inputs = [
    baseline({ ".github/workflows/ci.yml": workflow("exit 0; npm test") }),
    baseline({
      "package.json": JSON.stringify({
        ...pkg,
        scripts: { test: "exit 0; vitest run" },
      }),
    }),
    baseline({
      "package.json": JSON.stringify({
        ...pkg,
        scripts: { test: "bash scripts/test.sh" },
      }),
      "scripts/test.sh": "exit 0\nvitest run",
    }),
  ];
  for (const files of inputs)
    assert.notEqual(check(audit(files), "tests").status, "covered");
});

test("explicit always condition can override a conditionally skipped prerequisite", () => {
  const source =
    "on: pull_request\njobs:\n  gate:\n    if: github.event.pull_request.draft == false\n    steps:\n      - run: node --version\n  test:\n    needs: gate\n    if: $" +
    "{{ always() }}\n    steps:\n      - run: npm test\n";
  assert.equal(
    check(audit(baseline({ ".github/workflows/ci.yml": source })), "tests")
      .status,
    "covered",
  );
});

test("distinct Dockerfiles keep distinct findings and generic builds remain conditional", () => {
  const r = audit(
    baseline({
      Dockerfile: null,
      "services/api/Dockerfile": null,
      ".github/workflows/ci.yml": workflow("docker build ."),
    }),
  );
  const findings = r.checks.filter((c) => c.check === "container-build");
  assert.equal(findings.length, 2);
  assert.equal(new Set(findings.map((c) => c.id)).size, 2);
  assert(findings.every((c) => c.status === "conditional"));
});
