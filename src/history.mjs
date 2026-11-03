/** Bounded merged-PR replay. Independent GitHub metadata/logs are observations, never skip authority. */
import { execFileSync } from "node:child_process";
import { parseDocument } from "../vendor/yaml/dist/index.js";
import { githubRead, auditSnapshot } from "./audit.mjs";
import { planRepository } from "./planner.mjs";
import { gitRead, commitTree, trackedText, integer } from "./evidence.mjs";
import { SHA, WORKFLOW, ACTION_SHA, validRepository } from "./validation.mjs";
const pick = (x, keys) => Object.fromEntries(keys.map((k) => [k, x[k]]));
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
  "steps",
];
export function checkoutFromLog(log, step) {
  if (
    typeof log !== "string" ||
    Buffer.byteLength(log) > 4 * 1024 * 1024 ||
    step?.conclusion !== "success"
  )
    return null;
  const start = Date.parse(step.started_at),
    end = Date.parse(step.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  const lines = log
    .split(/\r?\n/)
    .map((line) => /^(\S+) (.*)$/.exec(line))
    .filter(
      (m) => m && Date.parse(m[1]) >= start && Date.parse(m[1]) < end + 1000,
    )
    .map((m) => m[2]);
  const hashes = [];
  for (let i = 0; i < lines.length - 1; i++)
    if (
      /^\[command\].*\bgit log -1 --format=['"]?%H['"]?$/.test(lines[i]) &&
      SHA.test(lines[i + 1])
    )
      hashes.push(lines[i + 1]);
  return hashes.length === 1 ? hashes[0] : null;
}
function readLog(repository, id) {
  try {
    return execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        `repos/${repository}/actions/jobs/${id}/logs`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw Error("Bounded checkout log unavailable");
  }
}
function contractCheck(contract) {
  if (
    !contract ||
    !WORKFLOW.test(contract.workflow ?? "") ||
    !contract.jobs ||
    typeof contract.jobs !== "object" ||
    Array.isArray(contract.jobs) ||
    !Object.keys(contract.jobs).length ||
    Object.keys(contract.jobs).length > 100
  )
    throw Error("Expected explicit workflow/job/matrix/required-step contract");
  const names = new Set();
  for (const [id, job] of Object.entries(contract.jobs)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ||
      !Array.isArray(job.names) ||
      !job.names.length ||
      job.names.length > 100 ||
      !Array.isArray(job.requiredSteps) ||
      !job.requiredSteps.length ||
      job.requiredSteps.length > 100
    )
      throw Error("Invalid history job contract");
    for (const name of job.names) {
      if (
        typeof name !== "string" ||
        !name ||
        name.length > 500 ||
        names.has(name)
      )
        throw Error("Ambiguous matrix job mapping");
      names.add(name);
    }
    if (
      job.requiredSteps.some(
        (n) => typeof n !== "string" || !n || n.length > 500,
      ) ||
      new Set(job.requiredSteps).size !== job.requiredSteps.length
    )
      throw Error("Invalid required step mapping");
  }
}
/** Retain shell operators in substitutions while ignoring literal quoted program text. */
export function unquotedShell(source) {
  const stack = [{ quote: null, depth: 0 }];
  let output = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i],
      frame = stack.at(-1);
    if (frame.quote === "'") {
      if (ch === "'") {
        frame.quote = null;
        output += " ";
      }
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (frame.quote === '"') {
      if (ch === '"') {
        frame.quote = null;
        output += " ";
      } else if (ch === "$" && source[i + 1] === "(") {
        stack.push({ quote: null, depth: 1 });
        output += "$(";
        i++;
      } else if (ch === "`") return null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      frame.quote = ch;
      output += " ";
      continue;
    }
    if (ch === "`") return null;
    if (ch === "#" && (i === 0 || /\s/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (ch === "$" && source[i + 1] === "(") {
      stack.push({ quote: null, depth: 1 });
      output += "$(";
      i++;
      continue;
    }
    if (stack.length > 1) {
      if (ch === "(") frame.depth++;
      if (ch === ")" && --frame.depth === 0) stack.pop();
    }
    output += ch;
  }
  return stack.length === 1 && stack[0].quote === null ? output : null;
}
/** Named invocations remain an owner-reviewed contract; opaque shells/operators cannot prove a full run. */
function fullInvocation(step, job, doc) {
  if (typeof step.run !== "string") return false;
  const shell =
    step.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
  if (shell !== undefined && !["bash", "sh"].includes(shell)) return false;
  if (
    shell === undefined &&
    !/^(?:ubuntu|macos)-(?:latest|\d+(?:\.\d+)?)$/.test(job["runs-on"] ?? "")
  )
    return false;
  const plain = unquotedShell(step.run);
  return (
    plain !== null &&
    plain.trim() !== "" &&
    !/[|;&]/.test(plain) &&
    !/(?:^|\n)\s*(?:set\s+\+e|if|for|while|until|case|trap|eval|exec|source|exit|bash|sh|zsh|pwsh|function)\b/.test(
      plain,
    ) &&
    !/^\s*(?:echo|printf|true|:)\b/.test(plain)
  );
}
/** Static full-run checks are independent of PR-supplied reports and never infer missing matrix names. */
export function inspectFullWorkflow(text, contract) {
  contractCheck(contract);
  const issues = [];
  let doc;
  try {
    const parsed = parseDocument(text, { uniqueKeys: true, strict: true });
    if (parsed.errors.length || parsed.warnings.length) throw Error();
    doc = parsed.toJS({ maxAliasCount: 100 });
  } catch {
    return ["unreadable-workflow"];
  }
  if (
    JSON.stringify(Object.keys(doc.jobs ?? {}).sort()) !==
    JSON.stringify(Object.keys(contract.jobs).sort())
  )
    issues.push("unmapped-workflow-jobs");
  const on = doc.on;
  if (
    !(
      on === "pull_request" ||
      (Array.isArray(on) && on.includes("pull_request")) ||
      (on && Object.hasOwn(on, "pull_request"))
    ) ||
    (on?.pull_request && Object.keys(on.pull_request).length)
  )
    issues.push("filtered-or-non-pr-trigger");
  for (const [id, cfg] of Object.entries(contract.jobs)) {
    const job = doc.jobs?.[id];
    if (
      !job ||
      job.if !== undefined ||
      job["continue-on-error"] ||
      !Array.isArray(job.steps)
    ) {
      issues.push("gated-or-opaque-job:" + id);
      continue;
    }
    const prerequisites =
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    if (
      !Array.isArray(prerequisites) ||
      prerequisites.some(
        (dep) => typeof dep !== "string" || !Object.hasOwn(contract.jobs, dep),
      )
    )
      issues.push("unmapped-or-dynamic-prerequisite:" + id);
    let count = 1;
    if (job.strategy?.matrix) {
      const matrix = job.strategy.matrix;
      if (
        !matrix ||
        typeof matrix !== "object" ||
        Array.isArray(matrix) ||
        Object.keys(matrix).some((k) => ["include", "exclude"].includes(k))
      )
        count = NaN;
      else
        for (const values of Object.values(matrix)) {
          if (
            !Array.isArray(values) ||
            !values.length ||
            values.some(
              (v) => !["string", "number", "boolean"].includes(typeof v),
            )
          )
            count = NaN;
          else count *= values.length;
        }
    }
    if (count !== cfg.names.length)
      issues.push("matrix-coverage-unverified:" + id);
    const checkouts = job.steps.filter((s) =>
      /^actions\/checkout@/.test(s.uses ?? ""),
    );
    if (
      checkouts.length !== 1 ||
      !ACTION_SHA.test(checkouts[0]?.uses?.split("@")[1] ?? "") ||
      Object.keys(checkouts[0]?.with ?? {}).some((k) =>
        ["ref", "repository", "path", "sparse-checkout"].includes(k),
      )
    )
      issues.push("checkout-definition-unverified:" + id);
    if (
      job.steps.some(
        (s) =>
          s.if !== undefined ||
          s["continue-on-error"] ||
          /\bgit\s+(?:checkout|reset|switch|worktree)\b/.test(s.run ?? ""),
      )
    )
      issues.push("gated-or-changing-checkout-step:" + id);
    // Check that required names correspond to real invocations, not a successful echo-only placeholder.
    for (const name of cfg.requiredSteps)
      if (
        !job.steps.some(
          (s) =>
            (s.name ?? "Run " + s.run) === name && fullInvocation(s, job, doc),
        )
      )
        issues.push("required-invocation-unverified:" + id);
  }
  return issues;
}
async function attemptJobs(repository, run, attempt, read) {
  const items = [];
  let total;
  for (let page = 1; page <= 5; page++) {
    const data = await read(
      `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.jobs) ||
      data.jobs.length > 100 ||
      (total !== undefined && total !== data.total_count)
    )
      throw Error("Invalid or changing attempt inventory");
    total = data.total_count;
    for (const job of data.jobs) {
      if (!Array.isArray(job.steps) || job.steps.length > 1000)
        throw Error("Missing/bounded step inventory");
      items.push(pick(job, jobKeys));
    }
    if (items.length >= total || data.jobs.length < 100) break;
  }
  return { total_count: total, items };
}
/** Local Git must already contain commits; --fetch explicitly fetches validated object IDs from the bound GitHub repository. */
export async function replayHistory(
  { root = ".", repository, limit = 5, contract, fetch = false },
  { read = githubRead, log = readLog } = {},
) {
  if (!validRepository(repository) || !integer(limit) || limit > 20)
    throw Error("Expected repository and limit 1 through 20");
  contractCheck(contract);
  const rawRead = read,
    rawLog = log;
  let requests = 0,
    bytes = 0,
    logs = 0;
  read = async (endpoint) => {
    if (++requests > 250) throw Error("History request budget exceeded");
    const value = await rawRead(endpoint);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > 32 * 1024 * 1024) throw Error("History byte budget exceeded");
    return value;
  };
  log = async (repo, id) => {
    if (++requests > 250 || ++logs > 40)
      throw Error("History log budget exceeded");
    const value = await rawLog(repo, id);
    bytes += Buffer.byteLength(value);
    if (bytes > 32 * 1024 * 1024) throw Error("History byte budget exceeded");
    return value;
  };
  const ensure = (sha) => {
    if (!SHA.test(sha ?? "")) throw Error("Invalid history commit");
    try {
      commitTree(root, sha);
    } catch (error) {
      if (!fetch) throw error;
      gitRead(root, [
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "https://github.com/" + repository + ".git",
        sha,
      ]);
      commitTree(root, sha);
    }
  };
  const closed = [];
  let selectionComplete = false;
  for (let page = 1; page <= 5; page++) {
    const data = await read(
      `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(data) || data.length > 100)
      throw Error("Invalid PR page");
    for (const pr of data) if (pr.merged_at) closed.push(pr);
    if (data.length < 100) {
      selectionComplete = true;
      break;
    }
  }
  const prs = closed
      .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
      .slice(0, limit),
    observations = [];
  let truncated = false;
  prLoop: for (const pr of prs) {
    if (!integer(pr.number) || !SHA.test(pr.head?.sha ?? ""))
      throw Error("Invalid merged PR identity");
    const query = new URLSearchParams({
      event: "pull_request",
      head_sha: pr.head.sha,
      per_page: "100",
    });
    const listed = await read(
      `repos/${repository}/actions/workflows/${encodeURIComponent(contract.workflow.split("/").at(-1))}/runs?${query}`,
    );
    if (
      !Array.isArray(listed.workflow_runs) ||
      listed.workflow_runs.length > 100
    )
      throw Error("Invalid history run inventory");
    if (
      !Number.isSafeInteger(listed.total_count) ||
      listed.total_count > listed.workflow_runs.length
    )
      observations.push({
        pr: pr.number,
        verified: false,
        issues: ["partial-run-inventory"],
        candidateJobs: 0,
        candidateWorkerSeconds: 0,
        failedSuggestedSkips: 0,
      });
    const runs = listed.workflow_runs.filter(
      (r) => r.path === contract.workflow && r.head_sha === pr.head.sha,
    );
    if (!runs.length)
      observations.push({
        pr: pr.number,
        verified: false,
        issues: ["no-matching-run"],
        candidateJobs: 0,
        candidateWorkerSeconds: 0,
        failedSuggestedSkips: 0,
      });
    for (const run of runs) {
      if (
        !integer(run.id) ||
        !integer(run.run_attempt) ||
        run.run_attempt > 5
      ) {
        observations.push({
          pr: pr.number,
          verified: false,
          issues: ["attempt-bound-or-identity"],
          candidateJobs: 0,
          candidateWorkerSeconds: 0,
          failedSuggestedSkips: 0,
        });
        continue;
      }
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        if (observations.length >= 100) {
          truncated = true;
          break prLoop;
        }
        const item = {
          pr: pr.number,
          runId: run.id,
          attempt,
          verified: false,
          issues: [],
          candidateJobs: 0,
          candidateWorkerSeconds: 0,
          failedSuggestedSkips: 0,
        };
        try {
          const meta = await read(
            `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}`,
          );
          if (
            meta.id !== run.id ||
            meta.run_attempt !== attempt ||
            meta.repository?.full_name?.toLowerCase() !==
              repository.toLowerCase() ||
            meta.head_sha !== pr.head.sha ||
            meta.path !== contract.workflow ||
            meta.event !== "pull_request" ||
            meta.status !== "completed"
          )
            throw Error("Mismatched or unfinished attempt");
          const jobs = await attemptJobs(repository, meta, attempt, read);
          auditSnapshot({
            schemaVersion: 1,
            repository,
            runs: [{ ...pick(meta, runKeys), jobs }],
          });
          const expected = Object.values(contract.jobs).flatMap((j) => j.names);
          if (
            jobs.items.length !== jobs.total_count ||
            jobs.items.length !== expected.length ||
            new Set(jobs.items.map((j) => j.name)).size !== expected.length ||
            jobs.items.some((j) => !expected.includes(j.name))
          )
            throw Error("Incomplete or unmapped matrix inventory");
          const tested = [];
          for (const job of jobs.items) {
            const mapping = Object.values(contract.jobs).find((j) =>
              j.names.includes(job.name),
            );
            for (const name of mapping.requiredSteps) {
              const steps = job.steps.filter((s) => s.name === name);
              if (
                steps.length !== 1 ||
                steps[0].status !== "completed" ||
                !["success", "failure"].includes(steps[0].conclusion)
              )
                item.issues.push(
                  "required-validation-step-not-fully-attempted:" + job.name,
                );
            }
            const checkout = job.steps.filter((s) =>
              /^Run actions\/checkout@[0-9a-f]{40}$/.test(s.name),
            );
            if (checkout.length !== 1) throw Error("Checkout step unverified");
            const sha = checkoutFromLog(
              await log(repository, job.id),
              checkout[0],
            );
            if (!sha) throw Error("Exact tested checkout unavailable");
            tested.push(sha);
          }
          if (new Set(tested).size !== 1) throw Error("Mixed tested checkout");
          const testedSha = tested[0];
          ensure(testedSha);
          const parents = gitRead(root, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            testedSha,
          ])
            .trim()
            .split(" ");
          if (parents.length !== 3 || parents[2] !== pr.head.sha)
            throw Error("Checkout is not the exact PR merge");
          ensure(parents[1]);
          ensure(pr.head.sha);
          const issues = inspectFullWorkflow(
            trackedText(root, testedSha, contract.workflow),
            contract,
          );
          if (issues.length) {
            item.issues.push(...issues);
            throw Error("Ungated workflow not verified");
          }
          const plan = planRepository({
            root,
            repository,
            baseSha: parents[1],
            headSha: pr.head.sha,
            mergeSha: testedSha,
            event: "pull_request",
            enforce: false,
          });
          item.testedSha = testedSha;
          item.verified = item.issues.length === 0;
          item.matrixNames = jobs.items.map((j) => j.name);
          item.decisions = [];
          for (const [id, cfg] of Object.entries(contract.jobs)) {
            const candidate =
              plan.jobs[contract.workflow + "#" + id]?.candidate;
            for (const name of cfg.names) {
              const job = jobs.items.find((j) => j.name === name),
                seconds =
                  (Date.parse(job.completed_at) - Date.parse(job.started_at)) /
                  1000;
              item.decisions.push({
                job: id,
                name,
                candidate,
                conclusion: job.conclusion,
              });
              if (candidate === "skip") {
                if (
                  ["failure", "timed_out", "startup_failure"].includes(
                    job.conclusion,
                  ) &&
                  cfg.requiredSteps.some((required) =>
                    job.steps.some(
                      (s) =>
                        s.name === required &&
                        s.status === "completed" &&
                        s.conclusion === "failure",
                    ),
                  )
                )
                  item.failedSuggestedSkips++;
                else if (
                  job.conclusion === "success" &&
                  Number.isFinite(seconds) &&
                  seconds >= 0
                ) {
                  item.candidateJobs++;
                  item.candidateWorkerSeconds += seconds;
                } else {
                  item.verified = false;
                  item.issues.push("candidate-with-unknown-result-or-duration");
                }
              }
            }
          }
          const after = await read(
            `repos/${repository}/actions/runs/${run.id}`,
          );
          if (
            after.run_attempt !== run.run_attempt ||
            after.head_sha !== run.head_sha ||
            after.status !== "completed"
          ) {
            item.verified = false;
            item.failedSuggestedSkips = 0;
            item.issues.push("run-changed-during-collection");
          }
        } catch (error) {
          item.verified = false;
          item.failedSuggestedSkips = 0;
          item.issues.push(error.message);
        }
        if (!item.verified) {
          item.candidateJobs = 0;
          item.candidateWorkerSeconds = 0;
        }
        observations.push(item);
      }
    }
  }
  const verifiedJobs = observations
    .filter((o) => o.verified)
    .reduce((n, o) => n + (o.decisions?.length ?? 0), 0);
  const candidateJobs = observations.reduce((n, o) => n + o.candidateJobs, 0);
  return {
    schemaVersion: 1,
    mode: "historical-replay",
    repository,
    selection: {
      limit,
      mergedPRs: prs.map((p) => p.number),
      complete: selectionComplete,
      attemptsTruncated: truncated,
    },
    summary: {
      attempts: observations.length,
      verifiedJobs,
      candidateJobPercent: verifiedJobs
        ? (candidateJobs / verifiedJobs) * 100
        : null,
      candidateWorkerMinutes:
        observations.reduce((n, o) => n + o.candidateWorkerSeconds, 0) / 60,
      verifiedAttempts: observations.filter((o) => o.verified).length,
      unknownAttempts: observations.filter((o) => !o.verified).length,
      candidateJobs: observations.reduce((s, o) => s + o.candidateJobs, 0),
      candidateWorkerSeconds: observations.reduce(
        (s, o) => s + o.candidateWorkerSeconds,
        0,
      ),
      failedSuggestedSkips: observations.reduce(
        (s, o) => s + o.failedSuggestedSkips,
        0,
      ),
    },
    observations,
    limitations: [
      "Advisory bounded historical observations only. No history or zero observed failures grants enforcement authority.",
      "Required step names and matrix names are an explicit owner-reviewed contract. Logs verify a pinned checkout's commit, not test quality or absence of subsequent arbitrary repository-code effects.",
      "Savings are candidate successful-job worker time, not billed savings. Missing logs, retired commits, gates and partial attempts remain unknown.",
      "Last-N merge ordering is complete only when the bounded closed-PR inventory is exhausted.",
    ],
  };
}
