const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../dist/index.js");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-dogfood-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" })
  );
  return cwd;
}
function run(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: cwd,
      SNIPARA_WORKSPACE_DIR: cwd,
      SNIPARA_LOCAL_ONLY: "1",
      SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
      ...extra,
    },
  });
}
function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function start(cwd, overrides = []) {
  fs.writeFileSync(
    path.join(cwd, "plan.json"),
    JSON.stringify({
      id: "plan-id",
      goal: "Plan goal",
      mode: "standard",
      steps: [
        { id: "edit", title: "Edit", query: "Read the relevant files" },
        { id: "verify", title: "Verify", query: "Check the result" },
      ],
    })
  );
  return run(cwd, [
    "workflow",
    "start",
    "--plan-file",
    "plan.json",
    "--skip-agent-context",
    "--json",
    ...overrides,
  ]);
}

test("start uses plan identity, explicit overrides win, and default JSON is a compact receipt", (t) => {
  const cwd = fixture(t);
  const initial = start(cwd);
  const receipt = json(initial);
  assert.equal(receipt.workflowId, "plan-id");
  assert.ok(Buffer.byteLength(initial.stdout) < 2000);
  assert.equal(receipt.nextPhaseId, "edit");
  const detail = JSON.parse(fs.readFileSync(path.join(cwd, receipt.detailPath)));
  assert.equal(detail.goal, "Plan goal");
  assert.equal(detail.phases.length, 2);
  const explicit = json(
    start(cwd, ["--force", "--id", "override", "--goal", "Explicit goal", "--detail"])
  );
  assert.equal(explicit.workflowId, "override");
  assert.equal(explicit.goal, "Explicit goal");
});

test("phase receipts save large detail and resume remains available without hosted configuration", (t) => {
  const cwd = fixture(t);
  json(start(cwd));
  const stateFile = path.join(cwd, ".snipara/workflow/current.json");
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.phases[1].summary = "old context ".repeat(16000);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const opened = run(cwd, ["workflow", "phase-start", "edit", "--json"]);
  const receipt = json(opened);
  assert.ok(Buffer.byteLength(opened.stdout) < 2000);
  assert.ok(fs.statSync(path.join(cwd, receipt.detailPath)).size > 79000);
  const resumed = json(run(cwd, ["workflow", "resume", "--json", "--detail"]));
  assert.equal(resumed.workflow.workflowId, "plan-id");
  assert.match(resumed.session_bootstrap_error, /not configured/);
  const committed = run(cwd, ["workflow", "phase-commit", "edit", "--summary", "Done", "--json"]);
  const commit = json(committed);
  assert.ok(Buffer.byteLength(committed.stdout) < 2000);
  assert.equal(commit.nextPhaseId, "verify");
  assert.equal(commit.status, "completed");
  const full = JSON.parse(fs.readFileSync(path.join(cwd, commit.detailPath)));
  assert.equal(full.workflow.phases[0].summary, "Done");
});

test("default text receipts stay under 2 KB and name the saved detail file", (t) => {
  const cwd = fixture(t);
  const started = start(cwd, []).stdout; // JSON receipt from the helper
  assert.ok(Buffer.byteLength(started) < 2000);
  const stateFile = path.join(cwd, ".snipara/workflow/current.json");
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.phases[1].summary = "accumulated ".repeat(20000);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  for (const args of [
    ["phase-start", "edit"],
    ["phase-commit", "edit", "--summary", "Done"],
  ]) {
    const result = run(cwd, ["workflow", ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      Buffer.byteLength(result.stdout) < 2000,
      `${args[0]}: ${Buffer.byteLength(result.stdout)} bytes`
    );
    assert.match(
      result.stdout,
      new RegExp(`Details: \\.snipara/workflow/detail-${args[0]}\\.json`)
    );
    assert.ok(
      fs.statSync(path.join(cwd, `.snipara/workflow/detail-${args[0]}.json`)).size > 100000
    );
  }
  // --detail restores the full result on stdout.
  const full = run(cwd, ["workflow", "phase-start", "verify", "--json", "--detail"]);
  assert.ok(JSON.parse(full.stdout).workflow.phases.length === 2);
});

test("an oversized activity timeline is trimmed by the next command instead of warning on every one", (t) => {
  const cwd = fixture(t);
  const activity = path.join(cwd, ".snipara/activity");
  fs.mkdirSync(activity, { recursive: true });
  // Sparse file past the read bound without allocating a transcript fixture.
  const fd = fs.openSync(path.join(activity, "timeline.jsonl"), "w");
  fs.ftruncateSync(fd, 256 * 1024 * 1024);
  fs.closeSync(fd);
  const result = start(cwd);
  assert.equal(json(result).workflowId, "plan-id");
  assert.ok(Buffer.byteLength(result.stdout) < 2000);
  assert.doesNotMatch(result.stderr, /oversized/i);
  assert.ok(fs.statSync(path.join(activity, "timeline.jsonl")).size <= 4 * 1024 * 1024);
});

function fullWorkflow(cwd) {
  json(start(cwd));
  const file = path.join(cwd, ".snipara/workflow/current.json");
  const state = JSON.parse(fs.readFileSync(file));
  state.coordination.mode = "full";
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}
function writeCodexUsage(home, thread, usage) {
  const sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessions, "usage.jsonl"),
    [
      { type: "session_meta", payload: { id: thread, timestamp, source: "cli" } },
      { type: "response_item", timestamp, payload: { role: "user" } },
      { type: "token_usage_record", payload: { thread_id: thread, response_id: "r1", usage } },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n"
  );
}

test("FULL phase commit stops before completing a phase when measured efficiency is exceeded", (t) => {
  const cwd = fixture(t);
  const file = fullWorkflow(cwd);
  writeCodexUsage(cwd, "heavy-thread", {
    input_tokens: 2500000,
    cached_input_tokens: 400000,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: 2500010,
  });
  const result = run(cwd, ["workflow", "phase-commit", "edit", "--summary", "Done", "--json"], {
    CODEX_THREAD_ID: "heavy-thread",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Workflow efficiency stopped: maxUncachedInputTokens exceeded/);
  assert.equal(result.stderr.trim().split("\n").length, 1, "one-line reason");
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(fs.readFileSync(file)).phases[0].status, "pending");
});

test("FULL phase commit records a long-session checkpoint; the next phase-start is the stop", (t) => {
  const cwd = fixture(t);
  fullWorkflow(cwd);
  // A long host session: every response re-reads its cached context, the workflow itself is small.
  writeCodexUsage(cwd, "long-thread", {
    input_tokens: 2500000,
    cached_input_tokens: 2499000,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: 2500010,
  });
  const thread = { CODEX_THREAD_ID: "long-thread" };
  const result = run(
    cwd,
    ["workflow", "phase-commit", "edit", "--summary", "Done", "--json"],
    thread
  );
  assert.equal(json(result).status, "completed");
  assert.match(
    result.stderr,
    /Workflow efficiency stop condition: maxInputTokens exceeded; input=2500000 \(cached=2499000\), responses=1\./
  );
  assert.match(result.stderr, /continue in a fresh thread/);
  // The same thread may not open the next phase on its own.
  const next = ["workflow", "phase-start", "verify", "--no-brief", "--json"];
  const refused = run(cwd, next, thread);
  assert.notEqual(refused.status, 0);
  assert.match(
    refused.stderr,
    /Workflow efficiency stopped: maxInputTokens exceeded; input=2500000/
  );
  assert.match(refused.stderr, /--accept-efficiency-excess/);
  assert.equal(refused.stdout, "");
  // A fresh thread has no such usage and goes on; so does this one once the user accepted.
  assert.equal(run(cwd, next, { CODEX_THREAD_ID: "fresh-thread" }).status, 0);
  const accepted = run(cwd, [...next, "--accept-efficiency-excess"], thread);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stderr, /Workflow efficiency excess accepted for this phase/);
});

test("the deferred efficiency stop also covers task-start and a partial measurement", (t) => {
  const cwd = fixture(t);
  fullWorkflow(cwd);
  writeCodexUsage(cwd, "long-thread", {
    input_tokens: 2500000,
    cached_input_tokens: 2499000,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: 2500010,
  });
  const thread = { CODEX_THREAD_ID: "long-thread" };
  json(run(cwd, ["workflow", "phase-commit", "edit", "--summary", "Done", "--json"], thread));
  // A truncated trailing record makes coverage partial; what was counted is still over the limit.
  fs.appendFileSync(path.join(cwd, ".codex", "sessions", "usage.jsonl"), '{"type":"token_');
  const report = json(run(cwd, ["workflow", "efficiency", "--profile", "full", "--json"], thread));
  assert.equal(report.coverage.status, "partial");
  const stopped = /Workflow efficiency stopped: maxInputTokens exceeded; input=2500000/;
  const phase = run(cwd, ["workflow", "phase-start", "verify", "--no-brief", "--json"], thread);
  assert.notEqual(phase.status, 0);
  assert.match(phase.stderr, stopped);
  // task-start opens the phase too: same stop, same override.
  const task = ["workflow", "task-start", "verify", "--skip-agent-context", "--json"];
  const refused = run(cwd, task, thread);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, stopped);
  const accepted = run(cwd, [...task, "--accept-efficiency-excess"], thread);
  assert.match(accepted.stderr, /Workflow efficiency excess accepted for this phase/);
  assert.doesNotMatch(accepted.stderr, stopped);
});

test("FULL phase commit proceeds with a warning when no usage records can be measured", (t) => {
  const cwd = fixture(t);
  fullWorkflow(cwd);
  const result = run(cwd, ["workflow", "phase-commit", "edit", "--summary", "Done", "--json"], {
    CODEX_THREAD_ID: "missing",
  });
  assert.equal(json(result).status, "completed");
  assert.match(result.stderr, /Workflow efficiency not enforced: usage coverage is/);
});

test("strict staged docs-only memory guard passes without guidance or historical failures", (t) => {
  const cwd = fixture(t);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init"]);
  fs.mkdirSync(path.join(cwd, "docs"));
  fs.writeFileSync(path.join(cwd, "docs/note.md"), "Documentation only");
  fs.writeFileSync(path.join(cwd, "unrelated.ts"), "unstaged");
  git(["add", "docs/note.md"]);
  const result = json(
    run(cwd, ["memory-guard", "check", "--trigger", "pre-commit", "--staged", "--strict", "--json"])
  );
  assert.equal(result.shouldBlock, false);
  assert.equal(result.triggered, false);
  assert.deepEqual(result.files, ["docs/note.md"]);
  assert.deepEqual(result.releaseSurfaces, []);
});

test(
  "pre-commit names every failing step on stderr even with shell errexit",
  {
    skip: fs.existsSync(path.resolve(__dirname, "../../../.husky/pre-commit"))
      ? false
      : "requires monorepo .husky/pre-commit (absent in standalone export)",
  },
  (t) => {
    const cwd = fixture(t),
      bin = path.join(cwd, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "pnpm"),
      `#!/bin/sh
case "$*" in
  *memory-guard*) step=memory-guard ;;
  lint-staged) step=lint-staged ;;
  lint) step=lint ;;
  type-check) step=type-check ;;
esac
[ "$step" != "$SNIPARA_TEST_FAIL" ] || exit 17
exit 0
`,
      { mode: 0o755 }
    );
    const hook = path.resolve(__dirname, "../../../.husky/pre-commit");
    for (const step of ["memory-guard", "lint-staged", "lint", "type-check"]) {
      const result = spawnSync("sh", ["-e", hook], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SNIPARA_COLLABORATION_GUARD: "0",
          SNIPARA_TEST_FAIL: step,
        },
      });
      assert.equal(result.status, 17, result.stderr);
      assert.match(result.stderr, new RegExp(`pre-commit failed: ${step} \\(exit 17\\)`));
    }
  }
);
