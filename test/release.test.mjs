import assert from "node:assert/strict";
import test from "node:test";
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
