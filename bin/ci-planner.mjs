#!/usr/bin/env node
/** CLI boundary: validate arguments, print JSON, and export run booleans only after a valid plan. */
import fs from "node:fs";
import { selectAffectedTests } from "../src/affected-tests.mjs";
import { replayHistory } from "../src/history.mjs";
import {
  auditRepositorySnapshot,
  readRepositorySnapshot,
} from "../src/repository-audit.mjs";
import {
  proposeCheckWorkflow,
  addCheckWorkflow,
} from "../src/check-proposals.mjs";
import { execFileSync } from "node:child_process";
import { main as audit } from "../src/audit.mjs";
import { planRepository, VERSION } from "../src/planner.mjs";
import { initializeRepository } from "../src/setup.mjs";
import { previewFix, openFixPullRequest } from "../src/fix-pr.mjs";
import { renderMarkdown } from "../src/reports.mjs";
import { uniqueJSON } from "../src/json.mjs";
import {
  readJSONFile,
  readDependencySnapshot,
  gitRead,
  commitTree,
} from "../src/evidence.mjs";
import { discoverDependencies } from "../src/dependencies.mjs";
import {
  validateSkipDecisions,
  validationAllowsPlanning,
} from "../src/skip-validation.mjs";
import { advisePerformance } from "../src/performance.mjs";
import { collectSnapshot } from "../src/audit.mjs";
import { attestValidation, verifyReuse } from "../src/reuse.mjs";

const help =
  "CI Planner " +
  VERSION +
  "\n\n" +
  "ci-planner audit --help\n" +
  "ci-planner history --repository OWNER/REPO --contract FILE [--root DIR] [--limit 5] [--fetch]\n" +
  "ci-planner affected --base SHA [--ref HEAD|SHA] [--root DIR] [--runner jest|vitest] [--github-output]\n" +
  "ci-planner audit-repo [--root DIR] [--ref HEAD|SHA] [--add-checks]\n" +
  "ci-planner init [--root DIR] [--action-ref SHA|vX.Y.Z] [--write]\n" +
  "ci-planner fix [--root DIR] [--repository OWNER/REPO --open-pr]\n" +
  "ci-planner report --input report.json\n" +
  "ci-planner validate --input full-run-observation.json [--check]\n" +
  "ci-planner discover [--root DIR] [--ref HEAD|SHA] [--base SHA]\n" +
  "ci-planner advise --input snapshot.json | --repository OWNER/REPO [--workflow ci.yml] [--limit 20]\n" +
  "ci-planner attest --repository OWNER/REPO --tested SHA --run-id ID --environment HASH --signing-key-file FILE --full-run\n" +
  "ci-planner reuse --repository OWNER/REPO --base BEFORE_SHA --target SHA --environment HASH --input receipt.json [--github-output]\n" +
  "ci-planner plan --base SHA --head SHA [--merge SHA] [--root DIR] [--repository OWNER/REPO]\n" +
  "  [--event pull_request] [--workflow .github/workflows/ci.yml] [--enforce] [--force] [--github-output] [--audit-repo] [--validation-input FILE]\n\n" +
  "Result commands accept --format json|markdown and --summary (append a GitHub job summary).\n" +
  "init/fix preview by default. --write creates local setup files; --open-pr explicitly publishes a draft fix PR.\n" +
  "Plans read committed Git objects and the policy from base. Default: shadow (all jobs run).\n" +
  "Enforcement also needs a base policy opt-in and an exact tested merge commit.\n";

import { parseOptions, WORKFLOW } from "../src/validation.mjs";
try {
  const [command, ...rawArgs] = process.argv.slice(2);
  const presentation = {
    format: command === "report" ? "markdown" : "json",
    summary: false,
  };
  const args = [];
  const seen = new Set();
  for (let i = 0; i < rawArgs.length; i++) {
    const key = rawArgs[i];
    if (["--format", "--summary"].includes(key)) {
      if (seen.has(key)) throw Error("Repeated presentation option");
      seen.add(key);
      if (key === "--summary") presentation.summary = true;
      else {
        const format = rawArgs[++i];
        if (!["json", "markdown"].includes(format))
          throw Error("Expected --format json or markdown");
        presentation.format = format;
      }
    } else args.push(key);
  }
  if (presentation.summary && !process.env.GITHUB_STEP_SUMMARY)
    throw Error("--summary requires GITHUB_STEP_SUMMARY");
  const emit = (result) => {
    const markdown =
      presentation.summary || presentation.format === "markdown"
        ? renderMarkdown(result)
        : null;
    if (presentation.summary) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
      } catch {
        process.stderr.write(
          "CI Planner: summary unavailable; structured result remains valid\n",
        );
      }
    }
    process.stdout.write(
      presentation.format === "markdown"
        ? markdown
        : JSON.stringify(result, null, 2) + "\n",
    );
  };
  if (command === "--help" || command === undefined) process.stdout.write(help);
  else if (command === "--version") process.stdout.write(VERSION + "\n");
  else if (command === "history") {
    const opts = parseOptions(
      args,
      ["--root", "--repository", "--contract", "--limit"],
      ["--fetch"],
    );
    emit(
      await replayHistory({
        root: opts["--root"] ?? ".",
        repository: opts["--repository"],
        contract: readJSONFile(opts["--contract"], 256 * 1024),
        limit: opts["--limit"] === undefined ? 5 : Number(opts["--limit"]),
        fetch: opts["--fetch"] === true,
      }),
    );
  } else if (command === "affected") {
    const opts = parseOptions(
      args,
      ["--root", "--base", "--ref", "--runner"],
      ["--github-output"],
    );
    const root = opts["--root"] ?? ".",
      snapshot = readDependencySnapshot({ root, ref: opts["--ref"] ?? "HEAD" });
    commitTree(root, opts["--base"]);
    const changes = gitRead(root, [
      "diff",
      "--no-ext-diff",
      "--ignore-submodules=none",
      "--no-renames",
      "--name-only",
      "-z",
      opts["--base"],
      snapshot.ref,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    const result = selectAffectedTests(snapshot, changes, {
      runner: opts["--runner"] ?? "vitest",
    });
    if (opts["--github-output"]) {
      if (!process.env.GITHUB_OUTPUT)
        throw Error("GitHub output needs GITHUB_OUTPUT");
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        "matrix=" +
          JSON.stringify(result.matrix) +
          "\nrun_all=" +
          result.runAll +
          "\nready=true\n",
      );
    }
    emit(result);
  } else if (command === "validate") {
    const opts = parseOptions(args, ["--input"], ["--check"]);
    const report = validateSkipDecisions(readJSONFile(opts["--input"]));
    emit(report);
    if (opts["--check"] && !report.safe) process.exitCode = 1;
  } else if (command === "discover") {
    const opts = parseOptions(args, ["--root", "--ref", "--base"]);
    const root = opts["--root"] ?? ".",
      snapshot = readDependencySnapshot({ root, ref: opts["--ref"] ?? "HEAD" });
    let changes = [];
    if (opts["--base"]) {
      commitTree(root, opts["--base"]);
      changes = gitRead(root, [
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--name-only",
        "-z",
        opts["--base"],
        snapshot.ref,
        "--",
      ])
        .split("\0")
        .filter(Boolean);
    }
    emit(discoverDependencies(snapshot, changes));
  } else if (command === "advise") {
    const opts = parseOptions(args, [
      "--input",
      "--repository",
      "--workflow",
      "--branch",
      "--limit",
    ]);
    if (opts["--input"] && Object.keys(opts).length !== 1)
      throw Error("Offline advice cannot use live options");
    emit(
      advisePerformance(
        opts["--input"]
          ? readJSONFile(opts["--input"], 32 * 1024 * 1024)
          : await collectSnapshot({
              repository: opts["--repository"],
              workflow: opts["--workflow"],
              branch: opts["--branch"],
              limit:
                opts["--limit"] === undefined ? 20 : Number(opts["--limit"]),
            }),
      ),
    );
  } else if (command === "attest") {
    const opts = parseOptions(
      args,
      [
        "--root",
        "--repository",
        "--tested",
        "--run-id",
        "--environment",
        "--signing-key-file",
      ],
      ["--full-run"],
    );
    emit(
      await attestValidation({
        root: opts["--root"] ?? ".",
        repository: opts["--repository"],
        testedSha: opts["--tested"],
        runId: Number(opts["--run-id"]),
        environmentHash: opts["--environment"],
        keyFile: opts["--signing-key-file"],
        fullRun: opts["--full-run"] === true,
      }),
    );
  } else if (command === "reuse") {
    const opts = parseOptions(
      args,
      [
        "--root",
        "--repository",
        "--base",
        "--target",
        "--environment",
        "--input",
      ],
      ["--github-output"],
    );
    if (
      opts["--github-output"] &&
      (!process.env.GITHUB_OUTPUT ||
        process.env.GITHUB_EVENT_NAME !== "push" ||
        process.env.GITHUB_SHA !== opts["--target"] ||
        process.env.GITHUB_REPOSITORY !== opts["--repository"])
    )
      throw Error(
        "Reuse outputs require the exact current repository push SHA and GITHUB_OUTPUT",
      );
    let receipt = null;
    try {
      receipt = readJSONFile(opts["--input"]);
    } catch {
      /* Missing/bad receipt always runs fresh. */
    }
    let baseSha = opts["--base"];
    if (opts["--github-output"]) {
      let event = null;
      try {
        event = readJSONFile(process.env.GITHUB_EVENT_PATH);
      } catch {
        /* Run fresh without trusted push evidence. */
      }
      if (
        event?.before !== baseSha ||
        event?.after !== opts["--target"] ||
        event?.repository?.full_name !== opts["--repository"] ||
        event.forced !== false ||
        event.deleted !== false
      )
        baseSha = null;
    }
    const result = await verifyReuse({
      root: opts["--root"] ?? ".",
      repository: opts["--repository"],
      targetSha: opts["--target"],
      baseSha,
      environmentHash: opts["--environment"],
      receipt,
    });
    emit(result);
    if (opts["--github-output"])
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        "run=" +
          result.run +
          "\nreusable=" +
          result.reusable +
          "\nready=true\n",
      );
  } else if (command === "audit") {
    const result = await audit(args);
    if (args.length === 1 && args[0] === "--help") process.stdout.write(result);
    else emit(uniqueJSON(result));
  } else if (command === "report") {
    const opts = parseOptions(args, ["--input"]);
    if (!opts["--input"]) throw Error("Expected --input report.json");
    const stat = fs.statSync(opts["--input"]);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw Error("Expected report file up to 4 MiB");
    const input = fs.readFileSync(opts["--input"]);
    if (input.length > 4 * 1024 * 1024) throw Error("Report exceeds 4 MiB");
    let result;
    try {
      result = uniqueJSON(input.toString("utf8"));
    } catch {
      throw Error("Invalid report JSON; object keys must be unique");
    }
    renderMarkdown(result); // Validate even when JSON output was requested.
    emit(result);
  } else if (command === "init") {
    const opts = parseOptions(args, ["--root", "--action-ref"], ["--write"]);
    emit(
      initializeRepository({
        root: opts["--root"] ?? ".",
        actionRef: opts["--action-ref"],
        write: opts["--write"] === true,
      }),
    );
  } else if (command === "fix") {
    const opts = parseOptions(args, ["--root", "--repository"], ["--open-pr"]);
    emit(
      opts["--open-pr"]
        ? await openFixPullRequest({
            root: opts["--root"] ?? ".",
            repository: opts["--repository"],
          })
        : previewFix({ root: opts["--root"] ?? "." }),
    );
  } else if (command === "audit-repo") {
    const opts = parseOptions(args, ["--root", "--ref"], ["--add-checks"]);
    const root = opts["--root"] ?? ".",
      snapshot = readRepositorySnapshot({ root, ref: opts["--ref"] }),
      report = auditRepositorySnapshot(snapshot);
    if (opts["--add-checks"]) {
      const current = execFileSync(
        "git",
        ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
        { cwd: root, encoding: "utf8" },
      ).trim();
      if (current !== snapshot.ref)
        throw Error("Adding checks requires the current HEAD snapshot");
      report.repair = addCheckWorkflow(
        root,
        proposeCheckWorkflow(snapshot, report),
      );
      report.mode = "repository-audit-with-reviewable-patch";
      report.limitations = report.limitations.filter(
        (line) => !line.startsWith("This command edits"),
      );
      report.limitations.push(
        "Only the explicit add-checks option may write one new workflow. It never commits, pushes or starts CI.",
      );
    }
    emit(report);
  } else if (command === "plan") {
    const options = parseOptions(
      args,
      [
        "--base",
        "--head",
        "--merge",
        "--root",
        "--repository",
        "--event",
        "--workflow",
        "--validation-input",
      ],
      ["--enforce", "--force", "--github-output", "--audit-repo"],
    );
    const workflow = options["--workflow"];
    if (workflow && !WORKFLOW.test(workflow))
      throw Error("Expected root workflow path");
    if (options["--github-output"] && (!workflow || !process.env.GITHUB_OUTPUT))
      throw Error("GitHub output needs a workflow path and GITHUB_OUTPUT");
    const planOptions = {
      root: options["--root"],
      repository: options["--repository"],
      baseSha: options["--base"],
      headSha: options["--head"],
      mergeSha: options["--merge"] ?? null,
      event:
        options["--event"] ?? process.env.GITHUB_EVENT_NAME ?? "pull_request",
      enforce: options["--enforce"] === true,
      force: options["--force"] === true,
    };
    let plan = planRepository(planOptions);
    if (options["--validation-input"]) {
      if (!workflow) throw Error("Validation feedback requires --workflow");
      let feedback = null;
      try {
        feedback = readJSONFile(options["--validation-input"]);
      } catch {
        /* Require a full run. */
      }
      // Feedback describes full shadow execution. Compare with that exact plan,
      // not its enforce-mode hash, which intentionally binds different decisions.
      const shadowPlan =
        plan.mode === "shadow"
          ? plan
          : planRepository({ ...planOptions, enforce: false });
      if (
        !validationAllowsPlanning(
          feedback,
          shadowPlan.policyHash,
          workflow,
          shadowPlan.planHash,
          shadowPlan.identity.repository,
        )
      ) {
        plan = planRepository({ ...planOptions, validationFallback: true });
      }
    }
    const jobs = Object.values(plan.jobs).filter(
      (job) => !workflow || job.workflow === workflow,
    );
    if (workflow && !jobs.length)
      throw Error("Requested workflow is absent from the tested commit");
    if (options["--audit-repo"]) {
      try {
        plan.repositoryAudit = auditRepositorySnapshot(
          readRepositorySnapshot({
            root: options["--root"] ?? ".",
            ref: options["--merge"] ?? options["--head"],
          }),
        );
      } catch {
        plan.auditWarning =
          "Repository audit unavailable; plan decisions are unchanged.";
      }
    }
    emit(plan);
    if (options["--github-output"]) {
      const run = Object.fromEntries(jobs.map((job) => [job.id, job.run]));
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        "run=" +
          JSON.stringify(run) +
          "\nplan_hash=" +
          plan.planHash +
          "\nmode=" +
          plan.mode +
          "\nready=true\n",
      );
    }
  } else throw Error("Unknown command; use --help");
} catch (error) {
  process.stderr.write("CI Planner: " + error.message + "\n");
  process.exitCode = 1;
}
