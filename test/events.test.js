const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  buildCanonicalEvent,
  buildLocalContextPackReceipts,
  packContext,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-events-pack-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}\n', "utf8");
  return dir;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "snipara-events-home-")),
      SNIPARA_API_KEY: "",
      SNIPARA_PROJECT_ID: "",
      SNIPARA_API_URL: "",
      SNIPARA_SESSION_ID: "",
      SNIPARA_AUTOMATION_CLIENT: "",
    },
  });
}

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

test("buildCanonicalEvent can attach metadata-only local context pack receipts", () => {
  const repo = makeTempRepo();
  const content = `${"large tool output line\n".repeat(200)}line 2\n`;
  const packed = packContext({
    cwd: repo,
    content,
    kind: "tool_output",
    label: "test output",
    source: "node test.js",
    now: new Date("2026-06-19T08:30:00.000Z"),
  });
  const receipts = buildLocalContextPackReceipts({
    ids: [packed.record.id],
    cwd: repo,
    operation: "reference",
  });

  const event = buildCanonicalEvent({
    eventType: "tool_result",
    workspace: repo,
    payload: { command: "node test.js" },
    contextPackReceipts: receipts,
  });

  assert.equal(event.payload.command, "node test.js");
  assert.equal(event.payload.local_context_pack_receipts.length, 1);
  const receipt = event.payload.local_context_pack_receipts[0];
  assert.equal(receipt.version, "snipara.context_pack.receipt.v1");
  assert.equal(receipt.pack_id, packed.record.id);
  assert.equal(receipt.content_uploaded, false);
  assert.equal(receipt.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(receipt.baseline_tokens, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
  assert.ok(receipt.packed_tokens > 0);
  assert.equal(receipt.retrieved_tokens, 0);
  assert.ok(receipt.saved_tokens > 0);
  assert.equal(
    receipt.local_ref.manifest_relative_path,
    packed.record.storage.manifestRelativePath
  );
  assert.equal(JSON.stringify(receipt).includes(content), false);
});

test("local context pack retrieve receipts do not claim saved tokens", () => {
  const repo = makeTempRepo();
  const content = `${"large tool output line\n".repeat(200)}line 2\n`;
  const packed = packContext({
    cwd: repo,
    content,
    kind: "tool_output",
    now: new Date("2026-06-19T08:30:00.000Z"),
  });
  const [receipt] = buildLocalContextPackReceipts({
    ids: [packed.record.id],
    cwd: repo,
    operation: "retrieve",
  });

  assert.equal(receipt.baseline_tokens, Math.ceil(Buffer.byteLength(content, "utf8") / 4));
  assert.equal(receipt.retrieved_tokens, receipt.baseline_tokens);
  assert.equal(receipt.saved_tokens, 0);
});

test("post-tool --pack-result keeps no-account local fallback", () => {
  const repo = makeTempRepo();
  const content = "long local output\nwithout hosted config\n";
  const result = runCli(
    [
      "post-tool",
      JSON.stringify({ command: "node fixture.js" }),
      "--tool",
      "Bash",
      "--result",
      content,
      "--pack-result",
    ],
    { cwd: repo }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const itemDir = path.join(repo, ".snipara", "context-pack", "items");
  const manifests = fs.readdirSync(itemDir).filter((name) => name.endsWith(".json"));
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(itemDir, manifests[0]), "utf8"));
  assert.equal(manifest.kind, "tool_output");
  assert.equal(manifest.source, "node fixture.js");
});
