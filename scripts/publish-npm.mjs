/** Publish the verified release tarball through npm OIDC, never a stored npm token. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { verifyReleaseCI, validReleaseSource } from "./release.mjs";
import { pathToFileURL } from "node:url";
const registry = "https://registry.npmjs.org";
const execute = (program, args) =>
  execFileSync(program, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const get = (endpoint) =>
  JSON.parse(execute("gh", ["api", "--method", "GET", endpoint]));
export function verifyTarball(bytes, checksum, name) {
  if (!/^[A-Za-z0-9_.-]+\.tgz$/.test(name)) throw Error("Invalid tarball name");
  const expected =
    createHash("sha256").update(bytes).digest("hex") + "  " + name;
  if (checksum.trim() !== expected)
    throw Error("Release tarball checksum mismatch");
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}
/** Read a fresh version record; new packages can have cached 404s at the packument URL. */
export async function readPublishedPackage(name, version, fetcher = fetch) {
  if (name !== "@gamenalyze/ci-planner" || !/^\d+\.\d+\.\d+$/.test(version))
    throw Error("Unexpected npm metadata identity");
  const url = new URL(
    registry + "/" + name.replace("/", "%2f") + "/" + version,
  );
  url.searchParams.set("verification", randomUUID());
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body)
    throw Error("npm registry verification unavailable");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 4 * 1024 * 1024)
      throw Error("npm registry metadata exceeds bounds");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("Invalid npm registry metadata");
  }
}
export async function publishNpm() {
  const repository = "Gamenalyze/ci-planner";
  if (
    process.env.GITHUB_REPOSITORY !== repository ||
    !["workflow_run", "workflow_dispatch"].includes(
      process.env.GITHUB_EVENT_NAME,
    )
  )
    throw Error("npm publication requires the canonical main release workflow");
  const sha = execute("git", ["rev-parse", "HEAD"]);
  if (sha !== process.env.RELEASE_COMMIT || sha !== process.env.GITHUB_SHA)
    throw Error("npm source differs from canonical current release commit");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (
    pkg.name !== "@gamenalyze/ci-planner" ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version)
  )
    throw Error("Unexpected npm package");
  const event = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const runId =
    process.env.GITHUB_EVENT_NAME === "workflow_run"
      ? event.workflow_run?.id
      : Number(process.env.RELEASE_CI_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw Error("Successful main CI identity required");
  const run = get(`repos/${repository}/actions/runs/${runId}`);
  const jobs = get(
    `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  verifyReleaseCI(run, jobs, repository, sha);
  const validSource = () =>
    validReleaseSource(
      {
        sha,
        mainSha: get(`repos/${repository}/branches/main`).commit?.sha,
        event: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        version: pkg.version,
      },
      (a, b) => {
        try {
          execute("git", ["merge-base", "--is-ancestor", a, b]);
          return true;
        } catch {
          return false;
        }
      },
    );
  if (!validSource())
    throw Error(
      "Invalid source; retry an older release from its verified version tag",
    );
  const tag = "v" + pkg.version;
  const release = get(`repos/${repository}/releases/tags/${tag}`);
  if (release.draft || release.prerelease)
    throw Error("Stable GitHub release required before npm");
  let object = get(`repos/${repository}/git/ref/tags/${tag}`).object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++)
    object = get(`repos/${repository}/git/tags/${object.sha}`).object;
  if (object?.type !== "commit") throw Error("Release commit unavailable");
  // Ordinary commits without a version bump do not republish.
  if (object.sha !== sha) {
    try {
      execute("git", ["merge-base", "--is-ancestor", object.sha, sha]);
    } catch {
      throw Error("Version release is outside main history");
    }
    console.log(
      `${pkg.name}@${pkg.version} already has its release commit; no new version requested.`,
    );
    return;
  }
  const name = "gamenalyze-ci-planner-" + pkg.version + ".tgz";
  const directory = fs.mkdtempSync(
    path.join(process.env.RUNNER_TEMP, "npm-publication-"),
  );
  execute("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--pattern",
    name,
    "--pattern",
    name + ".sha256",
    "--dir",
    directory,
  ]);
  const tarball = path.join(directory, name);
  const integrity = verifyTarball(
    fs.readFileSync(tarball),
    fs.readFileSync(tarball + ".sha256", "utf8"),
    name,
  );
  const metadata = () => readPublishedPackage(pkg.name, pkg.version);
  let published = await metadata();
  if (!published) {
    if (!validSource()) throw Error("Main advanced before npm publishing");
    // In hosted CI npm obtains an OIDC token from the configured trusted publisher.
    execute("npm", [
      "publish",
      tarball,
      "--ignore-scripts",
      "--access",
      "public",
      "--provenance",
      "--registry=" + registry,
    ]);
    for (let attempt = 0; attempt < 6; attempt++) {
      published = await metadata();
      if (published) break;
      if (attempt < 5)
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (
    published?.name !== pkg.name ||
    published.version !== pkg.version ||
    published.dist?.integrity !== integrity
  )
    throw Error("Published npm bytes do not match the verified GitHub release");
  const summary = `\nNpm package verified: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  publishNpm().catch((error) => {
    console.error("npm publishing: " + error.message);
    process.exitCode = 1;
  });
