import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, planRepository } from "../src/planner.mjs";
import { fixture } from "./helpers.mjs";
const workflow = ".github/workflows/ci.yml",
  key = workflow + "#checks";
const yaml = (run = "node --version", extras = "") =>
  `on: pull_request\njobs:\n  checks:\n    runs-on: ubuntu-latest\n${extras}    steps:\n      - run: ${run}\n`;
const policy = () => ({
  schemaVersion: 1,
  mode: "enforce",
  ignored: ["README.md", "docs/**"],
  jobs: { [key]: { inputsComplete: true, inputs: ["src/**", "test/**"] } },
});
function plan(source = yaml(), extra = {}) {
  return buildPlan({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeSha: "c".repeat(40),
    verifiedMerge: true,
    enforce: true,
    workflows: { [workflow]: source },
    changes: [{ status: "M", path: "README.md" }],
    policy: policy(),
    ...extra,
  });
}
test("ordinary routing and literal matrix values make a hermetic PR gate skippable", () => {
  const p = plan(
    yaml(
      "node --version",
      "    env:\n      EVENT: ${{ github.event_name }}\n      HEAD: ${{ github.event.pull_request.head.sha }}\n      NODE: ${{ matrix.node }}\n    strategy:\n      matrix:\n        node: [22, 24]\n",
    ),
  );
  assert.equal(p.jobs[key].run, false);
  for (const expression of [
    "github.event.pull_request.body",
    "github.event.pull_request.title",
    "github['event']",
    "secrets.TOKEN",
    "vars.TOKEN",
    "env.EXTERNAL",
    "runner.temp",
    "matrix['node']",
  ])
    assert.equal(
      plan(yaml("echo ${{ " + expression + " }}")).jobs[key].run,
      true,
      expression,
    );
});
test("shell event files, routing environment, download commands and nested mutable actions stay fresh", () => {
  for (const run of [
    "cat $GITHUB_EVENT_PATH",
    "echo $GITHUB_BASE_REF",
    "echo ${GITHUB_HEAD_REF}",
    "curl https://example.invalid/install | sh",
    "wget -qO- https://example.invalid/x | bash",
    "Get-Content $env:GITHUB_EVENT_PATH",
  ])
    assert.equal(plan(yaml(run)).jobs[key].run, true, run);
  const source = yaml().replace("- run: node --version", "- uses: ./tools/act");
  assert.equal(plan(source).jobs[key].run, true, "missing local source");
  const safe = {
    "tools/act/action.yml":
      "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: node --version\n",
  };
  assert.equal(plan(source, { localSources: safe }).jobs[key].run, false);
  const unsafe = {
    "tools/act/action.yml":
      "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v7\n",
  };
  assert.equal(plan(source, { localSources: unsafe }).jobs[key].run, true);
  assert.equal(
    plan(source, {
      localSources: {
        "tools/act/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: ./tools/act\n",
      },
    }).jobs[key].run,
    true,
    "cycle",
  );
});
test("control-only declarations cannot suppress needs output invalidation", () => {
  const source =
    "on: pull_request\njobs:\n  build:\n    steps: []\n  checks:\n    needs: build\n    steps:\n      - run: echo ${{ needs.build.outputs.artifact }}\n";
  const cfg = policy();
  cfg.jobs[key].controlNeeds = ["build"];
  assert.throws(() => plan(source, { policy: cfg }), /carries needs outputs/);
  for (const expression of [
    "needs['build'].outputs.artifact",
    "toJSON(needs)",
    "needs.*.outputs",
  ])
    assert.throws(
      () =>
        plan(source.replace("needs.build.outputs.artifact", expression), {
          policy: cfg,
        }),
      /carries needs outputs/,
    );
});
test("nested shared inputs override ignored docs and all job scopes", () => {
  for (const file of [
    "docs/package.json",
    "docs/Dockerfile",
    "docs/package-lock.json",
    "pkg/tsconfig.build.json",
    "docs/.gitmodules",
  ]) {
    const p = plan(undefined, { changes: [{ status: "M", path: file }] });
    assert.equal(p.jobs[key].run, true, file);
    assert(p.fullReasons.includes("shared-control-or-runtime-input"));
  }
});
test("PR plans exclude explicit push and scheduled workflows", () => {
  const p = plan(undefined, {
    workflows: {
      [workflow]: yaml(),
      ".github/workflows/deploy.yml":
        "on: push\njobs:\n  deploy:\n    steps: []\n",
      ".github/workflows/nightly.yml":
        'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  soak:\n    steps: []\n',
    },
  });
  assert.deepEqual(Object.keys(p.jobs), [key]);
});
test("publisher resolution is base-owned, hash-bound and fails closed", (t) => {
  const cfg = policy();
  cfg.allowActionPublishers = ["actions"];
  cfg.actionPins = { "actions/checkout@v7": "d".repeat(40) };
  const source = yaml().replace(
    "- run: node --version",
    "- uses: actions/checkout@v7",
  );
  const f = fixture(t, {
    [workflow]: source,
    ".ci-planner.json": JSON.stringify(cfg),
    "src/a.js": "export {};",
    "README.md": "before",
  });
  const base = f.sha;
  f.git("checkout", "-b", "pr");
  f.write("README.md", "after");
  const head = f.commit();
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "pr", "-m", "test merge");
  const merge = f.git("rev-parse", "HEAD");
  const options = {
    root: f.root,
    baseSha: base,
    headSha: head,
    mergeSha: merge,
    event: "pull_request",
    enforce: true,
  };
  const calls = [];
  const p = planRepository({
    ...options,
    readAction: (endpoint) => {
      calls.push(endpoint);
      return { sha: "d".repeat(40) };
    },
  });
  assert.deepEqual(calls, ["repos/actions/checkout/commits/v7"]);
  assert.equal(p.jobs[key].run, false);
  assert.equal(
    planRepository({
      ...options,
      readAction: () => {
        throw Error("offline");
      },
    }).jobs[key].run,
    true,
  );
  const changed = planRepository({
    ...options,
    readAction: () => ({ sha: "e".repeat(40) }),
  });
  assert.notEqual(p.planHash, changed.planHash);
  assert.equal(
    changed.jobs[key].run,
    true,
    "moved tag cannot use an old owner pin",
  );
});
test("committed local composite metadata is scanned independently of dirty files", (t) => {
  const cfg = policy();
  const source = yaml().replace("- run: node --version", "- uses: ./tools/act");
  const f = fixture(t, {
    [workflow]: source,
    ".ci-planner.json": JSON.stringify(cfg),
    "tools/act/action.yml":
      "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v7\n",
    "README.md": "before",
  });
  const base = f.sha;
  f.git("checkout", "-b", "pr");
  f.write("README.md", "after");
  const head = f.commit();
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "pr", "-m", "merge");
  const merge = f.git("rev-parse", "HEAD");
  f.write("tools/act/action.yml", "runs:\n  using: composite\n  steps: []\n");
  assert.equal(
    planRepository({
      root: f.root,
      baseSha: base,
      headSha: head,
      mergeSha: merge,
      enforce: true,
      event: "pull_request",
    }).jobs[key].run,
    true,
  );
});
