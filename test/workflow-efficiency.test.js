const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { measureWorkflowEfficiency, renderWorkflowEfficiency, workflowEfficiencyCommand } = require("../dist/index.js");

const since = "2026-01-01T00:00:00Z";
const before = "2025-12-31T23:00:00Z";
const after = "2026-01-01T00:01:00Z";
function meta(id, parent, time = before) {
  return { type: "session_meta", payload: { id, timestamp: time,
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: "PRIVATE_PATH" } } } : "cli" } };
}
function usage(id, overrides = {}) {
  return { type: "token_usage_record", payload: { response_id: id,
    usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5,
      output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120, ...overrides },
    thread_token_usage: { input_tokens: 99999999, output_tokens: 99999999 } } };
}
const timed = (time = after) => ({ type: "response_item", timestamp: time, payload: { role: "user", content: "PRIVATE_TRANSCRIPT_SECRET" } });
async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "snipara-efficiency-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const sessionsDir = path.join(cwd, "sessions");
  await fs.mkdir(sessionsDir);
  return { cwd, sessionsDir, rootThreadId: "root", since, maxElapsedMinutes: Number.MAX_SAFE_INTEGER };
}
async function log(options, name, records, tail = "") {
  const file = path.join(options.sessionsDir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const threadId = records.find(record => record && record.type === "session_meta")?.payload.id;
  await fs.writeFile(file, records.map(record => typeof record === "string" ? record : JSON.stringify(
    record.type === "token_usage_record" ? { ...record, payload: { thread_id: threadId, ...record.payload } } : record
  )).join("\n") + "\n" + tail);
  return file;
}

test("unique response accounting includes descendants across directories and keeps subsets correct", async t => {
  const options = await fixture(t);
  await log(options, "2025/root.jsonl", [meta("root"), timed(before), usage("old"), timed(), usage("r1"), usage("r1")]);
  await log(options, "2026/child.jsonl", [meta("child", "root"), timed(), usage("r1"), usage("r2")]);
  await log(options, "nested/deep/grandchild.jsonl", [meta("grandchild", "child"), timed(), usage("r3")]);
  await log(options, "unrelated.jsonl", [meta("unrelated"), timed(), usage("other", { input_tokens: 999900, total_tokens: 999920 }), "BAD_PRIVATE_UNRELATED_BODY"]);
  const result = await workflowEfficiencyCommand({ ...options, enforce: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.coverage.status, "complete");
  assert.equal(result.report.scope.sessions, 3);
  assert.equal(result.report.totals.responses, 3);
  assert.equal(result.report.totals.inputTokens, 300);
  assert.equal(result.report.totals.cachedInputTokens, 120);
  assert.equal(result.report.totals.uncachedInputTokens, 180);
  assert.equal(result.report.totals.outputTokens, 60);
  assert.equal(result.report.totals.reasoningOutputTokens, 30);
  assert.equal(result.report.coverage.duplicateResponses, 2);
  for (const rendered of [renderWorkflowEfficiency(result.report), renderWorkflowEfficiency(result.report, true)]) {
    assert.doesNotMatch(rendered, /PRIVATE|unrelated|r1|root\.jsonl|99999999/);
    assert.match(rendered, /external provider/i);
  }
});

test("conflicting duplicates, malformed records and live partial tail remain explicit gaps", async t => {
  const options = await fixture(t);
  await log(options, "root.jsonl", [meta("root"), timed(), usage("same"), usage("same", { cached_input_tokens: 41 }), "{malformed PRIVATE"], '{"type":"token_');
  const result = await workflowEfficiencyCommand({ ...options, enforce: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.coverage.conflictingResponses, 1);
  assert.equal(result.report.coverage.gaps.malformed_record, 1);
  assert.equal(result.report.coverage.gaps.trailing_partial_record, 1);
  assert.equal(result.report.totals.responses, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|same|malformed PRIVATE/);
});

test("event-only and absent logs are unavailable, never zero-usage approval", async t => {
  const options = await fixture(t);
  const missing = await workflowEfficiencyCommand({ ...options, sessionsDir: path.join(options.cwd, "missing"), enforce: true });
  assert.equal(missing.report.coverage.status, "unavailable");
  assert.equal(missing.exitCode, 1);
  await log(options, "root.jsonl", [meta("root"), { type: "event_msg", timestamp: after, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } } }]);
  const events = await workflowEfficiencyCommand({ ...options, enforce: true });
  assert.equal(events.report.status, "unavailable");
  assert.equal(events.report.coverage.gaps.authoritative_usage_unavailable, 1);
  assert.equal(events.exitCode, 1);
  assert.equal((await workflowEfficiencyCommand(options)).exitCode, 0);
});

test("thresholds warn by default and enforce fails only this check", async t => {
  const options = await fixture(t);
  await log(options, "root.jsonl", [meta("root"), timed(), usage("r")]);
  const warning = await workflowEfficiencyCommand({ ...options, maxResponses: 0, maxElapsedMinutes: 0 });
  assert.equal(warning.report.status, "limits_exceeded");
  assert.equal(warning.exitCode, 0);
  assert.deepEqual(warning.report.exceeded, ["maxResponses", "maxElapsedMinutes"]);
  const enforced = await workflowEfficiencyCommand({ ...options, maxUncachedInputTokens: 59, enforce: true });
  assert.equal(enforced.exitCode, 1);
  assert.deepEqual(enforced.report.exceeded, ["maxUncachedInputTokens"]);
  assert.equal(enforced.report.mode, "enforce-check");
  assert.match(enforced.report.caveats.join(" "), /does not stop Codex/);
  const exact = await workflowEfficiencyCommand({ ...options, maxUncachedInputTokens: 60, maxOutputTokens: 20, enforce: true });
  assert.equal(exact.exitCode, 0);
});

test("workflow timestamp or root metadata supplies an explicitly labelled boundary", async t => {
  const options = await fixture(t);
  delete options.since;
  await log(options, "root.jsonl", [meta("root"), timed(before), usage("old"), timed(), usage("new")]);
  const fromRoot = await measureWorkflowEfficiency(options);
  assert.equal(fromRoot.scope.sinceSource, "root-session-start");
  assert.equal(fromRoot.totals.responses, 2);
  await fs.mkdir(path.join(options.cwd, ".snipara", "workflow"), { recursive: true });
  await fs.writeFile(path.join(options.cwd, ".snipara", "workflow", "current.json"), JSON.stringify({ createdAt: since }));
  const fromWorkflow = await measureWorkflowEfficiency(options);
  assert.equal(fromWorkflow.scope.sinceSource, "current-workflow-createdAt");
  assert.equal(fromWorkflow.totals.responses, 1);
  assert.equal(fromWorkflow.coverage.status, "complete");
});

test("unknown counters and missing timestamps cannot produce a complete measurement", async t => {
  const options = await fixture(t);
  await log(options, "root.jsonl", [meta("root", undefined, "invalid"), usage("untimed"), timed(),
    usage("invalid-cache", { cached_input_tokens: 101 }), usage("invalid-reasoning", { reasoning_output_tokens: 21 }),
    { type: "token_usage_record", timestamp: after, payload: { response_id: "unknown", usage: { unknown_tokens: 1 } } }, usage("valid")]);
  const result = await workflowEfficiencyCommand({ ...options, enforce: true });
  assert.equal(result.report.totals.responses, 1);
  assert.equal(result.report.coverage.gaps.usage_timestamp_unavailable, 1);
  assert.equal(result.report.coverage.gaps.usage_record_unknown, 3);
  assert.equal(result.exitCode, 1);
});

test("symlinks and oversized transcript lines are skipped with bounded coverage", async t => {
  const options = await fixture(t);
  const file = await log(options, "root.jsonl", [meta("root"), timed(), usage("r"), JSON.stringify({ type: "response_item", payload: "x".repeat(1024 * 1024) })]);
  await fs.symlink(file, path.join(options.sessionsDir, "alias.jsonl"));
  const result = await workflowEfficiencyCommand({ ...options, enforce: true });
  assert.equal(result.report.totals.responses, 1);
  assert.equal(result.report.coverage.gaps.symlink_skipped, 1);
  assert.equal(result.report.coverage.gaps.record_bytes_truncated, 1);
  assert.equal(result.exitCode, 1);
});

test("invalid explicit options are rejected without echoing supplied content", async t => {
  const options = await fixture(t);
  await assert.rejects(measureWorkflowEfficiency({ ...options, since: "PRIVATE_INVALID" }), /ISO timestamp/);
  await assert.rejects(measureWorkflowEfficiency({ ...options, profile: "PRIVATE_PROFILE" }), /lite, standard or full/);
  await assert.rejects(measureWorkflowEfficiency({ ...options, maxResponses: -1 }), /Invalid efficiency threshold/);
});

test("cached standing context counts toward total input and enforced text is one line", async t => {
  const options = await fixture(t);
  await log(options, "root.jsonl", [meta("root"), timed(), usage("cached", {
    input_tokens: 1000000, cached_input_tokens: 999999, total_tokens: 1000020,
  })]);
  const advisory = await workflowEfficiencyCommand({ ...options, maxInputTokens: 1000 });
  assert.equal(advisory.exitCode, 0);
  assert.ok(advisory.report.exceeded.includes("maxInputTokens"));
  const enforced = await workflowEfficiencyCommand({ ...options, maxInputTokens: 1000, enforce: true });
  assert.equal(enforced.exitCode, 1);
  const message = renderWorkflowEfficiency(enforced.report);
  assert.equal(message.split("\n").length, 1);
  assert.match(message, /maxInputTokens exceeded/);
  assert.match(message, /cached=999999/);
});
