/** Consumer-owned runner. A missing/invalid selector always runs the entire suite. */
import { spawnSync } from "node:child_process";
const runner = process.env.TEST_RUNNER ?? "vitest";
if (!["jest", "vitest"].includes(runner))
  throw Error("Expected jest or vitest");
let selection;
try {
  selection = JSON.parse(process.env.CI_PLANNER_SELECTION);
  if (
    selection?.schemaVersion !== 1 ||
    selection.mode !== "affected-tests-advisory" ||
    selection.runner !== runner ||
    typeof selection.runAll !== "boolean" ||
    !Array.isArray(selection.tests) ||
    selection.tests.length > 20000 ||
    selection.tests.some(
      (n) =>
        typeof n !== "string" ||
        !n ||
        n.startsWith("/") ||
        n.split("/").includes("..") ||
        /[\\\x00-\x1f]/.test(n),
    )
  )
    throw Error();
} catch {
  selection = { runAll: true, tests: [] };
}
if (!selection.runAll && selection.tests.length === 0) {
  console.log(
    "No tests import the changed static sources; selection completed successfully.",
  );
} else {
  const args = runner === "vitest" ? ["run"] : [];
  if (process.env.TEST_JSON_OUTPUT)
    args.push(
      ...(runner === "vitest"
        ? ["--reporter=json", "--outputFile=" + process.env.TEST_JSON_OUTPUT]
        : ["--json", "--outputFile=" + process.env.TEST_JSON_OUTPUT]),
    );
  if (!selection.runAll)
    args.push(
      ...(runner === "jest" ? ["--runTestsByPath"] : []),
      ...selection.tests.map((n) => "./" + n),
    );
  const result = spawnSync("node_modules/.bin/" + runner, args, {
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}
