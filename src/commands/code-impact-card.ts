/**
 * The compact answer of `code impact`: what depends on the target, which tests to run, how sure the
 * answer is, and where the full result was written. It is what an agent reads by default; the full
 * result (chains, semantic assertions, source selection) stays in the detail file and behind --detail.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { CodeGraphAutoSourceResult, CodeGraphSourceSelection } from "./code";

/** What the card reads from a result: the answer and which source gave it, for any caller. */
export type CodeImpactCardInput = Pick<CodeGraphAutoSourceResult, "result"> & {
  sourceSelection: Pick<CodeGraphSourceSelection, "selected" | "reason">;
};

export const CODE_IMPACT_CARD_VERSION = "snipara.code_impact.card.v1";
export const CODE_IMPACT_DETAIL_RELATIVE_PATH = ".snipara/code-impact/latest.json";

const LIMITS = {
  dependents: 15,
  transitive: 8,
  dependencies: 8,
  tests: 8,
  warnings: 3,
  warningChars: 240,
};
const PACKAGE_ROOT_MARKERS = ["package.json", "pyproject.toml", "setup.py", "go.mod"];

export interface CodeImpactCardDependent {
  file: string;
  line?: number;
  symbols?: string[];
}

export interface CodeImpactCard {
  version: typeof CODE_IMPACT_CARD_VERSION;
  source: string;
  reason: string;
  targets: string[];
  missingTargets: string[];
  coverage: { status: string; reasons: string[] };
  risk: { level: string; score: number | null; reasons: string[] };
  /** Files that import or call the targets directly. `count` is the total; `files` is capped. */
  dependents: { count: number; files: CodeImpactCardDependent[] };
  /** Files that reach the targets through other files, up to the traversal depth. */
  transitiveDependents: { count: number; files: string[] };
  /** Files the targets depend on: context, not what breaks. */
  dependencies: { count: number; files: string[] };
  /**
   * Existing test files only. `linked`: named after a target, direct dependents, or recommended;
   * `transitive`: none is linked, so the nearest tests that reach a target through other files.
   * `count` is the total; `files` is capped.
   */
  tests: { count: number; files: string[]; basis: "linked" | "transitive" | "none" };
  warnings: string[];
  /** Present with `--minimum-change-mode review`: the smallest-safe-diff verdict; its evidence is in the detail. */
  minimumChange?: { status: string };
  /** Repository-relative path of the full result. */
  detail: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringsOf(value: unknown): string[] {
  return asArray(value).flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = asRecord(item);
    const filePath = record?.filePath ?? record?.file_path ?? record?.path;
    return typeof filePath === "string" ? [filePath] : [];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** The local and hosted halves of a result, whichever source answered. */
function resultSides(auto: CodeImpactCardInput): {
  top: UnknownRecord;
  local: UnknownRecord | null;
  hosted: UnknownRecord | null;
} {
  const top = asRecord(auto.result) ?? {};
  if (auto.sourceSelection.selected === "hosted_graph") {
    return { top, local: null, hosted: top };
  }
  if (auto.sourceSelection.selected === "local_overlay") {
    // A local answer can carry a merged hybrid envelope when hosted enrichment was requested.
    const nested = asRecord(top.local);
    return {
      top,
      local: nested && Array.isArray(nested.incoming) ? nested : top,
      hosted: asRecord(top.hosted),
    };
  }
  return { top, local: asRecord(top.local), hosted: asRecord(top.hosted) };
}

export function isTestPath(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(filePath) ||
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /^test_.+\.py$/.test(base) ||
    /_test\.(py|go)$/.test(base)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nearestPackageRoot(repoRoot: string, filePath: string): string {
  let current = path.posix.dirname(filePath);
  while (current && current !== ".") {
    if (
      PACKAGE_ROOT_MARKERS.some((marker) => fs.existsSync(path.join(repoRoot, current, marker)))
    ) {
      return current;
    }
    current = path.posix.dirname(current);
  }
  return "";
}

function listFilesUnder(repoRoot: string, relativeRoot: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z", "--", relativeRoot || "."],
      {
        cwd: repoRoot,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    return output.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Test files named after a target (`verify.ts` -> `verify.test.js`, `test_verify.py`, `verify_test.go`)
 * inside the target's package. It finds tests the graph cannot link, such as tests that load a build.
 */
export function conventionTests(repoRoot: string, targets: string[]): string[] {
  const listings = new Map<string, string[]>();
  const found: string[] = [];
  for (const target of targets) {
    const base = path.posix.basename(target);
    const stem = base.replace(/\.d\.ts$/, "").replace(/\.[^.]+$/, "");
    if (!stem || stem === "index" || isTestPath(target)) continue;
    const pattern = new RegExp(
      `^(?:${escapeRegExp(stem)}\\.(?:test|spec)\\.[cm]?[jt]sx?|test_${escapeRegExp(stem)}\\.py|${escapeRegExp(stem)}_test\\.(?:py|go))$`
    );
    const root = nearestPackageRoot(repoRoot, target);
    if (!listings.has(root)) listings.set(root, listFilesUnder(repoRoot, root));
    for (const candidate of listings.get(root) ?? []) {
      if (pattern.test(path.posix.basename(candidate))) found.push(candidate);
    }
  }
  return found;
}

function localDependents(local: UnknownRecord | null): CodeImpactCardDependent[] {
  const byFile = new Map<string, CodeImpactCardDependent>();
  for (const edge of asArray(local?.incoming)) {
    const record = asRecord(edge);
    const file = record?.from;
    if (typeof file !== "string") continue;
    const line = typeof record?.line === "number" ? record.line : undefined;
    const known = byFile.get(file);
    if (!known) byFile.set(file, line !== undefined ? { file, line } : { file });
    else if (line !== undefined && (known.line === undefined || line < known.line))
      known.line = line;
  }
  return [...byFile.values()];
}

function hostedDependents(hosted: UnknownRecord | null): CodeImpactCardDependent[] {
  const container = asRecord(hosted?.dependents);
  return asArray(container?.dependents ?? hosted?.dependents).flatMap((item) => {
    const record = asRecord(item);
    const file = record?.file_path ?? record?.filePath;
    if (typeof file !== "string") return [];
    const symbols = stringsOf(record?.symbols).slice(0, 3);
    return [symbols.length ? { file, symbols } : { file }];
  });
}

function mergeDependents(
  groups: CodeImpactCardDependent[][],
  excluded: Set<string>
): CodeImpactCardDependent[] {
  const byFile = new Map<string, CodeImpactCardDependent>();
  for (const dependent of groups.flat()) {
    if (excluded.has(dependent.file)) continue;
    const known = byFile.get(dependent.file);
    if (!known) {
      byFile.set(dependent.file, { ...dependent });
      continue;
    }
    if (known.line === undefined && dependent.line !== undefined) known.line = dependent.line;
    if (!known.symbols && dependent.symbols) known.symbols = dependent.symbols;
  }
  return [...byFile.values()].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  );
}

function riskReasons(risk: UnknownRecord | null): string[] {
  const reasons = stringsOf(risk?.reasons);
  for (const factor of asArray(risk?.factors)) {
    const code = asRecord(factor)?.code;
    if (typeof code === "string") reasons.push(code);
  }
  return [...new Set(reasons)].slice(0, 4);
}

function coverageOf(top: UnknownRecord, hostedOnly: boolean): CodeImpactCard["coverage"] {
  const coverage = asRecord(top.coverage);
  if (coverage && typeof coverage.status === "string") {
    return { status: coverage.status, reasons: unique(stringsOf(coverage.reasons)) };
  }
  if (hostedOnly) {
    return top.degraded === true
      ? { status: "incomplete", reasons: ["hosted_graph_degraded"] }
      : { status: "indexed", reasons: [] };
  }
  return { status: "unknown", reasons: [] };
}

function formatWarning(value: unknown, maxChars: number): string | null {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value.slice(0, maxChars) : null;
  const code = typeof record.code === "string" ? record.code : "warning";
  const message = typeof record.message === "string" ? record.message : "";
  const text = message ? `${code}: ${message}` : code;
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

/**
 * Builds the compact card from any `code impact` result: local overlay, hosted graph or hybrid.
 * Only test files that exist on disk are listed.
 */
export function buildCodeImpactCard(
  auto: CodeImpactCardInput,
  options: { repoRoot: string; detailPath: string; warningChars?: number }
): CodeImpactCard {
  const { top, local, hosted } = resultSides(auto);
  const targets = unique([
    ...stringsOf(local?.changedFiles),
    ...stringsOf(hosted?.changed_files),
    ...stringsOf(top.changed_files),
  ]);
  const targetSet = new Set(targets);
  const dependents = mergeDependents([localDependents(local), hostedDependents(hosted)], targetSet);
  const dependentSet = new Set(dependents.map((dependent) => dependent.file));
  // Kept in the order given, nearest first.
  const transitive = [...new Set(stringsOf(local?.dependentFiles))].filter(
    (file) => !targetSet.has(file) && !dependentSet.has(file)
  );
  const dependencies = unique(
    asArray(local?.outgoing).flatMap((edge) => {
      const to = asRecord(edge)?.to;
      return typeof to === "string" && !targetSet.has(to) ? [to] : [];
    })
  );
  const recommended = [
    ...stringsOf(top.recommended_tests),
    ...stringsOf(top.recommendedTests),
    ...stringsOf(hosted?.tests_to_run),
    ...stringsOf(hosted?.recommended_tests),
  ];
  const exists = (file: string): boolean => fs.existsSync(path.join(options.repoRoot, file));
  // Linked tests: named after a target, depending on it directly, or recommended. Tests that only reach
  // it through other files (a package `__init__` re-exporting everything) are the full suite's job, and
  // stand in only when nothing is linked, nearest first.
  const linkedTests = [
    ...new Set([
      ...conventionTests(options.repoRoot, targets).sort(),
      ...[...dependentSet].filter(isTestPath).sort(),
      ...unique(recommended),
    ]),
  ].filter(exists);
  const tests = linkedTests.length ? linkedTests : transitive.filter(isTestPath).filter(exists);
  const risk = asRecord(top.risk);
  const warningChars = options.warningChars ?? LIMITS.warningChars;
  const warnings = asArray(top.warnings)
    .map((warning) => formatWarning(warning, warningChars))
    .filter((warning): warning is string => Boolean(warning));
  const minimumChangeStatus =
    asRecord(asRecord(top.minimum_change_evidence)?.smallest_safe_diff)?.status ??
    asRecord(asRecord(local?.minimum_change_evidence)?.smallest_safe_diff)?.status ??
    asRecord(top.minimum_safe_change)?.status;

  return {
    version: CODE_IMPACT_CARD_VERSION,
    source: auto.sourceSelection.selected,
    reason: auto.sourceSelection.reason,
    targets,
    missingTargets: unique([
      ...stringsOf(top.missingTargetFiles),
      ...stringsOf(local?.missingTargetFiles),
    ]),
    coverage: coverageOf(top, auto.sourceSelection.selected === "hosted_graph"),
    risk: {
      level: typeof risk?.level === "string" ? risk.level : "unknown",
      score: typeof risk?.score === "number" ? risk.score : null,
      reasons: riskReasons(risk),
    },
    dependents: { count: dependents.length, files: dependents.slice(0, LIMITS.dependents) },
    transitiveDependents: {
      count: transitive.length,
      files: transitive.slice(0, LIMITS.transitive),
    },
    dependencies: { count: dependencies.length, files: dependencies.slice(0, LIMITS.dependencies) },
    tests: {
      count: tests.length,
      files: tests.slice(0, LIMITS.tests),
      basis: linkedTests.length ? "linked" : tests.length ? "transitive" : "none",
    },
    warnings: warnings.slice(0, LIMITS.warnings),
    ...(typeof minimumChangeStatus === "string"
      ? { minimumChange: { status: minimumChangeStatus } }
      : {}),
    detail: options.detailPath,
  };
}

/** Writes the full result where the card points, and returns its repository-relative path. */
export function writeCodeImpactDetail(repoRoot: string, auto: unknown): string {
  const file = path.join(repoRoot, CODE_IMPACT_DETAIL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auto, null, 2)}\n`);
  return CODE_IMPACT_DETAIL_RELATIVE_PATH;
}

function sourceLabel(source: string): string {
  if (source === "local_overlay") return "local";
  if (source === "hosted_graph") return "hosted";
  if (source === "hybrid_graph") return "hybrid";
  return source;
}

function printList(title: string, count: number, files: string[]): void {
  console.log(`${title}`);
  if (count === 0) {
    console.log("  (none)");
    return;
  }
  for (const file of files) console.log(`  ${file}`);
  if (count > files.length) console.log(`  ... ${count - files.length} more`);
}

export function printCodeImpactCard(
  card: CodeImpactCard,
  json?: boolean,
  missingTargetDetails?: Map<string, string>
): void {
  if (json) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }
  const target =
    card.targets.length === 1
      ? card.targets[0]
      : card.targets.length > 1
        ? `${card.targets.length} files`
        : "selected target";
  console.log(chalk.bold(`Code impact - ${sourceLabel(card.source)} - ${target}`));
  console.log(`Source: ${card.source} (${card.reason})`);
  const coverageReasons = card.coverage.reasons.length
    ? ` (${card.coverage.reasons.join(", ")})`
    : "";
  const score = card.risk.score !== null ? ` score ${card.risk.score}` : "";
  const riskReasons = card.risk.reasons.length ? ` (${card.risk.reasons.join(", ")})` : "";
  console.log(
    `Coverage: ${card.coverage.status}${coverageReasons}; risk: ${card.risk.level}${score}${riskReasons}`
  );
  console.log("");
  printList(
    `Incoming (${card.dependents.count}) - files that depend on this`,
    card.dependents.count,
    card.dependents.files.map((dependent) => {
      const location =
        dependent.line !== undefined ? `${dependent.file}:${dependent.line}` : dependent.file;
      return dependent.symbols?.length ? `${location} (${dependent.symbols.join(", ")})` : location;
    })
  );
  if (card.transitiveDependents.count > 0) {
    console.log("");
    printList(
      `Transitive (${card.transitiveDependents.count}) - files that reach this through others`,
      card.transitiveDependents.count,
      card.transitiveDependents.files
    );
  }
  console.log("");
  printList(
    `Outgoing (${card.dependencies.count}) - files this depends on`,
    card.dependencies.count,
    card.dependencies.files
  );
  console.log("");
  printList(
    `Tests (${card.tests.count}) - existing test files to run${card.tests.basis === "transitive" ? " (none linked directly; nearest that reach it)" : ""}`,
    card.tests.count,
    card.tests.files
  );
  if (card.minimumChange) {
    console.log("");
    console.log(`Smallest safe diff: ${card.minimumChange.status}`);
  }
  if (card.missingTargets.length > 0) {
    console.log("");
    console.log(chalk.yellow(`Missing targets (${card.missingTargets.length})`));
    for (const file of card.missingTargets.slice(0, 12)) {
      const detail = missingTargetDetails?.get(file);
      console.log(`  ${file}${detail ? ` (${detail})` : ""}`);
    }
    if (card.missingTargets.length > 12)
      console.log(`  ... ${card.missingTargets.length - 12} more`);
  }
  if (card.warnings.length > 0) {
    console.log("");
    console.log(chalk.yellow(`Warnings (${card.warnings.length})`));
    for (const warning of card.warnings) console.log(`  ${warning}`);
  }
  console.log("");
  console.log(`Detail: ${card.detail} (--detail prints the full result)`);
}
