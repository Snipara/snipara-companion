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
  status: "recorded" | "error";
  result?: RecordAdvisorInfluenceReceiptResult;
  error?: string;
}

export interface ProjectRunAdvisorReceiptCapture {
  status: "skipped" | "recorded" | "partial" | "error";
  servedJudgmentId?: string;
  attemptedCount: number;
  recordedCount: number;
  writes: ProjectRunAdvisorReceiptWrite[];
  reason?: string;
}

export interface ProjectIntelligenceRunResult {
  version: "project-intelligence.production-run.v1";
  generatedAt: string;
  release: boolean;
  brief: ProjectIntelligenceBrief;
  guard?: ProjectRunGuardResult;
  packageReview?: ProjectRunPackageReview;
  advisorReceiptCapture?: ProjectRunAdvisorReceiptCapture;
  judgmentCard: ProjectIntelligenceJudgmentCard;
  suggestedCommands: string[];
}

const GUARD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const RAW_OUTPUT_PREVIEW_BYTES = 64_000;

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

async function recordFirstPartyAdvisorReceipts(args: {
  options: ProjectRunCommandOptions;
  brief: ProjectIntelligenceBrief;
  judgmentCard: ProjectIntelligenceJudgmentCard;
}): Promise<ProjectRunAdvisorReceiptCapture | undefined> {
  if (args.options.skipAdvisorReceipts) {
    return {
      status: "skipped",
      attemptedCount: 0,
      recordedCount: 0,
      writes: [],
      reason: "advisor receipt capture was explicitly skipped",
    };
  }

  if (args.judgmentCard.advisorRecommendations.length === 0) {
    return undefined;
  }

  const servedJudgmentId = servedJudgmentIdForRun(args.options, args.brief);
  if (!servedJudgmentId) {
    return {
      status: "skipped",
      attemptedCount: 0,
      recordedCount: 0,
      writes: [],
      reason: "no served judgment id was available for first-party advisor receipts",
    };
  }

  const client = createClient(10000);
  const recommendations = args.judgmentCard.advisorRecommendations.slice(0, 6);
  const writes = await Promise.all(
    recommendations.map(async (recommendation): Promise<ProjectRunAdvisorReceiptWrite> => {
      try {
        const result = await client.recordAdvisorInfluenceReceipt({
          servedJudgmentId,
          recommendation: advisorReceiptRecommendation(recommendation),
          agentDecision: advisorReceiptDecision(recommendation, args.judgmentCard),
          behaviorChange: advisorReceiptBehaviorChange(recommendation, args.judgmentCard),
          verificationExecuted: [],
          outcomeLinkStatus: "pending",
          metadata: {
            source: "snipara-companion:run",
            firstParty: true,
            runVersion: "project-intelligence.production-run.v1",
            generatedAt: args.judgmentCard.generatedAt,
            release: Boolean(args.options.release),
            branch: args.brief.branch ?? args.options.branch ?? null,
            changedFiles: args.brief.changedFiles,
            judgmentState: args.judgmentCard.state,
            canProceed: args.judgmentCard.canProceed,
          },
        });
        return {
          advisorRecommendationId: recommendation.id,
          status: "recorded",
          result,
        };
      } catch (error) {
        return {
          advisorRecommendationId: recommendation.id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const recordedCount = writes.filter((write) => write.status === "recorded").length;
  return {
    status: recordedCount === writes.length ? "recorded" : recordedCount > 0 ? "partial" : "error",
    servedJudgmentId,
    attemptedCount: writes.length,
    recordedCount,
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
  const advisorReceiptCapture = await recordFirstPartyAdvisorReceipts({
    options,
    brief,
    judgmentCard,
  });

  const suggestedCommands = [
    ...brief.suggestedCommands,
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
      if (result.advisorReceiptCapture.reason) {
        console.log(result.advisorReceiptCapture.reason);
      }
      console.log("");
    }

    console.log(chalk.bold("Suggested Commands"));
    for (const command of result.suggestedCommands.slice(0, 8)) {
      console.log(command);
    }
  }

  if (result.judgmentCard.canProceed === "block") {
    process.exitCode = 2;
  }
}
