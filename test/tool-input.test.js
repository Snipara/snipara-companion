const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  buildCommitResultMetadata,
  hasActiveManagedWorkflow,
  readStandaloneCommitEvidence,
  buildCanonicalEvent,
  resolveQueryFromToolInput,
  extractFilesFromToolInput,
  buildToolResultPayload,
  classifyToolResult,
  extractCommandFromToolInput,
  getStuckGuardInjection,
} = require("../dist/index.js");

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("resolveQueryFromToolInput builds query from file path", () => {
  const query = resolveQueryFromToolInput(JSON.stringify({ file_path: "/src/auth.ts" }), "Read");

  assert.equal(query, "Read /src/auth.ts");
});

test("resolveQueryFromToolInput includes pattern and path", () => {
  const query = resolveQueryFromToolInput(JSON.stringify({ pattern: "user", path: "src" }), "Grep");

  assert.equal(query, "Grep user src");
});

test("resolveQueryFromToolInput parses Claude hook stdin payloads", () => {
  const query = resolveQueryFromToolInput(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/src/claude.ts" } })
  );

  assert.equal(query, "Read /src/claude.ts");
});

test("extractFilesFromToolInput parses single file", () => {
  const files = extractFilesFromToolInput(JSON.stringify({ file_path: "/src/api/auth.ts" }));

  assert.deepEqual(files, ["/src/api/auth.ts"]);
});

test("extractFilesFromToolInput parses file list", () => {
  const files = extractFilesFromToolInput(JSON.stringify({ files: ["a.ts", "b.ts"] }));

  assert.deepEqual(files, ["a.ts", "b.ts"]);
});

test("extractFilesFromToolInput parses nested Claude tool_input fields", () => {
  const files = extractFilesFromToolInput(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/src/api/claude.ts" } })
  );

  assert.deepEqual(files, ["/src/api/claude.ts"]);
});

test("extractCommandFromToolInput prefers executable command fields", () => {
  const command = extractCommandFromToolInput(
    JSON.stringify({ command: "pnpm db:push", description: "deploy" })
  );

  assert.equal(command, "pnpm db:push");
});

test("extractCommandFromToolInput parses nested Claude Bash payloads", () => {
  const command = extractCommandFromToolInput(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } })
  );

  assert.equal(command, "pnpm test");
});

test("classifyToolResult distinguishes failures and empty search output", () => {
  assert.equal(classifyToolResult({ tool: "Bash", command: "pnpm test", exitCode: 1 }), "failure");
  assert.equal(
    classifyToolResult({ tool: "Grep", command: "rg missing", exitCode: 1, result: "" }),
    "empty_result"
  );
});

test("buildToolResultPayload redacts and truncates result previews", () => {
  const payload = buildToolResultPayload({
    tool: "Bash",
    toolInput: JSON.stringify({ command: "curl api" }),
    result: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    exitCode: 1,
  });

  assert.equal(payload.result_classification, "failure");
  assert.equal(payload.command, "curl api");
  assert.match(payload.result_preview, /\[REDACTED\]/);
});

test("buildToolResultPayload and canonical events never retain raw command secrets", () => {
  const privateDiscordValue = "discord-value-that-must-never-leave-the-process";
  const payload = buildToolResultPayload({
    tool: "Bash",
    toolInput: JSON.stringify({
      command: `DISCORD_TOKEN=${privateDiscordValue} token=private-value pnpm test`,
    }),
    result: "ok",
    exitCode: 0,
  });
  const event = buildCanonicalEvent({ eventType: "tool_result", payload });
  const serialized = JSON.stringify(event);

  assert.equal(serialized.includes(privateDiscordValue), false);
  assert.equal(serialized.includes("private-value"), false);
  assert.equal(payload.command, "DISCORD_TOKEN=[REDACTED] token=[REDACTED] pnpm test");
});

test("buildCommitResultMetadata emits only full SHAs for actual commit-like results", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-commit-result-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "agent@example.com"]);
  runGit(repo, ["config", "user.name", "Agent"]);

  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  const initialSha = runGit(repo, ["rev-parse", "HEAD"]);
  const initialMetadata = buildCommitResultMetadata({
    tool: "Bash",
    toolInput: JSON.stringify({ command: 'git commit -m "initial"' }),
    result: `[branch ${initialSha.slice(0, 7)}] initial`,
    exitCode: 0,
    cwd: repo,
  });
  assert.deepEqual(initialMetadata, { commitSha: initialSha });
  assert.deepEqual(Object.keys(initialMetadata), ["commitSha"]);

  const initialEvidence = readStandaloneCommitEvidence(repo, initialSha);
  assert.equal(initialEvidence.commitSha, initialSha);
  assert.equal(initialEvidence.summary, "initial");
  assert.deepEqual(initialEvidence.files, ["tracked.txt"]);

  fs.appendFileSync(path.join(repo, "tracked.txt"), "amended\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "--amend", "-m", "amended"]);
  const amendedSha = runGit(repo, ["rev-parse", "HEAD"]);
  const amendedMetadata = buildCommitResultMetadata({
    tool: "Bash",
    toolInput: JSON.stringify({ command: 'git commit --amend -m "token=private-value"' }),
    result: `[branch ${amendedSha.slice(0, 7)}] amended`,
    status: "success",
    cwd: repo,
  });
  assert.deepEqual(amendedMetadata, { commitSha: amendedSha });
  assert.equal(JSON.stringify(amendedMetadata).includes("private-value"), false);

  const primaryBranch = runGit(repo, ["branch", "--show-current"]);
  runGit(repo, ["checkout", "-b", "topic"]);
  fs.writeFileSync(path.join(repo, "topic.txt"), "topic\n", "utf8");
  runGit(repo, ["add", "topic.txt"]);
  runGit(repo, ["commit", "-m", "topic"]);
  const topicSha = runGit(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["checkout", primaryBranch]);
  runGit(repo, ["cherry-pick", topicSha]);
  const cherryPickedSha = runGit(repo, ["rev-parse", "HEAD"]);
  assert.deepEqual(
    buildCommitResultMetadata({
      tool: "Bash",
      toolInput: JSON.stringify({ command: `git cherry-pick ${topicSha}` }),
      result: `[${primaryBranch} ${cherryPickedSha.slice(0, 7)}] topic`,
      exitCode: 0,
      cwd: repo,
    }),
    { commitSha: cherryPickedSha }
  );

  runGit(repo, ["revert", "--no-edit", cherryPickedSha]);
  const revertSha = runGit(repo, ["rev-parse", "HEAD"]);
  assert.deepEqual(
    buildCommitResultMetadata({
      tool: "Bash",
      toolInput: JSON.stringify({ command: `git revert --no-edit ${cherryPickedSha}` }),
      result: `[${primaryBranch} ${revertSha.slice(0, 7)}] Revert topic`,
      exitCode: 0,
      cwd: repo,
    }),
    { commitSha: revertSha }
  );
});

test("standalone commit evidence skips managed workflow state", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-standalone-rationale-"));
  const workflowDir = path.join(repo, ".snipara", "workflow");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, "current.json"), '{"status":"active"}\n', "utf8");
  assert.equal(hasActiveManagedWorkflow(repo), true);

  fs.writeFileSync(path.join(workflowDir, "current.json"), '{"status":"completed"}\n', "utf8");
  assert.equal(hasActiveManagedWorkflow(repo), false);
});

test("buildCommitResultMetadata rejects mentions, failures, no-ops, and reflog mismatches", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-commit-result-negative-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "agent@example.com"]);
  runGit(repo, ["config", "user.name", "Agent"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n", "utf8");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  const initialSha = runGit(repo, ["rev-parse", "HEAD"]);

  const base = {
    tool: "Bash",
    result: "command completed",
    exitCode: 0,
    cwd: repo,
  };
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "echo git commit -m fake" }),
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({
        command: "git commit --quiet -m masked || git rev-parse --short HEAD",
      }),
      result: initialSha.slice(0, 12),
    }),
    {}
  );
  const maskedNoop = spawnSync("sh", ["-c", "git commit -m masked >/dev/null 2>&1 || true"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(maskedNoop.status, 0, maskedNoop.stderr);
  assert.equal(maskedNoop.stdout, "");
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git commit -m masked || true" }),
      result: maskedNoop.stdout,
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git commit --quiet -m silent" }),
      result: "",
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git status" }),
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git revert HEAD" }),
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git commit -m failed" }),
      exitCode: 1,
    }),
    {}
  );
  assert.deepEqual(
    buildCommitResultMetadata({
      ...base,
      toolInput: JSON.stringify({ command: "git commit -m noop" }),
      result: "nothing to commit, working tree clean",
    }),
    {}
  );
});

test("getStuckGuardInjection returns only inject or enforce rescue text", () => {
  assert.equal(
    getStuckGuardInjection({
      enabled: true,
      triggered: true,
      configuredMode: "inject",
      action: "inject",
      score: 80,
      reasons: [],
      riskKeywords: [],
      memoryCheckedRecently: false,
      cooldownActive: false,
      eventCount: 4,
      evaluatedAt: "2026-05-12T10:00:00.000Z",
      rescuePack: {
        marker: "SNIPARA_RESCUE_PACK v1",
        title: "Rescue",
        instructions: [],
        recall: {
          tool: "snipara_recall",
          arguments: {
            query: "db decisions",
            scope: "project",
            limit: 5,
            min_relevance: 0.2,
          },
        },
        contextQuery: {
          tool: "snipara_context_query",
          arguments: {
            query: "db runbook",
            max_tokens: 1200,
            search_mode: "keyword",
            return_references: true,
            auto_decompose: false,
            include_all_tiers: false,
          },
        },
        injectionText: "SNIPARA_RESCUE_PACK v1\nCheck memory.",
      },
    }),
    "SNIPARA_RESCUE_PACK v1\nCheck memory."
  );
});

test("recorded productive and failing result sequences do not cause repeated rescue packs", () => {
  const { advanceStuckEvidence, toolActionKey } = require("../dist/index.js");
  let evidence, packs = [];
  const record = (tool, input, classification, at) => {
    const next = advanceStuckEvidence(evidence, { type: "tool_result", payload: {
      tool, action_key: toolActionKey(tool, input), result_classification: classification,
    } }, at);
    evidence = next.evidence;
    if (next.pack) packs.push(next.pack);
  };
  for (let i = 0; i < 200; i++) record(i % 2 ? "Read" : "PlanUpdate", `auth schema prod ${i}`, "success", i);
  assert.equal(packs.length, 0);
  for (let i = 0; i < 8; i++) record("Bash", '{"command":"false"}', "failure", 1000 + i);
  assert.equal(packs.length, 1);
  record("Bash", '{"command":"false"}', "success", 1010);
  record("Bash", '{"command":"false"}', "failure", 1011);
  assert.equal(packs.length, 1);
  for (let i = 0; i < 3; i++) record("PlanUpdate", "same", "empty_result", 2000 + i);
  assert.equal(packs.length, 1);
  for (let i = 0; i < 3; i++) record("Search", "missing", "empty_result", 3000 + i);
  assert.equal(packs.length, 2);
  assert.equal(toolActionKey("Bash", '{"a":1,"b":2}'), toolActionKey("Bash", '{"b":2,"a":1}'));
});

test("hook Git environment keeps linked worktree and alternate index relative to hook cwd", () => {
  const { hookGitEnvironment } = require("../dist/index.js");
  const env = hookGitEnvironment("/repo/packages/cli", {
    SNIPARA_WORKSPACE_DIR: "/repo", GIT_DIR: ".git", GIT_INDEX_FILE: "alternate-index",
  });
  assert.equal(env.GIT_DIR, "/repo/.git");
  assert.equal(env.GIT_INDEX_FILE, "/repo/alternate-index");
});

test("staged paths exclude unrelated unstaged files and preserve spaces", t => {
  const { readStagedPaths } = require("../dist/index.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-hook-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  runGit(cwd, ["init"]);
  fs.writeFileSync(path.join(cwd, "staged doc.md"), "staged");
  fs.writeFileSync(path.join(cwd, "unrelated.ts"), "unstaged");
  runGit(cwd, ["add", "staged doc.md"]);
  assert.deepEqual(readStagedPaths(cwd), ["staged doc.md"]);
});

test("workflow receipts do not echo accumulated state", () => {
  const { buildWorkflowReceipt } = require("../dist/index.js");
  const state = { workflowId: "one", status: "active", phases: [
    { id: "first", status: "completed", payload: "x".repeat(150000) },
    { id: "next", status: "pending" },
  ] };
  const receipt = buildWorkflowReceipt(state, "phase-commit", "details.json", "first");
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 2000);
  assert.equal(receipt.nextPhaseId, "next");
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.detailPath, "details.json");
});

test("plan identity is read from top-level fields", t => {
  const { readWorkflowPlanIdentity } = require("../dist/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-plan-id-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "unrelated-name.json");
  fs.writeFileSync(file, JSON.stringify({ id: "real-id", goal: "Real goal", phases: [] }));
  assert.deepEqual(readWorkflowPlanIdentity(file), { id: "real-id", goal: "Real goal" });
  assert.deepEqual(readWorkflowPlanIdentity(), {});
});

test("memory list pagination is bounded before any network call", () => {
  const { memoryListPage } = require("../dist/index.js");
  assert.deepEqual(memoryListPage({}), { limit: 20, offset: 0 });
  assert.deepEqual(memoryListPage({ limit: 50, offset: 100 }), { limit: 50, offset: 100 });
  for (const limit of [0, -1, 51, NaN, 1.5]) assert.throws(() => memoryListPage({ limit }));
  assert.throws(() => memoryListPage({ offset: -1 }));
});

test("default context agent prefers code aliases and has a deterministic fallback", () => {
  const { defaultContextAgent } = require("../dist/index.js");
  const old = process.env.SNIPARA_AGENT_ID;
  delete process.env.SNIPARA_AGENT_ID;
  try {
    assert.equal(defaultContextAgent({ agents: { security: {}, code: {} } }), "code");
    assert.equal(defaultContextAgent({ agents: { z: {}, a: {} } }), "a");
  } finally {
    if (old === undefined) delete process.env.SNIPARA_AGENT_ID;
    else process.env.SNIPARA_AGENT_ID = old;
  }
});

test("new hook bundles are quiet for Claude, Codex and Cursor, idempotently", () => {
  const { quietCompanionHook } = require("../dist/index.js");
  for (const client of ["Claude", "Codex", "Cursor"]) {
    const script = `#!/bin/bash\n# ${client}\nsnipara-companion pre-tool "$INPUT" --tool Read\n`;
    const quiet = quietCompanionHook(script);
    assert.match(quiet, /pre-tool --stuck-guard-only/);
    assert.equal(quietCompanionHook(quiet), quiet);
  }
});

test("search classification excludes reads and detects explicit structured failures", () => {
  assert.equal(classifyToolResult({ tool: "Read", result: "" }), "success");
  assert.equal(classifyToolResult({ tool: "PlanUpdate", result: "" }), "success");
  assert.equal(classifyToolResult({ tool: "Bash", command: "rg missing .", exitCode: 1 }), "empty_result");
  assert.equal(classifyToolResult({ tool: "Search", result: "[]" }), "empty_result");
  assert.equal(classifyToolResult({ tool: "Bash", result: '{"exit_code":2,"stderr":"failed"}' }), "failure");
});


test("linked worktree hook reads only its alternate staged index after pnpm changes cwd", t => {
  const { readStagedPaths } = require("../dist/index.js");
  // Real path: on macOS the temporary directory is a symlink, which breaks the relative GIT_DIR below.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snipara-linked-hook-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main"), linked = path.join(root, "linked");
  fs.mkdirSync(main);
  runGit(main, ["init"]);
  runGit(main, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "--no-verify", "-m", "base"]);
  runGit(main, ["worktree", "add", "-b", "fixture", linked]);
  fs.mkdirSync(path.join(linked, "packages/cli"), { recursive: true });
  fs.writeFileSync(path.join(linked, "selected doc.md"), "selected");
  fs.writeFileSync(path.join(linked, "wrong-index.ts"), "other");
  fs.writeFileSync(path.join(linked, "unstaged.ts"), "unstaged");
  runGit(linked, ["add", "wrong-index.ts"]);
  const env = { ...process.env, SNIPARA_WORKSPACE_DIR: linked,
    GIT_DIR: path.relative(linked, runGit(linked, ["rev-parse", "--absolute-git-dir"])),
    GIT_WORK_TREE: ".", GIT_INDEX_FILE: "alternate-index" };
  const add = spawnSync("git", ["add", "selected doc.md"], {
    cwd: linked, env: { ...env, GIT_INDEX_FILE: path.join(linked, "alternate-index") }, encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  assert.deepEqual(readStagedPaths(path.join(linked, "packages/cli"), env), ["selected doc.md"]);
  assert.throws(() => readStagedPaths(linked, { ...env, GIT_DIR: "missing-git" }), /Cannot read staged files/);
});

test("stuck evidence expires and distinguishes different failed inputs", () => {
  const { advanceStuckEvidence, toolActionKey } = require("../dist/index.js");
  const event = input => ({ type: "tool_result", payload: { tool: "Bash",
    action_key: toolActionKey("Bash", input), result_classification: "failure" } });
  let state = advanceStuckEvidence(undefined, event("false"), 0).evidence;
  state = advanceStuckEvidence(state, event("false"), 120001).evidence;
  assert.deepEqual(state.entries.map(entry => entry.hits.length), [1]);
  state = advanceStuckEvidence(state, event("other failure"), 120002).evidence;
  assert.deepEqual(state.entries.map(entry => entry.hits.length), [1, 1]);
  assert.notEqual(toolActionKey("Bash", "echo A"), toolActionKey("Bash", "echo a"));
  assert.equal(classifyToolResult({ tool: "Grep", result: '{"numFiles":0,"content":""}' }), "empty_result");
});


test("persistent stuck evidence emits once and skips a concurrent writer", t => {
  const { createHash } = require("node:crypto");
  const { updateLocalStuckGuard, toolActionKey } = require("../dist/index.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-stuck-local-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const event = { type: "tool_result", session_id: "fixture-session", payload: {
      tool: "Bash", action_key: toolActionKey("Bash", "false"), result_classification: "failure",
    } };
    assert.equal(updateLocalStuckGuard(event), null);
    assert.equal(updateLocalStuckGuard(event), null);
    assert.match(updateLocalStuckGuard(event), /SNIPARA_RESCUE_PACK/);
    assert.equal(updateLocalStuckGuard(event), null);
    const lock = path.join(cwd, ".snipara/stuck-guard", createHash("sha256").update(event.session_id).digest("hex") + ".json.lock");
    fs.writeFileSync(lock, "busy");
    assert.equal(updateLocalStuckGuard(event), null);
  } finally { process.chdir(original); }
});

test("search result arrays count as empty only when no populated list or count contradicts them", () => {
  assert.equal(classifyToolResult({ tool: "Search", result: '{"results":[]}' }), "empty_result");
  assert.equal(classifyToolResult({ tool: "Grep", result: '{"numFiles":0,"numMatches":2}' }), "success");
  assert.equal(classifyToolResult({ tool: "Search", result: '{"results":["hit"]}' }), "success");
  assert.equal(classifyToolResult({ tool: "Search", result: '{"total_count":0,"results":["hit"]}' }), "success");
});
