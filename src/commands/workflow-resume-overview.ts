/** Bounded presentation of existing receipts; this projection grants no authority. */
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const rows = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
const unique = (value: string[]) => [...new Set(value)];
const pick = (value: Data, keys: string[]): Data => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
export const WORKFLOW_RESUME_OVERVIEW_VERSION = "snipara.workflow.resume-overview.v1";
export const WORKFLOW_RESUME_OVERVIEW_MAX_BYTES = 16 * 1024;
export const WORKFLOW_RESUME_OVERVIEW_MAX_TOKENS = 2000;
const detail = ["snipara-companion", "workflow", "resume", "--detail", "--json"];
export function renderWorkflowResumeOverview(value: Data, json = true): string {
  return `${json ? "" : "Workflow Resume (overview)\n"}${JSON.stringify(value, null, 2)}\n`;
}
export function buildWorkflowResumeOverview(payload: Data, options: { maxTokens?: number; json?: boolean } = {}): Data {
  const maxTokens = options.maxTokens ?? WORKFLOW_RESUME_OVERVIEW_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > WORKFLOW_RESUME_OVERVIEW_MAX_TOKENS)
    throw new Error("Overview token budget must be an integer from 128 to 2000");
  const state = object(payload.workflow), continuity = object(payload.continuity), cp = object(continuity.checkpoint);
  const phase = rows(state.phases).find(item => item.id === state.currentPhaseId) ?? {};
  const task = rows(phase.tasks).find(item => item.id === phase.currentTaskId) ?? rows(phase.tasks).find(item => !["completed", "skipped"].includes(String(item.status))) ?? {};
  const relevant = (item: Data) => (!item.phaseId || item.phaseId === phase.id) && (!item.taskId || item.taskId === task.id);
  const changed = object(object(payload.what_changed_resume).data).whatChanged;
  const whatChanged = object(changed), policy = object(object(whatChanged.continuity).policy);
  const judgment = object(object(state.judgment).resolution);
  const contextOutputs = rows(payload.task_contexts).flatMap(item => {
    const output = object(item.output); return [output, ...rows(output.results), ...rows(output.context_queries)];
  });
  const required = {
    blockers: unique([...texts(continuity.reasons), ...texts(cp.blockers)]),
    diagnostics: rows(continuity.diagnostics).filter(item => item.required === true),
    changes: texts(continuity.changes),
    taskContextErrors: rows(payload.task_context_errors),
    contextReceipt: task.contextReceipt ?? null,
    contextConstraints: contextOutputs.filter(item => item.answer_pack || object(item.retrieval_diagnostics).source_conflict).map(item => ({
      caveats: object(item.answer_pack).caveats ?? [], denials: object(item.answer_pack).what_not_to_claim ?? [],
      sourceConflict: object(item.retrieval_diagnostics).source_conflict ?? null,
    })),
    constraints: unique(rows(cp.attempts).filter(relevant).flatMap(item => texts(item.constraints))),
    acceptance: task.acceptance ?? phase.acceptance ?? null,
    failedChecks: rows(cp.missingChecks).filter(relevant),
    authority: Object.keys(judgment).length ? pick(judgment, ["state", "canProceed", "pendingExplicitRecommendationIds", "hardBlockerCodes", "evidence"]) : null,
    policy: Object.keys(policy).length ? policy : null,
    freshness: whatChanged.freshness ?? null,
    criticalAssumptions: rows(whatChanged.staleAssumptions).filter(item => item.severity === "critical"),
    runtimeBoundary: texts(continuity.runtimeBoundary),
  };
  const value: Data = {
    version: WORKFLOW_RESUME_OVERVIEW_VERSION, status: "overview",
    workflow: pick(state, ["workflowId", "status", "currentPhaseId"]),
    task: pick(task, ["id", "status", "attempt", "maxAttempts", "outcome", "recoveryTaskId"]),
    continuity: { status: continuity.status ?? "unknown", checkpoint: state.continuity ?? null },
    required,
    nextAction: continuity.nextAction ?? { argv: detail, dispatchesWork: false },
    observations: { activity: payload.local_session_snapshot_status ?? "unknown", activityError: payload.local_session_snapshot_error ?? null,
      hostedContext: payload.session_bootstrap_error ? "unavailable" : "received", hostedError: payload.session_bootstrap_error ?? null },
    detail: { argv: detail, workflowState: ".snipara/workflow/current.json", sections: ["workflow", "task_contexts", "session_bootstrap", "what_changed_resume", "runtime_resume"] },
    omitted: { otherChecks: rows(cp.missingChecks).filter(item => !relevant(item)).length, historicalAttempts: rows(cp.attempts).length,
      hostedMemories: rows(object(payload.session_bootstrap).critical_memories).length, fullContext: true },
    caveat: "Overview is a local projection, not proof of safety, refreshed context or permission. Use --detail before acting on omitted context.",
  };
  const measure = (candidate: Data): Data => {
    candidate.budget = { estimator: "ceil(UTF-8 bytes / 4); estimate, not model-token count", maxTokens, maxBytes: WORKFLOW_RESUME_OVERVIEW_MAX_BYTES, usedTokens: 0, usedBytes: 0 };
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.byteLength(renderWorkflowResumeOverview(candidate, options.json !== false), "utf8");
      Object.assign(object(candidate.budget), { usedTokens: Math.ceil(bytes / 4), usedBytes: bytes });
    }
    return candidate;
  };
  const fits = (candidate: Data) => {
    const budget = object(measure(candidate).budget);
    return Number(budget.usedTokens) <= maxTokens && Number(budget.usedBytes) <= WORKFLOW_RESUME_OVERVIEW_MAX_BYTES;
  };
  if (!fits(value)) {
    // Do not silently truncate an unresolved denial, mandatory check, freshness gap or locator.
    const failure: Data = { version: WORKFLOW_RESUME_OVERVIEW_VERSION, status: "overview_incomplete",
      error: "Required blockers, constraints, freshness or exact locators do not fit. No continuation decision is supplied.",
      continuityStatus: continuity.status ?? "unknown", detail: { argv: detail, workflowState: ".snipara/workflow/current.json", checkpoint: state.continuity ?? null } };
    if (fits(failure)) return failure;
    return measure({ version: WORKFLOW_RESUME_OVERVIEW_VERSION, status: "budget_too_small", error: "Envelope cannot represent required context. Read full detail.", detail: { argv: detail } });
  }
  // Optional task prose/actions are added only when the complete envelope still fits.
  for (const [key, item] of Object.entries({ goal: state.goal, taskTitle: task.title,
    recommendedActions: texts(whatChanged.recommendedActions).slice(0, 3) })) {
    if (item === undefined) continue;
    value[key] = item;
    if (!fits(value)) delete value[key];
  }
  return measure(value);
}
