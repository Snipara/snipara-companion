const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const cliPath = path.resolve(__dirname, "../dist/index.js");
const { appendActivityEvent, buildSessionSnapshot, readActivityTimeline } = require(cliPath);

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-activity-safe-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = (relative) => { const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); return file; };
  return { cwd, target };
}

test("missing optional activity artifacts retain the ordinary empty snapshot", (t) => {
  const f = fixture(t); const snapshot = buildSessionSnapshot({ cwd: f.cwd });
  assert.equal(snapshot.activity.totalEvents, 0); assert.equal(snapshot.workflow, null);
  assert.equal(snapshot.decisions.pendingCount, 0);
});

for (const relative of ["activity/timeline.jsonl", "decisions/pending/unsafe.json", "team-sync/session.json", "producer-loop/unsafe.json", "workflow/current.json"]) {
  test(`optional snapshot rejects FIFO ${relative} without blocking for a writer`, (t) => {
    const f = fixture(t); execFileSync("mkfifo", [f.target(`.snipara/${relative}`)]);
    const script = `const {buildSessionSnapshot}=require(${JSON.stringify(cliPath)});try{buildSessionSnapshot({cwd:process.cwd()});process.exit(2)}catch(error){if(!/Local activity/.test(error.message))process.exit(3)}`;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: f.cwd, encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined, "reader should return before the watchdog");
    assert.equal(result.status, 0, result.stderr);
  });
}

test("timeline symlinks and symlink metadata directories are rejected", (t) => {
  const f = fixture(t); const outside = fixture(t);
  const secret = outside.target("private.json"); fs.writeFileSync(secret, '{"private":"do not read"}');
  fs.symlinkSync(secret, f.target(".snipara/activity/timeline.jsonl"));
  assert.throws(() => readActivityTimeline({ cwd: f.cwd }), /Local activity artifact/);
  fs.unlinkSync(path.join(f.cwd, ".snipara/activity/timeline.jsonl"));
  fs.mkdirSync(path.join(f.cwd, ".snipara/decisions"), { recursive: true });
  fs.symlinkSync(outside.cwd, path.join(f.cwd, ".snipara/decisions/pending"));
  assert.throws(() => buildSessionSnapshot({ cwd: f.cwd }), /Local activity directory/);
});

test("oversized timeline and JSON supplements report unavailable instead of reading without bounds", (t) => {
  const f = fixture(t); const timeline = f.target(".snipara/activity/timeline.jsonl");
  fs.writeFileSync(timeline, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  assert.throws(() => readActivityTimeline({ cwd: f.cwd }), /bounded read limit/);
  fs.unlinkSync(timeline);
  fs.writeFileSync(f.target(".snipara/team-sync/session.json"), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  assert.throws(() => buildSessionSnapshot({ cwd: f.cwd }), /bounded read limit/);
});

test("invalid JSON and timeline events are explicit unavailable supplements", (t) => {
  const f = fixture(t); const timeline = f.target(".snipara/activity/timeline.jsonl");
  fs.writeFileSync(timeline, "{not-json}\n");
  assert.throws(() => readActivityTimeline({ cwd: f.cwd }), /invalid event/);
  fs.unlinkSync(timeline);
  fs.writeFileSync(f.target(".snipara/team-sync/session.json"), "[not-json]");
  assert.throws(() => buildSessionSnapshot({ cwd: f.cwd }), /JSON artifact is invalid/);
});

test("activity metadata directory scans stop at the entry cap", (t) => {
  const f = fixture(t); const dir = f.target(".snipara/producer-loop/placeholder"); fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let i = 0; i < 257; i++) fs.writeFileSync(path.join(path.dirname(dir), `${i}.json`), "{}");
  assert.throws(() => buildSessionSnapshot({ cwd: f.cwd }), /bounded entry limit/);
});

test("activity metadata directory scans stop at the cumulative byte cap", (t) => {
  const f = fixture(t); const content = JSON.stringify({ value: "a".repeat(2 * 1024 * 1024 - 20) });
  fs.writeFileSync(f.target(".snipara/producer-loop/one.json"), content);
  fs.writeFileSync(f.target(".snipara/producer-loop/two.json"), content);
  fs.writeFileSync(f.target(".snipara/producer-loop/three.json"), JSON.stringify({ value: "a".repeat(100) }));
  assert.throws(() => buildSessionSnapshot({ cwd: f.cwd }), /bounded byte limit/);
});

test("ordinary activity events continue to produce useful local summaries", (t) => {
  const f = fixture(t); appendActivityEvent({ cwd: f.cwd, source: "workflow", kind: "task-commit", title: "Task checked",
    summary: "Known failure preserved", outcome: "blocked", files: ["src/code.ts"], metadata: { attempt: 1 } });
  const result = buildSessionSnapshot({ cwd: f.cwd });
  assert.equal(result.activity.totalEvents, 1); assert.equal(result.summary.latestActivityTitle, "Task checked");
  assert.deepEqual(result.summary.touchedFiles, ["src/code.ts"]);
});
