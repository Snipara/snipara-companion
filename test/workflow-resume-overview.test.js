const assert = require("node:assert/strict");
const test = require("node:test");
const { buildWorkflowResumeOverview, renderWorkflowResumeOverview } = require("../dist/index.js");
function payload() {
  return { workflow: { workflowId: "resume-fixture", goal: "Continue current scoped task", status: "blocked", currentPhaseId: "verify",
    continuity: { packId: "cpack_1234567890abcdef", sha256: "a".repeat(64), capturedAt: "2026-10-26T12:00:00Z" },
    phases: [{ id: "verify", currentTaskId: "proof", tasks: [{ id: "proof", title: "Verify source", status: "blocked", attempt: 2, maxAttempts: 3, acceptance: "Keep sentinel behavior", contextReceipt: { packId: "cpack_abcdef1234567890", sha256: "b".repeat(64) } }] }] },
    continuity: { status: "blocked", reasons: ["Required proof missing"], diagnostics: [{ code: "artifact_missing", path: "proof/current.json", required: true, action: "Restore exact proof" }],
      changes: ["source changed"], checkpoint: { blockers: ["Task remains blocked"], attempts: [{ phaseId: "verify", taskId: "proof", constraints: ["SENTINEL: never skip the tenant check"] }],
        missingChecks: [{ phaseId: "verify", taskId: "proof", command: "verify-current", status: "failed" }, { phaseId: "other", taskId: "old", command: "old-check", status: "unknown" }] },
      nextAction: { argv: ["snipara-companion", "workflow", "task-status", "verify", "--json"], dispatchesWork: false }, runtimeBoundary: ["No live process is restored"] },
    task_contexts: [{ output: { answer_pack: { what_not_to_claim: ["SENTINEL: do not deploy"], caveats: [{ claim: "Unverified source", source: { file: "contract.md", lines: [1, 9] } }] } } }],
    what_changed_resume: { data: { whatChanged: { freshness: { codeGraph: { sourceCommitSha: "c".repeat(40), status: "FAILED" } }, recommendedActions: ["Inspect current proof"] } } },
    session_bootstrap: { critical_memories: Array.from({ length: 150 }, () => ({ content: "Historical journal ".repeat(100) })) },
    local_session_snapshot_status: "degraded", local_session_snapshot_error: "Optional activity is oversized" };
}
for (const json of [true, false]) test(`complete ${json ? "JSON" : "human"} overview counts metadata and preserves current blockers/locators`, () => {
  const input = payload(), before = JSON.stringify(input), value = buildWorkflowResumeOverview(input, { json });
  const rendered = renderWorkflowResumeOverview(value, json), bytes = Buffer.byteLength(rendered);
  assert.equal(value.status, "overview");
  assert.ok(bytes <= 16 * 1024); assert.ok(Math.ceil(bytes / 4) <= 2000);
  assert.equal(value.budget.usedBytes, bytes); assert.equal(value.budget.usedTokens, Math.ceil(bytes / 4));
  assert.match(rendered, /never skip the tenant check/); assert.match(rendered, /do not deploy/);
  assert.match(rendered, /proof\/current.json/); assert.match(rendered, /verify-current/);
  assert.match(rendered, /contract.md/); assert.match(rendered, /cpack_abcdef1234567890/);
  assert.doesNotMatch(rendered, /Historical journal|old-check/);
  assert.equal(value.task.attempt, 2); assert.equal(value.task.maxAttempts, 3);
  assert.equal(JSON.stringify(input), before);
});

test("oversized mandatory field yields explicit incomplete envelope without an execution action", () => {
  const input = payload(); input.continuity.reasons = ["SENTINEL blocker ".repeat(5000)];
  const value = buildWorkflowResumeOverview(input), rendered = renderWorkflowResumeOverview(value);
  assert.equal(value.status, "overview_incomplete");
  assert.equal(value.nextAction, undefined); assert.ok(value.detail.argv.includes("--detail"));
  assert.ok(Buffer.byteLength(rendered) <= 16 * 1024); assert.ok(value.budget.usedTokens <= 2000);
  assert.equal(input.continuity.reasons[0].length, "SENTINEL blocker ".repeat(5000).length);
});

test("unicode bytes and tiny envelopes are explicit rather than silently dropping required context", () => {
  const input = payload(); input.continuity.reasons = ["拒绝继续🚫".repeat(5000)];
  for (const maxTokens of [128, 256, 1000, 2000]) {
    const value = buildWorkflowResumeOverview(input, { maxTokens });
    assert.ok(["overview_incomplete", "budget_too_small"].includes(value.status));
    assert.ok(Buffer.byteLength(renderWorkflowResumeOverview(value)) <= 16 * 1024);
    if (value.status !== "budget_too_small") assert.ok(value.budget.usedTokens <= maxTokens);
    assert.equal(value.nextAction, undefined);
  }
  assert.throws(() => buildWorkflowResumeOverview(input, { maxTokens: 2001 }), /128 to 2000/);
});

test("decomposition context query constraints remain visible in the compact view", () => {
  const input = payload();
  input.task_contexts = [{ output: { context_queries: [{ answer_pack: { what_not_to_claim: ["SENTINEL: no implicit retry"] } }] } }];
  const result = buildWorkflowResumeOverview(input);
  assert.equal(result.status, "overview");
  assert.match(renderWorkflowResumeOverview(result), /no implicit retry/);
});
