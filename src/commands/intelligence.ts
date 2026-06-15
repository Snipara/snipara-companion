/**
 * `intelligence` / `brief` command — Project Intelligence continuity brief.
 *
 * Composes a single "what changed, why, impact, next action, safe-to-proceed"
 * brief for the current task by combining resume context, memory health, and
 * local code impact. Each source is best-effort: failures are collected into
 * the brief's `errors` array rather than aborting, so a partial brief is still
 * produced. `buildProjectIntelligenceBrief` is the pure core; the command wraps
 * it with I/O and output formatting.
 */
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { createClient } from "../api/client";
import { resolveCodeGraphAutoSourceResult, type CodeGraphSourceSelection } from "./code";

export interface ProjectIntelligenceBriefOptions {
  task?: string;
  branch?: string;
  changedFiles?: string[];
  recentFiles?: string[];
  diffSummary?: string;
  maxTokens?: number;
  skipImpact?: boolean;
  skipMemoryHealth?: boolean;
  json?: boolean;
}

export interface ProjectIntelligenceBrief {
  version: "project-intelligence-brief-v1";
  generatedAt: string;
  branch?: string;
  task?: string;
  changedFiles: string[];
  recentFiles: string[];
  resumeContext?: Record<string, unknown>;
  memoryHealth?: Record<string, unknown>;
  codeImpact?: Record<string, unknown>;
  codeImpactSourceSelection?: CodeGraphSourceSelection;
  errors: Array<{ surface: string; message: string }>;
  suggestedCommands: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatPercentScore(score: number): string {
  const percent = score <= 1 ? score * 100 : score;
  return `${Math.round(percent)}%`;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function detectGitBranch(): string | undefined {
  try {
    const output = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return output && output !== "HEAD" ? output : undefined;
  } catch {
    return undefined;
  }
}

function preview(value: unknown, maxLength = 180): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function nestedRecord(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let current: Record<string, unknown> = root;
  for (const key of keys) {
    const next = current[key];
    if (!isRecord(next)) {
      return {};
    }
    current = next;
  }
  return current;
}

function stringListFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => preview(item, 180)).filter(Boolean);
}

function actionList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return preview(item);
      }
      const title = item.action ?? item.title ?? item.name ?? item.recommendedAction ?? "action";
      const reason = item.reason ?? item.description ?? item.detail;
      const priority = item.priority ? `[${preview(item.priority, 24)}] ` : "";
      return reason
        ? `${priority}${preview(title, 80)} - ${preview(reason, 140)}`
        : `${priority}${preview(title, 160)}`;
    })
    .filter(Boolean);
}

function buildSuggestedCommands(args: {
  task?: string;
  changedFiles: string[];
  diffSummary?: string;
}): string[] {
  const commands = [
    "snipara-companion team-sync what-changed",
    "snipara-companion workflow resume --include-session-context",
  ];

  if (args.task) {
    commands.unshift(
      `snipara-companion team-sync start-work --summary ${JSON.stringify(args.task)}${
        args.changedFiles.length > 0 ? ` --files ${args.changedFiles.join(" ")}` : ""
      }`
    );
  }

  if (args.changedFiles.length > 0) {
    commands.push(
      `snipara-companion code impact --changed-files ${args.changedFiles.join(" ")} --diff-summary ${JSON.stringify(
        args.diffSummary ?? args.task ?? "project intelligence change"
      )}`
    );
  }

  commands.push("snipara-companion code symbol-card --qualified-name '<symbol>'");
  commands.push("snipara-companion final-commit --summary '<final summary>' --files <files...>");
  return commands;
}

/**
 * Build a Project Intelligence continuity brief for the current task.
 *
 * Gathers three best-effort signals through the hosted client — resume context
 * (`snipara_resume_context`), memory health, and local code impact — and merges
 * them with the changed/recent files and a list of suggested next commands.
 * Each source is wrapped independently: a failure is recorded in `brief.errors`
 * rather than thrown, so callers always receive a usable (possibly partial)
 * brief.
 *
 * @param options Task, branch, changed/recent files, token budget, and skip
 *   flags (`skipImpact`, `skipMemoryHealth`).
 * @returns A `project-intelligence-brief-v1` document.
 */
export async function buildProjectIntelligenceBrief(
  options: ProjectIntelligenceBriefOptions
): Promise<ProjectIntelligenceBrief> {
  const changedFiles = normalizeStringList(options.changedFiles);
  const recentFiles = normalizeStringList(options.recentFiles);
  const branch = options.branch ?? detectGitBranch();
  const client = createClient(30000);
  const errors: ProjectIntelligenceBrief["errors"] = [];

  const brief: ProjectIntelligenceBrief = {
    version: "project-intelligence-brief-v1",
    generatedAt: new Date().toISOString(),
    ...(branch ? { branch } : {}),
    ...(options.task ? { task: options.task } : {}),
    changedFiles,
    recentFiles,
    errors,
    suggestedCommands: buildSuggestedCommands({
      task: options.task,
      changedFiles,
      diffSummary: options.diffSummary,
    }),
  };

  try {
    brief.resumeContext = await client.callTool<Record<string, unknown>>("snipara_resume_context", {
      ...(branch ? { branch } : {}),
      ...(options.task ? { task: options.task } : {}),
      ...(recentFiles.length > 0 ? { recentFiles } : {}),
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      max_tokens: options.maxTokens ?? 4000,
    });
  } catch (error) {
    errors.push({
      surface: "resume_context",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!options.skipMemoryHealth) {
    try {
      brief.memoryHealth = await client.callTool<Record<string, unknown>>(
        "snipara_memory_health",
        {}
      );
    } catch (error) {
      errors.push({
        surface: "memory_health",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!options.skipImpact && changedFiles.length > 0) {
    try {
      const autoResult = await resolveCodeGraphAutoSourceResult("impact", {
        changedFiles,
        diffSummary: options.diffSummary ?? options.task,
        limit: 20,
      });
      brief.codeImpact = autoResult.result as Record<string, unknown>;
      brief.codeImpactSourceSelection = autoResult.sourceSelection;
    } catch (error) {
      errors.push({
        surface: "code_impact",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return brief;
}

function printResumeContext(result: Record<string, unknown> | undefined): void {
  if (!result) {
    console.log(chalk.yellow("Unavailable"));
    return;
  }

  const resumeContext = isRecord(result.resumeContext) ? result.resumeContext : result;
  const focus = nestedRecord(resumeContext, ["focus"]);
  const scope = nestedRecord(resumeContext, ["scope"]);

  if (scope.branch) {
    console.log(`Branch: ${preview(scope.branch)}`);
  }
  if (focus.summary) {
    console.log(`Summary: ${preview(focus.summary, 260)}`);
  }
  if (focus.activeDecisionCount !== undefined) {
    console.log(`Active decisions: ${preview(focus.activeDecisionCount)}`);
  }
  if (focus.overlapCount !== undefined) {
    console.log(`Overlaps: ${preview(focus.overlapCount)}`);
  }

  const actions = stringListFromUnknown(resumeContext.recommendedActions);
  if (actions.length > 0) {
    console.log("Recommended actions:");
    for (const action of actions.slice(0, 5)) {
      console.log(`- ${action}`);
    }
  }

  const caveats = stringListFromUnknown(resumeContext.caveats);
  if (caveats.length > 0) {
    console.log("Caveats:");
    for (const caveat of caveats.slice(0, 3)) {
      console.log(`- ${caveat}`);
    }
  }
}

function printMemoryHealth(result: Record<string, unknown> | undefined): void {
  if (!result) {
    console.log(chalk.yellow("Skipped or unavailable"));
    return;
  }

  const score =
    numberValue(result.health_score) ??
    numberValue(result.healthScore) ??
    numberValue(result.score) ??
    numberValue(nestedRecord(result, ["summary"]).health_score);
  if (score !== undefined) {
    console.log(`Memory Health: ${formatPercentScore(score)}`);
  }

  const metrics = isRecord(result.metrics)
    ? result.metrics
    : nestedRecord(result, ["summary", "metrics"]);
  const metricEntries = Object.entries(metrics).filter(([, value]) => value !== undefined);
  if (metricEntries.length > 0) {
    console.log(
      metricEntries
        .slice(0, 6)
        .map(([key, value]) => `${key}: ${preview(value, 40)}`)
        .join(" | ")
    );
  } else if (result.status || result.message) {
    console.log(preview(result.status ?? result.message, 220));
  }
}

function printCodeImpact(result: Record<string, unknown> | undefined): void {
  if (!result) {
    console.log(chalk.yellow("Skipped or unavailable"));
    return;
  }

  const risk = isRecord(result.risk) ? result.risk : {};
  if (risk.level || risk.score !== undefined) {
    console.log(`Risk: ${preview(risk.level ?? "unknown")} (${preview(risk.score ?? "n/a")})`);
  }

  const evidence = isRecord(result.evidence_summary) ? result.evidence_summary : {};
  if (evidence.matched_target_count !== undefined) {
    console.log(`Matched targets: ${preview(evidence.matched_target_count)}`);
  }

  const actions = actionList(result.recommended_actions);
  if (actions.length > 0) {
    console.log("Recommended actions:");
    for (const action of actions.slice(0, 5)) {
      console.log(`- ${action}`);
    }
  }

  const gaps = actionList(result.coverage_gaps);
  if (gaps.length > 0) {
    console.log("Coverage gaps:");
    for (const gap of gaps.slice(0, 3)) {
      console.log(`- ${gap}`);
    }
  }
}

export async function projectIntelligenceBriefCommand(
  options: ProjectIntelligenceBriefOptions
): Promise<void> {
  const brief = await buildProjectIntelligenceBrief(options);

  if (options.json) {
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  console.log(chalk.bold("Project Intelligence Brief"));
  if (brief.branch) {
    console.log(`Branch: ${brief.branch}`);
  }
  if (brief.task) {
    console.log(`Task: ${brief.task}`);
  }
  if (brief.changedFiles.length > 0) {
    console.log(`Changed files: ${brief.changedFiles.join(", ")}`);
  }
  console.log("");

  console.log(chalk.bold("Continuity"));
  printResumeContext(brief.resumeContext);
  console.log("");

  console.log(chalk.bold("Memory Authority And Health"));
  printMemoryHealth(brief.memoryHealth);
  console.log("");

  console.log(chalk.bold("Code Impact"));
  if (brief.codeImpactSourceSelection) {
    console.log(
      `Source: ${brief.codeImpactSourceSelection.selected} (${brief.codeImpactSourceSelection.reason})`
    );
  }
  printCodeImpact(brief.codeImpact);
  console.log("");

  if (brief.errors.length > 0) {
    console.log(chalk.bold("Degraded Surfaces"));
    for (const error of brief.errors) {
      console.log(`- ${error.surface}: ${error.message}`);
    }
    console.log("");
  }

  console.log(chalk.bold("Next Companion Commands"));
  for (const command of brief.suggestedCommands) {
    console.log(command);
  }
}
