/**
 * `verify` command — build a transparent verification plan.
 *
 * Derives a checklist of verification steps (test, lint, type-check, build,
 * inspection) for the current change by combining code-impact signals with the
 * project's package scripts, and flags coverage gaps. `buildVerificationPlan`
 * is the pure core; the command adds I/O and formatting. It plans checks — it
 * does not run them.
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { resolveCodeGraphAutoSourceResult, type CodeGraphSourceSelection } from "./code";
import {
  buildProjectJudgmentCard,
  formatProjectJudgmentCard,
  type ProjectIntelligenceJudgmentCard,
} from "./judgment-card";

export interface VerifyCommandOptions {
  task?: string;
  qualifiedName?: string;
  symbolKey?: string;
  filePath?: string;
  changedFiles?: string[];
  diffSummary?: string;
  limit?: number;
  skipImpact?: boolean;
  json?: boolean;
}

export interface VerificationCheck {
  kind: "test" | "lint" | "type-check" | "build" | "inspection" | "command";
  title: string;
  command?: string;
  file?: string;
  source: "code-impact" | "package-script" | "fallback";
  reason?: string;
}

export interface VerificationGap {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface VerificationRisk {
  level: string;
  score?: number;
  source: "code-impact" | "fallback";
}

export interface VerificationPlan {
  version: "snipara.verification_plan.v1";
  generatedAt: string;
  task?: string;
  target: {
    qualifiedName?: string;
    symbolKey?: string;
    filePath?: string;
    changedFiles: string[];
  };
  impactedFiles: string[];
  recommendedChecks: VerificationCheck[];
  risk: VerificationRisk;
  missingChecks: VerificationGap[];
  caveats: string[];
  suggestedCommands: string[];
  codeImpact?: Record<string, unknown>;
  codeImpactSourceSelection?: CodeGraphSourceSelection;
  judgmentCard?: ProjectIntelligenceJudgmentCard;
  errors: Array<{ surface: string; message: string }>;
}

interface BuildVerificationPlanOptions extends VerifyCommandOptions {
  cwd?: string;
  codeImpact?: Record<string, unknown>;
  codeImpactSourceSelection?: CodeGraphSourceSelection;
  errors?: Array<{ surface: string; message: string }>;
}

interface PackageInfo {
  root: string;
  name?: string;
  scripts: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (!isRecord(item)) {
        return [];
      }
      return [
        item.file,
        item.file_path,
        item.path,
        item.test,
        item.test_path,
        item.command,
      ].flatMap((candidate) => (typeof candidate === "string" ? [candidate] : []));
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function preview(value: unknown, maxLength = 160): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function actionTitle(action: Record<string, unknown>): string {
  return preview(
    action.action ?? action.title ?? action.name ?? action.recommendedAction ?? "check"
  );
}

function actionReason(action: Record<string, unknown>): string | undefined {
  return stringValue(action.reason ?? action.description ?? action.detail ?? action.message);
}

function checkKindFromText(text: string): VerificationCheck["kind"] {
  const normalized = text.toLowerCase();
  if (normalized.includes("type")) {
    return "type-check";
  }
  if (normalized.includes("lint")) {
    return "lint";
  }
  if (normalized.includes("build")) {
    return "build";
  }
  if (normalized.includes("test") || normalized.includes("spec") || normalized.includes("vitest")) {
    return "test";
  }
  if (normalized.includes("inspect") || normalized.includes("review")) {
    return "inspection";
  }
  return "command";
}

function collectActionChecks(impact: Record<string, unknown> | undefined): VerificationCheck[] {
  if (!impact || !Array.isArray(impact.recommended_actions)) {
    return [];
  }

  return impact.recommended_actions.flatMap((item): VerificationCheck[] => {
    if (typeof item === "string") {
      const kind = checkKindFromText(item);
      return kind === "command" || kind === "inspection"
        ? []
        : [{ kind, title: item, source: "code-impact" }];
    }
    if (!isRecord(item)) {
      return [];
    }

    const title = actionTitle(item);
    const kind = checkKindFromText(title);
    if (kind === "command" || kind === "inspection") {
      return [];
    }
    return [
      {
        kind,
        title,
        source: "code-impact",
        reason: actionReason(item),
      },
    ];
  });
}

function collectDirectTestChecks(impact: Record<string, unknown> | undefined): VerificationCheck[] {
  if (!impact) {
    return [];
  }

  const candidates = [
    impact.recommended_tests,
    impact.recommendedTests,
    impact.related_tests,
    impact.relatedTests,
    impact.tests,
    isRecord(impact.impact) ? impact.impact.tests : undefined,
  ];

  return candidates.flatMap((candidate): VerificationCheck[] => {
    if (!Array.isArray(candidate)) {
      return [];
    }

    return candidate.flatMap((item): VerificationCheck[] => {
      if (typeof item === "string") {
        return [
          {
            kind: "test",
            title: item,
            command: item.includes(" ") ? item : undefined,
            file: item.includes(" ") ? undefined : item,
            source: "code-impact",
          },
        ];
      }
      if (!isRecord(item)) {
        return [];
      }

      const command = stringValue(item.command);
      const file = stringValue(item.file ?? item.file_path ?? item.path ?? item.test_path);
      const title = stringValue(item.title ?? item.name ?? item.test ?? item.id) ?? command ?? file;
      if (!title) {
        return [];
      }

      return [
        {
          kind: "test",
          title,
          ...(command ? { command } : {}),
          ...(file ? { file } : {}),
          source: "code-impact",
          reason: actionReason(item),
        },
      ];
    });
  });
}

function findPackageJson(startPath: string, cwd: string): string | null {
  const absoluteStart = path.resolve(cwd, startPath);
  let current =
    fs.existsSync(absoluteStart) && fs.statSync(absoluteStart).isDirectory()
      ? absoluteStart
      : path.dirname(absoluteStart);
  const stop = path.parse(path.resolve(cwd)).root;

  while (current !== stop) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const rootPackage = path.join(cwd, "package.json");
  return fs.existsSync(rootPackage) ? rootPackage : null;
}

function readPackageInfo(packageJsonPath: string): PackageInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    const scripts = isRecord(parsed.scripts)
      ? Object.fromEntries(
          Object.entries(parsed.scripts).filter((entry): entry is [string, string] => {
            return typeof entry[1] === "string";
          })
        )
      : {};
    return {
      root: path.dirname(packageJsonPath),
      name: stringValue(parsed.name),
      scripts,
    };
  } catch {
    return null;
  }
}

function commandForPackageScript(info: PackageInfo, scriptName: string, cwd: string): string {
  if (info.name && path.resolve(info.root) !== path.resolve(cwd)) {
    return `pnpm --filter ${info.name} ${scriptName}`;
  }
  return `pnpm ${scriptName}`;
}

function inferPackageScriptChecks(changedFiles: string[], cwd: string): VerificationCheck[] {
  const packageFiles = unique(
    changedFiles
      .map((file) => findPackageJson(file, cwd))
      .filter((file): file is string => typeof file === "string")
  );
  const packages = packageFiles
    .map(readPackageInfo)
    .filter((info): info is PackageInfo => Boolean(info));
  const scriptKinds: Array<[string, VerificationCheck["kind"]]> = [
    ["test", "test"],
    ["type-check", "type-check"],
    ["lint", "lint"],
    ["build", "build"],
  ];

  return packages.flatMap((info) =>
    scriptKinds.flatMap(([scriptName, kind]) => {
      if (!info.scripts[scriptName]) {
        return [];
      }
      return [
        {
          kind,
          title: `${scriptName} script${info.name ? ` for ${info.name}` : ""}`,
          command: commandForPackageScript(info, scriptName, cwd),
          source: "package-script" as const,
          reason: "Detected from nearest package.json scripts for the changed files.",
        },
      ];
    })
  );
}

function collectImpactedFiles(
  impact: Record<string, unknown> | undefined,
  changedFiles: string[],
  filePath?: string
): string[] {
  const files = [
    ...changedFiles,
    ...(filePath ? [filePath] : []),
    ...stringList(impact?.changed_files),
    ...stringList(impact?.changedFiles),
    ...stringList(impact?.impacted_files),
    ...stringList(impact?.impactedFiles),
    ...stringList(impact?.matched_targets),
    ...stringList(isRecord(impact?.impact) ? impact?.impact.files : undefined),
  ];
  return unique(files);
}

function buildRisk(impact: Record<string, unknown> | undefined): VerificationRisk {
  const risk = impact && isRecord(impact.risk) ? impact.risk : {};
  return {
    level: stringValue(risk.level) ?? "unknown",
    ...(numberValue(risk.score) !== undefined ? { score: numberValue(risk.score) } : {}),
    source: impact ? "code-impact" : "fallback",
  };
}

function collectCoverageGaps(impact: Record<string, unknown> | undefined): VerificationGap[] {
  if (!impact || !Array.isArray(impact.coverage_gaps)) {
    return [];
  }

  return impact.coverage_gaps.map((gap): VerificationGap => {
    if (!isRecord(gap)) {
      return {
        code: "coverage_gap",
        severity: "medium",
        message: preview(gap, 220),
      };
    }

    const severity = stringValue(gap.severity);
    return {
      code: stringValue(gap.code) ?? "coverage_gap",
      severity: severity === "low" || severity === "high" ? severity : "medium",
      message: stringValue(gap.message) ?? stringValue(gap.reason) ?? preview(gap, 220),
    };
  });
}

function collectCaveats(
  impact: Record<string, unknown> | undefined,
  errors: Array<{ surface: string; message: string }>
): string[] {
  const caveats = [
    "This command builds a verification plan; it does not run tests, lint, type-check, or deploy commands.",
  ];

  if (impact?.degraded === true) {
    caveats.push(
      "Code impact returned degraded results; prefer conservative checks and local reads."
    );
  }

  const freshness = impact && isRecord(impact.index_freshness) ? impact.index_freshness : {};
  if (freshness.commit_match === false || freshness.is_stale === true) {
    caveats.push(
      "Code graph freshness does not fully match the local working tree; verify exact files locally."
    );
  }

  const warnings = Array.isArray(freshness.warnings) ? freshness.warnings : [];
  for (const warning of warnings.slice(0, 3)) {
    if (isRecord(warning) && warning.message) {
      caveats.push(preview(warning.message, 220));
    }
  }

  for (const error of errors) {
    caveats.push(`${error.surface} unavailable: ${error.message}`);
  }

  return unique(caveats);
}

function buildSuggestedCommands(
  plan: Pick<VerificationPlan, "target" | "recommendedChecks">
): string[] {
  const commands = plan.recommendedChecks.flatMap((check) =>
    check.command ? [check.command] : []
  );
  if (plan.target.changedFiles.length > 0) {
    commands.unshift(
      `snipara-companion code impact --changed-files ${plan.target.changedFiles.join(
        " "
      )} --diff-summary '<change summary>'`
    );
  } else if (plan.target.filePath) {
    commands.unshift(`snipara-companion code impact --file-path ${plan.target.filePath}`);
  } else if (plan.target.qualifiedName) {
    commands.unshift(`snipara-companion code impact --qualified-name ${plan.target.qualifiedName}`);
  }
  return unique(commands);
}

function dedupeChecks(checks: VerificationCheck[]): VerificationCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = `${check.kind}:${check.command ?? check.file ?? check.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Build a transparent verification plan for the current change.
 *
 * Combines code-impact signals (direct related tests, action checks, coverage
 * gaps) with package scripts inferred from the impacted files, dedupes the
 * resulting checks, and records explicit gaps (impact unavailable/skipped, no
 * direct tests, no impacted files) so the plan is honest about what it can and
 * cannot verify. Pure: it returns a plan and never executes any check.
 *
 * @param options Changed files / file path, optional code impact, cwd, and
 *   `skipImpact`.
 * @returns A plan of recommended checks plus a list of coverage gaps.
 */
export function buildVerificationPlan(options: BuildVerificationPlanOptions): VerificationPlan {
  const cwd = options.cwd ?? process.cwd();
  const changedFiles = unique(options.changedFiles ?? []);
  const errors = options.errors ?? [];
  const impactedFiles = collectImpactedFiles(options.codeImpact, changedFiles, options.filePath);
  const directChecks = collectDirectTestChecks(options.codeImpact);
  const actionChecks = collectActionChecks(options.codeImpact);
  const packageChecks = inferPackageScriptChecks(impactedFiles, cwd);
  const recommendedChecks = dedupeChecks([...directChecks, ...actionChecks, ...packageChecks]);
  const missingChecks = collectCoverageGaps(options.codeImpact);

  if (!options.codeImpact) {
    missingChecks.push({
      code: options.skipImpact ? "impact_skipped" : "impact_unavailable",
      severity: "medium",
      message: options.skipImpact
        ? "Code impact was skipped; impacted files, risk, and related tests are inferred locally only."
        : "Code impact was unavailable; impacted files, risk, and related tests may be incomplete.",
    });
  }

  if (directChecks.length === 0) {
    missingChecks.push({
      code: "no_direct_tests",
      severity: "medium",
      message:
        "No direct related tests were returned by code impact; run inferred package scripts and inspect changed behavior manually.",
    });
  }

  if (impactedFiles.length === 0) {
    missingChecks.push({
      code: "no_impacted_files",
      severity: "high",
      message: "No changed or impacted files were provided; pass --changed-files or --file-path.",
    });
  }

  const plan: VerificationPlan = {
    version: "snipara.verification_plan.v1",
    generatedAt: new Date().toISOString(),
    ...(options.task ? { task: options.task } : {}),
    target: {
      ...(options.qualifiedName ? { qualifiedName: options.qualifiedName } : {}),
      ...(options.symbolKey ? { symbolKey: options.symbolKey } : {}),
      ...(options.filePath ? { filePath: options.filePath } : {}),
      changedFiles,
    },
    impactedFiles,
    recommendedChecks,
    risk: buildRisk(options.codeImpact),
    missingChecks,
    caveats: collectCaveats(options.codeImpact, errors),
    suggestedCommands: [],
    ...(options.codeImpact ? { codeImpact: options.codeImpact } : {}),
    ...(options.codeImpactSourceSelection
      ? { codeImpactSourceSelection: options.codeImpactSourceSelection }
      : {}),
    errors,
  };
  plan.suggestedCommands = buildSuggestedCommands(plan);
  plan.judgmentCard = buildProjectJudgmentCard({
    task: options.task,
    changedFiles,
    codeImpact: options.codeImpact,
    verificationPlan: plan as unknown as Record<string, unknown>,
    errors,
  });
  return plan;
}

function printCheck(check: VerificationCheck): void {
  const label = check.command ?? check.file ?? check.title;
  const details = check.reason ? ` - ${check.reason}` : "";
  console.log(`- [${check.kind}] ${label}${details}`);
}

function printGap(gap: VerificationGap): void {
  console.log(`- [${gap.severity}] ${gap.code}: ${gap.message}`);
}

export async function verifyCommand(options: VerifyCommandOptions): Promise<void> {
  const changedFiles = unique(options.changedFiles ?? []);
  const errors: VerificationPlan["errors"] = [];
  let codeImpact: Record<string, unknown> | undefined;
  let codeImpactSourceSelection: CodeGraphSourceSelection | undefined;

  if (!options.skipImpact) {
    if (
      !options.qualifiedName &&
      !options.symbolKey &&
      !options.filePath &&
      changedFiles.length === 0
    ) {
      throw new Error("Provide --changed-files, --file-path, --qualified-name, or --symbol-key");
    }

    try {
      const autoResult = await resolveCodeGraphAutoSourceResult("impact", {
        qualifiedName: options.qualifiedName,
        symbolKey: options.symbolKey,
        filePath: options.filePath,
        changedFiles,
        diffSummary: options.diffSummary ?? options.task,
        limit: options.limit,
      });
      codeImpact = autoResult.result as Record<string, unknown>;
      codeImpactSourceSelection = autoResult.sourceSelection;
    } catch (error) {
      errors.push({
        surface: "code_impact",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const plan = buildVerificationPlan({
    ...options,
    changedFiles,
    codeImpact,
    codeImpactSourceSelection,
    errors,
  });

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(chalk.bold("Verification Plan"));
  if (plan.task) {
    console.log(`Task: ${plan.task}`);
  }
  console.log(
    `Risk: ${plan.risk.level}${plan.risk.score !== undefined ? ` (${plan.risk.score})` : ""}`
  );
  if (plan.codeImpactSourceSelection) {
    console.log(
      `Code impact source: ${plan.codeImpactSourceSelection.selected} (${plan.codeImpactSourceSelection.reason})`
    );
  }
  console.log("");

  if (plan.judgmentCard) {
    console.log(chalk.bold("Project Judgment"));
    for (const line of formatProjectJudgmentCard(plan.judgmentCard)) {
      console.log(line);
    }
    console.log("");
  }

  console.log(chalk.bold("Impacted Files"));
  if (plan.impactedFiles.length === 0) {
    console.log(chalk.yellow("No impacted files available"));
  } else {
    for (const file of plan.impactedFiles) {
      console.log(`- ${file}`);
    }
  }
  console.log("");

  console.log(chalk.bold("Recommended Checks"));
  if (plan.recommendedChecks.length === 0) {
    console.log(chalk.yellow("No concrete checks available"));
  } else {
    for (const check of plan.recommendedChecks) {
      printCheck(check);
    }
  }
  console.log("");

  console.log(chalk.bold("Missing Checks"));
  if (plan.missingChecks.length === 0) {
    console.log("None reported");
  } else {
    for (const gap of plan.missingChecks) {
      printGap(gap);
    }
  }
  console.log("");

  console.log(chalk.bold("Caveats"));
  for (const caveat of plan.caveats) {
    console.log(`- ${caveat}`);
  }
  console.log("");

  if (plan.suggestedCommands.length > 0) {
    console.log(chalk.bold("Suggested Commands"));
    for (const command of plan.suggestedCommands) {
      console.log(command);
    }
  }
}
