/**
 * Opt-in PR-to-main reuse of signed, trusted full-run attestations.
 * GitHub metadata cannot attest actual checkout, environment or ungated execution.
 * A separate owner-controlled coordinator signs those facts; PR jobs must never hold its key.
 */
import fs from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { githubRead } from "./audit.mjs";
import { validRepository } from "./validation.mjs";
import { uniqueJSON } from "./json.mjs";
import {
  SHA,
  HASH,
  integer,
  gitRead,
  commitTree,
  trackedText,
} from "./evidence.mjs";

const WF = /^\.github\/workflows\/[^/\x00-\x20]+\.ya?ml$/;
const fields = [
  "schemaVersion",
  "repository",
  "workflow",
  "runId",
  "runAttempt",
  "runHeadSha",
  "testedSha",
  "treeSha",
  "environmentHash",
  "issuedAt",
  "fullRun",
  "jobs",
];
function statementBytes(statement) {
  if (
    !statement ||
    typeof statement !== "object" ||
    Array.isArray(statement) ||
    Object.keys(statement).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(statement, k)) ||
    statement.schemaVersion !== 1 ||
    !validRepository(statement.repository) ||
    !WF.test(statement.workflow ?? "") ||
    !integer(statement.runId) ||
    !integer(statement.runAttempt) ||
    !SHA.test(statement.runHeadSha ?? "") ||
    !SHA.test(statement.testedSha ?? "") ||
    !SHA.test(statement.treeSha ?? "") ||
    !HASH.test(statement.environmentHash ?? "") ||
    statement.fullRun !== true ||
    !Number.isSafeInteger(statement.issuedAt) ||
    !Array.isArray(statement.jobs) ||
    !statement.jobs.length ||
    statement.jobs.length > 500 ||
    statement.jobs.some((j) => typeof j !== "string" || !j || j.length > 500) ||
    new Set(statement.jobs).size !== statement.jobs.length
  )
    throw Error("Invalid validation attestation");
  // Domain separation and fixed field order prevent JSON property order ambiguity.
  return Buffer.from(
    "ci-planner-validation-v1\n" +
      JSON.stringify(Object.fromEntries(fields.map((k) => [k, statement[k]]))),
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = (jobs) => jobs.map((j) => j.name).sort();
function checkRun(run, repository, id) {
  if (
    !run ||
    run.id !== id ||
    !integer(run.run_attempt) ||
    run.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    run.event !== "pull_request" ||
    !SHA.test(run.head_sha ?? "") ||
    !WF.test(run.path ?? "") ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw Error("Successful unprivileged PR run evidence is required");
}
/** Fetch the exact latest attempt, require its complete unique successful inventory, then reread for drift. */
async function successfulRun(repository, id, read) {
  if (!validRepository(repository) || !integer(id))
    throw Error("Expected repository and positive run ID");
  const endpoint = "repos/" + repository + "/actions/runs/" + id;
  const run = await read(endpoint);
  checkRun(run, repository, id);
  const jobs = [],
    ids = new Set();
  let total;
  for (let page = 1; page <= 5; page++) {
    const data = await read(
      endpoint +
        "/attempts/" +
        run.run_attempt +
        "/jobs?per_page=100&page=" +
        page,
    );
    if (
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 1 ||
      data.total_count > 500 ||
      (total !== undefined && data.total_count !== total) ||
      !Array.isArray(data.jobs) ||
      data.jobs.length > 100
    )
      throw Error("Incomplete run inventory");
    total = data.total_count;
    jobs.push(...data.jobs);
    if (jobs.length >= total || data.jobs.length < 100) break;
  }
  if (
    jobs.length !== total ||
    jobs.some((j) => {
      const duplicate = ids.has(j.id);
      ids.add(j.id);
      return (
        duplicate ||
        !integer(j.id) ||
        j.run_id !== id ||
        j.run_attempt !== run.run_attempt ||
        j.status !== "completed" ||
        j.conclusion !== "success" ||
        typeof j.name !== "string" ||
        !j.name ||
        j.name.length > 500 ||
        !Array.isArray(j.steps) ||
        !j.steps.length ||
        j.steps.length > 1000 ||
        j.steps.some(
          (s) => s.status !== "completed" || s.conclusion !== "success",
        ) ||
        !Number.isFinite(Date.parse(j.completed_at))
      );
    }) ||
    new Set(names(jobs)).size !== jobs.length
  )
    throw Error(
      "Every expected job must succeed uniquely; skipped or ambiguous jobs cannot be reused",
    );
  const final = await read(endpoint);
  checkRun(final, repository, id);
  if (
    final.run_attempt !== run.run_attempt ||
    final.head_sha !== run.head_sha ||
    final.path !== run.path
  )
    throw Error("Run changed during evidence collection");
  return { run, jobs };
}

/** Explicit signing operation for a trusted coordinator. Never place its private key in PR execution. */
export async function attestValidation(
  {
    root = ".",
    repository,
    testedSha,
    runId,
    environmentHash,
    keyFile,
    fullRun = false,
    now = Date.now(),
  },
  read = githubRead,
) {
  if (/^pull_request/.test(process.env.GITHUB_EVENT_NAME ?? ""))
    throw Error("Attestation signing is forbidden in PR contexts");
  if (!fullRun || !HASH.test(environmentHash ?? "") || !keyFile)
    throw Error(
      "Trusted full-run, measured environment and signing key file are required",
    );
  const treeSha = commitTree(root, testedSha);
  const { run, jobs } = await successfulRun(repository, runId, read);
  if (jobs.some((j) => Date.parse(j.completed_at) > now))
    throw Error("Run completion is in the future");
  if (run.head_sha !== testedSha)
    throw Error(
      "Tested commit must equal the successful run head; merge attestation needs independent coordinator proof",
    );
  const statement = {
    schemaVersion: 1,
    repository,
    workflow: run.path,
    runId,
    runAttempt: run.run_attempt,
    runHeadSha: run.head_sha,
    testedSha,
    treeSha,
    environmentHash,
    issuedAt: Math.floor(now / 1000),
    fullRun: true,
    jobs: names(jobs),
  };
  let signature;
  try {
    const stat = fs.statSync(keyFile);
    if (!stat.isFile() || stat.size > 16384) throw Error();
    const key = createPrivateKey(fs.readFileSync(keyFile));
    if (key.asymmetricKeyType !== "ed25519") throw Error();
    signature = sign(null, statementBytes(statement), key).toString("base64");
  } catch {
    throw Error(
      "Ed25519 attestation signing failed; key material is never emitted",
    );
  }
  return { schemaVersion: 1, mode: "validation-receipt", statement, signature };
}

function contractAt(root, targetSha) {
  const cfg = uniqueJSON(
    trackedText(root, targetSha, ".ci-planner-reuse.json"),
  );
  if (
    !cfg ||
    cfg.schemaVersion !== 1 ||
    cfg.hermetic !== true ||
    cfg.noArtifacts !== true ||
    !WF.test(cfg.workflow ?? "") ||
    !HASH.test(cfg.environmentHash ?? "") ||
    !integer(cfg.maxAgeSeconds) ||
    cfg.maxAgeSeconds > 86400 ||
    !Array.isArray(cfg.publicKeys) ||
    !cfg.publicKeys.length ||
    cfg.publicKeys.length > 10 ||
    cfg.publicKeys.some(
      (key) => typeof key !== "string" || key.length > 4096,
    ) ||
    !Array.isArray(cfg.jobs) ||
    !cfg.jobs.length ||
    cfg.jobs.length > 500 ||
    cfg.jobs.some(
      (name) => typeof name !== "string" || !name || name.length > 500,
    ) ||
    new Set(cfg.jobs).size !== cfg.jobs.length ||
    Object.keys(cfg).some(
      (k) =>
        ![
          "schemaVersion",
          "hermetic",
          "noArtifacts",
          "workflow",
          "environmentHash",
          "maxAgeSeconds",
          "publicKeys",
          "jobs",
        ].includes(k),
    )
  )
    throw Error("Missing or invalid owner reuse contract");
  return cfg;
}

/**
 * Compare the entire tested tree with the current remote default-branch tree.
 * Missing/bad signatures, unknown runtime identity, stale/changed runs and missing fetches return run=true.
 * The caller must measure environmentHash in trusted runtime setup, never obtain it from a PR artifact.
 */
export async function verifyReuse(
  {
    root = ".",
    repository,
    targetSha,
    baseSha,
    environmentHash,
    receipt,
    now = Date.now(),
  },
  read = githubRead,
) {
  const result = {
    schemaVersion: 1,
    mode: "verified-reuse",
    repository,
    targetSha,
    baseSha,
    reusable: false,
    run: true,
    reason: "fresh-validation-required",
    limitations: [
      "Only an owner-signed full-run statement can bind tested checkout and environment facts; the API does not prove them.",
      "Whole-tree equivalence includes source, lockfiles, workflow and policy. No artifacts are restored or checks marked successful.",
      "Reuse trust comes from the target commit's first parent, before the merged change. Unknown evidence runs fresh.",
    ],
  };
  try {
    if (
      !validRepository(repository) ||
      !HASH.test(environmentHash ?? "") ||
      !SHA.test(baseSha ?? "")
    )
      throw Error("identity");
    const tree = commitTree(root, targetSha);
    // Never let a merged PR nominate the key that authorizes its own result.
    // A missing/shallow first parent or absent prior contract requires a fresh run.
    const contractSha = gitRead(root, [
      "rev-parse",
      "--verify",
      targetSha + "^1",
    ]).trim();
    // The caller supplies the trusted pre-push default-branch tip. Do not infer
    // it from a multi-commit push, whose first parent can already be PR-controlled.
    if (baseSha !== contractSha)
      throw Error("Target is not a single commit from the trusted base");
    const contract = contractAt(root, contractSha);
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.mode !== "validation-receipt" ||
      typeof receipt.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)
    )
      throw Error("receipt");
    const s = receipt.statement,
      bytes = statementBytes(s);
    const verified = contract.publicKeys.some((pem) => {
      try {
        const key = createPublicKey(pem);
        return (
          key.asymmetricKeyType === "ed25519" &&
          verify(null, bytes, key, Buffer.from(receipt.signature, "base64"))
        );
      } catch {
        return false;
      }
    });
    if (
      !verified ||
      s.repository !== repository ||
      s.workflow !== contract.workflow ||
      s.treeSha !== tree ||
      commitTree(root, s.testedSha) !== tree ||
      s.environmentHash !== environmentHash ||
      environmentHash !== contract.environmentHash ||
      !same([...s.jobs].sort(), [...contract.jobs].sort())
    )
      throw Error("equivalence");
    const age = Math.floor(now / 1000) - s.issuedAt;
    if (age < 0 || age > contract.maxAgeSeconds) throw Error("expired");
    const repo = await read("repos/" + repository);
    if (
      repo.full_name?.toLowerCase() !== repository.toLowerCase() ||
      typeof repo.default_branch !== "string" ||
      !repo.default_branch
    )
      throw Error("repository");
    const branchEndpoint =
      "repos/" +
      repository +
      "/branches/" +
      encodeURIComponent(repo.default_branch);
    if ((await read(branchEndpoint)).commit?.sha !== targetSha)
      throw Error("default branch");
    const { run, jobs } = await successfulRun(repository, s.runId, read);
    const completed = Math.max(...jobs.map((j) => Date.parse(j.completed_at)));
    if (
      completed > s.issuedAt * 1000 ||
      now - completed > contract.maxAgeSeconds * 1000
    )
      throw Error("Source validation has expired");
    if (
      run.run_attempt !== s.runAttempt ||
      run.head_sha !== s.runHeadSha ||
      run.path !== s.workflow ||
      !same(names(jobs), [...s.jobs].sort()) ||
      (await read(branchEndpoint)).commit?.sha !== targetSha
    )
      throw Error("live evidence changed");
    return {
      ...result,
      reusable: true,
      run: false,
      reason: "signed-full-run-and-whole-tree-match",
      sourceRunId: s.runId,
      sourceRunAttempt: s.runAttempt,
      treeSha: tree,
      workflow: s.workflow,
      contractSha,
    };
  } catch {
    // Do not print untrusted server errors, key bytes, filenames or raw receipt contents.
    return result;
  }
}
