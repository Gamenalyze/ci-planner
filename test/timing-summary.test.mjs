import assert from "node:assert/strict";
import test from "node:test";
import { auditSnapshot } from "../src/audit.mjs";
import { advisePerformance } from "../src/performance.mjs";
import { renderMarkdown } from "../src/reports.mjs";
function snapshot() {
  const runs = [60, 120, 180, 240, 300].map((duration, index) => ({
    id: index + 1,
    run_attempt: 1,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: index === 4 ? "cancelled" : "success",
    jobs: {
      total_count: 1,
      items: [
        {
          id: index + 100,
          run_id: index + 1,
          run_attempt: 1,
          name: "test",
          status: "completed",
          conclusion: index === 4 ? "cancelled" : "success",
          started_at: new Date(0).toISOString(),
          completed_at: new Date(duration * 1000).toISOString(),
          labels: ["ubuntu-latest"],
          steps: [
            {
              number: 1,
              name: "npm ci",
              status: "completed",
              conclusion: "success",
              started_at: new Date(0).toISOString(),
              completed_at: new Date(60000).toISOString(),
            },
          ],
        },
      ],
    },
  }));
  return { schemaVersion: 1, repository: "owner/repo", runs };
}
test("cancelled worker time and conclusion totals use observed intervals without inferring a cause", () => {
  const report = auditSnapshot(snapshot());
  assert.equal(report.totals.workerSeconds, 900);
  assert.equal(report.totals.cancelledWorkerSeconds, 300);
  assert.equal(report.totals.cancelledWorkerShare, 1 / 3);
  assert.equal(report.totals.byConclusion.success.workerSeconds, 600);
  assert.equal(report.cancellation.cause, "unknown");
  assert.match(renderMarkdown(report), /5.0 worker-minutes \(33.3%/);
  const empty = auditSnapshot({
    schemaVersion: 1,
    repository: "owner/repo",
    runs: [],
  });
  assert.equal(empty.totals.cancelledWorkerShare, null);
});
test("cost rates are explicit, unknown rates stay unknown and incomplete time remains visible", () => {
  const data = snapshot();
  const rates = { currency: "USD", perMinute: { "ubuntu-latest": 0.01 } };
  assert.equal(auditSnapshot(data).totals.estimatedCost.amount, null);
  assert(
    Math.abs(
      auditSnapshot(data, { rates }).totals.estimatedCost.amount - 0.15,
    ) < 1e-12,
  );
  delete data.runs[0].jobs.items[0].labels;
  const partial = auditSnapshot(data, { rates }).totals.estimatedCost;
  assert.equal(partial.unratedWorkerSeconds, 60);
  assert.equal(partial.partial, true);
  assert.throws(() =>
    auditSnapshot(data, { rates: { currency: "USD", perMinute: { a: -1 } } }),
  );
});
test("job timing uses median and nearest-rank p90; repeated findings aggregate across runs", () => {
  const report = advisePerformance(snapshot()),
    job = report.jobSummaries[0];
  assert.equal(report.jobSummaries.length, 1);
  assert.equal(job.samples, 5);
  assert.equal(job.medianSeconds, 180);
  assert.equal(job.p90Seconds, 300);
  assert.equal(job.repeatedInstallSeconds, 300);
  assert.equal(job.estimatedWorkerSecondsPerPR, 150);
  assert.equal(job.successfulPRSamples, 4);
  const cache = report.findings.filter(
    (f) => f.type === "cache-configuration-review",
  );
  assert.equal(cache.length, 1);
  assert.equal(cache[0].observations, 5);
  assert.equal(cache[0].observedSeconds, 300);
  assert.match(renderMarkdown(report), /Median min/);
});
