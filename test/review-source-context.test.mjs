import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseDocument } from "yaml";
import { fixture } from "./helpers.mjs";
const { hasContextRead } = createRequire(import.meta.url)(
  "../.github/scripts/claude-review-context.cjs",
);
const workflow = parseDocument(
  fs.readFileSync(
    new URL("../.github/workflows/claude-pr-review.yml", import.meta.url),
    "utf8",
  ),
).toJS();
const steps = workflow.jobs.review.steps;
const step = steps.find((s) => s.id === "source_context");
const script = /^node <<'NODE'\n([\s\S]*)\nNODE\s*$/.exec(step.run)[1];
const hash = (value) => createHash("sha256").update(value).digest("hex");
function context(f, head) {
  const temp = path.join(f.root, "task");
  fs.mkdirSync(temp);
  const original = path.join(temp, "original.json"),
    output = path.join(temp, "output");
  fs.writeFileSync(original, JSON.stringify({ schemaVersion: 1, head }) + "\n");
  return {
    temp,
    original,
    output,
    env: {
      ...process.env,
      BASE_SHA: f.sha,
      HEAD_SHA: head,
      ORIGINAL_CONTEXT: original,
      ORIGINAL_CONTEXT_SHA256: hash(fs.readFileSync(original)),
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temp,
    },
  };
}
const run = (f, c, env = {}) =>
  execFileSync(process.execPath, ["-e", script], {
    cwd: f.root,
    env: { ...c.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
test("verified review source uses immutable Git blobs, preserves deleted/pointer data and binds complete packet reads", (t) => {
  const f = fixture(t, { "a.txt": "before", "deleted.txt": "old source" });
  const name = "literal$(touch SHOULD_NOT_EXIST).js";
  f.write("a.txt", "committed\n\u2028separator");
  f.write(name, "export const x=1;");
  f.write("picture.png", Buffer.from([137, 80, 78, 71, 0, 1]));
  fs.unlinkSync(path.join(f.root, "deleted.txt"));
  fs.symlinkSync("../unavailable-private-target", path.join(f.root, "link"));
  const head = f.commit(),
    c = context(f, head);
  f.write("a.txt", "dirty input must be ignored");
  run(f, c);
  assert(!fs.existsSync(path.join(f.root, "SHOULD_NOT_EXIST")));
  const file = path.join(c.temp, "claude-review-source-context.json"),
    content = fs.readFileSync(file, "utf8"),
    packet = JSON.parse(content),
    sources = packet.immutable_sources;
  assert.equal(
    sources.find((s) => s.path === "a.txt").source.chunks.join(""),
    "committed\n\u2028separator",
  );
  assert.equal(sources.find((s) => s.path === "deleted.txt").revision, f.sha);
  assert.equal(
    sources.find((s) => s.path === "deleted.txt").source.chunks.join(""),
    "old source",
  );
  assert.equal(sources.find((s) => s.path === "link").kind, "symlink");
  assert.equal(
    sources.find((s) => s.path === "link").source.chunks.join(""),
    "../unavailable-private-target",
  );
  assert.equal(
    sources.find((s) => s.path === "picture.png").requires_file_read,
    true,
  );
  assert.equal(
    packet.source_packet_parent_sha256,
    c.env.ORIGINAL_CONTEXT_SHA256,
  );
  assert(fs.readFileSync(c.output, "utf8").includes("sha256=" + hash(content)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const receipt = (text) => [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read",
            name: "Read",
            input: { file_path: file },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read",
            content: text
              .trimEnd()
              .split("\n")
              .map((line, i) => `${i + 1}→${line}`)
              .join("\n"),
          },
        ],
      },
    },
  ];
  assert(hasContextRead(receipt(content), file, content));
  assert(
    !hasContextRead(
      receipt(fs.readFileSync(c.original, "utf8")),
      file,
      content,
    ),
  );
  assert.throws(
    () => run(f, c, { HEAD_SHA: "f".repeat(40) }),
    /Review source identity mismatch/,
  );
  assert.throws(
    () => run(f, c, { ORIGINAL_CONTEXT_SHA256: "0".repeat(64) }),
    /Original review packet changed/,
  );
  assert(
    steps
      .find((s) => s.id === "claude")
      .with.prompt.includes("steps.source_context.outputs.sha256"),
  );
  assert.equal(
    steps.find(
      (s) => s.name === "Verify Claude posted a completed review of this head",
    ).env.CONTEXT_FILE,
    "${{ steps.source_context.outputs.file }}",
  );
});
test("oversized source fails before a replacement packet or readiness receipt is written", (t) => {
  const f = fixture(t, { "a.txt": "before" });
  f.write("large.txt", "x".repeat(1024 * 1024 + 1));
  const head = f.commit(),
    c = context(f, head);
  assert.throws(() => run(f, c), /Review source byte budget exceeded/);
  assert(!fs.existsSync(c.output));
  assert(
    !fs.existsSync(path.join(c.temp, "claude-review-source-context.json")),
  );
});
