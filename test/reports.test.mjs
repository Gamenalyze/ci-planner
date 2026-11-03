import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { buildPlan } from "../src/planner.mjs";
import { auditSnapshot } from "../src/audit.mjs";
import { renderMarkdown } from "../src/reports.mjs";
import { auditRepositorySnapshot } from "../src/repository-audit.mjs";
import { fixture, cli } from "./helpers.mjs";

const workflow = ".github/workflows/ci.yml";
const source =
  "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n";

test("historical Markdown exposes incomplete collection, unknown evidence and limitations", () => {
  const report = {
    schemaVersion: 1,
    mode: "historical-replay",
    repository: "owner/repo",
    selection: { complete: false, attemptsTruncated: true },
    summary: { verifiedAttempts: 1, unknownAttempts: 1 },
    observations: [{ pr: 12, verified: false, issues: ["run-inventory-unavailable", "<unsafe>"], candidateJobs: 0, candidateWorkerSeconds: 0, failedSuggestedSkips: 0 }],
    limitations: ["Missing logs remain unknown."],
  };
  const before = structuredClone(report);
  const text = renderMarkdown(report);
  assert.match(text, /Partial collection/);
  assert.match(text, /PR inventory complete \| false/);
  assert.match(text, /Attempts truncated \| true/);
  assert.match(text, /run-inventory-unavailable, &lt;unsafe&gt;/);
  assert.match(text, /Missing logs remain unknown\./);
  assert.deepEqual(report, before);
  report.selection = { complete: true, attemptsTruncated: false };
  assert.match(renderMarkdown(report), /Collection: complete bounded PR inventory/);
  assert.doesNotMatch(renderMarkdown(report), /Partial collection/);
  delete report.selection;
  assert.match(renderMarkdown(report), /Partial collection/);
  assert.match(renderMarkdown(report), /Attempts truncated \| unknown/);
  report.observations = Array.from({ length: 120 }, () => report.observations[0]);
  const bounded = renderMarkdown(report);
  assert.match(bounded, /70 more rows omitted; see the JSON report/);
  assert.match(bounded, /Partial collection/);
  assert.match(bounded, /Missing logs remain unknown/);
  assert(Buffer.byteLength(bounded) < 96 * 1024);
});
const plan = (extra = {}) =>
  buildPlan({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    workflows: { [workflow]: source },
    changes: [{ status: "M", path: "README.md" }],
    policy: {
      schemaVersion: 1,
      mode: "shadow",
      ignored: ["README.md"],
      jobs: {
        [workflow + "#test"]: { inputsComplete: true, inputs: ["src/**"] },
      },
    },
    ...extra,
  });

test("Markdown distinguishes shadow suggestions from actual decisions and leaves the plan intact", () => {
  const report = plan();
  const before = structuredClone(report);
  const text = renderMarkdown(report);
  assert.match(text, /Shadow mode: every job runs/);
  assert.match(text, /Run: 1 · Skip: 0 · Suggested skips: 1/);
  assert.match(text, /Owner-declared inputs are unchanged/);
  assert.deepEqual(report, before);
  const enforced = plan({
    enforce: true,
    verifiedMerge: true,
    mergeSha: "c".repeat(40),
    policy: {
      schemaVersion: 1,
      mode: "enforce",
      ignored: ["README.md"],
      jobs: {
        [workflow + "#test"]: { inputsComplete: true, inputs: ["src/**"] },
      },
    },
  });
  assert.match(renderMarkdown(enforced), /Run: 0 · Skip: 1/);
});

test("timing summary counts cannot inject Markdown or HTML through report input", (t) => {
  const f = fixture(t),
    input = path.join(f.root, "report.json"),
    summary = path.join(f.root, "summary.md");
  const report = {
    schemaVersion: 1,
    mode: "read-only-audit",
    repository: "owner/repo",
    runs: [],
    findings: [],
    totals: {
      workerSeconds: 0,
      completeRuns: "\n\n![passed](https://evil.example/ping)\n<!--",
    },
  };
  assert.throws(() => renderMarkdown(report), /Invalid timing report/);
  fs.writeFileSync(input, JSON.stringify(report));
  fs.writeFileSync(summary, "previous summary\n");
  const result = spawnSync(
    process.execPath,
    [cli, "report", "--input", input, "--summary"],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(summary, "utf8"), "previous summary\n");
});

test("reports escape HTML, table delimiters, links and mentions without exposing unknown command fields", () => {
  const report = plan();
  const malicious = "<script>@owners|[click](javascript:bad)\n";
  report.jobs[malicious] = report.jobs[workflow + "#test"];
  report.command = "DO_NOT_RENDER_SECRET_OR_COMMAND";
  const text = renderMarkdown(report);
  assert(!text.includes("<script>"));
  assert(!text.includes("@owners"));
  assert(!text.includes("[click]"));
  assert(!text.includes("DO_NOT_RENDER"));
  assert.match(text, /&lt;script&gt;&#64;owners&#124;/);
});

test("completeness summaries retain uncertainty and never call recognized checks passed", () => {
  const report = auditRepositorySnapshot({
    ref: "a".repeat(40),
    files: {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "src/a.js": null,
      [workflow]: source.replace(
        "      - run:",
        "      - if: vars.CHECK == 'yes'\n        run:",
      ),
    },
  });
  const text = renderMarkdown(report);
  assert.match(text, /conditional: 1/);
  assert.match(text, /not a passed check/);
  assert.match(text, /missing/);
});

test("timing summaries show incomplete worker observations without inventing savings or billing", () => {
  const report = auditSnapshot({
    schemaVersion: 1,
    repository: "owner/repo",
    runs: [
      {
        id: 1,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        jobs: {
          total_count: 2,
          items: [
            {
              id: 2,
              run_id: 1,
              run_attempt: 1,
              status: "completed",
              conclusion: "success",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:02:00Z",
            },
          ],
        },
      },
    ],
  });
  const text = renderMarkdown(report);
  assert.match(text, /Observed worker-minutes: 2.0/);
  assert.match(text, /Complete runs: 0 \/ 1/);
  assert.match(text, /Partial/);
  assert.match(
    text,
    /not wall-clock duration, billed minutes or proven savings/,
  );
  assert(!text.includes("$"));
});

test("large reports are bounded and unsupported shapes fail instead of producing an empty green report", () => {
  const report = plan();
  report.jobs = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      "job-" + i + "-".repeat(240),
      { run: true, candidate: "run", reason: "new-or-unscoped-job" },
    ]),
  );
  const text = renderMarkdown(report);
  assert(Buffer.byteLength(text) < 96 * 1024);
  assert.match(text, /950 more rows omitted/);
  for (const value of [null, {}, { schemaVersion: 1, mode: "unknown" }])
    assert.throws(() => renderMarkdown(value));
});

test("no-op fix reports say that no changes are proposed without a misleading rollback instruction", () => {
  const text = renderMarkdown({
    schemaVersion: 1,
    mode: "fix-preview",
    ref: "a".repeat(40),
    addedCheckIds: [],
    notAdded: [],
  });
  assert.match(text, /No supported missing checks to publish/);
  assert(!text.includes("Rollback"));
});

test("CLI keeps JSON by default, emits Markdown on request and appends summaries without overwriting", (t) => {
  const f = fixture(t, { "README.md": "fixture" });
  const input = path.join(f.root, "input.json");
  fs.writeFileSync(input, JSON.stringify(plan()));
  const summary = path.join(f.root, "summary.md");
  fs.writeFileSync(summary, "Earlier step\n");
  const result = execFileSync(
    process.execPath,
    [cli, "report", "--input", input, "--format", "json", "--summary"],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    },
  );
  assert.equal(JSON.parse(result).mode, "shadow");
  assert.match(
    fs.readFileSync(summary, "utf8"),
    /^Earlier step\n## CI Planner/,
  );
  const md = execFileSync(process.execPath, [cli, "report", "--input", input], {
    encoding: "utf8",
  });
  assert.match(md, /^## CI Planner/);
  const audit = execFileSync(
    process.execPath,
    [cli, "audit-repo", "--root", f.root],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(audit).mode, "read-only-repository-audit");
});

test("CLI presentation failures cannot publish ready outputs; summary IO failure cannot authorize extra skips", (t) => {
  const f = fixture(t, { [workflow]: source });
  const output = path.join(f.root, "outputs");
  fs.writeFileSync(output, "");
  const args = [
    cli,
    "plan",
    "--event",
    "pull_request",
    "--root",
    f.root,
    "--base",
    f.sha,
    "--head",
    f.sha,
    "--workflow",
    workflow,
    "--github-output",
    "--summary",
  ];
  const missing = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(missing.status, 1);
  assert.equal(fs.readFileSync(output, "utf8"), "");
  for (const callerEvent of ["push", "pull_request"]) {
    fs.writeFileSync(output, "");
    const unavailable = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: callerEvent,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: f.root,
      },
    });
    assert.equal(unavailable.status, 0);
    assert.match(unavailable.stderr, /summary unavailable/);
    assert.equal(JSON.parse(unavailable.stdout).mode, "shadow");
    assert.match(fs.readFileSync(output, "utf8"), /ready=true/);
  }
  fs.writeFileSync(output, "");
  const nonPrArgs = [...args];
  nonPrArgs[nonPrArgs.indexOf("--event") + 1] = "push";
  const absent = spawnSync(process.execPath, nonPrArgs, {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: f.root },
  });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /Requested workflow is absent/);
  assert.equal(fs.readFileSync(output, "utf8"), "");
  for (const bad of [
    ["--format", "html"],
    ["--format", "json", "--format", "markdown"],
  ])
    assert.equal(
      spawnSync(process.execPath, [cli, "audit-repo", "--root", f.root, ...bad])
        .status,
      1,
    );
});

test("report command bounds input and refuses duplicate keys", (t) => {
  const f = fixture(t);
  const input = path.join(f.root, "report.json");
  fs.writeFileSync(input, '{"schemaVersion":1,"schemaVersion":1}');
  assert.equal(
    spawnSync(process.execPath, [cli, "report", "--input", input]).status,
    1,
  );
  fs.writeFileSync(input, '{"secret":PRIVATE_STDIN_VALUE');
  const invalid = spawnSync(
    process.execPath,
    [cli, "report", "--input", input],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert(!invalid.stderr.includes("PRIVATE_STDIN_VALUE"));
  fs.truncateSync(input, 4 * 1024 * 1024 + 1);
  assert.equal(
    spawnSync(process.execPath, [cli, "report", "--input", input]).status,
    1,
  );
});

test("optional repository summaries use committed inputs and cannot change a plan decision or hash", (t) => {
  const f = fixture(t, {
    [workflow]: source,
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "src/a.js": "fixture",
  });
  const args = [
    cli,
    "plan",
    "--root",
    f.root,
    "--base",
    f.sha,
    "--head",
    f.sha,
  ];
  const plain = JSON.parse(
    execFileSync(process.execPath, args, { encoding: "utf8" }),
  );
  f.write("package.json", "DIRTY_SECRET_NOT_A_MANIFEST");
  const combined = JSON.parse(
    execFileSync(process.execPath, [...args, "--audit-repo"], {
      encoding: "utf8",
    }),
  );
  assert.equal(combined.repositoryAudit.ref, f.sha);
  assert.equal(combined.planHash, plain.planHash);
  assert.deepEqual(combined.jobs, plain.jobs);
  assert(!JSON.stringify(combined).includes("DIRTY_SECRET"));
  f.commit();
  const invalid = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        "plan",
        "--root",
        f.root,
        "--base",
        f.sha,
        "--head",
        f.git("rev-parse", "HEAD"),
        "--audit-repo",
      ],
      { encoding: "utf8" },
    ),
  );
  assert(invalid.auditWarning);
  assert(Object.values(invalid.jobs).every((job) => job.run));
  assert(!JSON.stringify(invalid).includes("DIRTY_SECRET"));
});
