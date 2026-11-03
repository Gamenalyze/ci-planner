/** Compare shadow suggestions with full-run observations. Reports never grant skip authority. */
import { createHash } from "node:crypto";
import { auditSnapshot } from "./audit.mjs";
import { WORKFLOW } from "./validation.mjs";
import { HASH, SHA } from "./evidence.mjs";

/**
 * The trusted collector supplies testedSha and fullRun: metadata alone cannot prove checkout or gates.
 * jobNames explicitly maps each stable workflow#id to all expected matrix display names.
 * Missing, repeated, skipped or unfinished observations inhibit enforcement.
 */
export function validateSkipDecisions({
  plan,
  snapshot,
  workflow,
  runId,
  testedSha,
  fullRun,
  jobNames,
}) {
  auditSnapshot(snapshot); // Reject duplicate identities, mixed attempts and partial inventories.
  if (
    plan?.schemaVersion !== 1 ||
    plan.mode !== "shadow" ||
    !HASH.test(plan.planHash ?? "") ||
    !HASH.test(plan.policyHash ?? "") ||
    !plan.jobs ||
    !plan.identity ||
    !SHA.test(plan.identity.mergeSha ?? "") ||
    snapshot.repository !== plan.identity.repository ||
    !WORKFLOW.test(workflow ?? "") ||
    !jobNames ||
    typeof jobNames !== "object" ||
    Array.isArray(jobNames)
  )
    throw Error(
      "Expected a bound shadow plan, exact merge and explicit job-name mapping",
    );
  const planned = Object.entries(plan.jobs).filter(
    ([, j]) => j.workflow === workflow,
  );
  if (
    !planned.length ||
    planned.length > 1000 ||
    planned.some(
      ([, j]) => j.run !== true || !["skip", "run"].includes(j.candidate),
    )
  )
    throw Error("Expected full shadow execution for this workflow");
  const run = snapshot.runs.find((r) => r.id === runId);
  const issues = [];
  const fail = (reason, job = null) => issues.push({ reason, job });
  if (fullRun !== true || testedSha !== plan.identity.mergeSha)
    fail("full-run-or-tested-merge-unverified");
  if (
    !run ||
    run.path !== workflow ||
    run.event !== "pull_request" ||
    ![plan.identity.headSha, plan.identity.mergeSha].includes(run.head_sha) ||
    run.status !== "completed" ||
    run.jobs.items.length !== run.jobs.total_count
  )
    fail("incomplete-or-mismatched-run");
  const names = new Set();
  const decisions = [];
  for (const [key, job] of planned) {
    const expected = Object.hasOwn(jobNames, key) ? jobNames[key] : null;
    if (
      !Array.isArray(expected) ||
      !expected.length ||
      expected.length > 500 ||
      expected.some((n) => typeof n !== "string" || !n || n.length > 500)
    ) {
      fail("missing-job-name-mapping", key);
      continue;
    }
    for (const name of expected) {
      if (names.has(name)) {
        fail("ambiguous-job-name", key);
        continue;
      }
      names.add(name);
      const matches = run?.jobs.items.filter((j) => j.name === name) ?? [];
      const success =
        matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success";
      if (!success)
        fail(
          job.candidate === "skip" &&
            matches.some((j) =>
              ["failure", "timed_out", "startup_failure"].includes(
                j.conclusion,
              ),
            )
            ? "failed-suggested-skip"
            : "unsuccessful-or-missing-job",
          key,
        );
      decisions.push({
        job: key,
        name,
        candidate: job.candidate,
        conclusion: matches.length === 1 ? matches[0].conclusion : "unknown",
      });
    }
  }
  if (run?.jobs.items.some((j) => !names.has(j.name)))
    fail("unmapped-observed-job");
  if (run?.conclusion !== "success") fail("full-run-not-successful");
  const result = {
    schemaVersion: 1,
    mode: "skip-validation",
    repository: plan.identity.repository,
    policyHash: plan.policyHash,
    planHash: plan.planHash,
    workflow,
    runId,
    testedSha: testedSha ?? null,
    safe: issues.length === 0,
    fallback: issues.length !== 0,
    decisions,
    issues,
    limitations: [
      "One observation is not proof of complete input contracts.",
      "The collector must attest an ungated full run and the actual tested merge. Untrusted PR artifacts are not that attestation.",
      "Passing feedback never enables enforcement; failing or missing feedback can only require more validation.",
    ],
  };
  return {
    ...result,
    validationHash: createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex"),
  };
}

/** Optional feedback can only inhibit the existing base-policy/merge gates, never relax them. */
export function validationAllowsPlanning(
  report,
  policyHash,
  workflow,
  planHash,
  repository,
) {
  if (
    !report ||
    report.mode !== "skip-validation" ||
    report.schemaVersion !== 1 ||
    report.policyHash !== policyHash ||
    report.workflow !== workflow ||
    !HASH.test(planHash ?? "") ||
    report.planHash !== planHash ||
    typeof repository !== "string" ||
    report.repository !== repository ||
    report.safe !== true ||
    report.fallback !== false ||
    !Array.isArray(report.issues) ||
    report.issues.length
  )
    return false;
  const { validationHash, ...body } = report;
  return (
    HASH.test(validationHash ?? "") &&
    validationHash ===
      createHash("sha256").update(JSON.stringify(body)).digest("hex")
  );
}
