/**
 * `code` commands — local code graph overlay + optional hosted bridge.
 *
 * Builds a local code overlay (files, symbols, imports) over the working tree
 * or a local commit and answers structural queries offline: impact, callers,
 * imports, neighbors, and shortest path. Also installs Git hooks, serves a
 * small MCP, and promotes/uploads the overlay to the hosted Cloud code graph.
 * Local results are first-class for the current checkout; hosted graph queries
 * are opt-in when team, cross-machine, or cloud-indexed context is needed.
 */
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import type { AddressInfo } from "net";
import path from "path";
import chalk from "chalk";
import ts from "typescript";
import { createClient } from "../api/client";
import { findWorkspaceRoot, isConfigured, loadConfig } from "../config/store";
import { emitCanonicalEvent } from "./events";

export type LocalCodeOverlayMode = "working_tree" | "local_commit";
export type LocalCodeOverlayKind = "none" | "local_commit" | "working_tree" | "mixed";

export interface LocalCodeOverlayOptions {
  cwd?: string;
  mode?: LocalCodeOverlayMode;
  commit?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface LocalCodeOverlayFile {
  path: string;
  language: "typescript" | "python" | "go";
  sizeBytes: number;
  sha256: string;
  symbolCount: number;
  importCount: number;
  referenceCount: number;
  edgeCount: number;
}

export interface LocalCodeOverlaySymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  filePath: string;
  line: number;
  endLine?: number;
  qualifiedName: string;
  localKey: string;
  exported?: boolean;
  defaultExport?: boolean;
}

export type LocalSemanticPredicate =
  | "public_api"
  | "implicit_contract"
  | "architecture_role"
  | "dependency_criticality";

export interface LocalSemanticEvidence {
  kind: string;
  detail: string;
  filePath?: string;
  line?: number;
  edgeKind?: LocalCodeOverlayEdge["kind"];
}

export interface LocalSemanticAssertion {
  id: string;
  subject: string;
  predicate: LocalSemanticPredicate;
  value: string | boolean;
  confidence: number;
  scoreKind: "heuristic_prior";
  calibrated: false;
  source:
    | "typescript-compiler-api"
    | "language-parser"
    | "architecture-pattern-rules"
    | "criticality-rules"
    | "graph-criticality-rules";
  extractorVersion: 1;
  evidence: LocalSemanticEvidence[];
}

export interface LocalSemanticModel {
  version: "snipara.semantic.v1";
  extractorVersion: 1;
  source: "deterministic-graph-inference";
  modelType: "rule-based-heuristic";
  scoreContract: {
    kind: "heuristic_prior";
    calibrated: false;
    probability: false;
    comparableAcrossProjects: false;
    basis: "hand-tuned-v1";
    rulesetVersion: 1;
    interpretation: string;
  };
  ruleConfig: {
    version: "snipara.semantic.rules.v1";
    source: "defaults" | "project-file";
    path: ".snipara/semantic-rules.json";
    replaceDefaults: boolean;
    sensitivePathTermCount: number;
    contractPathTermCount: number;
    testPathTermCount: number;
    architectureRoleTermCount: number;
    configuredRoles: string[];
    configHash: string;
    warnings: string[];
  };
  scope: "repository" | "impact";
  assertions: LocalSemanticAssertion[];
  publicContracts: LocalSemanticAssertion[];
  architectureRoles: LocalSemanticAssertion[];
  dependencyCriticality: LocalSemanticAssertion[];
  truncation: {
    truncated: boolean;
    totalAssertionCount: number;
    returnedAssertionCount: number;
    assertionLimit: number;
  };
  historicalRegression: {
    mode: "shadow";
    sampleThreshold: 3;
    failureEventCount: 0;
    associations: [];
    riskContributionEnabled: false;
    suggestedRiskDelta: 0;
    caveat: string;
  };
  summary: {
    assertionCount: number;
    publicContractCount: number;
    architectureRoleCount: number;
    criticalDependencyCount: number;
    criticalEdgeCount: number;
    incidentalDependencyCount: number;
    historicalAssociationCount: 0;
  };
  caveats: string[];
}

export interface LocalCodeOverlayImportBinding {
  localName: string;
  importedName: string;
  kind: "named" | "default" | "namespace";
}

export interface LocalCodeOverlayImport {
  filePath: string;
  specifier: string;
  line: number;
  bindings?: LocalCodeOverlayImportBinding[];
}

export interface LocalCodeOverlayReference {
  filePath: string;
  from: string;
  name: string;
  kind: "CALLS" | "REFERENCES";
  line: number;
  confidence: number;
}

export interface LocalCodeOverlayEdge {
  from: string;
  to: string;
  kind: "IMPORTS" | "CALLS" | "REFERENCES" | "CONTAINS";
  filePath: string;
  line: number;
  confidence: number;
  source: "typescript-compiler-api" | "language-parser" | "import-resolver";
  evidence: {
    filePath: string;
    line: number;
  };
}

export interface LocalCodeOverlayWarning {
  code: string;
  severity: "info" | "warning";
  message: string;
  [key: string]: unknown;
}

export interface LocalCodeOverlayExcludedFile {
  path: string;
  reason: "ignored" | "unsupported_language" | "too_large" | "secret_pattern" | "read_error";
  line?: number;
}

export interface LocalCodeOverlayManifest {
  version: "snipara.local_code_overlay.v2";
  extractorVersion: 2 | 3;
  generatedAt: string;
  indexedAt: string;
  repoRoot: string;
  repositoryId: string;
  branch: string | null;
  baseSha: string | null;
  localHeadSha: string | null;
  commit: string | null;
  dirtyTreeHash: string | null;
  overlayKind: LocalCodeOverlayKind;
  canonicalIndexedSha: null;
  currentWorkingTreeVisible: boolean;
  canonical: false;
  mode: LocalCodeOverlayMode;
  files: LocalCodeOverlayFile[];
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
  references: LocalCodeOverlayReference[];
  edges: LocalCodeOverlayEdge[];
  semantic?: LocalSemanticModel;
  incremental: {
    reusedFiles: number;
    parsedFiles: number;
    deletedFiles: number;
  };
  excluded: {
    total: number;
    byReason: Record<LocalCodeOverlayExcludedFile["reason"], number>;
    samples: LocalCodeOverlayExcludedFile[];
  };
  warnings: LocalCodeOverlayWarning[];
}

export interface CodeStatusCommandOptions {
  dir?: string;
  maxFiles?: number;
  includeGraph?: boolean;
  json?: boolean;
}

export interface CodeSyncCommandOptions extends CodeStatusCommandOptions {
  commit?: string;
  workingTree?: boolean;
  onlyIfHead?: string;
}

export interface CodeUploadCommandOptions extends CodeStatusCommandOptions {
  cached?: boolean;
  ttlHours?: number;
  sourceClient?: string;
  sessionId?: string;
  retirePrevious?: boolean;
}

export interface LocalCodeQueryCommandOptions extends CodeStatusCommandOptions {
  cached?: boolean;
  mode?: LocalCodeOverlayMode;
  commit?: string;
  qualifiedName?: string;
  symbolKey?: string;
  filePath?: string;
  changedFiles?: string[];
  from?: string;
  to?: string;
  maxHops?: number;
  depth?: number;
  direction?: "in" | "out" | "both";
  edgeKinds?: string[];
  maxNodes?: number;
  transitive?: boolean;
}

export type CodeGraphSource = "auto" | "hosted" | "local" | "hybrid";
export type ResolvedCodeGraphSource = "hosted_graph" | "local_overlay" | "hybrid_graph";
export type CodeGraphVerb = "callers" | "imports" | "neighbors" | "shortest-path" | "impact";

export interface CodeGraphAutoSourceOptions extends LocalCodeQueryCommandOptions {
  source?: CodeGraphSource;
  fallbackHosted?: boolean;
  includeFileNodes?: boolean;
  diffSummary?: string;
  limit?: number;
}

export interface CodeGraphSourceSelection {
  requested: CodeGraphSource;
  selected: ResolvedCodeGraphSource;
  reason: string;
  guidance: string[];
  repositoryId: string;
  branch: string | null;
  localHeadSha: string | null;
  baseSha: string | null;
  aheadCount: number | null;
  dirtyFileCount: number;
  dirtyFilesSample: string[];
  localOverlay?: {
    indexedAt: string;
    overlayKind: LocalCodeOverlayKind;
    dirtyTreeHash: string | null;
    currentWorkingTreeVisible: boolean;
    fileCount: number;
    symbolCount: number;
    importCount: number;
    edgeCount: number;
    warnings: LocalCodeOverlayManifest["warnings"];
  };
  hosted?: {
    configured: boolean;
    indexFreshness?: unknown;
    contextScope?: unknown;
    error?: string;
  };
  limitations: string[];
}

export interface CodeGraphAutoSourceResult {
  title: string;
  sourceSelection: CodeGraphSourceSelection;
  result: unknown;
}

export type LocalCodeServeTransport = "http" | "mcp-stdio";

export interface CodeServeCommandOptions extends CodeStatusCommandOptions {
  transport?: LocalCodeServeTransport;
  host?: string;
  port?: number;
  cached?: boolean;
  readyFile?: string;
  allowOrigin?: string;
}

export interface CodeHooksInstallCommandOptions {
  dir?: string;
  maxFiles?: number;
  requestReindex?: boolean;
  reindexDelaySeconds?: number;
  synchronous?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface CodePromoteCommandOptions extends CodeStatusCommandOptions {
  pushedSha?: string;
  indexedSha?: string;
  requestReindex?: boolean;
  fromHook?: "pre-push";
  strict?: boolean;
}

export interface LocalCodePromotionState {
  version: "snipara.local_code_promotion.v1";
  updatedAt: string;
  repoRoot: string;
  repositoryId: string;
  branch: string | null;
  pushedSha: string | null;
  localHeadSha: string | null;
  indexedSha: string | null;
  overlayCachePath: string;
  status:
    | "local_commit_cached"
    | "reindex_requested"
    | "reindex_skipped_unconfigured"
    | "reindex_failed"
    | "superseded_by_hosted_index";
  canonical: false;
  hostedCanonicalVisible: boolean;
  reindexRequestedAt: string | null;
  reindexResult?: Record<string, unknown>;
  warnings: LocalCodeOverlayManifest["warnings"];
}

export interface LocalCodeOverlaySummary {
  version: LocalCodeOverlayManifest["version"];
  generatedAt: string;
  indexedAt: string;
  repoRoot: string;
  repositoryId: string;
  branch: string | null;
  baseSha: string | null;
  localHeadSha: string | null;
  commit: string | null;
  dirtyTreeHash: string | null;
  overlayKind: LocalCodeOverlayKind;
  canonicalIndexedSha: null;
  currentWorkingTreeVisible: boolean;
  canonical: false;
  mode: LocalCodeOverlayMode;
  counts: {
    files: number;
    symbols: number;
    imports: number;
    references: number;
    edges: number;
    semanticAssertions: number;
    excluded: number;
  };
  incremental: LocalCodeOverlayManifest["incremental"];
  excludedByReason: Record<LocalCodeOverlayExcludedFile["reason"], number>;
  fileSamples: string[];
  warnings: LocalCodeOverlayManifest["warnings"];
}

export interface HostedCodeOverlayUploadPayload {
  manifest: LocalCodeOverlayManifest;
  cachePath: string;
  request: {
    overlay: LocalCodeOverlayManifest;
    source_client: string;
    ttl_hours: number;
    retire_previous: boolean;
    session_id?: string;
  };
}

const SUPPORTED_EXTENSIONS = new Map<string, LocalCodeOverlayFile["language"]>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
]);

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_HOSTED_OVERLAY_TTL_HOURS = 48;
const MAX_HOSTED_OVERLAY_TTL_HOURS = 168;
const DEFAULT_HOOK_REINDEX_DELAY_SECONDS = 5;
const CACHE_RELATIVE_PATH = path.join(".snipara", "code-overlay", "latest.json");
const PROMOTION_RELATIVE_PATH = path.join(".snipara", "code-overlay", "promotion.json");
const HOOK_BLOCK_PREFIX = "snipara:code-overlay";
const DEFAULT_EXCLUDED_PREFIXES = [
  ".git/",
  ".snipara/code-overlay/",
  ".snipara/source/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  "coverage/",
];
const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".snipara",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  ".idea",
  ".vscode",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "venv",
]);

const SECRET_PATTERNS = [/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/];

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\b\s*[:=]\s*(?:"([^"\s]{20,})"|'([^'\s]{20,})'|([A-Za-z0-9][A-Za-z0-9_+=/-]{19,}))/i;

const SAFE_SECRET_VALUE_PREFIXES = [
  "process.env",
  "${",
  "<",
  "your_",
  "example",
  "placeholder",
  "dummy",
  "test_",
  "redacted",
  "null",
  "undefined",
];

interface SecretPatternFinding {
  line: number;
  reason: "private_key" | "secret_assignment";
}

interface SecretRedactionSample {
  path: string;
  findings: SecretPatternFinding[];
}

interface SecretWarningSample {
  path: string;
  lines: number[];
  reasons: string[];
}

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\/+/, "");
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string | Buffer): string {
  return sha256(value).slice(0, 16);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function positiveInteger(value: number | undefined, fallback: number, label = "value"): number {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  throw new Error(`${label} must be a positive integer.`);
}

function traversalDirection(
  value: LocalCodeQueryCommandOptions["direction"],
  fallback: "in" | "out" | "both" = "both"
): "in" | "out" | "both" {
  if (value === undefined) return fallback;
  if (value === "in" || value === "out" || value === "both") return value;
  throw new Error("--direction must be one of: in, out, both");
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : fallback;
}

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function runGitBuffer(args: string[], cwd: string): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function splitNul(buffer: Buffer | null): string[] {
  if (!buffer || buffer.length === 0) {
    return [];
  }
  return buffer
    .toString("utf8")
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveRepoRoot(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], resolvedCwd);
  if (gitRoot) {
    return path.resolve(gitRoot);
  }
  return findWorkspaceRoot(resolvedCwd, true) ?? resolvedCwd;
}

function readRemoteRepositoryId(repoRoot: string): string {
  const remoteUrl = runGit(["config", "--get", "remote.origin.url"], repoRoot);
  if (remoteUrl) {
    const match = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }
  return path.basename(repoRoot);
}

function readBranch(repoRoot: string): string | null {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
}

function readHeadSha(repoRoot: string): string | null {
  return runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
}

function readBaseSha(repoRoot: string, branch: string | null): string | null {
  const upstream = runGit(["rev-parse", "--verify", "@{u}"], repoRoot);
  if (upstream) {
    return upstream;
  }
  if (branch) {
    return runGit(["rev-parse", "--verify", `origin/${branch}`], repoRoot);
  }
  return null;
}

function readGitStatus(repoRoot: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}

function readAheadCount(repoRoot: string): number | null {
  const upstream = runGit(["rev-parse", "--verify", "@{u}"], repoRoot);
  if (!upstream) {
    return null;
  }
  const count = runGit(["rev-list", "--count", "@{u}..HEAD"], repoRoot);
  return count ? parseInt(count, 10) : null;
}

function parseDirtyFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const renamed = line.match(/^.. (.+) -> (.+)$/);
      if (renamed) {
        return normalizeRepoPath(renamed[2]);
      }
      return normalizeRepoPath(line.slice(3).trim());
    })
    .filter(Boolean);
}

function languageForFile(filePath: string): LocalCodeOverlayFile["language"] | null {
  return SUPPORTED_EXTENSIONS.get(path.extname(filePath)) ?? null;
}

function readSniparaIgnore(repoRoot: string): string[] {
  const ignorePath = path.join(repoRoot, ".sniparaignore");
  if (!fs.existsSync(ignorePath)) {
    return [];
  }
  try {
    return fs
      .readFileSync(ignorePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.endsWith("/")) {
    return filePath.startsWith(normalizedPattern);
  }
  if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
    return globToRegex(normalizedPattern).test(filePath);
  }
  return filePath === normalizedPattern || filePath.startsWith(`${normalizedPattern}/`);
}

function isIgnored(filePath: string, sniparaIgnore: string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (DEFAULT_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return sniparaIgnore.some((pattern) => matchesIgnorePattern(normalized, pattern));
}

function shouldSkipFilesystemDirectory(relativePath: string, sniparaIgnore: string[]): boolean {
  const normalized = normalizeRepoPath(relativePath);
  if (!normalized) {
    return false;
  }
  if (DEFAULT_EXCLUDED_DIR_NAMES.has(path.basename(normalized))) {
    return true;
  }
  return isIgnored(`${normalized}/`, sniparaIgnore);
}

function findUnsafeSecretAssignment(line: string): { value: string } | null {
  const match = line.match(SECRET_ASSIGNMENT_PATTERN);
  if (!match) {
    return null;
  }
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  const normalized = value.trim().toLowerCase();
  if (SAFE_SECRET_VALUE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return null;
  }
  return { value };
}

function redactSecretLikeContentForOverlay(content: string): {
  content: string;
  findings: SecretPatternFinding[];
} {
  const findings: SecretPatternFinding[] = [];
  const lines = content.split(/\r?\n/);
  const redactedLines = lines.map((line, index) => {
    const lineNumber = index + 1;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push({ line: lineNumber, reason: "private_key" });
      return "[SNIPARA_REDACTED_SECRET_LIKE_LINE]";
    }

    const assignment = findUnsafeSecretAssignment(line);
    if (!assignment) {
      return line;
    }

    findings.push({ line: lineNumber, reason: "secret_assignment" });
    return line.replace(assignment.value, "[SNIPARA_REDACTED_SECRET]");
  });

  return {
    content: redactedLines.join("\n"),
    findings,
  };
}

function formatSecretWarningMessage(samples: SecretWarningSample[]): string {
  const displayed = samples.slice(0, 5).map((sample) => {
    const lines = sample.lines.slice(0, 5).join(",");
    const suffix = sample.lines.length > 5 ? ",..." : "";
    return `${sample.path}:${lines}${suffix}`;
  });
  const more =
    samples.length > displayed.length ? `; ${samples.length - displayed.length} more` : "";
  return (
    "Secret-like lines were redacted before local graph extraction; files remain visible to impact. " +
    `Samples: ${displayed.join("; ")}${more}.`
  );
}

function toSecretWarningSamples(samples: SecretRedactionSample[]): SecretWarningSample[] {
  return samples.map((sample) => ({
    path: sample.path,
    lines: sample.findings.map((finding) => finding.line),
    reasons: [...new Set(sample.findings.map((finding) => finding.reason))],
  }));
}

function formatSecretRedactionWarning(samples: SecretRedactionSample[]): LocalCodeOverlayWarning {
  const warningSamples = toSecretWarningSamples(samples);
  return {
    code: "secret_like_lines_redacted",
    severity: "warning",
    message: formatSecretWarningMessage(warningSamples),
    samples: warningSamples,
  };
}

function listWorkingTreeFiles(repoRoot: string): string[] {
  const files = splitNul(runGitBuffer(["ls-files", "-co", "--exclude-standard", "-z"], repoRoot));
  if (files.length > 0) {
    return [...new Set(files.map(normalizeRepoPath))].sort();
  }

  const sniparaIgnore = readSniparaIgnore(repoRoot);
  const scanned: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRepoPath(path.relative(repoRoot, absolutePath));
      if (!relativePath) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!shouldSkipFilesystemDirectory(relativePath, sniparaIgnore)) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scanned.push(relativePath);
    }
  }

  return [...new Set(scanned)].sort();
}

function listCommitFiles(repoRoot: string, commit: string): string[] {
  const files = splitNul(runGitBuffer(["ls-tree", "-r", "--name-only", "-z", commit], repoRoot));
  return [...new Set(files.map(normalizeRepoPath))].sort();
}

function readFileContent(
  repoRoot: string,
  filePath: string,
  mode: LocalCodeOverlayMode,
  commit: string
): Buffer | null {
  if (mode === "local_commit") {
    return runGitBuffer(["show", `${commit}:${filePath}`], repoRoot);
  }
  try {
    return fs.readFileSync(path.join(repoRoot, filePath));
  } catch {
    return null;
  }
}

function lineNumberFromIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function buildSymbolKey(
  filePath: string,
  qualifiedName: string,
  kind: LocalCodeOverlaySymbol["kind"]
): string {
  return `local::${filePath}::${kind}::${qualifiedName}`;
}

function buildFileNodeKey(filePath: string): string {
  return `local-file::${filePath}`;
}

interface ExtractedLocalCode {
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
  references: LocalCodeOverlayReference[];
  edges: LocalCodeOverlayEdge[];
}

function typeScriptScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".mts")) return ts.ScriptKind.TS;
  if (filePath.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function typeScriptNodeName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return node.name.getText();
}

function typeScriptLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function typeScriptEndLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function typeScriptExportStatus(
  node: ts.Node,
  name: string,
  namedExports: Set<string>
): { exported: boolean; defaultExport: boolean } {
  let declaration: ts.Node = node;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    const statement = node.parent.parent;
    if (ts.isVariableStatement(statement)) declaration = statement;
  }
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  const exported =
    namedExports.has(name) ||
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const defaultExport =
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
  return { exported: Boolean(exported || defaultExport), defaultExport };
}

function extractTypeScript(content: string, filePath: string): ExtractedLocalCode {
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
  const references: LocalCodeOverlayReference[] = [];
  const edges: LocalCodeOverlayEdge[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    typeScriptScriptKind(filePath)
  );
  const namedExports = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        namedExports.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }

  const addSymbol = (
    node: ts.Node,
    name: string,
    kind: LocalCodeOverlaySymbol["kind"],
    ownerQualifiedName?: string,
    ownerKey?: string
  ): LocalCodeOverlaySymbol => {
    const qualifiedName = ownerQualifiedName ? `${ownerQualifiedName}.${name}` : name;
    const line = typeScriptLine(sourceFile, node);
    const exportStatus = ownerQualifiedName
      ? { exported: false, defaultExport: false }
      : typeScriptExportStatus(node, name, namedExports);
    const symbol: LocalCodeOverlaySymbol = {
      name,
      kind,
      filePath,
      line,
      endLine: typeScriptEndLine(sourceFile, node),
      qualifiedName,
      localKey: buildSymbolKey(filePath, qualifiedName, kind),
      exported: exportStatus.exported,
      defaultExport: exportStatus.defaultExport,
    };
    symbols.push(symbol);
    if (ownerKey) {
      edges.push({
        from: ownerKey,
        to: symbol.localKey,
        kind: "CONTAINS",
        filePath,
        line,
        confidence: 1,
        source: "typescript-compiler-api",
        evidence: { filePath, line },
      });
    }
    return symbol;
  };

  const addImport = (node: ts.ImportDeclaration | ts.ExportDeclaration): void => {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const bindings: LocalCodeOverlayImportBinding[] = [];
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.name) {
        bindings.push({
          localName: node.importClause.name.text,
          importedName: "default",
          kind: "default",
        });
      }
      const namedBindings = node.importClause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bindings.push({
          localName: namedBindings.name.text,
          importedName: "*",
          kind: "namespace",
        });
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          bindings.push({
            localName: element.name.text,
            importedName: element.propertyName?.text ?? element.name.text,
            kind: "named",
          });
        }
      }
    }
    imports.push({
      filePath,
      specifier: node.moduleSpecifier.text,
      line: typeScriptLine(sourceFile, node),
      bindings,
    });
  };

  const visit = (
    node: ts.Node,
    owner?: LocalCodeOverlaySymbol,
    ownerQualifiedName?: string
  ): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addImport(node);
      return;
    }

    let childOwner = owner;
    let childQualifiedName = ownerQualifiedName;
    if (ts.isFunctionDeclaration(node) && node.name) {
      childOwner = addSymbol(node, node.name.text, "function", ownerQualifiedName, owner?.localKey);
      childQualifiedName = childOwner.qualifiedName;
    } else if (ts.isClassDeclaration(node) && node.name) {
      childOwner = addSymbol(node, node.name.text, "class", ownerQualifiedName, owner?.localKey);
      childQualifiedName = childOwner.qualifiedName;
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node, node.name.text, "interface", ownerQualifiedName, owner?.localKey);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, node.name.text, "type", ownerQualifiedName, owner?.localKey);
    } else if (ts.isMethodDeclaration(node)) {
      const name = typeScriptNodeName(node);
      if (name) {
        childOwner = addSymbol(node, name, "method", ownerQualifiedName, owner?.localKey);
        childQualifiedName = childOwner.qualifiedName;
      }
    } else if (ts.isPropertyDeclaration(node)) {
      const name = typeScriptNodeName(node);
      if (
        name &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        childOwner = addSymbol(node, name, "method", ownerQualifiedName, owner?.localKey);
        childQualifiedName = childOwner.qualifiedName;
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const callable =
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
      const declarationStatement = node.parent?.parent;
      const topLevel =
        declarationStatement &&
        ts.isVariableStatement(declarationStatement) &&
        ts.isSourceFile(declarationStatement.parent);
      if (callable || topLevel) {
        childOwner = addSymbol(
          node,
          node.name.text,
          callable ? "function" : "variable",
          ownerQualifiedName,
          owner?.localKey
        );
        childQualifiedName = callable ? childOwner.qualifiedName : ownerQualifiedName;
      }
    }

    const referenceOwner = childOwner ?? owner;
    if (referenceOwner && ts.isCallExpression(node)) {
      references.push({
        filePath,
        from: referenceOwner.localKey,
        name: node.expression.getText(sourceFile),
        kind: "CALLS",
        line: typeScriptLine(sourceFile, node),
        confidence: 0.85,
      });
    } else if (referenceOwner && ts.isTypeReferenceNode(node)) {
      references.push({
        filePath,
        from: referenceOwner.localKey,
        name: node.typeName.getText(sourceFile),
        kind: "REFERENCES",
        line: typeScriptLine(sourceFile, node),
        confidence: 0.65,
      });
    }

    ts.forEachChild(node, (child) => visit(child, childOwner, childQualifiedName));
  };

  visit(sourceFile);
  return { symbols, imports, references, edges };
}

function extractPython(content: string, filePath: string): ExtractedLocalCode {
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
  const symbolPattern = /^(\s*)(class|def|async\s+def)\s+([A-Za-z_][\w]*)/gm;
  const importPattern = /^\s*(?:from\s+([A-Za-z_][\w.]*|\.)\s+import|import\s+([A-Za-z_][\w.]*))/gm;

  for (const match of content.matchAll(symbolPattern)) {
    const name = match[3];
    if (!name || match.index === undefined) {
      continue;
    }
    const indent = match[1] ?? "";
    const keyword = match[2] ?? "";
    const kind =
      indent.length > 0 && keyword.includes("def")
        ? "method"
        : keyword === "class"
          ? "class"
          : "function";
    const line = lineNumberFromIndex(content, match.index);
    const qualifiedName = name;
    symbols.push({
      name,
      kind,
      filePath,
      line,
      qualifiedName,
      localKey: buildSymbolKey(filePath, qualifiedName, kind),
      exported: /^[A-Z]/.test(name),
      defaultExport: false,
    });
  }

  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || match.index === undefined) {
      continue;
    }
    imports.push({ filePath, specifier, line: lineNumberFromIndex(content, match.index) });
  }

  return { symbols, imports, references: [], edges: [] };
}

function extractGo(content: string, filePath: string): ExtractedLocalCode {
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
  const symbolPattern = /^\s*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm;
  const importPattern = /^\s*import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/gm;

  for (const match of content.matchAll(symbolPattern)) {
    const name = match[2];
    if (!name || match.index === undefined) {
      continue;
    }
    const kind = match[1] === "type" ? "type" : "function";
    const line = lineNumberFromIndex(content, match.index);
    const qualifiedName = name;
    symbols.push({
      name,
      kind,
      filePath,
      line,
      qualifiedName,
      localKey: buildSymbolKey(filePath, qualifiedName, kind),
    });
  }

  for (const match of content.matchAll(importPattern)) {
    if (match.index === undefined) {
      continue;
    }
    const block = match[1];
    const single = match[2];
    const line = lineNumberFromIndex(content, match.index);
    if (single) {
      imports.push({ filePath, specifier: single, line });
      continue;
    }
    if (!block) {
      continue;
    }
    for (const blockMatch of block.matchAll(/"([^"]+)"/g)) {
      const specifier = blockMatch[1];
      if (specifier) {
        imports.push({ filePath, specifier, line });
      }
    }
  }

  return { symbols, imports, references: [], edges: [] };
}

function extractCode(
  content: string,
  filePath: string,
  language: LocalCodeOverlayFile["language"]
): ExtractedLocalCode {
  switch (language) {
    case "typescript":
      return extractTypeScript(content, filePath);
    case "python":
      return extractPython(content, filePath);
    case "go":
      return extractGo(content, filePath);
  }
}

function incrementReason(
  counts: Record<LocalCodeOverlayExcludedFile["reason"], number>,
  reason: LocalCodeOverlayExcludedFile["reason"]
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function determineOverlayKind(args: {
  mode: LocalCodeOverlayMode;
  baseSha: string | null;
  localHeadSha: string | null;
  dirtyStatus: string;
  hasWorkingTreeFiles: boolean;
}): LocalCodeOverlayKind {
  const hasLocalCommit =
    Boolean(args.localHeadSha) && Boolean(args.baseSha) && args.localHeadSha !== args.baseSha;
  const isDirty = args.dirtyStatus.trim().length > 0;
  if (args.mode === "working_tree" && isDirty && hasLocalCommit) {
    return "mixed";
  }
  if (
    args.mode === "working_tree" &&
    (isDirty || (!args.localHeadSha && args.hasWorkingTreeFiles))
  ) {
    return "working_tree";
  }
  if (hasLocalCommit || args.mode === "local_commit") {
    return "local_commit";
  }
  return "none";
}

export function getLocalCodeOverlayCachePath(cwd: string = process.cwd()): string {
  return path.join(resolveRepoRoot(cwd), CACHE_RELATIVE_PATH);
}

export function getLocalCodePromotionStatePath(cwd: string = process.cwd()): string {
  return path.join(resolveRepoRoot(cwd), PROMOTION_RELATIVE_PATH);
}

/**
 * Build a local code graph overlay over the working tree or a local commit.
 *
 * Walks candidate files (working tree, or a commit when `mode` is
 * "local_commit"), parses supported languages into files/symbols/imports, and
 * records why files were excluded (ignored, unsupported language, too large,
 * secret pattern, read error). Honors `.sniparaignore`, per-file size and file
 * count caps (`maxFiles`, `maxFileBytes`), and adds warnings when limits are
 * hit. This overlay backs the offline impact/callers/imports queries for the
 * current checkout.
 *
 * @returns A `LocalCodeOverlayManifest` with files, symbols, imports, excluded
 *   samples, and warnings.
 */
export function buildLocalCodeOverlay(
  options: LocalCodeOverlayOptions = {}
): LocalCodeOverlayManifest {
  const repoRoot = resolveRepoRoot(options.cwd ?? process.cwd());
  const mode = options.mode ?? "working_tree";
  const commit = mode === "local_commit" ? (options.commit ?? "HEAD") : (options.commit ?? "HEAD");
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, "--max-files");
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "--max-file-bytes"
  );
  const now = new Date().toISOString();
  const branch = readBranch(repoRoot);
  const localHeadSha = readHeadSha(repoRoot);
  const baseSha = readBaseSha(repoRoot, branch);
  const dirtyStatus = readGitStatus(repoRoot);
  const sniparaIgnore = readSniparaIgnore(repoRoot);
  const candidateFiles =
    mode === "local_commit" ? listCommitFiles(repoRoot, commit) : listWorkingTreeFiles(repoRoot);
  const previous = readLocalCodeOverlayCache(repoRoot);
  const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const files: LocalCodeOverlayFile[] = [];
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
  const references: LocalCodeOverlayReference[] = [];
  const extractedEdges: LocalCodeOverlayEdge[] = [];
  let reusedFiles = 0;
  let parsedFiles = 0;
  const excludedSamples: LocalCodeOverlayExcludedFile[] = [];
  const secretRedactionSamples: SecretRedactionSample[] = [];
  const byReason: Record<LocalCodeOverlayExcludedFile["reason"], number> = {
    ignored: 0,
    unsupported_language: 0,
    too_large: 0,
    secret_pattern: 0,
    read_error: 0,
  };
  const warnings: LocalCodeOverlayManifest["warnings"] = [];

  const addExcluded = (filePath: string, reason: LocalCodeOverlayExcludedFile["reason"]) => {
    incrementReason(byReason, reason);
    if (excludedSamples.length < 20) {
      excludedSamples.push({ path: filePath, reason });
    }
  };

  for (const filePath of candidateFiles) {
    if (files.length >= maxFiles) {
      warnings.push({
        code: "local_overlay_file_limit_reached",
        severity: "warning",
        message: `Stopped after ${maxFiles} included files. Increase --max-files for larger repos.`,
      });
      break;
    }

    if (isIgnored(filePath, sniparaIgnore)) {
      addExcluded(filePath, "ignored");
      continue;
    }

    const language = languageForFile(filePath);
    if (!language) {
      addExcluded(filePath, "unsupported_language");
      continue;
    }

    const contentBuffer = readFileContent(repoRoot, filePath, mode, commit);
    if (!contentBuffer) {
      addExcluded(filePath, "read_error");
      continue;
    }

    if (contentBuffer.length > maxFileBytes) {
      addExcluded(filePath, "too_large");
      continue;
    }

    const content = contentBuffer.toString("utf8");
    const redaction = redactSecretLikeContentForOverlay(content);
    const indexedContent = redaction.content;
    if (redaction.findings.length > 0) {
      secretRedactionSamples.push({ path: filePath, findings: redaction.findings });
    }

    const contentHash = sha256(indexedContent);
    const previousFile = previousFiles.get(filePath);
    const canReuse =
      previous?.version === "snipara.local_code_overlay.v2" &&
      previous.extractorVersion === 3 &&
      previousFile?.sha256 === contentHash &&
      previousFile.language === language;
    const extracted: ExtractedLocalCode = canReuse
      ? {
          symbols: previous.symbols.filter((item) => item.filePath === filePath),
          imports: previous.imports.filter((item) => item.filePath === filePath),
          references: previous.references.filter((item) => item.filePath === filePath),
          edges: previous.edges.filter(
            (item) => item.filePath === filePath && item.kind === "CONTAINS"
          ),
        }
      : extractCode(indexedContent, filePath, language);
    if (canReuse) reusedFiles += 1;
    else parsedFiles += 1;
    files.push({
      path: filePath,
      language,
      sizeBytes: contentBuffer.length,
      sha256: contentHash,
      symbolCount: extracted.symbols.length,
      importCount: extracted.imports.length,
      referenceCount: extracted.references.length,
      edgeCount: extracted.edges.length,
    });
    symbols.push(...extracted.symbols);
    imports.push(...extracted.imports);
    references.push(...extracted.references);
    extractedEdges.push(...extracted.edges);
  }

  const edges = resolveLocalGraphEdges(files, symbols, imports, references, extractedEdges);
  const semantic = buildLocalSemanticModel(
    { symbols, edges },
    { semanticRules: loadLocalSemanticRuleConfig(repoRoot) }
  );
  for (const file of files) {
    file.edgeCount = edges.filter((edge) => edge.filePath === file.path).length;
  }
  const currentFilePaths = new Set(files.map((file) => file.path));
  const deletedFiles = previous
    ? previous.files.filter((file) => !currentFilePaths.has(file.path)).length
    : 0;

  if (mode === "working_tree" && !localHeadSha && files.length > 0) {
    warnings.push({
      code: "local_folder_overlay",
      severity: "info",
      message:
        "This overlay was built from a local folder without Git commit metadata; it is local-only until synced through GitHub, GitLab, or hosted source upload.",
    });
  } else if (mode === "working_tree" && dirtyStatus.trim()) {
    warnings.push({
      code: "local_working_tree_overlay",
      severity: "info",
      message:
        "This overlay includes local working tree state that has not been pushed to a shared hosted index.",
    });
  } else if (mode === "local_commit" && dirtyStatus.trim()) {
    warnings.push({
      code: "dirty_working_tree_not_included",
      severity: "info",
      message:
        "The working tree is dirty, but this overlay was built from the selected commit only.",
    });
  }
  if (secretRedactionSamples.length > 0) {
    warnings.push(formatSecretRedactionWarning(secretRedactionSamples));
  }

  const dirtyTreeHash =
    mode === "working_tree" && (dirtyStatus.trim() || (!localHeadSha && files.length > 0))
      ? shortHash(
          JSON.stringify({
            dirtyStatus,
            files: files.map((file) => [file.path, file.sha256]),
          })
        )
      : null;

  return {
    version: "snipara.local_code_overlay.v2",
    extractorVersion: 3,
    generatedAt: now,
    indexedAt: now,
    repoRoot,
    repositoryId: readRemoteRepositoryId(repoRoot),
    branch,
    baseSha,
    localHeadSha,
    commit: mode === "local_commit" ? commit : localHeadSha,
    dirtyTreeHash,
    overlayKind: determineOverlayKind({
      mode,
      baseSha,
      localHeadSha,
      dirtyStatus,
      hasWorkingTreeFiles: files.length > 0,
    }),
    canonicalIndexedSha: null,
    currentWorkingTreeVisible: mode === "working_tree",
    canonical: false,
    mode,
    files,
    symbols,
    imports,
    references,
    edges,
    semantic,
    incremental: {
      reusedFiles,
      parsedFiles,
      deletedFiles,
    },
    excluded: {
      total: Object.values(byReason).reduce((sum, count) => sum + count, 0),
      byReason,
      samples: excludedSamples,
    },
    warnings,
  };
}

export function summarizeLocalCodeOverlay(
  manifest: LocalCodeOverlayManifest
): LocalCodeOverlaySummary {
  return {
    version: manifest.version,
    generatedAt: manifest.generatedAt,
    indexedAt: manifest.indexedAt,
    repoRoot: manifest.repoRoot,
    repositoryId: manifest.repositoryId,
    branch: manifest.branch,
    baseSha: manifest.baseSha,
    localHeadSha: manifest.localHeadSha,
    commit: manifest.commit,
    dirtyTreeHash: manifest.dirtyTreeHash,
    overlayKind: manifest.overlayKind,
    canonicalIndexedSha: manifest.canonicalIndexedSha,
    currentWorkingTreeVisible: manifest.currentWorkingTreeVisible,
    canonical: manifest.canonical,
    mode: manifest.mode,
    counts: {
      files: manifest.files.length,
      symbols: manifest.symbols.length,
      imports: manifest.imports.length,
      references: manifest.references.length,
      edges: manifest.edges.length,
      semanticAssertions: manifest.semantic?.assertions.length ?? 0,
      excluded: manifest.excluded.total,
    },
    incremental: manifest.incremental,
    excludedByReason: manifest.excluded.byReason,
    fileSamples: manifest.files.slice(0, 20).map((file) => file.path),
    warnings: manifest.warnings,
  };
}

export function writeLocalCodeOverlayCache(manifest: LocalCodeOverlayManifest): string {
  const cachePath = getLocalCodeOverlayCachePath(manifest.repoRoot);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2), "utf8");
  return cachePath;
}

export function readLocalCodeOverlayCache(
  cwd: string = process.cwd()
): LocalCodeOverlayManifest | null {
  const cachePath = getLocalCodeOverlayCachePath(cwd);
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    if (parsed?.version === "snipara.local_code_overlay.v2") {
      return parsed as unknown as LocalCodeOverlayManifest;
    }
    if (parsed?.version === "snipara.local_code_overlay.v1") {
      return upgradeLegacyLocalCodeOverlay(parsed);
    }
    return null;
  } catch {
    return null;
  }
}

export function writeLocalCodePromotionState(state: LocalCodePromotionState): string {
  const statePath = getLocalCodePromotionStatePath(state.repoRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return statePath;
}

export function readLocalCodePromotionState(
  cwd: string = process.cwd()
): LocalCodePromotionState | null {
  const statePath = getLocalCodePromotionStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as LocalCodePromotionState;
    return parsed && parsed.version === "snipara.local_code_promotion.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function printManifestSummary(manifest: LocalCodeOverlayManifest, cachePath?: string): void {
  console.log(chalk.bold("Local Code Overlay"));
  console.log(`Repo: ${manifest.repositoryId}`);
  console.log(`Branch: ${manifest.branch ?? "unknown"}`);
  console.log(
    `Overlay: ${manifest.overlayKind} (${manifest.canonical ? "canonical" : "non-canonical"})`
  );
  console.log(`Files: ${manifest.files.length}`);
  console.log(`Symbols: ${manifest.symbols.length}`);
  console.log(`Imports: ${manifest.imports.length}`);
  console.log(`References: ${manifest.references.length}`);
  console.log(`Edges: ${manifest.edges.length}`);
  console.log(
    `Incremental: ${manifest.incremental.reusedFiles} reused, ${manifest.incremental.parsedFiles} parsed, ${manifest.incremental.deletedFiles} deleted`
  );
  console.log(`Excluded: ${manifest.excluded.total}`);
  if (manifest.dirtyTreeHash) {
    console.log(`Dirty tree hash: ${manifest.dirtyTreeHash}`);
  }
  if (cachePath) {
    console.log(`Cache: ${cachePath}`);
  }
  for (const warning of manifest.warnings) {
    console.log(
      `${warning.severity === "warning" ? chalk.yellow("Warning") : "Info"}: ${warning.message}`
    );
  }
}

function compactSymbol(symbol: LocalCodeOverlaySymbol): Record<string, unknown> {
  return {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    filePath: symbol.filePath,
    line: symbol.line,
    localKey: symbol.localKey,
  };
}

function loadQueryManifest(options: LocalCodeQueryCommandOptions): LocalCodeOverlayManifest {
  if (options.cached) {
    const cached = readLocalCodeOverlayCache(options.dir);
    if (cached) {
      return cached;
    }
  }
  return buildLocalCodeOverlay({
    cwd: options.dir,
    mode: options.mode ?? "working_tree",
    commit: options.commit,
    maxFiles: options.maxFiles,
  });
}

function findSymbol(
  manifest: LocalCodeOverlayManifest,
  options: { qualifiedName?: string; symbolKey?: string; filePath?: string }
): LocalCodeOverlaySymbol | null {
  const symbolKey = options.symbolKey?.trim();
  if (symbolKey) {
    return manifest.symbols.find((symbol) => symbol.localKey === symbolKey) ?? null;
  }

  const qualifiedName = options.qualifiedName?.trim();
  if (!qualifiedName) {
    return null;
  }

  const exact = manifest.symbols.find(
    (symbol) =>
      symbol.localKey === qualifiedName ||
      `${symbol.filePath}::${symbol.name}` === qualifiedName ||
      symbol.name === qualifiedName
  );
  if (exact) {
    return exact;
  }

  const bySuffix = manifest.symbols.find((symbol) => qualifiedName.endsWith(`.${symbol.name}`));
  if (bySuffix) {
    return bySuffix;
  }

  if (options.filePath) {
    return manifest.symbols.find((symbol) => symbol.filePath === options.filePath) ?? null;
  }

  return null;
}

function resolveImportTarget(
  manifest: Pick<LocalCodeOverlayManifest, "files">,
  fromFile: string,
  specifier: string
): string | null {
  const files = new Set(manifest.files.map((file) => file.path));
  return resolveImportTargetFromSet(files, fromFile, specifier);
}

function resolveImportTargetFromSet(
  files: Set<string>,
  fromFile: string,
  specifier: string
): string | null {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    const base = normalizeRepoPath(path.join(path.dirname(fromFile), specifier));
    candidates.push(base);
    for (const extension of SUPPORTED_EXTENSIONS.keys()) {
      candidates.push(`${base}${extension}`);
      candidates.push(`${base}/index${extension}`);
    }
  } else {
    const modulePath = specifier.replace(/\./g, "/");
    for (const extension of SUPPORTED_EXTENSIONS.keys()) {
      candidates.push(`${modulePath}${extension}`);
      candidates.push(`${modulePath}/index${extension}`);
    }
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function buildLocalFileEdges(manifest: LocalCodeOverlayManifest): Array<{
  from: string;
  to: string;
  specifier: string;
  line: number;
}> {
  return manifest.imports.flatMap((item) => {
    const target = resolveImportTarget(manifest, item.filePath, item.specifier);
    return target
      ? [{ from: item.filePath, to: target, specifier: item.specifier, line: item.line }]
      : [];
  });
}

function normalizedReferenceParts(name: string): { root: string; member: string } {
  const normalized = name
    .replace(/\?\./g, ".")
    .replace(/<[^>]*>/g, "")
    .trim();
  const parts = normalized.split(".").filter(Boolean);
  return {
    root: parts[0] ?? normalized,
    member: parts.at(-1) ?? normalized,
  };
}

interface LocalGraphResolutionIndex {
  filePaths: Set<string>;
  symbolsByFile: Map<string, LocalCodeOverlaySymbol[]>;
  symbolsByKey: Map<string, LocalCodeOverlaySymbol>;
  importsByFile: Map<string, LocalCodeOverlayImport[]>;
}

function resolveReferenceTarget(
  index: LocalGraphResolutionIndex,
  reference: LocalCodeOverlayReference
): { key: string; confidence: number } | null {
  const { root, member } = normalizedReferenceParts(reference.name);
  const source = index.symbolsByKey.get(reference.from);
  const sameFile = index.symbolsByFile.get(reference.filePath) ?? [];

  if (root === "this" && source) {
    const owner = source.qualifiedName.split(".").slice(0, -1).join(".");
    const method = sameFile.find(
      (symbol) => symbol.name === member && symbol.qualifiedName.startsWith(`${owner}.`)
    );
    if (method) return { key: method.localKey, confidence: reference.confidence };
  }

  const local = sameFile.find(
    (symbol) =>
      symbol.localKey !== reference.from &&
      (symbol.name === root || symbol.name === member || symbol.qualifiedName === reference.name)
  );
  if (local) return { key: local.localKey, confidence: reference.confidence };

  for (const item of index.importsByFile.get(reference.filePath) ?? []) {
    const binding = item.bindings?.find((candidate) => candidate.localName === root);
    if (!binding) continue;
    const targetFile = resolveImportTargetFromSet(
      index.filePaths,
      reference.filePath,
      item.specifier
    );
    if (!targetFile) continue;
    const targetName =
      binding.kind === "namespace"
        ? member
        : binding.importedName === "default"
          ? member === root
            ? root
            : member
          : binding.importedName;
    const target = (index.symbolsByFile.get(targetFile) ?? []).find(
      (symbol) =>
        symbol.filePath === targetFile &&
        (symbol.name === targetName || symbol.qualifiedName.endsWith(`.${targetName}`))
    );
    return target
      ? { key: target.localKey, confidence: reference.confidence }
      : { key: buildFileNodeKey(targetFile), confidence: reference.confidence * 0.65 };
  }

  return null;
}

function dedupeLocalGraphEdges(edges: LocalCodeOverlayEdge[]): LocalCodeOverlayEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.filePath}\u0000${edge.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveLocalGraphEdges(
  files: LocalCodeOverlayFile[],
  symbols: LocalCodeOverlaySymbol[],
  imports: LocalCodeOverlayImport[],
  references: LocalCodeOverlayReference[],
  extractedEdges: LocalCodeOverlayEdge[]
): LocalCodeOverlayEdge[] {
  const edges: LocalCodeOverlayEdge[] = [...extractedEdges];
  const symbolsByFile = new Map<string, LocalCodeOverlaySymbol[]>();
  const symbolsByKey = new Map<string, LocalCodeOverlaySymbol>();
  const importsByFile = new Map<string, LocalCodeOverlayImport[]>();
  for (const symbol of symbols) {
    symbolsByFile.set(symbol.filePath, [...(symbolsByFile.get(symbol.filePath) ?? []), symbol]);
    symbolsByKey.set(symbol.localKey, symbol);
  }
  for (const item of imports) {
    importsByFile.set(item.filePath, [...(importsByFile.get(item.filePath) ?? []), item]);
  }
  const resolutionIndex: LocalGraphResolutionIndex = {
    filePaths: new Set(files.map((file) => file.path)),
    symbolsByFile,
    symbolsByKey,
    importsByFile,
  };

  for (const symbol of symbols) {
    edges.push({
      from: buildFileNodeKey(symbol.filePath),
      to: symbol.localKey,
      kind: "CONTAINS",
      filePath: symbol.filePath,
      line: symbol.line,
      confidence: 1,
      source: symbol.filePath.match(/\.(?:ts|tsx|mts|cts)$/)
        ? "typescript-compiler-api"
        : "language-parser",
      evidence: { filePath: symbol.filePath, line: symbol.line },
    });
  }

  for (const item of imports) {
    const target = resolveImportTargetFromSet(
      resolutionIndex.filePaths,
      item.filePath,
      item.specifier
    );
    if (!target) continue;
    edges.push({
      from: buildFileNodeKey(item.filePath),
      to: buildFileNodeKey(target),
      kind: "IMPORTS",
      filePath: item.filePath,
      line: item.line,
      confidence: 1,
      source: "import-resolver",
      evidence: { filePath: item.filePath, line: item.line },
    });
  }

  for (const reference of references) {
    const target = resolveReferenceTarget(resolutionIndex, reference);
    if (!target || target.key === reference.from) continue;
    edges.push({
      from: reference.from,
      to: target.key,
      kind: reference.kind,
      filePath: reference.filePath,
      line: reference.line,
      confidence: target.confidence,
      source: "typescript-compiler-api",
      evidence: { filePath: reference.filePath, line: reference.line },
    });
  }

  return dedupeLocalGraphEdges(edges);
}

function upgradeLegacyLocalCodeOverlay(parsed: Record<string, unknown>): LocalCodeOverlayManifest {
  const legacy = parsed as unknown as {
    generatedAt: string;
    indexedAt: string;
    repoRoot: string;
    repositoryId: string;
    branch: string | null;
    baseSha: string | null;
    localHeadSha: string | null;
    commit: string | null;
    dirtyTreeHash: string | null;
    overlayKind: LocalCodeOverlayKind;
    canonicalIndexedSha: null;
    currentWorkingTreeVisible: boolean;
    canonical: false;
    mode: LocalCodeOverlayMode;
    files: Array<Omit<LocalCodeOverlayFile, "referenceCount" | "edgeCount">>;
    symbols: Array<Omit<LocalCodeOverlaySymbol, "qualifiedName">>;
    imports: LocalCodeOverlayImport[];
    excluded: LocalCodeOverlayManifest["excluded"];
    warnings: LocalCodeOverlayWarning[];
  };
  const symbols = (legacy.symbols ?? []).map((symbol) => {
    const qualifiedName = symbol.name;
    return {
      ...symbol,
      qualifiedName,
      localKey: buildSymbolKey(symbol.filePath, qualifiedName, symbol.kind),
    };
  });
  const imports = legacy.imports ?? [];
  const files = (legacy.files ?? []).map((file) => ({
    ...file,
    referenceCount: 0,
    edgeCount: 0,
  }));
  const edges = resolveLocalGraphEdges(files, symbols, imports, [], []);
  for (const file of files) {
    file.edgeCount = edges.filter((edge) => edge.filePath === file.path).length;
  }
  return {
    ...legacy,
    version: "snipara.local_code_overlay.v2",
    extractorVersion: 2,
    files,
    symbols,
    imports,
    references: [],
    edges,
    incremental: {
      reusedFiles: 0,
      parsedFiles: files.length,
      deletedFiles: 0,
    },
  };
}

interface LocalGraphTraversalNode {
  key: string;
  depth: number;
  filePath: string | null;
  path: string[];
  edges: LocalCodeOverlayEdge[];
}

interface LocalGraphTraversalResult {
  nodes: LocalGraphTraversalNode[];
  traversedEdges: LocalCodeOverlayEdge[];
  truncated: boolean;
  visitedCount: number;
}

function graphNodeFilePath(manifest: LocalCodeOverlayManifest, key: string): string | null {
  if (key.startsWith("local-file::")) return key.slice("local-file::".length);
  return manifest.symbols.find((symbol) => symbol.localKey === key)?.filePath ?? null;
}

function graphNodePayload(
  manifest: LocalCodeOverlayManifest,
  node: LocalGraphTraversalNode
): Record<string, unknown> {
  const symbol = manifest.symbols.find((candidate) => candidate.localKey === node.key);
  return symbol
    ? { ...compactSymbol(symbol), depth: node.depth, path: node.path }
    : { key: node.key, kind: "file", filePath: node.filePath, depth: node.depth, path: node.path };
}

function findGraphSeedKeys(
  manifest: LocalCodeOverlayManifest,
  options: Pick<LocalCodeQueryCommandOptions, "qualifiedName" | "symbolKey" | "filePath">
): string[] {
  const symbol = findSymbol(manifest, options);
  if (symbol) return [symbol.localKey];
  if (options.filePath) {
    const normalized = normalizeRepoPath(options.filePath);
    return manifest.files.some((file) => file.path === normalized)
      ? [buildFileNodeKey(normalized)]
      : [];
  }
  return [];
}

function traverseLocalGraph(
  manifest: LocalCodeOverlayManifest,
  seeds: string[],
  options: {
    depth: number;
    direction: "in" | "out" | "both";
    edgeKinds?: string[];
    maxNodes: number;
  }
): LocalGraphTraversalResult {
  const allowed = new Set(
    (options.edgeKinds?.length
      ? options.edgeKinds
      : ["IMPORTS", "CALLS", "REFERENCES", "CONTAINS"]
    ).map((kind) => kind.toUpperCase())
  );
  const incoming = new Map<string, LocalCodeOverlayEdge[]>();
  const outgoing = new Map<string, LocalCodeOverlayEdge[]>();
  for (const edge of manifest.edges) {
    if (!allowed.has(edge.kind)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  const uniqueSeeds = [...new Set(seeds)];
  const boundedSeeds = uniqueSeeds.slice(0, options.maxNodes);
  const visited = new Set(boundedSeeds);
  const queue = boundedSeeds.map((key) => ({
    key,
    depth: 0,
    path: [key],
    edges: [] as LocalCodeOverlayEdge[],
  }));
  const nodes: LocalGraphTraversalNode[] = [];
  const traversedEdges: LocalCodeOverlayEdge[] = [];
  let truncated = boundedSeeds.length < uniqueSeeds.length;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= options.depth) continue;
    const candidates = [
      ...(options.direction !== "in"
        ? (outgoing.get(current.key) ?? []).map((edge) => ({ edge, next: edge.to }))
        : []),
      ...(options.direction !== "out"
        ? (incoming.get(current.key) ?? []).map((edge) => ({ edge, next: edge.from }))
        : []),
    ];
    for (const candidate of candidates) {
      if (visited.has(candidate.next)) continue;
      if (visited.size >= options.maxNodes) {
        truncated = true;
        queue.length = 0;
        break;
      }
      visited.add(candidate.next);
      const next = {
        key: candidate.next,
        depth: current.depth + 1,
        filePath: graphNodeFilePath(manifest, candidate.next),
        path: [...current.path, candidate.next],
        edges: [...current.edges, candidate.edge],
      };
      nodes.push(next);
      traversedEdges.push(candidate.edge);
      queue.push(next);
    }
  }

  return {
    nodes,
    traversedEdges: dedupeLocalGraphEdges(traversedEdges),
    truncated,
    visitedCount: visited.size,
  };
}

function uniqueTraversalFiles(nodes: LocalGraphTraversalNode[], excluded: Set<string>): string[] {
  return [
    ...new Set(
      nodes
        .map((node) => node.filePath)
        .filter(
          (filePath): filePath is string => typeof filePath === "string" && !excluded.has(filePath)
        )
    ),
  ].sort();
}

interface LocalRiskConfig {
  depthDecay: number;
  criticality: Array<{ pattern: string; weight: number }>;
  edgeWeights: Partial<Record<LocalCodeOverlayEdge["kind"], number>>;
}

interface LocalSemanticRuleConfig {
  replaceDefaults: boolean;
  sensitivePathTerms: string[];
  contractPathTerms: string[];
  testPathTerms: string[];
  architectureRoleTerms: Record<string, string[]>;
  source: "defaults" | "project-file";
  warnings: string[];
}

const LOCAL_SEMANTIC_RULE_CONFIG_PATH = path.join(".snipara", "semantic-rules.json");
const LOCAL_SEMANTIC_RULE_CONFIG_VERSION = "snipara.semantic.rules.v1";
const LOCAL_SEMANTIC_MAX_TERMS = 64;
const LOCAL_SEMANTIC_MAX_TERM_LENGTH = 80;
const LOCAL_SEMANTIC_MAX_ROLES = 24;
const LOCAL_SEMANTIC_TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?)(\/|$)|\.(test|spec)\./i;
const LOCAL_SEMANTIC_SENSITIVE_PATH =
  /(^|\/)(auth|middleware|billing|payments?|stripe|webhooks?|prisma|schema|migrations?|deploy)(\/|\.|$)/i;
const LOCAL_SEMANTIC_CONTRACT_PATH =
  /(^|\/)(schemas?|contracts?|protocols?|interfaces?|config|tool_defs)(\/|\.|$)|route\.(ts|tsx|py)$/i;

function localSemanticTerms(raw: unknown, label: string, warnings: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${label} terms must be an array.`);
    return [];
  }
  const terms: string[] = [];
  for (const value of raw.slice(0, LOCAL_SEMANTIC_MAX_TERMS)) {
    const term = String(value).trim().toLowerCase();
    if (!term) continue;
    if (term.length > LOCAL_SEMANTIC_MAX_TERM_LENGTH) {
      warnings.push(
        `Ignored a ${label} term longer than ${LOCAL_SEMANTIC_MAX_TERM_LENGTH} characters.`
      );
      continue;
    }
    terms.push(term);
  }
  if (raw.length > LOCAL_SEMANTIC_MAX_TERMS) {
    warnings.push(`Limited ${label} terms to ${LOCAL_SEMANTIC_MAX_TERMS} entries.`);
  }
  return [...new Set(terms)];
}

function loadLocalSemanticRuleConfig(repoRoot: string): LocalSemanticRuleConfig {
  const defaults: LocalSemanticRuleConfig = {
    replaceDefaults: false,
    sensitivePathTerms: [],
    contractPathTerms: [],
    testPathTerms: [],
    architectureRoleTerms: {},
    source: "defaults",
    warnings: [],
  };
  const configPath = path.join(repoRoot, LOCAL_SEMANTIC_RULE_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return defaults;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ...defaults,
        source: "project-file",
        warnings: ["Semantic rule config must be a JSON object; defaults were retained."],
      };
    }
    const raw = parsed as Record<string, unknown>;
    const warnings: string[] = [];
    const rawRoles = raw.architectureRoleTerms ?? raw.architecture_role_terms ?? {};
    const architectureRoleTerms: Record<string, string[]> = {};
    if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
      for (const [rawRole, rawTerms] of Object.entries(rawRoles).slice(
        0,
        LOCAL_SEMANTIC_MAX_ROLES
      )) {
        const role = rawRole
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "");
        if (!role) {
          warnings.push("Ignored an empty or unsupported architecture role name.");
          continue;
        }
        architectureRoleTerms[role] = localSemanticTerms(
          rawTerms,
          `architecture role ${role}`,
          warnings
        );
      }
    } else if (rawRoles) {
      warnings.push("architectureRoleTerms must be an object of role-to-term arrays.");
    }
    return {
      replaceDefaults: Boolean(raw.replaceDefaults ?? raw.replace_defaults ?? false),
      sensitivePathTerms: localSemanticTerms(
        raw.sensitivePathTerms ?? raw.sensitive_path_terms,
        "sensitive path",
        warnings
      ),
      contractPathTerms: localSemanticTerms(
        raw.contractPathTerms ?? raw.contract_path_terms,
        "contract path",
        warnings
      ),
      testPathTerms: localSemanticTerms(
        raw.testPathTerms ?? raw.test_path_terms,
        "test path",
        warnings
      ),
      architectureRoleTerms,
      source: "project-file",
      warnings,
    };
  } catch (error) {
    return {
      ...defaults,
      source: "project-file",
      warnings: [
        `Could not parse ${LOCAL_SEMANTIC_RULE_CONFIG_PATH}: ${
          error instanceof Error ? error.message : "invalid JSON"
        }`,
      ],
    };
  }
}

function localSemanticMatchesTerms(value: string, terms: string[]): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function localSemanticIsTestPath(filePath: string, rules: LocalSemanticRuleConfig): boolean {
  return (
    (!rules.replaceDefaults && LOCAL_SEMANTIC_TEST_PATH.test(filePath)) ||
    localSemanticMatchesTerms(filePath, rules.testPathTerms)
  );
}

function localSemanticIsSensitivePath(filePath: string, rules: LocalSemanticRuleConfig): boolean {
  return (
    (!rules.replaceDefaults && LOCAL_SEMANTIC_SENSITIVE_PATH.test(filePath)) ||
    localSemanticMatchesTerms(filePath, rules.sensitivePathTerms)
  );
}

function localSemanticIsContractPath(filePath: string, rules: LocalSemanticRuleConfig): boolean {
  return (
    (!rules.replaceDefaults && LOCAL_SEMANTIC_CONTRACT_PATH.test(filePath)) ||
    localSemanticMatchesTerms(filePath, rules.contractPathTerms)
  );
}

function localSemanticEvidence(
  kind: string,
  detail: string,
  metadata: Omit<LocalSemanticEvidence, "kind" | "detail"> = {}
): LocalSemanticEvidence {
  return { kind, detail, ...metadata };
}

function localSemanticAssertion(
  subject: string,
  predicate: LocalSemanticPredicate,
  value: string | boolean,
  confidence: number,
  source: LocalSemanticAssertion["source"],
  evidence: LocalSemanticEvidence[]
): LocalSemanticAssertion {
  const identity = JSON.stringify([subject, predicate, value, source]);
  return {
    id: `semantic-${sha256(identity).slice(0, 16)}`,
    subject,
    predicate,
    value,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    scoreKind: "heuristic_prior",
    calibrated: false,
    source,
    extractorVersion: 1,
    evidence,
  };
}

function localArchitectureRoles(
  symbol: LocalCodeOverlaySymbol,
  rules: LocalSemanticRuleConfig
): LocalSemanticAssertion[] {
  const haystack = `${symbol.filePath} ${symbol.name}`;
  const defaultCandidates: Array<{
    role: string;
    pattern: RegExp;
    confidence: number;
  }> = [
    { role: "repository", pattern: /repository|(^|[_.])repo($|[_.])/i, confidence: 0.9 },
    { role: "adapter", pattern: /adapter/i, confidence: 0.9 },
    { role: "facade", pattern: /facade/i, confidence: 0.9 },
    { role: "controller", pattern: /controller/i, confidence: 0.85 },
    { role: "service", pattern: /service/i, confidence: 0.78 },
    { role: "worker", pattern: /worker|background[_-]?job|indexer/i, confidence: 0.82 },
    { role: "factory", pattern: /factory|builder/i, confidence: 0.76 },
  ];
  const roles: LocalSemanticAssertion[] = [];
  if (/\/app\/api\//i.test(symbol.filePath) || /\/route\.(ts|tsx|py)$/i.test(symbol.filePath)) {
    roles.push(
      localSemanticAssertion(
        symbol.localKey,
        "architecture_role",
        "route_handler",
        0.94,
        "architecture-pattern-rules",
        [
          localSemanticEvidence("route_path", "Route path identifies an API boundary.", {
            filePath: symbol.filePath,
            line: symbol.line,
          }),
        ]
      )
    );
  }
  if (localSemanticIsTestPath(symbol.filePath, rules)) {
    roles.push(
      localSemanticAssertion(
        symbol.localKey,
        "architecture_role",
        "test",
        0.98,
        "architecture-pattern-rules",
        [localSemanticEvidence("test_path", "File is under a test surface.")]
      )
    );
  }
  for (const candidate of rules.replaceDefaults ? [] : defaultCandidates) {
    if (!candidate.pattern.test(haystack)) continue;
    roles.push(
      localSemanticAssertion(
        symbol.localKey,
        "architecture_role",
        candidate.role,
        candidate.confidence,
        "architecture-pattern-rules",
        [
          localSemanticEvidence(
            "name_or_path_pattern",
            `Name or path matches the ${candidate.role} pattern.`,
            { filePath: symbol.filePath, line: symbol.line }
          ),
        ]
      )
    );
  }
  const existingRoles = new Set(roles.map((assertion) => String(assertion.value)));
  for (const [role, terms] of Object.entries(rules.architectureRoleTerms)) {
    if (existingRoles.has(role) || !localSemanticMatchesTerms(haystack, terms)) continue;
    roles.push(
      localSemanticAssertion(
        symbol.localKey,
        "architecture_role",
        role,
        0.7,
        "architecture-pattern-rules",
        [
          localSemanticEvidence(
            "project_role_term",
            `Name or path matches a configured ${role} project term.`,
            { filePath: symbol.filePath, line: symbol.line }
          ),
        ]
      )
    );
  }
  return roles;
}

function localSymbolSemanticAssertions(
  symbol: LocalCodeOverlaySymbol,
  rules: LocalSemanticRuleConfig
): LocalSemanticAssertion[] {
  const assertions: LocalSemanticAssertion[] = [];
  const routeSurface =
    /\/app\/api\//i.test(symbol.filePath) || /\/route\.(ts|tsx|py)$/i.test(symbol.filePath);
  const toolSurface = /(^|\/)(mcp|tool_defs)(\/|\.|$)/i.test(symbol.filePath);
  const publicEvidence: LocalSemanticEvidence[] = [];
  if (symbol.exported) {
    publicEvidence.push(
      localSemanticEvidence(
        "explicit_export",
        "TypeScript/Go declaration is explicitly exported.",
        {
          filePath: symbol.filePath,
          line: symbol.line,
        }
      )
    );
  }
  if (routeSurface) {
    publicEvidence.push(
      localSemanticEvidence("route_path", "Symbol is declared in a route module.", {
        filePath: symbol.filePath,
        line: symbol.line,
      })
    );
  }
  if (toolSurface) {
    publicEvidence.push(
      localSemanticEvidence(
        "tool_surface",
        "Symbol is declared in an MCP/tool-definition surface.",
        {
          filePath: symbol.filePath,
          line: symbol.line,
        }
      )
    );
  }
  if (publicEvidence.length > 0) {
    assertions.push(
      localSemanticAssertion(
        symbol.localKey,
        "public_api",
        true,
        Math.min(0.98, 0.82 + publicEvidence.length * 0.05),
        symbol.exported ? "typescript-compiler-api" : "architecture-pattern-rules",
        publicEvidence
      )
    );
  }

  let contractKind: string | null = null;
  const contractEvidence: LocalSemanticEvidence[] = [];
  if (symbol.exported && ["interface", "type"].includes(symbol.kind)) {
    contractKind = "exported_type_contract";
    contractEvidence.push(
      localSemanticEvidence("symbol_kind", `Exported ${symbol.kind} defines a structural contract.`)
    );
  } else if (localSemanticIsContractPath(symbol.filePath, rules)) {
    contractKind = "repository_boundary_contract";
    contractEvidence.push(
      localSemanticEvidence(
        "contract_path",
        "File path denotes a schema, contract, config, route, or tool boundary."
      )
    );
  } else if (symbol.exported) {
    contractKind = "public_surface_contract";
    contractEvidence.push(...publicEvidence.slice(0, 1));
  }
  if (contractKind) {
    assertions.push(
      localSemanticAssertion(
        symbol.localKey,
        "implicit_contract",
        contractKind,
        ["interface", "type"].includes(symbol.kind) ? 0.92 : 0.78,
        symbol.exported ? "typescript-compiler-api" : "architecture-pattern-rules",
        contractEvidence
      )
    );
  }

  assertions.push(...localArchitectureRoles(symbol, rules));
  let criticality = "ordinary";
  let criticalityConfidence = 0.58;
  let criticalityEvidence = [
    localSemanticEvidence("default", "No critical or incidental evidence matched."),
  ];
  if (localSemanticIsTestPath(symbol.filePath, rules)) {
    criticality = "incidental";
    criticalityConfidence = 0.95;
    criticalityEvidence = [localSemanticEvidence("test_path", "Test-only dependency.")];
  } else if (localSemanticIsSensitivePath(symbol.filePath, rules) || routeSurface || toolSurface) {
    criticality = "critical";
    criticalityConfidence = 0.92;
    criticalityEvidence = [
      localSemanticEvidence(
        "sensitive_surface",
        "Path identifies an auth, billing, schema, webhook, deploy, route, or MCP surface."
      ),
    ];
  } else if (publicEvidence.length > 0) {
    criticality = "important";
    criticalityConfidence = 0.85;
    criticalityEvidence = [
      localSemanticEvidence(
        "exported_surface",
        "Explicit export defines a module contract but is not by itself a critical runtime surface."
      ),
    ];
  } else if (contractKind) {
    criticality = "important";
    criticalityConfidence = 0.82;
    criticalityEvidence = [
      localSemanticEvidence("contract_surface", "Dependency defines a repository contract."),
    ];
  }
  assertions.push(
    localSemanticAssertion(
      symbol.localKey,
      "dependency_criticality",
      criticality,
      criticalityConfidence,
      "criticality-rules",
      criticalityEvidence
    )
  );
  return assertions;
}

function buildLocalSemanticModel(
  manifest: Pick<LocalCodeOverlayManifest, "symbols" | "edges">,
  options: {
    scope?: LocalSemanticModel["scope"];
    symbolKeys?: Set<string>;
    edges?: LocalCodeOverlayEdge[];
    semanticRules?: LocalSemanticRuleConfig;
  } = {}
): LocalSemanticModel {
  const rules = options.semanticRules ?? loadLocalSemanticRuleConfig(process.cwd());
  const symbols = options.symbolKeys
    ? manifest.symbols.filter((symbol) => options.symbolKeys?.has(symbol.localKey))
    : manifest.symbols;
  const assertions = symbols.flatMap((symbol) => localSymbolSemanticAssertions(symbol, rules));
  const symbolByKey = new Map(manifest.symbols.map((symbol) => [symbol.localKey, symbol]));
  const criticalityBySymbol = new Map(
    assertions
      .filter((assertion) => assertion.predicate === "dependency_criticality")
      .map((assertion) => [assertion.subject, String(assertion.value)])
  );
  const criticalityRank: Record<string, number> = {
    incidental: 0,
    ordinary: 1,
    important: 2,
    critical: 3,
  };
  const criticalityByFile = new Map<string, string>();
  for (const symbol of manifest.symbols) {
    const value = criticalityBySymbol.get(symbol.localKey);
    if (!value) continue;
    const current = criticalityByFile.get(symbol.filePath);
    if (!current || criticalityRank[value] > criticalityRank[current]) {
      criticalityByFile.set(symbol.filePath, value);
    }
  }
  for (const edge of options.edges ?? []) {
    const fromSymbol = symbolByKey.get(edge.from);
    const toSymbol = symbolByKey.get(edge.to);
    const fromFile = fromSymbol?.filePath ?? edge.from.replace(/^local-file::/, "");
    const toFile = toSymbol?.filePath ?? edge.to.replace(/^local-file::/, "");
    const fromCriticality = criticalityBySymbol.get(edge.from) ?? criticalityByFile.get(fromFile);
    const toCriticality = criticalityBySymbol.get(edge.to) ?? criticalityByFile.get(toFile);
    const edgeSubject = `edge::${edge.from}::${edge.kind}::${edge.to}`;
    const evidence = [
      localSemanticEvidence("graph_edge", `${edge.kind} from ${fromFile} to ${toFile}.`, {
        filePath: edge.filePath,
        line: edge.line,
        edgeKind: edge.kind,
      }),
    ];
    let value = "ordinary";
    let confidence = 0.62;
    if (localSemanticIsTestPath(fromFile, rules) || localSemanticIsTestPath(toFile, rules)) {
      value = "incidental";
      confidence = 0.92;
      evidence.push(localSemanticEvidence("test_path", "At least one edge endpoint is test-only."));
    } else if (fromCriticality === "critical" || toCriticality === "critical") {
      value = "critical";
      confidence = 0.9;
      evidence.push(
        localSemanticEvidence("critical_endpoint", "At least one dependency endpoint is critical.")
      );
    } else if (edge.kind === "CONTAINS" || edge.confidence < 0.65) {
      value = "incidental";
      confidence = 0.78;
      evidence.push(
        localSemanticEvidence(
          "weak_or_structural",
          "Containment or low-confidence evidence is incidental to change propagation."
        )
      );
    } else if (fromCriticality === "important" || toCriticality === "important") {
      value = "important";
      confidence = 0.82;
      evidence.push(
        localSemanticEvidence(
          "contract_endpoint",
          "At least one dependency endpoint is a contract."
        )
      );
    }
    assertions.push(
      localSemanticAssertion(
        edgeSubject,
        "dependency_criticality",
        value,
        confidence,
        "graph-criticality-rules",
        evidence
      )
    );
  }

  const allAssertions = [
    ...new Map(assertions.map((assertion) => [assertion.id, assertion])).values(),
  ].sort((left, right) =>
    `${left.subject}:${left.predicate}:${String(left.value)}`.localeCompare(
      `${right.subject}:${right.predicate}:${String(right.value)}`
    )
  );
  const assertionLimit = (options.scope ?? "repository") === "impact" ? 2000 : 5000;
  const returnedAssertions = allAssertions.slice(0, assertionLimit);
  const allPublicContracts = allAssertions.filter(
    (assertion) =>
      assertion.predicate === "public_api" || assertion.predicate === "implicit_contract"
  );
  const allArchitectureRoles = allAssertions.filter(
    (assertion) => assertion.predicate === "architecture_role"
  );
  const allDependencyCriticality = allAssertions.filter(
    (assertion) => assertion.predicate === "dependency_criticality"
  );
  const publicContracts = returnedAssertions.filter(
    (assertion) =>
      assertion.predicate === "public_api" || assertion.predicate === "implicit_contract"
  );
  const architectureRoles = returnedAssertions.filter(
    (assertion) => assertion.predicate === "architecture_role"
  );
  const dependencyCriticality = returnedAssertions.filter(
    (assertion) => assertion.predicate === "dependency_criticality"
  );
  return {
    version: "snipara.semantic.v1",
    extractorVersion: 1,
    source: "deterministic-graph-inference",
    modelType: "rule-based-heuristic",
    scoreContract: {
      kind: "heuristic_prior",
      calibrated: false,
      probability: false,
      comparableAcrossProjects: false,
      basis: "hand-tuned-v1",
      rulesetVersion: 1,
      interpretation:
        "Relative rule strength for ranking and explanation; not an observed probability.",
    },
    ruleConfig: {
      version: LOCAL_SEMANTIC_RULE_CONFIG_VERSION,
      source: rules.source,
      path: ".snipara/semantic-rules.json",
      replaceDefaults: rules.replaceDefaults,
      sensitivePathTermCount: rules.sensitivePathTerms.length,
      contractPathTermCount: rules.contractPathTerms.length,
      testPathTermCount: rules.testPathTerms.length,
      architectureRoleTermCount: Object.values(rules.architectureRoleTerms).reduce(
        (total, terms) => total + terms.length,
        0
      ),
      configuredRoles: Object.keys(rules.architectureRoleTerms).sort(),
      configHash: sha256(
        JSON.stringify({
          replaceDefaults: rules.replaceDefaults,
          sensitivePathTerms: rules.sensitivePathTerms,
          contractPathTerms: rules.contractPathTerms,
          testPathTerms: rules.testPathTerms,
          architectureRoleTerms: rules.architectureRoleTerms,
        })
      ).slice(0, 16),
      warnings: rules.warnings,
    },
    scope: options.scope ?? "repository",
    assertions: returnedAssertions,
    publicContracts,
    architectureRoles,
    dependencyCriticality,
    truncation: {
      truncated: allAssertions.length > assertionLimit,
      totalAssertionCount: allAssertions.length,
      returnedAssertionCount: returnedAssertions.length,
      assertionLimit,
    },
    historicalRegression: {
      mode: "shadow",
      sampleThreshold: 3,
      failureEventCount: 0,
      associations: [],
      riskContributionEnabled: false,
      suggestedRiskDelta: 0,
      caveat:
        "The local overlay has no durable regression outcome stream. Historical path learning stays shadow-only until hosted evidence is available.",
    },
    summary: {
      assertionCount: allAssertions.length,
      publicContractCount: allPublicContracts.length,
      architectureRoleCount: allArchitectureRoles.length,
      criticalDependencyCount: allDependencyCriticality.filter(
        (assertion) => assertion.value === "critical"
      ).length,
      criticalEdgeCount: allDependencyCriticality.filter(
        (assertion) => assertion.value === "critical" && assertion.subject.startsWith("edge::")
      ).length,
      incidentalDependencyCount: allDependencyCriticality.filter(
        (assertion) => assertion.value === "incidental"
      ).length,
      historicalAssociationCount: 0,
    },
    caveats: [
      "Semantic assertions are deterministic inferences, not declarations of author intent.",
      "Confidence is an uncalibrated rule-based prior, not a probability or measured accuracy.",
      "Priors are not comparable across projects with different semantic rule configuration.",
      "Name-only architecture patterns use a lower prior than explicit export or path evidence.",
      "Historical regression learning requires hosted outcome evidence and remains shadow-only.",
    ],
  };
}

function loadLocalRiskConfig(repoRoot: string): LocalRiskConfig {
  const defaults: LocalRiskConfig = {
    depthDecay: 0.65,
    criticality: [
      { pattern: "(^|/)(auth|middleware)(/|\\.|$)", weight: 1.8 },
      { pattern: "(^|/)(billing|payments|stripe)(/|\\.|$)", weight: 1.8 },
      { pattern: "(^|/)(schema|migrations|deploy)(/|\\.|$)", weight: 1.6 },
      { pattern: "(^|/)route\\.(ts|tsx|py)$", weight: 1.25 },
    ],
    edgeWeights: { CALLS: 1.3, REFERENCES: 0.8, IMPORTS: 1, CONTAINS: 0.25 },
  };
  const configPath = path.join(repoRoot, ".snipara", "code-risk.json");
  if (!fs.existsSync(configPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<LocalRiskConfig>;
    return {
      depthDecay:
        typeof parsed.depthDecay === "number" && parsed.depthDecay > 0 && parsed.depthDecay <= 1
          ? parsed.depthDecay
          : defaults.depthDecay,
      criticality: Array.isArray(parsed.criticality) ? parsed.criticality : defaults.criticality,
      edgeWeights: { ...defaults.edgeWeights, ...(parsed.edgeWeights ?? {}) },
    };
  } catch {
    return defaults;
  }
}

function buildLocalRisk(
  manifest: LocalCodeOverlayManifest,
  changedFiles: string[],
  traversal: LocalGraphTraversalResult,
  depth: number,
  semantic: LocalSemanticModel
): Record<string, unknown> {
  const config = loadLocalRiskConfig(manifest.repoRoot);
  const allFiles = [
    ...changedFiles,
    ...traversal.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
  ];
  let criticality = 1;
  const criticalMatches: string[] = [];
  for (const rule of config.criticality) {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "i");
    } catch {
      continue;
    }
    if (allFiles.some((filePath) => regex.test(filePath))) {
      criticality = Math.max(criticality, Math.max(1, rule.weight));
      criticalMatches.push(rule.pattern);
    }
  }
  const directFiles = new Set(
    traversal.nodes
      .filter((node) => node.depth === 1)
      .flatMap((node) => (node.filePath ? [node.filePath] : []))
  );
  const transitiveFiles = new Set(
    traversal.nodes
      .filter((node) => node.depth > 1)
      .flatMap((node) => (node.filePath ? [node.filePath] : []))
  );
  let propagation = 0;
  for (const node of traversal.nodes) {
    const lastEdge = node.edges.at(-1);
    const weight = lastEdge ? (config.edgeWeights[lastEdge.kind] ?? 1) : 1;
    propagation += weight * Math.pow(config.depthDecay, Math.max(0, node.depth - 1));
  }
  const resolvedReferenceKeys = new Set(
    manifest.edges
      .filter((edge) => edge.kind === "CALLS" || edge.kind === "REFERENCES")
      .map((edge) => `${edge.from}:${edge.line}`)
  );
  const unresolvedReferences = manifest.references.filter(
    (reference) =>
      changedFiles.includes(reference.filePath) &&
      !resolvedReferenceKeys.has(`${reference.from}:${reference.line}`)
  ).length;
  const uncertaintyPenalty = Math.min(15, unresolvedReferences * 2 + (traversal.truncated ? 8 : 0));
  const criticalSemanticDependencies = semantic.summary.criticalEdgeCount;
  const changedSymbolKeys = new Set(
    manifest.symbols
      .filter((symbol) => changedFiles.includes(symbol.filePath))
      .map((symbol) => symbol.localKey)
  );
  const semanticRules = loadLocalSemanticRuleConfig(manifest.repoRoot);
  const changedContracts = manifest.symbols
    .filter((symbol) => changedSymbolKeys.has(symbol.localKey))
    .flatMap((symbol) => localSymbolSemanticAssertions(symbol, semanticRules))
    .filter(
      (assertion) =>
        assertion.predicate === "public_api" || assertion.predicate === "implicit_contract"
    ).length;
  const semanticRiskPoints =
    Math.min(20, criticalSemanticDependencies * 3) + Math.min(10, changedContracts * 2);
  const rawScore =
    criticality * (directFiles.size * 8 + propagation * 4) +
    uncertaintyPenalty +
    semanticRiskPoints;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const reasons = [
    `${directFiles.size} direct dependent file${directFiles.size === 1 ? "" : "s"}`,
    `${transitiveFiles.size} transitive dependent file${transitiveFiles.size === 1 ? "" : "s"}`,
    ...(criticalMatches.length ? [`critical-surface multiplier ${criticality.toFixed(2)}`] : []),
    ...(unresolvedReferences
      ? [`${unresolvedReferences} unresolved reference${unresolvedReferences === 1 ? "" : "s"}`]
      : []),
    ...(criticalSemanticDependencies
      ? [
          `${criticalSemanticDependencies} critical semantic dependenc${
            criticalSemanticDependencies === 1 ? "y" : "ies"
          }`,
        ]
      : []),
    ...(changedContracts
      ? [
          `${changedContracts} public or implicit contract assertion${changedContracts === 1 ? "" : "s"}`,
        ]
      : []),
    ...(traversal.truncated ? ["traversal truncated by max-nodes"] : []),
  ];
  return {
    score,
    level: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    depth,
    directDependentFiles: directFiles.size,
    transitiveDependentFiles: transitiveFiles.size,
    criticality,
    uncertaintyPenalty,
    semanticRiskPoints,
    criticalSemanticDependencies,
    changedContracts,
    unresolvedReferences,
    reasons,
    formula:
      "criticality * (directImpact + decayedEdgePropagation) + uncertaintyPenalty + semanticRiskPoints",
  };
}

function missingTargetDetail(
  manifest: LocalCodeOverlayManifest,
  filePath: string
): Record<string, unknown> {
  const excluded = manifest.excluded.samples.find((sample) => sample.path === filePath);
  if (!excluded) {
    const hitFileLimit = manifest.warnings.some(
      (warning) => warning.code === "local_overlay_file_limit_reached"
    );
    return {
      path: filePath,
      reason: "not_in_overlay",
      remediation: hitFileLimit
        ? "The overlay reached --max-files before this target was indexed. Increase --max-files and rebuild without --cached."
        : "Rebuild without --cached, then check the path, .sniparaignore, supported language, or generated-file state.",
    };
  }

  const remediationByReason: Record<LocalCodeOverlayExcludedFile["reason"], string> = {
    ignored:
      "Remove or narrow the matching .sniparaignore/default ignore rule if this file should be indexed.",
    unsupported_language:
      "Local overlay impact currently indexes TypeScript, TSX, Python, and Go files.",
    too_large:
      "This file is above the local overlay size limit. Split the generated file or raise maxFileBytes in the local overlay builder.",
    secret_pattern:
      "Rebuild without --cached so secret-like lines can be redacted and the file can stay in the graph; inspect the reported line if it should be changed.",
    read_error: "The file could not be read from the selected working tree or commit.",
  };

  return {
    path: filePath,
    reason: excluded.reason,
    ...(excluded.line ? { line: excluded.line } : {}),
    remediation: remediationByReason[excluded.reason],
  };
}

function buildMissingTargetsWarning(
  manifest: LocalCodeOverlayManifest,
  missingTargetFiles: string[]
): LocalCodeOverlayWarning | null {
  if (missingTargetFiles.length === 0) {
    return null;
  }
  const details = missingTargetFiles.map((filePath) => missingTargetDetail(manifest, filePath));
  const reasons = [...new Set(details.map((detail) => String(detail.reason)))];
  const remediation = [...new Set(details.map((detail) => String(detail.remediation)))].join(" ");
  return {
    code: "local_impact_targets_missing",
    severity: "warning",
    message:
      "One or more requested impact targets are not present in the selected local overlay. " +
      remediation,
    files: missingTargetFiles,
    reasons,
    details,
  };
}

function parseSecretWarningSamples(value: unknown): SecretWarningSample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const pathValue = typeof record.path === "string" ? record.path : undefined;
    const lines = Array.isArray(record.lines)
      ? record.lines.filter((line): line is number => typeof line === "number")
      : [];
    const reasons = Array.isArray(record.reasons)
      ? record.reasons.filter((reason): reason is string => typeof reason === "string")
      : [];
    return pathValue && lines.length > 0 ? [{ path: pathValue, lines, reasons }] : [];
  });
}

function impactOverlayWarnings(
  warnings: LocalCodeOverlayWarning[],
  relevantFiles: Set<string>
): LocalCodeOverlayWarning[] {
  return warnings.flatMap((warning) => {
    if (warning.code === "local_overlay_file_limit_reached") {
      return [warning];
    }
    if (warning.code !== "secret_like_lines_redacted") {
      return [];
    }

    const samples = parseSecretWarningSamples(warning.samples).filter((sample) =>
      relevantFiles.has(sample.path)
    );
    if (samples.length === 0) {
      return [];
    }
    return [
      {
        ...warning,
        message: formatSecretWarningMessage(samples),
        samples,
      },
    ];
  });
}

function printLocalQueryResult(result: Record<string, unknown>, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.bold(String(result.title ?? "Local code overlay query")));
  console.log(JSON.stringify(result, null, 2));
}

function localOverlaySelection(
  requested: CodeGraphSource,
  reason: string,
  manifest: LocalCodeOverlayManifest,
  aheadCount: number | null,
  dirtyFiles: string[]
): CodeGraphSourceSelection {
  return {
    requested,
    selected: "local_overlay",
    reason,
    guidance: localOverlayGuidance(reason),
    repositoryId: manifest.repositoryId,
    branch: manifest.branch,
    localHeadSha: manifest.localHeadSha,
    baseSha: manifest.baseSha,
    aheadCount,
    dirtyFileCount: dirtyFiles.length,
    dirtyFilesSample: dirtyFiles.slice(0, 12),
    localOverlay: {
      indexedAt: manifest.indexedAt,
      overlayKind: manifest.overlayKind,
      dirtyTreeHash: manifest.dirtyTreeHash,
      currentWorkingTreeVisible: manifest.currentWorkingTreeVisible,
      fileCount: manifest.files.length,
      symbolCount: manifest.symbols.length,
      importCount: manifest.imports.length,
      edgeCount: manifest.edges.length,
      warnings: manifest.warnings,
    },
    hosted: {
      configured: isConfigured({ cwd: manifest.repoRoot }),
    },
    limitations: [
      "local overlay uses compiler-AST edges for TypeScript and import-level fallback for Python and Go",
      "unresolved dynamic dispatch and runtime reflection remain outside deterministic local analysis",
      ...(reason === "fallback_hosted_not_configured" || reason === "hybrid_hosted_not_configured"
        ? ["hosted enrichment was requested but this workspace is not configured"]
        : []),
    ],
  };
}

function hostedSelection(
  requested: CodeGraphSource,
  reason: string,
  repoRoot: string,
  result: unknown
): CodeGraphSourceSelection {
  const branch = readBranch(repoRoot);
  const localHeadSha = readHeadSha(repoRoot);
  const baseSha = readBaseSha(repoRoot, branch);
  const dirtyStatus = readGitStatus(repoRoot);
  const dirtyFiles = parseDirtyFiles(dirtyStatus);
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return {
    requested,
    selected: "hosted_graph",
    reason,
    guidance: hostedGraphGuidance(reason, dirtyFiles.length),
    repositoryId: readRemoteRepositoryId(repoRoot),
    branch,
    localHeadSha,
    baseSha,
    aheadCount: readAheadCount(repoRoot),
    dirtyFileCount: dirtyFiles.length,
    dirtyFilesSample: dirtyFiles.slice(0, 12),
    hosted: {
      configured: true,
      indexFreshness: record.index_freshness,
      contextScope: record.context_scope,
    },
    limitations: dirtyFiles.length
      ? ["hosted graph does not include current uncommitted edits"]
      : [],
  };
}

function hybridSelection(
  requested: CodeGraphSource,
  reason: string,
  manifest: LocalCodeOverlayManifest,
  aheadCount: number | null,
  dirtyFiles: string[],
  hostedResult: unknown,
  hostedError?: string
): CodeGraphSourceSelection {
  const hostedRecord =
    hostedResult && typeof hostedResult === "object"
      ? (hostedResult as Record<string, unknown>)
      : {};
  return {
    requested,
    selected: "hybrid_graph",
    reason,
    guidance: [
      "Hosted graph is the canonical committed base; the local overlay contributes checkout-only structure.",
      "Inspect result.provenance before relying on an edge that exists in only one source.",
      ...(hostedError
        ? [
            "Hosted enrichment failed, so this response contains only the local delta with explicit degraded provenance.",
          ]
        : []),
    ],
    repositoryId: manifest.repositoryId,
    branch: manifest.branch,
    localHeadSha: manifest.localHeadSha,
    baseSha: manifest.baseSha,
    aheadCount,
    dirtyFileCount: dirtyFiles.length,
    dirtyFilesSample: dirtyFiles.slice(0, 12),
    localOverlay: {
      indexedAt: manifest.indexedAt,
      overlayKind: manifest.overlayKind,
      dirtyTreeHash: manifest.dirtyTreeHash,
      currentWorkingTreeVisible: manifest.currentWorkingTreeVisible,
      fileCount: manifest.files.length,
      symbolCount: manifest.symbols.length,
      importCount: manifest.imports.length,
      edgeCount: manifest.edges.length,
      warnings: manifest.warnings,
    },
    hosted: {
      configured: isConfigured({ cwd: manifest.repoRoot }),
      indexFreshness: hostedRecord.index_freshness,
      contextScope: hostedRecord.context_scope,
      ...(hostedError ? { error: hostedError } : {}),
    },
    limitations: [
      "cross-source edges are not synthesized when stable symbol identities differ",
      "dynamic dispatch and runtime reflection remain outside deterministic local analysis",
      ...(hostedError ? ["hosted graph was unavailable for this request"] : []),
    ],
  };
}

function localOverlayGuidance(reason: string): string[] {
  const selectedBecause =
    reason === "working_tree_dirty"
      ? "Local overlay selected because the working tree has uncommitted edits."
      : reason === "local_head_ahead_of_upstream"
        ? "Local overlay selected because local commits are ahead of upstream."
        : reason === "hosted_not_configured"
          ? "Local overlay selected because hosted Snipara is not configured."
          : reason === "fallback_hosted_not_configured" || reason === "hybrid_hosted_not_configured"
            ? "Local overlay selected because hosted enrichment was requested but Snipara is not configured."
            : reason === "auto_local_default"
              ? "Local overlay selected by default; no account or network call is required."
              : "Local overlay selected by request.";
  return [
    selectedBecause,
    "Use --source hosted after login when you want shared team context, cloud indexing, or cross-machine graph state.",
  ];
}

function hostedGraphGuidance(reason: string, dirtyFileCount: number): string[] {
  if (dirtyFileCount > 0) {
    return [
      "Hosted graph selected even though the working tree is dirty; this does not include uncommitted edits.",
      "Rerun with --source local before relying on local-change impact.",
    ];
  }
  if (reason === "source_forced_hosted") {
    return [
      "Hosted graph selected by request; use --source local for account-free checkout-local impact.",
    ];
  }
  return [
    "Hosted graph selected by request; use --source local when this checkout should stay fully local.",
  ];
}

function resolveRequestedCodeGraphSource(value: unknown): CodeGraphSource {
  if (value === undefined || value === null || value === "") return "auto";
  if (value === "auto" || value === "local" || value === "hosted" || value === "hybrid") {
    return value;
  }
  throw new Error("--source must be one of: auto, local, hosted, hybrid");
}

export function resolveCodeGraphMode(args: {
  requested: CodeGraphSource;
  dirtyFiles: string[];
  aheadCount: number | null;
  hostedConfigured: boolean;
  fallbackHosted: boolean;
}): { selected: ResolvedCodeGraphSource; reason: string } {
  if (args.fallbackHosted && args.requested !== "hosted") {
    return args.hostedConfigured
      ? { selected: "hybrid_graph", reason: "fallback_hosted_requested" }
      : { selected: "local_overlay", reason: "fallback_hosted_not_configured" };
  }
  if (args.requested === "local") {
    return { selected: "local_overlay", reason: "source_forced_local" };
  }
  if (args.requested === "hosted") {
    return { selected: "hosted_graph", reason: "source_forced_hosted" };
  }
  if (args.requested === "hybrid") {
    return args.hostedConfigured
      ? { selected: "hybrid_graph", reason: "source_forced_hybrid" }
      : { selected: "local_overlay", reason: "hybrid_hosted_not_configured" };
  }
  if (args.dirtyFiles.length > 0) {
    return {
      selected: args.hostedConfigured ? "hybrid_graph" : "local_overlay",
      reason: "working_tree_dirty",
    };
  }
  if ((args.aheadCount ?? 0) > 0) {
    return {
      selected: args.hostedConfigured ? "hybrid_graph" : "local_overlay",
      reason: "local_head_ahead_of_upstream",
    };
  }
  if (!args.hostedConfigured) {
    return { selected: "local_overlay", reason: "auto_local_default" };
  }
  return { selected: "hosted_graph", reason: "auto_hosted_clean_checkout" };
}

function collectStringValues(value: unknown, keys: Set<string>, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, keys, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && Array.isArray(item)) {
      for (const candidate of item) {
        if (typeof candidate === "string") result.add(candidate);
        if (candidate && typeof candidate === "object") {
          const record = candidate as Record<string, unknown>;
          const filePath = record.filePath ?? record.file_path ?? record.path;
          if (typeof filePath === "string") result.add(filePath);
        }
      }
    }
    collectStringValues(item, keys, result);
  }
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function mergeResultArrays(records: Record<string, unknown>[], keys: string[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const identity = typeof item === "string" ? item : JSON.stringify(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(item);
      }
    }
  }
  return merged;
}

function hybridRisk(local: Record<string, unknown>, hosted: Record<string, unknown>): unknown {
  const candidates = [
    { source: "local_overlay", value: asUnknownRecord(local.risk) },
    { source: "hosted_graph", value: asUnknownRecord(hosted.risk) },
  ].filter((candidate) => Object.keys(candidate.value).length > 0);
  if (candidates.length === 0) return undefined;
  const rank = (candidate: (typeof candidates)[number]): number => {
    const score = candidate.value.score;
    if (typeof score === "number") return score;
    return candidate.value.level === "high" ? 70 : candidate.value.level === "medium" ? 35 : 0;
  };
  const selected = [...candidates].sort((left, right) => rank(right) - rank(left))[0];
  return {
    ...selected.value,
    source: selected.source,
    sourceScores: Object.fromEntries(
      candidates.map((candidate) => [candidate.source, candidate.value.score ?? null])
    ),
  };
}

function hybridSemantic(
  local: Record<string, unknown>,
  hosted: Record<string, unknown>
): Record<string, unknown> | undefined {
  const localSemantic = asUnknownRecord(local.semantic);
  const hostedSemantic = asUnknownRecord(hosted.semantic);
  if (Object.keys(localSemantic).length === 0 && Object.keys(hostedSemantic).length === 0) {
    return undefined;
  }
  const assertions = mergeResultArrays(
    [{ assertions: hostedSemantic.assertions }, { assertions: localSemantic.assertions }],
    ["assertions"]
  );
  return {
    version: "snipara.semantic.hybrid.v1",
    mode: "hybrid",
    provenance: {
      canonicalBase: Object.keys(hostedSemantic).length > 0 ? "hosted_graph" : "unavailable",
      checkoutDelta: Object.keys(localSemantic).length > 0 ? "local_overlay" : "unavailable",
      crossSourceAssertionSynthesis: false,
    },
    assertions,
    summary: {
      assertionCount: assertions.length,
      publicContractCount: assertions.filter(
        (item) =>
          asUnknownRecord(item).predicate === "public_api" ||
          asUnknownRecord(item).predicate === "implicit_contract"
      ).length,
      architectureRoleCount: assertions.filter(
        (item) => asUnknownRecord(item).predicate === "architecture_role"
      ).length,
      criticalDependencyCount: assertions.filter(
        (item) =>
          asUnknownRecord(item).predicate === "dependency_criticality" &&
          asUnknownRecord(item).value === "critical"
      ).length,
    },
    historicalRegression:
      hostedSemantic.historical_regression ??
      hostedSemantic.historicalRegression ??
      localSemantic.historicalRegression ??
      null,
    local: Object.keys(localSemantic).length > 0 ? localSemantic : null,
    hosted: Object.keys(hostedSemantic).length > 0 ? hostedSemantic : null,
  };
}

export function mergeHybridCodeResults(
  verb: CodeGraphVerb,
  localResult: unknown,
  hostedResult: unknown,
  hostedError?: string
): Record<string, unknown> {
  const local = asUnknownRecord(localResult);
  const hosted = asUnknownRecord(hostedResult);
  const affectedFiles = new Set<string>();
  const affectedKeys = new Set([
    "affected_files",
    "affectedFiles",
    "impactedFiles",
    "transitiveFiles",
    "changedFiles",
    "test_files",
    "testFiles",
  ]);
  collectStringValues(local, affectedKeys, affectedFiles);
  collectStringValues(hosted, affectedKeys, affectedFiles);
  const changedFiles = new Set<string>();
  collectStringValues(local, new Set(["changed_files", "changedFiles"]), changedFiles);
  collectStringValues(hosted, new Set(["changed_files", "changedFiles"]), changedFiles);
  const risk = hybridRisk(local, hosted);
  const semantic = hybridSemantic(local, hosted);
  const recommendedTests = mergeResultArrays(
    [hosted, local],
    ["recommended_tests", "recommendedTests", "related_tests", "relatedTests", "tests"]
  );
  const recommendedActions = mergeResultArrays(
    [hosted, local],
    ["recommended_actions", "recommendedActions"]
  );
  const coverageGaps = mergeResultArrays([hosted, local], ["coverage_gaps", "coverageGaps"]);
  const warnings = mergeResultArrays([hosted, local], ["warnings"]);
  return {
    title: `Hybrid ${verb}`,
    mode: hostedError ? "hybrid_degraded_local" : "hybrid",
    provenance: {
      canonicalBase: hostedError ? "unavailable" : "hosted_graph",
      checkoutDelta: "local_overlay",
      mergeStrategy: "provenance_preserving_union",
      crossSourceEdgeSynthesis: false,
      ...(hostedError ? { hostedError } : {}),
    },
    merged: {
      affectedFiles: [...affectedFiles].sort(),
      affectedFileCount: affectedFiles.size,
    },
    changed_files: [...changedFiles].sort(),
    impactedFiles: [...affectedFiles].sort(),
    ...(risk ? { risk } : {}),
    ...(semantic ? { semantic } : {}),
    recommended_tests: recommendedTests,
    recommended_actions: recommendedActions,
    coverage_gaps: coverageGaps,
    warnings,
    ...(hosted.index_freshness !== undefined ? { index_freshness: hosted.index_freshness } : {}),
    ...(hosted.impact !== undefined ? { impact: hosted.impact } : {}),
    local: localResult,
    hosted: hostedError ? null : hostedResult,
  };
}

function buildLocalResultForVerb(
  verb: CodeGraphVerb,
  options: CodeGraphAutoSourceOptions
): Record<string, unknown> {
  switch (verb) {
    case "callers":
      return buildLocalCallersResult(options);
    case "imports":
      return buildLocalImportsResult(options);
    case "neighbors":
      return buildLocalNeighborsResult(options);
    case "shortest-path":
      return buildLocalShortestPathResult(options);
    case "impact":
      return buildLocalImpactResult(options);
  }
}

async function callHostedCodeTool(
  verb: CodeGraphVerb,
  options: CodeGraphAutoSourceOptions
): Promise<unknown> {
  const client = createClient(verb === "impact" ? 30000 : 15000, {
    cwd: options.dir,
  });

  switch (verb) {
    case "callers": {
      if (!options.qualifiedName && !options.symbolKey) {
        throw new Error("Provide --qualified-name or --symbol-key");
      }
      return client.codeCallers(options.qualifiedName ?? "", {
        symbolKey: options.symbolKey,
        depth: options.depth,
        limit: options.limit,
      });
    }
    case "imports": {
      if (!options.qualifiedName && !options.symbolKey && !options.filePath) {
        throw new Error("Provide --qualified-name, --symbol-key, or --file-path");
      }
      return client.codeImports({
        qualifiedName: options.qualifiedName,
        symbolKey: options.symbolKey,
        filePath: options.filePath,
        direction: options.direction === "in" ? "in" : "out",
        includeFileNodes: options.includeFileNodes,
        limit: options.limit,
      });
    }
    case "neighbors": {
      if (!options.qualifiedName && !options.symbolKey) {
        throw new Error("Provide --qualified-name or --symbol-key");
      }
      return client.codeNeighbors(options.qualifiedName ?? "", {
        symbolKey: options.symbolKey,
        depth: options.depth,
        edgeKinds: options.edgeKinds,
        limit: options.limit,
      });
    }
    case "shortest-path": {
      if (!options.from || !options.to) {
        throw new Error("Provide --from and --to");
      }
      return client.codeShortestPath(options.from, options.to, {
        edgeKinds: options.edgeKinds,
        maxHops: options.maxHops,
      });
    }
    case "impact": {
      if (
        !options.qualifiedName &&
        !options.symbolKey &&
        !options.filePath &&
        (!options.changedFiles || options.changedFiles.length === 0)
      ) {
        throw new Error("Provide --qualified-name, --symbol-key, --file-path, or --changed-files");
      }
      return client.codeImpact({
        qualifiedName: options.qualifiedName,
        symbolKey: options.symbolKey,
        filePath: options.filePath,
        changedFiles: options.changedFiles,
        diffSummary: options.diffSummary,
        depth: options.depth,
        direction: traversalDirection(options.direction),
        edgeKinds: options.edgeKinds,
        limit: options.limit,
      });
    }
  }
}

function printCodeGraphAutoSourceResult(result: CodeGraphAutoSourceResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.sourceSelection.selected === "local_overlay" && isLocalImpactResult(result.result)) {
    printLocalImpactHumanResult(result);
    return;
  }

  console.log(chalk.bold(result.title));
  console.log(`Source: ${result.sourceSelection.selected}`);
  console.log(`Reason: ${result.sourceSelection.reason}`);
  for (const guidance of result.sourceSelection.guidance) {
    console.log(`Guidance: ${guidance}`);
  }
  console.log(`Repo: ${result.sourceSelection.repositoryId}`);
  console.log(`Branch: ${result.sourceSelection.branch ?? "unknown"}`);
  console.log(`HEAD: ${result.sourceSelection.localHeadSha ?? "unknown"}`);
  if (result.sourceSelection.aheadCount !== null) {
    console.log(`Ahead of upstream: ${result.sourceSelection.aheadCount}`);
  }
  console.log(`Dirty files: ${result.sourceSelection.dirtyFileCount}`);
  if (result.sourceSelection.localOverlay) {
    console.log(`Overlay indexed: ${result.sourceSelection.localOverlay.indexedAt}`);
    console.log(`Overlay kind: ${result.sourceSelection.localOverlay.overlayKind}`);
  }
  if (result.sourceSelection.limitations.length > 0) {
    console.log(`Limitations: ${result.sourceSelection.limitations.join("; ")}`);
  }
  console.log("");
  console.log(JSON.stringify(result.result, null, 2));
}

function isLocalImpactResult(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).title === "Local impact" &&
    Array.isArray((value as Record<string, unknown>).incoming) &&
    Array.isArray((value as Record<string, unknown>).outgoing)
  );
}

function printLocalImpactHumanResult(result: CodeGraphAutoSourceResult): void {
  const impact = result.result as Record<string, unknown>;
  const target = formatLocalImpactTarget(impact);
  const incoming = uniqueEdgeFiles(impact.incoming, "from");
  const outgoing = uniqueEdgeFiles(impact.outgoing, "to");
  const warnings = Array.isArray(impact.warnings) ? impact.warnings : [];
  const missingTargets = Array.isArray(impact.missingTargetFiles)
    ? impact.missingTargetFiles.filter((item): item is string => typeof item === "string")
    : [];
  const missingTargetDetails = extractMissingTargetDetails(impact.missingTargetDetails);

  console.log(chalk.bold(`Code impact - local - ${target}`));
  console.log(`Source: ${result.sourceSelection.selected}`);
  console.log(`Reason: ${result.sourceSelection.reason}`);
  console.log("");
  printFileList("Incoming", "files that depend on this", incoming);
  console.log("");
  printFileList("Outgoing", "files this depends on", outgoing);

  if (missingTargets.length > 0) {
    console.log("");
    console.log(chalk.yellow(`Missing targets (${missingTargets.length})`));
    for (const filePath of missingTargets.slice(0, 12)) {
      const detail = missingTargetDetails.get(filePath);
      console.log(`  ${filePath}${detail ? ` (${detail})` : ""}`);
    }
    if (missingTargets.length > 12) {
      console.log(`  ... ${missingTargets.length - 12} more`);
    }
  }

  if (warnings.length > 0) {
    console.log("");
    console.log(chalk.yellow(`Warnings (${warnings.length})`));
    for (const warning of warnings.slice(0, 4)) {
      console.log(`  ${formatWarning(warning)}`);
    }
    if (warnings.length > 4) {
      console.log(`  ... ${warnings.length - 4} more`);
    }
  }

  console.log("");
  console.log("Use --json for full overlay details.");
}

function formatLocalImpactTarget(impact: Record<string, unknown>): string {
  const target = impact.target;
  if (target && typeof target === "object") {
    const record = target as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    const filePath = typeof record.filePath === "string" ? record.filePath : undefined;
    const changedFiles = Array.isArray(record.changedFiles)
      ? record.changedFiles.filter((item): item is string => typeof item === "string")
      : [];
    if (name && filePath) {
      return `${name} (${filePath})`;
    }
    if (filePath) {
      return filePath;
    }
    if (changedFiles.length === 1) {
      return changedFiles[0];
    }
    if (changedFiles.length > 1) {
      return `${changedFiles.length} files`;
    }
  }
  return "selected target";
}

function uniqueEdgeFiles(value: unknown, field: "from" | "to"): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) =>
          item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined
        )
        .filter((item): item is string => typeof item === "string")
    ),
  ].sort();
}

function extractMissingTargetDetails(value: unknown): Map<string, string> {
  const details = new Map<string, string>();
  if (!Array.isArray(value)) {
    return details;
  }

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const pathValue = typeof record.path === "string" ? record.path : undefined;
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    const line = typeof record.line === "number" ? record.line : undefined;
    if (!pathValue || !reason) {
      continue;
    }
    details.set(pathValue, line ? `excluded: ${reason} at line ${line}` : `excluded: ${reason}`);
  }

  return details;
}

function printFileList(title: string, description: string, files: string[]): void {
  const displayLimit = 12;
  console.log(`${title} (${files.length}) - ${description}`);
  if (files.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const filePath of files.slice(0, displayLimit)) {
    console.log(`  ${filePath}`);
  }
  if (files.length > displayLimit) {
    console.log(`  ... ${files.length - displayLimit} more`);
  }
}

function formatWarning(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "warning";
  const message = typeof record.message === "string" ? record.message : "";
  return message ? `${code}: ${message}` : code;
}

function emitCodeSourceTelemetry(
  verb: CodeGraphVerb,
  selection: CodeGraphSourceSelection,
  latencyMs: number
): void {
  // Best-effort adoption telemetry. Metadata only: never file paths, symbols, or query args.
  try {
    void emitCanonicalEvent(
      {
        eventType: "tool_call",
        privacyLevel: "standard",
        payload: {
          kind: "code_graph_source_resolution",
          verb,
          requested_source: selection.requested,
          selected_source: selection.selected,
          reason: selection.reason,
          dirty_file_count: selection.dirtyFileCount,
          ahead_count: selection.aheadCount,
          has_local_overlay: Boolean(selection.localOverlay),
          overlay_kind: selection.localOverlay?.overlayKind ?? null,
          working_tree_visible: selection.localOverlay?.currentWorkingTreeVisible ?? null,
          hosted_configured: selection.hosted?.configured ?? null,
          limitation_count: selection.limitations.length,
          latency_ms: latencyMs,
        },
      },
      { timeoutMs: 1500 }
    ).catch(() => undefined);
  } catch {
    // Telemetry must never affect the command outcome.
  }
}

export async function resolveCodeGraphAutoSourceResult(
  verb: CodeGraphVerb,
  options: CodeGraphAutoSourceOptions
): Promise<CodeGraphAutoSourceResult> {
  const startedAt = Date.now();
  const requested = resolveRequestedCodeGraphSource(options.source);
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const dirtyStatus = readGitStatus(repoRoot);
  const dirtyFiles = parseDirtyFiles(dirtyStatus);
  const aheadCount = readAheadCount(repoRoot);
  const hostedConfigured = isConfigured({ cwd: repoRoot });
  const decision = resolveCodeGraphMode({
    requested,
    dirtyFiles,
    aheadCount,
    hostedConfigured,
    fallbackHosted: options.fallbackHosted === true,
  });

  let autoResult: CodeGraphAutoSourceResult;
  if (decision.selected === "local_overlay") {
    const manifest = loadQueryManifest({
      ...options,
      dir: repoRoot,
      mode: options.mode ?? "working_tree",
    });
    writeLocalCodeOverlayCache(manifest);
    const localOptions = { ...options, dir: repoRoot, cached: true };
    const result = buildLocalResultForVerb(verb, localOptions);
    autoResult = {
      title: `Code ${verb}`,
      sourceSelection: localOverlaySelection(
        requested,
        decision.reason,
        manifest,
        aheadCount,
        dirtyFiles
      ),
      result,
    };
  } else if (decision.selected === "hosted_graph") {
    if (!hostedConfigured) {
      throw new Error(
        "Hosted Snipara is not configured. Use --source local or run snipara-companion code sync."
      );
    }

    const hostedResult = await callHostedCodeTool(verb, { ...options, dir: repoRoot });
    autoResult = {
      title: `Code ${verb}`,
      sourceSelection: hostedSelection(requested, decision.reason, repoRoot, hostedResult),
      result: hostedResult,
    };
  } else {
    const manifest = loadQueryManifest({
      ...options,
      dir: repoRoot,
      mode: options.mode ?? "working_tree",
    });
    writeLocalCodeOverlayCache(manifest);
    const localResult = buildLocalResultForVerb(verb, {
      ...options,
      dir: repoRoot,
      cached: true,
    });
    let hostedResult: unknown = null;
    let hostedError: string | undefined;
    try {
      hostedResult = await callHostedCodeTool(verb, { ...options, dir: repoRoot });
    } catch (error) {
      hostedError = error instanceof Error ? error.message : String(error);
    }
    autoResult = {
      title: `Code ${verb}`,
      sourceSelection: hybridSelection(
        requested,
        decision.reason,
        manifest,
        aheadCount,
        dirtyFiles,
        hostedResult,
        hostedError
      ),
      result: mergeHybridCodeResults(verb, localResult, hostedResult, hostedError),
    };
  }

  emitCodeSourceTelemetry(verb, autoResult.sourceSelection, Date.now() - startedAt);
  return autoResult;
}

export async function codeGraphAutoSourceCommand(
  verb: CodeGraphVerb,
  options: CodeGraphAutoSourceOptions
): Promise<void> {
  const autoResult = await resolveCodeGraphAutoSourceResult(verb, options);
  printCodeGraphAutoSourceResult(autoResult, options.json);
}

export function buildCodeStatusResult(options: CodeStatusCommandOptions): Record<string, unknown> {
  const manifest = buildLocalCodeOverlay({
    cwd: options.dir,
    mode: "working_tree",
    maxFiles: options.maxFiles,
  });
  const cached = readLocalCodeOverlayCache(manifest.repoRoot);
  return {
    current: options.includeGraph ? manifest : summarizeLocalCodeOverlay(manifest),
    cache: cached
      ? options.includeGraph
        ? { path: getLocalCodeOverlayCachePath(manifest.repoRoot), manifest: cached }
        : {
            path: getLocalCodeOverlayCachePath(manifest.repoRoot),
            ...summarizeLocalCodeOverlay(cached),
          }
      : null,
  };
}

export function buildCodeSyncResult(options: CodeSyncCommandOptions): Record<string, unknown> {
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const mode: LocalCodeOverlayMode =
    options.commit && !options.workingTree ? "local_commit" : "working_tree";
  const expectedHeadSha = options.onlyIfHead
    ? resolveCommitSha(repoRoot, options.onlyIfHead)
    : null;
  const currentHeadBefore = readHeadSha(repoRoot);

  if (expectedHeadSha && currentHeadBefore && currentHeadBefore !== expectedHeadSha) {
    return {
      skipped: true,
      skipReason: "head_changed",
      expectedHeadSha,
      currentHeadSha: currentHeadBefore,
      cachePath: getLocalCodeOverlayCachePath(repoRoot),
    };
  }

  const manifest = buildLocalCodeOverlay({
    cwd: repoRoot,
    mode,
    commit: options.commit ?? "HEAD",
    maxFiles: options.maxFiles,
  });
  const currentHeadAfter = readHeadSha(repoRoot);

  if (expectedHeadSha && currentHeadAfter && currentHeadAfter !== expectedHeadSha) {
    return {
      skipped: true,
      skipReason: "head_changed",
      expectedHeadSha,
      currentHeadSha: currentHeadAfter,
      cachePath: getLocalCodeOverlayCachePath(repoRoot),
    };
  }

  const cachePath = writeLocalCodeOverlayCache(manifest);
  return options.includeGraph
    ? { ...manifest, cachePath }
    : { ...summarizeLocalCodeOverlay(manifest), cachePath };
}

export function buildHostedCodeOverlayUploadPayload(
  options: CodeUploadCommandOptions = {}
): HostedCodeOverlayUploadPayload {
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const cached = options.cached ? readLocalCodeOverlayCache(repoRoot) : null;
  if (options.cached && !cached) {
    throw new Error("No cached local code overlay found. Run `snipara-companion code sync` first.");
  }

  const manifest =
    cached ??
    buildLocalCodeOverlay({
      cwd: repoRoot,
      mode: "working_tree",
      maxFiles: options.maxFiles,
    });
  const cachePath = writeLocalCodeOverlayCache(manifest);
  const ttlHours = positiveInteger(
    options.ttlHours,
    DEFAULT_HOSTED_OVERLAY_TTL_HOURS,
    "--ttl-hours"
  );
  if (ttlHours > MAX_HOSTED_OVERLAY_TTL_HOURS) {
    throw new Error(`--ttl-hours must be less than or equal to ${MAX_HOSTED_OVERLAY_TTL_HOURS}.`);
  }
  return {
    manifest,
    cachePath,
    request: {
      overlay: manifest,
      source_client: options.sourceClient ?? "snipara-companion",
      ttl_hours: ttlHours,
      retire_previous: options.retirePrevious !== false,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
    },
  };
}

export function buildLocalImportsResult(
  options: LocalCodeQueryCommandOptions
): Record<string, unknown> {
  const manifest = loadQueryManifest(options);
  const symbol = findSymbol(manifest, options);
  const filePath = options.filePath ?? symbol?.filePath;
  const imports = filePath ? manifest.imports.filter((item) => item.filePath === filePath) : [];
  const edges = buildLocalFileEdges(manifest).filter((edge) => edge.from === filePath);
  return {
    title: "Local imports",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { filePath },
    imports,
    resolvedEdges: edges,
  };
}

export function buildLocalCallersResult(
  options: LocalCodeQueryCommandOptions
): Record<string, unknown> {
  const manifest = loadQueryManifest(options);
  const symbol = findSymbol(manifest, options);
  const targetFile = options.filePath ?? symbol?.filePath;
  const directImportEdges = targetFile
    ? buildLocalFileEdges(manifest).filter((edge) => edge.to === targetFile)
    : [];
  const depth = positiveInteger(options.depth, 1, "--depth");
  const maxNodes = positiveInteger(options.maxNodes, 200, "--max-nodes");
  let seeds = findGraphSeedKeys(manifest, options);
  let edgeKinds = options.edgeKinds?.length ? options.edgeKinds : ["CALLS"];
  const hasIncomingCalls = seeds.some((seed) =>
    manifest.edges.some((edge) => edge.kind === "CALLS" && edge.to === seed)
  );
  if (!hasIncomingCalls && targetFile) {
    seeds = [buildFileNodeKey(targetFile)];
    edgeKinds = ["IMPORTS"];
  }
  const traversal = traverseLocalGraph(manifest, seeds, {
    depth,
    direction: "in",
    edgeKinds,
    maxNodes,
  });
  const callersByFile = new Map<
    string,
    { filePath: string; depth: number; path: string[]; symbols: Record<string, unknown>[] }
  >();
  for (const node of traversal.nodes) {
    if (!node.filePath || node.filePath === targetFile) continue;
    const current = callersByFile.get(node.filePath);
    if (current && current.depth <= node.depth) continue;
    callersByFile.set(node.filePath, {
      filePath: node.filePath,
      depth: node.depth,
      path: node.path,
      symbols: manifest.symbols
        .filter((item) => item.filePath === node.filePath)
        .map(compactSymbol),
    });
  }
  return {
    title: "Local callers",
    caveat:
      "TypeScript callers use compiler-AST call edges; unsupported or unresolved languages fall back to file importers.",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { filePath: targetFile },
    depth,
    edgeKinds,
    callers: [...callersByFile.values()].sort(
      (left, right) => left.depth - right.depth || left.filePath.localeCompare(right.filePath)
    ),
    directImporters: directImportEdges,
    paths: traversal.nodes.map((node) => ({
      depth: node.depth,
      path: node.path,
      edges: node.edges,
    })),
    truncated: traversal.truncated,
    visitedCount: traversal.visitedCount,
  };
}

export function buildLocalNeighborsResult(
  options: LocalCodeQueryCommandOptions
): Record<string, unknown> {
  const manifest = loadQueryManifest(options);
  const symbol = findSymbol(manifest, options);
  const targetFile = options.filePath ?? symbol?.filePath;
  const edges = buildLocalFileEdges(manifest);
  const outgoing = targetFile ? edges.filter((edge) => edge.from === targetFile) : [];
  const incoming = targetFile ? edges.filter((edge) => edge.to === targetFile) : [];
  const depth = positiveInteger(options.depth, 2, "--depth");
  const maxNodes = positiveInteger(options.maxNodes, 200, "--max-nodes");
  const direction = traversalDirection(options.direction);
  const traversal = traverseLocalGraph(manifest, findGraphSeedKeys(manifest, options), {
    depth,
    direction,
    edgeKinds: options.edgeKinds,
    maxNodes,
  });
  return {
    title: "Local neighbors",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { filePath: targetFile },
    fileSymbols: targetFile
      ? manifest.symbols.filter((item) => item.filePath === targetFile).map(compactSymbol)
      : [],
    incoming,
    outgoing,
    depth,
    direction,
    nodes: traversal.nodes.map((node) => graphNodePayload(manifest, node)),
    edges: traversal.traversedEdges,
    paths: traversal.nodes.map((node) => ({
      depth: node.depth,
      path: node.path,
      edges: node.edges,
    })),
    truncated: traversal.truncated,
    visitedCount: traversal.visitedCount,
  };
}

export function buildLocalShortestPathResult(
  options: LocalCodeQueryCommandOptions
): Record<string, unknown> {
  const manifest = loadQueryManifest(options);
  const fromSymbol = findSymbol(manifest, { qualifiedName: options.from });
  const toSymbol = findSymbol(manifest, { qualifiedName: options.to });
  const fromFile = fromSymbol?.filePath ?? options.from;
  const toFile = toSymbol?.filePath ?? options.to;
  const maxHops = positiveInteger(options.maxHops, 6);
  const direction = traversalDirection(options.direction);
  const fromKey = fromSymbol?.localKey ?? (fromFile ? buildFileNodeKey(fromFile) : "");
  const toKey = toSymbol?.localKey ?? (toFile ? buildFileNodeKey(toFile) : "");
  const traversal = traverseLocalGraph(manifest, fromKey ? [fromKey] : [], {
    depth: maxHops,
    direction,
    edgeKinds: options.edgeKinds,
    maxNodes: positiveInteger(options.maxNodes, 500, "--max-nodes"),
  });
  const foundNode = traversal.nodes.find((node) => node.key === toKey);
  const nodePath = foundNode?.path ?? null;
  const found = nodePath
    ? [
        ...new Set(
          nodePath
            .map((key) => graphNodeFilePath(manifest, key))
            .filter((filePath): filePath is string => Boolean(filePath))
        ),
      ]
    : null;

  return {
    title: "Local shortest path",
    scope: summarizeLocalCodeOverlay(manifest),
    from: fromSymbol ? compactSymbol(fromSymbol) : { filePath: fromFile },
    to: toSymbol ? compactSymbol(toSymbol) : { filePath: toFile },
    path: found,
    nodePath,
    edges: foundNode?.edges ?? [],
    found: Boolean(found),
    hops: foundNode?.depth ?? 0,
    direction,
    truncated: traversal.truncated,
    caveat:
      "Shortest path traverses AST calls/references plus resolved imports and containment edges.",
  };
}

export function buildLocalImpactResult(
  options: LocalCodeQueryCommandOptions
): Record<string, unknown> {
  const manifest = loadQueryManifest(options);
  const symbol = findSymbol(manifest, options);
  const selectedFiles = new Set<string>();
  for (const filePath of options.changedFiles ?? []) {
    selectedFiles.add(normalizeRepoPath(filePath));
  }
  if (options.filePath) {
    selectedFiles.add(normalizeRepoPath(options.filePath));
  }
  if (symbol?.filePath) {
    selectedFiles.add(symbol.filePath);
  }

  const edges = buildLocalFileEdges(manifest);
  const manifestFiles = new Set(manifest.files.map((file) => file.path));
  const requestedFiles = [...selectedFiles].sort();
  const changedFiles = requestedFiles.filter((filePath) => manifestFiles.has(filePath));
  const missingTargetFiles = requestedFiles.filter((filePath) => !manifestFiles.has(filePath));
  const incoming = edges.filter((edge) => selectedFiles.has(edge.to));
  const outgoing = edges.filter((edge) => selectedFiles.has(edge.from));
  const directImpactedFiles = [
    ...new Set([...incoming.map((edge) => edge.from), ...outgoing.map((edge) => edge.to)]),
  ].sort();
  const depth = positiveInteger(options.depth, options.transitive === false ? 1 : 3, "--depth");
  const maxNodes = positiveInteger(options.maxNodes, 500, "--max-nodes");
  const direction = traversalDirection(options.direction);
  const changedFileSet = new Set(changedFiles);
  const seedKeys = [
    ...changedFiles.map(buildFileNodeKey),
    ...manifest.symbols
      .filter((candidate) => changedFileSet.has(candidate.filePath))
      .map((candidate) => candidate.localKey),
  ];
  const traversal = traverseLocalGraph(manifest, seedKeys, {
    depth,
    direction,
    edgeKinds: options.edgeKinds?.length ? options.edgeKinds : ["IMPORTS", "CALLS", "REFERENCES"],
    maxNodes,
  });
  const traversalEdges = [
    ...new Map(
      traversal.nodes
        .flatMap((node) => node.edges)
        .map((edge) => [`${edge.from}:${edge.kind}:${edge.to}:${edge.line}`, edge])
    ).values(),
  ];
  const semanticSymbolKeys = new Set([...seedKeys, ...traversal.nodes.map((node) => node.key)]);
  const semanticFiles = new Set([
    ...changedFiles,
    ...traversal.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
  ]);
  for (const candidate of manifest.symbols) {
    if (semanticFiles.has(candidate.filePath)) semanticSymbolKeys.add(candidate.localKey);
  }
  const semantic = buildLocalSemanticModel(manifest, {
    scope: "impact",
    symbolKeys: semanticSymbolKeys,
    edges: traversalEdges,
    semanticRules: loadLocalSemanticRuleConfig(manifest.repoRoot),
  });
  const transitiveFiles = uniqueTraversalFiles(traversal.nodes, selectedFiles);
  const impactedFiles = [...new Set([...directImpactedFiles, ...transitiveFiles])].sort();
  const relevantWarningFiles = new Set<string>([
    ...selectedFiles,
    ...impactedFiles,
    ...incoming.map((edge) => edge.from),
    ...outgoing.map((edge) => edge.to),
  ]);
  const missingTargetsWarning = buildMissingTargetsWarning(manifest, missingTargetFiles);
  const warnings = [
    ...(missingTargetsWarning ? [missingTargetsWarning] : []),
    ...impactOverlayWarnings(manifest.warnings, relevantWarningFiles),
  ];

  return {
    title: "Local impact",
    caveat:
      "Local impact traverses TypeScript AST calls/references plus resolved file imports from the current checkout; Python and Go use import fallback.",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { changedFiles, missingTargetFiles },
    changedFiles,
    missingTargetFiles,
    missingTargetDetails: missingTargetsWarning?.details ?? [],
    warnings,
    symbols: manifest.symbols.filter((item) => selectedFiles.has(item.filePath)).map(compactSymbol),
    incoming,
    outgoing,
    impactedFiles,
    transitiveFiles,
    depth,
    direction,
    impactChains: traversal.nodes.map((node) => ({
      target: node.filePath,
      depth: node.depth,
      path: node.path,
      edges: node.edges,
    })),
    traversal: {
      truncated: traversal.truncated,
      visitedCount: traversal.visitedCount,
      maxNodes,
    },
    semantic,
    risk: buildLocalRisk(manifest, changedFiles, traversal, depth, semantic),
  };
}

export async function codeLocalImportsCommand(
  options: LocalCodeQueryCommandOptions
): Promise<void> {
  printLocalQueryResult(buildLocalImportsResult(options), options.json);
}

export async function codeLocalCallersCommand(
  options: LocalCodeQueryCommandOptions
): Promise<void> {
  printLocalQueryResult(buildLocalCallersResult(options), options.json);
}

export async function codeLocalNeighborsCommand(
  options: LocalCodeQueryCommandOptions
): Promise<void> {
  printLocalQueryResult(buildLocalNeighborsResult(options), options.json);
}

export async function codeLocalShortestPathCommand(
  options: LocalCodeQueryCommandOptions
): Promise<void> {
  printLocalQueryResult(buildLocalShortestPathResult(options), options.json);
}

export async function codeLocalImpactCommand(options: LocalCodeQueryCommandOptions): Promise<void> {
  printLocalQueryResult(buildLocalImpactResult(options), options.json);
}

export async function codeStatusCommand(options: CodeStatusCommandOptions): Promise<void> {
  const result = buildCodeStatusResult(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const manifest = buildLocalCodeOverlay({
    cwd: options.dir,
    mode: "working_tree",
    maxFiles: options.maxFiles,
  });
  const cached = readLocalCodeOverlayCache(manifest.repoRoot);
  printManifestSummary(
    manifest,
    cached ? getLocalCodeOverlayCachePath(manifest.repoRoot) : undefined
  );
}

export async function codeSyncCommand(options: CodeSyncCommandOptions): Promise<void> {
  const result = buildCodeSyncResult(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.skipped) {
    console.log(chalk.bold("Local Code Overlay"));
    console.log(`Skipped: ${String(result.skipReason ?? "unknown")}`);
    console.log(`Expected HEAD: ${String(result.expectedHeadSha ?? "unknown")}`);
    console.log(`Current HEAD: ${String(result.currentHeadSha ?? "unknown")}`);
    return;
  }

  const mode: LocalCodeOverlayMode =
    options.commit && !options.workingTree ? "local_commit" : "working_tree";
  const manifest = buildLocalCodeOverlay({
    cwd: options.dir,
    mode,
    commit: options.commit ?? "HEAD",
    maxFiles: options.maxFiles,
  });
  const cachePath = writeLocalCodeOverlayCache(manifest);
  printManifestSummary(manifest, cachePath);
}

export async function codeUploadCommand(options: CodeUploadCommandOptions): Promise<void> {
  const payload = buildHostedCodeOverlayUploadPayload(options);
  const result = await createClient(30000, { cwd: payload.manifest.repoRoot }).callTool<
    Record<string, unknown>
  >("snipara_local_code_overlay_upload", payload.request);
  const output = { ...result, cachePath: payload.cachePath };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(chalk.bold("Hosted Local Code Overlay"));
  const overlay = (result.overlay ?? {}) as Record<string, unknown>;
  console.log(`Overlay: ${String(overlay.id ?? "uploaded")}`);
  console.log(`Repo: ${payload.manifest.repositoryId}`);
  console.log(`Branch: ${payload.manifest.branch ?? "unknown"}`);
  console.log(`Expires: ${String(result.expires_at ?? "unknown")}`);
  console.log(`Cache: ${payload.cachePath}`);
  console.log("Canonical graph: unchanged until hosted code reindex completes.");
}

function hookBlockMarker(hookName: string, type: "start" | "end"): string {
  return `# ${HOOK_BLOCK_PREFIX} ${hookName}:${type}`;
}

function buildGitHookBlock(
  hookName: "post-commit" | "pre-push",
  options: CodeHooksInstallCommandOptions
): string {
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const reindexDelaySeconds = nonNegativeInteger(
    options.reindexDelaySeconds,
    DEFAULT_HOOK_REINDEX_DELAY_SECONDS
  );
  const requestReindex = options.requestReindex !== false;
  const syncWithHeadGuard =
    'snipara-companion code sync --commit "$SNIPARA_CODE_OVERLAY_HEAD" --only-if-head "$SNIPARA_CODE_OVERLAY_HEAD" --max-files "$SNIPARA_CODE_OVERLAY_MAX_FILES" --json';
  const syncFallback =
    'snipara-companion code sync --commit "$SNIPARA_CODE_OVERLAY_HEAD" --max-files "$SNIPARA_CODE_OVERLAY_MAX_FILES" --json';
  const syncCommand = `${syncWithHeadGuard} || ${syncFallback}`;
  const promoteCommand = [
    'snipara-companion code promote --from-hook pre-push --max-files "$SNIPARA_CODE_OVERLAY_MAX_FILES"',
    requestReindex ? "--request-reindex" : "",
    "--json",
  ]
    .filter(Boolean)
    .join(" ");

  const command =
    hookName === "post-commit"
      ? options.synchronous
        ? `SNIPARA_CODE_OVERLAY_HEAD="$(git rev-parse --verify HEAD 2>/dev/null || true)"\n  if [ -n "$SNIPARA_CODE_OVERLAY_HEAD" ]; then\n    ${syncCommand} >/dev/null 2>&1 || true\n  fi`
        : `SNIPARA_CODE_OVERLAY_HEAD="$(git rev-parse --verify HEAD 2>/dev/null || true)"\n  if [ -n "$SNIPARA_CODE_OVERLAY_HEAD" ]; then\n    ( ${syncCommand} ) >/dev/null 2>&1 &\n  fi`
      : options.synchronous
        ? `${promoteCommand} >/dev/null 2>&1 || true`
        : [
            'SNIPARA_CODE_OVERLAY_PRE_PUSH_INPUT="$(cat)"',
            requestReindex
              ? `SNIPARA_CODE_OVERLAY_REINDEX_DELAY_SECONDS="\${SNIPARA_CODE_OVERLAY_REINDEX_DELAY_SECONDS:-${reindexDelaySeconds}}"`
              : "",
            "(",
            requestReindex
              ? '  if [ "$SNIPARA_CODE_OVERLAY_REINDEX_DELAY_SECONDS" != "0" ]; then\n      sleep "$SNIPARA_CODE_OVERLAY_REINDEX_DELAY_SECONDS"\n    fi'
              : "",
            `  printf "%s\\n" "$SNIPARA_CODE_OVERLAY_PRE_PUSH_INPUT" | ${promoteCommand}`,
            ") >/dev/null 2>&1 &",
          ]
            .filter(Boolean)
            .join("\n  ");

  return [
    hookBlockMarker(hookName, "start"),
    "# Keep local code graph overlays fresh without blocking normal Git commands.",
    "if command -v snipara-companion >/dev/null 2>&1; then",
    `  SNIPARA_CODE_OVERLAY_MAX_FILES="\${SNIPARA_CODE_OVERLAY_MAX_FILES:-${maxFiles}}"`,
    `  ${command}`,
    "fi",
    hookBlockMarker(hookName, "end"),
  ].join("\n");
}

function mergeManagedHookBlock(
  hookName: "post-commit" | "pre-push",
  currentContent: string | null,
  block: string
): string {
  const startMarker = hookBlockMarker(hookName, "start");
  const endMarker = hookBlockMarker(hookName, "end");
  const managedBlockPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`,
    "m"
  );
  const base = currentContent && currentContent.trim() ? currentContent : "#!/usr/bin/env sh\n";
  const withShebang = base.startsWith("#!") ? base : `#!/usr/bin/env sh\n${base}`;
  const nextBlock = `${block}\n`;

  if (managedBlockPattern.test(withShebang)) {
    return ensureTrailingNewline(withShebang.replace(managedBlockPattern, nextBlock));
  }
  return ensureTrailingNewline(`${withShebang.trimEnd()}\n\n${nextBlock}`);
}

function resolveGitHooksDir(repoRoot: string): string {
  const gitHooksPath = runGit(["rev-parse", "--git-path", "hooks"], repoRoot);
  const hooksDir = path.resolve(repoRoot, gitHooksPath ?? path.join(".git", "hooks"));
  const huskyUserHooksDir = path.dirname(hooksDir);
  if (
    path.basename(hooksDir) === "_" &&
    path.basename(huskyUserHooksDir) === ".husky" &&
    fs.existsSync(path.join(hooksDir, "h"))
  ) {
    return huskyUserHooksDir;
  }
  return hooksDir;
}

function installManagedGitHook(
  repoRoot: string,
  hookName: "post-commit" | "pre-push",
  options: CodeHooksInstallCommandOptions
): { hook: string; path: string; action: "created" | "updated" | "unchanged"; content: string } {
  const hooksDir = resolveGitHooksDir(repoRoot);
  const hookPath = path.join(hooksDir, hookName);
  const currentContent = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null;
  const block = buildGitHookBlock(hookName, options);
  const nextContent = mergeManagedHookBlock(hookName, currentContent, block);
  const action =
    currentContent === null ? "created" : currentContent === nextContent ? "unchanged" : "updated";

  if (!options.dryRun && action !== "unchanged") {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, nextContent, "utf8");
    fs.chmodSync(hookPath, 0o755);
  } else if (!options.dryRun && fs.existsSync(hookPath)) {
    fs.chmodSync(hookPath, fs.statSync(hookPath).mode | 0o755);
  }

  return { hook: hookName, path: hookPath, action, content: nextContent };
}

export function buildCodeHooksInstallPlan(
  options: CodeHooksInstallCommandOptions = {}
): Record<string, unknown> {
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const hooks = [
    installManagedGitHook(repoRoot, "post-commit", options),
    installManagedGitHook(repoRoot, "pre-push", options),
  ];
  return {
    repoRoot,
    hooks: hooks.map((hook) => ({
      hook: hook.hook,
      path: hook.path,
      action: hook.action,
    })),
    dryRun: Boolean(options.dryRun),
    requestReindex: options.requestReindex !== false,
    execution: options.synchronous ? "foreground" : "background",
    reindexDelaySeconds: nonNegativeInteger(
      options.reindexDelaySeconds,
      DEFAULT_HOOK_REINDEX_DELAY_SECONDS
    ),
    maxFiles: positiveInteger(options.maxFiles, DEFAULT_MAX_FILES),
  };
}

export async function codeHooksInstallCommand(
  options: CodeHooksInstallCommandOptions
): Promise<void> {
  const result = buildCodeHooksInstallPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("Local Code Overlay Git Hooks"));
  for (const hook of result.hooks as Array<{ hook: string; path: string; action: string }>) {
    console.log(`${hook.hook}: ${hook.action} (${hook.path})`);
  }
  console.log(`Execution: ${String(result.execution)}`);
}

async function readOptionalProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function parsePrePushLocalSha(input: string): string | null {
  for (const line of input.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const localSha = parts[1];
    if (localSha && /^[0-9a-f]{40}$/i.test(localSha) && !/^0{40}$/.test(localSha)) {
      return localSha;
    }
  }
  return null;
}

function resolveCommitSha(repoRoot: string, ref: string | null | undefined): string | null {
  if (!ref) {
    return readHeadSha(repoRoot);
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return ref;
  }
  return runGit(["rev-parse", "--verify", ref], repoRoot) ?? ref;
}

function extractHostedIndexedSha(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "indexed_commit_sha",
    "indexedCommitSha",
    "commit_sha",
    "commitSha",
    "head_sha",
    "headSha",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^[0-9a-f]{40}$/i.test(candidate)) {
      return candidate;
    }
  }
  for (const item of Object.values(record)) {
    const nested = extractHostedIndexedSha(item);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function hasHostedReindexConfig(repoRoot: string): boolean {
  const config = loadConfig({ cwd: repoRoot });
  return Boolean(config.apiKey && config.projectId);
}

export async function buildCodePromotionResult(
  options: CodePromoteCommandOptions = {}
): Promise<Record<string, unknown>> {
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const hookStdin = options.fromHook === "pre-push" ? await readOptionalProcessStdin() : "";
  const pushedSha = resolveCommitSha(
    repoRoot,
    options.pushedSha ?? parsePrePushLocalSha(hookStdin) ?? "HEAD"
  );
  const manifest = buildLocalCodeOverlay({
    cwd: repoRoot,
    mode: "local_commit",
    commit: pushedSha ?? "HEAD",
    maxFiles: options.maxFiles,
  });
  const overlayCachePath = writeLocalCodeOverlayCache(manifest);
  const warnings: LocalCodeOverlayManifest["warnings"] = [...manifest.warnings];
  let indexedSha = options.indexedSha ? resolveCommitSha(repoRoot, options.indexedSha) : null;
  let reindexResult: Record<string, unknown> | undefined;
  let status: LocalCodePromotionState["status"] = "local_commit_cached";
  let reindexRequestedAt: string | null = null;

  if (indexedSha && pushedSha && indexedSha === pushedSha) {
    status = "superseded_by_hosted_index";
  } else if (options.requestReindex) {
    reindexRequestedAt = new Date().toISOString();
    if (!hasHostedReindexConfig(repoRoot)) {
      status = "reindex_skipped_unconfigured";
      warnings.push({
        code: "hosted_reindex_not_configured",
        severity: "info",
        message:
          "Hosted code reindex was requested, but Snipara project auth is not configured locally.",
      });
    } else {
      try {
        reindexResult = await createClient(30000).reindex({ kind: "code", mode: "incremental" });
        indexedSha = extractHostedIndexedSha(reindexResult) ?? indexedSha;
        status =
          pushedSha && indexedSha === pushedSha
            ? "superseded_by_hosted_index"
            : "reindex_requested";
      } catch (error) {
        status = "reindex_failed";
        warnings.push({
          code: "hosted_reindex_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        });
        if (options.strict) {
          throw error;
        }
      }
    }
  }

  const state: LocalCodePromotionState = {
    version: "snipara.local_code_promotion.v1",
    updatedAt: new Date().toISOString(),
    repoRoot,
    repositoryId: manifest.repositoryId,
    branch: manifest.branch,
    pushedSha,
    localHeadSha: manifest.localHeadSha,
    indexedSha,
    overlayCachePath,
    status,
    canonical: false,
    hostedCanonicalVisible: status === "superseded_by_hosted_index",
    reindexRequestedAt,
    ...(reindexResult ? { reindexResult } : {}),
    warnings,
  };
  const statePath = writeLocalCodePromotionState(state);

  return {
    ...state,
    statePath,
  };
}

export async function codePromoteCommand(options: CodePromoteCommandOptions): Promise<void> {
  const result = await buildCodePromotionResult(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold("Local Code Overlay Promotion"));
  console.log(`Status: ${result.status}`);
  console.log(`Pushed SHA: ${result.pushedSha ?? "unknown"}`);
  console.log(`Indexed SHA: ${result.indexedSha ?? "unknown"}`);
  console.log(`State: ${result.statePath}`);
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface LocalCodeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const LOCAL_CODE_MCP_TOOLS: LocalCodeToolDefinition[] = [
  {
    name: "snipara_local_code_status",
    description: "Inspect the non-canonical local code overlay for this working tree.",
    inputSchema: {
      type: "object",
      properties: {
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
        includeGraph: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_sync",
    description:
      "Build and cache a non-canonical local code overlay from the working tree or a local commit.",
    inputSchema: {
      type: "object",
      properties: {
        workingTree: { type: "boolean" },
        commit: { type: "string" },
        maxFiles: { type: "integer", minimum: 1 },
        includeGraph: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_imports",
    description: "List local imports for a symbol or file from the non-canonical overlay.",
    inputSchema: {
      type: "object",
      properties: {
        qualifiedName: { type: "string" },
        symbolKey: { type: "string" },
        filePath: { type: "string" },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_callers",
    description: "List local AST callers or importers with bounded transitive traversal.",
    inputSchema: {
      type: "object",
      properties: {
        qualifiedName: { type: "string" },
        symbolKey: { type: "string" },
        filePath: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 12, default: 1 },
        maxNodes: { type: "integer", minimum: 1, default: 200 },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_neighbors",
    description: "Traverse local AST and import graph neighbors.",
    inputSchema: {
      type: "object",
      properties: {
        qualifiedName: { type: "string" },
        symbolKey: { type: "string" },
        filePath: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 12, default: 2 },
        direction: { type: "string", enum: ["in", "out", "both"], default: "both" },
        edgeKinds: { type: "array", items: { type: "string" } },
        maxNodes: { type: "integer", minimum: 1, default: 200 },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_shortest_path",
    description: "Find a local AST/import path between symbols or files.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        maxHops: { type: "integer", minimum: 1 },
        direction: { type: "string", enum: ["in", "out", "both"], default: "both" },
        edgeKinds: { type: "array", items: { type: "string" } },
        maxNodes: { type: "integer", minimum: 1, default: 500 },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_impact",
    description: "Summarize bounded transitive local impact with explainable risk.",
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: { type: "array", items: { type: "string" } },
        qualifiedName: { type: "string" },
        symbolKey: { type: "string" },
        filePath: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 12, default: 3 },
        transitive: { type: "boolean", default: true },
        direction: { type: "string", enum: ["in", "out", "both"], default: "both" },
        edgeKinds: { type: "array", items: { type: "string" } },
        maxNodes: { type: "integer", minimum: 1, default: 500 },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
];

function booleanFromUnknown(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return fallback;
}

function numberFromUnknown(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function localQueryOptionsFromArgs(
  args: Record<string, unknown>,
  defaults: CodeServeCommandOptions
): LocalCodeQueryCommandOptions {
  return {
    dir: stringFromUnknown(args.dir) ?? defaults.dir,
    cached: booleanFromUnknown(args.cached, Boolean(defaults.cached)),
    includeGraph: booleanFromUnknown(args.includeGraph, Boolean(defaults.includeGraph)),
    maxFiles: numberFromUnknown(args.maxFiles, defaults.maxFiles),
    qualifiedName: stringFromUnknown(args.qualifiedName),
    symbolKey: stringFromUnknown(args.symbolKey),
    filePath: stringFromUnknown(args.filePath),
    changedFiles: stringArrayFromUnknown(args.changedFiles),
    from: stringFromUnknown(args.from),
    to: stringFromUnknown(args.to),
    maxHops: numberFromUnknown(args.maxHops, undefined),
    depth: numberFromUnknown(args.depth, undefined),
    direction:
      args.direction === "in" || args.direction === "out" || args.direction === "both"
        ? args.direction
        : undefined,
    edgeKinds: stringArrayFromUnknown(args.edgeKinds),
    maxNodes: numberFromUnknown(args.maxNodes, undefined),
    transitive:
      args.transitive === undefined ? undefined : booleanFromUnknown(args.transitive, true),
    json: true,
  };
}

function executeLocalCodeTool(
  name: string,
  args: Record<string, unknown>,
  defaults: CodeServeCommandOptions
): Record<string, unknown> {
  switch (name) {
    case "snipara_local_code_status":
      return buildCodeStatusResult({
        dir: stringFromUnknown(args.dir) ?? defaults.dir,
        maxFiles: numberFromUnknown(args.maxFiles, defaults.maxFiles),
        includeGraph: booleanFromUnknown(args.includeGraph, Boolean(defaults.includeGraph)),
        json: true,
      });
    case "snipara_local_code_sync":
      return buildCodeSyncResult({
        dir: stringFromUnknown(args.dir) ?? defaults.dir,
        workingTree: booleanFromUnknown(args.workingTree, false),
        commit: stringFromUnknown(args.commit),
        maxFiles: numberFromUnknown(args.maxFiles, defaults.maxFiles),
        includeGraph: booleanFromUnknown(args.includeGraph, Boolean(defaults.includeGraph)),
        json: true,
      });
    case "snipara_local_code_imports":
      return buildLocalImportsResult(localQueryOptionsFromArgs(args, defaults));
    case "snipara_local_code_callers":
      return buildLocalCallersResult(localQueryOptionsFromArgs(args, defaults));
    case "snipara_local_code_neighbors":
      return buildLocalNeighborsResult(localQueryOptionsFromArgs(args, defaults));
    case "snipara_local_code_shortest_path":
      return buildLocalShortestPathResult(localQueryOptionsFromArgs(args, defaults));
    case "snipara_local_code_impact":
      return buildLocalImpactResult(localQueryOptionsFromArgs(args, defaults));
    default:
      throw new Error(`Unknown local code tool: ${name}`);
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  allowOrigin?: string
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
  }
  if (!body.trim()) {
    return {};
  }
  const parsed = JSON.parse(body) as unknown;
  return objectFromUnknown(parsed);
}

function argsFromUrl(url: URL): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    args[key] = value;
  }
  return args;
}

async function handleLocalCodeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  defaults: CodeServeCommandOptions
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, defaults.allowOrigin);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "snipara-local-code-overlay" }, defaults.allowOrigin);
      return;
    }
    if (req.method === "GET" && url.pathname === "/tools") {
      sendJson(res, 200, { tools: LOCAL_CODE_MCP_TOOLS }, defaults.allowOrigin);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/local-code/status") {
      sendJson(
        res,
        200,
        executeLocalCodeTool("snipara_local_code_status", argsFromUrl(url), defaults),
        defaults.allowOrigin
      );
      return;
    }

    const routeToTool: Record<string, string> = {
      "/v1/local-code/status": "snipara_local_code_status",
      "/v1/local-code/sync": "snipara_local_code_sync",
      "/v1/local-code/imports": "snipara_local_code_imports",
      "/v1/local-code/callers": "snipara_local_code_callers",
      "/v1/local-code/neighbors": "snipara_local_code_neighbors",
      "/v1/local-code/shortest-path": "snipara_local_code_shortest_path",
      "/v1/local-code/impact": "snipara_local_code_impact",
    };
    const toolName = routeToTool[url.pathname];
    if (req.method === "POST" && toolName) {
      const body = await readJsonRequestBody(req);
      sendJson(res, 200, executeLocalCodeTool(toolName, body, defaults), defaults.allowOrigin);
      return;
    }

    sendJson(
      res,
      404,
      { error: "not_found", message: "Unknown local code overlay route." },
      defaults.allowOrigin
    );
  } catch (error) {
    sendJson(
      res,
      500,
      {
        error: "local_code_overlay_error",
        message: error instanceof Error ? error.message : String(error),
      },
      defaults.allowOrigin
    );
  }
}

function writeReadyFile(readyFile: string | undefined, payload: Record<string, unknown>): void {
  if (!readyFile) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(readyFile)), { recursive: true });
  fs.writeFileSync(path.resolve(readyFile), JSON.stringify(payload, null, 2), "utf8");
}

async function startLocalCodeHttpServer(options: CodeServeCommandOptions): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4747;
  const server = http.createServer((req, res) => {
    void handleLocalCodeHttpRequest(req, res, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      const ready = {
        transport: "http",
        host: address.address,
        port: address.port,
        baseUrl: `http://${address.address}:${address.port}`,
        tools: LOCAL_CODE_MCP_TOOLS.map((tool) => tool.name),
      };
      writeReadyFile(options.readyFile, ready);
      if (options.json) {
        console.log(JSON.stringify(ready));
      } else {
        console.log(`Snipara local code overlay HTTP server listening on ${ready.baseUrl}`);
      }
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function writeJsonRpcResponse(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function jsonRpcSuccess(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function handleLocalCodeMcpRequest(
  request: JsonRpcRequest,
  defaults: CodeServeCommandOptions
): Record<string, unknown> | null {
  const id = request.id;
  const method = request.method;
  if (!method) {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC request.");
  }

  if (method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    return jsonRpcSuccess(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: {
        name: "snipara-local-code-overlay",
        version: "0.1.0",
      },
    });
  }

  if (method === "ping") {
    return jsonRpcSuccess(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcSuccess(id, { tools: LOCAL_CODE_MCP_TOOLS });
  }

  if (method === "tools/call") {
    const params = objectFromUnknown(request.params);
    const name = stringFromUnknown(params.name);
    const args = objectFromUnknown(params.arguments);
    if (!name) {
      return jsonRpcError(id, -32602, "tools/call requires params.name.");
    }
    try {
      const result = executeLocalCodeTool(name, args, defaults);
      return jsonRpcSuccess(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      return jsonRpcSuccess(id, {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, `Unsupported MCP method: ${method}`);
}

async function startLocalCodeMcpStdioServer(options: CodeServeCommandOptions): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stderr.write("Snipara local code overlay MCP stdio server ready.\n");

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = handleLocalCodeMcpRequest(request, options);
        if (response) {
          writeJsonRpcResponse(response);
        }
      } catch (error) {
        writeJsonRpcResponse(
          jsonRpcError(
            null,
            -32700,
            error instanceof Error ? `Parse error: ${error.message}` : "Parse error."
          )
        );
      }
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
  });
}

export async function codeServeCommand(options: CodeServeCommandOptions): Promise<void> {
  const transport = options.transport ?? "http";
  if (transport === "mcp-stdio") {
    await startLocalCodeMcpStdioServer(options);
    return;
  }
  await startLocalCodeHttpServer(options);
}

export async function codeMcpCommand(options: CodeServeCommandOptions): Promise<void> {
  await startLocalCodeMcpStdioServer({ ...options, transport: "mcp-stdio" });
}
