const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cliPath = path.join(__dirname, "..", "dist", "index.js");

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "snipara-agent-context-"));
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "docs", "shared.md"), "# Shared\n");
  fs.writeFileSync(path.join(cwd, "docs", "code.md"), "# Code\n");
  fs.writeFileSync(path.join(cwd, "docs", "security.md"), "# Security\n");
  const agent = (id, role) => ({
    agentId: id,
    displayName: id,
    roles: [role],
    budget: {
      totalTokens: 5000,
      organizationTokens: 500,
      projectTokens: 1000,
      roleTokens: 2000,
      memoryTokens: 1000,
    },
    memory: {
      localCategory: `agent:${id}`,
      defaultWriteScope: "agent",
      promotionRequiresReview: true,
      promotionTargets: [{ scope: "project", category: `role:${role}` }],
    },
  });
  const manifest = {
    schemaVersion: "snipara.agent_context_manifest.v0",
    organization: {
      sourceIds: ["shared"],
      memory: [{ scope: "team", category: "organization:fixture" }],
    },
    project: {
      id: "fixture",
      sourceIds: [],
      memory: [{ scope: "project", category: "project:fixture" }],
    },
    sources: [
      {
        id: "shared",
        path: "docs/shared.md",
        authority: "canonical",
        tier: "HOT",
      },
      {
        id: "code",
        path: "docs/code.md",
        authority: "canonical",
        tier: "HOT",
      },
      {
        id: "security",
        path: "docs/security.md",
        authority: "canonical",
        tier: "HOT",
      },
    ],
    roles: {
      code: {
        description: "Implement.",
        capabilities: ["implementation"],
        boundaries: ["No deploy."],
        queryHints: ["code graph"],
        sourceIds: ["code"],
        memory: [{ scope: "project", category: "role:code" }],
      },
      security: {
        description: "Review security.",
        capabilities: ["security review"],
        boundaries: ["No secret output."],
        queryHints: ["threat model"],
        sourceIds: ["security"],
        memory: [{ scope: "project", category: "role:security" }],
      },
    },
    agents: {
      code: agent("code-agent", "code"),
      security: agent("security-agent", "security"),
    },
  };
  fs.writeFileSync(
    path.join(cwd, "snipara.agent-context.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return { cwd, manifest };
}

test("agent-context validate checks the local manifest and source files", () => {
  const { cwd } = createFixture();
  const result = runCli(["agent-context", "validate", "--json"], cwd);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "valid");
  assert.deepEqual(Object.keys(report.manifest.agents), ["code", "security"]);
});

test("agent-context resolve excludes sources and memory from other roles", () => {
  const { cwd } = createFixture();
  const result = runCli(
    ["agent-context", "resolve", "--agent", "code", "--task", "Implement the resolver", "--json"],
    cwd
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const resolution = JSON.parse(result.stdout);
  assert.deepEqual(
    resolution.sources.map((source) => source.id),
    ["shared", "code"]
  );
  assert.deepEqual(resolution.excludedRoleSourceIds, ["security"]);
  assert.equal(
    resolution.memory.recall.some((request) => request.category === "role:security"),
    false
  );
  assert.equal(resolution.memory.defaultWrite.scope, "agent");
  assert.ok(resolution.memory.promotion.every((target) => target.reviewRequired));
});

test("agent-context validate fails closed when a declared source is missing", () => {
  const { cwd } = createFixture();
  fs.rmSync(path.join(cwd, "docs", "security.md"));
  const result = runCli(["agent-context", "validate", "--json"], cwd);

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "invalid");
  assert.ok(report.findings.some((finding) => finding.id === "source_file_missing"));
});

test("agent-context evidence records an immutable policy-bound receipt", () => {
  const { cwd } = createFixture();
  const evidencePath = path.join(cwd, "evidence.json");
  const ledgerPath = path.join(cwd, ".snipara", "agent-context", "evidence.jsonl");
  const template = runCli(
    [
      "agent-context",
      "evidence",
      "template",
      "--agent",
      "code",
      "--task",
      "Implement a bounded change",
      "--output",
      evidencePath,
    ],
    cwd
  );
  assert.equal(template.status, 0, template.stderr || template.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  evidence.taskId = "task-code-1";
  evidence.usedSourceIds = ["shared", "code"];
  evidence.executedRecallKeys = [
    "agent:code-agent:agent:code-agent",
    "team:organization:fixture",
    "project:project:fixture",
    "project:role:code",
  ];
  evidence.memoryQuality = "precise";
  evidence.observedTotalTokens = 1800;
  evidence.contextEffect = "helped";
  evidence.benefitCodes = ["less_noise"];
  evidence.outcome = {
    status: "passed",
    summary: "Focused verification passed.",
    proofRefs: ["test/agent-context.test.js"],
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const recorded = runCli(
    [
      "agent-context",
      "evidence",
      "record",
      "--from",
      evidencePath,
      "--ledger",
      ledgerPath,
      "--json",
    ],
    cwd
  );
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  const receipt = JSON.parse(recorded.stdout);
  assert.equal(receipt.taskId, "task-code-1");
  assert.deepEqual(receipt.context.excludedRoleSourceIds, ["security"]);
  assert.match(receipt.receiptHash, /^sha256:/);
  assert.equal(fs.readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);

  const duplicate = runCli(
    ["agent-context", "evidence", "record", "--from", evidencePath, "--ledger", ledgerPath],
    cwd
  );
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
});

test("agent-context evidence status stays enforceably blocked below the exit gate", () => {
  const { cwd } = createFixture();
  const status = runCli(["agent-context", "evidence", "status", "--json"], cwd);

  assert.equal(status.status, 0, status.stderr || status.stdout);
  const report = JSON.parse(status.stdout);
  assert.equal(report.status, "blocked");
  assert.equal(report.receiptCount, 0);
  assert.deepEqual(report.missingRoles, ["code", "security"]);

  const enforced = runCli(["agent-context", "evidence", "status", "--enforce"], cwd);
  assert.equal(enforced.status, 1);
  assert.match(enforced.stdout, /Tasks: 0\/20/);
});

test("agent-context evidence collect creates a proof-linked draft without claiming retrieval use", () => {
  const { cwd } = createFixture();
  fs.mkdirSync(path.join(cwd, ".snipara", "workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".snipara", "workflow", "current.json"),
    JSON.stringify({
      goal: "Implement a bounded resolver change",
      updatedAt: "2026-08-14T12:00:00.000Z",
      phases: [
        {
          id: "resolver-phase",
          status: "completed",
          outcome: "completed",
          summary: "Focused resolver tests passed.",
          completedAt: "2026-08-14T11:00:00.000Z",
          files: ["docs/code.md", "/Users/alex/private.txt"],
        },
      ],
    })
  );
  const output = path.join(cwd, "evidence-draft.json");
  const result = runCli(
    ["agent-context", "evidence", "collect", "--agent", "code", "--output", output],
    cwd
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const draft = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(draft.task, "Implement a bounded resolver change");
  assert.equal(draft.outcome.status, "passed");
  assert.deepEqual(draft.outcome.proofRefs, ["resolver-phase", "docs/code.md"]);
  assert.deepEqual(draft.usedSourceIds, []);
  assert.deepEqual(draft.executedRecallKeys, []);
});

test("agent-context evidence ledger fails closed when a receipt is edited", () => {
  const { cwd } = createFixture();
  const evidencePath = path.join(cwd, "evidence.json");
  const ledgerPath = path.join(cwd, ".snipara", "agent-context", "evidence.jsonl");
  const template = runCli(
    [
      "agent-context",
      "evidence",
      "template",
      "--agent",
      "code",
      "--task",
      "Implement tamper detection",
      "--output",
      evidencePath,
    ],
    cwd
  );
  assert.equal(template.status, 0, template.stderr || template.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  evidence.taskId = "task-tamper-check";
  evidence.usedSourceIds = ["shared", "code"];
  evidence.executedRecallKeys = [
    "agent:code-agent:agent:code-agent",
    "team:organization:fixture",
    "project:project:fixture",
    "project:role:code",
  ];
  evidence.memoryQuality = "precise";
  evidence.observedTotalTokens = 1200;
  evidence.outcome = {
    status: "passed",
    summary: "Original verified outcome.",
    proofRefs: ["test/agent-context.test.js"],
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const recorded = runCli(
    ["agent-context", "evidence", "record", "--from", evidencePath, "--ledger", ledgerPath],
    cwd
  );
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const receipt = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  receipt.outcome.summary = "Edited after recording.";
  fs.writeFileSync(ledgerPath, `${JSON.stringify(receipt)}\n`);

  const status = runCli(["agent-context", "evidence", "status"], cwd);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /hash mismatch/);
});
