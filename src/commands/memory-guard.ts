/**
 * `memory-guard` — recall guidance before risky actions.
 *
 * Before failed retries, commits, or finalization, this surfaces tagged memory
 * and source context and flags release surfaces (npm/pypi), destructive intent,
 * and contradictions. In strict mode it returns stable exit codes (see
 * MEMORY_GUARD_EXIT_CODES): 20 = confirmation required, 21 = guidance
 * unavailable, 22 = invalid options — so Git hooks can block or prompt.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import {
  createClient,
  type ContextQueryResult,
  type MemoryScope,
  type MemoryType,
  type RecallResult,
  type RecentAutomationEvent,
  type RecalledMemory,
} from "../api/client";
import { findWorkspaceRoot, isConfigured, loadConfig } from "../config/store";

export type MemoryGuardTrigger = "failure" | "pre-commit" | "commit" | "pre-final" | "manual";

export interface ReleaseSurface {
  ecosystem: "npm" | "pypi";
  name: string;
  version?: string;
  manifestPath: string;
}

export interface MemoryGuardFinding {
  code: "recent_failure" | "release_surface" | "manual" | "destructive_intent" | "contradiction";
  message: string;
}

export const MEMORY_GUARD_EXIT_CODES = {
  ok: 0,
  confirmationRequired: 20,
  guidanceUnavailable: 21,
  validationError: 22,
} as const;

export type MemoryGuardBlockReason = "confirmation_required" | "guidance_unavailable";

export interface MemoryGuardContradiction {
  source: "memory" | "context";
  reason: string;
  excerpt: string;
  memoryId?: string;
  category?: string;
  title?: string;
  file?: string;
}

export interface MemoryGuardCheckOptions {
  trigger?: MemoryGuardTrigger;
  files?: string[];
  staged?: boolean;
  command?: string;
  intent?: string;
  result?: string;
  exitCode?: number;
  status?: string;
  destructive?: boolean;
  requireConfirmation?: boolean;
  confirmedByUser?: string;
  strict?: boolean;
  json?: boolean;
  limit?: number;
  categories?: string[];
  includeContext?: boolean;
  recentFailures?: boolean;
}

export interface MemoryGuardConfirmation {
  required: boolean;
  confirmed: boolean;
  note?: string;
  overridesDestructive: boolean;
  overridesContradictions: boolean;
}

export interface MemoryGuardValidationIssue {
  field: string;
  message: string;
}

export interface MemoryGuardValidationResult {
  version: "snipara.memory_guard_validation.v1";
  valid: false;
  exitCode: typeof MEMORY_GUARD_EXIT_CODES.validationError;
  errors: MemoryGuardValidationIssue[];
}

export interface MemoryGuardCheckResult {
  triggered: boolean;
  shouldBlock: boolean;
  blockReason?: MemoryGuardBlockReason;
  exitCode: number;
  trigger: MemoryGuardTrigger;
  findings: MemoryGuardFinding[];
  files: string[];
  releaseSurfaces: ReleaseSurface[];
  recentFailures: Array<{
    createdAt: string;
    command?: string;
    classification?: string;
    exitCode?: number;
    status?: string;
  }>;
  query: string;
  categories: string[];
  intent?: string;
  destructive: boolean;
  contradictions: MemoryGuardContradiction[];
  requiresConfirmation: boolean;
  confirmation: MemoryGuardConfirmation;
  confirmationPrompt?: string;
  memoryAvailable: boolean;
  contextAvailable: boolean;
  memories: RecalledMemory[];
  contextSections: Array<{
    title: string;
    file: string;
    relevanceScore: number;
    preview: string;
  }>;
  warnings: string[];
}

export interface RememberGuardMemoryOptions {
  text: string;
  guardTag?: string;
  category?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  ttlDays?: number;
  json?: boolean;
}

const DEFAULT_GUARD_CATEGORIES_BY_TRIGGER: Record<MemoryGuardTrigger, string[]> = {
  failure: ["failure", "debug", "stuck", "retry", "workflow-policy", "guard:failure"],
  "pre-commit": [
    "pre-commit",
    "commit",
    "release",
    "workflow-policy",
    "guard:pre-commit",
    "guard:commit",
  ],
  commit: [
    "commit",
    "pre-commit",
    "release",
    "workflow-policy",
    "guard:commit",
    "guard:pre-commit",
  ],
  "pre-final": ["pre-final", "final", "commit", "release", "workflow-policy", "guard:pre-final"],
  manual: ["memory-guard", "failure", "pre-commit", "commit", "release", "workflow-policy"],
};

const MEMORY_GUARD_TRIGGERS: MemoryGuardTrigger[] = [
  "failure",
  "pre-commit",
  "commit",
  "pre-final",
  "manual",
];

const DESTRUCTIVE_TERMS = [
  "archive",
  "compact",
  "delete",
  "deploy",
  "destroy",
  "drop",
  "forget",
  "force",
  "invalidate",
  "merge",
  "publish",
  "remove",
  "reset",
  "supersede",
  "truncate",
];

const DESTRUCTIVE_INTENT_PATTERN =
  /\b(accept-data-loss|archive|compact|delete|deploy|destroy|drop|forget|force-reset|invalidate|merge\s+.+\bmain\b|npm\s+publish|pnpm\s+db:push|prisma\s+db\s+push|publish|remove|reset\s+--hard|supersede|truncate)\b/i;

const NEGATIVE_GUIDANCE_PATTERN =
  /\b(do not|don't|never|must not|not allowed|forbidden|dangerous|destructive|requires confirmation|ask the user|confirm before|ne pas|jamais|interdit|dangereux|demander confirmation|confirmer avant)\b/i;

export function normalizeGuardTag(tag: string): string {
  return tag.trim().replace(/^guard:/, "");
}

export function categoryFromGuardTag(tag: string): string {
  return normalizeGuardTag(tag);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function textValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function validateMemoryGuardCheckOptions(
  options: MemoryGuardCheckOptions
): MemoryGuardValidationIssue[] {
  const errors: MemoryGuardValidationIssue[] = [];
  const trigger = options.trigger || "manual";
  const intent = textValue(options.intent) || textValue(options.command);
  const confirmation = textValue(options.confirmedByUser);

  if (!MEMORY_GUARD_TRIGGERS.includes(trigger)) {
    errors.push({
      field: "trigger",
      message: `Invalid trigger "${trigger}". Expected one of: ${MEMORY_GUARD_TRIGGERS.join(", ")}.`,
    });
  }

  if (options.exitCode !== undefined && !Number.isInteger(options.exitCode)) {
    errors.push({
      field: "exitCode",
      message: "Exit code must be an integer.",
    });
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    errors.push({
      field: "limit",
      message: "Limit must be a positive integer.",
    });
  }

  if (options.destructive && !intent) {
    errors.push({
      field: "destructive",
      message:
        "--destructive requires --intent or --command so the guard can check the exact action.",
    });
  }

  if (confirmation && !intent) {
    errors.push({
      field: "confirmedByUser",
      message: "--confirmed-by-user requires --intent or --command to make the override auditable.",
    });
  }

  return errors;
}

function buildValidationResult(errors: MemoryGuardValidationIssue[]): MemoryGuardValidationResult {
  return {
    version: "snipara.memory_guard_validation.v1",
    valid: false,
    exitCode: MEMORY_GUARD_EXIT_CODES.validationError,
    errors,
  };
}

function safeRelative(root: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return path.relative(root, absolute).replaceAll(path.sep, "/");
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parsePyprojectProject(content: string): { name?: string; version?: string } {
  const projectMatch = content.match(/(?:^|\n)\[project\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (!projectMatch) {
    return {};
  }

  const section = projectMatch[1];
  const name = section.match(/(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/)?.[1];
  const version = section.match(/(?:^|\n)\s*version\s*=\s*["']([^"']+)["']/)?.[1];
  return { name, version };
}

function findManifestForFile(
  root: string,
  filePath: string,
  manifest: "package.json" | "pyproject.toml"
) {
  let current = path.dirname(path.join(root, filePath));
  const resolvedRoot = path.resolve(root);

  while (current.startsWith(resolvedRoot)) {
    const candidate = path.join(current, manifest);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    if (current === resolvedRoot) {
      break;
    }
    current = path.dirname(current);
  }

  return null;
}

export function detectReleaseSurfacesFromFiles(root: string, files: string[]): ReleaseSurface[] {
  const surfaces: ReleaseSurface[] = [];
  const seen = new Set<string>();

  for (const rawFile of files) {
    const file = safeRelative(root, rawFile);

    const packageManifest =
      file.endsWith("package.json") && fs.existsSync(path.join(root, file))
        ? path.join(root, file)
        : findManifestForFile(root, file, "package.json");
    if (packageManifest && !seen.has(packageManifest)) {
      seen.add(packageManifest);
      const packageJson = readJsonFile(packageManifest);
      const name = packageJson?.name;
      const version = packageJson?.version;
      if (
        typeof name === "string" &&
        name.trim() &&
        packageJson?.private !== true &&
        !name.startsWith("@types/")
      ) {
        surfaces.push({
          ecosystem: "npm",
          name,
          version: typeof version === "string" ? version : undefined,
          manifestPath: safeRelative(root, packageManifest),
        });
      }
    }

    const pyprojectManifest =
      file.endsWith("pyproject.toml") && fs.existsSync(path.join(root, file))
        ? path.join(root, file)
        : findManifestForFile(root, file, "pyproject.toml");
    if (pyprojectManifest && !seen.has(pyprojectManifest)) {
      seen.add(pyprojectManifest);
      const project = parsePyprojectProject(fs.readFileSync(pyprojectManifest, "utf8"));
      if (project.name) {
        surfaces.push({
          ecosystem: "pypi",
          name: project.name,
          version: project.version,
          manifestPath: safeRelative(root, pyprojectManifest),
        });
      }
    }
  }

  return surfaces;
}

export function getStagedFiles(root: string): string[] {
  try {
    const output = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function classifyRecentFailures(events: RecentAutomationEvent[]) {
  return events
    .filter((item) => {
      const payload = item.event.payload || {};
      if (item.event.type === "error_observed") {
        return true;
      }
      if (item.event.type !== "tool_result") {
        return false;
      }
      const classification = String(payload.result_classification || "");
      const exitCode = payload.exit_code;
      return (
        ["failure", "timeout"].includes(classification) ||
        (typeof exitCode === "number" && exitCode !== 0)
      );
    })
    .map((item) => {
      const payload = item.event.payload || {};
      return {
        createdAt: item.createdAt,
        command: typeof payload.command === "string" ? payload.command : undefined,
        classification:
          typeof payload.result_classification === "string"
            ? payload.result_classification
            : undefined,
        exitCode: typeof payload.exit_code === "number" ? payload.exit_code : undefined,
        status: typeof payload.status === "string" ? payload.status : undefined,
      };
    });
}

function buildGuardQuery(args: {
  trigger: MemoryGuardTrigger;
  findings: MemoryGuardFinding[];
  files: string[];
  releaseSurfaces: ReleaseSurface[];
  command?: string;
  intent?: string;
  result?: string;
}): string {
  const surfaceNames = args.releaseSurfaces
    .map((surface) => `${surface.ecosystem}:${surface.name}@${surface.version || "unknown"}`)
    .join(", ");
  const findingText = args.findings
    .map((finding) => `${finding.code}: ${finding.message}`)
    .join("; ");
  const files = args.files.slice(0, 12).join(", ");
  const result = args.result ? args.result.slice(0, 300) : "";

  return [
    `memory guard ${args.trigger}`,
    findingText,
    surfaceNames ? `release surfaces ${surfaceNames}` : "",
    files ? `files ${files}` : "",
    args.intent ? `intent ${args.intent}` : "",
    args.command ? `command ${args.command}` : "",
    result ? `result ${result}` : "",
    "what does project memory or source context say before continuing committing or finalizing",
  ]
    .filter(Boolean)
    .join(" | ");
}

function detectDestructiveIntent(text: string | undefined): boolean {
  return Boolean(text && DESTRUCTIVE_INTENT_PATTERN.test(text));
}

function intentTerms(text: string): Set<string> {
  const lower = text.toLowerCase();
  return new Set(DESTRUCTIVE_TERMS.filter((term) => lower.includes(term)));
}

function hasOverlappingDestructiveTerm(intent: string, guidance: string): boolean {
  const terms = intentTerms(intent);
  if (terms.size === 0) {
    return false;
  }
  const lowerGuidance = guidance.toLowerCase();
  return [...terms].some((term) => lowerGuidance.includes(term));
}

function contradictionFromMemory(
  intent: string,
  memory: RecalledMemory
): MemoryGuardContradiction | null {
  if (
    !NEGATIVE_GUIDANCE_PATTERN.test(memory.content) ||
    !hasOverlappingDestructiveTerm(intent, memory.content)
  ) {
    return null;
  }

  return {
    source: "memory",
    reason: "Project memory contains negative guidance for a matching destructive action.",
    excerpt: memory.content.slice(0, 320),
    memoryId: memory.memory_id,
    category: memory.category,
  };
}

function contradictionFromContext(
  intent: string,
  section: MemoryGuardCheckResult["contextSections"][number]
): MemoryGuardContradiction | null {
  const text = `${section.title} ${section.preview}`;
  if (!NEGATIVE_GUIDANCE_PATTERN.test(text) || !hasOverlappingDestructiveTerm(intent, text)) {
    return null;
  }

  return {
    source: "context",
    reason: "Source context contains negative guidance for a matching destructive action.",
    excerpt: section.preview || section.title,
    title: section.title,
    file: section.file,
  };
}

function collectContradictions(
  intent: string | undefined,
  memories: RecalledMemory[],
  sections: MemoryGuardCheckResult["contextSections"]
): MemoryGuardContradiction[] {
  if (!intent) {
    return [];
  }

  return [
    ...memories.flatMap((memory) => {
      const contradiction = contradictionFromMemory(intent, memory);
      return contradiction ? [contradiction] : [];
    }),
    ...sections.flatMap((section) => {
      const contradiction = contradictionFromContext(intent, section);
      return contradiction ? [contradiction] : [];
    }),
  ].slice(0, 8);
}

function mergeRecallMemories(results: RecallResult[]): RecalledMemory[] {
  const seen = new Set<string>();
  const memories: RecalledMemory[] = [];
  for (const result of results) {
    for (const memory of result.memories || []) {
      if (seen.has(memory.memory_id)) {
        continue;
      }
      seen.add(memory.memory_id);
      memories.push(memory);
    }
  }
  return memories.sort((a, b) => b.relevance - a.relevance);
}

function contextSections(result: ContextQueryResult | null) {
  return (result?.sections || []).slice(0, 5).map((section) => ({
    title: section.title,
    file: section.file,
    relevanceScore: section.relevance_score,
    preview: section.content.trim().replace(/\s+/g, " ").slice(0, 220),
  }));
}

function printMemoryGuardResult(result: MemoryGuardCheckResult): void {
  console.log(chalk.bold("Snipara Memory Guard"));
  console.log(`Trigger: ${result.trigger}`);
  console.log(
    `Status: ${result.triggered ? (result.shouldBlock ? "blocked" : "checked") : "not triggered"}`
  );
  if (result.intent) {
    console.log(`Intent: ${result.intent}`);
  }
  if (result.destructive) {
    console.log("Risk: destructive or irreversible action");
  }
  if (result.blockReason) {
    console.log(`Block reason: ${result.blockReason}`);
  }

  if (result.findings.length > 0) {
    console.log("");
    console.log(chalk.bold("Why this ran"));
    for (const finding of result.findings) {
      console.log(`- ${finding.message}`);
    }
  }

  if (result.releaseSurfaces.length > 0) {
    console.log("");
    console.log(chalk.bold("Release Surfaces"));
    for (const surface of result.releaseSurfaces) {
      console.log(
        `- ${surface.ecosystem}: ${surface.name}@${surface.version || "unknown"} (${surface.manifestPath})`
      );
    }
  }

  if (result.recentFailures.length > 0) {
    console.log("");
    console.log(chalk.bold("Recent Failures"));
    for (const failure of result.recentFailures.slice(0, 5)) {
      console.log(
        `- ${failure.command || failure.status || failure.classification || "tool failure"}`
      );
    }
  }

  if (result.memories.length > 0) {
    console.log("");
    console.log(chalk.bold("Memory Says"));
    for (const memory of result.memories.slice(0, 6)) {
      const meta = [memory.type, memory.scope, memory.category].filter(Boolean).join(" · ");
      console.log(`- ${memory.content.slice(0, 260)}${memory.content.length > 260 ? "..." : ""}`);
      if (meta) {
        console.log(`  ${meta}`);
      }
    }
  }

  if (result.contextSections.length > 0) {
    console.log("");
    console.log(chalk.bold("Context Says"));
    for (const section of result.contextSections) {
      console.log(`- ${section.title} (${section.file})`);
      if (section.preview) {
        console.log(`  ${section.preview}`);
      }
    }
  }

  if (result.contradictions.length > 0) {
    console.log("");
    console.log(chalk.bold("Contradicting Signals"));
    for (const contradiction of result.contradictions) {
      const label =
        contradiction.source === "memory"
          ? `memory ${contradiction.memoryId || "unknown"}`
          : `${contradiction.title || "context"}${contradiction.file ? ` (${contradiction.file})` : ""}`;
      console.log(`- ${label}: ${contradiction.reason}`);
      if (contradiction.excerpt) {
        console.log(
          `  ${contradiction.excerpt.slice(0, 260)}${contradiction.excerpt.length > 260 ? "..." : ""}`
        );
      }
    }
  }

  if (result.confirmation.confirmed) {
    console.log("");
    console.log(chalk.bold("Confirmation Override"));
    console.log(result.confirmation.note || "Explicit user confirmation was supplied.");
  } else if (result.requiresConfirmation) {
    console.log("");
    console.log(chalk.bold("Confirmation Required"));
    console.log(
      result.confirmationPrompt || "Ask the user for explicit confirmation before continuing."
    );
  }

  if (result.warnings.length > 0) {
    console.log("");
    console.log(chalk.bold("Warnings"));
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

/**
 * Recall and evaluate guard guidance before a risky action.
 *
 * Given a trigger (failure | pre-commit | commit | pre-final | manual) and
 * optional touched files (or `--staged`), it detects release surfaces and
 * destructive/contradictory intent, recalls tagged memory and source context,
 * and returns findings plus whether the caller must stop or confirm. Honors an
 * explicit `confirmedByUser` override so a reviewed destructive action can
 * proceed. Backs the strict-mode exit codes used by Git hooks.
 *
 * @returns Findings, warnings, and a decision the caller can act on.
 */
export async function runMemoryGuardCheck(
  options: MemoryGuardCheckOptions = {}
): Promise<MemoryGuardCheckResult> {
  const cwd = process.env.SNIPARA_WORKSPACE_DIR || process.cwd();
  const root = findWorkspaceRoot(cwd, true) || cwd;
  const trigger = options.trigger || "manual";
  const files = unique([
    ...(options.files || []),
    ...(options.staged ? getStagedFiles(root) : []),
  ]).map((file) => safeRelative(root, file));
  const releaseSurfaces = detectReleaseSurfacesFromFiles(root, files);
  const findings: MemoryGuardFinding[] = [];
  const warnings: string[] = [];
  const intent = textValue(options.intent) || textValue(options.command);
  const confirmedByUser = textValue(options.confirmedByUser);
  const destructive = Boolean(
    options.destructive ||
    detectDestructiveIntent(options.intent) ||
    detectDestructiveIntent(options.command)
  );

  const resultLooksFailed = Boolean(
    options.result && /error|failed|failure|timeout|exception|\bE\d{3}\b/i.test(options.result)
  );
  if (
    trigger === "failure" ||
    options.exitCode !== undefined ||
    options.status ||
    resultLooksFailed
  ) {
    const failed =
      trigger === "failure" ||
      (typeof options.exitCode === "number" && options.exitCode !== 0) ||
      (options.status && /error|failed|failure|timeout/i.test(options.status)) ||
      resultLooksFailed;
    if (failed) {
      findings.push({
        code: "recent_failure",
        message: "A command or tool result failed before this step.",
      });
    }
  }

  if (releaseSurfaces.length > 0) {
    findings.push({
      code: "release_surface",
      message: "Changed files belong to publishable npm/PyPI package surfaces.",
    });
  }

  if (destructive) {
    findings.push({
      code: "destructive_intent",
      message: "The proposed action is destructive, irreversible, or publish/deploy-like.",
    });
  }

  const client = isConfigured() ? createClient(15000) : null;
  let recentFailures: MemoryGuardCheckResult["recentFailures"] = [];
  if (
    client &&
    options.recentFailures !== false &&
    ["pre-commit", "commit", "pre-final"].includes(trigger)
  ) {
    try {
      const config = loadConfig();
      const events = await client.getAutomationEvents({
        sessionId: config.sessionId,
        limit: 25,
      });
      recentFailures = classifyRecentFailures(events.events);
      if (recentFailures.length > 0) {
        findings.push({
          code: "recent_failure",
          message: "Recent Companion automation events contain failed or timed-out tool results.",
        });
      }
    } catch (error) {
      warnings.push(
        `Could not inspect recent tool failures: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (trigger === "manual" && findings.length === 0) {
    findings.push({
      code: "manual",
      message: options.intent
        ? "Manual memory/context guard check requested for a proposed intent."
        : "Manual memory guard check requested.",
    });
  }

  const triggered = findings.length > 0;
  const categories = unique([
    ...(options.categories || []),
    ...DEFAULT_GUARD_CATEGORIES_BY_TRIGGER[trigger],
  ]);
  const query = buildGuardQuery({
    trigger,
    findings,
    files,
    releaseSurfaces,
    command: options.command,
    intent: options.intent,
    result: options.result,
  });

  const recallResults: RecallResult[] = [];
  let memoryAvailable = false;
  let contextResult: ContextQueryResult | null = null;
  let contextAvailable = false;

  if (triggered && client) {
    try {
      recallResults.push(
        await client.recallMemories(query, {
          scope: "project",
          limit: options.limit ?? 8,
          minRelevance: 0.2,
          includeInactive: true,
        })
      );
      memoryAvailable = true;
    } catch (error) {
      warnings.push(
        `Project memory recall failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    for (const category of categories) {
      try {
        recallResults.push(
          await client.recallMemories(query, {
            scope: "project",
            category,
            limit: Math.min(options.limit ?? 6, 6),
            minRelevance: 0,
            includeInactive: true,
          })
        );
        memoryAvailable = true;
      } catch {
        // Category-specific guard memories are optional; the broad recall above is the hard gate.
      }
    }

    if (options.includeContext !== false) {
      try {
        contextResult = await client.queryContext(query, 1600);
        contextAvailable = (contextResult.sections || []).length > 0;
      } catch (error) {
        warnings.push(
          `Context query failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else if (triggered && !client) {
    warnings.push("Snipara Companion is not configured; memory/context guard could not run.");
  }

  const memories = mergeRecallMemories(recallResults);
  const sections = contextSections(contextResult);
  const contradictions = collectContradictions(intent, memories, sections);
  if (contradictions.length > 0) {
    findings.push({
      code: "contradiction",
      message: "Memory or source context appears to contradict the proposed action.",
    });
  }

  const hasGuidance = memories.length > 0 || sections.length > 0;
  const requiresConfirmation = Boolean(
    options.requireConfirmation || destructive || contradictions.length > 0
  );
  const confirmation: MemoryGuardConfirmation = {
    required: requiresConfirmation,
    confirmed: Boolean(confirmedByUser),
    ...(confirmedByUser ? { note: confirmedByUser } : {}),
    overridesDestructive: Boolean(confirmedByUser && destructive),
    overridesContradictions: Boolean(confirmedByUser && contradictions.length > 0),
  };
  const missingConfirmation = requiresConfirmation && !confirmation.confirmed;
  const guidanceUnavailable = triggered && !hasGuidance;
  const blockReason: MemoryGuardBlockReason | undefined = options.strict
    ? missingConfirmation
      ? "confirmation_required"
      : guidanceUnavailable
        ? "guidance_unavailable"
        : undefined
    : undefined;
  const shouldBlock = Boolean(blockReason);
  const exitCode =
    blockReason === "confirmation_required"
      ? MEMORY_GUARD_EXIT_CODES.confirmationRequired
      : blockReason === "guidance_unavailable"
        ? MEMORY_GUARD_EXIT_CODES.guidanceUnavailable
        : MEMORY_GUARD_EXIT_CODES.ok;
  const confirmationPrompt = requiresConfirmation
    ? [
        "Ask the user to explicitly confirm before continuing.",
        contradictions.length > 0
          ? "Show the contradicting memory/context signals and ask whether to override them."
          : "Explain the destructive or irreversible effect before asking for confirmation.",
      ].join(" ")
    : undefined;

  if (shouldBlock) {
    warnings.push(
      blockReason === "confirmation_required"
        ? "Strict mode blocked this step until the user explicitly confirms the destructive or contradictory action."
        : "Strict mode blocked this step because Memory Guard was triggered but no memory or context guidance was available."
    );
  } else if (confirmation.confirmed && requiresConfirmation) {
    warnings.push(
      "Explicit user confirmation override supplied; destructive or contradictory signals remain in the JSON for audit."
    );
  }

  return {
    triggered,
    shouldBlock,
    ...(blockReason ? { blockReason } : {}),
    exitCode,
    trigger,
    findings,
    files,
    releaseSurfaces,
    recentFailures,
    query,
    categories,
    ...(intent ? { intent } : {}),
    destructive,
    contradictions,
    requiresConfirmation,
    confirmation,
    ...(confirmationPrompt ? { confirmationPrompt } : {}),
    memoryAvailable,
    contextAvailable,
    memories,
    contextSections: sections,
    warnings,
  };
}

export async function memoryGuardCheckCommand(options: MemoryGuardCheckOptions): Promise<void> {
  const validationErrors = validateMemoryGuardCheckOptions(options);
  if (validationErrors.length > 0) {
    const validation = buildValidationResult(validationErrors);
    if (options.json) {
      console.log(JSON.stringify(validation, null, 2));
    } else {
      console.log(chalk.bold("Snipara Memory Guard"));
      console.log("Validation failed:");
      for (const error of validation.errors) {
        console.log(`- ${error.field}: ${error.message}`);
      }
    }
    process.exit(MEMORY_GUARD_EXIT_CODES.validationError);
  }

  const result = await runMemoryGuardCheck(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.triggered || options.trigger === "manual") {
    printMemoryGuardResult(result);
  }

  if (result.shouldBlock) {
    process.exit(result.exitCode);
  }
}

export async function rememberGuardMemoryCommand(
  options: RememberGuardMemoryOptions
): Promise<void> {
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }

  const category =
    options.category || (options.guardTag ? categoryFromGuardTag(options.guardTag) : undefined);
  const client = createClient(15000);
  const result = await client.rememberMemory({
    text: options.text,
    type: options.type || "learning",
    scope: options.scope || "project",
    category,
    ttlDays: options.ttlDays,
    source: "snipara-companion memory-guard remember",
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("Snipara Memory Guard"));
  console.log(`Stored guard memory${category ? ` in category ${category}` : ""}.`);
  console.log(JSON.stringify(result, null, 2));
}
