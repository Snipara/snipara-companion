const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createClient } = require("../dist/index.js");
const cli = path.resolve(__dirname, "../dist/index.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-session-test-"));
  const config = path.join(cwd, ".snipara/companion/config.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), "{}");
  fs.writeFileSync(
    config,
    JSON.stringify({
      apiKey: "synthetic-test-key",
      projectId: "test-project",
      apiUrl: "https://session.test.invalid",
      sessionId: "test-session",
    })
  );
  const log = path.join(cwd, "calls.jsonl");
  const preload = path.join(cwd, "preload.cjs");
  fs.writeFileSync(
    preload,
    `
    const fs = require('node:fs');
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(body) + '\\n');
      const journal = body.params?.name === 'snipara_journal_append';
      if (process.env.TEST_MODE === 'offline' || (journal && process.env.TEST_MODE === 'journal-error') ||
          (!journal && process.env.TEST_MODE === 'event-error')) throw new Error('simulated offline');
      if (journal) {
        const receipt = process.env.TEST_MODE === 'unconfirmed' ? { success: true } :
          { entry_id: 'entry-confirmed', date: '2026-09-12' };
        return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } }) };
      }
      return { ok: true, json: async () => ({ success: true, data: { accepted: 1, sessionIds: ['test-session'] } }) };
    };
  `
  );
  const env = {
    ...process.env,
    SNIPARA_WORKSPACE_DIR: cwd,
    SNIPARA_API_URL: "https://session.test.invalid",
    SNIPARA_API_KEY: "",
    SNIPARA_PROJECT_ID: "",
    SNIPARA_SESSION_ID: "",
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
    TEST_LOG: log,
  };
  return {
    cwd,
    config,
    log,
    preload,
    env,
    run(args = [], mode = "ok", input) {
      return spawnSync(process.execPath, ["--require", preload, cli, "session-end", ...args], {
        cwd,
        env: { ...env, TEST_MODE: mode },
        input,
        encoding: "utf8",
        timeout: 10000,
      });
    },
    calls() {
      return fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [];
    },
    session() {
      return JSON.parse(fs.readFileSync(config)).sessionId;
    },
  };
}

test("empty checkpoint is explicitly skipped without journal write or session rotation", () => {
  const f = fixture();
  const result = f.run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "skipped");
  assert.equal(f.session(), "test-session");
  assert.equal(f.calls().filter((call) => call.params).length, 0);
  assert.equal(f.calls()[0].events[0].payload.persisted, false);
});

test("journal entry id confirms persistence before successful event and rotation", () => {
  const f = fixture();
  const result = f.run(["--summary", "Fixed the regression", "--files", "a.ts", "a.ts", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "saved");
  assert.equal(report.entryId, "entry-confirmed");
  assert.equal(report.eventDelivered, true);
  assert.deepEqual(report.checkpoint.files, ["a.ts"]);
  assert.notEqual(f.session(), "test-session");
  assert.match(f.calls()[0].params.arguments.text, /Fixed the regression/);
  assert.equal(f.calls()[1].events[0].payload.journal_entry_id, "entry-confirmed");
  assert.equal(fs.statSync(report.reportPath).mode & 0o777, 0o600);
});

for (const mode of ["offline", "journal-error", "unconfirmed"]) {
  test(`${mode}: failure retains checkpoint and session, retry saves once`, () => {
    const f = fixture();
    const failed = f.run(["--summary", "Pending work worth preserving", "--json"], mode);
    assert.equal(failed.status, 1, failed.stderr);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.status, "error");
    assert.equal(f.session(), "test-session");
    assert.equal(
      JSON.parse(fs.readFileSync(report.reportPath)).checkpoint.summary,
      "Pending work worth preserving"
    );
    assert.ok(
      f
        .calls()
        .filter((call) => call.events)
        .every((call) => call.events[0].payload.persisted === false)
    );
    const retry = f.run(["--retry", report.reportPath, "--json"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).status, "saved");
    const count = f.calls().length;
    assert.equal(f.run(["--retry", report.reportPath, "--json"]).status, 0);
    assert.equal(f.calls().length, count, "already confirmed receipt must not be sent again");
  });
}

test("failed telemetry does not erase a confirmed journal receipt", () => {
  const f = fixture();
  const result = f.run(["--summary", "Confirmed journal", "--json"], "event-error");
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 0);
  assert.equal(report.status, "saved");
  assert.equal(report.eventDelivered, false);
  assert.equal(report.entryId, "entry-confirmed");
});

test("host session ids remain separate, repeat Stop is deduplicated, and stdin is redacted", () => {
  const f = fixture();
  const summary = "Useful result\nTOKEN=super-secret-value\nBearer abcdefghijklmnopqrstuvwxyz";
  const args = ["--summary-stdin", "--session-id", "host-thread-123", "--json"];
  const first = f.run(args, "ok", summary);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.checkpoint.sessionId, "host-thread-123");
  assert.equal(f.session(), "test-session");
  assert.doesNotMatch(
    fs.readFileSync(f.log, "utf8") + first.stdout,
    /super-secret-value|abcdefghijklmnopqrstuvwxyz/
  );
  assert.equal(f.calls()[1].events[0].session_id, "host-thread-123");
  const count = f.calls().length;
  assert.equal(f.run(args, "ok", summary).status, 0);
  assert.equal(f.calls().length, count);
});

test("a retry from another workspace is refused before any hosted call", () => {
  const first = fixture();
  const failed = JSON.parse(first.run(["--summary", "Pending", "--json"], "offline").stdout);
  const second = fixture();
  const retry = second.run(["--retry", failed.reportPath, "--json"]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /does not belong/);
  assert.equal(second.calls().length, 0);
});

test("persistSession no longer reports success without an input checkpoint", async () => {
  const f = fixture();
  const result = await createClient(100, { cwd: f.cwd }).persistSession();
  assert.equal(result.success, false);
  assert.equal(result.status, "skipped");
});

test("changing project cannot reuse the previous project's persistence receipt", () => {
  const f = fixture();
  const args = ["--summary", "Same summary", "--session-id", "host-thread", "--json"];
  const first = JSON.parse(f.run(args).stdout);
  const config = JSON.parse(fs.readFileSync(f.config));
  config.projectId = "other-project";
  fs.writeFileSync(f.config, JSON.stringify(config));
  const second = f.run(args);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(JSON.parse(second.stdout).reportPath, first.reportPath);
  assert.equal(f.calls().filter((call) => call.params).length, 2);
});

test("a retained checkpoint can be retried after its writer process exited", () => {
  const f = fixture();
  const failed = JSON.parse(
    f.run(["--summary", "Interrupted checkpoint", "--json"], "offline").stdout
  );
  fs.writeFileSync(`${failed.reportPath}.lock`, "2147483647");
  const retry = f.run(["--retry", failed.reportPath, "--json"]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, "saved");
});
