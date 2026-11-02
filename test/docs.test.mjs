import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocument } from "yaml";
import { buildPlan, discoverWorkflows, VERSION } from "../src/planner.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = [
  "README.md",
  "docs/cli.md",
  "docs/repository-audit.md",
  "docs/configuration.md",
  "docs/github-actions.md",
  "docs/architecture.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
];

test("public documentation has valid local links and ships in the package", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const name of documents) {
    const text = fs.readFileSync(path.join(root, name), "utf8");
    assert(text.length > 300, name);
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^https?:/.test(target)) continue;
      assert(
        fs.existsSync(path.resolve(root, path.dirname(name), target)),
        name + ": " + target,
      );
    }
    assert(
      pkg.files.some((entry) => name === entry || name.startsWith(entry)),
      "Missing from distributable: " + name,
    );
  }
  assert.equal(pkg.version, VERSION);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
      .version,
    VERSION,
  );
});

test("documented policy and workflow form a runnable shadow plan with safe outputs", () => {
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, "examples/policy.json"), "utf8"),
  );
  const workflow = fs.readFileSync(
    path.join(root, "examples/pull-request.yml"),
    "utf8",
  );
  const graph = discoverWorkflows({ ".github/workflows/ci.yml": workflow });
  assert(graph.has(".github/workflows/ci.yml#test"));
  const plan = buildPlan({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    workflows: { ".github/workflows/ci.yml": workflow },
    policy,
    changes: [{ status: "M", path: "docs/guide.md" }],
  });
  assert.equal(plan.mode, "shadow");
  assert(Object.values(plan.jobs).every((job) => job.run));
  const doc = parseDocument(workflow).toJS();
  assert.match(doc.jobs.test.if, /ready != 'true'/);
  assert.match(doc.jobs.test.if, /test != false/);
  assert.equal(doc.permissions.contents, "read");
  assert.equal(doc.jobs.plan["continue-on-error"], true);
});

test("Action passes untrusted values through environment and argument arrays", () => {
  const action = parseDocument(
    fs.readFileSync(path.join(root, "action.yml"), "utf8"),
  ).toJS();
  const step = action.runs.steps.find((step) => step.id === "plan");
  assert(step.env.PLANNER_BASE);
  assert(!step.run.includes("$" + "{{"));
  assert.match(step.run, /"\$\{args\[@\]\}"/);
  assert.match(
    action.runs.steps.find((step) => step.run?.includes("npm ci")).run,
    /--ignore-scripts/,
  );
  assert.equal(action.inputs.enforce.default, "false");
});

test("documented example can skip an unrelated job in enforce mode", () => {
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, "examples/policy.json"), "utf8"),
  );
  policy.mode = "enforce";
  const source = fs.readFileSync(
    path.join(root, "examples/pull-request.yml"),
    "utf8",
  );
  const plan = buildPlan({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeSha: "c".repeat(40),
    verifiedMerge: true,
    enforce: true,
    workflows: { ".github/workflows/ci.yml": source },
    policy,
    changes: [{ status: "M", path: "docs/guide.md" }],
  });
  assert.equal(plan.jobs[".github/workflows/ci.yml#test"].run, false);
  assert.equal(plan.jobs[".github/workflows/ci.yml#plan"].run, true);
});
