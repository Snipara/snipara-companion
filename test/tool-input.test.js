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
