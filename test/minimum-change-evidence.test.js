const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildInstalledDependencyEvidence } = require("../dist/index.js");

function tempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("lockfile/manifest adapter confirms a direct pnpm dependency", () => {
  const repo = tempRepo("snipara-evidence-pnpm-");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { yaml: "^2.8.0" } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "pnpm-lock.yaml"),
    [
      'lockfileVersion: "9.0"',
      "",
      "packages:",
      "  yaml@2.8.3:",
      "    resolution: {integrity: sha512-fixture}",
      "",
    ].join("\n"),
    "utf8"
  );

  const evidence = buildInstalledDependencyEvidence(repo, "yaml");

  assert.equal(evidence.status, "confirmed");
  assert.equal(evidence.source, "lockfile");
  assert.equal(evidence.scope, "yaml");
  assert.equal(evidence.adapter_receipt.name, "lockfile_manifest");
  assert.equal(evidence.adapter_receipt.status, "verified");
  assert.deepEqual(
    evidence.evidence.map((item) => item.kind),
    ["declared_dependency", "locked_dependency"]
  );
});

test("lockfile/manifest adapter confirms a direct uv dependency", () => {
  const repo = tempRepo("snipara-evidence-uv-");
  fs.writeFileSync(
    path.join(repo, "pyproject.toml"),
    ["[project]", "dependencies = [", '  "httpx>=0.27"', "]", ""].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "uv.lock"),
    [
      "version = 1",
      "revision = 1",
      "",
      "[[package]]",
      'name = "httpx"',
      'version = "0.28.1"',
      'source = { registry = "https://pypi.org/simple" }',
      "",
    ].join("\n"),
    "utf8"
  );

  const evidence = buildInstalledDependencyEvidence(repo, "httpx");

  assert.equal(evidence.status, "confirmed");
  assert.equal(evidence.source, "lockfile");
  assert.match(evidence.evidence[1].detail, /httpx=0\.28\.1/);
});

test("manifest without a lockfile stays needs_review", () => {
  const repo = tempRepo("snipara-evidence-missing-lock-");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { yaml: "^2.8.0" } }),
    "utf8"
  );

  const evidence = buildInstalledDependencyEvidence(repo, "yaml");

  assert.equal(evidence.status, "needs_review");
  assert.equal(evidence.source, "manifest");
  assert.equal("adapter_receipt" in evidence, false);
});

test("mixed ecosystems do not cross-pair manifest and lockfile evidence", () => {
  const repo = tempRepo("snipara-evidence-mixed-");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { yaml: "^2.8.0" } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "uv.lock"),
    ["version = 1", "", "[[package]]", 'name = "yaml"', 'version = "0.2.5"', ""].join("\n"),
    "utf8"
  );

  const evidence = buildInstalledDependencyEvidence(repo, "yaml");

  assert.equal(evidence.status, "needs_review");
  assert.equal(evidence.source, "manifest");
  assert.equal("adapter_receipt" in evidence, false);
});

test("unknown dependency has no fabricated provenance", () => {
  const repo = tempRepo("snipara-evidence-unknown-");

  const evidence = buildInstalledDependencyEvidence(repo, "yaml");

  assert.equal(evidence.status, "unknown");
  assert.equal(evidence.source, "caller_assertion");
  assert.deepEqual(evidence.evidence, []);
});

test("git diff adapter confirms a coherent low-risk working-tree diff", () => {
  const repo = tempRepo("snipara-evidence-git-diff-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/cache.ts"), "export const cache = 1;\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  fs.writeFileSync(
    path.join(repo, "src/cache.ts"),
    "export const cache = 2;\nexport const warm = true;\n",
    "utf8"
  );

  const { buildSmallestSafeDiffEvidence } = require("../dist/index.js");
  const evidence = buildSmallestSafeDiffEvidence(repo, ["src/cache.ts"], {
    changedFiles: ["src/cache.ts"],
    impactedFiles: ["src/cache.ts"],
    missingTargetFiles: [],
    warnings: [],
    risk: { level: "low" },
    traversal: { truncated: false },
  });

  assert.equal(evidence.status, "confirmed");
  assert.equal(evidence.source, "git_diff");
  assert.equal(evidence.adapter_receipt.name, "git_diff");
  assert.equal(evidence.adapter_receipt.claim, "smallest_safe_diff");
  assert.equal(evidence.adapter_receipt.status, "verified");
});

test("git diff adapter stays needs_review when blast radius is not coherent", () => {
  const repo = tempRepo("snipara-evidence-git-diff-review-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  fs.writeFileSync(path.join(repo, "README.md"), "after\n", "utf8");

  const { buildSmallestSafeDiffEvidence } = require("../dist/index.js");
  const evidence = buildSmallestSafeDiffEvidence(repo, ["README.md"], {
    changedFiles: ["README.md"],
    impactedFiles: ["README.md", "docs/index.md"],
    missingTargetFiles: [],
    warnings: ["impact-incomplete"],
    risk: { level: "medium" },
    traversal: { truncated: false },
  });

  assert.equal(evidence.status, "needs_review");
  assert.equal("adapter_receipt" in evidence, false);
});
