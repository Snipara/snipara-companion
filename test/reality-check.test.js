const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");
const {
  buildLocalProjectRealityCheck,
  buildLocalProjectRealityCheckWithAutoContext,
} = require("../dist/index.js");

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    SNIPARA_COMPANION_SKIP_NPM_VERSION_CHECK: "1",
    ...(options.env ?? {}),
  };
  delete env.SNIPARA_API_KEY;
  delete env.SNIPARA_PROJECT_ID;
  delete env.SNIPARA_API_URL;

  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
}

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-reality-check-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"private":true}\n', "utf8");
  return dir;
}

function runGit(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("buildLocalProjectRealityCheck flags auth changes without verification", () => {
  const dir = makeTempWorkspace();

  const result = buildLocalProjectRealityCheck({
    dir,
    task: "Refactor auth middleware",
    changedFiles: ["src/auth/middleware.ts"],
    diffSummary: "Expose public token handling in auth middleware.",
  });

  assert.equal(result.source, "local");
  assert.equal(result.status, "review_required");
  assert.ok(result.score < 80);
  assert.equal(result.intentLedger.coverage, "missing");
  assert.equal(result.unknownRegistry.version, "unknown-registry-v1");
  assert.equal(result.unknownRegistry.status, "risk");
  assert.ok(result.unknownRegistry.categories.includes("missing_intent"));
  assert.ok(result.unknownRegistry.categories.includes("missing_verification"));
  assert.ok(result.unknownRegistry.categories.includes("heuristic_calibration"));
  assert.ok(result.unknownRegistry.unknowns.length > 0);
  assert.ok(result.unknownRegistry.unknowns.every((unknown) => unknown.id.startsWith("unknown:")));
  assert.ok(!result.unknownRegistry.unknowns.some((unknown) => unknown.id.startsWith("reality:")));
  assert.ok(result.findings.some((finding) => finding.reasonCodes.includes("auth_security")));
  assert.ok(result.requiredActions.some((action) => /verify|verification/i.test(action)));
});

test("buildLocalProjectRealityCheck links supplied decision intent", () => {
  const dir = makeTempWorkspace();

  const result = buildLocalProjectRealityCheck({
    dir,
    task: "Refactor auth middleware",
    changedFiles: ["src/auth/middleware.ts"],
    diffSummary: "Keep auth middleware side effects explicit.",
    decision: ["DEC-001: auth middleware must keep side effects explicit"],
  });

  assert.equal(result.intentLedger.version, "intent-ledger-v1");
  assert.equal(result.intentLedger.coverage, "linked");
  assert.equal(result.intentLedger.linkedIntentCount, 1);
  assert.equal(result.intentLedger.entries[0].sourceDecisionId, "DEC-001");
});

test("auto-context links reviewed decisions and bounded keyword documents", async () => {
  const dir = makeTempWorkspace();
  const calls = [];
  const client = {
    getTeamSyncWhatChanged: async (args) => {
      calls.push({ kind: "team-sync", args });
      return {
        whatChanged: {
          decisions: [
            {
              id: "DEC-REALITY-CHECK",
              title: "Keep Companion Reality Check evidence inspectable",
              status: "ACTIVE",
              impact: "HIGH",
              summary:
                "Companion reality-check must retain source-backed decision and verification evidence.",
              tags: ["companion", "reality-check", "decision"],
              recommendedAction: "Review high-impact decision before changing related work.",
              updatedAt: "2026-07-18T00:00:00.000Z",
            },
          ],
        },
      };
    },
    queryContext: async (query, maxTokens, options) => {
      calls.push({ kind: "context", query, maxTokens, options });
      return {
        sections: [
          {
            title: "Reality Check ADR",
            content: "Goal: Keep reality-check verification evidence inspectable",
            file: "docs/adr/reality-check.md",
            lines: [1, 20],
            relevance_score: 0.9,
            token_count: 20,
            truncated: false,
          },
        ],
        total_tokens: 20,
        max_tokens: maxTokens,
        query,
      };
    },
  };

  const result = await buildLocalProjectRealityCheckWithAutoContext(
    {
      dir,
      task: "Make Companion reality-check verification evidence inspectable",
      changedFiles: ["packages/cli/src/commands/reality-check.ts"],
      verification: ["pnpm --filter snipara-companion test passed"],
    },
    client
  );

  assert.equal(result.intentLedger.coverage, "linked");
  assert.ok(
    result.intentLedger.entries.some((entry) => entry.sourceDecisionId === "DEC-REALITY-CHECK")
  );
  assert.ok(result.evidence.some((item) => item.kind === "decision"));
  assert.ok(result.evidence.some((item) => item.kind === "document"));
  assert.ok(result.evidence.some((item) => item.kind === "test"));
  const contextCall = calls.find((call) => call.kind === "context");
  assert.equal(contextCall.maxTokens, 1200);
  assert.equal(contextCall.options.searchMode, "keyword");
  assert.equal(contextCall.options.includeAnswerPack, false);
  assert.equal(contextCall.options.autoDecompose, false);
});

test("auto-context fails open and preserves explicit inputs", async () => {
  const dir = makeTempWorkspace();
  const client = {
    getTeamSyncWhatChanged: async () => {
      throw new Error("hosted Team Sync unavailable");
    },
    queryContext: async () => {
      throw new Error("hosted context unavailable");
    },
  };

  const result = await buildLocalProjectRealityCheckWithAutoContext(
    {
      dir,
      changedFiles: ["src/auth/middleware.ts"],
      decision: ["DEC-EXPLICIT: auth middleware stays explicit"],
    },
    client
  );

  assert.equal(result.intentLedger.entries[0].sourceDecisionId, "DEC-EXPLICIT");
  assert.ok(
    result.caveats.some((item) => /reviewed-decision auto-linking was unavailable/.test(item))
  );
  assert.ok(result.caveats.some((item) => /document auto-context was unavailable/.test(item)));
});

test("buildLocalProjectRealityCheck parses structured document intent sections", () => {
  const dir = makeTempWorkspace();

  const result = buildLocalProjectRealityCheck({
    dir,
    changedFiles: ["docs/adr-001.md"],
    document: [
      [
        "docs/adr-001.md:Goal: Keep billing settlement atomic",
        "Constraints:",
        "- keep billing synchronous",
        "- avoid Redis cache",
        "Anti-goals:",
        "- eventual consistency in settlement",
        "Rejected alternatives:",
        "- async worker settlement",
        "Owner: billing",
      ].join("\n"),
    ],
  });

  assert.equal(result.intentLedger.version, "intent-ledger-v1");
  assert.equal(result.intentLedger.entries[0].sourceDocumentPath, "docs/adr-001.md");
  assert.equal(result.intentLedger.entries[0].intent.goal, "Keep billing settlement atomic");
  assert.deepEqual(result.intentLedger.entries[0].intent.constraints, [
    "keep billing synchronous",
    "avoid Redis cache",
  ]);
  assert.deepEqual(result.intentLedger.entries[0].intent.antiGoals, [
    "eventual consistency in settlement",
  ]);
  assert.deepEqual(result.intentLedger.entries[0].intent.rejectedAlternatives, [
    "async worker settlement",
  ]);
  assert.equal(result.intentLedger.entries[0].owner, "billing");
  assert.equal(result.intentLedger.entries[0].extraction.mode, "structured_sections");
});

test("buildLocalProjectRealityCheck does not infer anti-goals from unstructured prose", () => {
  const dir = makeTempWorkspace();

  const result = buildLocalProjectRealityCheck({
    dir,
    changedFiles: ["docs/adr-002.md"],
    document: [
      "docs/adr-002.md:Avoid Redis cache here. Rejected async worker settlement last time.",
    ],
  });

  assert.equal(result.intentLedger.version, "intent-ledger-v1");
  assert.equal(result.intentLedger.entries[0].sourceDocumentPath, "docs/adr-002.md");
  assert.deepEqual(result.intentLedger.entries[0].intent.antiGoals, []);
  assert.deepEqual(result.intentLedger.entries[0].intent.rejectedAlternatives, []);
  assert.equal(result.intentLedger.entries[0].extraction.mode, "legacy_source_fields");
  assert.equal(result.intentLedger.entries[0].extraction.fallbackUsed, true);
});

test("buildLocalProjectRealityCheck parses structured decision intent sections", () => {
  const dir = makeTempWorkspace();

  const result = buildLocalProjectRealityCheck({
    dir,
    changedFiles: ["src/auth/middleware.ts"],
    decision: [
      [
        "DEC-001: Goal: Keep auth middleware side effects explicit",
        "Constraints:",
        "- auth middleware stays synchronous",
        "Anti-goals:",
        "- implicit token refresh",
        "Rejected alternatives:",
        "- global side-effect middleware",
        "Owner: platform",
      ].join("\n"),
    ],
  });

  const entry = result.intentLedger.entries[0];
  assert.equal(entry.sourceDecisionId, "DEC-001");
  assert.equal(entry.intent.goal, "Keep auth middleware side effects explicit");
  assert.deepEqual(entry.intent.constraints, ["auth middleware stays synchronous"]);
  assert.deepEqual(entry.intent.antiGoals, ["implicit token refresh"]);
  assert.deepEqual(entry.intent.rejectedAlternatives, ["global side-effect middleware"]);
  assert.equal(entry.owner, "platform");
  assert.equal(entry.extraction.mode, "structured_sections");
});

test("reality-check prints structured JSON for supplied changed files", () => {
  const dir = makeTempWorkspace();
  const result = runCli(
    [
      "reality-check",
      "--changed-files",
      "src/auth/middleware.ts",
      "--diff-summary",
      "Expose public token handling in auth middleware.",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "review_required");
  assert.equal(parsed.source, "local");
  assert.equal(parsed.changedFileCount, 1);
  assert.equal(parsed.intentLedger.version, "intent-ledger-v1");
  assert.equal(parsed.intentLedger.coverage, "missing");
  assert.equal(parsed.unknownRegistry.version, "unknown-registry-v1");
  assert.ok(parsed.unknownRegistry.categories.includes("missing_intent"));
  assert.ok(parsed.unknownRegistry.categories.includes("missing_verification"));
  assert.ok(parsed.findings.some((finding) => finding.reasonCodes.includes("auth_security")));
});

test("reality-check prints Intent Ledger section", () => {
  const dir = makeTempWorkspace();
  const result = runCli(
    [
      "reality-check",
      "--changed-files",
      "src/auth/middleware.ts",
      "--decision",
      "DEC-001: auth middleware must keep side effects explicit",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Intent Ledger:/);
  assert.match(result.stdout, /Coverage: linked/);
  assert.match(result.stdout, /intent:DEC-001/);
  assert.match(result.stdout, /Unknown Registry:/);
});

test("reality-check --enforce exits non-zero for review-required findings", () => {
  const dir = makeTempWorkspace();
  const result = runCli(
    [
      "reality-check",
      "--changed-files",
      "src/auth/middleware.ts",
      "--diff-summary",
      "Expose public token handling in auth middleware.",
      "--enforce",
      "--json",
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "review_required");
});

test("buildLocalProjectRealityCheck preserves dirty git file paths", () => {
  const dir = makeTempWorkspace();
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agent@example.com"]);
  runGit(dir, ["config", "user.name", "Agent"]);
  fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  const filePath = path.join(dir, "src", "auth", "session.ts");
  fs.writeFileSync(filePath, "export const session = true;\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "init"]);
  fs.writeFileSync(filePath, "export const session = 'dirty';\n", "utf8");

  const result = buildLocalProjectRealityCheck({
    dir,
    task: "change auth session",
    diffSummary: "dirty auth session change",
  });

  const dirtyFinding = result.findings.find((finding) =>
    finding.reasonCodes.includes("dirty_working_tree")
  );
  assert.ok(dirtyFinding);
  assert.ok(dirtyFinding.changedFiles.includes("src/auth/session.ts"));
  assert.ok(
    result.findings.some((finding) => finding.changedFiles.includes("src/auth/session.ts"))
  );
});
