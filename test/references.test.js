const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;

  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

test("references scan writes a manifest with allowlist and denylist classifications", () => {
  const dir = makeTempDir("snipara-references-scan");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(
    path.join(dir, "README.md"),
    [
      "# Demo",
      "",
      "[OpenAI docs](https://platform.openai.com/docs)",
      "Bare URL: https://example.com/reference).",
      "Denied URL: https://blocked.example.com/private",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "docs", "notes.md"), "Duplicate https://example.com/reference\n");

  const result = runCli([
    "references",
    "scan",
    "--root",
    dir,
    "--allow-domain",
    "platform.openai.com",
    "--deny-domain",
    "blocked.example.com",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.foundUrls, 3);
  assert.equal(payload.allowed, 1);
  assert.equal(payload.pending, 1);
  assert.equal(payload.denied, 1);
  assert.equal(fs.existsSync(path.join(dir, ".snipara", "references", "manifest.json")), true);

  const manifest = payload.manifest;
  const byDomain = new Map(manifest.items.map((item) => [item.domain, item]));
  assert.equal(byDomain.get("platform.openai.com").status, "allowed");
  assert.equal(byDomain.get("example.com").status, "pending");
  assert.equal(byDomain.get("blocked.example.com").status, "denied");
  assert.equal(byDomain.get("example.com").occurrences.length, 2);
});

test("references ingest fetches allowed URLs into provenance snapshots", () => {
  const dir = makeTempDir("snipara-references-ingest");
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "[Example docs](https://docs.example.com/guide/start)\n",
    "utf8"
  );

  const scan = runCli([
    "references",
    "scan",
    "--root",
    dir,
    "--allow-domain",
    "docs.example.com",
    "--json",
  ]);
  assert.equal(scan.status, 0, scan.stderr);

  const preloadPath = path.join(dir, "fetch-preload.js");
  fs.writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async (url) => ({",
      "  status: 200,",
      "  statusText: 'OK',",
      "  headers: new Headers({",
      "    'content-type': 'text/html; charset=utf-8',",
      "    etag: 'abc123',",
      "    'last-modified': 'Sat, 06 Jun 2026 00:00:00 GMT'",
      "  }),",
      "  text: async () => '<html><body><h1>Example Guide</h1><p>Hello from docs.</p></body></html>'",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  const ingest = runCli(
    [
      "references",
      "ingest",
      "--manifest",
      path.join(dir, ".snipara/references/manifest.json"),
      "--json",
    ],
    { nodeArgs: ["--require", preloadPath] }
  );

  assert.equal(ingest.status, 0, ingest.stderr);
  const payload = JSON.parse(ingest.stdout);
  assert.equal(payload.selected, 1);
  assert.equal(payload.fetched, 1);
  assert.equal(payload.uploaded, 0);
  assert.equal(payload.failed, 0);
  assert.equal(payload.snapshots.length, 1);

  const snapshotPath = path.join(dir, payload.snapshots[0].snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), true);
  const snapshot = fs.readFileSync(snapshotPath, "utf8");
  assert.match(snapshot, /Source URL: https:\/\/docs\.example\.com\/guide\/start/);
  assert.match(snapshot, /Content SHA256:/);
  assert.match(snapshot, /README\.md:1/);
  assert.match(snapshot, /Example Guide/);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, ".snipara/references/manifest.json"), "utf8")
  );
  assert.equal(manifest.items[0].latestFetchStatus, 200);
  assert.equal(manifest.items[0].latestSnapshotPath, payload.snapshots[0].snapshotPath);
});

test("references ingest dry-run does not require network access", () => {
  const dir = makeTempDir("snipara-references-dry-run");
  fs.writeFileSync(path.join(dir, "README.md"), "https://docs.example.com/api\n", "utf8");

  const scan = runCli([
    "references",
    "scan",
    "--root",
    dir,
    "--allow-domain",
    "docs.example.com",
    "--json",
  ]);
  assert.equal(scan.status, 0, scan.stderr);

  const dryRun = runCli([
    "references",
    "ingest",
    "--manifest",
    path.join(dir, ".snipara/references/manifest.json"),
    "--dry-run",
    "--json",
  ]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const payload = JSON.parse(dryRun.stdout);
  assert.equal(payload.selected, 1);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.fetched, 0);
});
