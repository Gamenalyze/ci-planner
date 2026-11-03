/**
 * Deterministic planning model and immutable-Git adapter.
 * No PR commands, actions, hooks or package scripts are executed during analysis.
 * Input completeness remains an explicit owner assertion, never an inferred proof.
 * @module planner
 */
import { createHash } from "node:crypto";
import { gitRead as git } from "./evidence.mjs";
import {
  parseDocument,
  visit as visitYaml,
} from "../vendor/yaml/dist/index.js";
import { validRepository, SHA, ACTION_SHA, WORKFLOW } from "./validation.mjs";
import { uniqueJSON } from "./json.mjs";
import { githubRead } from "./audit.mjs";

export const VERSION = "0.5.0";
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const GLOBAL = [
  ".gitmodules",
  ".gitattributes",
  ".tool-versions",
  ".node-version",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements*.txt",
  "poetry.lock",
  "uv.lock",
  "Gemfile",
  "Gemfile.lock",
  "docker-compose*",
  "compose.y*ml",
  ".github/**",
  ".ci-planner.json",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  "tsconfig*.json",
  "Dockerfile",
  "Dockerfile.*",
];
const SHARED = [
  ...GLOBAL,
  ...GLOBAL.filter((p) => !p.includes("/")).map((p) => "**/" + p),
];
const patternCache = new Map();
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Match the small supported glob language: literal paths, * within a segment, ** as a segment.
 * Reject exclusions and ambiguous syntax instead of guessing what an owner meant.
 * @param {string} pattern Repository-relative input pattern.
 * @param {string} filename Repository-relative path from Git.
 * @returns {boolean}
 * @throws {Error} Unsupported pattern syntax.
 */
export function patternMatches(pattern, filename) {
  if (patternCache.has(pattern))
    return patternCache.get(pattern).test(filename);
  if (
    typeof pattern !== "string" ||
    !pattern ||
    pattern.length > 500 ||
    /[\\\x00-\x20?\[\]{}!]/.test(pattern) ||
    pattern.startsWith("/") ||
    pattern
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          (part.includes("**") && part !== "**"),
      )
  )
    throw Error("Unsupported input pattern");
  const parts = pattern.split("/");
  let regex = "^";
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "**")
      regex += i === parts.length - 1 ? ".*" : "(?:[^/]+/)*";
    else
      regex +=
        parts[i]
          .split("*")
          .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
          .join("[^/]*") + (i < parts.length - 1 ? "/" : "");
  }
  const compiled = new RegExp(regex + "$");
  // Bounded across long-lived API callers; one plan fits within this bound.
  if (patternCache.size >= 250000) patternCache.clear();
  patternCache.set(pattern, compiled);
  return compiled.test(filename);
}

/** Inspect expressions in execution fields; plain text such as a step name is not an input. */
function hasHiddenExpression(value) {
  if (typeof value === "string") {
    // Find expression terminators outside GitHub single-quoted strings. A literal
    // containing }} must not hide a later secrets/vars reference in that expression.
    let cursor = 0;
    while ((cursor = value.indexOf("$" + "{{", cursor)) !== -1) {
      let quoted = false,
        body = "",
        closed = false;
      cursor += 3;
      for (; cursor < value.length; cursor++) {
        const char = value[cursor];
        if (char === "'") {
          if (quoted && value[cursor + 1] === "'") {
            cursor++;
            continue;
          }
          quoted = !quoted;
          continue;
        }
        if (!quoted && value.slice(cursor, cursor + 2) === "}}") {
          closed = true;
          cursor += 2;
          break;
        }
        if (!quoted) body += char;
      }
      // Only a small explicit set of routing facts is safe. PR body/title,
      // runner paths and computed context indexing remain external inputs.
      const routing = body
        .replace(
          /\bgithub\.(?:event_name|sha|ref_name|ref_type|ref|base_ref|head_ref|event\.pull_request\.(?:number|base\.sha|head\.sha))\b(?![.\[])/gi,
          "",
        )
        .replace(/\bmatrix\.[A-Za-z_][A-Za-z0-9_-]*\b(?![.\[])/gi, "");
      if (
        !closed ||
        /\b(?:secrets|vars|inputs|env|github|matrix|runner)\b/i.test(routing)
      )
        return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(hasHiddenExpression);
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some(hasHiddenExpression)
  );
}

function hiddenConditions(value) {
  if (Array.isArray(value)) return value.some(hiddenConditions);
  if (!object(value)) return false;
  return Object.entries(value).some(([field, child]) =>
    field === "if" && typeof child === "string"
      ? hasHiddenExpression(
          child.includes("$" + "{{") ? child : "$" + "{{" + child + "}}",
        )
      : hiddenConditions(child),
  );
}

/** Common hidden shell inputs; arbitrary scripts still require owner review. */
function hiddenShell(value) {
  if (Array.isArray(value)) return value.some(hiddenShell);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (key === "run" && typeof child === "string")
      return /(?:\$\{?(?:GITHUB_(?:EVENT_PATH|BASE_REF|HEAD_REF|REF|SHA|TOKEN)|RUNNER_[A-Z_]+)|\$env:(?:GITHUB|RUNNER)_|%GITHUB_[A-Z_]+%|\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b|\bgh\s+(?:api|run|release)\b)/i.test(
        child,
      );
    return hiddenShell(child);
  });
}

const matches = (patterns, filename) =>
  patterns.some((pattern) => patternMatches(pattern, filename));
function patterns(value) {
  if (!Array.isArray(value) || value.length > 200)
    throw Error("Expected bounded input patterns");
  for (const pattern of value) patternMatches(pattern, "validation");
  return value;
}

/** Validate the base-owned policy; unknown fields are errors to catch misspelled safety flags. */
function readPolicy(value) {
  if (value === null)
    return {
      schemaVersion: 1,
      mode: "shadow",
      globals: [],
      ignored: [],
      jobs: {},
    };
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !["shadow", "enforce"].includes(value.mode) ||
    !object(value.jobs) ||
    Object.keys(value.jobs).length > 1000
  )
    throw Error("Invalid policy");
  for (const key of Object.keys(value))
    if (
      ![
        "schemaVersion",
        "mode",
        "globals",
        "ignored",
        "jobs",
        "allowActionPublishers",
        "actionPins",
      ].includes(key)
    )
      throw Error("Unknown policy field");
  const allowActionPublishers = value.allowActionPublishers ?? [];
  if (
    !Array.isArray(allowActionPublishers) ||
    allowActionPublishers.length > 100 ||
    !allowActionPublishers.every(
      (p) => typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(p),
    )
  )
    throw Error("Invalid Action publisher allowlist");
  const actionPins = value.actionPins ?? {};
  if (
    !object(actionPins) ||
    Object.keys(actionPins).length > 200 ||
    Object.entries(actionPins).some(
      ([reference, sha]) =>
        !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[A-Za-z0-9_.\/-]+$/.test(
          reference,
        ) || !ACTION_SHA.test(sha),
    )
  )
    throw Error("Invalid owner Action pins");
  const jobs = Object.fromEntries(
    Object.entries(value.jobs).map(([key, rule]) => {
      const [workflow, id, extra] = key.split("#");
      if (
        !WORKFLOW.test(workflow) ||
        !JOB.test(id) ||
        extra !== undefined ||
        !object(rule) ||
        Object.keys(rule).some(
          (field) =>
            !["inputs", "inputsComplete", "controlNeeds"].includes(field),
        ) ||
        typeof rule.inputsComplete !== "boolean"
      )
        throw Error("Invalid job input contract");
      const inputs = patterns(rule.inputs);
      if (!inputs.length) throw Error("A scoped job needs at least one input");
      const controlNeeds = rule.controlNeeds ?? [];
      if (
        !Array.isArray(controlNeeds) ||
        controlNeeds.length > 100 ||
        !controlNeeds.every((id) => typeof id === "string" && JOB.test(id)) ||
        new Set(controlNeeds).size !== controlNeeds.length
      )
        throw Error("Invalid control dependencies");
      return [
        key,
        { inputs, inputsComplete: rule.inputsComplete, controlNeeds },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    mode: value.mode,
    allowActionPublishers,
    actionPins,
    globals: patterns(value.globals ?? []),
    ignored: patterns(value.ignored ?? []),
    jobs,
  };
}

/**
 * Rebuild all job nodes and local needs edges from committed workflow sources.
 * Bounded aliases keep their workflow fresh. Malformed YAML, dynamic needs and cycles refuse planning.
 * Mutable references, hidden inputs and environment-bound jobs stay fresh.
 * @param {Record<string, string>} sources Workflow paths mapped to YAML text.
 * @returns {Map<string, {key:string, workflow:string, id:string, needs:string[], implicitInputs:string[], opaque:boolean}>}
 */
export function discoverWorkflows(
  sources,
  {
    event,
    localSources = {},
    resolvedActions = {},
    allowActionPublishers = [],
    actionPins = {},
  } = {},
) {
  if (
    !object(sources) ||
    !Object.keys(sources).length ||
    Object.keys(sources).length > 100
  )
    throw Error("Expected 1 through 100 workflow definitions");
  const result = new Map();
  for (const [filename, source] of Object.entries(sources).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (
      !WORKFLOW.test(filename) ||
      typeof source !== "string" ||
      Buffer.byteLength(source) > 256 * 1024
    )
      throw Error("Invalid or oversized workflow");
    const document = parseDocument(source, {
      uniqueKeys: true,
      strict: true,
      merge: false,
    });
    if (document.errors.length || document.warnings.length)
      throw Error("Unsupported or invalid workflow YAML: " + filename);
    let aliases = false;
    visitYaml(document, {
      Alias() {
        aliases = true;
      },
    });
    const workflow = document.toJS({ maxAliasCount: 100 });
    if (
      !object(workflow) ||
      !object(workflow.jobs) ||
      !Object.keys(workflow.jobs).length
    )
      throw Error("Workflow has no jobs: " + filename);
    const trigger = workflow.on;
    const events =
      typeof trigger === "string"
        ? [trigger]
        : Array.isArray(trigger)
          ? trigger
          : object(trigger)
            ? Object.keys(trigger)
            : null;
    if (event && events && !events.includes(event)) continue;
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!JOB.test(id) || !object(job))
        throw Error("Unsupported job identifier or body");
      const needs =
        typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
      if (
        !Array.isArray(needs) ||
        !needs.every((name) => typeof name === "string" && JOB.test(name))
      )
        throw Error("Dynamic job dependencies are unsupported");
      const references = [
        job.uses,
        ...(Array.isArray(job.steps)
          ? job.steps.map((step) => step?.uses)
          : []),
      ].filter((value) => value !== undefined);
      const implicitInputs = [];
      const dataNeeds = new Set();
      // `if` may inspect ordering results; other needs access can carry data.
      function inspectNeeds(value, field = "") {
        if (field === "if") return;
        if (typeof value === "string") {
          for (const m of value.matchAll(
            /\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\b/gi,
          ))
            dataNeeds.add(m[1].toLowerCase());
          // Bracket/dynamic indexing cannot establish a control-only edge.
          if (
            /\bneeds(?:\.[A-Za-z_][A-Za-z0-9_-]*)?\s*\[|toJSON\s*\(\s*needs\b|\bneeds\.\*/i.test(
              value,
            )
          )
            needs.forEach((n) => dataNeeds.add(n.toLowerCase()));
        } else if (Array.isArray(value)) value.forEach((v) => inspectNeeds(v));
        else if (object(value))
          Object.entries(value).forEach(([k, v]) => inspectNeeds(v, k));
      }
      inspectNeeds([workflow.env, workflow.defaults, job]);
      // Routing metadata does not affect execution inputs. Inherited env/defaults do.
      const execution = Object.fromEntries(
        Object.entries(job).filter(
          ([key]) => !["name", "concurrency"].includes(key),
        ),
      );
      if (Array.isArray(execution.steps))
        execution.steps = execution.steps.map((step) =>
          step && typeof step === "object"
            ? Object.fromEntries(
                Object.entries(step).filter(([key]) => key !== "name"),
              )
            : step,
        );
      let opaque =
        aliases ||
        job.environment !== undefined ||
        job.secrets !== undefined ||
        hasHiddenExpression([workflow.env, workflow.defaults, execution]) ||
        hiddenShell(execution) ||
        hasHiddenExpression(job.strategy?.matrix) ||
        [
          job.if,
          ...(Array.isArray(job.steps)
            ? job.steps.map((step) => step?.if)
            : []),
        ].some(
          (condition) =>
            typeof condition === "string" &&
            hasHiddenExpression(
              condition.includes("$" + "{{")
                ? condition
                : "$" + "{{" + condition + "}}",
            ),
        );
      const seenLocals = new Set();
      function inspectReference(reference, depth = 0) {
        if (typeof reference !== "string" || reference.includes("$" + "{{")) {
          opaque = true;
          return;
        }
        if (
          /^\.\/[A-Za-z0-9_./-]+$/.test(reference) &&
          !reference.split("/").includes("..")
        ) {
          const local = reference.slice(2).replace(/\/$/, "");
          implicitInputs.push(local, local + "/**");
          if (seenLocals.has(local)) {
            opaque = true;
            return;
          }
          if (depth >= 10) {
            opaque = true;
            return;
          }
          seenLocals.add(local);
          const candidates = /\.ya?ml$/.test(local)
            ? [local]
            : [local + "/action.yml", local + "/action.yaml"];
          const found = candidates.filter((n) =>
            Object.hasOwn(localSources, n),
          );
          if (
            found.length !== 1 ||
            typeof localSources[found[0]] !== "string"
          ) {
            opaque = true;
            return;
          }
          const doc = parseDocument(localSources[found[0]], {
            uniqueKeys: true,
            strict: true,
          });
          let alias = false;
          visitYaml(doc, {
            Alias() {
              alias = true;
            },
          });
          if (doc.errors.length || doc.warnings.length || alias) {
            opaque = true;
            return;
          }
          const nested = doc.toJS({ maxAliasCount: 0 });
          // Reusable workflows remain fresh until their call inputs and nested jobs are modeled.
          if (!object(nested) || nested.runs?.using !== "composite") {
            opaque = true;
            return;
          }
          if (
            hasHiddenExpression(nested.runs.steps) ||
            hiddenShell(nested.runs.steps) ||
            hiddenConditions(nested.runs.steps)
          )
            opaque = true;
          for (const step of nested.runs.steps ?? [])
            if (step?.uses !== undefined)
              inspectReference(step.uses, depth + 1);
          seenLocals.delete(local);
        } else if (
          /^[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/.test(reference) ||
          /^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/.test(reference)
        ) {
          return;
        } else {
          const match =
            /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]+)?@([A-Za-z0-9_.\/-]+)$/.exec(
              reference,
            );
          if (
            !match ||
            !allowActionPublishers.some(
              (p) => p.toLowerCase() === match[1].toLowerCase(),
            ) ||
            !ACTION_SHA.test(resolvedActions[reference] ?? "") ||
            actionPins[reference] !== resolvedActions[reference]
          )
            opaque = true;
        }
      }
      for (const reference of references) inspectReference(reference);
      const containers = [
        job.container,
        ...Object.values(job.services ?? {}),
      ].filter(Boolean);
      if (
        containers.some(
          (container) =>
            !/@sha256:[0-9a-f]{64}$/.test(
              typeof container === "string"
                ? container
                : (container.image ?? ""),
            ),
        )
      )
        opaque = true;
      const key = filename + "#" + id;
      result.set(key, {
        key,
        workflow: filename,
        id,
        needs: needs.map((name) => filename + "#" + name),
        implicitInputs: [...new Set(implicitInputs)],
        dataNeeds: [...dataNeeds],
        opaque,
      });
    }
  }
  if (result.size > 1000) throw Error("Job graph exceeds 1000 jobs");
  const active = new Set();
  const done = new Set();
  function visit(key) {
    if (!result.has(key)) throw Error("Missing job dependency: " + key);
    if (active.has(key)) throw Error("Cyclic job dependencies");
    if (done.has(key)) return;
    active.add(key);
    for (const dependency of result.get(key).needs) visit(dependency);
    active.delete(key);
    done.add(key);
  }
  for (const key of result.keys()) visit(key);
  return result;
}

/**
 * Build explanations from a normalized repository snapshot.
 * This pure function models caller-supplied data. The verifiedMerge flag is an
 * internal assertion from planRepository, not a trust claim to accept from PR JSON.
 * Use planRepository for decisions that drive CI. Shadow mode always sets run=true.
 * @param {object} options
 * @param {string} options.baseSha Trusted base commit.
 * @param {string} options.headSha PR source commit.
 * @param {string|null} [options.mergeSha] Exact tested combined tree.
 * @param {boolean} [options.verifiedMerge] Set only by a trusted Git reader.
 * @param {boolean} [options.enforce] Caller requests skips, in addition to base-policy opt-in.
 * @param {Record<string,string>} options.workflows Workflow source map.
 * @param {Array<{status:string,path:string}>} options.changes Complete relevant Git delta.
 * @param {object|null} [options.policy] Policy read from base, never head or the worktree.
 * @returns {object} Versioned plan with per-job run booleans and reasons.
 */
export function buildPlan({
  repository = "local",
  baseSha,
  headSha,
  mergeSha = null,
  verifiedMerge = false,
  event = "pull_request",
  enforce = false,
  force = false,
  validationFallback = false,
  policy: rawPolicy = null,
  workflows,
  changes,
  localSources = {},
  resolvedActions = {},
}) {
  if (
    !SHA.test(baseSha) ||
    !SHA.test(headSha) ||
    (mergeSha !== null && !SHA.test(mergeSha))
  )
    throw Error("Expected full commit SHAs");
  if (repository !== "local" && !validRepository(repository))
    throw Error("Expected repository OWNER/REPO");
  if (
    !Array.isArray(changes) ||
    changes.length > 20000 ||
    changes.some(
      (change) =>
        !object(change) ||
        typeof change.path !== "string" ||
        typeof change.status !== "string",
    )
  )
    throw Error("Invalid or oversized change inventory");
  const policy = readPolicy(rawPolicy);
  const graph = discoverWorkflows(workflows, {
    event,
    localSources,
    resolvedActions,
    allowActionPublishers: policy.allowActionPublishers,
    actionPins: policy.actionPins,
  });
  const fullReasons = [];
  if (force) fullReasons.push("manual-full-validation");
  if (validationFallback) fullReasons.push("skip-validation-requires-full-run");
  if (event !== "pull_request")
    fullReasons.push("event-requires-full-validation");
  if (!changes.length) fullReasons.push("empty-change-set");
  if (
    changes.some(
      (change) =>
        !["A", "M"].includes(change.status) ||
        /[\x00-\x1f\\]/.test(change.path),
    )
  )
    fullReasons.push("structural-or-unknown-change");
  const allInputs = [
    ...SHARED,
    ...policy.globals,
    ...policy.ignored,
    ...Object.values(policy.jobs).flatMap((rule) => rule.inputs),
    ...[...graph.values()].flatMap((job) => job.implicitInputs),
  ];
  if (
    changes.some((change) =>
      matches([...SHARED, ...policy.globals], change.path),
    )
  )
    fullReasons.push("shared-control-or-runtime-input");
  if (changes.some((change) => !matches(allInputs, change.path)))
    fullReasons.push("unmapped-changed-input");
  const canEnforce =
    enforce &&
    policy.mode === "enforce" &&
    event === "pull_request" &&
    verifiedMerge &&
    mergeSha !== null;
  const jobs = new Map();
  for (const [key, job] of graph) {
    const rule = Object.hasOwn(policy.jobs, key) ? policy.jobs[key] : null;
    let reason = fullReasons[0] ?? null;
    if (!reason && !rule) reason = "new-or-unscoped-job";
    if (!reason && !rule.inputsComplete) reason = "incomplete-input-contract";
    if (!reason && job.opaque) reason = "hidden-dynamic-or-mutable-input";
    if (
      !reason &&
      changes.some((change) =>
        matches([...rule.inputs, ...job.implicitInputs], change.path),
      )
    )
      reason = "changed-job-input";
    jobs.set(key, {
      workflow: job.workflow,
      id: job.id,
      candidate: reason ? "run" : "skip",
      reason: reason ?? "owner-declared-inputs-unchanged",
    });
  }
  // Data invalidation travels producer -> consumer before retaining producers.
  // A forced unchanged producer does not needlessly invalidate its siblings.
  const consumers = new Map([...graph.keys()].map((key) => [key, []]));
  for (const [key, job] of graph) {
    const controls = policy.jobs[key]?.controlNeeds ?? [];
    for (const id of controls) {
      if (!job.needs.includes(job.workflow + "#" + id))
        throw Error("Control dependency is not a needs edge");
      if (job.dataNeeds.includes(id.toLowerCase()))
        throw Error("Control dependency carries needs outputs");
    }
    for (const upstream of job.needs)
      if (!controls.includes(graph.get(upstream).id))
        consumers.get(upstream).push(key);
  }
  const queue = [...jobs]
    .filter(([, job]) => job.candidate === "run")
    .map(([key]) => key);
  for (let i = 0; i < queue.length; i++)
    for (const child of consumers.get(queue[i]))
      if (jobs.get(child).candidate === "skip") {
        jobs.get(child).candidate = "run";
        jobs.get(child).reason = "upstream-job-selected";
        queue.push(child);
      }
  // A selected consumer needs its producers, even if a producer's own inputs did not change.
  function retain(key) {
    for (const dependency of graph.get(key).needs) {
      const producer = jobs.get(dependency);
      if (producer.candidate === "skip") {
        producer.candidate = "run";
        producer.reason = "selected-job-needs-output";
        retain(dependency);
      }
    }
  }
  for (const [key, job] of jobs) if (job.candidate === "run") retain(key);
  const decisions = Object.fromEntries(
    [...jobs].map(([key, job]) => [
      key,
      { ...job, run: !canEnforce || job.candidate === "run" },
    ]),
  );
  const identity = { repository, baseSha, headSha, mergeSha, event };
  return {
    schemaVersion: 1,
    engineVersion: VERSION,
    mode: canEnforce ? "enforce" : "shadow",
    identity,
    policySource: "base-commit",
    policyHash: digest(policy),
    warnings: Object.keys(policy.jobs)
      .filter((key) => !graph.has(key))
      .map((job) => ({
        code: "stale-policy-job",
        job,
        message:
          "Policy entry has no discovered job; renamed/new jobs still run.",
      })),
    planHash: digest({
      version: VERSION,
      identity,
      policy,
      workflows,
      localSources,
      resolvedActions,
      changes,
      force,
      validationFallback,
      canEnforce,
    }),
    fullReasons,
    resolvedActions,
    jobs: decisions,
    limitations: [
      "Input completeness is an owner declaration, not inferred proof.",
      "New jobs are discovered on every plan and run until scoped.",
      "Signed reuse is a separate explicit command; timing and discovery never authorize skips.",
    ],
    ...(enforce && !canEnforce
      ? {
          fallback:
            "Enforcement requires base policy opt-in and a verified merge for a pull_request event; every job runs.",
        }
      : {}),
  };
}

/**
 * Read only Git objects, bind decisions to exact commits, and load policy from base.
 * When merge is supplied, its first/second parents must equal base/head. Selection
 * uses base..merge, so manual edits to the combined tree cannot hide from the diff.
 * Without merge, merge-base..head supports shadow review and never enables skips.
 * Dirty files, environment tokens and private repository contents are not emitted.
 * @param {object} options Options accepted by buildPlan, plus root (checkout directory).
 * @returns {object} A bound plan; throws on missing or ambiguous repository evidence.
 */
export function planRepository(options) {
  const { root = ".", baseSha, headSha, mergeSha = null } = options;
  for (const sha of [baseSha, headSha, ...(mergeSha ? [mergeSha] : [])]) {
    if (
      !SHA.test(sha ?? "") ||
      git(root, ["cat-file", "-t", sha]).trim() !== "commit"
    )
      throw Error(
        "Expected available full commit SHAs; fetch base, head and merge commits",
      );
  }
  let verifiedMerge = false;
  if (mergeSha) {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", mergeSha])
      .trim()
      .split(" ");
    if (
      parents.length !== 3 ||
      parents[1] !== baseSha ||
      parents[2] !== headSha
    )
      throw Error("Merge commit does not combine the exact base and head");
    verifiedMerge = true;
  }
  const target = mergeSha ?? headSha;
  const diffBase = mergeSha
    ? baseSha
    : git(root, ["merge-base", baseSha, headSha]).trim();
  const entries = git(root, ["ls-tree", "-r", "-z", "--full-tree", target])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match =
        /^(\d+) (\w+) ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t([\s\S]+)$/.exec(line);
      if (!match) throw Error("Unsupported Git tree entry");
      return { mode: match[1], type: match[2], path: match[4] };
    });
  if (entries.length > 20000)
    throw Error("Repository exceeds the 20000-file pilot bound");
  const workflowEntries = entries.filter((entry) => WORKFLOW.test(entry.path));
  if (
    workflowEntries.length > 100 ||
    workflowEntries.some(
      (entry) =>
        entry.type !== "blob" || !["100644", "100755"].includes(entry.mode),
    )
  )
    throw Error("Unsupported workflow tree");
  const workflows = Object.fromEntries(
    workflowEntries.map((entry) => [
      entry.path,
      git(root, ["show", target + ":" + entry.path], 256 * 1024),
    ]),
  );
  const policyTree = git(root, [
    "ls-tree",
    baseSha,
    "--",
    ".ci-planner.json",
  ]).trim();
  let policy = null;
  if (policyTree) {
    if (
      !/^100644 blob (?:[0-9a-f]{40}|[0-9a-f]{64})\t\.ci-planner\.json$/.test(
        policyTree,
      )
    )
      throw Error("Policy must be a regular file at the trusted base");
    policy = uniqueJSON(
      git(root, ["show", baseSha + ":.ci-planner.json"], 64 * 1024),
    );
  }
  const localEntries = entries.filter((entry) =>
    /(?:^|\/)action\.ya?ml$/.test(entry.path),
  );
  const localSources = { ...workflows };
  let localBytes = 0;
  for (const entry of localEntries.slice(0, 500)) {
    localSources[entry.path] = null;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      continue;
    if (localBytes >= 2 * 1024 * 1024) continue;
    let source;
    try {
      source = git(root, ["show", target + ":" + entry.path], 256 * 1024);
    } catch {
      continue;
    } // Unavailable/oversized metadata keeps its calling job opaque.
    if (localBytes + Buffer.byteLength(source) > 2 * 1024 * 1024) continue;
    localBytes += Buffer.byteLength(source);
    localSources[entry.path] = source;
  }
  const trustedPolicy = readPolicy(policy),
    resolvedActions = {};
  const read = options.readAction ?? githubRead;
  const references = new Set();
  for (const source of Object.values({ ...workflows, ...localSources })) {
    if (typeof source !== "string") continue;
    const doc = parseDocument(source);
    if (doc.errors.length || doc.warnings.length) continue;
    visitYaml(doc, {
      Pair(_, pair) {
        if (pair.key?.value === "uses" && typeof pair.value?.value === "string")
          references.add(pair.value.value);
      },
    });
  }
  const resolutionStarted = Date.now();
  let resolutionReads = 0;
  for (const reference of [...references].sort().slice(0, 200)) {
    const m =
      /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]+)?@([A-Za-z0-9_.\/-]+)$/.exec(
        reference,
      );
    if (
      !m ||
      ACTION_SHA.test(m[3]) ||
      !trustedPolicy.allowActionPublishers?.some(
        (p) => p.toLowerCase() === m[1].toLowerCase(),
      )
    )
      continue;
    if (resolutionReads >= 20 || Date.now() - resolutionStarted > 15000)
      continue;
    resolutionReads++;
    try {
      const response = read(
        "repos/" + m[1] + "/" + m[2] + "/commits/" + encodeURIComponent(m[3]),
      );
      if (ACTION_SHA.test(response?.sha ?? ""))
        resolvedActions[reference] = response.sha;
    } catch {
      /* Unavailable resolution retains the job. */
    }
  }
  const delta = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--ignore-submodules=none",
    "--name-status",
    "-z",
    diffBase,
    target,
    "--",
  ]).split("\0");
  if (delta.pop() !== "") throw Error("Incomplete Git diff");
  const changes = [];
  for (let i = 0; i < delta.length; i += 2) {
    if (delta[i + 1] === undefined) throw Error("Incomplete Git change");
    changes.push({ status: delta[i], path: delta[i + 1] });
  }
  return buildPlan({
    ...options,
    policy,
    workflows,
    changes,
    verifiedMerge,
    localSources,
    resolvedActions,
  });
}
