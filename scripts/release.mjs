/** Release only the exact successful default-branch CI commit; immutable version tags. */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const shaPattern = /^[0-9a-f]{40}$/;
export function releaseSpec({
  pkg,
  engineVersion,
  changelog,
  sha,
  branch = "main",
  repository,
}) {
  if (
    repository !== "Gamenalyze/ci-planner" ||
    branch !== "main" ||
    !shaPattern.test(sha ?? "")
  )
    throw Error("Release must target the canonical main commit");
  if (
    pkg.name !== "@gamenalyze/ci-planner" ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version ?? "") ||
    pkg.version !== engineVersion
  )
    throw Error("Package and engine versions must agree");
  const tag = "v" + pkg.version;
  const section = changelog
    .split(/^## /m)
    .slice(1)
    .find((section) => section.startsWith(pkg.version + " — "));
  if (!section || /unpublished|unreleased/i.test(section.split("\n")[0]))
    throw Error("A dated changelog section is required");
  return {
    tag,
    sha,
    title: "CI Planner " + tag,
    notes: section.slice(section.indexOf("\n") + 1).trim(),
  };
}
export function marketplaceVersion(html) {
  // Read GitHub's public embedded release metadata, never match README examples.
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  for (const [, script] of scripts) {
    try {
      const data = JSON.parse(script);
      const search = (value) => {
        if (!value || typeof value !== "object") return null;
        if (value.releaseData?.latestRelease?.tagName)
          return value.releaseData.latestRelease.tagName;
        for (const child of Object.values(value)) {
          const found = search(child);
          if (found) return found;
        }
        return null;
      };
      const tag = search(data);
      if (tag) return tag;
    } catch {
      /* Ignore unrelated structured data. */
    }
  }
  return null;
}
const gh = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const get = (endpoint) => JSON.parse(gh(["api", "--method", "GET", endpoint]));
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export async function release() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository !== "Gamenalyze/ci-planner")
    throw Error("Unexpected release repository");
  const event = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const runId =
    process.env.GITHUB_EVENT_NAME === "workflow_run"
      ? event.workflow_run?.id
      : Number(process.env.RELEASE_CI_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw Error("A successful main CI run is required");
  const run = get(`repos/${repository}/actions/runs/${runId}`);
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.event !== "push" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !shaPattern.test(run.head_sha)
  )
    throw Error("Release requires successful canonical main push CI");
  const sha = git("rev-parse", "HEAD");
  if (sha !== run.head_sha)
    throw Error("Checkout differs from validated CI commit");
  const main = () => get(`repos/${repository}/branches/main`).commit?.sha;
  if (main() !== sha)
    throw Error("Stale CI run: main has advanced; wait for its CI");
  // An Actions run may contain a skipped validation lane; require both expected Node jobs.
  const jobs = get(
    `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  if (
    jobs.total_count !== jobs.jobs?.length ||
    !["validate (22)", "validate (24)"].every(
      (name) =>
        jobs.jobs.filter(
          (job) =>
            job.name === name &&
            job.status === "completed" &&
            job.conclusion === "success",
        ).length === 1,
    )
  )
    throw Error("Both Node validation lanes must succeed");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const { VERSION } = await import("../src/planner.mjs");
  const spec = releaseSpec({
    pkg,
    engineVersion: VERSION,
    changelog: fs.readFileSync("CHANGELOG.md", "utf8"),
    sha,
    repository,
  });
  const pack = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        process.env.RUNNER_TEMP,
      ],
      { encoding: "utf8" },
    ),
  )[0];
  const artifact = process.env.RUNNER_TEMP + "/" + pack.filename;
  const checksum = artifact + ".sha256";
  fs.writeFileSync(
    checksum,
    createHash("sha256").update(fs.readFileSync(artifact)).digest("hex") +
      "  " +
      pack.filename +
      "\n",
  );
  // Refuse an existing version pointing elsewhere; never force-move version tags.
  const refs = git(
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${spec.tag}`,
    `refs/tags/${spec.tag}^{}`,
  );
  let taggedSha = null;
  if (refs) {
    const target =
      refs.split("\n").find((line) => line.endsWith("^{}")) ??
      refs.split("\n")[0];
    taggedSha = target.split(/\s/)[0];
  }
  const existing = JSON.parse(
    gh(["api", "--method", "GET", `repos/${repository}/releases?per_page=100`]),
  );
  const current = existing.find((r) => r.tag_name === spec.tag);
  if (taggedSha && taggedSha !== sha) {
    // Ordinary commits without a version bump do not republish or move tags.
    if (!current || current.draft || current.prerelease)
      throw Error("Existing version tag lacks a stable release");
    try {
      git("merge-base", "--is-ancestor", taggedSha, sha);
    } catch {
      throw Error("Existing version is not from main history");
    }
    process.stdout.write(
      `${spec.tag} is already published; no new version requested.\n`,
    );
    return;
  }
  if (main() !== sha) throw Error("Main changed before publishing");
  if (!current) {
    const notes = process.env.RUNNER_TEMP + "/ci-planner-release-notes.md";
    fs.writeFileSync(notes, spec.notes);
    gh([
      "release",
      "create",
      spec.tag,
      artifact,
      checksum,
      "--repo",
      repository,
      "--target",
      sha,
      "--title",
      spec.title,
      "--notes-file",
      notes,
      "--latest",
    ]);
  } else {
    if (current.draft || current.prerelease)
      throw Error("Existing release is not a stable publication");
    // Retries cannot replace bytes attached to a previously published version.
    if (
      ![pack.filename, pack.filename + ".sha256"].every((name) =>
        current.assets?.some(
          (asset) => asset.name === name && asset.state === "uploaded",
        ),
      )
    )
      throw Error(
        "Existing release lacks expected assets; investigate without overwriting",
      );
  }
  const published = get(`repos/${repository}/releases/tags/${spec.tag}`);
  if (published.draft || published.prerelease)
    throw Error("Release publication could not be verified");
  let releasedObject = get(
    `repos/${repository}/git/ref/tags/${spec.tag}`,
  ).object;
  for (let depth = 0; releasedObject?.type === "tag" && depth < 5; depth++)
    releasedObject = get(
      `repos/${repository}/git/tags/${releasedObject.sha}`,
    ).object;
  if (releasedObject?.type !== "commit" || releasedObject.sha !== sha)
    throw Error("Published version tag does not match validated source");
  // Marketplace has no documented REST publish flag. Verify its public index;
  // a green GitHub release alone must never be reported as Marketplace success.
  let marketplace = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(
      "https://github.com/marketplace/actions/ci-planner",
    );
    if (response.ok) marketplace = marketplaceVersion(await response.text());
    if (marketplace === spec.tag) break;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  const summary = `## CI Planner publication\n\nRelease: ${published.html_url}\n\nCommit: ${sha}\n\nMarketplace latest: ${marketplace ?? "unverified"}; expected ${spec.tag}.\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (marketplace !== spec.tag)
    throw Error(
      `Release exists, but Marketplace latest is ${marketplace ?? "unknown"}. Edit ${published.html_url.replace("/tag/", "/edit/")} and publish to Marketplace if GitHub requires UI confirmation; rerun this workflow to verify.`,
    );
  process.stdout.write(summary);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  release().catch((error) => {
    console.error("Release: " + error.message);
    process.exitCode = 1;
  });
