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
import {
  buildProjectJudgmentCard,
  formatProjectJudgmentCard,
  type ProjectIntelligenceJudgmentCard,
} from "./judgment-card";
import { buildSessionSnapshot, readSessionSnapshot, type SessionSnapshot } from "./activity";
import { buildVerificationPlan, type VerificationPlan } from "./verify";
import {
  evaluateProjectPolicyDecision,
  type ProjectPolicyDecision,
  type ProjectPolicyRule,
  type ProjectPolicyRuleScope,
} from "../contracts/project-intelligence";

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
  servedJudgmentId?: string;
  branch?: string;
  task?: string;
  changedFiles: string[];
  recentFiles: string[];
  resumeContext?: Record<string, unknown>;
  memoryHealth?: Record<string, unknown>;
  codeImpact?: Record<string, unknown>;
  codeImpactSourceSelection?: CodeGraphSourceSelection;
  localSessionSnapshot?: SessionSnapshot;
  projectPolicyDecision?: ProjectPolicyDecision;
  verificationPlan?: VerificationPlan;
  judgmentCard?: ProjectIntelligenceJudgmentCard;
  errors: Array<{ surface: string; message: string }>;
  suggestedCommands: string[];
}

export function servedJudgmentIdFromContext(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) {
      const found = servedJudgmentIdFromContext(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const direct = value.servedJudgmentId ?? value.served_judgment_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  for (const key of [
    "projectIntelligence",
    "project_intelligence",
    "brief",
    "judgment",
    "resumeContext",
    "resume_context",
    "data",
  ]) {
    const found = servedJudgmentIdFromContext(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
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

function extractProjectPolicyRulesFromResumeContext(
  resumeContext: Record<string, unknown> | undefined
): ProjectPolicyRule[] {
  if (!resumeContext) {
    return [];
  }
  return collectRecords(resumeContext)
    .map(recordToProjectPolicyRule)
    .filter((rule): rule is ProjectPolicyRule => Boolean(rule));
}

function collectRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecords(item, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    value,
    ...Object.values(value).flatMap((item) =>
      typeof item === "object" && item !== null ? collectRecords(item, depth + 1) : []
    ),
  ];
}

function recordToProjectPolicyRule(record: Record<string, unknown>): ProjectPolicyRule | undefined {
  const type = preview(record.type ?? record.memory_type ?? record.category, 80).toLowerCase();
  const content = preview(record.content ?? record.text ?? record.summary ?? record.decision, 4000);
  if (!content || !/(decision|policy|workflow-policy|roadmap)/i.test(type)) {
    return undefined;
  }
  const status = preview(record.status ?? record.lifecycleStatus ?? "active", 40).toLowerCase();
  const reviewStatus = preview(record.reviewStatus ?? record.review_status ?? "approved", 40)
    .toLowerCase()
    .replace("canonical", "approved");
  if (status && status !== "active") {
    return undefined;
  }
  if (reviewStatus && reviewStatus !== "approved") {
    return undefined;
  }
  const anchors = extractPolicyAnchors(content);
  if (anchors.length === 0) {
    return undefined;
  }
  const id = preview(record.memory_id ?? record.id ?? record.source_id ?? anchors[0], 80);
  const confidence = numberValue(record.confidence) ?? numberValue(record.score) ?? 0.8;
  return {
    id,
    title: preview(record.title ?? content, 120),
    scope: inferProjectPolicyScope(content, anchors),
    strength: inferProjectPolicyStrength(content),
    confidence,
    source: {
      kind: "decision_memory",
      ref: id.startsWith("memory:") ? id : `memory:${id}`,
      reviewStatus: "approved",
    },
    anchors,
    requirement: content.slice(0, 240),
    forbiddenActions: extractForbiddenActions(content),
  };
}

function extractPolicyAnchors(text: string): string[] {
  const normalized = text.toLowerCase();
  return [
    ...Array.from(normalized.matchAll(/`([^`]{3,120})`/g), (match) => match[1]),
    ...Array.from(
      normalized.matchAll(/\b(?:apps|packages|deploy|docs|scripts|oss)\/[a-z0-9_[\]./-]+/g),
      (match) => match[0]
    ),
    ...["auth", "billing", "schema", "migration", "deploy", "package", "memory", "routing"].filter(
      (term) => normalized.includes(term)
    ),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function inferProjectPolicyScope(text: string, anchors: string[]): ProjectPolicyRuleScope {
  const haystack = `${text}\n${anchors.join("\n")}`.toLowerCase();
  if (/\b(auth|oauth|session|permission|token|secret)\b/.test(haystack)) return "auth";
  if (/\b(billing|stripe|subscription|checkout|entitlement|quota)\b/.test(haystack)) {
    return "billing";
  }
  if (/\b(schema|migration|prisma|database)\b/.test(haystack)) return "schema";
  if (/\b(deploy|production|pre-deploy|zero-downtime)\b/.test(haystack)) return "deploy";
  if (/\b(package|npm|pypi|npx|publish|pack smoke)\b/.test(haystack)) return "package_surface";
  if (/\b(memory|reviewed memory|decision memory)\b/.test(haystack)) return "memory";
  if (/\b(routing|orchestrator|worker)\b/.test(haystack)) return "routing";
  return "custom";
}

function inferProjectPolicyStrength(text: string): ProjectPolicyRule["strength"] {
  const normalized = text.toLowerCase();
  if (/\b(never|must not|do not|forbid|forbidden|disallow|block)\b/.test(normalized)) {
    return "blocking";
  }
  if (/\b(require review|requires review|approval|required|must)\b/.test(normalized)) {
    return "review_required";
  }
  return "advisory";
}

function extractForbiddenActions(text: string): string[] {
  const normalized = text.toLowerCase();
  return ["bypass", "skip", "remove", "delete", "disable", "drop", "force"].filter((term) =>
    normalized.includes(term)
  );
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
    brief.localSessionSnapshot = readSessionSnapshot() ?? buildSessionSnapshot({ limit: 8 });
  } catch (error) {
    errors.push({
      surface: "local_session_snapshot",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    brief.resumeContext = await client.callTool<Record<string, unknown>>("snipara_resume_context", {
      ...(branch ? { branch } : {}),
      ...(options.task ? { task: options.task } : {}),
      ...(recentFiles.length > 0 ? { recentFiles } : {}),
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      max_tokens: options.maxTokens ?? 4000,
    });
    const servedJudgmentId = servedJudgmentIdFromContext(brief.resumeContext);
    if (servedJudgmentId) brief.servedJudgmentId = servedJudgmentId;
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

  const projectPolicyRules = extractProjectPolicyRulesFromResumeContext(brief.resumeContext);
  if (projectPolicyRules.length > 0) {
    brief.projectPolicyDecision = evaluateProjectPolicyDecision({
      action: {
        summary: options.diffSummary ?? options.task ?? "Project Intelligence brief",
        changedFiles,
      },
      rules: projectPolicyRules,
    });
  }

  brief.verificationPlan = buildVerificationPlan({
    task: options.task,
    changedFiles,
    diffSummary: options.diffSummary,
    codeImpact: brief.codeImpact,
    codeImpactSourceSelection: brief.codeImpactSourceSelection,
    errors: brief.errors.filter((error) => error.surface === "code_impact"),
  });
  brief.judgmentCard = buildProjectJudgmentCard({
    task: options.task,
    branch,
    changedFiles,
    resumeContext: brief.resumeContext,
    memoryHealth: brief.memoryHealth,
    codeImpact: brief.codeImpact,
    verificationPlan: brief.verificationPlan as unknown as Record<string, unknown>,
    errors: brief.errors,
  });

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

function printLocalSessionSnapshot(snapshot: SessionSnapshot | undefined): void {
  if (!snapshot) {
    console.log(chalk.yellow("Unavailable"));
    return;
  }
  if (snapshot.summary.latestActivityAt) {
    console.log(`Latest activity: ${snapshot.summary.latestActivityAt}`);
  }
  if (snapshot.summary.latestActivityTitle) {
    console.log(`Latest title: ${preview(snapshot.summary.latestActivityTitle, 220)}`);
  }
  console.log(`Risk: ${snapshot.summary.risk}`);
  if (snapshot.summary.riskReasons.length > 0) {
    console.log(`Risk reasons: ${snapshot.summary.riskReasons.slice(0, 3).join("; ")}`);
  }
  if (snapshot.summary.touchedFiles.length > 0) {
    console.log(`Touched files: ${snapshot.summary.touchedFiles.slice(0, 8).join(", ")}`);
  }
  console.log(
    `Intent: ${snapshot.intentDetection.intent} (${snapshot.intentDetection.confidence})`
  );
  console.log(
    `Suggested mode: ${snapshot.intentDetection.advisoryRouting.suggestedWorkflowMode} (advisory)`
  );
  if (snapshot.intentDetection.signals.length > 0) {
    console.log(`Intent signals: ${snapshot.intentDetection.signals.slice(0, 5).join(", ")}`);
  }
  console.log(`Hard routing allowed: ${snapshot.intentDetection.hardRoutingAllowed}`);
  console.log(`Next action: ${snapshot.summary.recommendedNextAction}`);
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

  if (brief.judgmentCard) {
    console.log(chalk.bold("Project Judgment"));
    for (const line of formatProjectJudgmentCard(brief.judgmentCard)) {
      console.log(line);
    }
    console.log("");
  }

  console.log(chalk.bold("Continuity"));
  printResumeContext(brief.resumeContext);
  console.log("");

  console.log(chalk.bold("Local Session"));
  printLocalSessionSnapshot(brief.localSessionSnapshot);
  console.log("");

  console.log(chalk.bold("Memory Authority And Health"));
  printMemoryHealth(brief.memoryHealth);
  console.log("");

  if (brief.projectPolicyDecision) {
    console.log(chalk.bold("Project Policy"));
    console.log(
      `Verdict: ${brief.projectPolicyDecision.verdict} (${Math.round(
        brief.projectPolicyDecision.confidence * 100
      )}%)`
    );
    if (brief.projectPolicyDecision.requiredActions.length > 0) {
      console.log(`Required: ${brief.projectPolicyDecision.requiredActions[0]}`);
    }
    console.log(`Receipt: ${brief.projectPolicyDecision.receipt.receiptId}`);
    console.log("");
  }

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
