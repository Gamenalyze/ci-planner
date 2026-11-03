/**
 * Additive onboarding from committed inputs. Suggestions never assert complete
 * input knowledge, enable enforcement, or rewrite the repository's existing CI.
 * @module setup
 */
import fs from "node:fs";
import { gitRead, readDependencySnapshot } from "./evidence.mjs";
import { suggestJobInputs } from "./input-scopes.mjs";
import path from "node:path";
import { stringify } from "../vendor/yaml/dist/index.js";
import { buildPlan, discoverWorkflows, VERSION } from "./planner.mjs";
import {
  auditRepositorySnapshot,
  readRepositorySnapshot,
} from "./repository-audit.mjs";

import { SHA, WORKFLOW } from "./validation.mjs";
const workflowPath = ".github/workflows/ci-planner.yml";
const policyPath = ".ci-planner.json";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const workflow = (name) => WORKFLOW.test(name);
const git = (root, args) => gitRead(root, args).trim();

/**
 * Propose an advisory workflow and, when absent, an incomplete shadow policy.
 * @param {{ref:string,files:Record<string,string|null>}} snapshot Immutable repository snapshot.
 * @param {{actionRef?:string}} options Reviewed SHA or version; no branch-name interpolation.
 * @returns {object} Serializable preview. No reads, writes or repository commands.
 */
export function proposeSetup(snapshot, { actionRef = "v" + VERSION } = {}) {
  if (
    !SHA.test(snapshot?.ref ?? "") ||
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
  const expression = (body) => String.fromCharCode(36) + "{{ " + body + " }}";
  // The shared hex/length grammar needs only ERE groups in Bash. Keep this step
  // usable before the Action has bootstrapped a missing/unsupported Node runtime.
  const revisions = [
    "sha='" + SHA.source.replaceAll("(?:", "(") + "'",
    "valid() { [[ \"$1\" =~ $sha && ! \"$1\" =~ ^0+$ ]]; }",
    'base="$EVENT_BASE"',
    'if ! valid "$base"; then',
    "  base=$(git rev-parse --verify HEAD^ 2>/dev/null || git rev-parse --verify HEAD)",
    "fi",
    'head="$EVENT_HEAD"',
    'valid "$base"',
    'valid "$head"',
    "printf 'base=%s\\nhead=%s\\n' \"$base\" \"$head\" >> \"$GITHUB_OUTPUT\"",
  ].join("\n");
  const verify = [
    "node <<'NODE'",
    "const assert = require('node:assert/strict');",
    "assert.equal(process.env.PLANNER_READY, 'true');",
    "assert.equal(process.env.PLANNER_MODE, 'shadow');",
    "const run = JSON.parse(process.env.PLANNER_RUN);",
    "assert(run && typeof run === 'object' && !Array.isArray(run));",
    "assert(Object.keys(run).length > 0);",
    "assert.equal(run.report, true);",
    "assert(Object.values(run).every(value => value === true));",
    "console.log('Shadow outputs verified; existing CI jobs remain ungated.');",
    "NODE",
  ].join("\n");
  const content = stringify({
    name: "CI Planner shadow",
    on: {
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions: { contents: "read" },
    concurrency: {
      group: "ci-planner-shadow-" + expression("github.repository") + "-" +
        expression("github.event_name") + "-" +
        expression("github.event.pull_request.number || github.ref") + "-" +
        expression("github.sha"),
      "cancel-in-progress": true,
    },
    jobs: {
      report: {
        name: "Shadow report (no CI gating)",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        "continue-on-error": true,
        steps: [
          {
            uses: CHECKOUT,
            with: {
              ref: expression("github.sha"),
              "fetch-depth": 0,
              lfs: false,
              submodules: false,
              "persist-credentials": false,
            },
          },
          {
            name: "Resolve trusted event revisions",
            id: "revisions",
            shell: "bash",
            env: {
              EVENT_BASE: expression("github.event.pull_request.base.sha || github.event.before"),
              EVENT_HEAD: expression("github.event.pull_request.head.sha || github.sha"),
            },
            run: revisions,
          },
          {
            name: "Plan without enabling skips",
            id: "plan",
            uses: "Gamenalyze/ci-planner@" + actionRef,
            with: {
              base: expression("steps.revisions.outputs.base"),
              head: expression("steps.revisions.outputs.head"),
              merge: expression("github.event_name == 'pull_request' && github.sha || ''"),
              workflow: workflowPath,
              enforce: "false",
              summary: "true",
              "audit-repository": "true",
            },
          },
          {
            name: "Verify advisory outputs",
            id: "verify",
            shell: "bash",
            env: {
              PLANNER_READY: expression("steps.plan.outputs.ready"),
              PLANNER_MODE: expression("steps.plan.outputs.mode"),
              PLANNER_RUN: expression("steps.plan.outputs.run"),
            },
            run: verify,
          },
        ],
      },
    },
  });
  const graph = discoverWorkflows({ ...sources, [workflowPath]: content });
  const names = Object.keys(snapshot.files);
  // Propose reviewable source scopes, never infer completeness or execute scripts.
  const ignored = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "LICENSE",
    "docs/**",
  ].filter((pattern) =>
    pattern === "docs/**"
      ? names.some((n) => n.startsWith("docs/"))
      : names.includes(pattern),
  );
  const proposedInputs = new Set();
  for (const name of names) {
    if (
      /(?:^|\/)(?:node_modules|vendor|fixtures|__fixtures__)\//.test(name) ||
      /(?:^|\/)\.env(?:\.|$)/.test(name)
    )
      continue;
    if (
      /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$|^LICENSE$|^docs\//.test(
        name,
      )
    )
      continue;
    const parts = name.split("/");
    const pattern = parts.length > 1 ? parts[0] + "/**" : name;
    try {
      if (!/[\\\x00-\x20?\[\]{}!]/.test(pattern)) proposedInputs.add(pattern);
    } catch {
      /* Unrepresentable names remain unmapped. */
    }
  }
  // Documentation read by package scripts is input even when proposed as ignored.
  const manifestText = names
    .filter((n) => /(?:^|\/)package\.json$/.test(n))
    .map((n) => snapshot.files[n])
    .filter((text) => typeof text === "string")
    .join("\n");
  for (const name of names.filter((n) =>
    /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$|^LICENSE$|^docs\//.test(
      n,
    ),
  )) {
    if (manifestText.includes(name) || /npm\s+pack/.test(manifestText)) {
      proposedInputs.add(name.startsWith("docs/") ? "docs/**" : name);
    }
  }
  const suggestedInputs =
    proposedInputs.size > 0 && proposedInputs.size <= 200
      ? [...proposedInputs].sort()
      : ["**"];
  const completeness = auditRepositorySnapshot(snapshot);
  const jobScopes = suggestJobInputs(snapshot, graph, suggestedInputs);
  const jobs = Object.fromEntries(
    [...graph.keys()].map((key) => [
      key,
      { inputsComplete: false, inputs: jobScopes[key].inputs },
    ]),
  );
  if (Object.keys(jobs).length > 1000)
    throw Error("Setup exceeds the 1000-job policy bound");
  const policy = { schemaVersion: 1, mode: "shadow", ignored, jobs };
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
        purpose: "Verified advisory PR, main-push and manual report with a repository audit summary.",
        content,
      },
    ],
    discoveredJobs: graph.size,
    scopeProposal: {
      inputs: suggestedInputs,
      jobs: jobScopes,
      ignored,
      requiresOwnerReview: true,
      completeness: completeness.summary,
    },
    existingPolicy,
    warnings: [
      ...(existingPolicy
        ? ["Existing policy is preserved, including its mode and contracts."]
        : []),
      "Broad input suggestions are incomplete. Review each job before enabling skips.",
      "Existing jobs are not gated or replaced. Add fallback conditions manually after evaluation.",
      "The runner label in the new advisory workflow needs owner review.",
      "Inspect repository workflow-inventory guards when adding the report; update exact inventories without weakening checks.",
      "The advisory job can be green after a failed step. Check the planner and verification step outcomes, not only the job conclusion.",
      "The run map covers the report workflow; application job contracts and skip safety remain unverified.",
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
  const dependencies = readDependencySnapshot({ root, ref: snapshot.ref });
  snapshot.files = {
    ...dependencies.files,
    ...Object.fromEntries(
      Object.entries(snapshot.files).filter(([, value]) => value !== null),
    ),
  };
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
