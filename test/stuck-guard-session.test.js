/**
 * Stuck Guard evidence tests on a recorded-style long productive session.
 *
 * The hook entry points are `pre-tool --stuck-guard-only` (never prints a pack)
 * and `post-tool` (prints a pack only after three identical failed results).
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  advanceStuckEvidence,
  buildToolResultPayload,
  toolActionKey,
  updateLocalStuckGuard,
} = require("../dist/index.js");

const cli = path.resolve(__dirname, "../dist/index.js");
const RISK_WORDS = ["database", "schema", "migration", "auth", "prod", "deploy", "release", "secret"];

function resultEvent(session, tool, input, { result = "ok", exitCode, status } = {}) {
  const toolInput = typeof input === "string" ? input : JSON.stringify(input);
  return {
    type: "tool_result",
    session_id: session,
    payload: buildToolResultPayload({ tool, toolInput, result, exitCode, status }),
  };
}

/** Deterministic stand-in for a recorded 3-hour working session: only successes, plus isolated failures that get fixed. */
function productiveSession(session) {
  const events = [];
  const add = (...args) => events.push(resultEvent(session, ...args));
  for (let i = 0; i < 90; i++) {
    const word = RISK_WORDS[i % RISK_WORDS.length];
    add("Read", { file_path: `/repo/src/${word}/module-${i}.ts` });
    add("Grep", { pattern: `${word}_${i}`, path: "src" }, { result: JSON.stringify({ numFiles: 3, numMatches: 7 }) });
    add("Bash", { command: `git diff --stat src/${word}/module-${i}.ts`, description: "diff" });
    add("Edit", { file_path: `/repo/src/${word}/module-${i}.ts`, old_string: "a", new_string: "b" });
    add("Bash", { command: `pnpm --filter cli test -- ${word} --shard ${i}`, description: `run ${word} tests` }, { result: JSON.stringify({ exit_code: 0 }) });
    // The plan is rewritten again and again with the same text; plan tools never count.
    add("update_plan", { plan: [{ step: "implement", status: "in_progress" }] });
    add("TodoWrite", { todos: [{ content: "ship", status: "pending" }] });
    if (i % 15 === 0) add("Task", { description: `explore ${word}`, subagent_type: "Explore", prompt: `look at ${word} prod deploy` });
    if (i % 30 === 7) add("Read", { file_path: "/repo/AGENTS.md" }); // same successful read, repeated
    if (i % 20 === 5) {
      // Isolated failure, then the fix, then success of the same command.
      const command = `pnpm --filter cli test -- ${word} migration --bail`;
      add("Bash", { command }, { result: JSON.stringify({ exit_code: 1, stderr: "1 failing" }) });
      add("Edit", { file_path: `/repo/src/${word}/module-${i}.ts`, old_string: "b", new_string: "c" });
      add("Bash", { command }, { result: JSON.stringify({ exit_code: 0 }) });
    }
    if (i % 25 === 11) {
      // A search that finds nothing twice before the query is corrected.
      add("Grep", { pattern: `Missing${i}`, path: "src" }, { result: JSON.stringify({ numFiles: 0, numMatches: 0 }) });
      add("Grep", { pattern: `Missing${i}`, path: "src" }, { result: JSON.stringify({ numFiles: 0, numMatches: 0 }) });
      add("Grep", { pattern: `Found${i}`, path: "src" }, { result: JSON.stringify({ numFiles: 2, numMatches: 2 }) });
    }
  }
  return events;
}

function inTempProject(t, body) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-stuck-session-"));
  const original = process.cwd();
  process.chdir(cwd);
  t.after(() => {
    process.chdir(original);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return body(cwd);
}

test("a long productive session with risky words and isolated fixed failures yields zero packs", (t) =>
  inTempProject(t, () => {
    const events = productiveSession("session-productive");
    assert.ok(events.length >= 600, `fixture must be a long session, got ${events.length}`);
    assert.ok(events.filter((e) => e.payload.result_classification === "failure").length >= 4);
    assert.ok(events.filter((e) => e.payload.result_classification === "empty_result").length >= 6);
    const start = Date.parse("2026-11-11T08:00:00Z");
    const packs = events.map((event, index) => updateLocalStuckGuard(event, start + index * 15_000)).filter(Boolean);
    assert.deepEqual(packs, []);
  }));

test("three identical failing commands within two minutes give exactly one short pack, then silence until a new cause", (t) =>
  inTempProject(t, () => {
    const session = "session-stuck";
    const failing = (command) => resultEvent(session, "Bash", { command, description: "again" }, { result: JSON.stringify({ exit_code: 2, stderr: "boom" }) });
    const ok = (n) => resultEvent(session, "Read", { file_path: `/repo/file-${n}.ts` });
    const packs = [];
    let at = Date.parse("2026-11-11T09:00:00Z");
    const feed = (event, gap = 20_000) => {
      at += gap;
      const pack = updateLocalStuckGuard(event, at);
      if (pack) packs.push(pack);
    };
    feed(failing("pnpm build"));
    feed(ok(1));
    feed(failing("pnpm build")); // unrelated successes do not hide or reset the loop
    assert.equal(packs.length, 0);
    feed(failing("pnpm build"));
    assert.equal(packs.length, 1);
    const lines = packs[0].split("\n");
    assert.ok(lines.length <= 4, packs[0]);
    assert.ok(Buffer.byteLength(packs[0]) < 400);
    assert.equal(lines[0], "SNIPARA_RESCUE_PACK");
    assert.doesNotMatch(packs[0], /pnpm|database|recall|context_query/i, "no command text or retrieval instructions");

    // Same cause keeps failing: silent. Successes: silent.
    for (let i = 0; i < 6; i++) feed(failing("pnpm build"));
    feed(ok(2));
    assert.equal(packs.length, 1);

    // New cause: another command failing three times.
    feed(failing("pnpm lint"));
    feed(failing("pnpm lint"));
    assert.equal(packs.length, 1);
    feed(failing("pnpm lint"));
    assert.equal(packs.length, 2);

    // The first command was fixed, then breaks again later: a fresh cause.
    feed(resultEvent(session, "Bash", { command: "pnpm build" }, { result: JSON.stringify({ exit_code: 0 }) }));
    feed(failing("pnpm build"));
    feed(failing("pnpm build"));
    assert.equal(packs.length, 2);
    feed(failing("pnpm build"));
    assert.equal(packs.length, 3);
  }));

test("failures spread over more than two minutes, or by different inputs, never trigger", (t) =>
  inTempProject(t, () => {
    const session = "session-spread";
    let at = Date.parse("2026-11-11T10:00:00Z");
    const packs = [];
    const feed = (event, gap) => {
      at += gap;
      const pack = updateLocalStuckGuard(event, at);
      if (pack) packs.push(pack);
    };
    const failing = (command) => resultEvent(session, "Bash", { command }, { exitCode: 1 });
    for (let i = 0; i < 8; i++) feed(failing("make slow"), 70_000);
    assert.equal(packs.length, 0);
    for (let i = 0; i < 12; i++) feed(failing(`make target-${i}`), 5_000);
    assert.equal(packs.length, 0);
  }));

test("empty searches repeat to a pack, but empty reads, plan updates and writes do not", (t) =>
  inTempProject(t, () => {
    const session = "session-search";
    let at = Date.parse("2026-11-11T11:00:00Z");
    const packs = [];
    const feed = (event) => {
      at += 10_000;
      const pack = updateLocalStuckGuard(event, at);
      if (pack) packs.push(pack);
    };
    for (let i = 0; i < 6; i++) feed(resultEvent(session, "Read", { file_path: "/repo/empty.txt" }, { result: "" }));
    for (let i = 0; i < 6; i++) feed(resultEvent(session, "update_plan", { plan: [] }, { result: "" }));
    for (let i = 0; i < 6; i++) feed(resultEvent(session, "Write", { file_path: "/repo/x" }, { result: "" }));
    assert.deepEqual(packs, []);
    for (let i = 0; i < 3; i++) feed(resultEvent(session, "Grep", { pattern: "NoSuchThing" }, { result: JSON.stringify({ numFiles: 0, numMatches: 0 }) }));
    assert.equal(packs.length, 1);
  }));

test("evidence is per session and a default session never persists or triggers", (t) =>
  inTempProject(t, () => {
    const event = (session) => resultEvent(session, "Bash", { command: "false" }, { exitCode: 1 });
    const at = Date.parse("2026-11-11T12:00:00Z");
    assert.equal(updateLocalStuckGuard(event("one"), at), null);
    assert.equal(updateLocalStuckGuard(event("two"), at + 1000), null);
    assert.equal(updateLocalStuckGuard(event("one"), at + 2000), null);
    assert.equal(updateLocalStuckGuard(event("two"), at + 3000), null);
    for (let i = 0; i < 5; i++) assert.equal(updateLocalStuckGuard(event("default"), at + 4000 + i), null);
    assert.match(updateLocalStuckGuard(event("one"), at + 5000), /SNIPARA_RESCUE_PACK/);
  }));

test("a stale writer lock is replaced and a malformed state file cannot trigger", (t) =>
  inTempProject(t, (cwd) => {
    const { createHash } = require("node:crypto");
    const session = "session-lock";
    const base = path.join(cwd, ".snipara/stuck-guard", createHash("sha256").update(session).digest("hex") + ".json");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, '{"entries":[{"action":"x","kind":"failure","tool":"Bash","hits":[1,2,3,4,5],"lastAt":1}]}');
    fs.writeFileSync(`${base}.lock`, "dead");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${base}.lock`, old, old);
    const event = resultEvent(session, "Bash", { command: "false" }, { exitCode: 1 });
    const now = Date.now();
    assert.equal(updateLocalStuckGuard(event, now), null);
    assert.equal(fs.existsSync(`${base}.lock`), false);
    assert.equal(updateLocalStuckGuard(event, now + 1000), null);
    assert.match(updateLocalStuckGuard(event, now + 2000), /SNIPARA_RESCUE_PACK/);
  }));

test("advanceStuckEvidence is pure and ignores call events and keywords", () => {
  const call = { type: "tool_call", session_id: "s", payload: { tool: "Bash", query: RISK_WORDS.join(" ") } };
  for (let i = 0; i < 10; i++) assert.deepEqual(advanceStuckEvidence(undefined, call, i), { evidence: undefined, pack: null });
  assert.equal(toolActionKey("Bash", '{"command":"x","description":"a"}'), toolActionKey("Bash", '{"description":"b","command":"x"}'));
  assert.notEqual(toolActionKey("Bash", '{"command":"x"}'), toolActionKey("Bash", '{"command":"y"}'));
});

test("installed hook entry points: pre-tool --stuck-guard-only never prints or calls the server; post-tool prints one pack", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    // A hosted keyword/repetition policy would answer like this; the local hooks must never ask.
    res.end(JSON.stringify({ decision: { action: "inject", enabled: true, rescuePack: { injectionText: "SNIPARA_RESCUE_PACK v1 hosted keyword pack" } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-stuck-cli-"));
  t.after(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const env = {
    HOME: home,
    SNIPARA_API_KEY: "snp-test",
    SNIPARA_PROJECT_ID: "project_1",
    SNIPARA_API_URL: `http://127.0.0.1:${server.address().port}`,
    SNIPARA_SESSION_ID: "hook-session-1",
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
  };
  const run = (args, input) => runCliIn(home, args, env, input);

  // Keywords and repetition: six identical, risky-word calls.
  for (let i = 0; i < 6; i++) {
    const out = await run(
      ["pre-tool", JSON.stringify({ command: "psql prod database schema migration auth deploy" }), "--tool", "Bash", "--stuck-guard-only", "--query", "database schema migration auth prod deploy"],
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "", "pre-tool --stuck-guard-only must print nothing");
  }
  assert.deepEqual(requests, [], "pre-tool --stuck-guard-only must not call the hosted detector");

  // Three identical failed results through the PostToolUse entry point.
  const outputs = [];
  for (let i = 0; i < 5; i++) {
    const out = await run(["post-tool", JSON.stringify({ command: "pnpm build" }), "--tool", "Bash", "--result", JSON.stringify({ exit_code: 1 }), "--exit-code", "1"]);
    assert.equal(out.status, 0, out.stderr);
    outputs.push(out.stdout);
  }
  assert.equal(outputs.filter((value) => value.includes("SNIPARA_RESCUE_PACK")).length, 1, JSON.stringify(outputs));
  assert.match(outputs[2], /SNIPARA_RESCUE_PACK/);
  assert.ok(outputs.every((value) => !value.includes("hosted keyword pack")));
});

function runCliIn(cwd, args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
