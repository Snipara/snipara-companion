const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildDocsBootstrapResult, DEFAULT_DOCS_BOOTSTRAP_OUTPUT } = require("../dist/index.js");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function makeProject({ withDocs = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-docs-bootstrap-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "bootstrap-fixture",
      scripts: { build: "tsc", test: "node --test" },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  if (withDocs) {
    fs.writeFileSync(path.join(dir, "README.md"), "# Bootstrap fixture\n", "utf8");
  }
  return dir;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      SNIPARA_API_KEY: "",
      SNIPARA_PROJECT_ID: "",
      SNIPARA_API_URL: "",
    },
  });
}

test("docs bootstrap previews an evidence-linked brief without writing", () => {
  const dir = makeProject();
  const result = buildDocsBootstrapResult({ dir });

  assert.equal(result.applied, false);
  assert.equal(result.relativeOutputPath, DEFAULT_DOCS_BOOTSTRAP_OUTPUT.replaceAll(path.sep, "/"));
  assert.ok(result.content.includes("# Project Brief"));
  assert.ok(result.content.includes("`src/index.ts`"));
  assert.ok(result.content.includes("**bootstrap-fixture**"));
  assert.deepEqual(result.documentation.existingFiles, ["README.md"]);
  assert.equal(fs.existsSync(path.join(dir, "docs", "PROJECT.md")), false);
});

test("docs bootstrap makes the no-documentation state explicit", () => {
  const dir = makeProject({ withDocs: false });
  const result = runCli(["docs", "bootstrap", "--json"], dir);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.documentation.existingFiles, []);
  assert.match(payload.content, /No documentation files found/);
  assert.equal(fs.existsSync(path.join(dir, "docs", "PROJECT.md")), false);
});

test("docs bootstrap applies once and protects an existing brief", () => {
  const dir = makeProject({ withDocs: false });
  const first = runCli(["docs", "bootstrap", "--apply"], dir);
  assert.equal(first.status, 0, first.stderr);
  const outputPath = path.join(dir, "docs", "PROJECT.md");
  assert.ok(fs.existsSync(outputPath));
  assert.match(fs.readFileSync(outputPath, "utf8"), /# Project Brief/);

  const second = runCli(["docs", "bootstrap", "--apply"], dir);
  assert.notEqual(second.status, 0);
  assert.match(`${second.stderr}\n${second.stdout}`, /already exists/);

  const forced = runCli(["docs", "bootstrap", "--apply", "--force"], dir);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /overwritten/);
});

test("docs bootstrap rejects output paths outside the project", () => {
  const dir = makeProject();
  const result = runCli(["docs", "bootstrap", "--apply", "--output", "../PROJECT.md"], dir);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /must stay inside/);
});
