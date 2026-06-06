const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveQueryFromToolInput,
  extractFilesFromToolInput,
  buildToolResultPayload,
  classifyToolResult,
  extractCommandFromToolInput,
  getStuckGuardInjection,
} = require("../dist/index.js");

test("resolveQueryFromToolInput builds query from file path", () => {
  const query = resolveQueryFromToolInput(JSON.stringify({ file_path: "/src/auth.ts" }), "Read");

  assert.equal(query, "Read /src/auth.ts");
});

test("resolveQueryFromToolInput includes pattern and path", () => {
  const query = resolveQueryFromToolInput(JSON.stringify({ pattern: "user", path: "src" }), "Grep");

  assert.equal(query, "Grep user src");
});

test("resolveQueryFromToolInput parses Claude hook stdin payloads", () => {
  const query = resolveQueryFromToolInput(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/src/claude.ts" } })
  );

  assert.equal(query, "Read /src/claude.ts");
});

test("extractFilesFromToolInput parses single file", () => {
  const files = extractFilesFromToolInput(JSON.stringify({ file_path: "/src/api/auth.ts" }));

  assert.deepEqual(files, ["/src/api/auth.ts"]);
});

test("extractFilesFromToolInput parses file list", () => {
  const files = extractFilesFromToolInput(JSON.stringify({ files: ["a.ts", "b.ts"] }));

  assert.deepEqual(files, ["a.ts", "b.ts"]);
});

test("extractFilesFromToolInput parses nested Claude tool_input fields", () => {
  const files = extractFilesFromToolInput(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/src/api/claude.ts" } })
  );

  assert.deepEqual(files, ["/src/api/claude.ts"]);
});

test("extractCommandFromToolInput prefers executable command fields", () => {
  const command = extractCommandFromToolInput(
    JSON.stringify({ command: "pnpm db:push", description: "deploy" })
  );

  assert.equal(command, "pnpm db:push");
});

test("extractCommandFromToolInput parses nested Claude Bash payloads", () => {
  const command = extractCommandFromToolInput(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } })
  );

  assert.equal(command, "pnpm test");
});

test("classifyToolResult distinguishes failures and empty search output", () => {
  assert.equal(classifyToolResult({ tool: "Bash", command: "pnpm test", exitCode: 1 }), "failure");
  assert.equal(
    classifyToolResult({ tool: "Grep", command: "rg missing", exitCode: 1, result: "" }),
    "empty_result"
  );
});

test("buildToolResultPayload redacts and truncates result previews", () => {
  const payload = buildToolResultPayload({
    tool: "Bash",
    toolInput: JSON.stringify({ command: "curl api" }),
    result: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    exitCode: 1,
  });

  assert.equal(payload.result_classification, "failure");
  assert.equal(payload.command, "curl api");
  assert.match(payload.result_preview, /\[REDACTED\]/);
});

test("getStuckGuardInjection returns only inject or enforce rescue text", () => {
  assert.equal(
    getStuckGuardInjection({
      enabled: true,
      triggered: true,
      configuredMode: "inject",
      action: "inject",
      score: 80,
      reasons: [],
      riskKeywords: [],
      memoryCheckedRecently: false,
      cooldownActive: false,
      eventCount: 4,
      evaluatedAt: "2026-05-12T10:00:00.000Z",
      rescuePack: {
        marker: "SNIPARA_RESCUE_PACK v1",
        title: "Rescue",
        instructions: [],
        recall: {
          tool: "snipara_recall",
          arguments: {
            query: "db decisions",
            scope: "project",
            limit: 5,
            min_relevance: 0.2,
          },
        },
        contextQuery: {
          tool: "snipara_context_query",
          arguments: {
            query: "db runbook",
            max_tokens: 1200,
            search_mode: "keyword",
            return_references: true,
            auto_decompose: false,
            include_all_tiers: false,
          },
        },
        injectionText: "SNIPARA_RESCUE_PACK v1\nCheck memory.",
      },
    }),
    "SNIPARA_RESCUE_PACK v1\nCheck memory."
  );
});
