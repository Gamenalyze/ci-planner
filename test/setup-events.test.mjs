import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { initializeRepository } from "../src/setup.mjs";
import { fixture, baseFiles } from "./helpers.mjs";

const reportPath = ".github/workflows/ci-planner.yml";
const actionRoot = fileURLToPath(new URL("../", import.meta.url));
const actionPlan = parseDocument(
  fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8"),
).toJS().runs.steps.find((step) => step.id === "plan").run;
const generated = (preview) =>
  parseDocument(preview.files.find((file) => file.path === reportPath).content).toJS();
const outputs = (filename) =>
  Object.fromEntries(fs.readFileSync(filename, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
const execute = (run, root, env) =>
  spawnSync("bash", ["-e", "-c", run], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });

test("generated Action outputs retain the report when the first existing workflow excludes the event", (t) => {
  const f = fixture(t, {
    ...baseFiles(),
    ".github/workflows/a-push.yml":
      "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n",
    ".github/workflows/ci.yml":
      "on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    "scripts/unsafe.sh": "touch SHOULD_NOT_EXIST\n",
  });
  const preview = initializeRepository({ root: f.root, write: true });
  const config = generated(preview);
  const plan = config.jobs.report.steps.find((step) => step.uses?.startsWith("Gamenalyze/ci-planner@"));
  const head = f.commit();
  const merge = f.git("commit-tree", head + "^{tree}", "-p", f.sha, "-p", head, "-m", "tested merge");
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    const output = path.join(f.root, "action-output");
    const result = execute(actionPlan, f.root, {
      GITHUB_ACTION_PATH: actionRoot,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(f.root, "summary"),
      PLANNER_ROOT: f.root,
      PLANNER_BASE: f.sha,
      PLANNER_HEAD: head,
      PLANNER_MERGE: event === "pull_request" ? merge : "",
      PLANNER_WORKFLOW: plan.with.workflow,
      PLANNER_ENFORCE: plan.with.enforce,
      PLANNER_SUMMARY: plan.with.summary,
      PLANNER_AUDIT: plan.with["audit-repository"],
      PLANNER_VALIDATION: "",
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = outputs(output);
    assert.equal(actual.ready, "true");
    assert.equal(actual.mode, "shadow");
    assert.deepEqual(JSON.parse(actual.run), { report: true }, event);
    fs.unlinkSync(output);
  }
  assert.equal(config.jobs.report.steps[0].with.lfs, false);
  assert.equal(config.jobs.report.steps[0].with.submodules, false);
  assert(!fs.existsSync(path.join(f.root, "SHOULD_NOT_EXIST")));
});

test("generated revision resolution handles manual and zero-before pushes without executing head text", (t) => {
  for (const objectFormat of ["sha1", "sha256"]) {
    const f = fixture(t, baseFiles(), { objectFormat });
    const config = generated(initializeRepository({ root: f.root }));
    const resolve = config.jobs.report.steps.find((step) => step.id === "revisions");
    assert(resolve?.run, "a metadata-only revision resolver is required");
    const output = path.join(f.root, "revision-output");
    for (const before of ["", "0".repeat(f.sha.length), "invalid"]) {
      const result = execute(resolve.run, f.root, {
        EVENT_BASE: before, EVENT_HEAD: f.sha, GITHUB_OUTPUT: output,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(outputs(output), { base: f.sha, head: f.sha });
      fs.unlinkSync(output);
    }
    // Revision metadata must work before the Action bootstraps Node.
    const bin = path.join(f.root, "metadata-bin");
    fs.mkdirSync(bin);
    fs.symlinkSync("/bin/bash", path.join(bin, "bash"));
    fs.symlinkSync("/usr/bin/git", path.join(bin, "git"));
    const noNode = execute(resolve.run, f.root, {
      PATH: bin, EVENT_BASE: "", EVENT_HEAD: f.sha, GITHUB_OUTPUT: output,
    });
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.deepEqual(outputs(output), { base: f.sha, head: f.sha });
    fs.unlinkSync(output);
    fs.rmSync(bin, { recursive: true });
    f.write("README.md", "next revision");
    const head = f.commit();
    for (const before of ["", f.sha]) {
      const result = execute(resolve.run, f.root, {
        EVENT_BASE: before, EVENT_HEAD: head, GITHUB_OUTPUT: output,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(outputs(output), { base: f.sha, head });
      fs.unlinkSync(output);
    }
    for (const badHead of ["", "0".repeat(head.length), "$(touch SHOULD_NOT_EXIST)", head + "\nother=value"]) {
      const result = execute(resolve.run, f.root, {
        EVENT_BASE: f.sha, EVENT_HEAD: badHead, GITHUB_OUTPUT: output,
      });
      assert.notEqual(result.status, 0);
      assert(!fs.existsSync(output));
      assert(!fs.existsSync(path.join(f.root, "SHOULD_NOT_EXIST")));
    }
  }
});

test("generated advisory verification rejects empty, wrong-shaped and non-shadow outputs", (t) => {
  const f = fixture(t);
  const config = generated(initializeRepository({ root: f.root }));
  const verify = config.jobs.report.steps.find((step) => step.id === "verify");
  assert(verify?.run, "advisory job success must not substitute for output verification");
  const good = { PLANNER_READY: "true", PLANNER_MODE: "shadow", PLANNER_RUN: '{"report":true}' };
  assert.equal(execute(verify.run, f.root, good).status, 0);
  for (const change of [
    { PLANNER_READY: "false" }, { PLANNER_MODE: "enforce" },
    ...["", "null", "true", "[]", "[true]", "{}", '{"other":true}', '{"report":false}', '{"report":"true"}', '{"report":true,"other":false}']
      .map((PLANNER_RUN) => ({ PLANNER_RUN })),
  ]) {
    assert.notEqual(execute(verify.run, f.root, { ...good, ...change }).status, 0);
  }
});

test("generated report cancellation is separated by event, commit and pull request", (t) => {
  const f = fixture(t);
  const config = generated(initializeRepository({ root: f.root }));
  assert.equal(config.concurrency?.["cancel-in-progress"], true);
  const expression = (name) => String.fromCharCode(36) + "{{ " + name + " }}";
  const group = (event, sha = f.sha, ref = "refs/heads/main") => {
    let value = config.concurrency.group;
    for (const [key, replacement] of [
      ["github.repository", "owner/repo"], ["github.event_name", event],
      ["github.sha", sha], ["github.event.pull_request.number || github.ref", ref],
    ]) value = value.replaceAll(expression(key), replacement);
    assert(!value.includes(expression("").slice(0, 3)));
    return value;
  };
  assert.notEqual(group("push"), group("workflow_dispatch"));
  assert.notEqual(group("push"), group("push", "f".repeat(40)));
  assert.notEqual(group("pull_request", f.sha, "7"), group("pull_request", f.sha, "8"));
  assert.equal(group("push"), group("push"));
  assert(config.on.pull_request !== undefined);
  assert.deepEqual(config.on.push.branches, ["main"]);
  assert(config.on.workflow_dispatch !== undefined);
});
