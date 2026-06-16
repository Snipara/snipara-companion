/**
 * `run` command — production Project Intelligence orchestration.
 *
 * This command is the direct dogfood entrypoint for agents: build the brief,
 * verification plan, release guard evidence, package surface note, and final
 * Judgment Card in one pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import chalk from "chalk";
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

export interface ProjectIntelligenceRunResult {
  version: "project-intelligence.production-run.v1";
  generatedAt: string;
  release: boolean;
  brief: ProjectIntelligenceBrief;
  guard?: ProjectRunGuardResult;
  packageReview?: ProjectRunPackageReview;
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
    errors: runErrors,
  });

  const suggestedCommands = [
    ...brief.suggestedCommands,
    ...(options.release
      ? [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
          packageReviewCommand(),
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

    console.log(chalk.bold("Suggested Commands"));
    for (const command of result.suggestedCommands.slice(0, 8)) {
      console.log(command);
    }
  }

  if (result.judgmentCard.canProceed === "block") {
    process.exitCode = 2;
  }
}
