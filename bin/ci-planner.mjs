#!/usr/bin/env node
/** CLI boundary: validate arguments, print JSON, and export run booleans only after a valid plan. */
import fs from "node:fs";
import { main as audit } from "../src/audit.mjs";
import { planRepository, VERSION } from "../src/planner.mjs";

const help =
  "CI Planner " +
  VERSION +
  "\n\n" +
  "ci-planner audit --help\n" +
  "ci-planner plan --base SHA --head SHA [--merge SHA] [--root DIR] [--repository OWNER/REPO]\n" +
  "  [--event pull_request] [--workflow .github/workflows/ci.yml] [--enforce] [--force] [--github-output]\n\n" +
  "Plans read committed Git objects and the policy from base. Default: shadow (all jobs run).\n" +
  "Enforcement also needs a base policy opt-in and an exact tested merge commit.\n";
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === undefined) process.stdout.write(help);
  else if (command === "--version") process.stdout.write(VERSION + "\n");
  else if (command === "audit") process.stdout.write(await audit(args));
  else if (command === "plan") {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (
        ![
          "--base",
          "--head",
          "--merge",
          "--root",
          "--repository",
          "--event",
          "--workflow",
          "--enforce",
          "--force",
          "--github-output",
        ].includes(key) ||
        Object.hasOwn(options, key)
      )
        throw Error("Unknown or repeated argument");
      if (["--enforce", "--force", "--github-output"].includes(key))
        options[key] = true;
      else {
        const value = args[++i];
        if (!value || value.startsWith("--"))
          throw Error("Missing argument value");
        options[key] = value;
      }
    }
    const workflow = options["--workflow"];
    if (
      workflow &&
      !/^\.github\/workflows\/[^/\x00-\x1f]+\.ya?ml$/.test(workflow)
    )
      throw Error("Expected root workflow path");
    if (options["--github-output"] && (!workflow || !process.env.GITHUB_OUTPUT))
      throw Error("GitHub output needs a workflow path and GITHUB_OUTPUT");
    const plan = planRepository({
      root: options["--root"],
      repository: options["--repository"],
      baseSha: options["--base"],
      headSha: options["--head"],
      mergeSha: options["--merge"] ?? null,
      event:
        options["--event"] ?? process.env.GITHUB_EVENT_NAME ?? "pull_request",
      enforce: options["--enforce"] === true,
      force: options["--force"] === true,
    });
    const jobs = Object.values(plan.jobs).filter(
      (job) => !workflow || job.workflow === workflow,
    );
    if (workflow && !jobs.length)
      throw Error("Requested workflow is absent from the tested commit");
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
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  } else throw Error("Unknown command; use --help");
} catch (error) {
  process.stderr.write("CI Planner: " + error.message + "\n");
  process.exitCode = 1;
}
