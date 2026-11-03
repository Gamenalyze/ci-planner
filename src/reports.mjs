/**
 * Bounded Markdown views of planner/audit results. Presentation never grants skip
 * authority, publishes comments, or converts worker time into billing or savings.
 * Unknown fields and raw workflow commands are deliberately omitted.
 * @module reports
 */
import { auditSnapshot } from "./audit.mjs";

const LIMIT = 50;
const reasons = {
  "changed-job-input": "A declared input changed.",
  "owner-declared-inputs-unchanged": "Owner-declared inputs are unchanged.",
  "new-or-unscoped-job": "New job or no owner input contract.",
  "incomplete-input-contract": "The owner has not confirmed complete inputs.",
  "hidden-dynamic-or-mutable-input":
    "External, dynamic or mutable inputs need a fresh run.",
  "upstream-job-selected": "An upstream data producer must run.",
  "selected-job-needs-output": "A selected consumer needs this job's output.",
};
const actions = {
  tests: "Wire an existing meaningful test suite.",
  lint: "Wire the configured linter in check mode.",
  typecheck: "Run checked type compilation.",
  format: "Run the configured formatter in check mode.",
  build: "Review the existing build command and runner placement.",
  "dependency-audit": "Add a dependency vulnerability check.",
  "secret-scan": "Add or verify repository secret scanning.",
  "workflow-lint": "Run workflow lint.",
  "container-build": "Review the container context, platform and runner.",
  "pull-request-ci": "Add unprivileged, blocking PR validation.",
};

/**
 * Escape one bounded Markdown table cell, including HTML, links and mentions.
 * @param {unknown} value Display data, never executable markup.
 * @returns {string} Single-line text with at most 240 input characters.
 */
export function markdownCell(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "|": "&#124;",
    "\u0060": "&#96;",
    "@": "&#64;",
    "[": "&#91;",
    "]": "&#93;",
    "*": "&#42;",
    _: "&#95;",
    "\\": "&#92;",
  };
  return String(value ?? "")
    .slice(0, 240)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[&<>|\x60@\[\]*_\\]/g, (c) => entities[c]);
}

function table(columns, rows) {
  return [
    "| " + columns.join(" | ") + " |",
    "| " + columns.map(() => "---").join(" | ") + " |",
    ...rows
      .slice(0, LIMIT)
      .map((row) => "| " + row.map(markdownCell).join(" | ") + " |"),
    ...(rows.length > LIMIT
      ? [
          "",
          String(rows.length - LIMIT) +
            " more rows omitted; see the JSON report.",
        ]
      : []),
  ].join("\n");
}
const list = (value, maximum = 20000) => {
  if (!Array.isArray(value) || value.length > maximum)
    throw Error("Invalid report collection");
  return value;
};

/** Render completeness evidence without claiming successful execution or test quality. */
function repositoryView(report) {
  const checks = list(report.checks);
  const counts = ["covered", "conditional", "unverified", "missing"]
    .map(
      (status) =>
        status + ": " + checks.filter((c) => c.status === status).length,
    )
    .join(" · ");
  return [
    "## Repository checks",
    "",
    "Commit: " + markdownCell(report.ref),
    "",
    counts,
    "",
    table(
      ["Check", "Scope", "Evidence", "Next action"],
      checks.map((check) => [
        check.check,
        check.package ?? "repository",
        check.status,
        check.status === "covered"
          ? "Recognized CI invocation."
          : Object.hasOwn(actions, check.check)
            ? actions[check.check]
            : "Review this check.",
      ]),
    ),
    "",
    "Covered means a recognized blocking invocation, not a passed check or complete test coverage.",
    "Conditional and unverified checks require review. Missing invocations may have external equivalents.",
  ].join("\n");
}

function planView(report) {
  if (
    !report.jobs ||
    Array.isArray(report.jobs) ||
    typeof report.jobs !== "object"
  )
    throw Error("Invalid plan report");
  const jobs = Object.entries(report.jobs);
  if (
    jobs.length > 1000 ||
    !["shadow", "enforce"].includes(report.mode) ||
    jobs.some(
      ([, job]) =>
        !job ||
        typeof job.run !== "boolean" ||
        !["run", "skip"].includes(job.candidate),
    )
  )
    throw Error("Invalid plan decisions");
  const run = jobs.filter(([, job]) => job.run).length;
  const suggested = jobs.filter(([, job]) => job.candidate === "skip").length;
  return [
    "## CI Planner",
    "",
    report.mode === "shadow"
      ? "**Shadow mode: every job runs. Skip suggestions are not applied.**"
      : "**Enforce mode: owner-approved input contracts control job selection.**",
    "",
    "Run: " +
      run +
      " · Skip: " +
      (jobs.length - run) +
      " · Suggested skips: " +
      suggested,
    "",
    table(
      ["Job", "Decision", "Suggestion", "Reason"],
      jobs.map(([key, job]) => [
        key,
        job.run ? "Run" : "Skip",
        job.candidate,
        Object.hasOwn(reasons, job.reason)
          ? reasons[job.reason]
          : String(job.reason ?? "Fresh validation required.").replaceAll(
              "-",
              " ",
            ),
      ]),
    ),
    "",
    "Plan: " + markdownCell(report.planHash),
    "Decisions use the trusted base policy. Timing history does not authorize skips.",
    ...(report.fallback
      ? ["", "**Enforcement unavailable: all jobs run.**"]
      : []),
    ...(report.warnings?.length
      ? [
          "",
          "Policy warnings: " +
            report.warnings.length +
            ". Review the JSON report.",
        ]
      : []),
    ...(report.repositoryAudit
      ? ["", repositoryView(report.repositoryAudit)]
      : []),
    ...(report.auditWarning
      ? [
          "",
          "Repository audit unavailable. Plan decisions are unchanged; check the audit separately.",
        ]
      : []),
  ].join("\n");
}

function timingView(report) {
  const runs = list(report.runs, 20);
  if (
    !report.totals ||
    !Number.isFinite(report.totals.workerSeconds) ||
    report.totals.workerSeconds < 0 ||
    !Number.isSafeInteger(report.totals.completeRuns) ||
    report.totals.completeRuns < 0 ||
    report.totals.completeRuns > runs.length
  )
    throw Error("Invalid timing report");
  return [
    "## CI runtime audit",
    "",
    "Repository: " + markdownCell(report.repository),
    "",
    "Observed worker-minutes: " + (report.totals.workerSeconds / 60).toFixed(1),
    "Complete runs: " + report.totals.completeRuns + " / " + runs.length,
    ...(Number.isFinite(report.totals.cancelledWorkerSeconds)
      ? [
          "Cancelled runs consumed **" +
            (report.totals.cancelledWorkerSeconds / 60).toFixed(1) +
            " worker-minutes (" +
            (report.totals.cancelledWorkerShare === null
              ? "unknown share"
              : (report.totals.cancelledWorkerShare * 100).toFixed(1) +
                "% of observed time") +
            ")**.",
          report.cancellation?.recommendation ?? "",
          table(
            ["Conclusion", "Runs", "Worker-minutes"],
            Object.entries(report.totals.byConclusion ?? {}).map(
              ([conclusion, total]) => [
                conclusion,
                total.runs,
                Number.isFinite(total.workerSeconds)
                  ? (total.workerSeconds / 60).toFixed(1)
                  : "Unknown",
              ],
            ),
          ),
          report.totals.estimatedCost?.amount !== null &&
          Number.isFinite(report.totals.estimatedCost?.amount)
            ? "Estimated cost at owner rates: " +
              markdownCell(report.totals.estimatedCost.currency) +
              " " +
              report.totals.estimatedCost.amount.toFixed(2) +
              (report.totals.estimatedCost.partial
                ? " (partial; unrated or missing time excluded)."
                : ".")
            : "Estimated cost: unknown; supply runner rates to estimate it.",
        ]
      : []),
    "",
    table(
      ["Run", "Result", "Worker-minutes", "Observation"],
      runs.map((run) => [
        run.id,
        run.conclusion ?? run.status,
        Number.isFinite(run.workerSeconds)
          ? (run.workerSeconds / 60).toFixed(1)
          : "Unknown",
        run.complete
          ? "Complete latest attempt"
          : "Partial; totals are incomplete",
      ]),
    ),
    "",
    "Review findings: " + list(report.findings).length,
    table(
      ["Finding", "Runs"],
      report.findings.map((finding) => [
        finding.type,
        Array.isArray(finding.runIds) ? finding.runIds.join(", ") : "",
      ]),
    ),
    "",
    "**Worker time is not wall-clock duration, billed minutes or proven savings.**",
    "Earlier attempts and runs outside the sample are excluded. Findings request investigation.",
  ].join("\n");
}

function setupView(report) {
  return [
    "## CI Planner setup",
    "",
    report.mode === "setup-written"
      ? "Created files for owner review."
      : "Preview only; no files changed.",
    "Source commit: " + markdownCell(report.ref),
    "",
    table(
      ["File", "Purpose"],
      list(report.files, 3).map((file) => [file.path, file.purpose]),
    ),
    "",
    "**Existing CI stays in place. The new report workflow is advisory and uses shadow mode.**",
    "New input contracts remain incomplete until the owner reviews each job's inputs.",
    "This setup does not add skip conditions to existing jobs.",
    ...(report.warnings?.length
      ? [
          "",
          ...list(report.warnings, 100)
            .slice(0, 10)
            .map((s) => "- " + markdownCell(s)),
        ]
      : []),
  ].join("\n");
}

function fixView(report) {
  const added = list(report.addedCheckIds ?? []);
  const omitted = list(report.notAdded ?? []);
  return [
    "## CI check proposal",
    "",
    report.mode === "fix-pr-created"
      ? "Draft PR created for owner review: " + markdownCell(report.url)
      : "Preview only; no remote changes or CI runs started.",
    "Source commit: " + markdownCell(report.ref),
    "",
    ...(added.length
      ? [
          "Proposed checks: " + added.length,
          "",
          table(
            ["Check"],
            added.map((id) => [id]),
          ),
        ]
      : ["No supported missing checks to publish."]),
    ...(omitted.length
      ? [
          "",
          "Omitted checks: " + omitted.length,
          "",
          table(
            ["Check", "Reason"],
            omitted.map((c) => [c.id, c.reason]),
          ),
        ]
      : []),
    "",
    "Static audit evidence is not a successful CI run. Review the new workflow before merging.",
    ...(added.length
      ? [
          "Rollback: remove only the generated workflow. Existing checks and their gates are preserved.",
        ]
      : []),
  ].join("\n");
}

function evidenceView(report) {
  if (report.mode === "skip-validation")
    return [
      "## Skip decision validation",
      "",
      report.safe === true
        ? "Observed full run passed; this does not enable enforcement."
        : "**Require full validation: failed, missing or uncertain evidence.**",
      "",
      table(
        ["Job", "Suggestion", "Observed result"],
        list(report.decisions).map((d) => [d.job, d.candidate, d.conclusion]),
      ),
      "",
      table(
        ["Issue", "Job"],
        list(report.issues).map((d) => [d.reason, d.job]),
      ),
    ].join("\n");
  if (report.mode === "dependency-discovery")
    return [
      "## Repository dependency discovery",
      "",
      "Commit: " + markdownCell(report.ref),
      "",
      "**Suggested scopes need owner review. Every input contract remains incomplete.**",
      "",
      table(
        ["Package", "Dependencies", "Affected"],
        list(report.packages, 500).map((p) => [
          p.directory,
          list(p.dependencies, 500).join(", "),
          p.affected ? "Yes" : "No",
        ]),
      ),
      "",
      "Uncertain inputs: " + list(report.warnings, 2000).length,
    ].join("\n");
  if (report.mode === "performance-advice")
    return [
      "## CI performance advice",
      "",
      "Complete observed runs: " +
        markdownCell(report.completeRuns) +
        " / " +
        markdownCell(report.observedRuns),
      "",
      table(
        [
          "Workflow / job",
          "Samples",
          "Median min",
          "p90 min",
          "Shard ratio",
          "Install min",
          "Est. worker-min/PR",
        ],
        list(report.jobSummaries ?? [], 1000).map((j) => [
          j.workflow + " / " + j.job,
          j.samples,
          Number.isFinite(j.medianSeconds)
            ? (j.medianSeconds / 60).toFixed(1)
            : "Unknown",
          Number.isFinite(j.p90Seconds)
            ? (j.p90Seconds / 60).toFixed(1)
            : "Unknown",
          Number.isFinite(j.medianShardImbalanceRatio)
            ? j.medianShardImbalanceRatio.toFixed(2)
            : "Unknown",
          Number.isFinite(j.repeatedInstallSeconds)
            ? (j.repeatedInstallSeconds / 60).toFixed(1)
            : "Unknown",
          Number.isFinite(j.estimatedWorkerSecondsPerPR)
            ? (j.estimatedWorkerSecondsPerPR / 60).toFixed(1)
            : "Unknown",
        ]),
      ),
      "",
      "Per-PR estimates use complete successful PR samples only; medians and p90 include all timed samples. Install time is observed setup, not avoidable waste.",
      "",
      table(
        ["Observation", "Jobs", "Review"],
        list(report.findings).map((f) => [
          f.type,
          list(f.jobs, 500).join(", "),
          f.advice,
        ]),
      ),
      "",
      "Cache hit rate: " +
        (report.cache?.hitRate === null
          ? "Unknown; trusted instrumentation is needed."
          : markdownCell(report.cache?.hitRate)),
      "",
      "Timing advice does not prove savings or change CI. Incomplete runs can skew the sample.",
    ].join("\n");
  if (report.mode === "verified-reuse")
    return [
      "## Verified validation reuse",
      "",
      report.reusable === true
        ? "Signed evidence and the complete tested tree match the current default branch."
        : "**Run fresh: required reuse evidence is missing, stale or different.**",
      "",
      "Decision: " + markdownCell(report.reason),
      "",
      "A trusted coordinator attests the actual tested checkout and environment. PR jobs must never hold its key.",
      "Artifacts are not restored and no check is marked successful by this command.",
    ].join("\n");
  return "## Validation receipt\n\nSigned full-run evidence created. Keep signing keys outside PR execution.\n";
}

/**
 * Render a plan, completeness audit, timing audit/snapshot, setup or fix result.
 * Output stays below 96 KiB, far below GitHub's per-step summary limit.
 * @param {object} report Structured result; unknown properties are not rendered.
 * @returns {string} GitHub-flavored Markdown with no raw commands or active HTML.
 */
export function renderMarkdown(report) {
  if (!report || typeof report !== "object" || report.schemaVersion !== 1)
    throw Error("Expected a supported CI Planner report");
  let content;
  if (report.jobs && report.identity) content = planView(report);
  else if (
    [
      "read-only-repository-audit",
      "repository-audit-with-reviewable-patch",
    ].includes(report.mode)
  )
    content = repositoryView(report);
  else if (report.mode === "read-only-audit") content = timingView(report);
  else if (["setup-preview", "setup-written"].includes(report.mode))
    content = setupView(report);
  else if (["fix-preview", "fix-pr-created"].includes(report.mode))
    content = fixView(report);
  else if (
    [
      "skip-validation",
      "dependency-discovery",
      "performance-advice",
      "verified-reuse",
      "validation-receipt",
    ].includes(report.mode)
  )
    content = evidenceView(report);
  else if (report.repository && Array.isArray(report.runs))
    content = timingView(auditSnapshot(report));
  else throw Error("Unsupported CI Planner report type");
  if (Buffer.byteLength(content) > 96 * 1024)
    content =
      Buffer.from(content)
        .subarray(0, 90 * 1024)
        .toString("utf8") +
      "\n\nReport truncated; see JSON for complete evidence.";
  return content + "\n";
}
