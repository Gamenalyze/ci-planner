/**
 * Explicit, local-only publication of a generated additive workflow as a draft PR.
 * No repository scripts are executed. No existing ref is updated and no existing
 * workflow is replaced. Default preview needs no network or credentials.
 * @module fix-pr
 */
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";
import {
  auditRepositorySnapshot,
  readRepositorySnapshot,
} from "./repository-audit.mjs";
import { proposeCheckWorkflow } from "./check-proposals.mjs";
import { validRepository } from "./validation.mjs";
import { markdownCell } from "./reports.mjs";

const SHA = /^[0-9a-f]{40}$/;
const safeBranch = (value) =>
  typeof value === "string" &&
  value.length <= 200 &&
  /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(value) &&
  !value.endsWith("/") &&
  !value.includes("..") &&
  value
    .split("/")
    .every((part) => part && !part.endsWith(".lock") && !part.endsWith("."));

/**
 * Authenticated GitHub transport through gh. Tokens are consumed by gh, never
 * read, printed or written by this module. Errors omit raw response payloads.
 * @param {"GET"|"POST"} method
 * @param {string} endpoint A validated repo REST path built by this module.
 * @param {object|undefined} body
 * @param {{allowNotFound?:boolean}} options
 * @returns {object|null} Decoded JSON, or null for an explicitly allowed 404.
 */
export function githubRequest(
  method,
  endpoint,
  body,
  { allowNotFound = false } = {},
) {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          method,
          endpoint,
          ...(body ? ["--input", "-"] : []),
        ],
        {
          input: body ? JSON.stringify(body) : undefined,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 30000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    if (allowNotFound && /\(HTTP 404\)/.test(String(error.stderr ?? "")))
      return null;
    throw Error(
      "GitHub request failed; check gh authentication and repository permissions",
    );
  }
}

/**
 * Build a supported fix proposal and its before/after evidence, without changing files.
 * @param {{root?:string}} options Checkout containing committed repository objects.
 * @returns {object} Versioned offline preview with supported check IDs and omissions.
 */
export function previewFix({ root = "." } = {}) {
  const snapshot = readRepositorySnapshot({ root });
  const before = auditRepositorySnapshot(snapshot);
  const proposal = proposeCheckWorkflow(snapshot, before);
  if (Object.hasOwn(snapshot.files, proposal.path) && proposal.content)
    throw Error(
      "Generated workflow already exists; review it instead of overwriting",
    );
  const after = proposal.content
    ? auditRepositorySnapshot({
        ...snapshot,
        files: { ...snapshot.files, [proposal.path]: proposal.content },
      })
    : before;
  return {
    schemaVersion: 1,
    mode: "fix-preview",
    ref: snapshot.ref,
    path: proposal.path,
    content: proposal.content,
    addedCheckIds: proposal.addedCheckIds,
    notAdded: proposal.notAdded,
    before: before.summary,
    after: after.summary,
  };
}

function verifyContent(preview) {
  if (
    preview.path !== ".github/workflows/ci-planner-checks.yml" ||
    !SHA.test(preview.ref)
  )
    throw Error("Invalid generated fix identity");
  const doc = parseDocument(preview.content, {
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length || doc.warnings.length)
    throw Error("Invalid generated workflow");
  const data = doc.toJS({ maxAliasCount: 100 });
  if (
    data.on !== "pull_request" ||
    data.permissions?.contents !== "read" ||
    Object.keys(data.jobs ?? {}).length !== 1 ||
    Object.values(data.jobs).some((job) => job["runs-on"] !== "ubuntu-latest")
  )
    throw Error("Generated workflow violates additive fix contract");
}

/**
 * Bounded, escaped PR explanation. Never copy raw scripts, secret fields or commands.
 * @param {object} preview Generated fix preview, not arbitrary workflow contents.
 * @param {{repository:string,branch:string,base:string}} identity Validated publish scope.
 * @returns {string} Draft PR description with static evidence and rollback.
 */
export function fixPullRequestBody(preview, { repository, branch, base }) {
  const checks = preview.addedCheckIds
    .slice(0, 50)
    .map((id) => "- " + markdownCell(id));
  const omitted = preview.notAdded
    .slice(0, 25)
    .map((c) => "- " + markdownCell(c.id) + ": " + markdownCell(c.reason));
  return (
    [
      "## Problem and result",
      "",
      "Task description: add recognized missing repository CI checks through one new workflow.",
      "Branch: https://github.com/" + repository + "/tree/" + branch,
      "",
      "The audit found missing CI invocations at " +
        preview.ref +
        " on " +
        markdownCell(base) +
        ".",
      "This draft adds only " +
        markdownCell(preview.path) +
        "; existing workflows and release gates stay in place.",
      "",
      "## Proposed checks",
      "",
      ...checks,
      ...(preview.addedCheckIds.length > 50
        ? ["Additional check IDs are available in the CLI JSON report."]
        : []),
      "",
      "## Left for owner review",
      "",
      ...(omitted.length
        ? omitted
        : ["No additional supported gaps were omitted."]),
      "",
      "## Validation",
      "",
      "The YAML and event/permission contract were checked locally. A synthetic before/after audit recognizes the added invocations.",
      "Static missing invocations: " +
        preview.before.missing +
        " before, " +
        preview.after.missing +
        " after. Conditional or unverified findings still require owner review.",
      "No repository scripts or tests were executed. This is static evidence, not a successful CI run or test-quality approval.",
      "Opening this PR may start the repository's normal CI. Review runner placement, commands, dependency installation and required checks before merging.",
      "",
      "## Rollback",
      "",
      "Remove only the generated workflow. The existing CI files, input policy and release gates are unchanged.",
    ].join("\n") + "\n"
  );
}

/**
 * Publish only on explicit owner invocation from a local checkout matching the
 * remote default branch. The exact proposal is regenerated from Git objects.
 * No existing branches are updated; branch collisions and base drift abort.
 * @param {{root?:string,repository:string}} options
 * @param {Function} request Injectable GET/POST transport for offline tests.
 * @returns {Promise<object>} Draft PR receipt or a no-op preview when there is no supported gap.
 */
export async function openFixPullRequest(
  { root = ".", repository },
  request = githubRequest,
) {
  if (!validRepository(repository))
    throw Error("Explicit repository OWNER/REPO is required");
  if (process.env.GITHUB_ACTIONS === "true" || process.env.GITHUB_EVENT_NAME)
    throw Error(
      "Fix publication is local-only; CI and PR analysis remain read-only",
    );
  const preview = previewFix({ root });
  if (!preview.content)
    return { ...preview, message: "No supported missing checks to publish." };
  verifyContent(preview);
  const prefix = "repos/" + repository + "/";
  const info = await request("GET", "repos/" + repository);
  if (
    info.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !safeBranch(info.default_branch)
  )
    throw Error("Unexpected repository or default branch");
  const base = info.default_branch;
  const baseEndpoint = prefix + "git/ref/heads/" + base;
  const remote = await request("GET", baseEndpoint);
  if (remote.object?.type !== "commit" || remote.object.sha !== preview.ref)
    throw Error(
      "Local HEAD must match the remote default branch before publishing",
    );
  const commit = await request("GET", prefix + "git/commits/" + preview.ref);
  if (commit.sha !== preview.ref || !SHA.test(commit.tree?.sha ?? ""))
    throw Error("Invalid remote base commit");
  const branch = "ci-planner/fix-" + preview.ref.slice(0, 12);
  if (
    await request("GET", prefix + "git/ref/heads/" + branch, undefined, {
      allowNotFound: true,
    })
  )
    throw Error("Fix branch already exists; review the existing branch or PR");
  const tree = await request("POST", prefix + "git/trees", {
    base_tree: commit.tree.sha,
    tree: [
      {
        path: preview.path,
        mode: "100644",
        type: "blob",
        content: preview.content,
      },
    ],
  });
  if (!SHA.test(tree.sha ?? "")) throw Error("Invalid created tree");
  const created = await request("POST", prefix + "git/commits", {
    message: "ci: add missing repository checks",
    tree: tree.sha,
    parents: [preview.ref],
  });
  if (!SHA.test(created.sha ?? "")) throw Error("Invalid created commit");
  if ((await request("GET", baseEndpoint)).object?.sha !== preview.ref)
    throw Error("Default branch moved during preparation; rerun the audit");
  let branchCreated = false;
  try {
    const reference = await request("POST", prefix + "git/refs", {
      ref: "refs/heads/" + branch,
      sha: created.sha,
    });
    branchCreated = true;
    if (
      reference.ref !== "refs/heads/" + branch ||
      reference.object?.sha !== created.sha
    )
      throw Error("Invalid branch receipt");
    const pr = await request("POST", prefix + "pulls", {
      title: "ci: add missing repository checks",
      base,
      head: branch,
      draft: true,
      body: fixPullRequestBody(preview, { repository, branch, base }),
    });
    const expected = "https://github.com/" + repository + "/pull/";
    if (
      typeof pr.html_url !== "string" ||
      !pr.html_url.toLowerCase().startsWith(expected.toLowerCase()) ||
      !/^\d+$/.test(pr.html_url.slice(expected.length))
    )
      throw Error("Invalid PR receipt");
    return {
      ...preview,
      content: undefined,
      mode: "fix-pr-created",
      repository,
      base,
      branch,
      headSha: created.sha,
      url: pr.html_url,
      draft: true,
    };
  } catch {
    // Never delete a branch after a partial response: a PR may already exist.
    throw Error(
      branchCreated
        ? "Fix branch created at https://github.com/" +
            repository +
            "/tree/" +
            branch +
            "; PR creation was not confirmed. Inspect it before retrying."
        : "Fix branch creation was not confirmed. Inspect remote refs before retrying.",
    );
  }
}
