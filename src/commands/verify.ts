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
import {
  resolveCodeGraphAutoSourceResult,
  resolveRepoRoot,
  type CodeGraphSourceSelection,
} from "./code";
import {
  buildCodeImpactCard,
  conventionTests,
  writeCodeImpactDetail,
  type CodeImpactCard,
} from "./code-impact-card";
import {
  buildProjectJudgmentCard,
  codeImpactApplicabilityGap,
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
  /** Print the full plan, with the full code impact, instead of the compact one. */
  detail?: boolean;
}

export interface VerificationCheck {
  kind: "test" | "lint" | "type-check" | "build" | "inspection" | "command";
  title: string;
  command?: string;
  file?: string;
  /** Every test file a grouped targeted check runs; `file` is the first. */
  files?: string[];
  source: "code-impact" | "package-script" | "fallback";
  reason?: string;
}

export interface VerificationGap {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
  reasons?: string[];
  missingTargetFiles?: string[];
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
  /**
   * Existing test files linked to the change, relative to `cwd` (the impact card's tests). Without it,
   * the test files named after the changed files are used.
   */
  linkedTests?: string[];
  errors?: Array<{ surface: string; message: string }>;
}

interface PackageInfo {
  root: string;
  name?: string;
  scripts: Record<string, string>;
}

interface PythonProjectInfo {
  root: string;
  pyprojectPath: string;
  text: string;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandInDirectory(root: string, cwd: string, command: string): string {
  const relativeRoot = path.relative(path.resolve(cwd), path.resolve(root));
  if (!relativeRoot) {
    return command;
  }
  return `cd ${shellQuote(relativeRoot)} && ${command}`;
}

/** Quotes a shell argument only when it needs it, so ordinary paths stay readable. */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./@:+=-]+$/.test(value) ? value : shellQuote(value);
}

const TEST_RUNNERS: Array<{ name: string; pattern: RegExp; command: (file: string) => string }> = [
  { name: "vitest", pattern: /\bvitest\b/, command: (file) => `vitest run ${file}` },
  { name: "jest", pattern: /\bjest\b/, command: (file) => `jest ${file}` },
  {
    name: "node --test",
    pattern: /\bnode\b[^&|;]*\s--test\b/,
    command: (file) => `node --test ${file}`,
  },
  { name: "mocha", pattern: /\bmocha\b/, command: (file) => `mocha ${file}` },
];

/** `A=1 B=2 node --test ...` keeps `A=1 B=2 ` so a targeted run sees the same environment. */
function leadingEnvironment(script: string): string {
  const match = script.match(/^\s*((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/);
  return match ? `${match[1].trim()} ` : "";
}

function findUpward(startPath: string, cwd: string, marker: string): string | null {
  let current = path.dirname(path.resolve(cwd, startPath));
  const stop = path.parse(current).root;
  while (current !== stop) {
    const candidate = path.join(current, marker);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** How to run test files of one package with the runner it already uses. */
interface TargetedRun {
  /** Files sharing a key run in one command. */
  key: string;
  runner: string;
  /** Path of the file as the command sees it. */
  argument: string;
  command: (argumentsList: string[]) => string;
}

/**
 * The run for one test file: the package's `pretest` first (it often builds what the test loads), the
 * test script's leading environment, then the runner on the selected files only. Null when no known
 * runner is found.
 */
function targetedTestRun(testFile: string, cwd: string): TargetedRun | null {
  if (testFile.endsWith(".py")) {
    const pyproject = findPyproject(testFile, cwd);
    const root = pyproject ? path.dirname(pyproject) : path.resolve(cwd);
    return {
      key: `pytest:${root}`,
      runner: "pytest",
      argument: path.relative(root, path.resolve(cwd, testFile)).split(path.sep).join("/"),
      command: (files) =>
        commandInDirectory(root, cwd, `python -m pytest ${files.map(shellArgument).join(" ")}`),
    };
  }
  if (testFile.endsWith("_test.go")) {
    const goMod = findUpward(testFile, cwd, "go.mod");
    const root = goMod ? path.dirname(goMod) : path.resolve(cwd);
    const directory = path
      .relative(root, path.dirname(path.resolve(cwd, testFile)))
      .split(path.sep)
      .join("/");
    return {
      key: `go:${root}`,
      runner: "go test",
      argument: `./${directory}`,
      command: (packages) => commandInDirectory(root, cwd, `go test ${unique(packages).join(" ")}`),
    };
  }
  const packageJson = findPackageJson(testFile, cwd);
  const info = packageJson ? readPackageInfo(packageJson) : null;
  const script = info?.scripts.test;
  if (!info || !script) return null;
  const runner = TEST_RUNNERS.find((candidate) => candidate.pattern.test(script));
  if (!runner) return null;
  const exec =
    info.name && path.resolve(info.root) !== path.resolve(cwd)
      ? `pnpm --filter ${info.name} exec `
      : "pnpm exec ";
  const pretest = info.scripts.pretest
    ? `${commandForPackageScript(info, "pretest", cwd)} && `
    : "";
  return {
    key: `${runner.name}:${info.root}`,
    runner: runner.name,
    argument: path.relative(info.root, path.resolve(cwd, testFile)).split(path.sep).join("/"),
    command: (files) =>
      `${pretest}${leadingEnvironment(script)}${exec}${runner.command(files.map(shellArgument).join(" "))}`,
  };
}

/** One check per package and runner, so related test files run in a single targeted command. */
function linkedTestChecks(
  testFiles: string[],
  cwd: string,
  fromImpact: boolean
): VerificationCheck[] {
  const source = fromImpact ? ("code-impact" as const) : ("fallback" as const);
  const groups = new Map<string, { run: TargetedRun; files: string[]; argumentsList: string[] }>();
  const checks: VerificationCheck[] = [];
  for (const file of testFiles) {
    const run = targetedTestRun(file, cwd);
    if (!run) {
      checks.push({
        kind: "test",
        title: `targeted test ${file}`,
        file,
        source,
        reason:
          "Linked to the change; no known test runner was found in its package, run it with the package's runner.",
      });
      continue;
    }
    const group = groups.get(run.key) ?? { run, files: [], argumentsList: [] };
    group.files.push(file);
    group.argumentsList.push(run.argument);
    groups.set(run.key, group);
  }
  const grouped = [...groups.values()].map(
    (group): VerificationCheck => ({
      kind: "test",
      title:
        group.files.length === 1
          ? `targeted test ${group.files[0]}`
          : `targeted tests (${group.files.length})`,
      file: group.files[0],
      ...(group.files.length > 1 ? { files: group.files } : {}),
      command: group.run.command(group.argumentsList),
      source,
      reason: `Linked to the change; run first (${group.run.runner}).`,
    })
  );
  return [...grouped, ...checks];
}

function isPythonSurface(filePath: string): boolean {
  const basename = path.basename(filePath);
  return (
    filePath.endsWith(".py") ||
    basename === "pyproject.toml" ||
    basename === "requirements.txt" ||
    basename.startsWith("requirements-") ||
    basename === "setup.py" ||
    basename === "setup.cfg" ||
    basename === "tox.ini"
  );
}

function findPyproject(startPath: string, cwd: string): string | null {
  const absoluteStart = path.resolve(cwd, startPath);
  let current =
    fs.existsSync(absoluteStart) && fs.statSync(absoluteStart).isDirectory()
      ? absoluteStart
      : path.dirname(absoluteStart);
  const stop = path.parse(path.resolve(cwd)).root;

  while (current !== stop) {
    const candidate = path.join(current, "pyproject.toml");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function readPythonProject(pyprojectPath: string): PythonProjectInfo | null {
  try {
    return {
      root: path.dirname(pyprojectPath),
      pyprojectPath,
      text: fs.readFileSync(pyprojectPath, "utf8"),
    };
  } catch {
    return null;
  }
}

function inferPythonChecks(changedFiles: string[], cwd: string): VerificationCheck[] {
  const pyprojectFiles = unique(
    changedFiles
      .filter(isPythonSurface)
      .map((file) => findPyproject(file, cwd))
      .filter((file): file is string => typeof file === "string")
  );
  const projects = pyprojectFiles
    .map(readPythonProject)
    .filter((info): info is PythonProjectInfo => Boolean(info));

  return projects.flatMap((info): VerificationCheck[] => {
    const checks: VerificationCheck[] = [
      {
        kind: "test",
        title: "pytest for Python project",
        command: commandInDirectory(info.root, cwd, "python -m pytest"),
        source: "fallback",
        reason: `Detected Python project at ${path.relative(cwd, info.pyprojectPath)}.`,
      },
    ];

    if (/\[tool\.ruff(?:\.|\])/.test(info.text) || /\bruff\b/.test(info.text)) {
      checks.push({
        kind: "lint",
        title: "ruff check for Python project",
        command: commandInDirectory(info.root, cwd, "python -m ruff check ."),
        source: "fallback",
        reason: `Detected Ruff configuration or dependency in ${path.relative(cwd, info.pyprojectPath)}.`,
      });
    }

    if (/\[tool\.mypy\]/.test(info.text) || /\bmypy\b/.test(info.text)) {
      checks.push({
        kind: "type-check",
        title: "mypy for Python project",
        command: commandInDirectory(info.root, cwd, "python -m mypy ."),
        source: "fallback",
        reason: `Detected mypy configuration or dependency in ${path.relative(cwd, info.pyprojectPath)}.`,
      });
    }

    if (/\[build-system\]/.test(info.text)) {
      checks.push({
        kind: "build",
        title: "build Python package",
        command: commandInDirectory(info.root, cwd, "python -m build"),
        source: "fallback",
        reason: `Detected Python build system in ${path.relative(cwd, info.pyprojectPath)}.`,
      });
    }

    return checks;
  });
}

function inferPackageScriptChecks(
  changedFiles: string[],
  cwd: string,
  fullSuiteLast = false
): VerificationCheck[] {
  const packageFiles = unique(
    changedFiles
      .filter((file) => !(isPythonSurface(file) && findPyproject(file, cwd)))
      .map((file) => findPackageJson(file, cwd))
      .filter((file): file is string => typeof file === "string")
  );
  const packages = packageFiles
    .map(readPackageInfo)
    .filter((info): info is PackageInfo => Boolean(info));
  // With targeted tests first, the package's whole suite comes after the cheaper checks.
  const scriptKinds: Array<[string, VerificationCheck["kind"]]> = fullSuiteLast
    ? [
        ["type-check", "type-check"],
        ["lint", "lint"],
        ["test", "test"],
        ["build", "build"],
      ]
    : [
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
          reason:
            fullSuiteLast && scriptName === "test"
              ? "The package's whole suite: run it once the targeted tests pass."
              : "Detected from nearest package.json scripts for the changed files.",
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
  const incomplete = codeImpactApplicabilityGap(impact);
  return {
    level: incomplete ? "unknown" : (stringValue(risk.level) ?? "unknown"),
    ...(!incomplete && numberValue(risk.score) !== undefined
      ? { score: numberValue(risk.score) }
      : {}),
    source: impact ? "code-impact" : "fallback",
  };
}

function collectCoverageGaps(impact: Record<string, unknown> | undefined): VerificationGap[] {
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
      : [];
  const gaps = (Array.isArray(impact?.coverage_gaps) ? impact.coverage_gaps : []).map(
    (gap: unknown): VerificationGap => {
      if (!isRecord(gap)) {
        return {
          code: "coverage_gap",
          severity: "medium",
          message: preview(gap, 220),
        };
      }

      const severity = stringValue(gap.severity);
      const reasons = strings(gap.reasons);
      const missingTargetFiles = [
        ...new Set([...strings(gap.missingTargetFiles), ...strings(gap.missing_target_files)]),
      ];
      return {
        code: stringValue(gap.code) ?? "coverage_gap",
        severity: severity === "low" || severity === "high" ? severity : "medium",
        message: stringValue(gap.message) ?? stringValue(gap.reason) ?? preview(gap, 220),
        ...(reasons.length ? { reasons } : {}),
        ...(missingTargetFiles.length ? { missingTargetFiles } : {}),
      };
    }
  );
  const applicability = codeImpactApplicabilityGap(impact);
  if (applicability) gaps.push(applicability);
  const merged = new Map<string, VerificationGap>();
  const messages = new Map<string, string[]>();
  const rank = { low: 0, medium: 1, high: 2 };
  for (const gap of gaps) {
    const previous = merged.get(gap.code);
    if (!previous) {
      merged.set(gap.code, gap);
      messages.set(gap.code, [gap.message]);
      continue;
    }
    const reasons = [...new Set([...(previous.reasons ?? []), ...(gap.reasons ?? [])])];
    const missingTargetFiles = [
      ...new Set([...(previous.missingTargetFiles ?? []), ...(gap.missingTargetFiles ?? [])]),
    ];
    const messageParts = [...new Set([...(messages.get(gap.code) ?? []), gap.message])];
    messages.set(gap.code, messageParts);
    merged.set(gap.code, {
      code: gap.code,
      severity: rank[previous.severity] >= rank[gap.severity] ? previous.severity : gap.severity,
      message: messageParts.join(" "),
      ...(reasons.length ? { reasons } : {}),
      ...(missingTargetFiles.length ? { missingTargetFiles } : {}),
    });
  }
  return [...merged.values()];
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
  const exists = (file: string): boolean => fs.existsSync(path.resolve(cwd, file));
  const linkedTests = unique(
    options.linkedTests ??
      conventionTests(cwd, [...changedFiles, ...(options.filePath ? [options.filePath] : [])])
  ).filter(exists);
  // A recommended test file that does not exist is a guess, not a check.
  const directChecks = [
    ...linkedTestChecks(linkedTests, cwd, options.linkedTests !== undefined),
    ...collectDirectTestChecks(options.codeImpact).filter(
      (check) => !check.file || exists(check.file)
    ),
  ];
  const actionChecks = collectActionChecks(options.codeImpact);
  const pythonChecks = inferPythonChecks(impactedFiles, cwd);
  const packageChecks = inferPackageScriptChecks(impactedFiles, cwd, linkedTests.length > 0);
  const recommendedChecks = dedupeChecks([
    ...directChecks,
    ...actionChecks,
    ...pythonChecks,
    ...packageChecks,
  ]);
  const missingChecks = collectCoverageGaps(options.codeImpact).filter(
    (gap) => !(gap.code === "no_related_tests" && directChecks.length > 0)
  );

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
  let impactCard: CodeImpactCard | undefined;
  const cwd = process.cwd();
  const repoRoot = resolveRepoRoot(cwd);

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
      impactCard = buildCodeImpactCard(autoResult, {
        repoRoot,
        detailPath: writeCodeImpactDetail(repoRoot, autoResult),
      });
    } catch (error) {
      errors.push({
        surface: "code_impact",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const plan = buildVerificationPlan({
    ...options,
    cwd,
    changedFiles,
    codeImpact,
    codeImpactSourceSelection,
    // The card's tests are repository-relative; the plan's paths are relative to where it runs.
    ...(impactCard
      ? {
          linkedTests: impactCard.tests.files.map((file) =>
            path.relative(cwd, path.join(repoRoot, file)).split(path.sep).join("/")
          ),
        }
      : {}),
    errors,
  });
  const detailPath = writeVerificationDetail(repoRoot, plan);

  if (options.json) {
    console.log(
      JSON.stringify(
        options.detail ? plan : compactVerificationPlan(plan, impactCard, detailPath),
        null,
        2
      )
    );
    return;
  }
  if (options.detail) {
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

  if (impactCard) {
    console.log(chalk.bold("Impact"));
    console.log(
      `${impactCard.dependents.count} dependent file(s), ${impactCard.transitiveDependents.count} transitive; coverage ${impactCard.coverage.status}`
    );
    for (const dependent of impactCard.dependents.files) {
      console.log(
        `- ${dependent.line !== undefined ? `${dependent.file}:${dependent.line}` : dependent.file}`
      );
    }
    if (impactCard.dependents.count > impactCard.dependents.files.length) {
      console.log(`- ... ${impactCard.dependents.count - impactCard.dependents.files.length} more`);
    }
  } else {
    console.log(chalk.bold("Impacted Files"));
    if (plan.impactedFiles.length === 0) {
      console.log(chalk.yellow("No impacted files available"));
    } else {
      for (const file of plan.impactedFiles.slice(0, 20)) {
        console.log(`- ${file}`);
      }
      if (plan.impactedFiles.length > 20)
        console.log(`- ... ${plan.impactedFiles.length - 20} more`);
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

  const commands = suggestedCommandsFor(plan, impactCard);
  if (commands.length > 0) {
    console.log(chalk.bold("Suggested Commands"));
    for (const command of commands) {
      console.log(command);
    }
    console.log("");
  }
  console.log(`Detail: ${detailPath} (--detail prints the full plan)`);
}

export const VERIFICATION_DETAIL_RELATIVE_PATH = ".snipara/verify/latest.json";

/** Writes the full plan, code impact included, and returns its repository-relative path. */
export function writeVerificationDetail(repoRoot: string, plan: VerificationPlan): string {
  const file = path.join(repoRoot, VERIFICATION_DETAIL_RELATIVE_PATH);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  } catch {
    // The plan is still printed; only the detail file is missing.
  }
  return VERIFICATION_DETAIL_RELATIVE_PATH;
}

/** With an impact card in hand, re-running code impact is not a next step. */
function suggestedCommandsFor(plan: VerificationPlan, card: CodeImpactCard | undefined): string[] {
  return card
    ? plan.suggestedCommands.filter(
        (command) => !command.startsWith("snipara-companion code impact ")
      )
    : plan.suggestedCommands;
}

/**
 * What an agent reads by default: the checks in the order to run them, the gaps, the impact card in
 * place of the full impact, a short judgment, and where the full plan was written.
 */
export function compactVerificationPlan(
  plan: VerificationPlan,
  card: CodeImpactCard | undefined,
  detailPath: string
): Record<string, unknown> {
  const judgment = plan.judgmentCard as unknown as Record<string, unknown> | undefined;
  return {
    version: "snipara.verification_plan.compact.v1",
    generatedAt: plan.generatedAt,
    ...(plan.task ? { task: plan.task } : {}),
    target: plan.target,
    risk: plan.risk,
    impact: card ?? null,
    recommendedChecks: plan.recommendedChecks,
    missingChecks: plan.missingChecks,
    caveats: plan.caveats,
    suggestedCommands: suggestedCommandsFor(plan, card),
    ...(judgment
      ? {
          judgment: {
            score: judgment.score,
            band: judgment.band,
            state: judgment.state,
            canProceed: judgment.canProceed,
            summary: judgment.summary,
          },
        }
      : {}),
    errors: plan.errors,
    detail: detailPath,
  };
}
