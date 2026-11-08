const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "../..");

function regularFile(file, label, maximumBytes) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes, label);
  return file;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function monorepoRoot() {
  const root = path.resolve(packageRoot, "../..");
  return packageRoot === path.join(root, "packages", "cli")
    && exists(path.join(root, "pnpm-workspace.yaml")) ? root : null;
}

function resolveCanonicalDocumentation(relativePath) {
  assert.ok(typeof relativePath === "string" && relativePath.startsWith("docs/")
    && !/[\\\x00-\x1f\x7f]/.test(relativePath)
    && relativePath.split("/").every((part) => part && part !== "." && part !== ".."),
  "Canonical documentation must use a contained docs/ path");
  const exported = path.join(packageRoot, relativePath);
  if (exists(exported)) return regularFile(exported, "Invalid exported canonical document", 4 * 1024 * 1024);
  const root = monorepoRoot();
  assert.ok(root, `Canonical document was not exported: ${relativePath}`);
  return regularFile(path.join(root, relativePath), "Invalid canonical monorepo document", 4 * 1024 * 1024);
}

function resolveOrchestratorSourceFixture(explicitSource) {
  if (explicitSource !== undefined) {
    assert.ok(typeof explicitSource === "string" && explicitSource.length > 0
      && path.isAbsolute(explicitSource) && path.extname(explicitSource) === ".py"
      && !/[\x00-\x1f\x7f]/.test(explicitSource),
    "SNIPARA_ORCHESTRATOR_TEST_SOURCE must name an absolute regular Python source fixture");
    assert.ok(exists(explicitSource), "SNIPARA_ORCHESTRATOR_TEST_SOURCE must name an existing source fixture");
    regularFile(explicitSource, "SNIPARA_ORCHESTRATOR_TEST_SOURCE must name a bounded regular source fixture", 512 * 1024);
    return fs.realpathSync(explicitSource);
  }
  const root = monorepoRoot();
  if (!root) return null;
  const source = path.join(root, "packages/agentic-orchestrator/src/snipara_orchestrator/task_intake.py");
  return exists(source) ? regularFile(source, "Invalid canonical Orchestrator source fixture", 512 * 1024) : null;
}

module.exports = { resolveCanonicalDocumentation, resolveOrchestratorSourceFixture };
