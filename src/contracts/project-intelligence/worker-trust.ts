import { hashDecisionJsonValue } from "./decision-request";

export const WORKER_TRUST_EVENT_VERSION = "snipara.worker_trust_event.v1" as const;

export const WORKER_TRUST_CATEGORIES = [
  "docs_low_risk",
  "tests_low_risk",
  "code_low_risk",
  "code_shared",
  "release_surface",
  "sensitive_surface",
  "unknown",
] as const;

export const WORKER_TRUST_STATES = [
  "probation_supervised",
  "advisory_earned",
  "delegated_earned",
  "demoted",
] as const;

export type WorkerTrustCategory = (typeof WORKER_TRUST_CATEGORIES)[number];
export type WorkerTrustState = (typeof WORKER_TRUST_STATES)[number];
export type WorkerTrustTarget = "advisory_earned" | "delegated_earned";

export interface WorkerTrustEvidenceWindow {
  reviewedSamples: number;
  verifiedSamples: number;
  blockedSamples: number;
  incompleteReceiptSamples: number;
  realWorkflowSamples: number;
  distinctSessionsOrDays: number;
  since: string;
  receiptRefs: string[];
  safetyViolations: string[];
}

export interface WorkerTrustCandidate {
  workerId: string;
  workCategory: WorkerTrustCategory;
  profileHash: string;
  targetState: WorkerTrustTarget | null;
  eligible: boolean;
  hardGateReady: false;
  evidence: WorkerTrustEvidenceWindow;
  reasonCodes: string[];
  nextRequired: string[];
}

export interface WorkerTrustEvent {
  schemaVersion: typeof WORKER_TRUST_EVENT_VERSION;
  eventId: string;
  generatedAt: string;
  workerId: string;
  workCategory: WorkerTrustCategory;
  profileHash: string;
  previousState: WorkerTrustState;
  state: WorkerTrustState;
  hardGateReady: boolean;
  evidence: WorkerTrustEvidenceWindow;
  decision: {
    requestId: string;
    responseChoice: "approve" | "reject" | "demote";
    reviewer: string;
    resolvedAt: string;
  };
  ceilings: {
    writeScope: string[];
    riskCeiling: "low";
    expiresAt: string;
    rollbackConditions: string[];
  };
  reasonCodes: string[];
}

export interface WorkerTrustGateInput {
  event: WorkerTrustEvent | null | undefined;
  workerId: string;
  workCategory: WorkerTrustCategory;
  profileHash: string;
  requestedWriteScope: string[];
  risk: "low" | "medium" | "high" | "critical";
  explicitExecute: boolean;
  proofRequired: string[];
  now?: string | Date;
}

export interface WorkerTrustGateDecision {
  delegated: boolean;
  approvalReceiptRequired: boolean;
  hardGateReady: boolean;
  reasonCodes: string[];
}

const WORKER_TRUST_CATEGORY_RANK: Record<WorkerTrustCategory, number> = {
  docs_low_risk: 0,
  tests_low_risk: 0,
  code_low_risk: 1,
  code_shared: 2,
  release_surface: 3,
  sensitive_surface: 4,
  unknown: 5,
};

export function deriveWorkerTrustCategory(input: {
  declared?: WorkerTrustCategory;
  task?: string;
  writeScope?: string[];
}): WorkerTrustCategory {
  const text = [input.task ?? "", ...(input.writeScope ?? [])].join(" ").toLowerCase();
  let derived: WorkerTrustCategory;
  if (
    /(^|[\s/_.-])(auth|oauth|billing|secret|credential|migration|prisma|schema|database|production[ _-]?data)([\s/_.-]|$)/.test(
      text
    )
  ) {
    derived = "sensitive_surface";
  } else if (
    /(^|[\s/_.-])(deploy|release|publish|package\.json|pyproject\.toml|public[ _-]?docs)([\s/_.-]|$)/.test(
      text
    )
  ) {
    derived = "release_surface";
  } else if (
    (input.writeScope ?? []).length > 0 &&
    (input.writeScope ?? []).every((scope) => /(^|\/)docs?\//.test(scope))
  ) {
    derived = "docs_low_risk";
  } else if (
    (input.writeScope ?? []).length > 0 &&
    (input.writeScope ?? []).every((scope) => /(^|\/)(test|tests|__tests__)(\/|$)/.test(scope))
  ) {
    derived = "tests_low_risk";
  } else if (/(^|[\s/_.-])(contract|shared|route|service|job)([\s/_.-]|$)/.test(text)) {
    derived = "code_shared";
  } else if ((input.writeScope ?? []).length > 0) {
    derived = "code_low_risk";
  } else {
    derived = "unknown";
  }
  const declared = input.declared;
  if (!declared) return derived;
  return WORKER_TRUST_CATEGORY_RANK[declared] >= WORKER_TRUST_CATEGORY_RANK[derived]
    ? declared
    : derived;
}

export function isWorkerTrustEvent(value: unknown): value is WorkerTrustEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<WorkerTrustEvent>;
  const decision = event.decision as Partial<WorkerTrustEvent["decision"]> | undefined;
  const ceilings = event.ceilings as Partial<WorkerTrustEvent["ceilings"]> | undefined;
  const evidence = event.evidence as Partial<WorkerTrustEvidenceWindow> | undefined;
  const generatedAt = Date.parse(String(event.generatedAt ?? ""));
  const resolvedAt = Date.parse(String(decision?.resolvedAt ?? ""));
  const expiresAt = Date.parse(String(ceilings?.expiresAt ?? ""));
  const expectedEventId = `worker-trust-${hashDecisionJsonValue({
    workerId: event.workerId,
    workCategory: event.workCategory,
    profileHash: event.profileHash,
    state: event.state,
    requestId: decision?.requestId,
    resolvedAt: decision?.resolvedAt,
  })
    .replace(/^sha256:/, "")
    .slice(0, 16)}`;
  return (
    event.schemaVersion === WORKER_TRUST_EVENT_VERSION &&
    typeof event.eventId === "string" &&
    /^worker-trust-[a-f0-9]{16}$/.test(event.eventId) &&
    event.eventId === expectedEventId &&
    typeof event.workerId === "string" &&
    event.workerId.trim().length > 0 &&
    WORKER_TRUST_CATEGORIES.includes(event.workCategory as WorkerTrustCategory) &&
    WORKER_TRUST_STATES.includes(event.previousState as WorkerTrustState) &&
    WORKER_TRUST_STATES.includes(event.state as WorkerTrustState) &&
    event.hardGateReady === (event.state === "delegated_earned") &&
    typeof event.profileHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(event.profileHash) &&
    Number.isFinite(generatedAt) &&
    Number.isFinite(resolvedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > resolvedAt &&
    expiresAt - resolvedAt <= 90 * 24 * 60 * 60 * 1000 &&
    typeof decision?.requestId === "string" &&
    decision.requestId.trim().length > 0 &&
    typeof decision.reviewer === "string" &&
    decision.reviewer.trim().length > 0 &&
    ["approve", "reject", "demote"].includes(String(decision.responseChoice)) &&
    (event.state === "delegated_earned" || event.state === "advisory_earned"
      ? decision.responseChoice === "approve"
      : true) &&
    ceilings?.riskCeiling === "low" &&
    Array.isArray(ceilings.writeScope) &&
    ceilings.writeScope.every(isSafeScope) &&
    Array.isArray(ceilings.rollbackConditions) &&
    ceilings.rollbackConditions.length > 0 &&
    ceilings.rollbackConditions.every(
      (item) => typeof item === "string" && item.trim().length > 0
    ) &&
    hasEvidenceShape(evidence)
  );
}

export function buildWorkerTrustCandidate(input: {
  workerId: string;
  workCategory: WorkerTrustCategory;
  profileHash: string;
  evidence: WorkerTrustEvidenceWindow;
}): WorkerTrustCandidate {
  const evidence = normalizeEvidence(input.evidence);
  const reasons = new Set<string>();
  const nextRequired: string[] = [];
  const eligibleCategory = ["docs_low_risk", "tests_low_risk", "code_low_risk"].includes(
    input.workCategory
  );
  if (!eligibleCategory) reasons.add("worker_trust_category_supervised_only");
  if (evidence.blockedSamples > 0) reasons.add("worker_trust_blocked_sample_present");
  if (evidence.incompleteReceiptSamples > 0) reasons.add("worker_trust_incomplete_receipt_family");
  if (evidence.safetyViolations.length > 0) reasons.add("worker_trust_safety_violation");

  const commonSafe =
    eligibleCategory &&
    evidence.blockedSamples === 0 &&
    evidence.incompleteReceiptSamples === 0 &&
    evidence.safetyViolations.length === 0;
  const delegatedEligible =
    commonSafe &&
    evidence.reviewedSamples >= 10 &&
    evidence.verifiedSamples >= 8 &&
    evidence.realWorkflowSamples >= 3 &&
    evidence.distinctSessionsOrDays >= 2;
  const advisoryEligible =
    commonSafe && evidence.reviewedSamples >= 5 && evidence.verifiedSamples >= 3;

  if (evidence.reviewedSamples < 5)
    nextRequired.push(`${5 - evidence.reviewedSamples} more reviewed sample(s) for advisory trust`);
  if (evidence.verifiedSamples < 3)
    nextRequired.push(`${3 - evidence.verifiedSamples} more verified sample(s) for advisory trust`);
  if (advisoryEligible && evidence.reviewedSamples < 10)
    nextRequired.push(`${10 - evidence.reviewedSamples} more reviewed sample(s) for delegation`);
  if (advisoryEligible && evidence.verifiedSamples < 8)
    nextRequired.push(`${8 - evidence.verifiedSamples} more verified sample(s) for delegation`);
  if (advisoryEligible && evidence.realWorkflowSamples < 3)
    nextRequired.push(`${3 - evidence.realWorkflowSamples} more real workflow sample(s)`);
  if (advisoryEligible && evidence.distinctSessionsOrDays < 2)
    nextRequired.push(`${2 - evidence.distinctSessionsOrDays} more distinct session or day(s)`);
  if (commonSafe && (advisoryEligible || delegatedEligible))
    reasons.add("worker_trust_decision_request_required");

  return {
    workerId: normalizeId(input.workerId),
    workCategory: input.workCategory,
    profileHash: normalizeHash(input.profileHash),
    targetState: delegatedEligible
      ? "delegated_earned"
      : advisoryEligible
        ? "advisory_earned"
        : null,
    eligible: delegatedEligible || advisoryEligible,
    hardGateReady: false,
    evidence,
    reasonCodes: [...reasons].sort(),
    nextRequired,
  };
}

export function buildWorkerTrustEvent(input: {
  candidate: WorkerTrustCandidate;
  previousState?: WorkerTrustState;
  targetState: WorkerTrustTarget | "demoted";
  requestId: string;
  responseChoice: "approve" | "reject" | "demote";
  reviewer: string;
  resolvedAt?: string | Date;
  generatedAt?: string | Date;
  writeScope: string[];
  expiresAt: string | Date;
  rollbackConditions?: string[];
}): WorkerTrustEvent {
  const generatedAt = isoTimestamp(input.generatedAt);
  const resolvedAt = isoTimestamp(input.resolvedAt);
  const expiresAt = isoTimestamp(input.expiresAt);
  const approved = input.responseChoice === "approve";
  const reviewer = input.reviewer.trim();
  const requestId = input.requestId.trim();
  const resolvedTime = Date.parse(resolvedAt);
  const expiryTime = Date.parse(expiresAt);
  const writeScope = uniqueStrings(input.writeScope);
  const rollbackConditions = uniqueStrings(
    input.rollbackConditions ?? [
      "blocked proof",
      "out-of-scope write",
      "ledger verification failure",
      "worker profile hash mismatch",
      "secret exposure",
    ]
  );
  if (!reviewer) throw new Error("Worker trust review needs a reviewer.");
  if (!requestId) throw new Error("Worker trust review needs a Decision Request id.");
  if (writeScope.some((scope) => !isSafeScope(scope))) {
    throw new Error("Worker trust write scope is unsafe.");
  }
  if (rollbackConditions.length === 0) {
    throw new Error("Worker trust needs at least one rollback condition.");
  }
  if (expiryTime <= resolvedTime || expiryTime - resolvedTime > 90 * 24 * 60 * 60 * 1000) {
    throw new Error("Worker trust expiry must be between 1 millisecond and 90 days.");
  }
  if (approved && !input.candidate.eligible) {
    throw new Error("Cannot approve an ineligible worker trust candidate.");
  }
  if (approved && input.targetState !== input.candidate.targetState) {
    throw new Error("Approved state must match the eligible trust candidate target.");
  }
  const state: WorkerTrustState = approved ? input.targetState : "demoted";
  const core = {
    workerId: input.candidate.workerId,
    workCategory: input.candidate.workCategory,
    profileHash: input.candidate.profileHash,
    state,
    requestId,
    resolvedAt,
  };
  const eventHash = hashDecisionJsonValue(core).replace(/^sha256:/, "");
  return {
    schemaVersion: WORKER_TRUST_EVENT_VERSION,
    eventId: `worker-trust-${eventHash.slice(0, 16)}`,
    generatedAt,
    workerId: input.candidate.workerId,
    workCategory: input.candidate.workCategory,
    profileHash: input.candidate.profileHash,
    previousState: input.previousState ?? "probation_supervised",
    state,
    hardGateReady: state === "delegated_earned",
    evidence: input.candidate.evidence,
    decision: {
      requestId,
      responseChoice: input.responseChoice,
      reviewer,
      resolvedAt,
    },
    ceilings: {
      writeScope,
      riskCeiling: "low",
      expiresAt,
      rollbackConditions,
    },
    reasonCodes: [
      approved ? "worker_trust_promotion_approved" : "worker_trust_demotion_recorded",
      `worker_trust_state_${state}`,
    ],
  };
}

export function evaluateWorkerTrustGate(input: WorkerTrustGateInput): WorkerTrustGateDecision {
  const reasons = new Set<string>(["worker_trust_gate_v1"]);
  const event = isWorkerTrustEvent(input.event) ? input.event : null;
  if (!input.explicitExecute) reasons.add("worker_trust_explicit_execute_required");
  if (input.event && !event) reasons.add("worker_trust_event_invalid");
  if (!event) reasons.add("worker_trust_event_missing");
  if (event && event.workerId !== normalizeId(input.workerId))
    reasons.add("worker_trust_worker_mismatch");
  if (event && event.workCategory !== input.workCategory)
    reasons.add("worker_trust_category_mismatch");
  if (event && event.profileHash !== normalizeHash(input.profileHash))
    reasons.add("worker_trust_profile_hash_mismatch");
  if (event && event.state !== "delegated_earned") reasons.add("worker_trust_not_delegated");
  if (event && !event.hardGateReady) reasons.add("worker_trust_hard_gate_not_ready");
  if (event && event.decision.responseChoice !== "approve")
    reasons.add("worker_trust_decision_not_approved");
  if (event && !evidenceSupportsDelegation(event.evidence))
    reasons.add("worker_trust_evidence_below_delegation_threshold");
  if (event && new Date(event.ceilings.expiresAt).getTime() <= isoDate(input.now).getTime())
    reasons.add("worker_trust_grant_expired");
  if (input.risk !== "low") reasons.add("worker_trust_risk_above_low");
  if (!["docs_low_risk", "tests_low_risk", "code_low_risk"].includes(input.workCategory))
    reasons.add("worker_trust_sensitive_category_blocked");
  if (input.proofRequired.length === 0) reasons.add("worker_trust_proof_contract_required");
  if (
    event &&
    !input.requestedWriteScope.every((scope) =>
      event.ceilings.writeScope.some((allowed) => scopeCoveredBy(scope, allowed))
    )
  ) {
    reasons.add("worker_trust_write_scope_exceeded");
  }
  const delegated = reasons.size === 1;
  if (delegated) reasons.add("worker_trust_delegated_gate_consumed");
  return {
    delegated,
    approvalReceiptRequired: !delegated,
    hardGateReady: delegated,
    reasonCodes: [...reasons].sort(),
  };
}

function normalizeEvidence(value: WorkerTrustEvidenceWindow): WorkerTrustEvidenceWindow {
  return {
    reviewedSamples: count(value.reviewedSamples),
    verifiedSamples: count(value.verifiedSamples),
    blockedSamples: count(value.blockedSamples),
    incompleteReceiptSamples: count(value.incompleteReceiptSamples),
    realWorkflowSamples: count(value.realWorkflowSamples),
    distinctSessionsOrDays: count(value.distinctSessionsOrDays),
    since: isoTimestamp(value.since),
    receiptRefs: uniqueStrings(value.receiptRefs),
    safetyViolations: uniqueStrings(value.safetyViolations),
  };
}

function scopeCoveredBy(requested: string, allowed: string): boolean {
  const request = requested.replace(/\\/g, "/").replace(/^\.\//, "");
  const ceiling = allowed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!isSafeScope(request) || !isSafeScope(ceiling)) return false;
  if (ceiling === "**" || ceiling === "**/*") return true;
  if (ceiling.endsWith("/**")) {
    const prefix = ceiling.slice(0, -3).replace(/\/$/, "");
    return request === prefix || request.startsWith(`${prefix}/`);
  }
  return request === ceiling || request.startsWith(`${ceiling}/`);
}

function hasEvidenceShape(
  evidence: Partial<WorkerTrustEvidenceWindow> | undefined
): evidence is WorkerTrustEvidenceWindow {
  return Boolean(
    evidence &&
    [
      evidence.reviewedSamples,
      evidence.verifiedSamples,
      evidence.blockedSamples,
      evidence.incompleteReceiptSamples,
      evidence.realWorkflowSamples,
      evidence.distinctSessionsOrDays,
    ].every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0) &&
    Number.isFinite(Date.parse(String(evidence.since ?? ""))) &&
    Array.isArray(evidence.receiptRefs) &&
    evidence.receiptRefs.every((item) => typeof item === "string") &&
    Array.isArray(evidence.safetyViolations) &&
    evidence.safetyViolations.every((item) => typeof item === "string")
  );
}

function evidenceSupportsDelegation(evidence: WorkerTrustEvidenceWindow): boolean {
  return (
    evidence.reviewedSamples >= 10 &&
    evidence.verifiedSamples >= 8 &&
    evidence.realWorkflowSamples >= 3 &&
    evidence.distinctSessionsOrDays >= 2 &&
    evidence.blockedSamples === 0 &&
    evidence.incompleteReceiptSamples === 0 &&
    evidence.safetyViolations.length === 0
  );
}

function isSafeScope(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return Boolean(
    normalized &&
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..") &&
    !normalized.includes("\0")
  );
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeId(value: string): string {
  return value.trim() || "unassigned-worker";
}

function normalizeHash(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function isoDate(value: string | Date | undefined): Date {
  return value instanceof Date ? value : new Date(value ?? Date.now());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
