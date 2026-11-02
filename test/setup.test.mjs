import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { initializeRepository, proposeSetup } from "../src/setup.mjs";
import { planRepository } from "../src/planner.mjs";
import { fixture, baseFiles, cli } from "./helpers.mjs";

const workflow = ".github/workflows/ci.yml";
const source =
  "on: pull_request\njobs:\n  unit:\n    runs-on: [self-hosted, internal]\n    steps:\n      - run: npm test\n";

test("setup preview discovers jobs, never enables skips, executes no source and leaves CI untouched", (t) => {
  const f = fixture(t, {
    ...baseFiles(),
    [workflow]: source,
    "scripts/unsafe.sh": "touch SHOULD_NOT_EXIST",
    ".env": "PRIVATE_FIXTURE_CONTENT",
  });
  const preview = initializeRepository({ root: f.root });
  assert.equal(preview.mode, "setup-preview");
  assert.equal(preview.discoveredJobs, 2);
  const policy = JSON.parse(
    preview.files.find((file) => file.path === ".ci-planner.json").content,
  );
  assert.equal(policy.mode, "shadow");
  assert(
    Object.values(policy.jobs).every((job) => job.inputsComplete === false),
  );
  const generated = parseDocument(
    preview.files.find((file) => file.path.endsWith(".yml")).content,
  ).toJS();
  assert.equal(generated.permissions.contents, "read");
  assert.equal(generated.jobs.report["continue-on-error"], true);
  assert.equal(generated.jobs.report.steps[1].with.enforce, "false");
  assert.equal(generated.jobs.report.steps[1].with.workflow, workflow);
  assert.equal(f.git("status", "--porcelain"), "");
  assert(!JSON.stringify(preview).includes("PRIVATE_FIXTURE_CONTENT"));
  assert(!fs.existsSync(path.join(f.root, "SHOULD_NOT_EXIST")));
  assert.equal(fs.readFileSync(path.join(f.root, workflow), "utf8"), source);
});

test("written setup creates only missing files and forms a runnable all-run shadow plan", (t) => {
  const f = fixture(t, { ...baseFiles(), [workflow]: source });
  const result = initializeRepository({ root: f.root, write: true });
  assert.equal(result.mode, "setup-written");
  assert(fs.existsSync(path.join(f.root, ".ci-planner.json")));
  assert(fs.existsSync(path.join(f.root, ".github/workflows/ci-planner.yml")));
  assert.equal(fs.readFileSync(path.join(f.root, workflow), "utf8"), source);
  const sha = f.commit();
  const plan = planRepository({
    root: f.root,
    baseSha: sha,
    headSha: sha,
    enforce: true,
  });
  assert.equal(plan.mode, "shadow");
  assert(Object.values(plan.jobs).every((job) => job.run));
  assert.throws(
    () => initializeRepository({ root: f.root, write: true }),
    /already exists/,
  );
});

test("existing owner policies are preserved byte-for-byte", (t) => {
  const existing =
    JSON.stringify({ schemaVersion: 1, mode: "enforce", jobs: {} }, null, 4) +
    "\n";
  const f = fixture(t, { ...baseFiles(), ".ci-planner.json": existing });
  const result = initializeRepository({ root: f.root, write: true });
  assert.equal(result.files.length, 1);
  assert(result.existingPolicy);
  assert.equal(
    fs.readFileSync(path.join(f.root, ".ci-planner.json"), "utf8"),
    existing,
  );
});

test("repos without workflows get an advisory report workflow, including native projects without hosted app builds", (t) => {
  const f = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: { expo: "1" },
      scripts: { build: "eas build", test: "vitest run" },
    }),
    "Assets/game.cs": "fixture",
    "ProjectSettings/ProjectVersion.txt": "fixture",
  });
  const result = initializeRepository({ root: f.root });
  const file = result.files.find((file) => file.path.endsWith(".yml"));
  const job = parseDocument(file.content).toJS().jobs.report;
  assert.equal(job.steps.length, 2);
  assert(job.steps.every((step) => !step.run));
  assert.equal(job.steps[1].with.workflow, ".github/workflows/ci-planner.yml");
  assert(!file.content.includes("eas build"));
  assert(!file.content.includes("gameci"));
});

test("dirty checkouts and workflow collisions leave every existing file intact", (t) => {
  const f = fixture(t);
  f.write("untracked", "leave me");
  assert.throws(
    () => initializeRepository({ root: f.root, write: true }),
    /clean checkout/,
  );
  assert(!fs.existsSync(path.join(f.root, ".ci-planner.json")));
  assert.equal(
    fs.readFileSync(path.join(f.root, "untracked"), "utf8"),
    "leave me",
  );
  fs.unlinkSync(path.join(f.root, "untracked"));
  f.write(".github/workflows/ci-planner.yml", source);
  f.commit();
  assert.throws(
    () => initializeRepository({ root: f.root, write: true }),
    /already exists/,
  );
  assert(!fs.existsSync(path.join(f.root, ".ci-planner.json")));
});

test("setup refuses symlinked parents before creating the policy, including dangling links", (t) => {
  for (const dangling of [false, true]) {
    const f = fixture(t);
    if (!dangling) fs.mkdirSync(path.join(f.root, "outside"));
    fs.symlinkSync("outside", path.join(f.root, ".github"));
    f.commit();
    assert.throws(
      () => initializeRepository({ root: f.root, write: true }),
      /symlink/,
    );
    assert(!fs.existsSync(path.join(f.root, ".ci-planner.json")));
    if (!dangling)
      assert.deepEqual(fs.readdirSync(path.join(f.root, "outside")), []);
  }
});

test("unsupported workflow graphs and mutable Action refs refuse setup without edits", (t) => {
  const f = fixture(t, {
    [workflow]: "jobs:\n  a:\n    needs: a\n    steps: []\n",
  });
  assert.throws(() => initializeRepository({ root: f.root, write: true }));
  assert.equal(f.git("status", "--porcelain"), "");
  for (const actionRef of ["main", "v1", "../x", "v0.3.0\nbad"]) {
    assert.throws(
      () => proposeSetup({ ref: f.sha, files: {} }, { actionRef }),
      /Action ref/,
    );
  }
});

test("init CLI previews by default and writes only with the explicit flag", (t) => {
  const f = fixture(t);
  const run = (...args) =>
    execFileSync(process.execPath, [cli, "init", "--root", f.root, ...args], {
      encoding: "utf8",
    });
  assert.equal(JSON.parse(run()).mode, "setup-preview");
  assert.equal(f.git("status", "--porcelain"), "");
  const markdown = run("--write", "--format", "markdown");
  assert.match(markdown, /Created files for owner review/);
  assert.match(markdown, /shadow mode/);
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--root", f.root, "--write"])
      .status,
    1,
  );
});
