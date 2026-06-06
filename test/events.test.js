const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCanonicalEvent } = require("../dist/index.js");

test("buildCanonicalEvent uses defaults from local environment", () => {
  const event = buildCanonicalEvent({
    eventType: "tool_call",
    payload: { hook: "pre-tool" },
  });

  assert.equal(event.type, "tool_call");
  assert.equal(event.client, "snipara-companion");
  assert.equal(event.agent_id, "local-agent");
  assert.equal(event.privacy_level, "standard");
  assert.equal(event.payload.hook, "pre-tool");
  assert.ok(typeof event.timestamp === "string");
});

test("buildCanonicalEvent respects explicit overrides", () => {
  const event = buildCanonicalEvent({
    eventType: "session_end",
    client: "cursor",
    workspace: "/tmp/project",
    sessionId: "sess_custom",
    agentId: "agent-7",
    privacyLevel: "restricted",
    payload: { persisted: true },
  });

  assert.equal(event.client, "cursor");
  assert.equal(event.workspace, "/tmp/project");
  assert.equal(event.session_id, "sess_custom");
  assert.equal(event.agent_id, "agent-7");
  assert.equal(event.privacy_level, "restricted");
  assert.equal(event.payload.persisted, true);
});
