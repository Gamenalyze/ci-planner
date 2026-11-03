import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { releaseSpec, marketplaceVersion } from "../scripts/release.mjs";
const input = {
  pkg: { name: "@gamenalyze/ci-planner", version: "0.4.0" },
  engineVersion: "0.4.0",
  sha: "a".repeat(40),
  repository: "Gamenalyze/ci-planner",
  changelog: "## 0.4.0 — 2026-11-03\n\nChanges\n\n## 0.3.1 — 2026-11-03\nold",
};
test("release spec binds stable version, canonical commit and dated notes", () => {
  assert.equal(releaseSpec(input).notes, "Changes");
  for (const extra of [
    { sha: "main" },
    { branch: "other" },
    { repository: "fork/ci-planner" },
    { engineVersion: "0.3.1" },
    { pkg: { ...input.pkg, version: "0.4.0-rc.1" } },
    { changelog: "## 0.4.0 — unpublished\nChanges" },
  ])
    assert.throws(() => releaseSpec({ ...input, ...extra }));
});
test("Marketplace verification reads release metadata, never README version strings", () => {
  const html =
    '<p>use v0.4.0</p><script type="application/json">' +
    JSON.stringify({
      payload: { releaseData: { latestRelease: { tagName: "v0.3.0" } } },
    }) +
    "</script>";
  assert.equal(marketplaceVersion(html), "v0.3.0");
  assert.equal(marketplaceVersion("<p>v0.4.0</p>"), null);
});

test("Marketplace parser accepts captured GitHub release data", () => {
  const html = fs.readFileSync(
    new URL("./fixtures/marketplace-release-data.html", import.meta.url),
    "utf8",
  );
  assert.equal(marketplaceVersion(html), "v0.3.0");
});

import { verifyTarball } from "../scripts/publish-npm.mjs";
import { createHash } from "node:crypto";
test("npm publishing binds both checksum and registry integrity to release bytes", () => {
  const bytes = Buffer.from("release tarball"),
    name = "gamenalyze-ci-planner-0.4.0.tgz";
  const checksum =
    createHash("sha256").update(bytes).digest("hex") + "  " + name + "\n";
  assert.match(verifyTarball(bytes, checksum, name), /^sha512-/);
  assert.throws(
    () => verifyTarball(Buffer.from("tampered"), checksum, name),
    /mismatch/,
  );
  assert.throws(
    () => verifyTarball(bytes, checksum, "../tarball.tgz"),
    /Invalid/,
  );
});

import { verifyReleaseCI, validReleaseSource } from "../scripts/release.mjs";
test("both publication channels independently require canonical successful CI and both non-skipped Node lanes", () => {
  const repo = "Gamenalyze/ci-planner",
    sha = "a".repeat(40),
    run = {
      repository: { full_name: repo },
      head_repository: { full_name: repo },
      event: "push",
      path: ".github/workflows/ci.yml",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
    };
  const jobs = {
    total_count: 2,
    jobs: ["validate (22)", "validate (24)"].map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  verifyReleaseCI(run, jobs, repo, sha);
  for (const change of [
    { event: "pull_request" },
    { head_branch: "feature" },
    { conclusion: "failure" },
    { head_sha: "b".repeat(40) },
    { head_repository: { full_name: "fork/repo" } },
  ])
    assert.throws(() =>
      verifyReleaseCI({ ...run, ...change }, jobs, repo, sha),
    );
  assert.throws(() =>
    verifyReleaseCI(
      run,
      {
        ...jobs,
        jobs: jobs.jobs.map((job) => ({ ...job, conclusion: "skipped" })),
      },
      repo,
      sha,
    ),
  );
});
test("stale release recovery permits only an explicitly dispatched matching version tag from main history", () => {
  const source = {
    sha: "a".repeat(40),
    mainSha: "b".repeat(40),
    event: "workflow_dispatch",
    ref: "refs/tags/v0.4.0",
    version: "0.4.0",
  };
  assert.equal(
    validReleaseSource(source, () => true),
    true,
  );
  for (const change of [
    { event: "workflow_run" },
    { ref: "refs/heads/feature" },
    { ref: "refs/tags/v0.3.0" },
  ])
    assert.equal(
      validReleaseSource({ ...source, ...change }, () => true),
      false,
    );
  assert.equal(
    validReleaseSource(source, () => false),
    false,
  );
  assert.equal(
    validReleaseSource(
      { ...source, mainSha: source.sha, ref: "refs/heads/main" },
      () => false,
    ),
    true,
  );
});

test("a matching version tag can also be retried while it is still main", () => {
  const sha = "a".repeat(40);
  assert.equal(
    validReleaseSource(
      {
        sha,
        mainSha: sha,
        event: "workflow_dispatch",
        ref: "refs/tags/v0.4.0",
        version: "0.4.0",
      },
      () => false,
    ),
    true,
  );
});
