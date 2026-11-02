import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildPlan,
  discoverWorkflows,
  patternMatches,
  planRepository,
} from "../src/planner.mjs";

const workflow = ".github/workflows/ci.yml";
const key = (id) => workflow + "#" + id;
const source =
  "name: CI\non: pull_request\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n  tests:\n    needs: lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n";
const policy = () => ({
  schemaVersion: 1,
  mode: "enforce",
  ignored: ["README.md"],
  jobs: {
    [key("lint")]: { inputsComplete: true, inputs: ["lint/**"] },
    [key("tests")]: { inputsComplete: true, inputs: ["src/**", "test/**"] },
    [key("docs")]: { inputsComplete: true, inputs: ["docs/**"] },
  },
});
const options = (extra = {}) => ({
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergeSha: "c".repeat(40),
  verifiedMerge: true,
  workflows: { [workflow]: source },
  policy: policy(),
  changes: [{ status: "M", path: "README.md" }],
  ...extra,
});

test("shadow mode runs every job while exposing suggested skips", () => {
  const plan = buildPlan(options());
  assert.equal(plan.mode, "shadow");
  assert(
    Object.values(plan.jobs).every(
      (job) => job.run && job.candidate === "skip",
    ),
  );
});

test("enforcement requires caller opt-in, base policy opt-in and exact tested merge identity", () => {
  assert(
    Object.values(buildPlan(options({ enforce: true })).jobs).every(
      (job) => !job.run,
    ),
  );
  for (const extra of [
    { verifiedMerge: false },
    { mergeSha: null },
    { policy: { ...policy(), mode: "shadow" } },
    { event: "push" },
    { event: "pull_request_target" },
  ]) {
    const plan = buildPlan(options({ enforce: true, ...extra }));
    assert.equal(plan.mode, "shadow");
    assert(Object.values(plan.jobs).every((job) => job.run));
  }
});

test("changed consumers retain upstream outputs, including transitive producers", () => {
  const nested = source.replace(
    "  lint:\n",
    "  setup:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n  lint:\n    needs: setup\n",
  );
  const scoped = policy();
  scoped.jobs[key("setup")] = { inputsComplete: true, inputs: ["setup/**"] };
  const plan = buildPlan(
    options({
      enforce: true,
      workflows: { [workflow]: nested },
      policy: scoped,
      changes: [{ status: "M", path: "src/main.js" }],
    }),
  );
  for (const id of ["tests", "lint", "setup"])
    assert.equal(plan.jobs[key(id)].run, true, id);
  assert.equal(plan.jobs[key("lint")].reason, "selected-job-needs-output");
  assert.equal(plan.jobs[key("docs")].run, false);
});

test("new jobs and workflows are discovered without a filename registry and always run", () => {
  const extra = ".github/workflows/future.yaml";
  const plan = buildPlan(
    options({
      enforce: true,
      workflows: {
        [workflow]: source,
        [extra]:
          "on: pull_request\njobs:\n  fresh:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n",
      },
    }),
  );
  assert.equal(plan.jobs[extra + "#fresh"].run, true);
  assert.equal(plan.jobs[extra + "#fresh"].reason, "new-or-unscoped-job");
  assert.equal(Object.keys(plan.jobs).length, 4);
});

test("shared, unknown, deleted, empty and manual-full inputs all retain every job", () => {
  for (const changes of [
    [{ status: "M", path: "package-lock.json" }],
    [{ status: "A", path: ".github/workflows/extra.yml" }],
    [{ status: "M", path: "unknown.bin" }],
    [{ status: "D", path: "src/file.js" }],
    [{ status: "R100", path: "README.md" }],
    [],
  ]) {
    const plan = buildPlan(options({ enforce: true, changes }));
    assert(Object.values(plan.jobs).every((job) => job.run));
    assert(plan.fullReasons.length);
  }
  assert(
    Object.values(
      buildPlan(options({ enforce: true, force: true })).jobs,
    ).every((job) => job.run),
  );
});

test("incomplete input declarations and mutable or hidden execution remain fresh", () => {
  const incomplete = policy();
  incomplete.jobs[key("docs")].inputsComplete = false;
  assert.equal(
    buildPlan(options({ enforce: true, policy: incomplete })).jobs[key("docs")]
      .run,
    true,
  );
  for (const replacement of [
    "      - uses: owner/action@v1",
    "      - run: echo\n        env:\n          TOKEN: $" +
      "{{ secrets.TOKEN }}",
  ]) {
    const changed = source.replaceAll(
      "      - run: node --version",
      replacement,
    );
    assert(
      Object.values(
        buildPlan(
          options({ enforce: true, workflows: { [workflow]: changed } }),
        ).jobs,
      ).every((job) => job.run),
    );
  }
  const environment = source.replaceAll(
    "    runs-on: ubuntu-latest",
    "    environment: staging\n    runs-on: ubuntu-latest",
  );
  assert(
    Object.values(
      buildPlan(
        options({ enforce: true, workflows: { [workflow]: environment } }),
      ).jobs,
    ).every((job) => job.run),
  );
  const hiddenGlobal = source.replace(
    "on: pull_request",
    "on: pull_request\ndefaults:\n  run:\n    shell: $" + "{{ vars.SHELL }}",
  );
  assert(
    Object.values(
      buildPlan(
        options({ enforce: true, workflows: { [workflow]: hiddenGlobal } }),
      ).jobs,
    ).every((job) => job.run),
  );
});

test("local action paths are implicit job inputs and pinned action references can be scoped", () => {
  const local = source.replaceAll(
    "      - run: node --version",
    "      - uses: ./actions/example",
  );
  const plan = buildPlan(
    options({
      enforce: true,
      workflows: { [workflow]: local },
      changes: [{ status: "M", path: "actions/example/action.yml" }],
    }),
  );
  assert(Object.values(plan.jobs).every((job) => job.run));
  const pinned = source.replaceAll(
    "      - run: node --version",
    "      - uses: owner/action@" + "d".repeat(40),
  );
  assert(
    Object.values(
      buildPlan(options({ enforce: true, workflows: { [workflow]: pinned } }))
        .jobs,
    ).every((job) => !job.run),
  );
});

test("rejects YAML aliases, duplicate keys, missing/cyclic/dynamic needs and oversized sources", () => {
  for (const text of [
    "jobs:\n  x: &x\n    runs-on: ubuntu-latest\n  y: *x\n",
    "jobs:\n  x: {}\n  x: {}\n",
    "jobs:\n  x:\n    needs: absent\n",
    "jobs:\n  x:\n    needs: y\n  y:\n    needs: x\n",
    "jobs:\n  x:\n    needs: $" + "{{ inputs.needs }}\n",
    "x".repeat(256 * 1024 + 1),
  ])
    assert.throws(() => discoverWorkflows({ [workflow]: text }));
});

test("glob syntax handles recursive segments, escapes regex literals and rejects ambiguous rules", () => {
  for (const file of ["src/a.js", "src/deep/a.js"])
    assert(patternMatches("src/**/a.js", file));
  assert(patternMatches("src/*.js", "src/a.js"));
  assert(!patternMatches("src/*.js", "src/deep/a.js"));
  assert(patternMatches("config+.json", "config+.json"));
  assert(!patternMatches("config+.json", "configgg.json"));
  for (const pattern of [
    "../**",
    "/root/**",
    "src/**x",
    "!src/**",
    "src/[ab]",
    "src/{a,b}",
    "src//x",
    "src/./x",
  ])
    assert.throws(() => patternMatches(pattern, "file"));
});

test("plan hashes isolate repository and source identity and track execution changes", () => {
  const baseline = buildPlan(options()).planHash;
  for (const extra of [
    { repository: "other/project" },
    { headSha: "d".repeat(40) },
    {
      workflows: {
        [workflow]: source.replaceAll("node --version", "node --help"),
      },
    },
  ])
    assert.notEqual(buildPlan(options(extra)).planHash, baseline);
});

async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-planner-"));
  const git = (args) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), data);
  };
  const commit = () => {
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "CI Planner test"]);
    git(["config", "user.email", "tests@example.invalid"]);
    write(workflow, source);
    write(".ci-planner.json", JSON.stringify(policy()));
    write("README.md", "before");
    const baseSha = commit();
    return await fn({ root, git, write, commit, baseSha });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Git planner verifies merge parents and ignores dirty checkout content", () =>
  fixture(({ root, git, write, commit, baseSha }) => {
    write("README.md", "after");
    const headSha = commit();
    const mergeSha = git([
      "commit-tree",
      headSha + "^{tree}",
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      "tested merge",
    ]);
    write("src/uncommitted.js", "not part of the tested tree");
    const plan = planRepository({
      root,
      baseSha,
      headSha,
      mergeSha,
      enforce: true,
    });
    assert.equal(plan.mode, "enforce");
    assert(Object.values(plan.jobs).every((job) => !job.run));
    assert.throws(
      () =>
        planRepository({
          root,
          baseSha,
          headSha: baseSha,
          mergeSha,
          enforce: true,
        }),
      /exact base and head/,
    );
    assert.throws(
      () => planRepository({ root, baseSha: "--bad", headSha }),
      /full commit SHAs/,
    );
  }));

test("PR policy changes cannot enable skipping and CLI outputs are bound to verified source", () =>
  fixture(({ root, git, write, commit, baseSha: originalBase }) => {
    const shadow = { ...policy(), mode: "shadow" };
    write(".ci-planner.json", JSON.stringify(shadow));
    const baseSha = commit();
    write(".ci-planner.json", JSON.stringify(policy()));
    write("README.md", "after");
    const headSha = commit();
    const mergeSha = git([
      "commit-tree",
      headSha + "^{tree}",
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      "tested merge",
    ]);
    const plan = planRepository({
      root,
      baseSha,
      headSha,
      mergeSha,
      enforce: true,
    });
    assert.equal(plan.mode, "shadow");
    assert(Object.values(plan.jobs).every((job) => job.run));
    const output = path.join(root, "outputs");
    const cli = new URL("../bin/ci-planner.mjs", import.meta.url).pathname;
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "plan",
        "--root",
        root,
        "--base",
        baseSha,
        "--head",
        headSha,
        "--merge",
        mergeSha,
        "--workflow",
        workflow,
        "--enforce",
        "--github-output",
      ],
      { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(output, "utf8"), /ready=true/);
    assert.match(fs.readFileSync(output, "utf8"), /"tests":true/);
    fs.unlinkSync(output);
    const bad = spawnSync(
      process.execPath,
      [
        cli,
        "plan",
        "--root",
        root,
        "--base",
        originalBase,
        "--head",
        headSha,
        "--merge",
        mergeSha,
        "--workflow",
        workflow,
        "--github-output",
      ],
      { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    assert.notEqual(bad.status, 0);
    assert(!fs.existsSync(output));
  }));

test("parallel PR plans keep distinct heads and hashes without shared mutable state", async () =>
  fixture(async ({ root, git, write, commit, baseSha }) => {
    write("README.md", "first PR");
    const first = commit();
    git(["checkout", "-b", "second", baseSha]);
    write("README.md", "second PR");
    const second = commit();
    const cli = new URL("../bin/ci-planner.mjs", import.meta.url).pathname;
    const outputs = await Promise.all(
      [first, second].map((head) =>
        promisify(execFile)(
          process.execPath,
          [cli, "plan", "--root", root, "--base", baseSha, "--head", head],
          { encoding: "utf8" },
        ),
      ),
    );
    const plans = outputs.map((result) => JSON.parse(result.stdout));
    assert.deepEqual(
      plans.map((plan) => plan.identity.headSha),
      [first, second],
    );
    assert.notEqual(plans[0].planHash, plans[1].planHash);
    assert(plans.every((plan) => plan.mode === "shadow"));
  }));
