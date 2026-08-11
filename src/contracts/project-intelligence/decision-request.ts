import { createHash } from "node:crypto";

export const DECISION_REQUEST_VERSION = "snipara.decision_request.v0" as const;
export const DECISION_RESPONSE_VERSION = "snipara.decision_response.v0" as const;
export const DECISION_REQUEST_RELATIVE_DIR = ".snipara/decisions" as const;

export type DecisionRequestProducerKind =
  | "producer_loop_triage"
  | "outcome_capture"
  | "memory_review_queue"
  | "memory_duplicate_candidate"
  | "memory_clean_candidate"
  | "memory_verify"
  | "memory_invalidate"
  | "document_tombstone"
  | "unknown_registry_risk"
  | "project_policy_review"
  | "policy_suggestion"
  | "worker_trust_promotion"
  | "hosted_context_control";

export type DecisionRequestApplyPath =
  | "workflow producer-review"
  | "snipara_memory_resolve_queue_item"
  | "snipara_memory_verify"
  | "snipara_memory_invalidate"
  | "workers trust review"
  | "manual_context_review"
  | "context-control hosted-apply";

export interface DecisionRequestProducer {
  kind: DecisionRequestProducerKind;
  command: string;
  sourceRef?: string;
}

export interface DecisionRequestEvidence {
  summary: string;
  refs: string[];
  items?: DecisionRequestEvidenceItem[];
  reasonCodes: string[];
  files?: string[];
  applyPath?: DecisionRequestApplyPath;
  applyCommand?: string;
}

export interface DecisionRequestEvidenceItem {
  ref: string;
  title?: string;
  summary?: string;
  kind?: string;
  status?: string;
  files?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DecisionRequest {
  schemaVersion: typeof DECISION_REQUEST_VERSION;
  requestId: string;
  fingerprint: string;
  createdAt: string;
  producer: DecisionRequestProducer;
  decision: string;
  question: string;
  evidence: DecisionRequestEvidence;
  options: string[];
  recommendation?: string;
  rationale?: string;
  blocking: boolean;
  expiresAt: string | null;
}

export interface DecisionResponse {
  schemaVersion: typeof DECISION_RESPONSE_VERSION;
  requestId: string;
  resolvedAt: string;
  choice: string;
  reviewer: string;
  note?: string;
  appliedActions: string[];
}

export interface BuildDecisionRequestInput {
  createdAt?: string | Date;
  producer: DecisionRequestProducer;
  decision: string;
  question: string;
  evidence: DecisionRequestEvidence;
  options: string[];
  recommendation?: string;
  rationale?: string;
  blocking?: boolean;
  expiresAt?: string | Date | null;
  fingerprintParts?: unknown[];
}

export interface BuildDecisionResponseInput {
  requestId: string;
  resolvedAt?: string | Date;
  choice: string;
  reviewer: string;
  note?: string;
  appliedActions?: string[];
}

export function stableDecisionJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function hashDecisionContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashDecisionJsonValue(value: unknown): string {
  return `sha256:${hashDecisionContent(stableDecisionJsonStringify(value))}`;
}

export function buildDecisionFingerprint(input: BuildDecisionRequestInput): string {
  return hashDecisionJsonValue(
    input.fingerprintParts ?? [
      input.producer.kind,
      input.producer.sourceRef ?? "",
      input.decision,
      input.question,
      input.options,
      input.evidence.refs,
      input.evidence.reasonCodes,
    ]
  );
}

export function buildDecisionRequest(input: BuildDecisionRequestInput): DecisionRequest {
  const createdAt = isoTimestamp(input.createdAt);
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null
      ? null
      : isoTimestamp(input.expiresAt);
  const options = uniqueStrings(input.options);
  if (options.length === 0) {
    throw new Error("Decision request needs at least one option.");
  }
  if (input.recommendation && !options.includes(input.recommendation)) {
    throw new Error(`Decision recommendation '${input.recommendation}' is not a valid option.`);
  }
  const fingerprint = buildDecisionFingerprint(input);
  return {
    schemaVersion: DECISION_REQUEST_VERSION,
    requestId: `decision-${hashDecisionContent(fingerprint).slice(0, 16)}`,
    fingerprint,
    createdAt,
    producer: {
      ...input.producer,
      ...(normalizeOptionalString(input.producer.sourceRef)
        ? { sourceRef: normalizeOptionalString(input.producer.sourceRef) }
        : {}),
    },
    decision: input.decision,
    question: input.question,
    evidence: {
      summary: input.evidence.summary,
      refs: uniqueStrings(input.evidence.refs),
      ...(input.evidence.items ? { items: normalizeEvidenceItems(input.evidence.items) } : {}),
      reasonCodes: uniqueStrings(input.evidence.reasonCodes),
      ...(input.evidence.files ? { files: uniqueStrings(input.evidence.files) } : {}),
      ...(input.evidence.applyPath ? { applyPath: input.evidence.applyPath } : {}),
      ...(normalizeOptionalString(input.evidence.applyCommand)
        ? { applyCommand: normalizeOptionalString(input.evidence.applyCommand) }
        : {}),
    },
    options,
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
    ...(normalizeOptionalString(input.rationale)
      ? { rationale: normalizeOptionalString(input.rationale) }
      : {}),
    blocking: Boolean(input.blocking),
    expiresAt,
  };
}

export function buildDecisionResponse(input: BuildDecisionResponseInput): DecisionResponse {
  return {
    schemaVersion: DECISION_RESPONSE_VERSION,
    requestId: input.requestId,
    resolvedAt: isoTimestamp(input.resolvedAt),
    choice: input.choice,
    reviewer: input.reviewer,
    ...(normalizeOptionalString(input.note) ? { note: normalizeOptionalString(input.note) } : {}),
    appliedActions: uniqueStrings(input.appliedActions ?? []),
  };
}

export function isDecisionRequest(value: unknown): value is DecisionRequest {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== DECISION_REQUEST_VERSION) return false;
  if (!isRecord(value.producer) || !isRecord(value.evidence)) return false;
  return (
    typeof value.requestId === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.producer.kind === "string" &&
    typeof value.producer.command === "string" &&
    typeof value.decision === "string" &&
    typeof value.question === "string" &&
    Array.isArray(value.options) &&
    typeof value.blocking === "boolean" &&
    (typeof value.expiresAt === "string" || value.expiresAt === null)
  );
}

export function isDecisionResponse(value: unknown): value is DecisionResponse {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === DECISION_RESPONSE_VERSION &&
    typeof value.requestId === "string" &&
    typeof value.resolvedAt === "string" &&
    typeof value.choice === "string" &&
    typeof value.reviewer === "string" &&
    Array.isArray(value.appliedActions)
  );
}

export function decisionRequestStatus(
  request: DecisionRequest,
  resolvedFingerprints: ReadonlySet<string>,
  now: string | Date = new Date()
): "pending" | "resolved" | "expired_pending" {
  if (resolvedFingerprints.has(request.fingerprint)) {
    return "resolved";
  }
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= new Date(now).getTime()) {
    return "expired_pending";
  }
  return "pending";
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeEvidenceItems(
  items: DecisionRequestEvidenceItem[]
): DecisionRequestEvidenceItem[] {
  const seen = new Set<string>();
  const normalized: DecisionRequestEvidenceItem[] = [];
  for (const item of items) {
    const ref = item.ref.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    normalized.push({
      ref,
      ...(normalizeOptionalString(item.title)
        ? { title: normalizeOptionalString(item.title) }
        : {}),
      ...(normalizeOptionalString(item.summary)
        ? { summary: normalizeOptionalString(item.summary) }
        : {}),
      ...(normalizeOptionalString(item.kind) ? { kind: normalizeOptionalString(item.kind) } : {}),
      ...(normalizeOptionalString(item.status)
        ? { status: normalizeOptionalString(item.status) }
        : {}),
      ...(item.files ? { files: uniqueStrings(item.files) } : {}),
      ...(item.metadata ? { metadata: normalizeMetadata(item.metadata) } : {}),
    });
  }
  return normalized;
}

function normalizeMetadata(
  metadata: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }
  return value;
}
