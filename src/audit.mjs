/**
 * Read-only Actions metadata audit and offline replay.
 * Job durations describe the observed latest attempts, not billing or proven waste.
 * @module audit
 */
import fs from "node:fs";
import { readJSONFile } from "./evidence.mjs";
import { validRepository } from "./validation.mjs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_RUNS = 20;
const MAX_JOB_PAGES = 5;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key]]));
const runKeys = [
  "id",
  "run_attempt",
  "workflow_id",
  "path",
  "name",
  "event",
  "head_sha",
  "status",
  "conclusion",
];
const jobKeys = [
  "id",
  "run_id",
  "run_attempt",
  "name",
  "status",
  "conclusion",
  "started_at",
  "completed_at",
  "labels",
];
const stepKeys = [
  "number",
  "name",
  "status",
  "conclusion",
  "started_at",
  "completed_at",
];
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

// Only GET metadata endpoints. Never fetch logs, artifacts, code or secret values.
/**
 * Read a GitHub metadata endpoint through an installed authenticated gh CLI.
 * Collection constructs only run/job GET endpoints. No token is read or printed here.
 * @param {string} endpoint GitHub REST endpoint path.
 * @returns {object} Decoded response.
 */
export function githubRead(endpoint) {
  let response;
  try {
    response = execFileSync(
      "gh",
      ["api", "--hostname", "github.com", "--method", "GET", endpoint],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw Error(
      "GitHub metadata read failed; check gh authentication and Actions read access",
    );
  }
  return JSON.parse(response);
}

/**
 * Collect a bounded latest-attempt sample, stripping logs/steps and unrelated fields.
 * Pagination shortfalls remain visible through total_count rather than counting as zero.
 * @param {{repository:string,branch?:string,workflow?:string,limit?:number}} options
 * @param {(endpoint:string)=>object|Promise<object>} [read] Injectable read transport.
 * @returns {Promise<object>} Replayable schema-versioned metadata snapshot.
 */
export async function collectSnapshot(
  { repository, branch, workflow, limit = MAX_RUNS },
  read = githubRead,
) {
  if (!validRepository(repository))
    throw Error("Expected repository OWNER/REPO");
  if (!positiveInteger(limit) || limit > MAX_RUNS)
    throw Error("Limit must be 1 through 20");
  if (workflow && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/.test(workflow))
    throw Error("Expected workflow filename");
  const scope = "repos/" + repository + "/actions/";
  const query = new URLSearchParams({ per_page: String(limit) });
  if (branch) query.set("branch", branch);
  const listed = await read(
    scope + (workflow ? "workflows/" + workflow + "/" : "") + "runs?" + query,
  );
  if (
    !Array.isArray(listed.workflow_runs) ||
    listed.workflow_runs.length > limit
  )
    throw Error("Invalid run list");
  const runs = [];
  let collectedBytes = 0;
  for (const run of listed.workflow_runs) {
    if (!positiveInteger(run.id) || !positiveInteger(run.run_attempt))
      throw Error("Invalid run identity");
    const items = [];
    let total;
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      const data = await read(
        scope +
          "runs/" +
          run.id +
          "/attempts/" +
          run.run_attempt +
          "/jobs?per_page=100&page=" +
          page,
      );
      if (
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.jobs) ||
        data.jobs.length > 100
      ) {
        throw Error("Invalid jobs page");
      }
      if (total !== undefined && total !== data.total_count)
        throw Error("Jobs changed during collection; retry after completion");
      total = data.total_count;
      items.push(
        ...data.jobs.map((job) => {
          if (
            job.steps !== undefined &&
            (!Array.isArray(job.steps) || job.steps.length > 1000)
          )
            throw Error("Invalid step inventory");
          return {
            ...pick(job, jobKeys),
            ...(job.steps
              ? { steps: job.steps.map((step) => pick(step, stepKeys)) }
              : {}),
          };
        }),
      );
      collectedBytes += Buffer.byteLength(JSON.stringify(data.jobs));
      if (collectedBytes > MAX_INPUT_BYTES)
        throw Error("Collected metadata exceeds 32 MiB");
      if (items.length >= total || data.jobs.length < 100) break;
    }
    runs.push({ ...pick(run, runKeys), jobs: { total_count: total, items } });
  }
  return {
    schemaVersion: 1,
    repository,
    selection: { branch: branch ?? null, workflow: workflow ?? null, limit },
    runs,
  };
}

function interval(job) {
  if (job.conclusion === "skipped") return null;
  if (job.status !== "completed") return undefined;
  const start =
    typeof job.started_at === "string" ? Date.parse(job.started_at) : NaN;
  const end =
    typeof job.completed_at === "string" ? Date.parse(job.completed_at) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? [start, end]
    : undefined;
}

// A review aid only. Timing/history never authorizes a skip or proves equivalent inputs.
/**
 * Validate identities and sum overlapping runner intervals independently.
 * A cancelled or failed run can have useful work; findings request investigation only.
 * @param {object} snapshot Untrusted metadata snapshot, bounded by the CLI before parsing.
 * @returns {object} Audit report; savings and billing values deliberately remain null.
 */
export function auditSnapshot(snapshot, { rates = null } = {}) {
  if (
    rates !== null &&
    (!rates ||
      !/^[A-Z]{3}$/.test(rates.currency ?? "") ||
      !rates.perMinute ||
      typeof rates.perMinute !== "object" ||
      Array.isArray(rates.perMinute) ||
      Object.keys(rates.perMinute).length > 100 ||
      Object.entries(rates.perMinute).some(
        ([label, value]) =>
          !label || label.length > 100 || !Number.isFinite(value) || value < 0,
      ))
  )
    throw Error(
      "Expected currency and bounded nonnegative perMinute runner rates",
    );
  let ratedWorkerSeconds = 0,
    unratedWorkerSeconds = 0,
    estimatedAmount = 0;
  if (
    snapshot?.schemaVersion !== 1 ||
    !validRepository(snapshot.repository) ||
    !Array.isArray(snapshot.runs) ||
    snapshot.runs.length > MAX_RUNS
  ) {
    throw Error("Invalid audit snapshot");
  }
  const seenRuns = new Set();
  const seenJobs = new Set();
  const runs = [];
  const findings = [];
  for (const run of snapshot.runs) {
    if (
      !positiveInteger(run.id) ||
      !positiveInteger(run.run_attempt) ||
      seenRuns.has(run.id)
    )
      throw Error("Invalid or duplicate run identity");
    seenRuns.add(run.id);
    const jobs = run.jobs?.items;
    const expected = run.jobs?.total_count;
    if (
      !Array.isArray(jobs) ||
      jobs.length > MAX_JOB_PAGES * 100 ||
      !Number.isSafeInteger(expected) ||
      expected < jobs.length
    )
      throw Error("Invalid job inventory");
    const intervals = [];
    let unknownTimingJobs = 0;
    let skippedJobs = 0;
    for (const job of jobs) {
      if (
        !positiveInteger(job.id) ||
        seenJobs.has(job.id) ||
        job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt
      )
        throw Error("Job does not belong to this unique run attempt");
      seenJobs.add(job.id);
      const span = interval(job);
      if (span === null) skippedJobs++;
      else if (span === undefined) unknownTimingJobs++;
      else {
        intervals.push({ job, span });
        const elapsed = (span[1] - span[0]) / 1000;
        const labels = job.labels;
        if (
          labels !== undefined &&
          (!Array.isArray(labels) ||
            labels.length > 100 ||
            labels.some(
              (label) => typeof label !== "string" || label.length > 100,
            ))
        )
          throw Error("Invalid runner labels");
        const prices = rates
          ? [
              ...new Set(
                (labels ?? [])
                  .filter((label) => Object.hasOwn(rates.perMinute, label))
                  .map((label) => rates.perMinute[label]),
              ),
            ]
          : [];
        if (prices.length === 1) {
          ratedWorkerSeconds += elapsed;
          estimatedAmount += (elapsed / 60) * prices[0];
        } else unratedWorkerSeconds += elapsed;
      }
    }
    const workerSeconds = intervals.reduce(
      (sum, { span }) => sum + (span[1] - span[0]) / 1000,
      0,
    );
    const failures = intervals.filter(({ job }) =>
      ["failure", "timed_out", "startup_failure"].includes(job.conclusion),
    );
    const firstFailure = failures.length
      ? Math.min(...failures.map(({ span }) => span[1]))
      : null;
    const workerSecondsAfterFirstFailure =
      firstFailure === null
        ? 0
        : intervals.reduce(
            (sum, { span }) =>
              sum +
              Math.max(0, span[1] - Math.max(firstFailure, span[0])) / 1000,
            0,
          );
    const complete =
      jobs.length === expected &&
      unknownTimingJobs === 0 &&
      run.status === "completed";
    runs.push({
      ...pick(run, runKeys),
      observedJobs: jobs.length,
      expectedJobs: expected,
      skippedJobs,
      unknownTimingJobs,
      complete,
      workerSeconds,
      workerSecondsAfterFirstFailure,
    });
    if (!complete)
      findings.push({
        type: "incomplete-observation",
        runIds: [run.id],
        message:
          "Missing jobs, unfinished run or unavailable timestamps: duration totals are partial.",
      });
    if (run.conclusion === "cancelled" && workerSeconds >= 60)
      findings.push({
        type: "cancelled-work-review",
        runIds: [run.id],
        workerSeconds,
        message:
          "Inspect cancellation timing and concurrency scope. Cancellation can be intentional; this is not an avoidable-cost estimate.",
      });
    if (workerSecondsAfterFirstFailure >= 60)
      findings.push({
        type: "early-failure-review",
        runIds: [run.id],
        workerSecondsAfterFirstFailure,
        message:
          "Review whether a cheap failing gate could precede other runners. Independent checks may still need to finish.",
      });
  }
  const repeated = new Map();
  for (const run of runs) {
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !["push", "pull_request"].includes(run.event) ||
      !positiveInteger(run.workflow_id) ||
      typeof run.path !== "string" ||
      !/^[0-9a-f]{40}$/.test(run.head_sha ?? "")
    )
      continue;
    const key = JSON.stringify([
      run.workflow_id,
      run.path,
      run.event,
      run.head_sha,
    ]);
    repeated.set(key, [...(repeated.get(key) ?? []), run.id]);
  }
  for (const ids of repeated.values()) {
    if (ids.length > 1)
      findings.push({
        type: "repeated-success-review",
        runIds: ids.sort((a, b) => a - b),
        message:
          "Same workflow, event and head succeeded repeatedly. Compare base/merge state, inputs and environment before considering reuse.",
      });
  }
  const byConclusion = new Map();
  for (const run of runs) {
    const conclusion = [
      "success",
      "failure",
      "cancelled",
      "timed_out",
      "skipped",
      "neutral",
      "action_required",
      "stale",
      "startup_failure",
    ].includes(run.conclusion)
      ? run.conclusion
      : "unknown";
    const total = byConclusion.get(conclusion) ?? {
      runs: 0,
      completeRuns: 0,
      workerSeconds: 0,
    };
    total.runs++;
    total.completeRuns += Number(run.complete);
    total.workerSeconds += run.workerSeconds;
    byConclusion.set(conclusion, total);
  }
  const totalWorkerSeconds = runs.reduce(
    (sum, run) => sum + run.workerSeconds,
    0,
  );
  const cancelledWorkerSeconds =
    byConclusion.get("cancelled")?.workerSeconds ?? 0;
  return {
    schemaVersion: 1,
    repository: snapshot.repository,
    mode: "read-only-audit",
    scope:
      "Latest observed attempt per run; bounded sample, not complete history or billing.",
    totals: {
      runs: runs.length,
      completeRuns: runs.filter((run) => run.complete).length,
      observedJobs: runs.reduce((sum, run) => sum + run.observedJobs, 0),
      workerSeconds: runs.reduce((sum, run) => sum + run.workerSeconds, 0),
      byConclusion: Object.fromEntries(
        [...byConclusion].sort(([a], [b]) => a.localeCompare(b)),
      ),
      cancelledWorkerSeconds,
      cancelledWorkerShare:
        totalWorkerSeconds > 0
          ? cancelledWorkerSeconds / totalWorkerSeconds
          : null,
      estimatedCost: {
        currency: rates?.currency ?? null,
        amount: rates && ratedWorkerSeconds > 0 ? estimatedAmount : null,
        ratedWorkerSeconds,
        unratedWorkerSeconds,
        partial: unratedWorkerSeconds > 0 || runs.some((r) => !r.complete),
      },
      billingMinutes: null,
      estimatedSavingsSeconds: null,
    },
    cancellation: {
      cause: "unknown",
      recommendation:
        cancelledWorkerSeconds > 0
          ? "Inspect concurrency cancel-in-progress and successive pushes. If superseding pushes are confirmed, evaluate a 30–60 second debounce or a cheap metadata gate before expensive jobs. Cancellation metadata alone does not establish cause or savings."
          : null,
    },
    runs: runs.sort((a, b) => a.id - b.id),
    findings,
    limitations: [
      "Job durations sum concurrent workers; they are not workflow elapsed time or billed minutes.",
      "Earlier attempts and runs outside the sample are excluded.",
      "Timing findings require investigation and do not change CI, required checks, runner placement or skip/reuse policy.",
    ],
  };
}

const HELP =
  "Read-only CI audit (Node.js, no model or service required)\n\n" +
  "  ci-planner audit --repository OWNER/REPO [--workflow ci.yml] [--branch main] [--limit 20] [--snapshot]\n" +
  "  ci-planner audit --input snapshot.json [--rates rates.json]\n\n" +
  "Live mode uses authenticated gh GET requests (at most 20 runs, 500 jobs per run).\n" +
  "--snapshot emits replayable metadata instead of the audit. Output is JSON on stdout.\n" +
  "Offline mode reads one snapshot (up to 32 MiB). No files or CI settings are changed.\n" +
  "Durations cover latest attempts only. Findings are review prompts, not proven savings.\n";

/** Parse audit arguments and return stdout text; writes no files or CI settings. */
export async function main(args) {
  if (args.length === 1 && args[0] === "--help") return HELP;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        "--repository",
        "--workflow",
        "--branch",
        "--limit",
        "--input",
        "--snapshot",
        "--rates",
      ].includes(key) ||
      Object.hasOwn(options, key)
    )
      throw Error("Unknown or repeated argument; use --help");
    if (key === "--snapshot") options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw Error("Missing argument value");
      options[key] = value;
    }
  }
  let snapshot;
  if (options["--input"]) {
    if (
      Object.keys(options).some((key) => !["--input", "--rates"].includes(key))
    )
      throw Error("--input cannot be combined with live options");
    const info = fs.statSync(options["--input"]);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES)
      throw Error("Expected snapshot file up to 32 MiB");
    const bytes = fs.readFileSync(options["--input"]);
    if (bytes.length > MAX_INPUT_BYTES) throw Error("Snapshot exceeds 32 MiB");
    snapshot = JSON.parse(bytes.toString("utf8"));
  } else {
    snapshot = await collectSnapshot({
      repository: options["--repository"],
      workflow: options["--workflow"],
      branch: options["--branch"],
      limit:
        options["--limit"] === undefined
          ? MAX_RUNS
          : Number(options["--limit"]),
    });
  }
  const report = auditSnapshot(snapshot, {
    rates: options["--rates"] ? readJSONFile(options["--rates"]) : null,
  });
  return (
    JSON.stringify(options["--snapshot"] ? snapshot : report, null, 2) + "\n"
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write("CI audit: " + error.message + "\n");
    process.exitCode = 1;
  }
}
