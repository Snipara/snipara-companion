const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  generateClaudeHookConfig,
  generateClaudeSessionScript,
  generateClaudeStuckGuardScript,
} = require("../dist/index.js");

const hasJq = spawnSync("jq", ["--version"]).status === 0;

test("new Claude installs get the quiet pre-tool hook and a failure event hook", () => {
  assert.match(generateClaudeStuckGuardScript(), /pre-tool .*--stuck-guard-only/);
  const config = generateClaudeHookConfig({ preserveOnCompaction: true, restoreOnSessionStart: true });
  assert.deepEqual(config.hooks.PostToolUseFailure, config.hooks.PostToolUse);
  for (const script of [generateClaudeStuckGuardScript(), generateClaudeSessionScript()]) {
    const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
});

test("the session hook forwards a failed tool call as failure evidence with the host session id", { skip: !hasJq }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-hook-template-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "args.txt");
  fs.writeFileSync(
    path.join(bin, "snipara-companion"),
    `#!/bin/sh\nprintf '%s\\n' "$SNIPARA_SESSION_ID" > "${log}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho hint\n`,
    { mode: 0o755 }
  );
  const script = path.join(dir, "snipara-session.sh");
  fs.writeFileSync(script, generateClaudeSessionScript(), { mode: 0o755 });
  const run = (input) =>
    spawnSync("bash", [script], {
      cwd: dir,
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: dir, TOOL_INPUT: "" },
    });

  const failed = run({ session_id: "claude-session-7", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "pnpm build" }, error: "Exit code 2\nboom" });
  assert.equal(failed.status, 0, failed.stderr);
  const logged = fs.readFileSync(log, "utf8").split("\n");
  assert.equal(logged[0], "claude-session-7");
  assert.ok(logged.includes("--status") && logged.includes("failed"));
  const result = logged[logged.indexOf("--result") + 1];
  assert.equal(JSON.parse(result).is_error, true);
  assert.equal(JSON.parse(failed.stdout).hookSpecificOutput.hookEventName, "PostToolUseFailure");

  const ok = run({ session_id: "claude-session-7", tool_name: "Read", tool_input: { file_path: "/a" }, tool_response: { content: "x" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(!fs.readFileSync(log, "utf8").includes("failed"));
});
