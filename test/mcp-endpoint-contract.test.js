const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveCanonicalDocumentation } = require("./support/source-fixtures.js");

const packageRoot = path.resolve(__dirname, "..");

function readPackageFile(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

test("Companion uses the canonical hosted MCP JSON-RPC endpoint", () => {
  const client = readPackageFile("src/api/client.ts");
  const init = readPackageFile("src/commands/init.ts");

  assert.match(client, /const url = `\$\{this\.config\.apiUrl\}\/mcp\/\$\{encoded\}`;/);
  assert.match(client, /method: "tools\/call"/);
  assert.match(init, /return `https:\/\/api\.snipara\.com\/mcp\/\$\{projectSlug\}`;/);

  assert.doesNotMatch(client, /api\.snipara\.com\/api\/mcp\//);
  assert.doesNotMatch(client, /api\.snipara\.com\/v1\/.*\/mcp/);
  assert.doesNotMatch(init, /snipara\.com\/api\/mcp\//);
  assert.doesNotMatch(init, /api\.snipara\.com\/v1\/.*\/mcp/);
});

test("MCP reference documentation identifies the direct endpoint and route boundaries", () => {
  const reference = fs.readFileSync(
    resolveCanonicalDocumentation("docs/reference/api/mcp.md"),
    "utf8"
  );

  assert.match(reference, /POST https:\/\/api\.snipara\.com\/mcp\/\{project_id_or_slug\}/);
  assert.match(reference, /method: \"tools\/call\"/);
  assert.match(reference, /do not configure an MCP client or session with `\/api\/mcp\/\.\.\.` or/);
  assert.match(reference, /`\/v1\/\.\.\.\/mcp`/);
  assert.match(reference, /Web app REST proxy/);
});
