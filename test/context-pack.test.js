const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  buildContextPackStats,
  cleanContextPacks,
  getContextPackStoragePaths,
  packContext,
  retrieveContextPack,
} = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-context-pack-"));
  runGit(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture"}\n', "utf8");
  return dir;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

test("packContext writes a deterministic local pack and retrieves exact content", () => {
  const repo = makeTempRepo();
  const content = "first line\nsecond line\n";
  const now = new Date("2026-06-19T08:00:00.000Z");
  const result = packContext({
    cwd: repo,
    content,
    label: "test log",
    source: "pnpm test",
    kind: "log",
    tags: ["test", "test", "local"],
    ttlDays: 2,
    now,
  });

  assert.match(result.record.id, /^cpack_[a-f0-9]{16}$/);
  assert.equal(result.created, true);
  assert.equal(result.record.kind, "log");
  assert.equal(result.record.label, "test log");
  assert.equal(result.record.source, "pnpm test");
  assert.deepEqual(result.record.tags, ["test", "local"]);
  assert.equal(result.record.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(result.record.lineCount, 3);
  assert.equal(result.record.expiresAt, "2026-06-21T08:00:00.000Z");
  assert.ok(result.record.storage.blobRelativePath.startsWith(".snipara/context-pack/blobs/"));
  assert.ok(fs.existsSync(result.manifestPath));
  assert.ok(fs.existsSync(result.blobPath));
  assert.ok(fs.existsSync(path.join(repo, ".snipara", "context-pack", ".gitignore")));
  assert.equal(fileMode(path.join(repo, ".snipara", "context-pack")), 0o700);
  assert.equal(fileMode(result.manifestPath), 0o600);
  assert.equal(fileMode(result.blobPath), 0o600);

  const visiblePackFiles = runGit(repo, [
    "status",
    "--short",
    "--untracked-files=all",
    ".snipara/context-pack",
  ]);
  assert.match(visiblePackFiles, /\.snipara\/context-pack\/\.gitignore/);
  assert.doesNotMatch(visiblePackFiles, /blobs/);
  assert.doesNotMatch(visiblePackFiles, /items/);
  assert.doesNotMatch(visiblePackFiles, /latest\.json/);

  const repeat = packContext({ cwd: repo, content, kind: "log", now });
  assert.equal(repeat.record.id, result.record.id);
  assert.equal(repeat.created, false);

  const retrieved = retrieveContextPack(result.record.id, repo);
  assert.equal(retrieved.content, content);
  assert.equal(retrieveContextPack("latest", repo).record.id, result.record.id);

  const stats = buildContextPackStats({ cwd: repo });
  assert.equal(stats.totalPacks, 1);
  assert.equal(stats.totalBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(stats.kinds.log, 1);
  assert.equal(stats.latestId, result.record.id);
});

test("context-pack CLI packs piped output, retrieves it, reports stats, and cleans all", () => {
  const repo = makeTempRepo();
  const content = "tool stdout\nstderr summary\n";

  const packed = runCli(
    [
      "context-pack",
      "pack",
      "--label",
      "tool run",
      "--source",
      "node script.js",
      "--kind",
      "tool-output",
      "--tag",
      "phase-1",
      "--json",
    ],
    { cwd: repo, input: content }
  );
  assert.equal(packed.status, 0, packed.stderr);
  const packPayload = JSON.parse(packed.stdout);
  assert.equal(packPayload.record.label, "tool run");
  assert.equal(packPayload.record.source, "node script.js");
  assert.equal(packPayload.record.kind, "tool_output");
  assert.deepEqual(packPayload.record.tags, ["phase-1"]);

  const retrieved = runCli(["context-pack", "retrieve", packPayload.record.id], { cwd: repo });
  assert.equal(retrieved.status, 0, retrieved.stderr);
  assert.equal(retrieved.stdout, content);

  const retrieveJson = runCli(["context-pack", "retrieve", "latest", "--json"], { cwd: repo });
  assert.equal(retrieveJson.status, 0, retrieveJson.stderr);
  const retrievePayload = JSON.parse(retrieveJson.stdout);
  assert.equal(retrievePayload.record.id, packPayload.record.id);
  assert.equal(retrievePayload.content, content);

  const metadataOnly = runCli(["context-pack", "retrieve", "latest", "--json", "--metadata-only"], {
    cwd: repo,
  });
  assert.equal(metadataOnly.status, 0, metadataOnly.stderr);
  const metadataOnlyPayload = JSON.parse(metadataOnly.stdout);
  assert.equal(metadataOnlyPayload.record.id, packPayload.record.id);
  assert.equal(Object.prototype.hasOwnProperty.call(metadataOnlyPayload, "content"), false);

  const stats = runCli(["context-pack", "stats", "--json"], { cwd: repo });
  assert.equal(stats.status, 0, stats.stderr);
  const statsPayload = JSON.parse(stats.stdout);
  assert.equal(statsPayload.totalPacks, 1);
  assert.equal(statsPayload.kinds.tool_output, 1);

  const dryRun = runCli(["context-pack", "clean", "--all", "--dry-run", "--json"], {
    cwd: repo,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).selected, 1);
  assert.ok(fs.existsSync(path.join(repo, ".snipara", "context-pack")));

  const cleaned = runCli(["context-pack", "clean", "--all", "--json"], { cwd: repo });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  const cleanPayload = JSON.parse(cleaned.stdout);
  assert.equal(cleanPayload.deleted, 1);
  assert.deepEqual(cleanPayload.deletedIds, [packPayload.record.id]);

  const emptyStats = buildContextPackStats({ cwd: repo });
  assert.equal(emptyStats.totalPacks, 0);
  assert.equal(emptyStats.latestId, null);
});

test("context-pack clean removes expired packs without touching fresh packs", () => {
  const repo = makeTempRepo();
  const oldNow = new Date("2026-06-01T00:00:00.000Z");
  const currentNow = new Date("2026-06-19T00:00:00.000Z");
  const expired = packContext({
    cwd: repo,
    content: "expired output",
    kind: "tool_output",
    ttlDays: 1,
    now: oldNow,
  });
  const fresh = packContext({
    cwd: repo,
    content: "fresh output",
    kind: "note",
    now: currentNow,
  });

  const result = cleanContextPacks({ cwd: repo, now: currentNow });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.deletedIds, [expired.record.id]);
  assert.equal(retrieveContextPack(fresh.record.id, repo).content, "fresh output");
  assert.throws(() => retrieveContextPack(expired.record.id, repo), /not found/);

  const paths = getContextPackStoragePaths(repo);
  assert.ok(fs.existsSync(paths.latestPath));
  assert.equal(retrieveContextPack("latest", repo).record.id, fresh.record.id);
});

test("context-pack blocks secret-like content by default and redacts metadata when allowed", () => {
  const repo = makeTempRepo();
  const content = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    "DATABASE_URL=postgres://user:supersecretpassword@localhost:5432/app",
    "SNIPARA_API_KEY=snp_1234567890abcdef1234567890", // gitleaks:allow
    "-----BEGIN PRIVATE KEY-----",
    "abc123",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  assert.throws(() => packContext({ cwd: repo, content }), /requires --allow-sensitive/);

  const packed = packContext({
    cwd: repo,
    content,
    label: "sensitive log",
    allowSensitive: true,
  });
  assert.equal(packed.record.sensitive, true);
  assert.equal(packed.record.preview.includes("supersecretpassword"), false);
  assert.equal(packed.record.preview.includes("abcdefghijklmnopqrstuvwxyz1234567890"), false);
  assert.match(packed.record.preview, /REDACTED/);
  assert.equal(retrieveContextPack(packed.record.id, repo).content, content);

  const manifest = JSON.parse(fs.readFileSync(packed.manifestPath, "utf8"));
  assert.equal(JSON.stringify(manifest).includes("supersecretpassword"), false);
  assert.equal(JSON.stringify(manifest).includes("snp_1234567890abcdef1234567890"), false);
});
