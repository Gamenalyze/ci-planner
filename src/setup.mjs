/**
 * Additive onboarding from committed inputs. Suggestions never assert complete
 * input knowledge, enable enforcement, or rewrite the repository's existing CI.
 * @module setup
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { buildPlan, discoverWorkflows, VERSION } from "./planner.mjs";
import { readRepositorySnapshot } from "./repository-audit.mjs";

const workflowPath = ".github/workflows/ci-planner.yml";
const policyPath = ".ci-planner.json";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const workflow = (name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name);
const git = (root, args) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * Propose an advisory workflow and, when absent, an incomplete shadow policy.
 * @param {{ref:string,files:Record<string,string|null>}} snapshot Immutable repository snapshot.
 * @param {{actionRef?:string}} options Reviewed SHA or version; no branch-name interpolation.
 * @returns {object} Serializable preview. No reads, writes or repository commands.
 */
export function proposeSetup(snapshot, { actionRef = "v" + VERSION } = {}) {
  if (
    !/^[0-9a-f]{40}$/.test(snapshot?.ref ?? "") ||
    !snapshot.files ||
    typeof snapshot.files !== "object" ||
    Array.isArray(snapshot.files) ||
    Object.keys(snapshot.files).length > 20000
  )
    throw Error("Invalid setup snapshot");
  if (!/^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/.test(actionRef))
    throw Error("Action ref must be a full reviewed SHA or vMAJOR.MINOR.PATCH");
  if (Object.hasOwn(snapshot.files, workflowPath))
    throw Error(
      "Setup workflow already exists; review it instead of overwriting",
    );
  const sources = Object.fromEntries(
    Object.entries(snapshot.files).filter(([name]) => workflow(name)),
  );
  // Refuse unsupported graphs before creating any files; discovery never executes jobs.
  if (Object.keys(sources).length) discoverWorkflows(sources);
  const selected = Object.keys(sources).sort()[0] ?? workflowPath;
  const expression = (body) => String.fromCharCode(36) + "{{ " + body + " }}";
  const content = stringify({
    name: "CI Planner report",
    on: "pull_request",
    permissions: { contents: "read" },
    jobs: {
      report: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        "continue-on-error": true,
        steps: [
          {
            uses: CHECKOUT,
            with: { "fetch-depth": 0, "persist-credentials": false },
          },
          {
            uses: "Gamenalyze/ci-planner@" + actionRef,
            with: {
              base: expression("github.event.pull_request.base.sha"),
              head: expression("github.event.pull_request.head.sha"),
              merge: expression("github.sha"),
              workflow: selected,
              enforce: "false",
              summary: "true",
              "audit-repository": "true",
            },
          },
        ],
      },
    },
  });
  const graph = discoverWorkflows({ ...sources, [workflowPath]: content });
  const jobs = Object.fromEntries(
    [...graph.keys()].map((key) => [
      key,
      { inputsComplete: false, inputs: ["**"] },
    ]),
  );
  if (Object.keys(jobs).length > 1000)
    throw Error("Setup exceeds the 1000-job policy bound");
  const policy = { schemaVersion: 1, mode: "shadow", jobs };
  // Exercise the same policy validator used by real plans, without granting any skip.
  buildPlan({
    baseSha: snapshot.ref,
    headSha: snapshot.ref,
    workflows: { ...sources, [workflowPath]: content },
    policy,
    changes: [],
  });
  const existingPolicy = Object.hasOwn(snapshot.files, policyPath);
  return {
    schemaVersion: 1,
    mode: "setup-preview",
    ref: snapshot.ref,
    actionRef,
    files: [
      ...(!existingPolicy
        ? [
            {
              path: policyPath,
              purpose: "Shadow policy; each job needs owner input review.",
              content: JSON.stringify(policy, null, 2) + "\n",
            },
          ]
        : []),
      {
        path: workflowPath,
        purpose: "Advisory PR plan and repository audit summary.",
        content,
      },
    ],
    discoveredJobs: graph.size,
    existingPolicy,
    warnings: [
      ...(existingPolicy
        ? ["Existing policy is preserved, including its mode and contracts."]
        : []),
      "Broad input suggestions are incomplete. Review each job before enabling skips.",
      "Existing jobs are not gated or replaced. Add fallback conditions manually after evaluation.",
      "The runner label in the new advisory workflow needs owner review.",
    ],
  };
}

/** Reject unsafe parents before any file is created; only the two fixed setup paths are allowed. */
function checkTargets(root, files) {
  for (const file of files) {
    if (
      ![policyPath, workflowPath].includes(file.path) ||
      typeof file.content !== "string"
    )
      throw Error("Unexpected setup output path");
    for (const name of [".github", ".github/workflows"]) {
      const parent = path.join(root, name);
      if (!fs.existsSync(parent)) {
        // A dangling symlink exists even when existsSync follows it to nothing.
        try {
          fs.lstatSync(parent);
          throw Error("Refuse symlinked setup parent");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else if (
        !fs.lstatSync(parent).isDirectory() ||
        fs.lstatSync(parent).isSymbolicLink()
      )
        throw Error("Refuse non-directory or symlinked setup parent");
    }
    try {
      fs.lstatSync(path.join(root, file.path));
      throw Error("Setup target already exists; no files changed");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Preview by default; --write creates only missing setup files exclusively.
 * Writes require a clean checkout at its Git root and the same committed HEAD.
 * No commit, push, PR, dependency install or source execution occurs.
 * @param {{root?:string,write?:boolean,actionRef?:string}} options
 * @returns {object} Versioned setup preview or local write receipt.
 */
export function initializeRepository({
  root = ".",
  write = false,
  actionRef,
} = {}) {
  const snapshot = readRepositorySnapshot({ root });
  const proposal = proposeSetup(snapshot, { actionRef });
  if (!write) return proposal;
  const base = fs.realpathSync(root);
  if (fs.realpathSync(git(base, ["rev-parse", "--show-toplevel"])) !== base)
    throw Error("Run setup writes at the repository root");
  if (git(base, ["status", "--porcelain", "--untracked-files=normal"]))
    throw Error(
      "Setup writes require a clean checkout; commit or stash changes first",
    );
  if (git(base, ["rev-parse", "HEAD"]) !== snapshot.ref)
    throw Error("HEAD changed during setup");
  checkTargets(base, proposal.files);
  fs.mkdirSync(path.join(base, ".github/workflows"), { recursive: true });
  checkTargets(base, proposal.files);
  const created = [];
  try {
    for (const file of proposal.files) {
      const target = path.join(base, file.path);
      fs.writeFileSync(target, file.content, { flag: "wx" });
      created.push({ target, stat: fs.lstatSync(target) });
    }
  } catch (error) {
    // Undo only files this invocation created, and leave pre-existing paths intact.
    for (const { target, stat } of created) {
      const current = fs.lstatSync(target);
      if (current.ino === stat.ino && current.dev === stat.dev)
        fs.unlinkSync(target);
    }
    throw error;
  }
  return { ...proposal, mode: "setup-written", written: true };
}
