import { createHash } from "node:crypto";

export const PRODUCER_LOOP_ARTIFACT_VERSION = "snipara.producer_loop_artifact.v0" as const;
export const PRODUCER_LOOP_REPORT_VERSION = "snipara.producer_loop_report.v0" as const;
export const PRODUCER_LOOP_RELATIVE_DIR = ".snipara/producer-loop" as const;
export const PRODUCER_LOOP_MIN_REVIEW_SAMPLE_SIZE = 5;

export type ProducerLoopProducerKind =
  | "workflow_phase_commit"
  | "workflow_final_commit"
  | "pr_answer_pack_decision_capture";

export type ProducerLoopCommand =
  | "workflow phase-commit"
  | "workflow final-commit"
  | "github-pr-answer-pack decision-capture";

export type ProducerLoopSampleReviewStatus =
  | "sample_unreviewed"
  | "sample_reviewed"
  | "sample_rejected";

export type ProducerLoopReviewOutcome =
  | "useful"
  | "false_positive"
  | "missing_context"
  | "unsafe"
  | "duplicate"
  | "other";

export interface ProducerLoopArtifactReview {
  status: Exclude<ProducerLoopSampleReviewStatus, "sample_unreviewed">;
  reviewedAt: string;
  reviewer?: string;
  outcome?: ProducerLoopReviewOutcome;
  notes: string[];
}

export interface ProducerLoopLedgerLike {
  version: string;
  generatedAt?: string;
  reasonCodes?: string[];
  caveats?: string[];
  [key: string]: unknown;
}

export interface ProducerLoopArtifact {
  schemaVersion: typeof PRODUCER_LOOP_ARTIFACT_VERSION;
  artifactId: string;
  generatedAt: string;
  producer: {
    kind: ProducerLoopProducerKind;
    command: ProducerLoopCommand;
    workflowId?: string;
    phaseId?: string;
    phaseTitle?: string;
    repository?: string;
    pullNumber?: number;
    sourceRef?: string;
    category: string;
    outcome?: string;
    files: string[];
    candidateCount?: number;
    createdDecisionCount?: number;
    duplicateDecisionCount?: number;
    failedDecisionCount?: number;
  };
  source: {
    goal?: string;
    summary: string;
    status?: string;
    sourceRef?: string;
  };
  ledger: ProducerLoopLedgerLike;
  ledgerHash: string;
  localEvidence: {
    durableMemoryAttempted: boolean;
    journalAttempted?: boolean;
    teamSyncCompletionAttempted?: boolean;
    decisionCaptureAttempted?: boolean;
    serverSide?: boolean;
  };
  calibration: {
    status: ProducerLoopSampleReviewStatus;
    sampleSize: 1;
    hardGateReady: false;
    notes: string[];
  };
  review?: ProducerLoopArtifactReview;
  caveats: string[];
}

export interface BuildProducerLoopArtifactInput {
  generatedAt?: string | Date;
  producer: ProducerLoopArtifact["producer"];
  source: ProducerLoopArtifact["source"];
  ledger: ProducerLoopLedgerLike;
  localEvidence: ProducerLoopArtifact["localEvidence"];
  calibrationNotes?: string[];
  caveats?: string[];
  artifactIdParts?: string[];
}

export interface ApplyProducerLoopArtifactReviewInput {
  status?: Exclude<ProducerLoopSampleReviewStatus, "sample_unreviewed">;
  reviewedAt?: string | Date;
  reviewer?: string;
  outcome?: ProducerLoopReviewOutcome;
  notes?: string[];
}

export function stableProducerLoopJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function hashProducerLoopContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashProducerLoopJsonValue(value: unknown): string {
  return `sha256:${hashProducerLoopContent(stableProducerLoopJsonStringify(value))}`;
}

export function isProducerLoopProducerKind(value: unknown): value is ProducerLoopProducerKind {
  return (
    value === "workflow_phase_commit" ||
    value === "workflow_final_commit" ||
    value === "pr_answer_pack_decision_capture"
  );
}

export function isProducerLoopSampleReviewStatus(
  value: unknown
): value is ProducerLoopSampleReviewStatus {
  return (
    value === "sample_unreviewed" || value === "sample_reviewed" || value === "sample_rejected"
  );
}

export function isProducerLoopReviewOutcome(value: unknown): value is ProducerLoopReviewOutcome {
  return (
    value === "useful" ||
    value === "false_positive" ||
    value === "missing_context" ||
    value === "unsafe" ||
    value === "duplicate" ||
    value === "other"
  );
}

export function buildProducerLoopArtifactId(options: {
  kind: ProducerLoopProducerKind;
  generatedAt: string;
  ledgerHash: string;
  workflowId?: string;
  phaseId?: string;
  sourceRef?: string;
  extraParts?: string[];
}): string {
  const source = [
    options.kind,
    options.workflowId ?? "no-workflow",
    options.phaseId ?? "no-phase",
    options.sourceRef ?? "no-source-ref",
    ...uniqueStrings(options.extraParts ?? []),
    options.generatedAt,
    options.ledgerHash,
  ].join(":");
  return `producer-${hashProducerLoopContent(source).slice(0, 16)}`;
}

export function buildProducerLoopArtifact(
  input: BuildProducerLoopArtifactInput
): ProducerLoopArtifact {
  const generatedAt =
    input.generatedAt instanceof Date
      ? input.generatedAt.toISOString()
      : input.generatedAt || new Date().toISOString();
  const ledgerHash = hashProducerLoopJsonValue(input.ledger);
  const producer = {
    ...input.producer,
    files: uniqueStrings(input.producer.files.map(normalizeProducerLoopFilePath)),
  };
  const artifactId = buildProducerLoopArtifactId({
    kind: producer.kind,
    workflowId: producer.workflowId,
    phaseId: producer.phaseId,
    sourceRef: producer.sourceRef ?? input.source.sourceRef,
    generatedAt,
    ledgerHash,
    extraParts: input.artifactIdParts,
  });

  return {
    schemaVersion: PRODUCER_LOOP_ARTIFACT_VERSION,
    artifactId,
    generatedAt,
    producer,
    source: input.source,
    ledger: input.ledger,
    ledgerHash,
    localEvidence: input.localEvidence,
    calibration: {
      status: "sample_unreviewed",
      sampleSize: 1,
      hardGateReady: false,
      notes:
        input.calibrationNotes && input.calibrationNotes.length > 0
          ? uniqueStrings(input.calibrationNotes)
          : [
              "This artifact is one Producer Loop sample.",
              "Confidence remains uncalibrated until reviewed samples accumulate.",
            ],
    },
    caveats:
      input.caveats && input.caveats.length > 0
        ? uniqueStrings(input.caveats)
        : [
            "Review evidence only; this is not server-side compliance attestation.",
            "Producer Loop V0 does not execute workers or write approved memory automatically.",
          ],
  };
}

export function applyProducerLoopArtifactReview(
  artifact: ProducerLoopArtifact,
  input: ApplyProducerLoopArtifactReviewInput = {}
): ProducerLoopArtifact {
  const status = input.status ?? "sample_reviewed";
  const reviewedAt =
    input.reviewedAt instanceof Date
      ? input.reviewedAt.toISOString()
      : input.reviewedAt || new Date().toISOString();
  const reviewNotes = uniqueStrings(input.notes ?? []);
  const reviewer = normalizeOptionalString(input.reviewer);
  const reviewNote =
    status === "sample_rejected"
      ? "Sample rejected by local operator review."
      : "Sample reviewed by local operator.";

  return {
    ...artifact,
    calibration: {
      ...artifact.calibration,
      status,
      hardGateReady: false,
      notes: uniqueStrings([
        ...artifact.calibration.notes,
        reviewNote,
        ...reviewNotes.map((note) => `Review note: ${note}`),
      ]),
    },
    review: {
      status,
      reviewedAt,
      ...(reviewer ? { reviewer } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      notes: reviewNotes,
    },
  };
}

function normalizeProducerLoopFilePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
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
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)])
    );
  }
  return value;
}
