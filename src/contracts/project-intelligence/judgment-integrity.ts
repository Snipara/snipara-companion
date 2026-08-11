import { randomUUID } from "node:crypto";
import { hashDecisionJsonValue } from "./decision-request";

export const JUDGMENT_SNAPSHOT_VERSION = "snipara.judgment_snapshot.v1" as const;
export const JUDGMENT_EXPOSURE_VERSION = "snipara.judgment_exposure.v1" as const;
export const JUDGMENT_SNAPSHOT_MAX_STRING_CHARS = 20_000;
export const JUDGMENT_SNAPSHOT_MAX_ARRAY_ITEMS = 200;
export const JUDGMENT_SNAPSHOT_MAX_OBJECT_KEYS = 200;
export const JUDGMENT_SNAPSHOT_MAX_DEPTH = 12;

export type JudgmentJsonPrimitive = string | number | boolean | null;
export type JudgmentJsonValue =
  | JudgmentJsonPrimitive
  | JudgmentJsonValue[]
  | { [key: string]: JudgmentJsonValue };

export type JudgmentExposureSurface =
  | "web_api"
  | "dashboard"
  | "companion"
  | "github_pr_answer_pack"
  | "automation"
  | "unknown";

export interface JudgmentSnapshotProvenance {
  briefVersion: string;
  engineVersion: string;
  judgmentVersion: string;
  algorithmVersion: string;
  codeIndexCommitSha: string | null;
  codeIndexStatus: "current" | "stale" | "missing" | "incomplete" | "unknown";
  codeIndexCoveragePercent: number | null;
  sourceFreshness: JudgmentJsonValue;
  featureFlags: JudgmentJsonValue;
}

export interface JudgmentSnapshot {
  schemaVersion: typeof JUDGMENT_SNAPSHOT_VERSION;
  snapshotId: string;
  contentHash: string;
  generatedAt: string;
  projectId: string;
  task: string | null;
  anchors: string[];
  input: JudgmentJsonValue;
  judgment: JudgmentJsonValue;
  provenance: JudgmentSnapshotProvenance;
}

export interface JudgmentExposure {
  schemaVersion: typeof JUDGMENT_EXPOSURE_VERSION;
  exposureId: string;
  snapshotId: string;
  servedJudgmentId: string | null;
  surface: JudgmentExposureSurface;
  runId: string | null;
  sessionId: string | null;
  servedAt: string;
  metadata: JudgmentJsonValue;
}

export interface BuildJudgmentSnapshotInput {
  generatedAt?: string | Date;
  projectId: string;
  task?: string | null;
  anchors?: string[];
  input?: unknown;
  judgment: unknown;
  provenance: Pick<
    JudgmentSnapshotProvenance,
    "briefVersion" | "engineVersion" | "judgmentVersion" | "algorithmVersion"
  > & {
    codeIndexCommitSha?: string | null;
    codeIndexStatus?: JudgmentSnapshotProvenance["codeIndexStatus"];
    codeIndexCoveragePercent?: number | null;
    sourceFreshness?: unknown;
    featureFlags?: unknown;
  };
}

export interface BuildJudgmentExposureInput {
  exposureId?: string;
  snapshotId: string;
  servedJudgmentId?: string | null;
  surface?: JudgmentExposureSurface;
  runId?: string | null;
  sessionId?: string | null;
  servedAt?: string | Date;
  metadata?: unknown;
}

const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token)/i;
const INLINE_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|snp|rlm)[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:postgres(?:ql)?|redis):\/\/[^\s]+/gi,
];

export function buildJudgmentSnapshot(input: BuildJudgmentSnapshotInput): JudgmentSnapshot {
  const generatedAt = isoTimestamp(input.generatedAt);
  const anchors = normalizeStrings(input.anchors ?? [], 120);
  const task = boundedOptionalString(input.task, 700);
  const sanitizedInput = sanitizeJudgmentJson(input.input ?? {});
  const judgment = sanitizeJudgmentJson(input.judgment);
  const provenance: JudgmentSnapshotProvenance = {
    briefVersion: boundedRequiredString(input.provenance.briefVersion, 120, "unknown-brief"),
    engineVersion: boundedRequiredString(input.provenance.engineVersion, 120, "unknown-engine"),
    judgmentVersion: boundedRequiredString(
      input.provenance.judgmentVersion,
      120,
      "unknown-judgment"
    ),
    algorithmVersion: boundedRequiredString(
      input.provenance.algorithmVersion,
      120,
      input.provenance.judgmentVersion
    ),
    codeIndexCommitSha: boundedOptionalString(input.provenance.codeIndexCommitSha, 160),
    codeIndexStatus: normalizeIndexStatus(input.provenance.codeIndexStatus),
    codeIndexCoveragePercent: normalizeCoverage(input.provenance.codeIndexCoveragePercent),
    sourceFreshness: sanitizeJudgmentJson(input.provenance.sourceFreshness ?? {}),
    featureFlags: sanitizeJudgmentJson(input.provenance.featureFlags ?? {}),
  };
  const hashPayload = {
    projectId: boundedRequiredString(input.projectId, 180, "unknown-project"),
    task,
    anchors,
    input: sanitizedInput,
    judgment,
    provenance,
  };
  const contentHash = hashDecisionJsonValue(hashPayload);

  return {
    schemaVersion: JUDGMENT_SNAPSHOT_VERSION,
    snapshotId: `judgment-snapshot:${contentHash.replace(/^sha256:/, "").slice(0, 24)}`,
    contentHash,
    generatedAt,
    projectId: hashPayload.projectId,
    task,
    anchors,
    input: sanitizedInput,
    judgment,
    provenance,
  };
}

export function buildJudgmentExposure(input: BuildJudgmentExposureInput): JudgmentExposure {
  return {
    schemaVersion: JUDGMENT_EXPOSURE_VERSION,
    exposureId: boundedOptionalString(input.exposureId, 180) ?? `judgment-exposure:${randomUUID()}`,
    snapshotId: boundedRequiredString(input.snapshotId, 180, "unknown-snapshot"),
    servedJudgmentId: boundedOptionalString(input.servedJudgmentId, 180),
    surface: normalizeExposureSurface(input.surface),
    runId: boundedOptionalString(input.runId, 180),
    sessionId: boundedOptionalString(input.sessionId, 180),
    servedAt: isoTimestamp(input.servedAt),
    metadata: sanitizeJudgmentJson(input.metadata ?? {}),
  };
}

export function sanitizeJudgmentJson(value: unknown): JudgmentJsonValue {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): JudgmentJsonValue {
  if (depth >= JUDGMENT_SNAPSHOT_MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, JUDGMENT_SNAPSHOT_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output: Record<string, JudgmentJsonValue> = {};
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, JUDGMENT_SNAPSHOT_MAX_OBJECT_KEYS);
  for (const [rawKey, item] of entries) {
    const key = rawKey.slice(0, 160);
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function redactString(value: string): string {
  let redacted = value.slice(0, JUDGMENT_SNAPSHOT_MAX_STRING_CHARS);
  for (const pattern of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted
    .replace(/\/Users\/[^/\s]+\/?/g, "$WORKSPACE/")
    .replace(/\/home\/[^/\s]+\/?/g, "$WORKSPACE/");
}

function normalizeStrings(values: string[], limit: number): string[] {
  return [
    ...new Set(
      values
        .map((value) => boundedOptionalString(value, 900))
        .filter((value): value is string => value !== null)
    ),
  ].slice(0, limit);
}

function boundedRequiredString(
  value: string | null | undefined,
  maxChars: number,
  fallback: string
): string {
  return boundedOptionalString(value, maxChars) ?? fallback;
}

function boundedOptionalString(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function normalizeCoverage(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function normalizeIndexStatus(
  value: JudgmentSnapshotProvenance["codeIndexStatus"] | undefined
): JudgmentSnapshotProvenance["codeIndexStatus"] {
  return value && ["current", "stale", "missing", "incomplete", "unknown"].includes(value)
    ? value
    : "unknown";
}

function normalizeExposureSurface(
  value: JudgmentExposureSurface | undefined
): JudgmentExposureSurface {
  return value &&
    [
      "web_api",
      "dashboard",
      "companion",
      "github_pr_answer_pack",
      "automation",
      "unknown",
    ].includes(value)
    ? value
    : "unknown";
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}
