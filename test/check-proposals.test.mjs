import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { execFileSync } from "node:child_process";
import { auditRepositorySnapshot } from "../src/repository-audit.mjs";
import {
  proposeCheckWorkflow,
  addCheckWorkflow,
} from "../src/check-proposals.mjs";
const snapshot = (
  scripts = { test: "vitest run", lint: "eslint src", build: "vite build" },
) => ({
  ref: "a".repeat(40),
  files: {
    "package.json": JSON.stringify({
      scripts,
      dependencies: { vitest: "1", eslint: "1" },
    }),
    "package-lock.json": null,
    "src/main.ts": null,
    "tsconfig.json": null,
    "test/main.test.ts": null,
  },
});
test("proposes verifiable missing checks in one unprivileged job and preserves build placement", () => {
  const s = snapshot(),
    p = proposeCheckWorkflow(s);
  const doc = parseDocument(p.content).toJS();
  assert.equal(doc.on, "pull_request");
  assert.deepEqual(doc.permissions, { contents: "read" });
  assert.equal(Object.keys(doc.jobs).length, 1);
  assert(p.addedCheckIds.includes("package.json#tests"));
  assert(p.addedCheckIds.includes("package.json#lint"));
  assert(!p.addedCheckIds.includes("package.json#build"));
  assert(p.notAdded.some((c) => c.id === "package.json#build"));
  const follow = auditRepositorySnapshot({
    ...s,
    files: { ...s.files, [p.path]: p.content },
  });
  assert.equal(
    follow.checks.find((c) => c.check === "tests").status,
    "covered",
  );
  assert.equal(
    follow.checks.find((c) => c.check === "dependency-audit").status,
    "covered",
  );
});
test("does not wire fake, dynamic or native build scripts as automated tests", () => {
  for (const script of [
    'echo \"vitest run\"',
    "vitest run && eas build",
    "npm run nested",
    "vitest $ARGS",
  ]) {
    const p = proposeCheckWorkflow(snapshot({ test: script }));
    assert(!p.addedCheckIds.includes("package.json#tests"), script);
  }
});
test("does not add duplicate checks when blocking CI coverage already exists", () => {
  const s = snapshot();
  const p = proposeCheckWorkflow(s);
  const next = proposeCheckWorkflow({
    ...s,
    files: { ...s.files, [p.path]: p.content },
  });
  assert(!next.addedCheckIds.includes("package.json#tests"));
});
test("add-checks is additive, refuses existing files and leaves existing CI intact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-proposal-"));
  try {
    const proposal = proposeCheckWorkflow(snapshot());
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".github/workflows/original.yml"),
      "original",
    );
    const result = addCheckWorkflow(root, proposal);
    assert.equal(result.written, true);
    assert.equal(
      fs.readFileSync(
        path.join(root, ".github/workflows/original.yml"),
        "utf8",
      ),
      "original",
    );
    assert.throws(() => addCheckWorkflow(root, proposal), /EEXIST/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("refuses symlinked workflow parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-symlink-"));
  try {
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(root, ".github"));
    assert.throws(
      () => addCheckWorkflow(root, proposeCheckWorkflow(snapshot())),
      /symlink/,
    );
    assert.deepEqual(fs.readdirSync(path.join(root, "outside")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI adds a reviewable workflow at current HEAD and refuses overwrites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-cli-"));
  const git = (args) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Check fixture"]);
    git(["config", "user.email", "test@example.invalid"]);
    for (const [name, text] of Object.entries(snapshot().files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text ?? "");
    }
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const cli = new URL("../bin/ci-planner.mjs", import.meta.url).pathname;
    const out = execFileSync(
      process.execPath,
      [cli, "audit-repo", "--root", root, "--add-checks"],
      { encoding: "utf8" },
    );
    const report = JSON.parse(out);
    assert(report.repair.written);
    assert(fs.existsSync(path.join(root, report.repair.path)));
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [cli, "audit-repo", "--root", root, "--add-checks"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
