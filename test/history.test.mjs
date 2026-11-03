import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  replayHistory,
  checkoutFromLog,
  inspectFullWorkflow,
  unquotedShell,
} from "../src/history.mjs";
import { fixture, cli } from "./helpers.mjs";
import { renderMarkdown } from "../src/reports.mjs";
const workflow = ".github/workflows/ci.yml",
  pin = "a".repeat(40);
const source = `on: pull_request\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [22, 24]\n    steps:\n      - uses: actions/checkout@${pin}\n      - run: npm test\n`;
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
  assert.throws(
    () => inspectFullWorkflow(source, { workflow, jobs: { tests: null } }),
    /Invalid history job contract/,
  );
  for (const changed of [
    source.replace("    strategy:", "    if: false\n    strategy:"),
    source.replace("      - run:", "      - if: false\n        run:"),
    source.replace("npm test", "echo npm test"),
    source.replace("[22, 24]", "[22]"),
    source.replace(pin, "v4"),
  ])
    assert(inspectFullWorkflow(changed, contract).length);
});
test("shipped legacy history contract verifies unit/syntax steps without claiming multiline packaging semantics", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../examples/history-contract.json", import.meta.url), "utf8"));
  const legacy = source.replaceAll("tests:", "validate:") +
    "      - run: npm run check\n      - name: Smoke-test the distributable\n        run: |\n          task_dir=$(mktemp -d)\n          npm pack --pack-destination \"$task_dir\"\n";
  assert.deepEqual(inspectFullWorkflow(legacy, example), []);
  const expanded = structuredClone(example);
  expanded.jobs.validate.requiredSteps.push("Smoke-test the distributable");
  assert(inspectFullWorkflow(legacy, expanded).includes("required-invocation-unverified:validate"));
  assert(inspectFullWorkflow(legacy + "  metadata:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run check\n", example).includes("unmapped-workflow-jobs"));
});
test("bounded historical replay separates known success, failed suggested skips and unknown attempts", async (t) => {
  const files = {
    "package.json": '{"scripts":{"test":"vitest run"}}',
    "src/main.js": "export const x=1;",
    "README.md": "before",
    [workflow]: source + "      - run: node check.js\n",
    ".github/workflows/other.yml": "on: pull_request\njobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: publisher/demo@v1\n",

    ".ci-planner.json": JSON.stringify({
      schemaVersion: 1,
      mode: "shadow",
      ignored: ["README.md"],
      allowActionPublishers: ["publisher"],
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
  const transport = path.join(f.root, "transport");
  fs.mkdirSync(transport);
  const sentinel = path.join(transport, "unexpected-live-read");
  fs.writeFileSync(path.join(transport, "gh"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.HISTORY_NETWORK_SENTINEL, 'called'); process.exit(1);\n", { mode: 0o755 });
  const oldPath = process.env.PATH, oldSentinel = process.env.HISTORY_NETWORK_SENTINEL;
  process.env.PATH = transport + path.delimiter + oldPath;
  process.env.HISTORY_NETWORK_SENTINEL = sentinel;
  t.after(() => { process.env.PATH = oldPath; if (oldSentinel === undefined) delete process.env.HISTORY_NETWORK_SENTINEL; else process.env.HISTORY_NETWORK_SENTINEL = oldSentinel; });
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
      conclusion:
        ["failure", "partial-step"].includes(variant) && i === 0
          ? "failure"
          : "success",
      started_at: start,
      completed_at: end,
      labels: ["ubuntu-latest"],
      steps: [
        checkout,
        {
          number: 3,
          name: "Run npm test",
          status: "completed",
          conclusion:
            variant === "partial-step" && i === 0 ? "failure" : "success",
        },
        {
          number: 4,
          name: "Run node check.js",
          status: "completed",
          conclusion:
            i === 0 && variant === "partial-step"
              ? "skipped"
              : i === 0 && variant === "failure"
                ? "failure"
                : "success",
        },
      ],
    }));
  let inventories = 0;
  const read = async (endpoint) => {
    if (endpoint.includes("/pulls?"))
      return [
        { number: 1, merged_at: end, head: { sha: head } },
        ...(variant === "budget"
          ? [{ number: 2, merged_at: start, head: { sha: head } }]
          : []),
      ];
    if (endpoint.includes("/workflows/")) {
      if (variant === "budget" && ++inventories > 1)
        throw Error("History request budget exceeded");
      return { total_count: 1, workflow_runs: [meta] };
    }
    if (endpoint.includes("/jobs?"))
      return {
        total_count: 2,
        jobs: variant === "partial" ? jobs().slice(0, 1) : jobs(),
      };
    return {
      ...meta,
      conclusion: ["failure", "partial-step"].includes(variant)
        ? "failure"
        : "success",
    };
  };
  const log = async () =>
    variant === "missing-log"
      ? ""
      : `2026-11-03T01:00:01Z [command]/usr/bin/git log -1 --format=%H\n2026-11-03T01:00:02Z ${merge}\n`;
  const fullContract = {
    workflow,
    jobs: {
      tests: {
        ...contract.jobs.tests,
        requiredSteps: ["Run npm test", "Run node check.js"],
      },
    },
  };
  const replay = (limit = 1) =>
    replayHistory(
      {
        root: f.root,
        repository: "owner/repo",
        limit,
        contract: fullContract,
      },
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
  variant = "partial-step";
  report = await replay();
  assert.equal(report.summary.unknownAttempts, 1);
  assert.equal(report.summary.failedSuggestedSkips, 1);
  assert.equal(report.summary.candidateWorkerSeconds, 0);
  variant = "budget";
  inventories = 0;
  report = await replay(2);
  assert.equal(report.summary.verifiedAttempts, 1);
  assert.equal(report.summary.unknownAttempts, 1);
  assert.equal(report.summary.candidateWorkerSeconds, 40);
  assert.equal(report.selection.attemptsTruncated, true);
  assert(report.observations[1].issues.includes("run-inventory-unavailable"));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Partial collection/);
  assert.match(markdown, /Attempts truncated \| true/);
  assert.match(markdown, /run-inventory-unavailable/);
  assert.match(markdown, /Missing logs/);
  for (const v of ["partial", "missing-log"]) {
    variant = v;
    report = await replay();
    assert.equal(report.summary.unknownAttempts, 1);
    assert.equal(report.summary.candidateWorkerSeconds, 0);
  }
  assert.equal(fs.existsSync(sentinel), false, "replay must not consult live Action tag metadata");
});

test("required invocation evidence rejects masked shell failures and custom shells while respecting quoted program text", () => {
  for (const cmd of [
    "npm test | tee out.log",
    "npm test; true",
    "npm test &",
    "npm test && true",
    "npm test || true",
    "! npm test",
    "s\\et +o errexit",
    "npm test --if-present",
    "npm test -- --help",
    "npm test --dry-run",
    "npm test '--listTests'",
    "npm test --'if-pres''ent'",
    "npm test -- --test-skip-pattern=.",
    "npm test --prefix other-package",
    'npm test "$FLAGS"',
    "CI_SKIP_TESTS=true npm test",
    ": npm test",
    "mocha --grep unit",
    "jest -o",
    "vitest run --project core",
    "jest --shard=1/2",
    "npm test test/only-one.test.js",
    "npm test -- --runInBand",
  ]) {
    const changed = source.replace(
      "      - run: npm test",
      "      - name: Run npm test\n        run: " + JSON.stringify(cmd),
    );
    assert(
      inspectFullWorkflow(changed, contract).includes(
        "required-invocation-unverified:tests",
      ),
      cmd,
    );
  }
  for (const extra of [
    "        working-directory: other-package\n",
    "        env: { SKIP_TESTS: true }\n",
  ]) {
    const changed = source.replace("      - run: npm test", "      - name: Run npm test\n" + extra + "        run: npm test");
    assert(inspectFullWorkflow(changed, contract).includes("required-invocation-unverified:tests"));
  }
  for (const cmd of [
    "set +o errexit\nnpm test\ntrue",
    "set +e\nnpm test\ntrue",
    "npm test\necho done",
    "npm test\n:",
  ]) {
    const changed = source.replace(
      "      - run: npm test",
      "      - name: Run npm test\n        run: |\n" +
        cmd.split("\n").map((line) => "          " + line).join("\n"),
    );
    assert(inspectFullWorkflow(changed, contract).includes("required-invocation-unverified:tests"), cmd);
  }
  for (const cmd of ["npm run validate", "node --test", "npx vitest run", "go test ./..."]) {
    const full = source.replace("      - run: npm test", "      - name: Run npm test\n        run: " + JSON.stringify(cmd));
    assert.deepEqual(inspectFullWorkflow(full, contract), [], cmd);
  }
  const custom = source.replace(
    "      - run: npm test",
    "      - name: Run npm test\n        shell: bash {0}\n        run: npm test",
  );
  assert(
    inspectFullWorkflow(custom, contract).includes(
      "required-invocation-unverified:tests",
    ),
  );
  assert(!unquotedShell("node -e 'const x=1; console.log(x);'").includes(";"));
  assert(unquotedShell('npm test "$(false; true)"').includes(";"));
  assert.equal(unquotedShell("npm test 'unterminated"), null);
});

test("history CLI reads an explicit contract through a bounded offline transport", (t) => {
  const f = fixture(t);
  const transport = path.join(f.root, "transport"); fs.mkdirSync(transport);
  fs.writeFileSync(path.join(transport, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
  const contractPath = path.join(f.root, "history-contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  const report = JSON.parse(execFileSync(process.execPath, [cli, "history", "--root", f.root, "--repository", "owner/repo", "--contract", contractPath, "--limit", "1"], { encoding: "utf8", env: { ...process.env, PATH: transport + path.delimiter + process.env.PATH } }));
  assert.equal(report.mode, "historical-replay");
  assert.equal(report.selection.complete, true);
  assert.equal(report.summary.attempts, 0);
});
