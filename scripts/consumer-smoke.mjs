/** Execute a real Vitest single-package consumer, then its mandatory run-all fallbacks. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { selectAffectedTests } from "../src/affected-tests.mjs";
const root = new URL("../examples/affected-tests-consumer/", import.meta.url);
const files = Object.fromEntries(
  fs
    .readdirSync(root, { recursive: true })
    .filter((n) => !n.startsWith("node_modules/") && /\.(?:js|json)$/.test(n))
    .map((n) => [n, fs.readFileSync(new URL(n, root), "utf8")]),
);
const snapshot = { ref: "a".repeat(40), files },
  selected = selectAffectedTests(snapshot, ["src/add.js"]);
assert.equal(selected.runAll, false);
assert.deepEqual(selected.tests, ["test/add.test.js"]);
const task = fs.mkdtempSync(path.join(os.tmpdir(), "affected-consumer-"));
try {
  for (const [label, selection, count] of [
    ["selected", JSON.stringify(selected), 1],
    [
      "global-input",
      JSON.stringify(selectAffectedTests(snapshot, ["package.json"])),
      2,
    ],
    ["invalid-selector", "bad JSON", 2],
  ]) {
    const output = path.join(task, label + ".json");
    execFileSync(
      process.execPath,
      [new URL("../examples/run-affected-tests.mjs", import.meta.url).pathname],
      {
        cwd: root,
        env: {
          ...process.env,
          CI_PLANNER_SELECTION: selection,
          TEST_JSON_OUTPUT: output,
        },
        stdio: "inherit",
      },
    );
    const report = JSON.parse(fs.readFileSync(output));
    assert.equal(report.numTotalTests, count);
    assert.equal(report.numPassedTests, count);
  }
  // Vitest's defaults include vendor tests even though the static graph excludes vendor sources.
  const isolated = path.join(task, "vendor-consumer");
  const vendorTest = "vendor/extra.test.js";
  const expanded = { ...files, [vendorTest]: files["test/add.test.js"] };
  for (const [name, content] of Object.entries(expanded)) {
    fs.mkdirSync(path.dirname(path.join(isolated, name)), { recursive: true });
    fs.writeFileSync(path.join(isolated, name), content);
  }
  fs.symlinkSync(new URL("node_modules", root), path.join(isolated, "node_modules"), "dir");
  const fallback = selectAffectedTests({ ...snapshot, files: expanded }, ["src/add.js"]);
  assert.equal(fallback.runAll, true);
  const output = path.join(task, "vendor-fallback.json");
  execFileSync(process.execPath, [new URL("../examples/run-affected-tests.mjs", import.meta.url).pathname], {
    cwd: isolated,
    env: { ...process.env, CI_PLANNER_SELECTION: JSON.stringify(fallback), TEST_JSON_OUTPUT: output },
    stdio: "inherit",
  });
  const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.numTotalTests, 3);
  assert.equal(report.numPassedTests, 3);
} finally {
  fs.rmSync(task, { recursive: true, force: true });
}
console.log(
  "Actual Vitest consumer: 1 selected test; both full-suite fallbacks passed 2 tests; vendor fallback passed 3 tests.",
);
