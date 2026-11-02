/** Offline Git fixtures shared by setup, publishing and presentation tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const cli = new URL("../bin/ci-planner.mjs", import.meta.url).pathname;
export const baseFiles = () => ({
  "package.json": JSON.stringify({
    scripts: { test: "vitest run", lint: "eslint src" },
    devDependencies: { vitest: "1", eslint: "1" },
  }),
  "package-lock.json": "{}",
  "src/main.js": "export const answer = 42;\n",
  "test/main.test.js": "// fixture; analysis must not execute this file\n",
});

export function fixture(t, files = baseFiles()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-v03-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const write = (name, content) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Offline fixture");
  git("config", "user.email", "fixture@example.invalid");
  Object.entries(files).forEach(([name, text]) => write(name, text));
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const sha = commit();
  return { root, git, write, commit, sha };
}

/** Hosted tests still exercise local-only publishing with a fake transport. */
export function localContext(t) {
  const names = ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME"];
  const original = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  names.forEach((name) => delete process.env[name]);
  t.after(() =>
    names.forEach((name) => {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }),
  );
}
