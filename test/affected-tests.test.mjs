import test from "node:test";
import assert from "node:assert/strict";
import { selectAffectedTests } from "../src/affected-tests.mjs";
import { suggestJobInputs } from "../src/input-scopes.mjs";
import { discoverWorkflows } from "../src/planner.mjs";
const ref = "a".repeat(40);
const files = () => ({
  "package.json":
    '{"type":"module","scripts":{"check":"node scripts/check.js"}}',
  "src/shared.js": "export const n=1;",
  "src/a.js": "import {n} from './shared.js';export const a=n;",
  "src/b.js": "export const b=2;",
  "test/a.test.js":
    "import {a} from '../src/a.js';test('a',()=>expect(a).toBe(1));",
  "test/b.test.js":
    "import {b} from '../src/b.js';test('b',()=>expect(b).toBe(2));",
  "scripts/check.js": "import {a} from '../src/a.js';",
});
test("both runners select reverse transitive tests and keep independent tests out", () => {
  for (const runner of ["jest", "vitest"]) {
    const r = selectAffectedTests({ ref, files: files() }, ["src/shared.js"], {
      runner,
    });
    assert.equal(r.runAll, false);
    assert.deepEqual(r.tests, ["test/a.test.js"]);
    assert.equal(r.inputsComplete, false);
    assert.deepEqual(r.matrix.include, [
      {
        schemaVersion: 1,
        mode: "affected-tests-advisory",
        runner,
        runAll: false,
        tests: ["test/a.test.js"],
      },
    ]);
    assert.deepEqual(
      selectAffectedTests({ ref, files: files() }, ["test/b.test.js"], {
        runner,
      }).tests,
      ["test/b.test.js"],
    );
  }
});
test("aliases, dynamic imports, runtime files, globals, configuration, missing/deleted inputs always run all", () => {
  const cases = [
    { "src/a.js": "import x from '@/shared.js';" },
    { "src/a.js": "const x=import('./shared.js');" },
    { "src/a.js": "import * as fs from 'node:fs';" },
    { "src/a.js": "const env=process.env.X;" },
    { "src/a.js": "const name=globalThis['process'];" },
    { "jest.config.js": "export default {};" },
    { "vitest.config.js": "export default {};" },
    { "vitest.workspace.js": "export default [];" },
    { "jest.preset.js": "export default {};" },
    { "jest-preset.json": "{}" },
    { ".mocharc.json": "{}" },
    { "test/setup.js": "" },
    { "src/a.js": null },
    { "src/a.ts": "export const a:number=1" },
    { "src/a.js": "const r = require('./shared.js');" },
    { "src/a.js": "import {vi} from 'vitest'; vi.mock('./shared.js');" },
    {
      "src/a.js": "import {n} from '../vendor/bridge.js';",
      "vendor/bridge.js": "export {n} from '../src/shared.js';",
    },
  ];
  for (const extra of cases)
    assert.equal(
      selectAffectedTests({ ref, files: { ...files(), ...extra } }, [
        "src/shared.js",
      ]).runAll,
      true,
      JSON.stringify(extra),
    );
  for (const changed of ["deleted.js", "package.json", "unknown.json"])
    assert.equal(
      selectAffectedTests({ ref, files: files() }, [changed]).runAll,
      true,
    );
});
test("parser handles comments, re-exports and multiline imports without guessing config code", () => {
  const f = files();
  f["src/a.js"] =
    "/* import x from 'fake' */ export {n as a} from './shared.js';";
  assert.deepEqual(
    selectAffectedTests({ ref, files: f }, ["src/shared.js"]).tests,
    ["test/a.test.js"],
  );
  f["src/a.js"] =
    "import /* comment */ {n} from './shared.js'; export const a=n;";
  assert.equal(
    selectAffectedTests({ ref, files: f }, ["src/shared.js"]).runAll,
    false,
  );
});
test("per-job setup follows actual script and imports, unrelated opaque commands retain inventory fallback", () => {
  const f = files(),
    workflow = ".github/workflows/ci.yml";
  f[workflow] =
    "on: pull_request\njobs:\n  check:\n    steps:\n      - run: npm run check\n  opaque:\n    steps:\n      - run: bash unknown.sh\n";
  const scopes = suggestJobInputs(
    { ref, files: f },
    discoverWorkflows({ [workflow]: f[workflow] }),
    ["**"],
  );
  assert.deepEqual(scopes[workflow + "#check"].inputs, [
    workflow,
    "package.json",
    "scripts/check.js",
    "src/a.js",
    "src/shared.js",
  ]);
  assert.equal(scopes[workflow + "#check"].inputsComplete, false);
  assert.deepEqual(scopes[workflow + "#opaque"].inputs, ["**"]);
});

test("default Jest test.js/spec.js files are included without widening Vitest's default test names", () => {
  const f = files();
  f["test.js"] = "import {n} from './src/shared.js';";
  f["spec.js"] = "import {n} from './src/shared.js';";
  assert.deepEqual(
    selectAffectedTests({ ref, files: f }, ["src/shared.js"], {
      runner: "jest",
    }).tests,
    ["spec.js", "test.js", "test/a.test.js"],
  );
  assert.deepEqual(
    selectAffectedTests({ ref, files: f }, ["src/shared.js"], {
      runner: "vitest",
    }).tests,
    ["test/a.test.js"],
  );
});
