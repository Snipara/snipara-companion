import { hashDecisionJsonValue } from "./decision-request";
import type { ProjectPolicyVerdict } from "./project-policy";

export const OUTCOME_INTELLIGENCE_RECEIPT_VERSION =
  "snipara.outcome_intelligence.receipt.v0" as const;
export const OUTCOME_INTELLIGENCE_CALIBRATION_VERSION =
  "snipara.outcome_intelligence.calibration.v0" as const;

export type OutcomeIntelligenceTaskKind =
  | "bugfix"
  | "feature"
  | "docs"
  | "release"
  | "deploy"
  | "refactor"
  | "investigation"
  | "unknown";

export type OutcomeIntelligenceRiskLevel = "low" | "medium" | "high" | "critical";

export type OutcomeIntelligenceSurface =
  | "web"
  | "backend"
  | "database"
  | "package"
  | "docs"
  | "security"
  | "workflow"
  | "memory"
  | "unknown";

export type OutcomeIntelligenceStatus = "success" | "failure" | "blocked" | "partial" | "unknown";

export type OutcomeIntelligenceEvidenceStatus = "passed" | "failed" | "warning" | "skipped";

export interface OutcomeIntelligenceTaskProfile {
  kind: OutcomeIntelligenceTaskKind;
  risk: OutcomeIntelligenceRiskLevel;
  surfaces: OutcomeIntelligenceSurface[];
  changedFiles: string[];
  workflowFingerprint?: string;
}

export interface OutcomeIntelligenceEvidence {
  source:
    | "test"
    | "typecheck"
    | "lint"
    | "build"
    | "deploy_health"
    | "hosted_mcp"
    | "package_publish"
    | "review"
    | "guard"
    | "manual";
  label: string;
  status: OutcomeIntelligenceEvidenceStatus;
  command?: string;
  detail?: string;
}

export interface OutcomeIntelligenceReceipt {
  version: typeof OUTCOME_INTELLIGENCE_RECEIPT_VERSION;
  receiptId: string;
  generatedAt: string;
  sourceRef: string;
  taskProfile: OutcomeIntelligenceTaskProfile;
  decision: {
    summary: string;
    reasonCodes: string[];
    policyVerdict?: ProjectPolicyVerdict;
    advisorRecommendationIds?: string[];
  };
  verification: {
    evidence: OutcomeIntelligenceEvidence[];
    passedCount: number;
    failedCount: number;
    warningCount: number;
    skippedCount: number;
  };
  outcome: {
    status: OutcomeIntelligenceStatus;
    summary: string;
  };
  caveats: string[];
}

export interface BuildOutcomeIntelligenceReceiptInput {
  generatedAt?: string | Date;
  sourceRef: string;
  taskProfile: Partial<OutcomeIntelligenceTaskProfile>;
  decision: {
    summary: string;
    reasonCodes?: string[];
    policyVerdict?: ProjectPolicyVerdict;
    advisorRecommendationIds?: string[];
  };
  evidence?: OutcomeIntelligenceEvidence[];
  outcome?: {
    status?: OutcomeIntelligenceStatus;
    summary?: string;
  };
}

export interface OutcomeIntelligenceCalibrationBucket {
  key: string;
  reasonCode: string;
  taskKind: OutcomeIntelligenceTaskKind;
  risk: OutcomeIntelligenceRiskLevel;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  partialCount: number;
  unknownCount: number;
  positiveRate: number | null;
  confidence: "thin" | "emerging" | "usable";
  caveats: string[];
}

export interface OutcomeIntelligenceCalibration {
  version: typeof OUTCOME_INTELLIGENCE_CALIBRATION_VERSION;
  generatedAt: string;
  receiptCount: number;
  buckets: OutcomeIntelligenceCalibrationBucket[];
  caveats: string[];
}

export interface BuildOutcomeIntelligenceCalibrationInput {
  receipts: OutcomeIntelligenceReceipt[];
  generatedAt?: string | Date;
  minSamplesForUsable?: number;
}

const DEFAULT_MIN_SAMPLES_FOR_USABLE = 5;

export function buildOutcomeIntelligenceReceipt(
  input: BuildOutcomeIntelligenceReceiptInput
): OutcomeIntelligenceReceipt {
  const generatedAt = isoTimestamp(input.generatedAt);
  const taskProfile = normalizeTaskProfile(input.taskProfile);
  const evidence = normalizeEvidence(input.evidence ?? []);
  const status = normalizeOutcomeStatus(input.outcome?.status, evidence);
  const receiptCore = {
    sourceRef: input.sourceRef,
    taskProfile,
    decision: input.decision,
    evidence,
    outcome: status,
  };
  const receiptHash = hashDecisionJsonValue(receiptCore).replace(/^sha256:/, "");

  return {
    version: OUTCOME_INTELLIGENCE_RECEIPT_VERSION,
    receiptId: `outcome-${receiptHash.slice(0, 16)}`,
    generatedAt,
    sourceRef: input.sourceRef.trim() || "local",
    taskProfile,
    decision: {
      summary: compactText(input.decision.summary) || "Outcome decision requires review.",
      reasonCodes: uniqueStrings(input.decision.reasonCodes ?? []),
      ...(input.decision.policyVerdict ? { policyVerdict: input.decision.policyVerdict } : {}),
      ...(input.decision.advisorRecommendationIds
        ? { advisorRecommendationIds: uniqueStrings(input.decision.advisorRecommendationIds) }
        : {}),
    },
    verification: {
      evidence,
      passedCount: evidence.filter((item) => item.status === "passed").length,
      failedCount: evidence.filter((item) => item.status === "failed").length,
      warningCount: evidence.filter((item) => item.status === "warning").length,
      skippedCount: evidence.filter((item) => item.status === "skipped").length,
    },
    outcome: {
      status,
      summary: compactText(input.outcome?.summary) || defaultOutcomeSummary(status),
    },
    caveats: [
      "Outcome receipts are calibration evidence, not causal proof.",
      "Receipts must be normalized by task profile before comparing recommendation reliability.",
      "Project Policy remains authoritative even when historical outcomes look positive.",
    ],
  };
}

export function buildOutcomeIntelligenceCalibration(
  input: BuildOutcomeIntelligenceCalibrationInput
): OutcomeIntelligenceCalibration {
  const generatedAt = isoTimestamp(input.generatedAt);
  const minSamplesForUsable = positiveInteger(
    input.minSamplesForUsable,
    DEFAULT_MIN_SAMPLES_FOR_USABLE
  );
  const grouped = new Map<string, OutcomeIntelligenceReceipt[]>();

  for (const receipt of input.receipts) {
    for (const reasonCode of receipt.decision.reasonCodes.length
      ? receipt.decision.reasonCodes
      : ["uncategorized"]) {
      const key = calibrationKey(receipt, reasonCode);
      grouped.set(key, [...(grouped.get(key) ?? []), receipt]);
    }
  }

  const buckets = [...grouped.entries()]
    .map(([key, receipts]) => buildBucket(key, receipts, minSamplesForUsable))
    .sort((left, right) => {
      if (right.sampleCount !== left.sampleCount) return right.sampleCount - left.sampleCount;
      return left.key.localeCompare(right.key);
    });

  return {
    version: OUTCOME_INTELLIGENCE_CALIBRATION_VERSION,
    generatedAt,
    receiptCount: input.receipts.length,
    buckets,
    caveats: [
      "Thin buckets are advisory only and should not change enforcement thresholds.",
      "Positive rates compare similar task profiles; they are not global agent trust scores.",
      "Use negative and blocked outcomes for faster demotion than promotion in later Trust Evolution work.",
    ],
  };
}

function buildBucket(
  key: string,
  receipts: OutcomeIntelligenceReceipt[],
  minSamplesForUsable: number
): OutcomeIntelligenceCalibrationBucket {
  const [reasonCode, taskKind, risk] = key.split("|") as [
    string,
    OutcomeIntelligenceTaskKind,
    OutcomeIntelligenceRiskLevel,
  ];
  const sampleCount = receipts.length;
  const successCount = receipts.filter((receipt) => receipt.outcome.status === "success").length;
  const failureCount = receipts.filter((receipt) => receipt.outcome.status === "failure").length;
  const blockedCount = receipts.filter((receipt) => receipt.outcome.status === "blocked").length;
  const partialCount = receipts.filter((receipt) => receipt.outcome.status === "partial").length;
  const unknownCount = receipts.filter((receipt) => receipt.outcome.status === "unknown").length;
  const comparableCount = successCount + failureCount + blockedCount + partialCount;
  const positiveRate =
    comparableCount === 0
      ? null
      : Number(((successCount + partialCount * 0.5) / comparableCount).toFixed(3));
  const confidence =
    sampleCount >= minSamplesForUsable ? "usable" : sampleCount >= 2 ? "emerging" : "thin";

  return {
    key,
    reasonCode,
    taskKind,
    risk,
    sampleCount,
    successCount,
    failureCount,
    blockedCount,
    partialCount,
    unknownCount,
    positiveRate,
    confidence,
    caveats:
      confidence === "usable"
        ? ["Calibration is usable for ranking, still not causal proof."]
        : ["Sample is too small for enforcement; use as an advisory hint only."],
  };
}

function calibrationKey(receipt: OutcomeIntelligenceReceipt, reasonCode: string): string {
  return [reasonCode, receipt.taskProfile.kind, receipt.taskProfile.risk].join("|");
}

function normalizeTaskProfile(
  profile: Partial<OutcomeIntelligenceTaskProfile>
): OutcomeIntelligenceTaskProfile {
  return {
    kind: normalizeTaskKind(profile.kind),
    risk: normalizeRisk(profile.risk),
    surfaces: uniqueStrings(profile.surfaces ?? []).map(normalizeSurface),
    changedFiles: uniqueStrings(profile.changedFiles ?? []).slice(0, 100),
    ...(profile.workflowFingerprint?.trim()
      ? { workflowFingerprint: profile.workflowFingerprint.trim() }
      : {}),
  };
}

function normalizeEvidence(evidence: OutcomeIntelligenceEvidence[]): OutcomeIntelligenceEvidence[] {
  return evidence
    .filter((item) => item.label.trim())
    .slice(0, 50)
    .map((item) => ({
      source: item.source,
      label: compactText(item.label),
      status: normalizeEvidenceStatus(item.status),
      ...(item.command ? { command: compactText(item.command, 300) } : {}),
      ...(item.detail ? { detail: compactText(item.detail, 500) } : {}),
    }));
}

function normalizeOutcomeStatus(
  explicit: OutcomeIntelligenceStatus | undefined,
  evidence: OutcomeIntelligenceEvidence[]
): OutcomeIntelligenceStatus {
  if (explicit) return explicit;
  if (evidence.some((item) => item.status === "failed")) return "failure";
  if (evidence.some((item) => item.status === "warning")) return "partial";
  if (evidence.some((item) => item.status === "passed")) return "success";
  return "unknown";
}

function normalizeTaskKind(
  value: OutcomeIntelligenceTaskKind | undefined
): OutcomeIntelligenceTaskKind {
  return value ?? "unknown";
}

function normalizeRisk(
  value: OutcomeIntelligenceRiskLevel | undefined
): OutcomeIntelligenceRiskLevel {
  return value ?? "medium";
}

function normalizeSurface(value: string): OutcomeIntelligenceSurface {
  if (
    value === "web" ||
    value === "backend" ||
    value === "database" ||
    value === "package" ||
    value === "docs" ||
    value === "security" ||
    value === "workflow" ||
    value === "memory"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeEvidenceStatus(
  value: OutcomeIntelligenceEvidenceStatus
): OutcomeIntelligenceEvidenceStatus {
  if (value === "passed" || value === "failed" || value === "warning" || value === "skipped") {
    return value;
  }
  return "warning";
}

function defaultOutcomeSummary(status: OutcomeIntelligenceStatus): string {
  if (status === "success") return "Verification completed successfully.";
  if (status === "failure") return "Verification found a failing outcome.";
  if (status === "blocked") return "Execution was blocked before completion.";
  if (status === "partial") return "Execution completed with warnings or partial proof.";
  return "Outcome requires review.";
}

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function compactText(value: string | undefined, maxLength = 700): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
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
