import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  previewFix,
  openFixPullRequest,
  fixPullRequestBody,
  githubRequest,
} from "../src/fix-pr.mjs";
import { fixture, cli, localContext, baseFiles } from "./helpers.mjs";

function transport(f, options = {}) {
  const calls = [],
    refs = new Set();
  let baseReads = 0,
    prs = 0;
  const tree = f.git("rev-parse", "HEAD^{tree}");
  const request = async (method, endpoint, body, flags) => {
    calls.push({ method, endpoint, body, flags });
    if (method === "GET" && endpoint === "repos/owner/repo")
      return { full_name: "Owner/Repo", default_branch: "main" };
    if (method === "GET" && endpoint.endsWith("git/ref/heads/main")) {
      baseReads++;
      return {
        object: {
          type: "commit",
          sha:
            options.drift && baseReads > options.drift ? "f".repeat(40) : f.sha,
        },
      };
    }
    if (method === "GET" && endpoint.endsWith("git/commits/" + f.sha))
      return { sha: f.sha, tree: { sha: tree } };
    if (method === "GET" && endpoint.includes("git/ref/heads/ci-planner/fix-"))
      return options.collision ? { object: { sha: "a".repeat(40) } } : null;
    if (method === "POST" && endpoint.endsWith("git/trees"))
      return { sha: "c".repeat(40) };
    if (method === "POST" && endpoint.endsWith("git/commits"))
      return { sha: "d".repeat(40) };
    if (method === "POST" && endpoint.endsWith("git/refs")) {
      if (refs.has(body.ref)) throw Error("already exists");
      refs.add(body.ref);
      return { ref: body.ref, object: { sha: body.sha } };
    }
    if (method === "POST" && endpoint.endsWith("/pulls")) {
      if (options.prFailure) throw Error("RAW_SECRET_SERVER_RESPONSE");
      prs++;
      return { html_url: "https://github.com/Owner/Repo/pull/" + prs };
    }
    throw Error("Unexpected fake request: " + endpoint);
  };
  return { request, calls, refs, count: () => prs };
}

test("fix preview is local, additive, evidence-backed and executes no scripts", (t) => {
  const f = fixture(t, {
    ...baseFiles(),
    "scripts/unsafe.sh": "touch SHOULD_NOT_EXECUTE",
  });
  const report = previewFix({ root: f.root });
  assert.equal(report.mode, "fix-preview");
  assert(report.addedCheckIds.includes("package.json#tests"));
  assert(report.after.covered > report.before.covered);
  assert.equal(report.path, ".github/workflows/ci-planner-checks.yml");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(
    spawnSync(process.execPath, [cli, "fix", "--root", f.root]).status,
    0,
  );
  assert.equal(f.git("status", "--porcelain"), "");
});

test("explicit publication creates exactly one new workflow and a draft PR without updating existing refs", async (t) => {
  localContext(t);
  const f = fixture(t);
  const fake = transport(f);
  const report = await openFixPullRequest(
    { root: f.root, repository: "owner/repo" },
    fake.request,
  );
  assert.equal(report.mode, "fix-pr-created");
  assert.equal(report.draft, true);
  assert.equal(report.url, "https://github.com/Owner/Repo/pull/1");
  const writes = fake.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(
    writes.map((c) => c.endpoint.split("/").at(-1)),
    ["trees", "commits", "refs", "pulls"],
  );
  assert.equal(writes[0].body.tree.length, 1);
  assert.equal(
    writes[0].body.tree[0].path,
    ".github/workflows/ci-planner-checks.yml",
  );
  assert.equal(writes[0].body.base_tree, f.git("rev-parse", "HEAD^{tree}"));
  assert.deepEqual(writes[1].body.parents, [f.sha]);
  assert.equal(
    writes[2].body.ref,
    "refs/heads/ci-planner/fix-" + f.sha.slice(0, 12),
  );
  assert.equal(writes[3].body.draft, true);
  assert.match(writes[3].body.body, /Task description/);
  assert.match(writes[3].body.body, /Rollback/);
  assert.match(writes[3].body.body, /not a successful CI run/);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("publication refuses CI contexts, invalid repositories, base mismatch and branch collisions before ref writes", async (t) => {
  localContext(t);
  const f = fixture(t);
  const noRequest = () => {
    throw Error("transport must not be called");
  };
  await assert.rejects(
    openFixPullRequest({ root: f.root, repository: "../.." }, noRequest),
    /repository/,
  );
  process.env.GITHUB_ACTIONS = "true";
  await assert.rejects(
    openFixPullRequest({ root: f.root, repository: "owner/repo" }, noRequest),
    /local-only/,
  );
  delete process.env.GITHUB_ACTIONS;
  for (const options of [{ drift: -1 }, { collision: true }]) {
    const fake = transport(f, options);
    await assert.rejects(
      openFixPullRequest(
        { root: f.root, repository: "owner/repo" },
        fake.request,
      ),
    );
    assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
  }
});

test("a moved default branch stops publication before creating a branch or PR", async (t) => {
  localContext(t);
  const f = fixture(t);
  const fake = transport(f, { drift: 1 });
  await assert.rejects(
    openFixPullRequest(
      { root: f.root, repository: "owner/repo" },
      fake.request,
    ),
    /moved/,
  );
  assert(
    !fake.calls.some(
      (c) => c.method === "POST" && /\/(?:refs|pulls)$/.test(c.endpoint),
    ),
  );
});

test("concurrent publishers collide on the deterministic branch instead of opening duplicate PRs", async (t) => {
  localContext(t);
  const f = fixture(t);
  const fake = transport(f);
  const results = await Promise.allSettled([
    openFixPullRequest(
      { root: f.root, repository: "owner/repo" },
      fake.request,
    ),
    openFixPullRequest(
      { root: f.root, repository: "owner/repo" },
      fake.request,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(fake.count(), 1);
  assert.equal(fake.refs.size, 1);
});

test("partial PR publication preserves recovery evidence without leaking raw server errors or deleting refs", async (t) => {
  localContext(t);
  const f = fixture(t);
  const fake = transport(f, { prFailure: true });
  await assert.rejects(
    openFixPullRequest(
      { root: f.root, repository: "owner/repo" },
      fake.request,
    ),
    (error) => {
      assert.match(error.message, /Fix branch created at https:\/\/github.com/);
      assert(!error.message.includes("RAW_SECRET"));
      return true;
    },
  );
  assert.equal(fake.refs.size, 1);
  assert(
    !fake.calls.some((c) => ["DELETE", "PATCH", "PUT"].includes(c.method)),
  );
});

test("repos with no supported gaps publish nothing, and generated files are never overwritten", async (t) => {
  localContext(t);
  const f = fixture(t);
  const first = previewFix({ root: f.root });
  f.write(first.path, first.content);
  f.commit();
  const result = await openFixPullRequest(
    { root: f.root, repository: "owner/repo" },
    () => {
      throw Error("No network request expected");
    },
  );
  assert.equal(result.content, null);
  assert.match(result.message, /No supported/);
  // An owner may have replaced the generated file. New fixes must not overwrite it.
  f.write(
    first.path,
    "on: pull_request\njobs:\n  owner:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo owner checks\n",
  );
  f.commit();
  assert.throws(() => previewFix({ root: f.root }), /already exists/);
});

test("fix PR explanations escape display text and omit raw source commands", (t) => {
  const f = fixture(t);
  const preview = previewFix({ root: f.root });
  preview.addedCheckIds.push("<script>@owners|[bad]");
  preview.command = "SECRET_COMMAND_NOT_FOR_A_PR";
  const body = fixPullRequestBody(preview, {
    repository: "owner/repo",
    branch: "ci-planner/fix-" + f.sha.slice(0, 12),
    base: "main",
  });
  assert(!body.includes("<script>"));
  assert(!body.includes("@owners"));
  assert(!body.includes("SECRET_COMMAND"));
});

test("gh transport uses fixed-host argument arrays and JSON stdin, and redacts API error payloads", (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    "#!" +
      process.execPath +
      "\n" +
      [
        "const fs = require('node:fs');",
        "if (process.argv.includes('missing')) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }",
        "if (process.argv.includes('forbidden')) { process.stderr.write('RAW_SECRET_RESPONSE (HTTP 403)'); process.exit(1); }",
        "process.stdout.write(JSON.stringify({args: process.argv.slice(2), body: JSON.parse(fs.readFileSync(0, 'utf8') || '{}')}));",
      ].join("\n"),
    { mode: 0o755 },
  );
  const original = process.env.PATH;
  process.env.PATH = bin + path.delimiter + original;
  t.after(() => {
    process.env.PATH = original;
  });
  const body = { message: "$(touch NOT_EXECUTED)" };
  const result = githubRequest("POST", "repos/owner/repo/git/trees", body);
  assert.deepEqual(result.body, body);
  assert.deepEqual(result.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/owner/repo/git/trees",
    "--input",
    "-",
  ]);
  assert.equal(
    githubRequest("GET", "missing", undefined, { allowNotFound: true }),
    null,
  );
  assert.throws(
    () => githubRequest("GET", "forbidden"),
    (error) => {
      assert(!error.message.includes("RAW_SECRET"));
      return true;
    },
  );
});
