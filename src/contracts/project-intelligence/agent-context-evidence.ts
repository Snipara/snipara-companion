import { hashDecisionJsonValue } from "./decision-request";
import type { AgentContextResolution } from "./agent-context";

export const AGENT_CONTEXT_EVIDENCE_INPUT_VERSION =
  "snipara.agent_context_evidence_input.v0" as const;
export const AGENT_CONTEXT_EVIDENCE_RECEIPT_VERSION =
  "snipara.agent_context_evidence_receipt.v0" as const;
export const AGENT_CONTEXT_EVIDENCE_REPORT_VERSION =
  "snipara.agent_context_evidence_report.v0" as const;

export const AGENT_CONTEXT_LEAK_SEVERITIES = ["low", "medium", "high"] as const;
export const AGENT_CONTEXT_LEAK_KINDS = ["source", "memory", "promotion", "other"] as const;
export const AGENT_CONTEXT_MEMORY_QUALITIES = [
  "precise",
  "mixed",
  "irrelevant",
  "not_used",
] as const;
export const AGENT_CONTEXT_PROMOTION_OUTCOMES = [
  "accepted",
  "rejected",
  "duplicate",
  "conflicted",
  "pending",
] as const;
export const AGENT_CONTEXT_OUTCOME_STATUSES = ["passed", "partial", "failed", "blocked"] as const;
export const AGENT_CONTEXT_EFFECTS = ["helped", "neutral", "hindered"] as const;
export const AGENT_CONTEXT_RUNTIME_NEEDS = ["cross_machine", "multi_runtime"] as const;

export type AgentContextLeakSeverity = (typeof AGENT_CONTEXT_LEAK_SEVERITIES)[number];
export type AgentContextLeakKind = (typeof AGENT_CONTEXT_LEAK_KINDS)[number];
export type AgentContextMemoryQuality = (typeof AGENT_CONTEXT_MEMORY_QUALITIES)[number];
export type AgentContextPromotionOutcome = (typeof AGENT_CONTEXT_PROMOTION_OUTCOMES)[number];
export type AgentContextOutcomeStatus = (typeof AGENT_CONTEXT_OUTCOME_STATUSES)[number];
export type AgentContextEffect = (typeof AGENT_CONTEXT_EFFECTS)[number];
export type AgentContextRuntimeNeed = (typeof AGENT_CONTEXT_RUNTIME_NEEDS)[number];

export interface AgentContextEvidenceLeak {
  id: string;
  kind: AgentContextLeakKind;
  severity: AgentContextLeakSeverity;
  summary: string;
  resolved: boolean;
  regressionTestRef?: string;
}

export interface AgentContextEvidencePromotion {
  scope: "project" | "team";
  category: string;
  outcome: AgentContextPromotionOutcome;
  evidenceRef?: string;
}

export interface AgentContextEvidenceInput {
  schemaVersion: typeof AGENT_CONTEXT_EVIDENCE_INPUT_VERSION;
  taskId: string;
  agent: string;
  task: string;
  completedAt: string;
  usedSourceIds: string[];
  executedRecallKeys: string[];
  memoryQuality: AgentContextMemoryQuality;
  leaks: AgentContextEvidenceLeak[];
  missingSharedTruthCodes: string[];
  promotions: AgentContextEvidencePromotion[];
  observedTotalTokens: number;
  contextEffect: AgentContextEffect;
  benefitCodes: string[];
  capabilityAssessment: {
    status: "none" | "observed";
    codes: string[];
  };
  runtimeNeeds: AgentContextRuntimeNeed[];
  outcome: {
    status: AgentContextOutcomeStatus;
    summary: string;
    proofRefs: string[];
  };
}

export interface AgentContextEvidenceReceipt {
  schemaVersion: typeof AGENT_CONTEXT_EVIDENCE_RECEIPT_VERSION;
  receiptHash: string;
  inputHash: string;
  recordedAt: string;
  completedAt: string;
  manifestHash: string;
  taskId: string;
  task: string;
  agent: AgentContextResolution["agent"];
  context: {
    includedSourceIds: string[];
    excludedRoleSourceIds: string[];
    usedSourceIds: string[];
    unusedSelectedSourceIds: string[];
  };
  memory: {
    plannedRecallKeys: string[];
    executedRecallKeys: string[];
    unexecutedRecallKeys: string[];
    quality: AgentContextMemoryQuality;
  };
  leaks: AgentContextEvidenceLeak[];
  missingSharedTruthCodes: string[];
  promotions: AgentContextEvidencePromotion[];
  tokenUsage: {
    allocatedTotalTokens: number;
    observedTotalTokens: number;
    withinBudget: boolean;
  };
  contextEffect: AgentContextEffect;
  benefitCodes: string[];
  capabilityAssessment: AgentContextEvidenceInput["capabilityAssessment"];
  runtimeNeeds: AgentContextRuntimeNeed[];
  outcome: AgentContextEvidenceInput["outcome"];
  redaction: {
    redacted: boolean;
    patterns: string[];
  };
  caveats: string[];
}

export interface AgentContextEvidenceCriterion {
  id:
    | "representative_task_count"
    | "configured_role_coverage"
    | "high_severity_leaks_resolved"
    | "leak_regression_coverage"
    | "repeated_benefits_documented"
    | "capability_assessments_documented";
  passed: boolean;
  summary: string;
  actual: number;
  required: number;
  refs: string[];
}

export interface AgentContextEvidenceReport {
  schemaVersion: typeof AGENT_CONTEXT_EVIDENCE_REPORT_VERSION;
  generatedAt: string;
  status: "ready" | "blocked";
  receiptCount: number;
  manifestHashes: string[];
  expectedRoles: string[];
  observedRoles: string[];
  missingRoles: string[];
  criteria: AgentContextEvidenceCriterion[];
  metrics: {
    tasksByRole: Record<string, number>;
    outcomes: Record<AgentContextOutcomeStatus, number>;
    memoryQuality: Record<AgentContextMemoryQuality, number>;
    promotionOutcomes: Record<AgentContextPromotionOutcome, number>;
    leaks: {
      total: number;
      unresolvedHighSeverity: number;
      withoutRegressionTest: number;
    };
    sources: {
      selected: number;
      used: number;
      utilizationRate: number | null;
    };
    tokens: {
      observedTotal: number;
      averagePerTask: number | null;
      overBudgetTasks: number;
    };
    benefitCodes: Record<string, number>;
    missingSharedTruthCodes: Record<string, number>;
    missingCapabilityCodes: Record<string, number>;
    runtimeNeeds: Record<AgentContextRuntimeNeed, number>;
  };
  repeatedBenefitCodes: string[];
  repeatedRuntimeNeedCodes: AgentContextRuntimeNeed[];
  nextActions: string[];
  caveats: string[];
}

export interface BuildAgentContextEvidenceReceiptInput {
  resolution: AgentContextResolution;
  evidence: unknown;
  recordedAt?: string | Date;
}

export interface BuildAgentContextEvidenceReportInput {
  receipts: AgentContextEvidenceReceipt[];
  expectedRoles: string[];
  generatedAt?: string | Date;
  minimumTaskCount?: number;
}

interface Redactor {
  redact(value: string): string;
  patterns(): string[];
}

const MAX_TASK_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 700;
const MAX_REF_LENGTH = 500;
const MAX_LIST_ITEMS = 32;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "secret_assignment",
    pattern:
      /\b(api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;]+/gi,
  },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { name: "snipara_key", pattern: /\bsnp[-_][A-Za-z0-9._~+/=-]{8,}/gi },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}/g },
  { name: "unix_home_path", pattern: /\/(?:Users|home)\/[^/\s]+/g },
  { name: "windows_home_path", pattern: /[A-Za-z]:\\Users\\[^\\\s]+/g },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoTimestamp(value?: string | Date): string {
  const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return parsed.toISOString();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function createRedactor(): Redactor {
  const matched = new Set<string>();
  return {
    redact(value: string): string {
      let result = value;
      for (const item of SECRET_PATTERNS) {
        item.pattern.lastIndex = 0;
        if (!item.pattern.test(result)) {
          item.pattern.lastIndex = 0;
          continue;
        }
        item.pattern.lastIndex = 0;
        result = result.replace(item.pattern, (match) => {
          matched.add(item.name);
          if (item.name === "unix_home_path" || item.name === "windows_home_path") {
            return "<home>";
          }
          const prefix = match.match(/^([^:=\s]+)\s*[:=]/)?.[1]?.trim();
          return prefix ? `${prefix}=<redacted>` : "<redacted>";
        });
        item.pattern.lastIndex = 0;
      }
      return result.replace(/\s+/g, " ").trim();
    },
    patterns(): string[] {
      return [...matched].sort();
    },
  };
}

function requiredText(value: unknown, ref: string, maxLength: number, redactor: Redactor): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${ref} must be non-empty.`);
  return redactor.redact(value).slice(0, maxLength);
}

function safeCode(value: unknown, ref: string): string {
  if (typeof value !== "string" || !SAFE_CODE_PATTERN.test(value.trim())) {
    throw new Error(`${ref} must be a safe identifier.`);
  }
  return value.trim();
}

function codeList(value: unknown, ref: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${ref} must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  return uniqueStrings(value.map((entry, index) => safeCode(entry, `${ref}[${index}]`)));
}

function textList(value: unknown, ref: string, redactor: Redactor): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${ref} must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  return uniqueStrings(
    value.map((entry, index) => requiredText(entry, `${ref}[${index}]`, MAX_REF_LENGTH, redactor))
  );
}

function enumValue<T extends string>(value: unknown, values: readonly T[], ref: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${ref} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function assertSubset(values: string[], allowed: Set<string>, ref: string): void {
  const outside = values.filter((value) => !allowed.has(value));
  if (outside.length > 0) {
    throw new Error(`${ref} contains values outside the resolved policy: ${outside.join(", ")}.`);
  }
}

export function agentContextRecallKey(
  request: AgentContextResolution["memory"]["recall"][number]
): string {
  return request.scope === "agent"
    ? `agent:${request.agentId}:${request.category}`
    : `${request.scope}:${request.category}`;
}

export function buildAgentContextEvidenceTemplate(
  resolution: AgentContextResolution,
  completedAt: string | Date = new Date()
): AgentContextEvidenceInput {
  return {
    schemaVersion: AGENT_CONTEXT_EVIDENCE_INPUT_VERSION,
    taskId: `task-${hashDecisionJsonValue({
      agent: resolution.agent.agentId,
      task: resolution.task,
      manifestHash: resolution.manifestHash,
    }).slice(-12)}`,
    agent: resolution.agent.alias,
    task: resolution.task,
    completedAt: isoTimestamp(completedAt),
    usedSourceIds: [],
    executedRecallKeys: [],
    memoryQuality: "not_used",
    leaks: [],
    missingSharedTruthCodes: [],
    promotions: [],
    observedTotalTokens: 0,
    contextEffect: "neutral",
    benefitCodes: [],
    capabilityAssessment: { status: "none", codes: [] },
    runtimeNeeds: [],
    outcome: {
      status: "blocked",
      summary: "Replace with a bounded outcome summary before recording.",
      proofRefs: [],
    },
  };
}

export function buildAgentContextEvidenceReceipt(
  input: BuildAgentContextEvidenceReceiptInput
): AgentContextEvidenceReceipt {
  if (!isRecord(input.evidence)) throw new Error("Evidence must be a JSON object.");
  const evidence = input.evidence;
  if (evidence.schemaVersion !== AGENT_CONTEXT_EVIDENCE_INPUT_VERSION) {
    throw new Error(`Evidence schemaVersion must be ${AGENT_CONTEXT_EVIDENCE_INPUT_VERSION}.`);
  }
  const redactor = createRedactor();
  const taskId = safeCode(evidence.taskId, "taskId");
  const agent = requiredText(evidence.agent, "agent", 128, redactor);
  if (![input.resolution.agent.alias, input.resolution.agent.agentId].includes(agent)) {
    throw new Error(`agent must match the resolved alias or stable agent id.`);
  }
  const task = requiredText(evidence.task, "task", MAX_TASK_LENGTH, redactor);
  if (task !== redactor.redact(input.resolution.task).slice(0, MAX_TASK_LENGTH)) {
    throw new Error("task must match the task used to resolve Agent Context.");
  }
  const completedAt = isoTimestamp(requiredText(evidence.completedAt, "completedAt", 64, redactor));
  const usedSourceIds = codeList(evidence.usedSourceIds, "usedSourceIds");
  const includedSourceIds = input.resolution.sources.map((source) => source.id);
  assertSubset(usedSourceIds, new Set(includedSourceIds), "usedSourceIds");

  const executedRecallKeys = textList(evidence.executedRecallKeys, "executedRecallKeys", redactor);
  const plannedRecallKeys = input.resolution.memory.recall.map(agentContextRecallKey);
  assertSubset(executedRecallKeys, new Set(plannedRecallKeys), "executedRecallKeys");
  const unexecutedRecallKeys = plannedRecallKeys.filter((key) => !executedRecallKeys.includes(key));
  if (unexecutedRecallKeys.length > 0) {
    throw new Error(
      `executedRecallKeys must include every planned recall: ${unexecutedRecallKeys.join(", ")}.`
    );
  }
  const memoryQuality = enumValue(
    evidence.memoryQuality,
    AGENT_CONTEXT_MEMORY_QUALITIES,
    "memoryQuality"
  );
  if (memoryQuality === "not_used" && executedRecallKeys.length > 0) {
    throw new Error("memoryQuality cannot be not_used when recall evidence was recorded.");
  }
  if (memoryQuality !== "not_used" && executedRecallKeys.length === 0) {
    throw new Error("memoryQuality requires at least one executedRecallKey.");
  }

  if (!Array.isArray(evidence.leaks) || evidence.leaks.length > MAX_LIST_ITEMS) {
    throw new Error(`leaks must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  const leakIds = new Set<string>();
  const leaks = evidence.leaks.map((candidate, index): AgentContextEvidenceLeak => {
    if (!isRecord(candidate)) throw new Error(`leaks[${index}] must be an object.`);
    const id = safeCode(candidate.id, `leaks[${index}].id`);
    if (leakIds.has(id)) throw new Error(`Duplicate leak id: ${id}.`);
    leakIds.add(id);
    const regressionTestRef =
      candidate.regressionTestRef === undefined
        ? undefined
        : requiredText(
            candidate.regressionTestRef,
            `leaks[${index}].regressionTestRef`,
            MAX_REF_LENGTH,
            redactor
          );
    return {
      id,
      kind: enumValue(candidate.kind, AGENT_CONTEXT_LEAK_KINDS, `leaks[${index}].kind`),
      severity: enumValue(
        candidate.severity,
        AGENT_CONTEXT_LEAK_SEVERITIES,
        `leaks[${index}].severity`
      ),
      summary: requiredText(
        candidate.summary,
        `leaks[${index}].summary`,
        MAX_SUMMARY_LENGTH,
        redactor
      ),
      resolved: candidate.resolved === true,
      ...(regressionTestRef ? { regressionTestRef } : {}),
    };
  });

  const missingSharedTruthCodes = codeList(
    evidence.missingSharedTruthCodes,
    "missingSharedTruthCodes"
  );
  if (!Array.isArray(evidence.promotions) || evidence.promotions.length > MAX_LIST_ITEMS) {
    throw new Error(`promotions must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  const allowedPromotionTargets = new Set(
    input.resolution.memory.promotion.map((target) => `${target.scope}:${target.category}`)
  );
  const promotions = evidence.promotions.map((candidate, index): AgentContextEvidencePromotion => {
    if (!isRecord(candidate)) throw new Error(`promotions[${index}] must be an object.`);
    const scope = enumValue(
      candidate.scope,
      ["project", "team"] as const,
      `promotions[${index}].scope`
    );
    const category = safeCode(candidate.category, `promotions[${index}].category`);
    if (!allowedPromotionTargets.has(`${scope}:${category}`)) {
      throw new Error(`promotions[${index}] targets memory outside the resolved policy.`);
    }
    const evidenceRef =
      candidate.evidenceRef === undefined
        ? undefined
        : requiredText(
            candidate.evidenceRef,
            `promotions[${index}].evidenceRef`,
            MAX_REF_LENGTH,
            redactor
          );
    return {
      scope,
      category,
      outcome: enumValue(
        candidate.outcome,
        AGENT_CONTEXT_PROMOTION_OUTCOMES,
        `promotions[${index}].outcome`
      ),
      ...(evidenceRef ? { evidenceRef } : {}),
    };
  });

  if (!Number.isInteger(evidence.observedTotalTokens) || Number(evidence.observedTotalTokens) < 1) {
    throw new Error("observedTotalTokens must be a positive integer.");
  }
  const observedTotalTokens = Number(evidence.observedTotalTokens);
  const contextEffect = enumValue(evidence.contextEffect, AGENT_CONTEXT_EFFECTS, "contextEffect");
  const benefitCodes = codeList(evidence.benefitCodes, "benefitCodes");
  if (contextEffect === "helped" && benefitCodes.length === 0) {
    throw new Error("contextEffect=helped requires at least one benefitCode.");
  }
  if (!isRecord(evidence.capabilityAssessment)) {
    throw new Error("capabilityAssessment must be an object.");
  }
  const capabilityStatus = enumValue(
    evidence.capabilityAssessment.status,
    ["none", "observed"] as const,
    "capabilityAssessment.status"
  );
  const capabilityCodes = codeList(
    evidence.capabilityAssessment.codes,
    "capabilityAssessment.codes"
  );
  if (capabilityStatus === "observed" && capabilityCodes.length === 0) {
    throw new Error("capabilityAssessment.status=observed requires at least one code.");
  }
  if (capabilityStatus === "none" && capabilityCodes.length > 0) {
    throw new Error("capabilityAssessment.status=none cannot include codes.");
  }
  if (!Array.isArray(evidence.runtimeNeeds) || evidence.runtimeNeeds.length > MAX_LIST_ITEMS) {
    throw new Error(`runtimeNeeds must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  const runtimeNeeds = uniqueStrings(
    evidence.runtimeNeeds.map((entry, index) =>
      enumValue(entry, AGENT_CONTEXT_RUNTIME_NEEDS, `runtimeNeeds[${index}]`)
    )
  ) as AgentContextRuntimeNeed[];
  if (!isRecord(evidence.outcome)) throw new Error("outcome must be an object.");
  const proofRefs = textList(evidence.outcome.proofRefs, "outcome.proofRefs", redactor);
  if (proofRefs.length === 0) throw new Error("outcome.proofRefs must include task proof.");

  const normalizedInput: AgentContextEvidenceInput = {
    schemaVersion: AGENT_CONTEXT_EVIDENCE_INPUT_VERSION,
    taskId,
    agent,
    task,
    completedAt,
    usedSourceIds,
    executedRecallKeys,
    memoryQuality,
    leaks,
    missingSharedTruthCodes,
    promotions,
    observedTotalTokens,
    contextEffect,
    benefitCodes,
    capabilityAssessment: { status: capabilityStatus, codes: capabilityCodes },
    runtimeNeeds,
    outcome: {
      status: enumValue(evidence.outcome.status, AGENT_CONTEXT_OUTCOME_STATUSES, "outcome.status"),
      summary: requiredText(
        evidence.outcome.summary,
        "outcome.summary",
        MAX_SUMMARY_LENGTH,
        redactor
      ),
      proofRefs,
    },
  };
  const receiptBase = {
    schemaVersion: AGENT_CONTEXT_EVIDENCE_RECEIPT_VERSION,
    inputHash: hashDecisionJsonValue(normalizedInput),
    recordedAt: isoTimestamp(input.recordedAt),
    completedAt,
    manifestHash: input.resolution.manifestHash,
    taskId,
    task,
    agent: input.resolution.agent,
    context: {
      includedSourceIds,
      excludedRoleSourceIds: input.resolution.excludedRoleSourceIds,
      usedSourceIds,
      unusedSelectedSourceIds: includedSourceIds.filter(
        (sourceId) => !usedSourceIds.includes(sourceId)
      ),
    },
    memory: {
      plannedRecallKeys,
      executedRecallKeys,
      unexecutedRecallKeys,
      quality: memoryQuality,
    },
    leaks,
    missingSharedTruthCodes,
    promotions,
    tokenUsage: {
      allocatedTotalTokens: input.resolution.budget.totalTokens,
      observedTotalTokens,
      withinBudget: observedTotalTokens <= input.resolution.budget.totalTokens,
    },
    contextEffect,
    benefitCodes,
    capabilityAssessment: normalizedInput.capabilityAssessment,
    runtimeNeeds,
    outcome: normalizedInput.outcome,
    redaction: {
      redacted: redactor.patterns().length > 0,
      patterns: redactor.patterns(),
    },
    caveats: [
      "This receipt records reviewed dogfood evidence; it is not durable memory or causal proof.",
      "Agent Context resolution plans retrieval but does not prove that a source or memory was used.",
      "Secret-like fragments and local home paths are redacted before the receipt is emitted.",
    ],
  };
  return {
    ...receiptBase,
    receiptHash: hashDecisionJsonValue(receiptBase),
  };
}

function emptyCounter<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export function buildAgentContextEvidenceReport(
  input: BuildAgentContextEvidenceReportInput
): AgentContextEvidenceReport {
  const minimumTaskCount = input.minimumTaskCount ?? 20;
  if (!Number.isInteger(minimumTaskCount) || minimumTaskCount < 1) {
    throw new Error("minimumTaskCount must be a positive integer.");
  }
  const duplicateTaskIds = input.receipts
    .map((receipt) => receipt.taskId)
    .filter((taskId, index, values) => values.indexOf(taskId) !== index);
  if (duplicateTaskIds.length > 0) {
    throw new Error(
      `Duplicate task ids in evidence ledger: ${uniqueStrings(duplicateTaskIds).join(", ")}.`
    );
  }
  const expectedRoles = uniqueStrings(
    input.expectedRoles.map((role) => safeCode(role, "expectedRoles"))
  );
  if (expectedRoles.length === 0) throw new Error("expectedRoles must not be empty.");
  const observedRoles = uniqueStrings(
    input.receipts.flatMap((receipt) => receipt.agent.roles)
  ).sort();
  const missingRoles = expectedRoles.filter((role) => !observedRoles.includes(role));
  const unresolvedHighLeaks = input.receipts.flatMap((receipt) =>
    receipt.leaks
      .filter((leak) => leak.severity === "high" && !leak.resolved)
      .map((leak) => `${receipt.taskId}:${leak.id}`)
  );
  const leaksWithoutRegression = input.receipts.flatMap((receipt) =>
    receipt.leaks
      .filter((leak) => !leak.regressionTestRef)
      .map((leak) => `${receipt.taskId}:${leak.id}`)
  );
  const benefitCodes: Record<string, number> = {};
  const missingSharedTruthCodes: Record<string, number> = {};
  const missingCapabilityCodes: Record<string, number> = {};
  const runtimeNeeds = emptyCounter(AGENT_CONTEXT_RUNTIME_NEEDS);
  const tasksByRole: Record<string, number> = {};
  const outcomes = emptyCounter(AGENT_CONTEXT_OUTCOME_STATUSES);
  const memoryQuality = emptyCounter(AGENT_CONTEXT_MEMORY_QUALITIES);
  const promotionOutcomes = emptyCounter(AGENT_CONTEXT_PROMOTION_OUTCOMES);
  let selectedSources = 0;
  let usedSources = 0;
  let observedTokens = 0;
  let overBudgetTasks = 0;

  for (const receipt of input.receipts) {
    receipt.agent.roles.forEach((role) => increment(tasksByRole, role));
    increment(outcomes, receipt.outcome.status);
    increment(memoryQuality, receipt.memory.quality);
    receipt.promotions.forEach((promotion) => increment(promotionOutcomes, promotion.outcome));
    receipt.benefitCodes.forEach((code) => increment(benefitCodes, code));
    receipt.missingSharedTruthCodes.forEach((code) => increment(missingSharedTruthCodes, code));
    receipt.capabilityAssessment.codes.forEach((code) => increment(missingCapabilityCodes, code));
    receipt.runtimeNeeds.forEach((need) => increment(runtimeNeeds, need));
    selectedSources += receipt.context.includedSourceIds.length;
    usedSources += receipt.context.usedSourceIds.length;
    observedTokens += receipt.tokenUsage.observedTotalTokens;
    if (!receipt.tokenUsage.withinBudget) overBudgetTasks += 1;
  }
  const repeatedBenefitCodes = Object.entries(benefitCodes)
    .filter(([, count]) => count >= 2)
    .map(([code]) => code)
    .sort();
  const repeatedRuntimeNeedCodes = AGENT_CONTEXT_RUNTIME_NEEDS.filter(
    (need) => runtimeNeeds[need] >= 2
  );
  const criteria: AgentContextEvidenceCriterion[] = [
    {
      id: "representative_task_count",
      passed: input.receipts.length >= minimumTaskCount,
      summary: `${input.receipts.length}/${minimumTaskCount} representative tasks recorded.`,
      actual: input.receipts.length,
      required: minimumTaskCount,
      refs: input.receipts.map((receipt) => receipt.taskId),
    },
    {
      id: "configured_role_coverage",
      passed: missingRoles.length === 0,
      summary:
        missingRoles.length === 0
          ? `All configured roles are represented: ${expectedRoles.join(", ")}.`
          : `Missing role evidence: ${missingRoles.join(", ")}.`,
      actual: expectedRoles.length - missingRoles.length,
      required: expectedRoles.length,
      refs: observedRoles,
    },
    {
      id: "high_severity_leaks_resolved",
      passed: unresolvedHighLeaks.length === 0,
      summary: `${unresolvedHighLeaks.length} unresolved high-severity leak(s).`,
      actual: unresolvedHighLeaks.length,
      required: 0,
      refs: unresolvedHighLeaks,
    },
    {
      id: "leak_regression_coverage",
      passed: leaksWithoutRegression.length === 0,
      summary: `${leaksWithoutRegression.length} observed leak(s) lack a regression-test reference.`,
      actual: leaksWithoutRegression.length,
      required: 0,
      refs: leaksWithoutRegression,
    },
    {
      id: "repeated_benefits_documented",
      passed: repeatedBenefitCodes.length > 0,
      summary:
        repeatedBenefitCodes.length > 0
          ? `Repeated benefits: ${repeatedBenefitCodes.join(", ")}.`
          : "No benefit code has repeated across two tasks yet.",
      actual: repeatedBenefitCodes.length,
      required: 1,
      refs: repeatedBenefitCodes,
    },
    {
      id: "capability_assessments_documented",
      passed: input.receipts.length >= minimumTaskCount,
      summary: `${input.receipts.length} task-level missing-capability assessments recorded.`,
      actual: input.receipts.length,
      required: minimumTaskCount,
      refs: Object.keys(missingCapabilityCodes).sort(),
    },
  ];
  const nextActions = criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => {
      if (criterion.id === "representative_task_count") {
        return `Record ${minimumTaskCount - input.receipts.length} more representative task(s).`;
      }
      if (criterion.id === "configured_role_coverage") {
        return `Record evidence for missing role(s): ${missingRoles.join(", ")}.`;
      }
      if (criterion.id === "high_severity_leaks_resolved") {
        return "Resolve every high-severity cross-role leak before considering AC-1 complete.";
      }
      if (criterion.id === "leak_regression_coverage") {
        return "Add a regression-test reference for every observed leak.";
      }
      if (criterion.id === "repeated_benefits_documented") {
        return "Use stable benefit codes so repeated value can be demonstrated across tasks.";
      }
      return "Complete the missing-capability assessment for every representative task.";
    });
  return {
    schemaVersion: AGENT_CONTEXT_EVIDENCE_REPORT_VERSION,
    generatedAt: isoTimestamp(input.generatedAt),
    status: criteria.every((criterion) => criterion.passed) ? "ready" : "blocked",
    receiptCount: input.receipts.length,
    manifestHashes: uniqueStrings(input.receipts.map((receipt) => receipt.manifestHash)).sort(),
    expectedRoles,
    observedRoles,
    missingRoles,
    criteria,
    metrics: {
      tasksByRole,
      outcomes,
      memoryQuality,
      promotionOutcomes,
      leaks: {
        total: input.receipts.reduce((count, receipt) => count + receipt.leaks.length, 0),
        unresolvedHighSeverity: unresolvedHighLeaks.length,
        withoutRegressionTest: leaksWithoutRegression.length,
      },
      sources: {
        selected: selectedSources,
        used: usedSources,
        utilizationRate: selectedSources > 0 ? usedSources / selectedSources : null,
      },
      tokens: {
        observedTotal: observedTokens,
        averagePerTask: input.receipts.length > 0 ? observedTokens / input.receipts.length : null,
        overBudgetTasks,
      },
      benefitCodes,
      missingSharedTruthCodes,
      missingCapabilityCodes,
      runtimeNeeds,
    },
    repeatedBenefitCodes,
    repeatedRuntimeNeedCodes,
    nextActions,
    caveats: [
      "Ready means only that the documented AC-1 dogfood exit gate is satisfied.",
      "Repeated runtime-need signals do not authorize AC-2 without a reviewed external design partner.",
      "Task outcomes are observed associations and must not be presented as causal model improvement.",
    ],
  };
}

export function isAgentContextEvidenceReceipt(
  value: unknown
): value is AgentContextEvidenceReceipt {
  if (!isRecord(value) || value.schemaVersion !== AGENT_CONTEXT_EVIDENCE_RECEIPT_VERSION) {
    return false;
  }
  const agent = value.agent;
  const context = value.context;
  const memory = value.memory;
  const tokenUsage = value.tokenUsage;
  const capabilityAssessment = value.capabilityAssessment;
  const outcome = value.outcome;
  const redaction = value.redaction;
  return (
    typeof value.receiptHash === "string" &&
    typeof value.inputHash === "string" &&
    typeof value.recordedAt === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.manifestHash === "string" &&
    typeof value.taskId === "string" &&
    typeof value.task === "string" &&
    isRecord(agent) &&
    typeof agent.alias === "string" &&
    typeof agent.agentId === "string" &&
    typeof agent.displayName === "string" &&
    Array.isArray(agent.roles) &&
    agent.roles.every((role) => typeof role === "string") &&
    isRecord(context) &&
    [
      context.includedSourceIds,
      context.excludedRoleSourceIds,
      context.usedSourceIds,
      context.unusedSelectedSourceIds,
    ].every(
      (candidate) =>
        Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")
    ) &&
    isRecord(memory) &&
    [memory.plannedRecallKeys, memory.executedRecallKeys, memory.unexecutedRecallKeys].every(
      (candidate) =>
        Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")
    ) &&
    AGENT_CONTEXT_MEMORY_QUALITIES.includes(memory.quality as AgentContextMemoryQuality) &&
    Array.isArray(value.leaks) &&
    value.leaks.every(
      (leak) =>
        isRecord(leak) &&
        typeof leak.id === "string" &&
        AGENT_CONTEXT_LEAK_KINDS.includes(leak.kind as AgentContextLeakKind) &&
        AGENT_CONTEXT_LEAK_SEVERITIES.includes(leak.severity as AgentContextLeakSeverity) &&
        typeof leak.summary === "string" &&
        typeof leak.resolved === "boolean" &&
        (leak.regressionTestRef === undefined || typeof leak.regressionTestRef === "string")
    ) &&
    Array.isArray(value.missingSharedTruthCodes) &&
    value.missingSharedTruthCodes.every((code) => typeof code === "string") &&
    Array.isArray(value.promotions) &&
    value.promotions.every(
      (promotion) =>
        isRecord(promotion) &&
        (promotion.scope === "project" || promotion.scope === "team") &&
        typeof promotion.category === "string" &&
        AGENT_CONTEXT_PROMOTION_OUTCOMES.includes(
          promotion.outcome as AgentContextPromotionOutcome
        ) &&
        (promotion.evidenceRef === undefined || typeof promotion.evidenceRef === "string")
    ) &&
    isRecord(tokenUsage) &&
    typeof tokenUsage.allocatedTotalTokens === "number" &&
    Number.isFinite(tokenUsage.allocatedTotalTokens) &&
    typeof tokenUsage.observedTotalTokens === "number" &&
    Number.isFinite(tokenUsage.observedTotalTokens) &&
    typeof tokenUsage.withinBudget === "boolean" &&
    AGENT_CONTEXT_EFFECTS.includes(value.contextEffect as AgentContextEffect) &&
    Array.isArray(value.benefitCodes) &&
    value.benefitCodes.every((code) => typeof code === "string") &&
    isRecord(capabilityAssessment) &&
    (capabilityAssessment.status === "none" || capabilityAssessment.status === "observed") &&
    Array.isArray(capabilityAssessment.codes) &&
    capabilityAssessment.codes.every((code) => typeof code === "string") &&
    Array.isArray(value.runtimeNeeds) &&
    value.runtimeNeeds.every((need) =>
      AGENT_CONTEXT_RUNTIME_NEEDS.includes(need as AgentContextRuntimeNeed)
    ) &&
    isRecord(outcome) &&
    AGENT_CONTEXT_OUTCOME_STATUSES.includes(outcome.status as AgentContextOutcomeStatus) &&
    typeof outcome.summary === "string" &&
    Array.isArray(outcome.proofRefs) &&
    outcome.proofRefs.every((proof) => typeof proof === "string") &&
    isRecord(redaction) &&
    typeof redaction.redacted === "boolean" &&
    Array.isArray(redaction.patterns) &&
    redaction.patterns.every((pattern) => typeof pattern === "string") &&
    Array.isArray(value.caveats) &&
    value.caveats.every((caveat) => typeof caveat === "string")
  );
}
