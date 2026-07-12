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
}

export interface LocalCodeOverlaySymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  filePath: string;
  line: number;
  localKey: string;
}

export interface LocalCodeOverlayImport {
  filePath: string;
  specifier: string;
  line: number;
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
  version: "snipara.local_code_overlay.v1";
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
}

export type CodeGraphSource = "auto" | "hosted" | "local";
export type ResolvedCodeGraphSource = "hosted_graph" | "local_overlay";
export type CodeGraphVerb = "callers" | "imports" | "neighbors" | "shortest-path" | "impact";

export interface CodeGraphAutoSourceOptions extends LocalCodeQueryCommandOptions {
  source?: CodeGraphSource;
  depth?: number;
  direction?: "in" | "out";
  includeFileNodes?: boolean;
  edgeKinds?: string[];
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
    warnings: LocalCodeOverlayManifest["warnings"];
  };
  hosted?: {
    configured: boolean;
    indexFreshness?: unknown;
    contextScope?: unknown;
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
    excluded: number;
  };
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

function buildSymbolKey(filePath: string, name: string, line: number): string {
  return `local::${filePath}::${name}::${line}`;
}

function extractTypeScript(
  content: string,
  filePath: string
): {
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
} {
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
  const symbolPattern =
    /^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const importPattern =
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of content.matchAll(symbolPattern)) {
    const name = match[1];
    if (!name || match.index === undefined) {
      continue;
    }
    const source = match[0];
    const kind = source.includes("class")
      ? "class"
      : source.includes("interface")
        ? "interface"
        : source.includes("type")
          ? "type"
          : source.includes("function")
            ? "function"
            : "variable";
    const line = lineNumberFromIndex(content, match.index);
    symbols.push({ name, kind, filePath, line, localKey: buildSymbolKey(filePath, name, line) });
  }

  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || match.index === undefined) {
      continue;
    }
    imports.push({ filePath, specifier, line: lineNumberFromIndex(content, match.index) });
  }

  return { symbols, imports };
}

function extractPython(
  content: string,
  filePath: string
): {
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
} {
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
    symbols.push({ name, kind, filePath, line, localKey: buildSymbolKey(filePath, name, line) });
  }

  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || match.index === undefined) {
      continue;
    }
    imports.push({ filePath, specifier, line: lineNumberFromIndex(content, match.index) });
  }

  return { symbols, imports };
}

function extractGo(
  content: string,
  filePath: string
): {
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
} {
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
    symbols.push({ name, kind, filePath, line, localKey: buildSymbolKey(filePath, name, line) });
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

  return { symbols, imports };
}

function extractCode(
  content: string,
  filePath: string,
  language: LocalCodeOverlayFile["language"]
): {
  symbols: LocalCodeOverlaySymbol[];
  imports: LocalCodeOverlayImport[];
} {
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
  const files: LocalCodeOverlayFile[] = [];
  const symbols: LocalCodeOverlaySymbol[] = [];
  const imports: LocalCodeOverlayImport[] = [];
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

    const extracted = extractCode(indexedContent, filePath, language);
    files.push({
      path: filePath,
      language,
      sizeBytes: contentBuffer.length,
      sha256: sha256(indexedContent),
      symbolCount: extracted.symbols.length,
      importCount: extracted.imports.length,
    });
    symbols.push(...extracted.symbols);
    imports.push(...extracted.imports);
  }

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
    version: "snipara.local_code_overlay.v1",
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
      excluded: manifest.excluded.total,
    },
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
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as LocalCodeOverlayManifest;
    return parsed && parsed.version === "snipara.local_code_overlay.v1" ? parsed : null;
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
  manifest: LocalCodeOverlayManifest,
  fromFile: string,
  specifier: string
): string | null {
  const files = new Set(manifest.files.map((file) => file.path));
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
      warnings: manifest.warnings,
    },
    hosted: {
      configured: isConfigured({ cwd: manifest.repoRoot }),
    },
    limitations: [
      "local_overlay_file_import_model",
      "local callers and impact use file-level import and symbol analysis from the current checkout",
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

function localOverlayGuidance(reason: string): string[] {
  const selectedBecause =
    reason === "working_tree_dirty"
      ? "Local overlay selected because the working tree has uncommitted edits."
      : reason === "local_head_ahead_of_upstream"
        ? "Local overlay selected because local commits are ahead of upstream."
        : reason === "hosted_not_configured"
          ? "Local overlay selected because hosted Snipara is not configured."
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

function shouldUseLocalOverlay(args: {
  requested: CodeGraphSource;
  repoRoot: string;
  dirtyFiles: string[];
  aheadCount: number | null;
}): { useLocal: boolean; reason: string } {
  if (args.requested === "local") {
    return { useLocal: true, reason: "source_forced_local" };
  }
  if (args.requested === "hosted") {
    return { useLocal: false, reason: "source_forced_hosted" };
  }
  if (args.dirtyFiles.length > 0) {
    return { useLocal: true, reason: "working_tree_dirty" };
  }
  if ((args.aheadCount ?? 0) > 0) {
    return { useLocal: true, reason: "local_head_ahead_of_upstream" };
  }
  return { useLocal: true, reason: "auto_local_default" };
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
        direction: options.direction,
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
  const requested = options.source ?? "auto";
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const dirtyStatus = readGitStatus(repoRoot);
  const dirtyFiles = parseDirtyFiles(dirtyStatus);
  const aheadCount = readAheadCount(repoRoot);
  const decision = shouldUseLocalOverlay({
    requested,
    repoRoot,
    dirtyFiles,
    aheadCount,
  });

  let autoResult: CodeGraphAutoSourceResult;
  if (decision.useLocal) {
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
  } else {
    if (!isConfigured({ cwd: repoRoot })) {
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
  const edges = targetFile
    ? buildLocalFileEdges(manifest).filter((edge) => edge.to === targetFile)
    : [];
  return {
    title: "Local callers",
    caveat:
      "Local callers are file-level importers in this CLI overlay slice, not call-site AST edges.",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { filePath: targetFile },
    callers: edges.map((edge) => ({
      filePath: edge.from,
      importSpecifier: edge.specifier,
      line: edge.line,
      symbols: manifest.symbols.filter((item) => item.filePath === edge.from).map(compactSymbol),
    })),
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
  return {
    title: "Local neighbors",
    scope: summarizeLocalCodeOverlay(manifest),
    target: symbol ? compactSymbol(symbol) : { filePath: targetFile },
    fileSymbols: targetFile
      ? manifest.symbols.filter((item) => item.filePath === targetFile).map(compactSymbol)
      : [],
    incoming,
    outgoing,
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
  const edges = buildLocalFileEdges(manifest);
  const queue: Array<{ file: string; path: string[] }> = fromFile
    ? [{ file: fromFile, path: [fromFile] }]
    : [];
  const seen = new Set<string>();
  let found: string[] | null = null;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.file)) {
      continue;
    }
    seen.add(next.file);
    if (next.file === toFile) {
      found = next.path;
      break;
    }
    if (next.path.length > maxHops) {
      continue;
    }
    for (const edge of edges.filter((item) => item.from === next.file)) {
      queue.push({ file: edge.to, path: [...next.path, edge.to] });
    }
  }

  return {
    title: "Local shortest path",
    scope: summarizeLocalCodeOverlay(manifest),
    from: fromSymbol ? compactSymbol(fromSymbol) : { filePath: fromFile },
    to: toSymbol ? compactSymbol(toSymbol) : { filePath: toFile },
    path: found,
    found: Boolean(found),
    caveat:
      "Shortest path currently traverses resolved file-level import edges in the local overlay.",
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
  const impactedFiles = [
    ...new Set([...incoming.map((edge) => edge.from), ...outgoing.map((edge) => edge.to)]),
  ].sort();
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
      "Local impact reports file-level import neighbors from the current checkout. Use --source hosted only when you want the hosted team graph.",
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
    description:
      "List local file-level importers for a symbol or file from the non-canonical overlay.",
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
    name: "snipara_local_code_neighbors",
    description: "List local incoming and outgoing file-level import neighbors.",
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
    name: "snipara_local_code_shortest_path",
    description: "Find a local file-level import path between symbols or files.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        maxHops: { type: "integer", minimum: 1 },
        cached: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snipara_local_code_impact",
    description: "Summarize local file-level import impact for changed files or a selected symbol.",
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: { type: "array", items: { type: "string" } },
        qualifiedName: { type: "string" },
        symbolKey: { type: "string" },
        filePath: { type: "string" },
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
