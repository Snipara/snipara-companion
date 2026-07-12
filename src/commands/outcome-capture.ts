import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  buildDecisionRequest,
  buildOutcomeIntelligenceReceipt,
  type OutcomeIntelligenceReceipt,
  type OutcomeIntelligenceStatus,
  type OutcomeIntelligenceSurface,
  type OutcomeIntelligenceTaskKind,
} from "../contracts/project-intelligence";
import { writeDecisionRequest } from "./decision-requests";

export const WHY_OUTCOME_CAPTURE_VERSION = "snipara.why_outcome_capture.v1" as const;

export type WhyOutcomeCaptureEventKind =
  | "commit"
  | "pull_request"
  | "phase_commit"
  | "handoff"
  | "final_commit"
  | "guard_decision"
  | "test_result"
  | "deploy_health"
  | "review_result"
  | "feedback";

export type WhyOutcomeCandidateKind = "decision" | "outcome";
export type WhyOutcomeCandidateOutcomeStatus =
  | "positive"
  | "negative"
  | "blocked"
  | "neutral"
  | "unknown";

export interface WhyOutcomeCaptureEvent {
  kind?: WhyOutcomeCaptureEventKind | string;
  event?: WhyOutcomeCaptureEventKind | string;
  summary?: string;
  reason?: string | string[];
  outcome?: string;
  status?: string;
  feedback?: string;
  sourceRef?: string;
  actor?: string;
  files?: string[];
  evidence?: string[];
  commands?: string[];
  reviewResult?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface WhyOutcomeCaptureCandidate {
  id: string;
  kind: WhyOutcomeCandidateKind;
  reviewStatus: "review_pending";
  authorityStatus: "candidate";
  content: string;
  confidence: number;
  source: {
    kind: WhyOutcomeCaptureEventKind;
    ref: string | null;
    actor: string | null;
    observedAt: string;
  };
  outcome?: {
    status: WhyOutcomeCandidateOutcomeStatus;
    label: string;
  };
  provenance: {
    files: string[];
    evidence: string[];
    commands: string[];
    reasonCodes: string[];
    dedupeKey: string;
  };
  redaction: {
    redacted: boolean;
    patterns: string[];
  };
}

export interface WhyOutcomeCaptureReport {
  version: typeof WHY_OUTCOME_CAPTURE_VERSION;
  generatedAt: string;
  reviewStatus: "review_pending";
  eventCount: number;
  candidateCount: number;
  skippedDuplicateCount: number;
  candidates: WhyOutcomeCaptureCandidate[];
  caveats: string[];
}

export interface WhyOutcomeCaptureOptions {
  events: WhyOutcomeCaptureEvent[];
  now?: Date;
  maxCandidates?: number;
}

interface RedactedText {
  value: string;
  patterns: string[];
}

interface NormalizedCaptureEvent {
  kind: WhyOutcomeCaptureEventKind;
  summary: RedactedText;
  reasons: RedactedText[];
  outcome: RedactedText;
  status: RedactedText;
  feedback: RedactedText;
  sourceRef: string | null;
  actor: string | null;
  files: string[];
  evidence: RedactedText[];
  commands: RedactedText[];
  observedAt: string;
  redactionPatterns: string[];
}

interface OutcomeCapturePreviewCommandOptions {
  fromFile?: string;
  event?: string;
  summary?: string;
  outcome?: string;
  status?: string;
  sourceRef?: string;
  actor?: string;
  files?: string[];
  evidence?: string[];
  command?: string[];
  reason?: string[];
  feedback?: string;
  maxCandidates?: string;
  emitDecisions?: boolean;
  emitOutcomeReceipt?: boolean;
  taskKind?: string;
  risk?: string;
  surface?: string[];
  workflowFingerprint?: string;
  json?: boolean;
}

const DEFAULT_MAX_CANDIDATES = 20;
const MAX_EVENTS = 50;
const MAX_LIST_ITEMS = 20;
const MAX_TEXT_LENGTH = 700;

const DECISION_EVENT_KINDS = new Set<WhyOutcomeCaptureEventKind>([
  "commit",
  "pull_request",
  "phase_commit",
  "handoff",
  "final_commit",
  "review_result",
  "feedback",
]);

const OUTCOME_EVENT_KINDS = new Set<WhyOutcomeCaptureEventKind>([
  "commit",
  "pull_request",
  "phase_commit",
  "handoff",
  "final_commit",
  "guard_decision",
  "test_result",
  "deploy_health",
  "review_result",
  "feedback",
]);

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "secret_assignment",
    pattern:
      /\b(api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;]+/gi,
  },
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    name: "snipara_key",
    pattern: /\bsnp[-_][A-Za-z0-9._~+/=-]{8,}/gi,
  },
];

export function buildWhyOutcomeCaptureReport(
  options: WhyOutcomeCaptureOptions
): WhyOutcomeCaptureReport {
  const now = options.now ?? new Date();
  const maxCandidates = boundedPositiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
  const normalizedEvents = options.events
    .slice(0, MAX_EVENTS)
    .map((event, index) => normalizeCaptureEvent(event, now, index));
  const candidates: WhyOutcomeCaptureCandidate[] = [];
  const seen = new Set<string>();
  let skippedDuplicateCount = 0;

  for (const event of normalizedEvents) {
    for (const candidate of buildCandidatesForEvent(event)) {
      if (seen.has(candidate.provenance.dedupeKey)) {
        skippedDuplicateCount += 1;
        continue;
      }
      seen.add(candidate.provenance.dedupeKey);
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) {
        break;
      }
    }
    if (candidates.length >= maxCandidates) {
      break;
    }
  }

  return {
    version: WHY_OUTCOME_CAPTURE_VERSION,
    generatedAt: now.toISOString(),
    reviewStatus: "review_pending",
    eventCount: normalizedEvents.length,
    candidateCount: candidates.length,
    skippedDuplicateCount,
    candidates,
    caveats: [
      "Candidates are review-pending only; they are not approved memory, project truth, or causal outcome proof.",
      "Secret-like fragments are redacted before candidate text and evidence are emitted.",
      "Duplicate candidates are collapsed by source, kind, and normalized content.",
    ],
  };
}

export async function outcomeCapturePreviewCommand(
  options: OutcomeCapturePreviewCommandOptions
): Promise<void> {
  const events = options.fromFile
    ? readEventsFromFile(options.fromFile)
    : [
        {
          kind: options.event,
          summary: options.summary,
          outcome: options.outcome,
          status: options.status,
          sourceRef: options.sourceRef,
          actor: options.actor,
          files: options.files,
          evidence: options.evidence,
          commands: options.command,
          reason: options.reason,
          feedback: options.feedback,
        },
      ];

  if (
    events.length === 0 ||
    events.every(
      (event) =>
        !event.summary && !event.outcome && !event.status && !event.feedback && !event.reason
    )
  ) {
    throw new Error(
      "outcome-capture preview needs --from-file or at least --summary/--outcome/--feedback."
    );
  }

  const report = buildWhyOutcomeCaptureReport({
    events,
    maxCandidates:
      options.maxCandidates !== undefined ? parseInt(options.maxCandidates, 10) : undefined,
  });
  const decisionWrites = options.emitDecisions
    ? report.candidates.map((candidate) =>
        writeDecisionRequest(
          buildDecisionRequest({
            producer: {
              kind: "outcome_capture",
              command: "outcome-capture preview --emit-decisions",
              sourceRef: candidate.source.ref ?? candidate.id,
            },
            decision:
              candidate.kind === "decision"
                ? "promote_why_extraction_to_memory"
                : "record_outcome_candidate",
            question:
              candidate.kind === "decision"
                ? `Promote this why-extraction candidate to durable memory? ${candidate.content}`
                : `Accept this outcome candidate for future calibration? ${candidate.content}`,
            evidence: {
              summary: candidate.content,
              refs: [candidate.source.ref ?? candidate.id],
              reasonCodes: candidate.provenance.reasonCodes,
              files: candidate.provenance.files,
              applyPath: "snipara_memory_resolve_queue_item",
              applyCommand:
                "Route through the existing reviewed memory write path; do not write canonical memory directly.",
            },
            options: ["promote", "reject", "keep_pending"],
            recommendation: candidate.confidence >= 0.75 ? "promote" : "keep_pending",
            rationale: `candidate confidence ${candidate.confidence}; authorityStatus=candidate reviewStatus=review_pending`,
            fingerprintParts: [
              "outcome_capture",
              candidate.id,
              candidate.provenance.dedupeKey,
              candidate.content,
            ],
          })
        )
      )
    : [];
  const outcomeReceipt = options.emitOutcomeReceipt
    ? buildOutcomeIntelligenceReceiptFromCapture(report, events, {
        taskKind: options.taskKind,
        risk: options.risk,
        surfaces: options.surface,
        workflowFingerprint: options.workflowFingerprint,
      })
    : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          ...(outcomeReceipt ? { outcomeReceipt } : {}),
          ...(options.emitDecisions
            ? {
                decisionRequests: {
                  written: decisionWrites.filter((write) => write.status === "written").length,
                  duplicatePending: decisionWrites.filter(
                    (write) => write.status === "duplicate_pending"
                  ).length,
                  duplicateResolved: decisionWrites.filter(
                    (write) => write.status === "duplicate_resolved"
                  ).length,
                  writes: decisionWrites,
                },
              }
            : {}),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Outcome capture candidates: ${report.candidateCount}`);
  for (const candidate of report.candidates) {
    console.log(`- ${candidate.kind}: ${candidate.content}`);
    console.log(
      `  source: ${candidate.source.kind}${candidate.source.ref ? ` ${candidate.source.ref}` : ""}`
    );
    console.log(`  review: ${candidate.reviewStatus}`);
  }
  if (options.emitDecisions) {
    console.log(
      `Decision requests written: ${decisionWrites.filter((write) => write.status === "written").length}`
    );
  }
  if (outcomeReceipt) {
    console.log(`Outcome receipt: ${outcomeReceipt.receiptId}`);
    console.log(`Outcome status: ${outcomeReceipt.outcome.status}`);
  }
}

export function buildOutcomeIntelligenceReceiptFromCapture(
  report: WhyOutcomeCaptureReport,
  events: WhyOutcomeCaptureEvent[],
  options: {
    taskKind?: string;
    risk?: string;
    surfaces?: string[];
    workflowFingerprint?: string;
  } = {}
): OutcomeIntelligenceReceipt {
  const files = uniqueStrings(events.flatMap((event) => normalizeStringList(event.files)));
  const reasonCodes = uniqueStrings(
    report.candidates.flatMap((candidate) => candidate.provenance.reasonCodes)
  );
  const outcomeStatuses = report.candidates
    .map((candidate) => candidate.outcome?.status)
    .filter((status): status is NonNullable<WhyOutcomeCaptureCandidate["outcome"]>["status"] =>
      Boolean(status)
    );
  const sourceRef =
    events.map((event) => event.sourceRef).find((value): value is string => Boolean(value)) ??
    `outcome-capture:${report.generatedAt}`;
  const evidence = report.candidates
    .flatMap((candidate) => [
      ...candidate.provenance.evidence.map((detail) => ({
        source: evidenceSourceForCandidate(candidate),
        label: candidate.source.kind,
        status: evidenceStatusForOutcome(candidate.outcome?.status),
        detail,
      })),
      ...candidate.provenance.commands.map((command) => ({
        source: evidenceSourceForCandidate(candidate),
        label: candidate.source.kind,
        status: evidenceStatusForOutcome(candidate.outcome?.status),
        command,
      })),
    ])
    .slice(0, 20);

  return buildOutcomeIntelligenceReceipt({
    generatedAt: report.generatedAt,
    sourceRef,
    taskProfile: {
      kind: normalizeTaskKindOption(options.taskKind) ?? inferTaskKind(events),
      risk: normalizeRiskOption(options.risk) ?? inferRisk(events, outcomeStatuses),
      surfaces:
        options.surfaces && options.surfaces.length > 0
          ? options.surfaces.map(normalizeSurfaceOption)
          : inferSurfaces(files),
      changedFiles: files,
      ...(options.workflowFingerprint ? { workflowFingerprint: options.workflowFingerprint } : {}),
    },
    decision: {
      summary: decisionSummaryForReceipt(events, report),
      reasonCodes,
    },
    evidence,
    outcome: {
      status: aggregateOutcomeStatus(outcomeStatuses),
      summary: outcomeSummaryForReceipt(report),
    },
  });
}

function buildCandidatesForEvent(event: NormalizedCaptureEvent): WhyOutcomeCaptureCandidate[] {
  const candidates: WhyOutcomeCaptureCandidate[] = [];
  if (shouldCreateDecisionCandidate(event)) {
    const content = decisionContent(event);
    candidates.push(buildCandidate(event, "decision", content));
  }

  if (shouldCreateOutcomeCandidate(event)) {
    const outcome = classifyOutcome(event);
    const content = outcomeContent(event, outcome);
    candidates.push(buildCandidate(event, "outcome", content, outcome));
  }

  return candidates;
}

function buildCandidate(
  event: NormalizedCaptureEvent,
  kind: WhyOutcomeCandidateKind,
  content: string,
  outcome?: WhyOutcomeCaptureCandidate["outcome"]
): WhyOutcomeCaptureCandidate {
  const normalizedContent = compactWhitespace(content);
  const dedupeKey = stableHash([
    kind,
    event.kind,
    event.sourceRef ?? "",
    normalizedContent.toLowerCase(),
    event.files.join(","),
  ]);
  const reasonCodes = reasonCodesForEvent(event, kind, outcome?.status);
  return {
    id: `${kind}:${dedupeKey.slice(0, 16)}`,
    kind,
    reviewStatus: "review_pending",
    authorityStatus: "candidate",
    content: truncateText(normalizedContent),
    confidence: confidenceForEvent(event, kind),
    source: {
      kind: event.kind,
      ref: event.sourceRef,
      actor: event.actor,
      observedAt: event.observedAt,
    },
    ...(outcome ? { outcome } : {}),
    provenance: {
      files: event.files,
      evidence: event.evidence.map((item) => item.value),
      commands: event.commands.map((item) => item.value),
      reasonCodes,
      dedupeKey,
    },
    redaction: {
      redacted: event.redactionPatterns.length > 0,
      patterns: event.redactionPatterns,
    },
  };
}

function shouldCreateDecisionCandidate(event: NormalizedCaptureEvent): boolean {
  if (!DECISION_EVENT_KINDS.has(event.kind)) {
    return false;
  }
  return Boolean(event.summary.value || event.reasons.length > 0 || event.feedback.value);
}

function shouldCreateOutcomeCandidate(event: NormalizedCaptureEvent): boolean {
  if (!OUTCOME_EVENT_KINDS.has(event.kind)) {
    return false;
  }
  if (
    event.kind === "test_result" ||
    event.kind === "deploy_health" ||
    event.kind === "guard_decision"
  ) {
    return true;
  }
  return Boolean(event.outcome.value || event.status.value || event.feedback.value);
}

function decisionContent(event: NormalizedCaptureEvent): string {
  const reason = event.reasons
    .map((item) => item.value)
    .filter(Boolean)
    .join("; ");
  const feedback = event.feedback.value ? ` Feedback: ${event.feedback.value}` : "";
  const why = reason ? ` Why: ${reason}.` : "";
  return `${event.summary.value || fallbackSummaryForEvent(event)}.${why}${feedback}`.trim();
}

function outcomeContent(
  event: NormalizedCaptureEvent,
  outcome: NonNullable<WhyOutcomeCaptureCandidate["outcome"]>
): string {
  const base = event.summary.value || fallbackSummaryForEvent(event);
  const evidence = event.evidence.length > 0 ? ` Evidence: ${event.evidence[0].value}.` : "";
  return `${base}. Outcome candidate: ${outcome.label}.${evidence}`.trim();
}

function classifyOutcome(
  event: NormalizedCaptureEvent
): NonNullable<WhyOutcomeCaptureCandidate["outcome"]> {
  const value = [event.outcome.value, event.status.value, event.feedback.value]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    /\b(pass|passed|green|merged|success|healthy|accepted|approved|complete|completed|fixed)\b/.test(
      value
    )
  ) {
    return {
      status: "positive",
      label: event.outcome.value || event.status.value || "positive signal",
    };
  }
  if (/\b(fail|failed|red|error|unhealthy|rejected|regression|broken|negative)\b/.test(value)) {
    return {
      status: "negative",
      label: event.outcome.value || event.status.value || "negative signal",
    };
  }
  if (
    /\b(block|blocked|stop|guard|denied|conflict)\b/.test(value) ||
    event.kind === "guard_decision"
  ) {
    return {
      status: "blocked",
      label: event.outcome.value || event.status.value || "blocked signal",
    };
  }
  if (value) {
    return {
      status: "neutral",
      label: event.outcome.value || event.status.value || event.feedback.value,
    };
  }
  return { status: "unknown", label: "outcome requires review" };
}

function normalizeCaptureEvent(
  event: WhyOutcomeCaptureEvent,
  now: Date,
  index: number
): NormalizedCaptureEvent {
  const kind = normalizeEventKind(event.kind ?? event.event);
  const summary = redactText(event.summary ?? "");
  const outcome = redactText(event.outcome ?? "");
  const status = redactText(event.status ?? "");
  const feedback = redactText(event.feedback ?? "");
  const reasons = normalizeStringList(event.reason).map(redactText);
  const evidence = normalizeStringList(event.evidence).map(redactText);
  const commands = normalizeStringList(event.commands).map(redactText);
  const redactionPatterns = uniqueStrings([
    ...summary.patterns,
    ...outcome.patterns,
    ...status.patterns,
    ...feedback.patterns,
    ...reasons.flatMap((item) => item.patterns),
    ...evidence.flatMap((item) => item.patterns),
    ...commands.flatMap((item) => item.patterns),
  ]);

  return {
    kind,
    summary,
    reasons,
    outcome,
    status,
    feedback,
    sourceRef: truncateText(event.sourceRef ?? `${kind}:${index}`, 220),
    actor: event.actor ? truncateText(event.actor, 120) : null,
    files: normalizeStringList(event.files).map((item) => truncateText(item, 240)),
    evidence,
    commands,
    observedAt: validIsoOrNow(event.observedAt, now),
    redactionPatterns,
  };
}

function normalizeEventKind(value: string | undefined): WhyOutcomeCaptureEventKind {
  const normalized = (value ?? "feedback").trim().toLowerCase().replace(/[-\s]/g, "_");
  if (
    normalized === "commit" ||
    normalized === "pull_request" ||
    normalized === "phase_commit" ||
    normalized === "handoff" ||
    normalized === "final_commit" ||
    normalized === "guard_decision" ||
    normalized === "test_result" ||
    normalized === "deploy_health" ||
    normalized === "review_result" ||
    normalized === "feedback"
  ) {
    return normalized;
  }
  return "feedback";
}

function reasonCodesForEvent(
  event: NormalizedCaptureEvent,
  kind: WhyOutcomeCandidateKind,
  status?: WhyOutcomeCandidateOutcomeStatus
): string[] {
  return uniqueStrings([
    "why_outcome_capture_v1",
    "review_pending_authority",
    `source_${event.kind}`,
    `candidate_${kind}`,
    ...(status ? [`outcome_${status}`] : []),
    ...(event.files.length > 0 ? ["file_scope_present"] : []),
    ...(event.evidence.length > 0 ? ["evidence_present"] : []),
    ...(event.redactionPatterns.length > 0 ? ["redacted_secret_like_content"] : []),
  ]);
}

function confidenceForEvent(event: NormalizedCaptureEvent, kind: WhyOutcomeCandidateKind): number {
  let confidence = kind === "outcome" ? 0.58 : 0.52;
  if (event.sourceRef) confidence += 0.06;
  if (event.files.length > 0) confidence += 0.04;
  if (event.evidence.length > 0) confidence += 0.08;
  if (event.commands.length > 0) confidence += 0.04;
  if (event.kind === "feedback" || event.kind === "review_result") confidence += 0.04;
  return Math.min(0.82, Number(confidence.toFixed(2)));
}

function evidenceSourceForCandidate(
  candidate: WhyOutcomeCaptureCandidate
): "test" | "deploy_health" | "review" | "guard" | "manual" {
  if (candidate.source.kind === "test_result") return "test";
  if (candidate.source.kind === "deploy_health") return "deploy_health";
  if (candidate.source.kind === "guard_decision") return "guard";
  if (candidate.source.kind === "review_result" || candidate.source.kind === "feedback") {
    return "review";
  }
  return "manual";
}

function evidenceStatusForOutcome(
  status: WhyOutcomeCandidateOutcomeStatus | undefined
): "passed" | "failed" | "warning" | "skipped" {
  if (status === "positive") return "passed";
  if (status === "negative") return "failed";
  if (status === "blocked") return "warning";
  if (status === "neutral") return "warning";
  return "skipped";
}

function aggregateOutcomeStatus(
  statuses: Array<NonNullable<WhyOutcomeCaptureCandidate["outcome"]>["status"]>
): OutcomeIntelligenceStatus {
  if (statuses.includes("negative")) return "failure";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("neutral")) return "partial";
  if (statuses.includes("positive")) return "success";
  return "unknown";
}

function inferTaskKind(events: WhyOutcomeCaptureEvent[]): OutcomeIntelligenceTaskKind {
  const text = events
    .map((event) =>
      [event.kind, event.summary, event.outcome, event.sourceRef].filter(Boolean).join(" ")
    )
    .join(" ")
    .toLowerCase();
  if (/\b(deploy|health|production)\b/.test(text)) return "deploy";
  if (/\b(release|publish|npm|pypi|package)\b/.test(text)) return "release";
  if (/\b(doc|docs|copy)\b/.test(text)) return "docs";
  if (/\b(fix|bug|regression)\b/.test(text)) return "bugfix";
  if (/\b(refactor|cleanup)\b/.test(text)) return "refactor";
  if (/\b(investigate|audit|review)\b/.test(text)) return "investigation";
  if (/\b(feature|ship|implement)\b/.test(text)) return "feature";
  return "unknown";
}

function inferRisk(
  events: WhyOutcomeCaptureEvent[],
  statuses: Array<NonNullable<WhyOutcomeCaptureCandidate["outcome"]>["status"]>
): "low" | "medium" | "high" | "critical" {
  const text = events
    .map((event) =>
      [event.kind, event.summary, event.outcome, event.sourceRef].filter(Boolean).join(" ")
    )
    .join(" ")
    .toLowerCase();
  if (statuses.includes("negative") || /\b(auth|billing|schema|migration|security)\b/.test(text)) {
    return "critical";
  }
  if (statuses.includes("blocked") || /\b(deploy|release|production|package)\b/.test(text)) {
    return "high";
  }
  if (/\b(docs|copy)\b/.test(text)) return "low";
  return "medium";
}

function inferSurfaces(files: string[]): OutcomeIntelligenceSurface[] {
  const surfaces = new Set<OutcomeIntelligenceSurface>();
  for (const file of files) {
    if (file.startsWith("apps/web/")) surfaces.add("web");
    if (file.startsWith("apps/mcp-server/")) surfaces.add("backend");
    if (file.includes("prisma") || file.includes("migrations/")) surfaces.add("database");
    if (file.startsWith("packages/")) surfaces.add("package");
    if (file.startsWith("docs/") || file.includes("/docs/")) surfaces.add("docs");
    if (file.includes("auth") || file.includes("security")) surfaces.add("security");
    if (file.includes("workflow") || file.includes("commands/")) surfaces.add("workflow");
    if (file.includes("memory")) surfaces.add("memory");
  }
  return surfaces.size > 0 ? [...surfaces] : ["unknown"];
}

function normalizeTaskKindOption(
  value: string | undefined
): OutcomeIntelligenceTaskKind | undefined {
  if (
    value === "bugfix" ||
    value === "feature" ||
    value === "docs" ||
    value === "release" ||
    value === "deploy" ||
    value === "refactor" ||
    value === "investigation" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function normalizeRiskOption(
  value: string | undefined
): "low" | "medium" | "high" | "critical" | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return undefined;
}

function normalizeSurfaceOption(value: string): OutcomeIntelligenceSurface {
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

function decisionSummaryForReceipt(
  events: WhyOutcomeCaptureEvent[],
  report: WhyOutcomeCaptureReport
): string {
  const eventSummary = events
    .map((event) => event.summary)
    .find((value): value is string => Boolean(value?.trim()));
  return (
    eventSummary ??
    report.candidates.map((candidate) => candidate.content).find(Boolean) ??
    "Outcome capture receipt"
  );
}

function outcomeSummaryForReceipt(report: WhyOutcomeCaptureReport): string {
  const outcome = report.candidates.find((candidate) => candidate.kind === "outcome");
  return outcome?.content ?? "Outcome capture emitted review-pending calibration evidence.";
}

function fallbackSummaryForEvent(event: NormalizedCaptureEvent): string {
  return `${event.kind.replace(/_/g, " ")} signal captured for review`;
}

function redactText(value: string): RedactedText {
  let redacted = truncateText(value);
  const patterns: string[] = [];
  for (const item of SECRET_PATTERNS) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(redacted)) {
      patterns.push(item.name);
      item.pattern.lastIndex = 0;
      redacted = redacted.replace(item.pattern, (match) => {
        const prefix = match.match(/^([^:=]+)\s*[:=]/)?.[1]?.trim();
        return prefix ? `${prefix}=<redacted>` : "<redacted>";
      });
    }
    item.pattern.lastIndex = 0;
  }
  return { value: compactWhitespace(redacted), patterns };
}

function normalizeStringList(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap((item) => String(item).split("\n"))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function readEventsFromFile(filePath: string): WhyOutcomeCaptureEvent[] {
  const resolved = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as WhyOutcomeCaptureEvent[];
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as { events?: unknown; event?: unknown };
    if (Array.isArray(record.events)) {
      return record.events as WhyOutcomeCaptureEvent[];
    }
    if (record.event && typeof record.event === "object") {
      return [record.event as WhyOutcomeCaptureEvent];
    }
    return [parsed as WhyOutcomeCaptureEvent];
  }
  return [];
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, limit = MAX_TEXT_LENGTH): string {
  const normalized = String(value ?? "");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 16)).trimEnd()} ... [truncated]`;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), 100);
}

function validIsoOrNow(value: string | undefined, now: Date): string {
  if (!value) {
    return now.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? now.toISOString() : date.toISOString();
}
