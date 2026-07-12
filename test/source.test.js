const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildLocalSourceSnapshot,
  buildLocalSourceSyncResult,
  buildLocalSourceStatus,
  compareLocalSourceSnapshots,
  getLocalCodeOverlayCachePath,
  getLocalSourceSnapshotPath,
  readLocalSourceSnapshot,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeLocalSourceFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-source-"));
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# Local source\n", "utf8");
  fs.writeFileSync(path.join(dir, "docs", "spec.md"), "# Spec\n", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"local-source"}\n', "utf8");
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    [
      "import { helper } from './helper';",
      "export function run() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "src", "helper.ts"),
    ["export function helper() {", "  return 'ok';", "}", ""].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "ignored", "index.ts"),
    "export const ignored = true;\n",
    "utf8"
  );
  return dir;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      SNIPARA_API_KEY: "",
      SNIPARA_PROJECT_ID: "",
      SNIPARA_API_URL: "",
    },
  });
}

test("buildLocalSourceSnapshot classifies docs, code, config, and ignores dependency dirs", () => {
  const dir = makeLocalSourceFolder();
  const snapshot = buildLocalSourceSnapshot({ dir });

  assert.equal(snapshot.version, "snipara.local_source_snapshot.v1");
  assert.equal(snapshot.provider, "local_folder");
  assert.ok(snapshot.revision.startsWith("sha256:"));
  assert.equal(snapshot.summary.byKind.DOC, 2);
  assert.equal(snapshot.summary.byKind.CODE, 2);
  assert.equal(snapshot.summary.byKind.CONFIG, 1);
  assert.equal(snapshot.summary.byKind.BINARY, 0);
  assert.ok(!snapshot.files.some((file) => file.path.includes("node_modules")));
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    snapshot.files.map((file) => file.path).sort()
  );
});

test("buildLocalSourceStatus compares current folder to cached snapshot", () => {
  const dir = makeLocalSourceFolder();
  const before = buildLocalSourceSnapshot({ dir });
  fs.mkdirSync(path.dirname(getLocalSourceSnapshotPath(dir)), { recursive: true });
  fs.writeFileSync(getLocalSourceSnapshotPath(dir), `${JSON.stringify(before, null, 2)}\n`, "utf8");

  fs.appendFileSync(path.join(dir, "docs", "spec.md"), "\nupdated\n", "utf8");
  fs.writeFileSync(path.join(dir, "docs", "new.md"), "# New\n", "utf8");
  fs.unlinkSync(path.join(dir, "README.md"));

  const status = buildLocalSourceStatus({ dir });
  assert.ok(status.previous);
  assert.deepEqual(status.comparison.added, ["docs/new.md"]);
  assert.deepEqual(status.comparison.modified, ["docs/spec.md"]);
  assert.deepEqual(status.comparison.deleted, ["README.md"]);
  assert.equal(
    status.comparison.unchanged,
    before.files.length - status.comparison.modified.length - status.comparison.deleted.length
  );
});

test("compareLocalSourceSnapshots treats first snapshot as all added", () => {
  const dir = makeLocalSourceFolder();
  const current = buildLocalSourceSnapshot({ dir });
  const comparison = compareLocalSourceSnapshots(null, current);

  assert.equal(comparison.added.length, current.files.length);
  assert.equal(comparison.modified.length, 0);
  assert.equal(comparison.deleted.length, 0);
  assert.equal(comparison.unchanged, 0);
});

test("readLocalSourceSnapshot rejects structurally invalid cached snapshots", () => {
  const dir = makeLocalSourceFolder();
  fs.mkdirSync(path.dirname(getLocalSourceSnapshotPath(dir)), { recursive: true });
  fs.writeFileSync(
    getLocalSourceSnapshotPath(dir),
    JSON.stringify({ version: "snipara.local_source_snapshot.v1", files: null }),
    "utf8"
  );

  assert.equal(readLocalSourceSnapshot(dir), null);
  const status = buildLocalSourceStatus({ dir });
  assert.equal(status.previous, null);
  assert.equal(status.comparison.added.length, status.current.files.length);
});

test("buildLocalSourceSyncResult reports delta against previous cached snapshot", async () => {
  const dir = makeLocalSourceFolder();
  const before = buildLocalSourceSnapshot({ dir });
  fs.mkdirSync(path.dirname(getLocalSourceSnapshotPath(dir)), { recursive: true });
  fs.writeFileSync(getLocalSourceSnapshotPath(dir), `${JSON.stringify(before, null, 2)}\n`, "utf8");

  fs.appendFileSync(path.join(dir, "docs", "spec.md"), "\nupdated\n", "utf8");
  fs.writeFileSync(path.join(dir, "docs", "new.md"), "# New\n", "utf8");
  fs.unlinkSync(path.join(dir, "README.md"));

  const result = await buildLocalSourceSyncResult({ dir });

  assert.deepEqual(result.comparison.added, ["docs/new.md"]);
  assert.deepEqual(result.comparison.modified, ["docs/spec.md"]);
  assert.deepEqual(result.comparison.deleted, ["README.md"]);
  assert.equal(
    result.comparison.unchanged,
    before.files.length - result.comparison.modified.length - result.comparison.deleted.length
  );
});

test("source sync writes local source and code overlay caches without hosted config", () => {
  const dir = makeLocalSourceFolder();

  const result = runCli(["source", "sync", "--json"], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.snapshot.version, "snipara.local_source_snapshot.v1");
  assert.equal(payload.documents.dryRun.total, 2);
  assert.equal(payload.documents.dryRun.would_sync, 2);
  assert.equal(payload.codeOverlay.summary.overlayKind, "working_tree");
  assert.equal(payload.codeOverlay.summary.counts.files, 2);
  assert.equal(payload.apply, null);
  assert.ok(fs.existsSync(getLocalSourceSnapshotPath(dir)));
  assert.ok(fs.existsSync(getLocalCodeOverlayCachePath(dir)));

  const cached = readLocalSourceSnapshot(dir);
  assert.equal(cached.revision, payload.snapshot.revision);
});

test("source commands reject invalid positive integer options", () => {
  const dir = makeLocalSourceFolder();

  const result = runCli(["source", "snapshot", "--max-files", "0", "--json"], { cwd: dir });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /--max-files must be a positive integer/);
});

test("source watch --once performs a single sync cycle", () => {
  const dir = makeLocalSourceFolder();

  const result = runCli(["source", "watch", "--once", "--json"], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.snapshot.version, "snipara.local_source_snapshot.v1");
  assert.ok(fs.existsSync(getLocalSourceSnapshotPath(dir)));
  assert.ok(fs.existsSync(getLocalCodeOverlayCachePath(dir)));
});
