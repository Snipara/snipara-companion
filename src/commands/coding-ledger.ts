import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const CODING_INTELLIGENCE_LEDGER_VERSION = "snipara.coding_intelligence_ledger.v0" as const;

export type CodingLedgerSectionName =
  | "served_context"
  | "plans"
  | "diffs"
  | "tests"
  | "ci"
  | "reviews"
  | "outcomes"
  | "influence_receipts";

export type CodingLedgerConfidenceBand = "high" | "medium" | "low" | "unknown";

export interface CodingLedgerEvidenceItem {
  id: string;
  kind: CodingLedgerSectionName;
  title?: string;
  summary: string;
  sourceRef?: string;
  status?: string;
  confidence?: number;
  reasonCodes: string[];
  files: string[];
  commands: string[];
  observedAt?: string;
}

export interface CodingLedgerPrompt {
  task?: string;
  prompt?: string;
  sourceRef?: string;
}

export interface CodingLedgerRepoState {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  stagedFileCount?: number;
  unstagedFileCount?: number;
  changedFiles: string[];
  recentFiles: string[];
  diffSummary?: string;
}

export interface CodingLedgerConfidence {
  score?: number;
  band: CodingLedgerConfidenceBand;
  rationale?: string;
}

export interface CodingLedgerCalibrationMetadata {
  sampleSize?: number;
  reliability?: number;
  status?: string;
  notes: string[];
  caveats: string[];
}

export interface CodingLedgerRedactionSummary {
  redacted: boolean;
  redactedValueCount: number;
  patterns: string[];
}

export interface CodingIntelligenceLedger {
  version: typeof CODING_INTELLIGENCE_LEDGER_VERSION;
  generatedAt: string;
  portability: {
    format: "json";
    schema: typeof CODING_INTELLIGENCE_LEDGER_VERSION;
    generatedBy: "snipara-companion";
    contentModel: "structured_redacted_ledger";
  };
  prompt: CodingLedgerPrompt;
  repoState: CodingLedgerRepoState;
  servedContext: CodingLedgerEvidenceItem[];
  plans: CodingLedgerEvidenceItem[];
  diffs: CodingLedgerEvidenceItem[];
  tests: CodingLedgerEvidenceItem[];
  ci: CodingLedgerEvidenceItem[];
  reviews: CodingLedgerEvidenceItem[];
  outcomes: CodingLedgerEvidenceItem[];
  influenceReceipts: CodingLedgerEvidenceItem[];
  reasonCodes: string[];
  confidence: CodingLedgerConfidence;
  calibrationMetadata: CodingLedgerCalibrationMetadata;
  redaction: CodingLedgerRedactionSummary;
  caveats: string[];
}

export interface CodingLedgerBuildOptions {
  input?: unknown;
  fromFile?: string;
  dir?: string;
  now?: Date;
  task?: string;
  prompt?: string;
  sourceRef?: string;
  branch?: string;
  commit?: string;
  changedFiles?: string[];
  recentFiles?: string[];
  diffSummary?: string;
  servedContext?: string[];
  plan?: string[];
  diff?: string[];
  test?: string[];
  ci?: string[];
  review?: string[];
  outcome?: string[];
  influenceReceipt?: string[];
  reasonCode?: string[];
  confidence?: string;
  calibration?: string[];
}

export interface CodingLedgerExportCommandOptions extends CodingLedgerBuildOptions {
  output?: string;
  json?: boolean;
}

interface RedactedText {
  value: string;
  patterns: string[];
}

interface Redactor {
  redact(value: string): RedactedText;
  summary(): CodingLedgerRedactionSummary;
}

const MAX_SECTION_ITEMS = 24;
const MAX_LIST_ITEMS = 20;
const MAX_TEXT_LENGTH = 900;

const SECTION_INPUT_KEYS: Record<CodingLedgerSectionName, string[]> = {
  served_context: ["servedContext", "served_context", "context", "contexts"],
  plans: ["plans", "plan"],
  diffs: ["diffs", "diff", "changes"],
  tests: ["tests", "test", "verification"],
  ci: ["ci", "checks", "builds"],
  reviews: ["reviews", "review"],
  outcomes: ["outcomes", "outcome"],
  influence_receipts: ["influenceReceipts", "influence_receipts", "advisorReceipts", "receipts"],
};

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "secret_assignment",
    pattern:
      /\b(api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;]+/gi,
  },
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    name: "snipara_key",
    pattern: /\bsnp[-_][A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    name: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    name: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRedactor(rootDir: string): Redactor {
  const patterns = new Set<string>();
  let redactedValueCount = 0;
  const repoPath = path.resolve(rootDir);

  function redact(value: string): RedactedText {
    let result = truncateText(String(value ?? ""));
    const matchedPatterns: string[] = [];

    if (repoPath && result.includes(repoPath)) {
      result = result.split(repoPath).join("<repo>");
      matchedPatterns.push("local_repo_path");
      patterns.add("local_repo_path");
    }

    for (const item of SECRET_PATTERNS) {
      item.pattern.lastIndex = 0;
      if (!item.pattern.test(result)) {
        item.pattern.lastIndex = 0;
        continue;
      }
      item.pattern.lastIndex = 0;
      result = result.replace(item.pattern, (match) => {
        const prefix = match.match(/^([^:=\s]+)\s*[:=]/)?.[1]?.trim();
        return prefix ? `${prefix}=<redacted>` : "<redacted>";
      });
      matchedPatterns.push(item.name);
      patterns.add(item.name);
      item.pattern.lastIndex = 0;
    }

    const uniqueMatchedPatterns = uniqueStrings(matchedPatterns);
    if (uniqueMatchedPatterns.length > 0) {
      redactedValueCount += 1;
    }

    return {
      value: compactWhitespace(result),
      patterns: uniqueMatchedPatterns,
    };
  }

  return {
    redact,
    summary() {
      const patternList = Array.from(patterns).sort();
      return {
        redacted: patternList.length > 0,
        redactedValueCount,
        patterns: patternList,
      };
    },
  };
}

export function buildCodingIntelligenceLedger(
  options: CodingLedgerBuildOptions = {}
): CodingIntelligenceLedger {
  const rootDir = path.resolve(options.dir ?? process.cwd());
  const input = mergeInputs(readInputFile(options.fromFile, rootDir), options.input);
  const redactor = createRedactor(rootDir);
  const prompt = buildPrompt(input, options, redactor);
  const repoState = buildRepoState(input, options, rootDir, redactor);
  const servedContext = buildSection(input, options.servedContext, "served_context", redactor);
  const plans = buildSection(input, options.plan, "plans", redactor);
  const diffs = buildSection(input, options.diff, "diffs", redactor);
  const tests = buildSection(input, options.test, "tests", redactor);
  const ci = buildSection(input, options.ci, "ci", redactor);
  const reviews = buildSection(input, options.review, "reviews", redactor);
  const outcomes = buildSection(input, options.outcome, "outcomes", redactor);
  const influenceReceipts = buildSection(
    input,
    options.influenceReceipt,
    "influence_receipts",
    redactor
  );
  const reasonCodes = collectReasonCodes(
    input,
    options.reasonCode,
    [servedContext, plans, diffs, tests, ci, reviews, outcomes, influenceReceipts].flat(),
    redactor
  );
  const confidence = buildConfidence(input, options.confidence, redactor);
  const calibrationMetadata = buildCalibrationMetadata(input, options.calibration, redactor);

  return {
    version: CODING_INTELLIGENCE_LEDGER_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    portability: {
      format: "json",
      schema: CODING_INTELLIGENCE_LEDGER_VERSION,
      generatedBy: "snipara-companion",
      contentModel: "structured_redacted_ledger",
    },
    prompt,
    repoState,
    servedContext,
    plans,
    diffs,
    tests,
    ci,
    reviews,
    outcomes,
    influenceReceipts,
    reasonCodes,
    confidence,
    calibrationMetadata,
    redaction: redactor.summary(),
    caveats: [
      "This ledger is a structured export for review and replay; it is not approved memory, causal proof, or a raw transcript.",
      "Secret-like fragments and local repository paths are redacted before output.",
      "Sections are bounded; source references should be used to retrieve full evidence when needed.",
      "Outcome and calibration fields describe observed association only, not causal impact.",
    ],
  };
}

export async function codingLedgerExportCommand(
  options: CodingLedgerExportCommandOptions
): Promise<void> {
  const ledger = buildCodingIntelligenceLedger(options);
  const content = JSON.stringify(ledger, null, 2);

  if (options.output) {
    const absolute = path.resolve(options.dir ?? process.cwd(), options.output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${content}\n`, "utf8");
    if (!options.json) {
      console.log(`Wrote coding intelligence ledger: ${absolute}`);
      return;
    }
  }

  console.log(content);
}

function buildPrompt(
  input: Record<string, unknown>,
  options: CodingLedgerBuildOptions,
  redactor: Redactor
): CodingLedgerPrompt {
  const promptInput = inputRecord(input, "prompt");
  return removeUndefined({
    task: redactOptional(
      options.task ?? stringValue(input.task) ?? stringValue(promptInput.task),
      redactor
    ),
    prompt: redactOptional(
      options.prompt ?? stringValue(input.prompt) ?? stringValue(promptInput.prompt),
      redactor
    ),
    sourceRef: redactOptional(
      options.sourceRef ??
        stringValue(input.sourceRef) ??
        stringValue(input.source_ref) ??
        stringValue(promptInput.sourceRef),
      redactor
    ),
  });
}

function buildRepoState(
  input: Record<string, unknown>,
  options: CodingLedgerBuildOptions,
  rootDir: string,
  redactor: Redactor
): CodingLedgerRepoState {
  const inputRepo = inputRecord(input, "repoState", "repo_state", "repo");
  const detected = detectGitState(rootDir);
  const statusCounts = countGitStatus(detected.statusLines);
  const changedFiles = uniqueStrings([
    ...normalizeUnknownStringList(inputRepo.changedFiles),
    ...normalizeUnknownStringList(inputRepo.changed_files),
    ...normalizeUnknownStringList(input.changedFiles),
    ...normalizeUnknownStringList(input.changed_files),
    ...(options.changedFiles ?? []),
  ]).map((item) => redactor.redact(item).value);
  const recentFiles = uniqueStrings([
    ...normalizeUnknownStringList(inputRepo.recentFiles),
    ...normalizeUnknownStringList(inputRepo.recent_files),
    ...normalizeUnknownStringList(input.recentFiles),
    ...normalizeUnknownStringList(input.recent_files),
    ...(options.recentFiles ?? []),
  ]).map((item) => redactor.redact(item).value);

  return removeUndefined({
    branch: redactOptional(
      options.branch ??
        stringValue(inputRepo.branch) ??
        stringValue(input.branch) ??
        detected.branch,
      redactor
    ),
    commit: redactOptional(
      options.commit ??
        stringValue(inputRepo.commit) ??
        stringValue(input.commit) ??
        detected.commit,
      redactor
    ),
    dirty:
      booleanValue(inputRepo.dirty) ??
      booleanValue(input.dirty) ??
      (detected.statusLines ? detected.statusLines.length > 0 : undefined),
    stagedFileCount: numberValue(inputRepo.stagedFileCount) ?? statusCounts.stagedFileCount,
    unstagedFileCount: numberValue(inputRepo.unstagedFileCount) ?? statusCounts.unstagedFileCount,
    changedFiles,
    recentFiles,
    diffSummary: redactOptional(
      options.diffSummary ??
        stringValue(inputRepo.diffSummary) ??
        stringValue(inputRepo.diff_summary) ??
        stringValue(input.diffSummary) ??
        stringValue(input.diff_summary),
      redactor
    ),
  });
}

function buildSection(
  input: Record<string, unknown>,
  cliValues: string[] | undefined,
  section: CodingLedgerSectionName,
  redactor: Redactor
): CodingLedgerEvidenceItem[] {
  const inputValues = SECTION_INPUT_KEYS[section].flatMap((key) =>
    normalizeSectionInput(input[key])
  );
  const cliItems = (cliValues ?? []).map((value) => ({ summary: value }));
  return [...inputValues, ...cliItems]
    .slice(0, MAX_SECTION_ITEMS)
    .map((value, index) => normalizeEvidenceItem(value, section, index, redactor));
}

function normalizeEvidenceItem(
  value: unknown,
  section: CodingLedgerSectionName,
  index: number,
  redactor: Redactor
): CodingLedgerEvidenceItem {
  if (!isRecord(value)) {
    const summary = redactor.redact(stringValue(value) ?? `${section} item ${index + 1}`).value;
    return {
      id: itemId(section, index, summary),
      kind: section,
      summary,
      reasonCodes: [`section_${section}`],
      files: [],
      commands: [],
    };
  }

  const title = firstString(value, ["title", "name", "label", "id"]);
  const sourceRef = firstString(value, [
    "sourceRef",
    "source_ref",
    "ref",
    "source",
    "url",
    "commit",
    "phaseId",
    "phase_id",
  ]);
  const status = firstString(value, ["status", "result", "outcomeStatus", "outcome_status"]);
  const summary =
    firstString(value, [
      "summary",
      "text",
      "description",
      "content",
      "rationale",
      "outcome",
      "command",
      "check",
    ]) ?? fallbackSummary(value, section, index);
  const reasonCodes = uniqueStrings([
    `section_${section}`,
    ...normalizeUnknownStringList(value.reasonCodes),
    ...normalizeUnknownStringList(value.reason_codes),
  ]).map((item) => redactor.redact(item).value);
  const files = uniqueStrings([
    ...normalizeUnknownStringList(value.files),
    ...normalizeUnknownStringList(value.changedFiles),
    ...normalizeUnknownStringList(value.changed_files),
    ...normalizeUnknownStringList(value.file),
  ])
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => redactor.redact(item).value);
  const commands = uniqueStrings([
    ...normalizeUnknownStringList(value.commands),
    ...normalizeUnknownStringList(value.command),
    ...normalizeUnknownStringList(value.checks),
    ...normalizeUnknownStringList(value.check),
  ])
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => redactor.redact(item).value);
  const redactedSummary = redactor.redact(summary).value;

  return removeUndefined({
    id:
      redactOptional(firstString(value, ["id"]), redactor) ??
      itemId(section, index, redactedSummary),
    kind: section,
    title: redactOptional(title, redactor),
    summary: redactedSummary,
    sourceRef: redactOptional(sourceRef, redactor),
    status: redactOptional(status, redactor),
    confidence: numberValue(value.confidence) ?? numberValue(value.score),
    reasonCodes,
    files,
    commands,
    observedAt: validIso(
      firstString(value, ["observedAt", "observed_at", "createdAt", "created_at"])
    ),
  });
}

function collectReasonCodes(
  input: Record<string, unknown>,
  cliValues: string[] | undefined,
  items: CodingLedgerEvidenceItem[],
  redactor: Redactor
): string[] {
  return uniqueStrings([
    "coding_intelligence_ledger_v0",
    ...normalizeUnknownStringList(input.reasonCodes),
    ...normalizeUnknownStringList(input.reason_codes),
    ...(cliValues ?? []),
    ...items.flatMap((item) => item.reasonCodes),
  ])
    .slice(0, 50)
    .map((item) => redactor.redact(item).value);
}

function buildConfidence(
  input: Record<string, unknown>,
  cliValue: string | undefined,
  redactor: Redactor
): CodingLedgerConfidence {
  const confidenceInput = inputRecord(input, "confidence");
  const parsedCliScore = parseNumber(cliValue);
  const inputScore =
    numberValue(confidenceInput.score) ??
    numberValue(confidenceInput.value) ??
    numberValue(input.confidenceScore) ??
    numberValue(input.confidence_score);
  const score = clampScore(parsedCliScore ?? inputScore);
  const inputBand =
    parseBand(cliValue) ??
    parseBand(stringValue(confidenceInput.band)) ??
    parseBand(stringValue(input.confidenceBand));
  const band = inputBand ?? bandForScore(score);
  return removeUndefined({
    score,
    band,
    rationale: redactOptional(
      stringValue(confidenceInput.rationale) ??
        stringValue(confidenceInput.reason) ??
        stringValue(input.confidenceRationale) ??
        stringValue(input.confidence_rationale),
      redactor
    ),
  });
}

function buildCalibrationMetadata(
  input: Record<string, unknown>,
  cliValues: string[] | undefined,
  redactor: Redactor
): CodingLedgerCalibrationMetadata {
  const calibration = inputRecord(
    input,
    "calibrationMetadata",
    "calibration",
    "calibration_metadata"
  );
  const notes = uniqueStrings([
    ...normalizeUnknownStringList(calibration.notes),
    ...normalizeUnknownStringList(calibration.note),
    ...normalizeUnknownStringList(input.calibrationNotes),
    ...(cliValues ?? []),
  ])
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => redactor.redact(item).value);
  const caveats = uniqueStrings([
    ...normalizeUnknownStringList(calibration.caveats),
    ...normalizeUnknownStringList(calibration.caveat),
    ...normalizeUnknownStringList(input.calibrationCaveats),
  ])
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => redactor.redact(item).value);

  return removeUndefined({
    sampleSize:
      numberValue(calibration.sampleSize) ??
      numberValue(calibration.sample_size) ??
      numberValue(input.sampleSize),
    reliability:
      clampScore(numberValue(calibration.reliability) ?? numberValue(input.reliability)) ??
      undefined,
    status: redactOptional(
      stringValue(calibration.status) ?? stringValue(input.calibrationStatus),
      redactor
    ),
    notes,
    caveats,
  });
}

function readInputFile(filePath: string | undefined, rootDir: string): Record<string, unknown> {
  if (!filePath) {
    return {};
  }
  const absolute = path.resolve(rootDir, filePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("coding ledger --from-file must contain a JSON object.");
  }
  if (isRecord(parsed.ledger)) {
    return parsed.ledger;
  }
  if (isRecord(parsed.codingIntelligenceLedger)) {
    return parsed.codingIntelligenceLedger;
  }
  return parsed;
}

function mergeInputs(
  fileInput: Record<string, unknown>,
  explicitInput: unknown
): Record<string, unknown> {
  if (!isRecord(explicitInput)) {
    return fileInput;
  }
  return {
    ...fileInput,
    ...explicitInput,
  };
}

function detectGitState(rootDir: string): {
  branch?: string;
  commit?: string;
  statusLines?: string[];
} {
  return {
    branch: gitOutput(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitOutput(rootDir, ["rev-parse", "--short=12", "HEAD"]),
    statusLines: gitOutput(rootDir, ["status", "--short"])
      ?.split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean),
  };
}

function gitOutput(rootDir: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function countGitStatus(statusLines: string[] | undefined): {
  stagedFileCount?: number;
  unstagedFileCount?: number;
} {
  if (!statusLines) {
    return {};
  }
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  for (const line of statusLines) {
    if (line[0] && line[0] !== " " && line[0] !== "?") {
      stagedFileCount += 1;
    }
    if (line[1] && line[1] !== " ") {
      unstagedFileCount += 1;
    }
    if (line.startsWith("??")) {
      unstagedFileCount += 1;
    }
  }
  return { stagedFileCount, unstagedFileCount };
}

function inputRecord(input: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    if (isRecord(input[key])) {
      return input[key];
    }
  }
  return {};
}

function normalizeSectionInput(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeUnknownStringList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeUnknownStringList(item)).slice(0, MAX_LIST_ITEMS);
  }
  return String(value)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function fallbackSummary(
  record: Record<string, unknown>,
  section: CodingLedgerSectionName,
  index: number
): string {
  const status = firstString(record, ["status", "result"]);
  const sourceRef = firstString(record, ["sourceRef", "source_ref", "ref"]);
  const pieces = [
    status ? `status ${status}` : undefined,
    sourceRef ? `source ${sourceRef}` : undefined,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join("; ") : `${section} item ${index + 1}`;
}

function itemId(section: CodingLedgerSectionName, index: number, value: string): string {
  return `${section}:${stableHash([section, String(index), value]).slice(0, 16)}`;
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = parseNumber(value);
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function parseBand(value: string | undefined): CodingLedgerConfidenceBand | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return undefined;
}

function bandForScore(score: number | undefined): CodingLedgerConfidenceBand {
  if (score === undefined) {
    return "unknown";
  }
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.5) {
    return "medium";
  }
  return "low";
}

function clampScore(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = value > 1 ? value / 100 : value;
  return Number(Math.min(1, Math.max(0, normalized)).toFixed(3));
}

function redactOptional(value: string | undefined, redactor: Redactor): string | undefined {
  return value ? redactor.redact(value).value : undefined;
}

function validIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, limit = MAX_TEXT_LENGTH): string {
  const normalized = String(value ?? "");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 16)).trimEnd()} ... [truncated]`;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
