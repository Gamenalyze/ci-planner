import test from "node:test";
import assert from "node:assert/strict";
import {
  replayHistory,
  checkoutFromLog,
  inspectFullWorkflow,
} from "../src/history.mjs";
import { fixture } from "./helpers.mjs";
const workflow = ".github/workflows/ci.yml",
  pin = "a".repeat(40);
const source = `on: pull_request\njobs:\n  tests:\n    strategy:\n      matrix:\n        node: [22, 24]\n    steps:\n      - uses: actions/checkout@${pin}\n      - run: npm test\n`;
const contract = {
  workflow,
  jobs: {
    tests: {
      names: ["tests (22)", "tests (24)"],
      requiredSteps: ["Run npm test"],
    },
  },
};
const start = "2026-11-03T01:00:00Z",
  end = "2026-11-03T01:00:20Z";
const checkout = {
  number: 2,
  name: "Run actions/checkout@" + pin,
  status: "completed",
  conclusion: "success",
  started_at: start,
  completed_at: end,
};
test("checkout logs bind one complete pinned-checkout interval and reject missing, outside or conflicting hashes", () => {
  const sha = "b".repeat(40),
    log = `2026-11-03T01:00:01Z [command]/usr/bin/git log -1 --format=%H\n2026-11-03T01:00:02Z ${sha}\n`;
  assert.equal(checkoutFromLog(log, checkout), sha);
  assert.equal(checkoutFromLog(log + log, checkout), null);
  assert.equal(
    checkoutFromLog(log.replaceAll("01:00:", "02:00:"), checkout),
    null,
  );
  assert.equal(
    checkoutFromLog(log, { ...checkout, conclusion: "skipped" }),
    null,
  );
});
test("workflow evidence requires explicit matrix coverage, ungated jobs/steps and actual required commands", () => {
  assert.deepEqual(inspectFullWorkflow(source, contract), []);
  for (const changed of [
    source.replace("    strategy:", "    if: false\n    strategy:"),
    source.replace("      - run:", "      - if: false\n        run:"),
    source.replace("npm test", "echo npm test"),
    source.replace("[22, 24]", "[22]"),
    source.replace(pin, "v4"),
  ])
    assert(inspectFullWorkflow(changed, contract).length);
});
test("bounded historical replay separates known success, failed suggested skips and unknown attempts", async (t) => {
  const files = {
    "package.json": '{"scripts":{"test":"vitest run"}}',
    "src/main.js": "export const x=1;",
    "README.md": "before",
    [workflow]: source,
    ".ci-planner.json": JSON.stringify({
      schemaVersion: 1,
      mode: "shadow",
      ignored: ["README.md"],
      jobs: {
        [workflow + "#tests"]: {
          inputsComplete: true,
          inputs: ["src/**", "test/**"],
        },
      },
    }),
  };
  const f = fixture(t, files);
  f.git("checkout", "-b", "feature");
  f.write("README.md", "after");
  const head = f.commit();
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "feature", "-m", "merge");
  const merge = f.git("rev-parse", "HEAD");
  let variant = "success";
  const meta = {
    id: 10,
    run_attempt: 1,
    workflow_id: 1,
    path: workflow,
    event: "pull_request",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    repository: { full_name: "owner/repo" },
  };
  const jobs = () =>
    [22, 24].map((n, i) => ({
      id: i + 1,
      run_id: 10,
      run_attempt: 1,
      name: `tests (${n})`,
      status: "completed",
      conclusion: variant === "failure" && i === 0 ? "failure" : "success",
      started_at: start,
      completed_at: end,
      labels: ["ubuntu-latest"],
      steps: [
        checkout,
        {
          number: 3,
          name: "Run npm test",
          status: "completed",
          conclusion: variant === "failure" && i === 0 ? "failure" : "success",
        },
      ],
    }));
  const read = async (endpoint) => {
    if (endpoint.includes("/pulls?"))
      return [{ number: 1, merged_at: end, head: { sha: head } }];
    if (endpoint.includes("/workflows/"))
      return { total_count: 1, workflow_runs: [meta] };
    if (endpoint.includes("/jobs?"))
      return {
        total_count: 2,
        jobs: variant === "partial" ? jobs().slice(0, 1) : jobs(),
      };
    return meta;
  };
  const log = async () =>
    variant === "missing-log"
      ? ""
      : `2026-11-03T01:00:01Z [command]/usr/bin/git log -1 --format=%H\n2026-11-03T01:00:02Z ${merge}\n`;
  const replay = () =>
    replayHistory(
      { root: f.root, repository: "owner/repo", limit: 1, contract },
      { read, log },
    );
  let report = await replay();
  assert.equal(report.summary.verifiedAttempts, 1);
  assert.equal(report.summary.candidateJobs, 2);
  assert.equal(report.summary.candidateWorkerSeconds, 40);
  variant = "failure";
  report = await replay();
  assert.equal(report.summary.failedSuggestedSkips, 1);
  assert.equal(report.summary.candidateJobs, 1);
  for (const v of ["partial", "missing-log"]) {
    variant = v;
    report = await replay();
    assert.equal(report.summary.unknownAttempts, 1);
    assert.equal(report.summary.candidateWorkerSeconds, 0);
  }
});
