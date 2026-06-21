/**
 * `run` command — production Project Intelligence orchestration.
 *
 * This command is the direct dogfood entrypoint for agents: build the brief,
 * verification plan, release guard evidence, package surface note, and final
 * Judgment Card in one pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import chalk from "chalk";
import {
  createClient,
  type AdvisorInfluenceAgentDecision,
  type AdvisorInfluenceRecommendationInput,
  type RecordAdvisorInfluenceReceiptResult,
} from "../api/client";
import { buildProjectIntelligenceBrief, type ProjectIntelligenceBrief } from "./intelligence";
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
  result?: RecordAdvisorInfluenceReceiptResult;
  reason?: ProjectRunAdvisorReceiptSkipReason;
  error?: string;
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
  release: boolean;
  brief: ProjectIntelligenceBrief;
  guard?: ProjectRunGuardResult;
  packageReview?: ProjectRunPackageReview;
  policyGates: ProjectPolicyGatesResult;
  advisorReceiptCapture?: ProjectRunAdvisorReceiptCapture;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  suggestedCommands: string[];
}

const GUARD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const RAW_OUTPUT_PREVIEW_BYTES = 64_000;
const ADVISOR_RECEIPT_WRITE_LIMIT = 6;

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
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

function outputPreview(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= RAW_OUTPUT_PREVIEW_BYTES) {
    return value;
  }
  return `${value.slice(0, RAW_OUTPUT_PREVIEW_BYTES)}\n...[truncated]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function servedJudgmentIdFromUnknown(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) {
        const found = servedJudgmentIdFromUnknown(item, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  const direct = stringValue(value.servedJudgmentId) ?? stringValue(value.served_judgment_id);
  if (direct) {
    return direct;
  }

  for (const key of [
    "projectIntelligence",
    "project_intelligence",
    "brief",
    "judgment",
    "resumeContext",
    "resume_context",
    "data",
  ]) {
    const found = servedJudgmentIdFromUnknown(value[key], depth + 1);
    if (found) return found;
  }

  return undefined;
}

function servedJudgmentIdForRun(
  options: ProjectRunCommandOptions,
  brief: ProjectIntelligenceBrief
): string | undefined {
  return (
    stringValue(options.servedJudgmentId) ??
    servedJudgmentIdFromUnknown(brief.resumeContext) ??
    servedJudgmentIdFromUnknown(brief.verificationPlan)
  );
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
    caveats: ["First-party companion receipt records plan adaptation, not outcome proof."],
  };
}

function advisorReceiptDecision(
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number],
  judgmentCard: ProjectIntelligenceJudgmentCard
): AdvisorInfluenceAgentDecision {
  if (recommendation.severity === "block" && judgmentCard.canProceed === "block") {
    return "blocked";
  }
  return "modified";
}

function advisorReceiptChangedBecauseOfRecommendation(args: {
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number];
  judgmentCard: ProjectIntelligenceJudgmentCard;
}): boolean {
  if (args.recommendation.severity === "block" && args.judgmentCard.canProceed === "block") {
    return true;
  }
  if (args.recommendation.severity === "risk") {
    return true;
  }
  if (args.recommendation.expectedBehaviorChange?.trim()) {
    return true;
  }
  if (args.recommendation.recommendedVerification.length > 0) {
    return true;
  }
  return args.judgmentCard.requiredActions.length > 0;
}

function advisorReceiptBehaviorChange(
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number],
  judgmentCard: ProjectIntelligenceJudgmentCard
): string {
  const verification = recommendation.recommendedVerification.slice(0, 3).join("; ");
  const mode =
    recommendation.severity === "block" || recommendation.severity === "risk"
      ? "required action"
      : "advisory action";
  return [
    `snipara-companion run added a ${mode} from Project Advisor: ${recommendation.title}.`,
    recommendation.expectedBehaviorChange
      ? `Expected adaptation: ${recommendation.expectedBehaviorChange}.`
      : null,
    verification ? `Recommended verification to perform: ${verification}.` : null,
    `Judgment state after adaptation: ${judgmentCard.state}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function advisorReceiptPlanBefore(options: ProjectRunCommandOptions): string | null {
  return (
    options.task ??
    options.diffSummary ??
    (options.changedFiles && options.changedFiles.length > 0
      ? `Work on ${options.changedFiles.slice(0, 8).join(", ")}`
      : null)
  );
}

function advisorReceiptPlanAfter(args: {
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number];
  behaviorChange: string;
  judgmentCard: ProjectIntelligenceJudgmentCard;
}): string {
  const requiredActions = args.judgmentCard.requiredActions
    .slice(0, 5)
    .map((action) => action.command ?? action.title)
    .filter(Boolean);
  return [
    args.behaviorChange,
    requiredActions.length > 0
      ? `Visible plan now includes required action(s): ${requiredActions.join("; ")}.`
      : null,
    args.recommendation.recommendedVerification.length > 0
      ? `Recommended verification stays open: ${args.recommendation.recommendedVerification
          .slice(0, 5)
          .join("; ")}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function advisorReceiptMetadata(args: {
  options: ProjectRunCommandOptions;
  brief: ProjectIntelligenceBrief;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  recommendation: ProjectIntelligenceJudgmentCard["advisorRecommendations"][number];
  recommendationIndex: number;
  totalRecommendations: number;
  verificationEvidence: ProjectRunVerificationEvidence[];
  agentDecision: AdvisorInfluenceAgentDecision;
  behaviorChange: string;
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
    runId: process.env.SNIPARA_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? null,
    generatedAt: args.judgmentCard.generatedAt,
    release: Boolean(args.options.release),
    task: args.brief.task ?? args.options.task ?? null,
    branch: args.brief.branch ?? args.options.branch ?? null,
    filesAffected,
    changedFiles: filesAffected,
    planBefore: advisorReceiptPlanBefore(args.options),
    planAfter: advisorReceiptPlanAfter({
      recommendation: args.recommendation,
      behaviorChange: args.behaviorChange,
      judgmentCard: args.judgmentCard,
    }),
    changedBecauseOfRecommendation: args.agentDecision !== "ignored",
    toolActions,
    humanOverride: null,
    judgmentState: args.judgmentCard.state,
    canProceed: args.judgmentCard.canProceed,
    verificationEvidence: args.verificationEvidence,
    verificationBackfill: {
      version: "advisor-receipt-verification-backfill-v1",
      executedCount: args.verificationEvidence.filter((item) => item.status !== "skipped").length,
      skippedCount: args.verificationEvidence.filter((item) => item.status === "skipped").length,
      caveat:
        "Verification evidence records commands or gates observed by this run; it is not outcome proof.",
    },
    receiptAutomation: {
      version: "first-party-advisor-receipt-automation-v1",
      trigger: "snipara-companion run",
      selectedRecommendationRank: args.recommendationIndex + 1,
      totalRecommendations: args.totalRecommendations,
      writeLimit: ADVISOR_RECEIPT_WRITE_LIMIT,
      skipReason: null,
      reason: "served judgment id and plan adaptation were present",
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

function verificationExecutedFromEvidence(evidence: ProjectRunVerificationEvidence[]): string[] {
  return evidence
    .filter((item) => item.status !== "skipped")
    .map((item) =>
      item.command
        ? `${item.label}: ${item.command} (${item.status})`
        : `${item.label}: ${item.status}`
    );
}

async function recordFirstPartyAdvisorReceipts(args: {
  options: ProjectRunCommandOptions;
  brief: ProjectIntelligenceBrief;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  verificationEvidence?: ProjectRunVerificationEvidence[];
}): Promise<ProjectRunAdvisorReceiptCapture | undefined> {
  const allRecommendations = args.judgmentCard.advisorRecommendations;
  if (args.options.skipAdvisorReceipts) {
    return {
      status: "skipped",
      totalRecommendationCount: allRecommendations.length,
      eligibleCount: 0,
      attemptedCount: 0,
      recordedCount: 0,
      skippedCount: allRecommendations.length,
      writes: [],
      reason: "explicitly_skipped",
    };
  }

  if (allRecommendations.length === 0) {
    return {
      status: "skipped",
      totalRecommendationCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      recordedCount: 0,
      skippedCount: 0,
      writes: [],
      reason: "no_advisor_recommendations",
    };
  }

  const servedJudgmentId = servedJudgmentIdForRun(args.options, args.brief);
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
      reason: "missing_served_judgment_id",
    };
  }

  const client = createClient(10000);
  const verificationEvidence = args.verificationEvidence ?? [];
  const verificationExecuted = verificationExecutedFromEvidence(verificationEvidence);
  const selectedRecommendations = allRecommendations.slice(0, ADVISOR_RECEIPT_WRITE_LIMIT);
  const overflowWrites = allRecommendations
    .slice(ADVISOR_RECEIPT_WRITE_LIMIT)
    .map((recommendation) => skippedAdvisorReceiptWrite(recommendation, "write_limit_exceeded"));
  const writes = [
    ...(await Promise.all(
      selectedRecommendations.map(
        async (recommendation, recommendationIndex): Promise<ProjectRunAdvisorReceiptWrite> => {
          const agentDecision = advisorReceiptDecision(recommendation, args.judgmentCard);
          const changedBecauseOfRecommendation = advisorReceiptChangedBecauseOfRecommendation({
            recommendation,
            judgmentCard: args.judgmentCard,
          });
          if (!changedBecauseOfRecommendation) {
            return skippedAdvisorReceiptWrite(
              recommendation,
              "no_plan_adaptation",
              agentDecision,
              false
            );
          }

          try {
            const behaviorChange = advisorReceiptBehaviorChange(recommendation, args.judgmentCard);
            const result = await client.recordAdvisorInfluenceReceipt({
              servedJudgmentId,
              recommendation: advisorReceiptRecommendation(recommendation),
              agentDecision,
              behaviorChange,
              verificationExecuted,
              outcomeLinkStatus: "pending",
              metadata: advisorReceiptMetadata({
                options: args.options,
                brief: args.brief,
                judgmentCard: args.judgmentCard,
                recommendation,
                recommendationIndex,
                totalRecommendations: allRecommendations.length,
                verificationEvidence,
                agentDecision,
                behaviorChange,
              }),
            });
            return {
              advisorRecommendationId: recommendation.id,
              status: "recorded",
              agentDecision,
              changedBecauseOfRecommendation,
              result,
            };
          } catch (error) {
            return {
              advisorRecommendationId: recommendation.id,
              status: "error",
              agentDecision,
              changedBecauseOfRecommendation,
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

  return {
    version: "project-intelligence.production-run.v1",
    generatedAt: new Date().toISOString(),
    release: Boolean(options.release),
    brief,
    ...(guard ? { guard } : {}),
    ...(packageReview ? { packageReview } : {}),
    policyGates,
    ...(advisorReceiptCapture ? { advisorReceiptCapture } : {}),
    judgmentCard,
    suggestedCommands: [...new Set(suggestedCommands)],
  };
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

    console.log(chalk.bold("Suggested Commands"));
    for (const command of result.suggestedCommands.slice(0, 8)) {
      console.log(command);
    }
  }

  if (result.judgmentCard.canProceed === "block" || result.policyGates.summary.block > 0) {
    process.exitCode = 2;
  }
}
