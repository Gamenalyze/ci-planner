import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditSnapshot, collectSnapshot, main } from "../src/audit.mjs";

const timestamp = (seconds) =>
  new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const job = (
  id,
  start,
  end,
  conclusion = "success",
  runId = 1,
  attempt = 1,
) => ({
  id,
  run_id: runId,
  run_attempt: attempt,
  name: "worker-" + id,
  status: "completed",
  conclusion,
  started_at: timestamp(start),
  completed_at: timestamp(end),
});
const run = (jobs, extra = {}) => ({
  id: 1,
  run_attempt: 1,
  workflow_id: 10,
  path: ".github/workflows/ci.yml",
  name: "CI",
  event: "pull_request",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
  jobs: { total_count: jobs.length, items: jobs },
  ...extra,
});
const snapshot = (...runs) => ({
  schemaVersion: 1,
  repository: "example/project",
  runs,
});

test("sums parallel matrix workers rather than elapsed time and does not claim billing or savings", () => {
  const report = auditSnapshot(snapshot(run([job(1, 0, 120), job(2, 0, 120)])));
  assert.equal(report.totals.workerSeconds, 240);
  assert.equal(report.totals.completeRuns, 1);
  assert.equal(report.totals.billingMinutes, null);
  assert.equal(report.totals.estimatedSavingsSeconds, null);
  assert.deepEqual(report.findings, []);
});

test("skipped jobs cost zero; unknown, reversed and unfinished times remain partial", () => {
  const jobs = [
    job(1, 0, 30),
    { ...job(2, 0, 100), conclusion: "skipped" },
    { ...job(3, 0, 100), started_at: null },
    { ...job(4, 0, 100), completed_at: "invalid" },
    job(5, 100, 10),
    { ...job(6, 0, 100), status: "in_progress", completed_at: null },
  ];
  const report = auditSnapshot(snapshot(run(jobs)));
  assert.equal(report.totals.workerSeconds, 30);
  assert.equal(report.runs[0].skippedJobs, 1);
  assert.equal(report.runs[0].unknownTimingJobs, 4);
  assert.equal(report.totals.completeRuns, 0);
  assert.equal(report.findings[0].type, "incomplete-observation");
  const missing = auditSnapshot(
    snapshot(
      run([job(1, 0, 30)], {
        jobs: { total_count: 2, items: [job(1, 0, 30)] },
      }),
    ),
  );
  assert.equal(missing.totals.completeRuns, 0);
});

test("failure review clips each worker interval after first failure without treating work as avoidable", () => {
  const report = auditSnapshot(
    snapshot(
      run(
        [
          job(1, 0, 10, "failure"),
          job(2, 0, 100),
          job(3, 50, 100),
          job(4, 0, 5),
        ],
        {
          conclusion: "failure",
        },
      ),
    ),
  );
  assert.equal(report.runs[0].workerSecondsAfterFirstFailure, 140);
  assert.equal(report.findings[0].type, "early-failure-review");
  assert.equal(report.totals.estimatedSavingsSeconds, null);
  const cancelled = auditSnapshot(
    snapshot(run([job(1, 0, 90, "cancelled")], { conclusion: "cancelled" })),
  );
  assert.equal(cancelled.findings[0].type, "cancelled-work-review");
});

test("same head successes are review candidates only within matching workflow, path and event", () => {
  const second = (id, extra = {}) =>
    run([job(id, 0, 10, "success", id)], { id, ...extra });
  const report = auditSnapshot(
    snapshot(
      run([job(1, 0, 10)]),
      second(2),
      second(3, { event: "schedule" }),
      second(4, { event: "push" }),
      second(5, { workflow_id: 20 }),
      second(6, { path: ".github/workflows/other.yml" }),
      second(7, { head_sha: "b".repeat(40) }),
    ),
  );
  assert.deepEqual(
    report.findings.map((item) => [item.type, item.runIds]),
    [["repeated-success-review", [1, 2]]],
  );
  assert.equal(report.mode, "read-only-audit");
});

test("rejects duplicated, mixed-attempt or mismatched-run jobs instead of silently overcounting", () => {
  for (const input of [
    snapshot(run([job(1, 0, 10)]), run([job(1, 0, 10)])),
    snapshot(run([job(1, 0, 10), job(1, 0, 10)])),
    snapshot(run([job(1, 0, 10, "success", 2)])),
    snapshot(run([job(1, 0, 10, "success", 1, 2)])),
    snapshot(run([], { jobs: { total_count: -1, items: [] } })),
    snapshot(run([], { jobs: { total_count: 0, items: [job(1, 0, 10)] } })),
  ])
    assert.throws(() => auditSnapshot(input));
});

test("collects bounded, paginated metadata for the exact latest attempt and strips unrelated fields", async () => {
  const calls = [];
  const listRun = run([], {
    run_attempt: 2,
    secret_payload: "must not survive",
  });
  const snap = await collectSnapshot(
    {
      repository: "example/project",
      branch: "feature/a&b",
      workflow: "ci.yml",
      limit: 1,
    },
    async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes("/workflows/")) return { workflow_runs: [listRun] };
      const count = endpoint.endsWith("page=1") ? 100 : 1;
      return {
        total_count: 101,
        jobs: Array.from({ length: count }, (_, i) => ({
          ...job(calls.length * 1000 + i, 0, 1, "success", 1, 2),
          steps: [{ run: "secret" }],
        })),
      };
    },
  );
  assert.equal(calls.length, 3);
  assert.match(calls[0], /branch=feature%2Fa%26b/);
  assert(
    calls
      .slice(1)
      .every((endpoint) => endpoint.includes("/runs/1/attempts/2/jobs?")),
  );
  assert.equal(snap.runs[0].jobs.items.length, 101);
  assert.equal(snap.runs[0].secret_payload, undefined);
  assert.equal(snap.runs[0].jobs.items[0].steps, undefined);
  assert.equal(auditSnapshot(snap).totals.workerSeconds, 101);
});

test("500-job ceiling exposes incomplete inventory rather than inventing complete totals", async () => {
  let calls = 0;
  const snap = await collectSnapshot(
    { repository: "example/project", limit: 1 },
    async (endpoint) => {
      if (endpoint.includes("/runs?")) return { workflow_runs: [run([])] };
      const start = calls++ * 100;
      return {
        total_count: 501,
        jobs: Array.from({ length: 100 }, (_, i) => job(start + i + 1, 0, 1)),
      };
    },
  );
  assert.equal(calls, 5);
  assert.equal(snap.runs[0].jobs.items.length, 500);
  const report = auditSnapshot(snap);
  assert.equal(report.totals.completeRuns, 0);
  assert.equal(report.findings[0].type, "incomplete-observation");
});

test("malformed/changing pagination and invalid limits fail without unbounded reads", async () => {
  for (const options of [
    { repository: "../bad/name" },
    { repository: "a/b", limit: 21 },
    { repository: "a/b", limit: 0 },
    { repository: "a/b", workflow: "../ci.yml" },
  ]) {
    await assert.rejects(
      collectSnapshot(options, () => {
        throw Error("must not call");
      }),
      /Expected|Limit/,
    );
  }
  let calls = 0;
  await assert.rejects(
    collectSnapshot({ repository: "a/b", limit: 1 }, async (endpoint) => {
      if (endpoint.includes("/runs?")) return { workflow_runs: [run([])] };
      calls++;
      return {
        total_count: calls === 1 ? 101 : 102,
        jobs: Array.from({ length: 100 }, (_, i) => job(i + 1, 0, 1)),
      };
    }),
    /changed during collection/,
  );
  assert.equal(calls, 2);
});

test("offline CLI needs no dependencies or gh; malformed options fail and import is inert", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-audit-"));
  try {
    const file = path.join(dir, "snapshot.json");
    fs.writeFileSync(file, JSON.stringify(snapshot(run([job(1, 0, 90)]))));
    const cli = new URL("../src/audit.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "--input", file], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).totals.workerSeconds, 90);
    assert.deepEqual(fs.readdirSync(dir), ["snapshot.json"]);
    for (const args of [
      ["--input", file, "--snapshot"],
      ["--limit", "1", "--limit", "2"],
      ["--token", "x"],
      ["--branch"],
    ])
      await assert.rejects(main(args));
    assert.match(await main(["--help"]), /No files or CI settings are changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dot and parent repository components are rejected before authenticated reads", async () => {
  for (const repository of ["../..", "owner/..", "./repo", "../repo"]) {
    let calls = 0;
    await assert.rejects(
      collectSnapshot({ repository }, () => {
        calls++;
        return { workflow_runs: [] };
      }),
      /repository/i,
    );
    assert.equal(calls, 0);
  }
});
