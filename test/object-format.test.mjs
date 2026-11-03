import test from "node:test";
import assert from "node:assert/strict";
import { auditRepositorySnapshot } from "../src/repository-audit.mjs";
import { collectSnapshot } from "../src/audit.mjs";
import { fixture } from "./helpers.mjs";
import { planRepository } from "../src/planner.mjs";
import { readRepositorySnapshot } from "../src/repository-audit.mjs";
import {
  readDependencySnapshot,
  trackedText,
  commitTree,
} from "../src/evidence.mjs";
import { initializeRepository } from "../src/setup.mjs";
import { parseOptions, WORKFLOW, SHA, ACTION_SHA } from "../src/validation.mjs";
test("real SHA-256 Git objects support snapshots, shadow setup and exact-merge planning", (t) => {
  const f = fixture(
    t,
    {
      "package.json": '{"type":"module"}',
      "src/a.js": "export const a=1;",
      "README.md": "before",
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  test:\n    steps:\n      - run: node --test\n",
    },
    { objectFormat: "sha256" },
  );
  assert.equal(f.sha.length, 64);
  assert.equal(readRepositorySnapshot({ root: f.root }).ref, f.sha);
  assert.equal(readDependencySnapshot({ root: f.root }).ref, f.sha);
  assert.equal(commitTree(f.root, f.sha).length, 64);
  assert.equal(trackedText(f.root, f.sha, "README.md"), "before");
  assert.equal(initializeRepository({ root: f.root }).mode, "setup-preview");
  f.git("checkout", "-b", "feature");
  f.write("README.md", "after");
  const head = f.commit();
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "feature", "-m", "merge");
  const result = planRepository({
    root: f.root,
    baseSha: f.sha,
    headSha: head,
    mergeSha: f.git("rev-parse", "HEAD"),
    repository: "owner/repo",
  });
  assert.equal(result.identity.mergeSha.length, 64);
  assert.equal(result.mode, "shadow");
});
test("common option and identity boundaries reject missing/duplicate flags and invalid workflow paths", () => {
  assert.deepEqual(
    parseOptions(["--root", "here", "--write"], ["--root"], ["--write"]),
    { "--root": "here", "--write": true },
  );
  for (const args of [
    ["--root"],
    ["--root", "--write"],
    ["--write", "--write"],
    ["--unknown"],
  ])
    assert.throws(() => parseOptions(args, ["--root"], ["--write"]));
  assert(SHA.test("a".repeat(64)));
  assert(!ACTION_SHA.test("a".repeat(64)));
  for (const name of [
    ".github/workflows/../bad.yml",
    ".github/workflows/evil\n.yml",
  ])
    assert(!WORKFLOW.test(name));
});

test("spaced workflow names remain discoverable and use encoded metadata endpoints", async (t) => {
  const workflow = ".github/workflows/my ci.yml";
  assert(WORKFLOW.test(workflow));
  const f = fixture(t, {
    "package.json": '{"type":"module"}',
    "src/a.js": "export const a=1;",
    [workflow]:
      "on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n",
  });
  const snapshot = readRepositorySnapshot({ root: f.root });
  assert.equal(typeof snapshot.files[workflow], "string");
  const audit = auditRepositorySnapshot(snapshot);
  assert.equal(audit.checks.find((c) => c.check === "tests").status, "covered");
  const setup = initializeRepository({ root: f.root });
  assert(setup.scopeProposal.jobs[workflow + "#unit"]);
  const plan = planRepository({ root: f.root, baseSha: f.sha, headSha: f.sha });
  assert(plan.jobs[workflow + "#unit"]);
  await collectSnapshot(
    { repository: "owner/repo", workflow: "my ci.yml", limit: 1 },
    async (endpoint) => {
      assert(endpoint.includes("my%20ci.yml"));
      return { workflow_runs: [], total_count: 0 };
    },
  );
});
