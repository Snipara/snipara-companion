/**
 * `run` command — production Project Intelligence orchestration.
 *
 * This command is the direct dogfood entrypoint for agents: build the brief,
 * verification plan, release guard evidence, package surface note, and final
 * Judgment Card in one pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import {
  buildAdvisorInfluenceLifecycle,
  buildDecisionRequest,
  buildOutcomeIntelligenceCalibration,
  type AdvisorInfluenceLifecycle,
  type AdvisorInfluenceLifecycleEvidence,
  type AdvisorInfluenceLifecycleState,
  type DecisionRequest,
  type OutcomeIntelligenceCalibration,
  type OutcomeIntelligenceReceipt,
} from "../contracts/project-intelligence";
import {
  createClient,
  type AdvisorInfluenceAgentDecision,
  type AdvisorInfluenceRecommendationInput,
  type RecordAdvisorInfluenceReceiptResult,
} from "../api/client";
import {
  buildProjectIntelligenceBrief,
  servedJudgmentIdFromContext,
  type ProjectIntelligenceBrief,
} from "./intelligence";
import {
  buildProjectJudgmentCard,
  formatProjectJudgmentCard,
  type ProjectIntelligenceJudgmentCard,
} from "./judgment-card";
import {
  evaluateProjectPolicyGates,
  formatPolicyGateDecision,
  type ProjectPolicyGatesResult,
} from "./policy-gates";
import { writeDecisionRequest, type DecisionRequestWriteResult } from "./decision-requests";

export interface ProjectRunCommandOptions {
  task?: string;
  branch?: string;
  changedFiles?: string[];
  recentFiles?: string[];
  diffSummary?: string;
  maxTokens?: number;
  release?: boolean;
  skipImpact?: boolean;
  skipMemoryHealth?: boolean;
  skipGuard?: boolean;
  skipPackageReview?: boolean;
  servedJudgmentId?: string;
  skipAdvisorReceipts?: boolean;
  advisorPlanBefore?: string;
  advisorPlanAfter?: string;
  advisorRecommendationId?: string;
  outcomeReceiptFiles?: string[];
  emitPolicyDecisions?: boolean;
  json?: boolean;
}

export interface ProjectRunGuardResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface ProjectRunPackageReview {
  command: string;
  status: "skipped" | "ok" | "error";
  packageName: "snipara-companion";
  data?: unknown;
  error?: string;
}

export interface ProjectRunAdvisorReceiptWrite {
  advisorRecommendationId: string;
  status: "recorded" | "skipped" | "error";
  agentDecision?: AdvisorInfluenceAgentDecision;
  changedBecauseOfRecommendation?: boolean;
  lifecycleState?: AdvisorInfluenceLifecycleState;
  measurementState?: ProjectRunAdvisorMeasurementState;
  targeted?: boolean;
  result?: RecordAdvisorInfluenceReceiptResult;
  reason?: ProjectRunAdvisorReceiptSkipReason;
  error?: string;
}

export type ProjectRunAdvisorMeasurementState =
  | "unmeasured"
  | "acknowledged_unscoped"
  | "acknowledged"
  | "applied"
  | "verified"
  | "blocked";

export interface ProjectRunAdvisorMeasurementCoverage {
  version: "project-intelligence.advisor-measurement-coverage.v1";
  identityStatus: "linked" | "missing";
  recommendationCount: number;
  recordedCount: number;
  targetedCount: number;
  unscopedCount: number;
  acknowledgedCount: number;
  appliedCount: number;
  verifiedCount: number;
  blockedCount: number;
  unmeasuredCount: number;
  receiptCoverage: number | null;
}

export type ProjectRunAdvisorReceiptSkipReason =
  | "explicitly_skipped"
  | "no_advisor_recommendations"
  | "missing_served_judgment_id"
  | "no_plan_adaptation"
  | "write_limit_exceeded";

export interface ProjectRunAdvisorReceiptCapture {
  status: "skipped" | "recorded" | "partial" | "error";
  servedJudgmentId?: string;
  totalRecommendationCount: number;
  eligibleCount: number;
  attemptedCount: number;
  recordedCount: number;
  skippedCount: number;
  writes: ProjectRunAdvisorReceiptWrite[];
  measurement: ProjectRunAdvisorMeasurementCoverage;
  reason?: ProjectRunAdvisorReceiptSkipReason;
}

export type ProjectRunVerificationEvidenceStatus = "passed" | "failed" | "skipped" | "warning";

export interface ProjectRunVerificationEvidence {
  source: "collaboration_guard" | "package_review" | "policy_gates";
  label: string;
  status: ProjectRunVerificationEvidenceStatus;
  command?: string;
  detail?: string;
  exitCode?: number | null;
}

export interface ProjectIntelligenceRunResult {
  version: "project-intelligence.production-run.v1";
  generatedAt: string;
  runEnvelope: ProjectIntelligenceRunEnvelope;
  release: boolean;
  brief: ProjectIntelligenceBrief;
  guard?: ProjectRunGuardResult;
  packageReview?: ProjectRunPackageReview;
  policyGates: ProjectPolicyGatesResult;
  policyDecisionRequests?: ProjectRunPolicyDecisionRequests;
  advisorReceiptCapture?: ProjectRunAdvisorReceiptCapture;
  outcomeCalibration?: OutcomeIntelligenceCalibration;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  suggestedCommands: string[];
}

export interface ProjectIntelligenceRunEnvelope {
  version: "project-intelligence.judgment-run-envelope.v1";
  runId: string;
  identitySource: "snipara_session" | "codex_session" | "generated";
  startedAt: string;
}

export interface ProjectRunPolicyDecisionRequests {
  version: "project-intelligence.policy-decision-requests.v1";
  emitted: boolean;
  requestCount: number;
  requests: DecisionRequest[];
  writes: DecisionRequestWriteResult[];
  caveats: string[];
}

const GUARD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const RAW_OUTPUT_PREVIEW_BYTES = 64_000;
const ADVISOR_RECEIPT_WRITE_LIMIT = 6;

export function buildProjectIntelligenceRunEnvelope(
  startedAt = new Date()
): ProjectIntelligenceRunEnvelope {
  const sniparaSessionId = stringValue(process.env.SNIPARA_SESSION_ID)?.slice(0, 200);
  const codexSessionId = stringValue(process.env.CODEX_SESSION_ID)?.slice(0, 200);
  return {
    version: "project-intelligence.judgment-run-envelope.v1",
    runId: sniparaSessionId ?? codexSessionId ?? `judgment-run:${randomUUID()}`,
    identitySource: sniparaSessionId
      ? "snipara_session"
      : codexSessionId
        ? "codex_session"
        : "generated",
    startedAt: startedAt.toISOString(),
  };
}

interface AdvisorRecommendationPlanScope {
  mode:
    | "automatic_single_recommendation"
    | "explicit_match"
    | "explicit_non_match"
    | "multiple_recommendations_require_selector";
  requestedRecommendationId: string | null;
  targeted: boolean;
  totalRecommendationCount: number;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function guardPayload(
  guard: ProjectRunGuardResult | undefined
): Record<string, unknown> | undefined {
  return guard?.payload;
}

function packageReviewCommand(): string {
  return "npm view snipara-companion version bin dist-tags --json";
}

function readOutcomeReceipts(files: string[] | undefined): OutcomeIntelligenceReceipt[] {
  const receipts: OutcomeIntelligenceReceipt[] = [];
  for (const file of normalizeStringList(files)) {
    const resolved = path.resolve(process.cwd(), file);
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
    receipts.push(...outcomeReceiptsFromUnknown(parsed));
  }
  return receipts;
}

function outcomeReceiptsFromUnknown(value: unknown): OutcomeIntelligenceReceipt[] {
  if (Array.isArray(value)) {
    return value.flatMap(outcomeReceiptsFromUnknown);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (value.version === "snipara.outcome_intelligence.receipt.v0") {
    return [value as unknown as OutcomeIntelligenceReceipt];
  }
  if (isRecord(value.outcomeReceipt)) {
    return outcomeReceiptsFromUnknown(value.outcomeReceipt);
  }
  if (Array.isArray(value.outcomeReceipts)) {
    return outcomeReceiptsFromUnknown(value.outcomeReceipts);
  }
  if (Array.isArray(value.receipts)) {
    return outcomeReceiptsFromUnknown(value.receipts);
  }
  return [];
}

function outputPreview(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= RAW_OUTPUT_PREVIEW_BYTES) {
    return value;
  }
  return `${value.slice(0, RAW_OUTPUT_PREVIEW_BYTES)}\n...[truncated]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function servedJudgmentIdForRun(
  options: ProjectRunCommandOptions,
  brief: ProjectIntelligenceBrief
): string | undefined {
  return (
    stringValue(options.servedJudgmentId) ??
    stringValue(brief.servedJudgmentId) ??
    servedJudgmentIdFromContext(brief.resumeContext) ??
    servedJudgmentIdFromContext(brief.verificationPlan)
  );
}

function advisorMeasurementState(args: {
  agentDecision: AdvisorInfluenceAgentDecision;
  lifecycle: AdvisorInfluenceLifecycle;
  planScope: AdvisorRecommendationPlanScope;
}): ProjectRunAdvisorMeasurementState {
  if (args.agentDecision === "blocked") return "blocked";
  if (args.lifecycle.state === "verified") return "verified";
  if (args.lifecycle.state === "applied") return "applied";
  return args.planScope.targeted ? "acknowledged" : "acknowledged_unscoped";
}

function advisorMeasurementCoverage(args: {
  servedJudgmentId?: string;
  recommendationCount: number;
  writes: ProjectRunAdvisorReceiptWrite[];
}): ProjectRunAdvisorMeasurementCoverage {
  const states = args.writes.map((write) => write.measurementState ?? "unmeasured");
  const recordedCount = args.writes.filter((write) => write.status === "recorded").length;
  return {
    version: "project-intelligence.advisor-measurement-coverage.v1",
    identityStatus: args.servedJudgmentId ? "linked" : "missing",
    recommendationCount: args.recommendationCount,
    recordedCount,
    targetedCount: args.writes.filter((write) => write.targeted === true).length,
    unscopedCount: states.filter((state) => state === "acknowledged_unscoped").length,
    acknowledgedCount: states.filter((state) => state === "acknowledged").length,
    appliedCount: states.filter((state) => state === "applied").length,
    verifiedCount: states.filter((state) => state === "verified").length,
    blockedCount: states.filter((state) => state === "blocked").length,
    unmeasuredCount: Math.max(0, args.recommendationCount - recordedCount),
    receiptCoverage: args.recommendationCount > 0 ? recordedCount / args.recommendationCount : null,
  };
}

function normalizeAdvisorSource(value: string): AdvisorInfluenceRecommendationInput["source"] {
  if (
    value === "judgment" ||
    value === "outcome_calibration" ||
    value === "historical_impact" ||
    value === "safety" ||
    value === "verification" ||
    value === "context_quality"
  ) {
    return value;
  }
  return "judgment";
}

function normalizeAdvisorSeverity(value: string): AdvisorInfluenceRecommendationInput["severity"] {
  if (value === "info" || value === "watch" || value === "risk" || value === "block") {
    return value;
  }
  return "watch";
}

function advisorReceiptRecommendation(
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number]
): AdvisorInfluenceRecommendationInput {
  return {
    id: recommendation.id,
    version: "advisor-recommendation-v0",
    source: normalizeAdvisorSource(recommendation.source),
    severity: normalizeAdvisorSeverity(recommendation.severity),
    title: recommendation.title,
    rationale:
      recommendation.rationale ??
      recommendation.expectedBehaviorChange ??
      `Snipara recommended ${recommendation.title}.`,
    reasonCodes: recommendation.reasonCodes,
    historicalImpactSummary: recommendation.historicalImpactSummary ?? null,
    reasonCodeReliability: recommendation.reasonCodeReliability ?? null,
    recommendedVerification: recommendation.recommendedVerification,
    expectedBehaviorChange:
      recommendation.expectedBehaviorChange ??
      `Adapt the visible plan according to ${recommendation.title}.`,
    evidence: [],
    caveats: [
      "Expected behavior is a proposal only; lifecycle evidence separately records acknowledgement, application, and verification.",
    ],
  };
}

function advisorReceiptDecision(
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number],
  judgmentCard: ProjectIntelligenceJudgmentCard,
  lifecycle: AdvisorInfluenceLifecycle
): AdvisorInfluenceAgentDecision {
  if (recommendation.severity === "block" && judgmentCard.canProceed === "block") {
    return "blocked";
  }
  return lifecycle.planChange.changed ? "modified" : "accepted";
}

function advisorLifecycleEvidenceStatus(
  status: OutcomeIntelligenceReceipt["verification"]["evidence"][number]["status"]
): AdvisorInfluenceLifecycleEvidence["status"] | undefined {
  if (status === "passed" || status === "failed" || status === "warning") return status;
  return undefined;
}

function advisorLifecycleOutcomeStatus(
  status: OutcomeIntelligenceReceipt["outcome"]["status"]
): AdvisorInfluenceLifecycleEvidence["status"] | undefined {
  if (status === "success") return "passed";
  if (status === "failure" || status === "blocked") return "failed";
  if (status === "partial") return "warning";
  return undefined;
}

function boundedLifecycleText(value: string, maxChars: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function advisorRecommendationPlanScope(args: {
  options: ProjectRunCommandOptions;
  recommendationId: string;
  totalRecommendationCount: number;
}): AdvisorRecommendationPlanScope {
  const requestedRecommendationId = stringValue(args.options.advisorRecommendationId) ?? null;
  if (requestedRecommendationId) {
    const targeted = requestedRecommendationId === args.recommendationId;
    return {
      mode: targeted ? "explicit_match" : "explicit_non_match",
      requestedRecommendationId,
      targeted,
      totalRecommendationCount: args.totalRecommendationCount,
    };
  }
  if (args.totalRecommendationCount === 1) {
    return {
      mode: "automatic_single_recommendation",
      requestedRecommendationId: null,
      targeted: true,
      totalRecommendationCount: 1,
    };
  }
  return {
    mode: "multiple_recommendations_require_selector",
    requestedRecommendationId: null,
    targeted: false,
    totalRecommendationCount: args.totalRecommendationCount,
  };
}

function advisorLifecycleEvidenceFromOutcomeReceipts(args: {
  recommendationId: string;
  outcomeReceipts: OutcomeIntelligenceReceipt[];
}): AdvisorInfluenceLifecycleEvidence[] {
  const evidence: AdvisorInfluenceLifecycleEvidence[] = [];
  for (const receipt of args.outcomeReceipts) {
    if (!receipt.decision.advisorRecommendationIds?.includes(args.recommendationId)) continue;

    receipt.verification.evidence.forEach((item, index) => {
      const status = advisorLifecycleEvidenceStatus(item.status);
      if (!status) return;
      const detail = boundedLifecycleText(
        [item.label, item.command, item.detail].filter(Boolean).join(" — "),
        900
      );
      evidence.push({
        kind: "execution",
        ref: boundedLifecycleText(`${receipt.receiptId}#verification-${index + 1}`, 500),
        status,
        ...(detail ? { detail } : {}),
      });
    });

    const outcomeStatus = advisorLifecycleOutcomeStatus(receipt.outcome.status);
    if (outcomeStatus) {
      evidence.push({
        kind: "outcome",
        ref: boundedLifecycleText(receipt.receiptId, 500),
        status: outcomeStatus,
        detail: boundedLifecycleText(receipt.outcome.summary, 900),
      });
    }
  }
  return evidence;
}

function advisorReceiptBehaviorChange(args: {
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number];
  lifecycle: AdvisorInfluenceLifecycle;
  planScope: AdvisorRecommendationPlanScope;
}): string {
  const { lifecycle, recommendation, planScope } = args;
  const beforeHash = lifecycle.planChange.beforeHash?.slice(0, 20) ?? "missing";
  const afterHash = lifecycle.planChange.afterHash?.slice(0, 20) ?? "missing";
  if (lifecycle.state === "verified") {
    return `Recommendation '${recommendation.title}' changed the bounded plan from ${beforeHash} to ${afterHash}; ${lifecycle.evidence.length} recommendation-scoped execution/outcome evidence item(s) verified the applied change.`;
  }
  if (lifecycle.state === "applied") {
    return `Recommendation '${recommendation.title}' changed the bounded plan from ${beforeHash} to ${afterHash}; no recommendation-scoped execution/outcome evidence verifies it yet.`;
  }
  if (lifecycle.planChange.beforeHash && lifecycle.planChange.afterHash) {
    return `Recommendation '${recommendation.title}' was acknowledged, but the bounded plan hashes are unchanged; application is not proven.`;
  }
  if (!planScope.targeted) {
    return `Recommendation '${recommendation.title}' was acknowledged, but the supplied plan snapshots were not scoped to this recommendation; application is not proven.`;
  }
  return `Recommendation '${recommendation.title}' was acknowledged, but a complete bounded plan-before/plan-after pair was not supplied; application is not proven.`;
}

function verificationExecutedFromLifecycle(lifecycle: AdvisorInfluenceLifecycle): string[] {
  if (lifecycle.state !== "verified") return [];
  return lifecycle.evidence.map((item) =>
    boundedLifecycleText(
      `${item.kind} ${item.ref}: ${item.status}${item.detail ? ` — ${item.detail}` : ""}`,
      900
    )
  );
}

function advisorReceiptMetadata(args: {
  options: ProjectRunCommandOptions;
  brief: ProjectIntelligenceBrief;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number];
  recommendationIndex: number;
  totalRecommendations: number;
  verificationEvidence: ProjectRunVerificationEvidence[];
  lifecycle: AdvisorInfluenceLifecycle;
  planScope: AdvisorRecommendationPlanScope;
  measurementState: ProjectRunAdvisorMeasurementState;
  runEnvelope: ProjectIntelligenceRunEnvelope;
}): Record<string, unknown> {
  const toolActions = normalizeStringList([
    ...args.recommendation.recommendedVerification,
    ...args.judgmentCard.requiredActions.map((action) => action.command ?? action.title),
  ]).slice(0, 20);
  const filesAffected = normalizeStringList([
    ...(args.brief.changedFiles ?? []),
    ...(args.options.changedFiles ?? []),
  ]).slice(0, 80);
  return {
    source: "snipara-companion:run",
    firstParty: true,
    runVersion: "project-intelligence.production-run.v1",
    runId: args.runEnvelope.runId,
    runEnvelope: args.runEnvelope,
    generatedAt: args.judgmentCard.generatedAt,
    release: Boolean(args.options.release),
    task: args.brief.task ?? args.options.task ?? null,
    branch: args.brief.branch ?? args.options.branch ?? null,
    filesAffected,
    changedFiles: filesAffected,
    planBefore: args.lifecycle.planChange.before,
    planAfter: args.lifecycle.planChange.after,
    changedBecauseOfRecommendation: args.lifecycle.planChange.changed,
    advisorInfluenceLifecycle: args.lifecycle,
    advisorPlanScope: args.planScope,
    advisorMeasurement: {
      version: "project-intelligence.advisor-measurement.v1",
      state: args.measurementState,
      targeted: args.planScope.targeted,
      identityLinked: true,
    },
    toolActions,
    humanOverride: null,
    judgmentState: args.judgmentCard.state,
    canProceed: args.judgmentCard.canProceed,
    verificationEvidence: args.verificationEvidence,
    verificationBackfill: {
      version: "advisor-receipt-verification-backfill-v1",
      executedCount: args.verificationEvidence.filter((item) => item.status !== "skipped").length,
      skippedCount: args.verificationEvidence.filter((item) => item.status === "skipped").length,
      qualifyingLifecycleEvidenceCount: args.lifecycle.evidence.length,
      caveat:
        "Run diagnostics are retained for compatibility but do not advance the lifecycle; only recommendation-scoped execution/outcome evidence can verify an applied change.",
    },
    receiptAutomation: {
      version: "first-party-advisor-receipt-automation-v2",
      trigger: "snipara-companion run",
      selectedRecommendationRank: args.recommendationIndex + 1,
      totalRecommendations: args.totalRecommendations,
      writeLimit: ADVISOR_RECEIPT_WRITE_LIMIT,
      skipReason: null,
      reason: `served judgment was acknowledged; lifecycle state is ${args.lifecycle.state}`,
    },
  };
}

function skippedAdvisorReceiptWrite(
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number],
  reason: ProjectRunAdvisorReceiptSkipReason,
  agentDecision?: AdvisorInfluenceAgentDecision,
  changedBecauseOfRecommendation?: boolean
): ProjectRunAdvisorReceiptWrite {
  return {
    advisorRecommendationId: recommendation.id,
    status: "skipped",
    ...(agentDecision ? { agentDecision } : {}),
    ...(changedBecauseOfRecommendation !== undefined ? { changedBecauseOfRecommendation } : {}),
    reason,
  };
}

function advisorReceiptCaptureStatus(args: {
  eligibleCount: number;
  recordedCount: number;
  skippedCount: number;
  errorCount: number;
}): ProjectRunAdvisorReceiptCapture["status"] {
  if (args.eligibleCount === 0) return "skipped";
  if (
    args.recordedCount === args.eligibleCount &&
    args.errorCount === 0 &&
    args.skippedCount === 0
  ) {
    return "recorded";
  }
  if (args.recordedCount > 0) return "partial";
  if (args.errorCount > 0) return "error";
  return "skipped";
}

function verificationEvidenceFromRun(args: {
  guard?: ProjectRunGuardResult;
  packageReview?: ProjectRunPackageReview;
  policyGates?: ProjectPolicyGatesResult;
}): ProjectRunVerificationEvidence[] {
  const evidence: ProjectRunVerificationEvidence[] = [];
  if (args.guard) {
    evidence.push({
      source: "collaboration_guard",
      label: "Collaboration guard",
      status: args.guard.status === 0 ? "passed" : "failed",
      command: args.guard.command,
      exitCode: args.guard.status,
      detail:
        args.guard.status === 0
          ? "Pre-deploy collaboration guard passed or only review-only warnings were acknowledged."
          : (args.guard.error ?? args.guard.stderr.trim() ?? `Guard exited ${args.guard.status}.`),
    });
  }
  if (args.packageReview) {
    evidence.push({
      source: "package_review",
      label: "Package surface review",
      status:
        args.packageReview.status === "ok"
          ? "passed"
          : args.packageReview.status === "skipped"
            ? "skipped"
            : "failed",
      command: args.packageReview.command,
      detail:
        args.packageReview.status === "ok"
          ? "npm package metadata was read successfully."
          : (args.packageReview.error ?? `Package review ${args.packageReview.status}.`),
    });
  }
  if (args.policyGates) {
    evidence.push({
      source: "policy_gates",
      label: "Policy gates",
      status:
        args.policyGates.summary.block > 0
          ? "failed"
          : args.policyGates.summary.requiredAction > 0
            ? "warning"
            : "passed",
      detail: `Strongest policy gate: ${args.policyGates.summary.strongestSeverity}; advisory ${args.policyGates.summary.advisory}, required ${args.policyGates.summary.requiredAction}, block ${args.policyGates.summary.block}.`,
    });
  }
  return evidence;
}

function buildPolicyDecisionRequest(args: {
  run: ProjectIntelligenceRunResult;
}): DecisionRequest | undefined {
  const decision = args.run.policyGates.projectPolicyDecision;
  if (!decision || decision.verdict === "allow") return undefined;

  const changedFiles = args.run.brief.changedFiles.slice(0, 24);
  const matchedRules = decision.matchedRules.slice(0, 8);
  const options =
    decision.verdict === "block"
      ? ["respect_block", "request_exception", "mark_policy_stale"]
      : ["approve_once", "require_changes", "mark_policy_stale", "keep_advisory"];
  const recommendation = decision.verdict === "block" ? "respect_block" : "approve_once";

  return buildDecisionRequest({
    producer: {
      kind: "project_policy_review",
      command: "run --emit-policy-decisions",
      sourceRef: decision.receipt.receiptId,
    },
    decision: `project_policy_${decision.verdict}`,
    question:
      decision.verdict === "block"
        ? "Project Policy blocked this action. Should the agent stop, request an exception, or mark the policy stale?"
        : "Project Policy requires human review. May the agent proceed once, change plan, or mark the policy stale?",
    evidence: {
      summary: `Project Policy verdict ${decision.verdict} for task '${args.run.brief.task ?? "unspecified"}'. Receipt ${decision.receipt.receiptId}.`,
      refs: uniqueStrings([decision.receipt.receiptId, ...decision.receipt.ruleRefs]),
      items: matchedRules.map((rule) => ({
        ref: rule.source.ref,
        title: rule.title,
        summary: rule.requirement,
        kind: rule.source.kind,
        status: rule.strength,
        metadata: {
          ruleId: rule.id,
          scope: rule.scope,
          confidence: rule.confidence,
          reviewStatus: rule.source.reviewStatus ?? null,
        },
      })),
      reasonCodes: uniqueStrings(["project_policy_review", ...decision.reasonCodes]),
      files: changedFiles,
      applyPath: "manual_context_review",
      applyCommand:
        "Resolve with `snipara-companion workflow decide <request-id> --choose <option> --reviewer <name>`; if policy is stale, update or invalidate the cited decision/policy before rerunning `snipara-companion run`.",
    },
    options,
    recommendation,
    rationale:
      "Project Policy decisions stay agent-first: the agent asks for explicit human governance and records a response receipt; no dashboard or silent policy mutation is required.",
    blocking: true,
    fingerprintParts: [
      "project_policy_review_v1",
      decision.receipt.receiptId,
      decision.verdict,
      decision.receipt.ruleRefs,
      changedFiles,
    ],
  });
}

function emitPolicyDecisionRequests(
  run: ProjectIntelligenceRunResult
): ProjectRunPolicyDecisionRequests {
  const requests = [buildPolicyDecisionRequest({ run })].filter(
    (request): request is DecisionRequest => Boolean(request)
  );
  const writes = requests.map((request) => writeDecisionRequest(request));
  return {
    version: "project-intelligence.policy-decision-requests.v1",
    emitted: true,
    requestCount: requests.length,
    requests,
    writes,
    caveats: [
      "Policy decision requests never apply policy changes automatically.",
      "Resolve them with workflow decide so the human choice is recorded as a local response receipt.",
      "Marking a policy stale is a governance signal; the cited memory or policy still needs explicit update or invalidation.",
    ],
  };
}

async function recordFirstPartyAdvisorReceipts(args: {
  options: ProjectRunCommandOptions;
  brief: ProjectIntelligenceBrief;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  verificationEvidence?: ProjectRunVerificationEvidence[];
  outcomeReceipts?: OutcomeIntelligenceReceipt[];
  runEnvelope: ProjectIntelligenceRunEnvelope;
}): Promise<ProjectRunAdvisorReceiptCapture | undefined> {
  const allRecommendations = args.judgmentCard.advisorRecommendations;
  const servedJudgmentId = servedJudgmentIdForRun(args.options, args.brief);
  if (args.options.skipAdvisorReceipts) {
    const writes: ProjectRunAdvisorReceiptWrite[] = [];
    return {
      status: "skipped",
      totalRecommendationCount: allRecommendations.length,
      eligibleCount: 0,
      attemptedCount: 0,
      recordedCount: 0,
      skippedCount: allRecommendations.length,
      writes,
      measurement: advisorMeasurementCoverage({
        servedJudgmentId,
        recommendationCount: allRecommendations.length,
        writes,
      }),
      reason: "explicitly_skipped",
    };
  }

  if (allRecommendations.length === 0) {
    const writes: ProjectRunAdvisorReceiptWrite[] = [];
    return {
      status: "skipped",
      totalRecommendationCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      recordedCount: 0,
      skippedCount: 0,
      writes,
      measurement: advisorMeasurementCoverage({ servedJudgmentId, recommendationCount: 0, writes }),
      reason: "no_advisor_recommendations",
    };
  }

  if (!servedJudgmentId) {
    const writes = allRecommendations
      .slice(0, ADVISOR_RECEIPT_WRITE_LIMIT)
      .map((recommendation) =>
        skippedAdvisorReceiptWrite(recommendation, "missing_served_judgment_id")
      );
    return {
      status: "skipped",
      totalRecommendationCount: allRecommendations.length,
      eligibleCount: 0,
      attemptedCount: 0,
      recordedCount: 0,
      skippedCount: writes.length,
      writes,
      measurement: advisorMeasurementCoverage({
        recommendationCount: allRecommendations.length,
        writes,
      }),
      reason: "missing_served_judgment_id",
    };
  }

  const client = createClient(10000);
  const verificationEvidence = args.verificationEvidence ?? [];
  const outcomeReceipts = args.outcomeReceipts ?? [];
  const selectedRecommendations = allRecommendations.slice(0, ADVISOR_RECEIPT_WRITE_LIMIT);
  const overflowWrites = allRecommendations
    .slice(ADVISOR_RECEIPT_WRITE_LIMIT)
    .map((recommendation) => skippedAdvisorReceiptWrite(recommendation, "write_limit_exceeded"));
  const writes = [
    ...(await Promise.all(
      selectedRecommendations.map(
        async (recommendation, recommendationIndex): Promise<ProjectRunAdvisorReceiptWrite> => {
          const planScope = advisorRecommendationPlanScope({
            options: args.options,
            recommendationId: recommendation.id,
            totalRecommendationCount: allRecommendations.length,
          });
          const lifecycle = buildAdvisorInfluenceLifecycle({
            recommendationId: recommendation.id,
            generatedAt: args.judgmentCard.generatedAt,
            acknowledged: true,
            planBefore: planScope.targeted ? args.options.advisorPlanBefore : undefined,
            planAfter: planScope.targeted ? args.options.advisorPlanAfter : undefined,
            evidence: advisorLifecycleEvidenceFromOutcomeReceipts({
              recommendationId: recommendation.id,
              outcomeReceipts,
            }),
          });
          const agentDecision = advisorReceiptDecision(
            recommendation,
            args.judgmentCard,
            lifecycle
          );
          const changedBecauseOfRecommendation = lifecycle.planChange.changed;
          const verificationExecuted = verificationExecutedFromLifecycle(lifecycle);
          const measurementState = advisorMeasurementState({
            agentDecision,
            lifecycle,
            planScope,
          });

          try {
            const behaviorChange = advisorReceiptBehaviorChange({
              recommendation,
              lifecycle,
              planScope,
            });
            const result = await client.recordAdvisorInfluenceReceipt({
              servedJudgmentId,
              recommendation: advisorReceiptRecommendation(recommendation),
              agentDecision,
              behaviorChange,
              verificationExecuted,
              // The backend owns canonical OutcomeSignal linking. Companion can
              // carry external lifecycle evidence, but creation stays pending.
              outcomeLinkStatus: "pending",
              metadata: advisorReceiptMetadata({
                options: args.options,
                brief: args.brief,
                judgmentCard: args.judgmentCard,
                recommendation,
                recommendationIndex,
                totalRecommendations: allRecommendations.length,
                verificationEvidence,
                lifecycle,
                planScope,
                measurementState,
                runEnvelope: args.runEnvelope,
              }),
            });
            return {
              advisorRecommendationId: recommendation.id,
              status: "recorded",
              agentDecision,
              changedBecauseOfRecommendation,
              lifecycleState: lifecycle.state,
              measurementState,
              targeted: planScope.targeted,
              result,
            };
          } catch (error) {
            return {
              advisorRecommendationId: recommendation.id,
              status: "error",
              agentDecision,
              changedBecauseOfRecommendation,
              lifecycleState: lifecycle.state,
              measurementState: "unmeasured",
              targeted: planScope.targeted,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      )
    )),
    ...overflowWrites,
  ];

  const recordedCount = writes.filter((write) => write.status === "recorded").length;
  const skippedCount = writes.filter((write) => write.status === "skipped").length;
  const errorCount = writes.filter((write) => write.status === "error").length;
  const eligibleCount = writes.filter((write) => write.status !== "skipped").length;
  return {
    status: advisorReceiptCaptureStatus({
      eligibleCount,
      recordedCount,
      skippedCount,
      errorCount,
    }),
    servedJudgmentId,
    totalRecommendationCount: allRecommendations.length,
    eligibleCount,
    attemptedCount: eligibleCount,
    recordedCount,
    skippedCount,
    writes,
    measurement: advisorMeasurementCoverage({
      servedJudgmentId,
      recommendationCount: allRecommendations.length,
      writes,
    }),
  };
}

function runGuard(
  options: ProjectRunCommandOptions,
  changedFiles: string[]
): ProjectRunGuardResult {
  const cliPath = process.argv[1] || "snipara-companion";
  const args = [
    cliPath,
    "collaboration",
    "guard",
    "--profile",
    "pre-deploy",
    "--enforce",
    "--ack-review-only",
    "--json",
  ];
  if (changedFiles.length > 0) {
    args.push("--files", ...changedFiles);
  }
  if (options.task) {
    args.push("--action", options.release ? "release" : "run");
  }

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: GUARD_MAX_BUFFER_BYTES,
  });

  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    if (isRecord(parsed)) {
      payload = parsed;
    }
  } catch {
    // Keep raw stdout/stderr in the result; callers still get an actionable caveat.
  }

  return {
    command: `${process.execPath} ${args.join(" ")}`,
    status: result.status,
    stdout: outputPreview(result.stdout),
    stderr: outputPreview(result.stderr),
    ...(payload ? { payload } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function runPackageReview(options: ProjectRunCommandOptions): ProjectRunPackageReview {
  if (options.skipPackageReview) {
    return {
      command: packageReviewCommand(),
      status: "skipped",
      packageName: "snipara-companion",
    };
  }

  try {
    const output = execFileSync(
      "npm",
      ["view", "snipara-companion", "version", "bin", "dist-tags", "--json"],
      {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return {
      command: packageReviewCommand(),
      status: "ok",
      packageName: "snipara-companion",
      data: JSON.parse(output),
    };
  } catch (error) {
    return {
      command: packageReviewCommand(),
      status: "error",
      packageName: "snipara-companion",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildProjectIntelligenceRun(
  options: ProjectRunCommandOptions
): Promise<ProjectIntelligenceRunResult> {
  const runEnvelope = buildProjectIntelligenceRunEnvelope();
  const changedFiles = normalizeStringList(options.changedFiles);
  const brief = await buildProjectIntelligenceBrief({
    task: options.task,
    branch: options.branch,
    changedFiles,
    recentFiles: options.recentFiles,
    diffSummary: options.diffSummary,
    maxTokens: options.maxTokens,
    skipImpact: options.skipImpact,
    skipMemoryHealth: options.skipMemoryHealth,
  });

  const guard = options.release && !options.skipGuard ? runGuard(options, changedFiles) : undefined;
  const packageReview =
    options.release || changedFiles.some((file) => file.startsWith("packages/cli/"))
      ? runPackageReview(options)
      : undefined;
  let outcomeCalibration: OutcomeIntelligenceCalibration | undefined;
  let outcomeCalibrationError: string | undefined;
  let outcomeReceipts: OutcomeIntelligenceReceipt[] = [];
  try {
    outcomeReceipts = readOutcomeReceipts(options.outcomeReceiptFiles);
    if (outcomeReceipts.length > 0) {
      outcomeCalibration = buildOutcomeIntelligenceCalibration({ receipts: outcomeReceipts });
    }
  } catch (error) {
    outcomeCalibrationError = error instanceof Error ? error.message : String(error);
  }

  const runErrors = [
    ...brief.errors,
    ...(guard && guard.status !== 0
      ? [
          {
            surface: "collaboration_guard",
            message: guard.error ?? guard.stderr.trim() ?? `guard exited ${guard.status}`,
          },
        ]
      : []),
    ...(packageReview?.status === "error"
      ? [
          {
            surface: "package_review",
            message: packageReview.error ?? "package review failed",
          },
        ]
      : []),
    ...(outcomeCalibrationError
      ? [
          {
            surface: "outcome_calibration",
            message: outcomeCalibrationError,
          },
        ]
      : []),
  ];

  const judgmentCard = buildProjectJudgmentCard({
    task: options.task,
    branch: brief.branch,
    changedFiles,
    resumeContext: brief.resumeContext,
    memoryHealth: brief.memoryHealth,
    codeImpact: brief.codeImpact,
    verificationPlan: brief.verificationPlan as unknown as Record<string, unknown>,
    guard: guardPayload(guard),
    packageReview: packageReview as unknown as Record<string, unknown> | undefined,
    advisoryObservability: outcomeCalibration as unknown as Record<string, unknown> | undefined,
    errors: runErrors,
  });
  const policyGates = evaluateProjectPolicyGates({
    task: options.task,
    release: options.release,
    changedFiles,
    diffSummary: options.diffSummary,
    skipGuard: options.skipGuard,
    skipPackageReview: options.skipPackageReview,
    guard,
    packageReview,
    judgmentCard,
    projectPolicy: brief.projectPolicyDecision
      ? {
          decision: brief.projectPolicyDecision,
        }
      : undefined,
  });
  const verificationEvidence = verificationEvidenceFromRun({
    guard,
    packageReview,
    policyGates,
  });
  const advisorReceiptCapture = await recordFirstPartyAdvisorReceipts({
    options,
    brief,
    judgmentCard,
    verificationEvidence,
    outcomeReceipts,
    runEnvelope,
  });

  const suggestedCommands = [
    ...brief.suggestedCommands,
    ...policyGates.suggestedCommands,
    ...(options.release
      ? [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
          ...(!options.skipPackageReview && packageReview?.status !== "ok"
            ? [packageReviewCommand()]
            : []),
        ]
      : []),
  ];

  const result: ProjectIntelligenceRunResult = {
    version: "project-intelligence.production-run.v1",
    generatedAt: runEnvelope.startedAt,
    runEnvelope,
    release: Boolean(options.release),
    brief,
    ...(guard ? { guard } : {}),
    ...(packageReview ? { packageReview } : {}),
    policyGates,
    ...(advisorReceiptCapture ? { advisorReceiptCapture } : {}),
    ...(outcomeCalibration ? { outcomeCalibration } : {}),
    judgmentCard,
    suggestedCommands: [...new Set(suggestedCommands)],
  };

  if (options.emitPolicyDecisions) {
    result.policyDecisionRequests = emitPolicyDecisionRequests(result);
  }

  return result;
}

export async function projectIntelligenceRunCommand(
  options: ProjectRunCommandOptions
): Promise<void> {
  const result = await buildProjectIntelligenceRun(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.bold("Project Intelligence Run"));
    if (result.brief.task) {
      console.log(`Task: ${result.brief.task}`);
    }
    console.log(`Release: ${result.release ? "yes" : "no"}`);
    console.log(`Run: ${result.runEnvelope.runId} (${result.runEnvelope.identitySource})`);
    console.log("");

    console.log(chalk.bold("Project Judgment"));
    for (const line of formatProjectJudgmentCard(result.judgmentCard)) {
      console.log(line);
    }
    console.log("");

    if (result.policyGates.gates.length > 0) {
      console.log(chalk.bold("Policy Gates"));
      console.log(
        `Strongest: ${result.policyGates.summary.strongestSeverity}; advisory ${result.policyGates.summary.advisory}, required ${result.policyGates.summary.requiredAction}, block ${result.policyGates.summary.block}`
      );
      for (const gateDecision of result.policyGates.gates.slice(0, 8)) {
        for (const line of formatPolicyGateDecision(gateDecision)) {
          console.log(line);
        }
      }
      console.log("");
    }

    if (result.guard) {
      console.log(chalk.bold("Guard"));
      console.log(`Status: ${result.guard.status}`);
      const actionCards = isRecord(result.guard.payload)
        ? (result.guard.payload.actionCards as unknown[])
        : [];
      if (Array.isArray(actionCards) && actionCards.length > 0) {
        for (const card of actionCards.slice(0, 6)) {
          if (!isRecord(card)) continue;
          console.log(`- ${card.kind}: ${card.title ?? card.reason ?? "guard action"}`);
        }
      }
      console.log("");
    }

    if (result.packageReview) {
      console.log(chalk.bold("Package Review"));
      console.log(`${result.packageReview.packageName}: ${result.packageReview.status}`);
      if (result.packageReview.error) {
        console.log(result.packageReview.error);
      }
      console.log("");
    }

    if (result.advisorReceiptCapture) {
      console.log(chalk.bold("Advisor Receipts"));
      console.log(`Status: ${result.advisorReceiptCapture.status}`);
      if (result.advisorReceiptCapture.servedJudgmentId) {
        console.log(`Served judgment: ${result.advisorReceiptCapture.servedJudgmentId}`);
      }
      console.log(
        `Recorded: ${result.advisorReceiptCapture.recordedCount}/${result.advisorReceiptCapture.attemptedCount}`
      );
      const measurement = result.advisorReceiptCapture.measurement;
      console.log(
        `Measurement: ${measurement.identityStatus}; targeted ${measurement.targetedCount}, unscoped ${measurement.unscopedCount}, applied ${measurement.appliedCount}, verified ${measurement.verifiedCount}, unmeasured ${measurement.unmeasuredCount}`
      );
      if (result.advisorReceiptCapture.skippedCount > 0) {
        console.log(`Skipped: ${result.advisorReceiptCapture.skippedCount}`);
      }
      if (result.advisorReceiptCapture.reason) {
        console.log(`Reason: ${result.advisorReceiptCapture.reason}`);
      }
      for (const write of result.advisorReceiptCapture.writes.slice(0, 4)) {
        if (write.status === "skipped" && write.reason) {
          console.log(`- skipped ${write.advisorRecommendationId}: ${write.reason}`);
        }
      }
      console.log("");
    }

    if (result.outcomeCalibration) {
      console.log(chalk.bold("Outcome Intelligence"));
      console.log(`Receipts: ${result.outcomeCalibration.receiptCount}`);
      for (const bucket of result.outcomeCalibration.buckets.slice(0, 5)) {
        const rate =
          bucket.positiveRate === null ? "n/a" : `${Math.round(bucket.positiveRate * 100)}%`;
        console.log(
          `- ${bucket.reasonCode} / ${bucket.taskKind}/${bucket.risk}: ${rate} (${bucket.confidence}, n=${bucket.sampleCount})`
        );
      }
      if (result.outcomeCalibration.caveats.length > 0) {
        console.log(`Caveat: ${result.outcomeCalibration.caveats[0]}`);
      }
      console.log("");
    }

    console.log(chalk.bold("Suggested Commands"));
    for (const command of result.suggestedCommands.slice(0, 8)) {
      console.log(command);
    }
  }

  if (result.judgmentCard.canProceed === "block" || result.policyGates.summary.block > 0) {
    process.exitCode = 2;
  }
}
