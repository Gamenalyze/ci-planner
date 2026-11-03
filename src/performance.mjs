/** Observed timing advice, never changes runner placement, gates, shards or caches. */
import { auditSnapshot } from "./audit.mjs";

const seconds = (item) => {
  if (item.status !== "completed" || item.conclusion === "skipped") return null;
  const a = Date.parse(item.started_at),
    b = Date.parse(item.completed_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a
    ? (b - a) / 1000
    : null;
};
const median = (values) => {
  const v = [...values].sort((a, b) => a - b),
    m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Recognize explicit shard labels and step timing. Unknown cache hits remain unknown. */
export function advisePerformance(snapshot) {
  const audit = auditSnapshot(snapshot),
    findings = [];
  const cacheHits = [],
    jobIds = new Set();
  for (const run of snapshot.runs) {
    const jobs = run.jobs.items,
      shards = new Map(),
      installs = [];
    for (const job of jobs) {
      jobIds.add(job.id);
      if (typeof job.name !== "string" || job.name.length > 1000)
        throw Error("Invalid job name");
      const duration = seconds(job);
      const label = job.name.replace(
        /\bshard\s*[:= -]?\s*\d+(?:\s*\/\s*\d+)?|\b\d+\s*\/\s*\d+\b/gi,
        "{shard}",
      );
      if (label !== job.name && duration !== null)
        shards.set(label, [
          ...(shards.get(label) ?? []),
          { name: job.name, seconds: duration },
        ]);
      if (
        job.steps !== undefined &&
        (!Array.isArray(job.steps) || job.steps.length > 1000)
      )
        throw Error("Invalid performance steps");
      const seen = new Set();
      let installSeconds = 0,
        cacheSeconds = 0,
        knownCacheStep = false;
      for (const step of job.steps ?? []) {
        if (
          !Number.isSafeInteger(step.number) ||
          step.number < 1 ||
          seen.has(step.number) ||
          typeof step.name !== "string" ||
          step.name.length > 1000
        )
          throw Error("Invalid or duplicate performance step");
        seen.add(step.number);
        const elapsed = seconds(step);
        if (elapsed === null) continue;
        if (
          /\b(?:npm\s+(?:ci|install)|pnpm\s+(?:install|i)|yarn(?:\s+install)?|install\s+(?:dependencies|packages))\b/i.test(
            step.name,
          )
        )
          installSeconds += elapsed;
        if (/\bcache\b/i.test(step.name)) {
          cacheSeconds += elapsed;
          knownCacheStep = true;
        }
      }
      if (installSeconds >= 30)
        installs.push({ job: job.name, seconds: installSeconds });
      if (installSeconds >= 60 && !knownCacheStep)
        findings.push({
          type: "cache-configuration-review",
          runIds: [run.id],
          jobs: [job.name],
          observedSeconds: installSeconds,
          advice:
            "Inspect dependency caching and lockfile/platform keys. Setup actions may cache internally; metadata does not establish a miss.",
        });
      if (cacheSeconds >= 60)
        findings.push({
          type: "cache-overhead-review",
          runIds: [run.id],
          jobs: [job.name],
          observedSeconds: cacheSeconds,
          advice:
            "Compare cache transfer time and size with a fresh install; do not share incompatible native artifacts.",
        });
    }
    for (const members of shards.values()) {
      if (members.length < 2) continue;
      const times = members.map((m) => m.seconds),
        shortest = Math.min(...times),
        longest = Math.max(...times);
      if (longest >= 120 && longest >= Math.max(1, shortest) * 1.5)
        findings.push({
          type: "uneven-shards-review",
          runIds: [run.id],
          jobs: members.map((m) => m.name),
          observedSeconds: longest,
          medianSeconds: median(times),
          advice:
            "Review per-test timing and shard inputs, then rebalance while preserving full test coverage. Matrix members may have different workloads.",
        });
    }
    if (installs.length >= 2)
      findings.push({
        type: "repeated-install-review",
        runIds: [run.id],
        jobs: installs.map((j) => j.job),
        observedSeconds: installs.reduce((sum, j) => sum + j.seconds, 0),
        advice:
          "Review repeated dependency setup and compatible cache keys. Independent jobs may need separate installs; native binaries and permissions must match.",
      });
    const ends = jobs
      .filter((j) => seconds(j) !== null)
      .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
    if (ends.length >= 2) {
      const tail =
        (Date.parse(ends[0].completed_at) - Date.parse(ends[1].completed_at)) /
        1000;
      if (tail >= 60)
        findings.push({
          type: "last-finishing-job-review",
          runIds: [run.id],
          jobs: [ends[0].name],
          observedSeconds: tail,
          advice:
            "This job finished after the other observed jobs. Review dependencies, queue time and its slow steps; metadata alone does not prove the critical path.",
        });
    }
  }
  const observations = snapshot.cacheObservations ?? [];
  if (!Array.isArray(observations) || observations.length > 10000)
    throw Error("Invalid cache observations");
  const seen = new Set();
  for (const item of observations) {
    const id = item.jobId + ":" + item.stepNumber;
    if (
      !jobIds.has(item.jobId) ||
      !Number.isSafeInteger(item.stepNumber) ||
      typeof item.hit !== "boolean" ||
      seen.has(id) ||
      !snapshot.runs.some((r) =>
        r.jobs.items.some(
          (j) =>
            j.id === item.jobId &&
            j.steps?.some((s) => s.number === item.stepNumber),
        ),
      )
    )
      throw Error("Unbound or duplicate cache observation");
    seen.add(id);
    cacheHits.push(item.hit);
  }
  const hitRate = cacheHits.length
    ? cacheHits.filter(Boolean).length / cacheHits.length
    : null;
  if (cacheHits.length >= 3 && hitRate < 0.5)
    findings.push({
      type: "low-cache-hit-rate-review",
      runIds: [],
      jobs: [],
      hitRate,
      advice:
        "Review the instrumented cache misses, key stability and restore scope. Keep lockfile, OS, architecture and toolchain compatibility in the key.",
    });
  return {
    schemaVersion: 1,
    mode: "performance-advice",
    repository: snapshot.repository,
    observedRuns: audit.runs.length,
    completeRuns: audit.totals.completeRuns,
    findings,
    cache: {
      observedHits: cacheHits.filter(Boolean).length,
      samples: cacheHits.length,
      hitRate,
    },
    estimatedSavingsSeconds: null,
    billingMinutes: null,
    limitations: [
      "Names and bounded latest-attempt timestamps provide review prompts, not proven waste or measured savings.",
      "Step names may be wrappers; default GitHub metadata does not expose cache hits. Optional cache observations must come from trusted instrumentation.",
      "Partial and failed runs can skew advice. No workflow or cache is changed.",
    ],
  };
}
