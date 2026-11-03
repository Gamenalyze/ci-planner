import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { fixture, cli } from "./helpers.mjs";
import { buildPlan } from "../src/planner.mjs";
import {
  readDependencySnapshot,
  readJSONFile,
  commitTree,
} from "../src/evidence.mjs";
import { discoverDependencies } from "../src/dependencies.mjs";
import {
  validateSkipDecisions,
  validationAllowsPlanning,
} from "../src/skip-validation.mjs";
import { advisePerformance } from "../src/performance.mjs";
import { attestValidation, verifyReuse } from "../src/reuse.mjs";
import { renderMarkdown } from "../src/reports.mjs";

const workflow = ".github/workflows/ci.yml",
  key = workflow + "#test";
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  envHash = "d".repeat(64);
const now = Date.parse("2026-11-03T12:00:00Z");
const workflowText =
  "on: [pull_request, push]\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node test.mjs\n";
const date = (s) => new Date(now + s * 1000).toISOString();
function snapshot() {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    runs: [
      {
        id: 1,
        run_attempt: 1,
        path: workflow,
        event: "pull_request",
        head_sha: b,
        status: "completed",
        conclusion: "success",
        jobs: {
          total_count: 1,
          items: [
            {
              id: 11,
              run_id: 1,
              run_attempt: 1,
              name: "test",
              status: "completed",
              conclusion: "success",
              started_at: date(0),
              completed_at: date(240),
            },
          ],
        },
      },
    ],
  };
}
function observation() {
  const plan = buildPlan({
    repository: "owner/repo",
    baseSha: a,
    headSha: b,
    mergeSha: c,
    verifiedMerge: true,
    workflows: { [workflow]: workflowText },
    policy: {
      schemaVersion: 1,
      mode: "enforce",
      ignored: ["README.md"],
      jobs: { [key]: { inputsComplete: true, inputs: ["src/**"] } },
    },
    changes: [{ status: "M", path: "README.md" }],
  });
  return {
    plan,
    snapshot: snapshot(),
    workflow,
    runId: 1,
    testedSha: c,
    fullRun: true,
    jobNames: { [key]: ["test"] },
  };
}

test("skip validation compares suggestions to an explicit complete full run, without granting skips", () => {
  const input = observation(),
    report = validateSkipDecisions(input);
  assert.equal(report.safe, true);
  assert.equal(report.decisions[0].candidate, "skip");
  assert(validationAllowsPlanning(report, input.plan.policyHash, workflow));
  assert(!validationAllowsPlanning(report, "f".repeat(64), workflow));
  assert(
    !validationAllowsPlanning(
      report,
      input.plan.policyHash,
      ".github/workflows/other.yml",
    ),
  );
  const failed = structuredClone(input);
  failed.snapshot.runs[0].jobs.items[0].conclusion = "failure";
  failed.snapshot.runs[0].conclusion = "failure";
  const bad = validateSkipDecisions(failed);
  assert.equal(bad.fallback, true);
  assert(bad.issues.some((i) => i.reason === "failed-suggested-skip"));
  assert(
    !validationAllowsPlanning(
      { ...bad, safe: true, fallback: false, issues: [] },
      input.plan.policyHash,
      workflow,
    ),
  );
});

test("unknown, cancelled, skipped, partial, repeated and incorrectly bound validation evidence runs fresh", () => {
  for (const modify of [
    (x) => {
      x.fullRun = false;
    },
    (x) => {
      x.testedSha = a;
    },
    (x) => {
      x.jobNames = {};
    },
    (x) => {
      x.snapshot.runs[0].head_sha = a;
    },
    (x) => {
      x.snapshot.runs[0].path = ".github/workflows/other.yml";
    },
    (x) => {
      x.snapshot.runs[0].jobs.total_count = 2;
    },
    (x) => {
      x.snapshot.runs[0].status = "in_progress";
    },
    (x) => {
      x.snapshot.runs[0].jobs.items[0].conclusion = "skipped";
    },
    (x) => {
      x.snapshot.runs[0].jobs.items[0].conclusion = "cancelled";
    },
    (x) => {
      x.snapshot.runs[0].jobs.items.push({
        ...x.snapshot.runs[0].jobs.items[0],
        id: 12,
      });
      x.snapshot.runs[0].jobs.total_count = 2;
    },
  ]) {
    const x = observation();
    modify(x);
    assert.equal(validateSkipDecisions(x).safe, false);
  }
  const mixed = observation();
  mixed.snapshot.runs[0].jobs.items[0].run_attempt = 2;
  assert.throws(() => validateSkipDecisions(mixed));
});

test("matrix validation requires every explicitly mapped member to succeed", () => {
  const input = observation(),
    run = input.snapshot.runs[0];
  run.jobs.items[0].name = "test (22)";
  run.jobs.items.push({ ...run.jobs.items[0], id: 12, name: "test (24)" });
  run.jobs.total_count = 2;
  input.jobNames[key] = ["test (22)", "test (24)"];
  assert(validateSkipDecisions(input).safe);
  input.jobNames[key].pop();
  assert(!validateSkipDecisions(input).safe);
});

function workspaceFiles() {
  return {
    "package.json": '{"private":true,"workspaces":["packages/*"]}',
    "package-lock.json": "{}",
    "packages/core/package.json": '{"name":"@test/core"}',
    "packages/core/src/index.ts": "export const x = 1;",
    "packages/api/package.json":
      '{"name":"api","dependencies":{"@test/core":"workspace:*"}}',
    "packages/api/src/main.ts": "import { x } from '@test/core'; export { x };",
    "packages/web/package.json": '{"name":"web"}',
    "packages/web/src/main.ts": "export {x} from '../../core/src/index.js';",
    "packages/web/tsconfig.json": '{"references":[{"path":"../api"}]}',
    "packages/other/package.json": '{"name":"other"}',
    "packages/other/src/index.ts": "export const y = 2;",
  };
}
test("workspace graph follows package, cross-package literal imports and TS reference edges transitively", () => {
  const report = discoverDependencies({ ref: a, files: workspaceFiles() }, [
    "packages/core/src/index.ts",
  ]);
  assert.deepEqual(report.affectedPackages, [
    "packages/api",
    "packages/core",
    "packages/web",
  ]);
  const web = report.packages.find((p) => p.name === "web");
  assert.deepEqual(web.dependencies, ["packages/api", "packages/core"]);
  assert(web.suggestedInputs.includes("packages/core/**"));
  assert(report.packages.every((p) => p.inputsComplete === false));
  assert(
    report.packages
      .filter((p) => p.directory !== ".")
      .every((p) => p.workspace),
  );
  assert(
    discoverDependencies({ ref: a, files: workspaceFiles() }, [
      "package-lock.json",
    ]).packages.every((p) => p.affected),
  );
});
test("pnpm, local package links, import cycles and unsupported dynamic inputs remain visible", () => {
  const files = workspaceFiles();
  files["pnpm-workspace.yaml"] = "packages:\n  - packages/*\n";
  files["packages/api/package.json"] =
    '{"name":"api","dependencies":{"linked":"file:../core"}}';
  files["packages/core/src/index.ts"] =
    "export { x } from '../../web/src/main'; const m = import(moduleName); require('alias/foo');";
  files["packages/web/tsconfig.json"] =
    '{"references":[{"path":"../api"}],"compilerOptions":{"paths":{"@alias/*":["src/*"]}}}';
  const report = discoverDependencies({ ref: a, files }, [
    "packages/api/src/main.ts",
  ]);
  assert(report.affectedPackages.includes("packages/core"));
  assert(
    report.warnings.some(
      (w) => w.reason === "dynamic-module-or-file-discovery",
    ),
  );
  assert(
    report.warnings.some(
      (w) => w.reason === "typescript-aliases-require-owner-review",
    ),
  );
});
test("discovery reads committed state, ignores dirty files and never follows symlinks or submodules", (t) => {
  const f = fixture(t, workspaceFiles());
  f.write("packages/core/src/index.ts", "throw new Error('do not execute');");
  const snap = readDependencySnapshot({ root: f.root, ref: f.sha });
  assert.equal(snap.files["packages/core/src/index.ts"], "export const x = 1;");
  fs.symlinkSync("/etc/passwd", path.join(f.root, "leak.ts"));
  f.commit();
  assert.equal(readDependencySnapshot({ root: f.root }).files["leak.ts"], null);
  assert.throws(() => readDependencySnapshot({ root: f.root, ref: "--help" }));
});

test("performance advice finds explicit shard skew, repeated installs, a long tail and cache uncertainty", () => {
  const snap = snapshot(),
    run = snap.runs[0],
    slow = run.jobs.items[0];
  slow.name = "tests shard 1/2";
  slow.completed_at = date(600);
  slow.steps = [
    {
      number: 1,
      name: "npm ci",
      status: "completed",
      conclusion: "success",
      started_at: date(0),
      completed_at: date(120),
    },
  ];
  run.jobs.items.push({
    ...structuredClone(slow),
    id: 12,
    name: "tests shard 2/2",
    completed_at: date(200),
  });
  run.jobs.total_count = 2;
  const result = advisePerformance(snap),
    types = result.findings.map((f) => f.type);
  for (const kind of [
    "uneven-shards-review",
    "repeated-install-review",
    "last-finishing-job-review",
    "cache-configuration-review",
  ])
    assert(types.includes(kind), kind);
  assert.equal(result.cache.hitRate, null);
  assert.equal(result.estimatedSavingsSeconds, null);
  assert.match(renderMarkdown(result), /Unknown/);
});
test("performance distinguishes instrumented cache misses from absent metadata, and rejects mixed identities", () => {
  const snap = snapshot(),
    run = snap.runs[0];
  run.jobs.items[0].steps = [1, 2, 3].map((number) => ({
    number,
    name: "Cache restore",
    status: "completed",
    conclusion: "success",
    started_at: date(0),
    completed_at: date(25),
  }));
  snap.cacheObservations = [1, 2, 3].map((stepNumber) => ({
    jobId: 11,
    stepNumber,
    hit: false,
  }));
  const report = advisePerformance(snap);
  assert.equal(report.cache.hitRate, 0);
  assert(report.findings.some((f) => f.type === "low-cache-hit-rate-review"));
  snap.cacheObservations[0].jobId = 999;
  assert.throws(() => advisePerformance(snap));
});

async function reuseFixture(t) {
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const f = fixture(t, {
    [workflow]: workflowText,
    "src/main.ts": "export const x = 1;",
    ".ci-planner-reuse.json": JSON.stringify({
      schemaVersion: 1,
      workflow,
      hermetic: true,
      noArtifacts: true,
      publicKeys: [publicKey],
      environmentHash: envHash,
      maxAgeSeconds: 3600,
      jobs: ["test"],
    }),
  });
  const source = f.sha;
  f.git("commit", "--allow-empty", "-m", "equivalent main commit");
  const target = f.git("rev-parse", "HEAD");
  const keyFile = f.root + "-signer.key";
  fs.writeFileSync(
    keyFile,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  t.after(() => fs.rmSync(keyFile, { force: true }));
  const run = {
    ...snapshot().runs[0],
    head_sha: source,
    repository: { full_name: "owner/repo" },
  };
  run.jobs.items[0].started_at = date(-300);
  run.jobs.items[0].completed_at = date(-60);
  run.jobs.items[0].steps = [
    { number: 1, name: "Validate", status: "completed", conclusion: "success" },
  ];
  const read = async (url) => {
    if (url === "repos/owner/repo")
      return { full_name: "owner/repo", default_branch: "main" };
    if (url === "repos/owner/repo/branches/main")
      return { commit: { sha: target } };
    if (url === "repos/owner/repo/actions/runs/1") return structuredClone(run);
    if (
      url ===
      "repos/owner/repo/actions/runs/1/attempts/1/jobs?per_page=100&page=1"
    )
      return { total_count: 1, jobs: structuredClone(run.jobs.items) };
    throw Error("Unexpected endpoint " + url);
  };
  const options = {
    root: f.root,
    repository: "owner/repo",
    testedSha: source,
    runId: 1,
    environmentHash: envHash,
    keyFile,
    fullRun: true,
    now,
  };
  const old = process.env.GITHUB_EVENT_NAME;
  delete process.env.GITHUB_EVENT_NAME;
  let receipt;
  try {
    receipt = await attestValidation(options, read);
  } finally {
    if (old !== undefined) process.env.GITHUB_EVENT_NAME = old;
  }
  return {
    f,
    source,
    target,
    run,
    read,
    receipt,
    signOptions: options,
    options: {
      root: f.root,
      repository: "owner/repo",
      targetSha: target,
      environmentHash: envHash,
      receipt,
      now,
    },
  };
}
test("reuse verifies owner signature, identical full tree, runtime contract and live latest successful PR attempt", async (t) => {
  const ctx = await reuseFixture(t),
    result = await verifyReuse(ctx.options, ctx.read);
  assert.equal(result.reusable, true);
  assert.equal(result.run, false);
  assert.equal(result.sourceRunId, 1);
  assert.equal(
    commitTree(ctx.f.root, ctx.source),
    commitTree(ctx.f.root, ctx.target),
  );
  assert.match(renderMarkdown(result), /Signed evidence/);
});
test("reuse fails closed on missing, altered, stale, unknown-environment and differently scoped evidence", async (t) => {
  const ctx = await reuseFixture(t);
  for (const override of [
    { receipt: null },
    { environmentHash: undefined },
    { environmentHash: "e".repeat(64) },
    { now: now + 3601000 },
    { now: now - 1000 },
    { repository: "other/repo" },
    { receipt: { ...ctx.receipt, signature: "A".repeat(86) + "==" } },
    {
      receipt: {
        ...ctx.receipt,
        statement: { ...ctx.receipt.statement, fullRun: false },
      },
    },
    {
      receipt: {
        ...ctx.receipt,
        statement: {
          ...ctx.receipt.statement,
          environmentHash: "e".repeat(64),
        },
      },
    },
  ])
    assert.equal(
      (await verifyReuse({ ...ctx.options, ...override }, ctx.read)).run,
      true,
    );
});
test("different code, dependency, workflow and policy trees always require a fresh run", async (t) => {
  const ctx = await reuseFixture(t);
  for (const name of [
    "src/main.ts",
    "package-lock.json",
    workflow,
    ".ci-planner-reuse.json",
  ]) {
    ctx.f.write(name, "changed");
    const targetSha = ctx.f.commit();
    assert.equal(
      (await verifyReuse({ ...ctx.options, targetSha }, ctx.read)).run,
      true,
      name,
    );
    ctx.f.git("reset", "--hard", ctx.target);
  }
});
test("reuse rejects skipped/failed jobs, ambiguous display names, run drift and default branch movement", async (t) => {
  const ctx = await reuseFixture(t);
  for (const modify of [
    (run) => {
      run.event = "pull_request_target";
    },
    (run) => {
      run.repository.full_name = "fork/repo";
    },
    (run) => {
      run.jobs.items[0].conclusion = "skipped";
    },
    (run) => {
      run.jobs.items[0].conclusion = "failure";
    },
    (run) => {
      run.run_attempt = 2;
    },
    (run) => {
      run.head_sha = a;
    },
    (run) => {
      run.jobs.items.push({ ...run.jobs.items[0], id: 12 });
    },
  ]) {
    const read = async (url) => {
      const value = await ctx.read(url);
      if (url.endsWith("runs/1")) modify(value);
      if (url.includes("/jobs?")) {
        const run = structuredClone(ctx.run);
        modify(run);
        value.jobs = run.jobs.items;
        value.total_count = value.jobs.length;
      }
      return value;
    };
    assert.equal((await verifyReuse(ctx.options, read)).run, true);
  }
  let branchReads = 0;
  assert.equal(
    (
      await verifyReuse(ctx.options, async (url) =>
        url.endsWith("branches/main") && ++branchReads === 2
          ? { commit: { sha: a } }
          : ctx.read(url),
      )
    ).run,
    true,
  );
  let runReads = 0;
  assert.equal(
    (
      await verifyReuse(ctx.options, async (url) =>
        url.endsWith("runs/1") && ++runReads === 2
          ? { ...ctx.run, run_attempt: 2 }
          : ctx.read(url),
      )
    ).run,
    true,
  );
  assert.equal(
    (
      await verifyReuse(ctx.options, () => {
        throw Error("private server payload");
      })
    ).run,
    true,
  );
});
test("attestation refuses PR signing, non-full runs, non-Ed25519 keys and unbound tested commits", async (t) => {
  const ctx = await reuseFixture(t),
    old = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = "pull_request";
  await assert.rejects(
    attestValidation(ctx.signOptions, ctx.read),
    /PR contexts/,
  );
  if (old === undefined) delete process.env.GITHUB_EVENT_NAME;
  else process.env.GITHUB_EVENT_NAME = old;
  await assert.rejects(
    attestValidation({ ...ctx.signOptions, fullRun: false }, ctx.read),
  );
  await assert.rejects(
    attestValidation({ ...ctx.signOptions, testedSha: ctx.target }, ctx.read),
  );
  fs.writeFileSync(ctx.signOptions.keyFile, "sensitive key material");
  await assert.rejects(
    attestValidation(ctx.signOptions, ctx.read),
    (e) => !e.message.includes("sensitive"),
  );
});
test("new CLI commands ship escaped reports and missing receipts export only fresh-run decisions", (t) => {
  const f = fixture(t, workspaceFiles()),
    input = path.join(f.root, "observation.json");
  fs.writeFileSync(input, JSON.stringify(observation()));
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.match(
    run("validate", "--input", input, "--format", "markdown"),
    /Skip decision validation/,
  );
  assert.match(
    run("discover", "--root", f.root, "--format", "markdown"),
    /Repository dependency discovery/,
  );
  const output = path.join(f.root, "output");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "reuse",
      "--root",
      f.root,
      "--repository",
      "owner/repo",
      "--target",
      f.sha,
      "--input",
      path.join(f.root, "missing"),
      "--environment",
      envHash,
      "--github-output",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: f.sha,
        GITHUB_OUTPUT: output,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    fs.readFileSync(output, "utf8"),
    /^run=true\nreusable=false\nready=true\n$/,
  );
  const dup = path.join(f.root, "duplicate.json");
  fs.writeFileSync(dup, '{"private":"do not print","private":"x"}');
  assert.throws(
    () => readJSONFile(dup),
    (e) => !e.message.includes("do not print"),
  );
});
test("failed or absent feedback forces all plan jobs without weakening owner enforcement gates", (t) => {
  const policy = observation().plan;
  const f = fixture(t, {
    [workflow]: workflowText,
    ".ci-planner.json": JSON.stringify({
      schemaVersion: 1,
      mode: "enforce",
      ignored: ["README.md"],
      jobs: { [key]: { inputsComplete: true, inputs: ["src/**"] } },
    }),
    "README.md": "base",
    "src/main.ts": "base",
  });
  f.git("checkout", "-b", "pr");
  f.write("README.md", "changed");
  const head = f.commit();
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "pr", "-m", "merge");
  const merge = f.git("rev-parse", "HEAD");
  const args = [
    cli,
    "plan",
    "--root",
    f.root,
    "--repository",
    "owner/repo",
    "--base",
    f.sha,
    "--head",
    head,
    "--merge",
    merge,
    "--enforce",
    "--workflow",
    workflow,
    "--event",
    "pull_request",
  ];
  const normal = JSON.parse(
    execFileSync(process.execPath, args, { encoding: "utf8" }),
  );
  assert.equal(normal.jobs[key].run, false);
  const guarded = JSON.parse(
    execFileSync(
      process.execPath,
      [...args, "--validation-input", path.join(f.root, "missing")],
      { encoding: "utf8" },
    ),
  );
  assert(guarded.jobs[key].run);
  assert(guarded.fullReasons.includes("skip-validation-requires-full-run"));
  assert.notEqual(normal.planHash, guarded.planHash);
  assert.equal(policy.mode, "shadow");
});
