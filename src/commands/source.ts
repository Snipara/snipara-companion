/**
 * `source` commands - local source activation for folders without hosted Git.
 *
 * Scans a local folder into a deterministic source snapshot, previews document
 * sync through the existing onboard-folder manifest, and refreshes the local
 * code overlay. This gives free/local users an automatic Git-like activation
 * path before they connect GitHub or GitLab.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { createClient } from "../api/client";
import { isConfigured } from "../config/store";
import {
  buildLocalCodeOverlay,
  summarizeLocalCodeOverlay,
  writeLocalCodeOverlayCache,
  type LocalCodeOverlaySummary,
} from "./code";
import {
  buildOnboardFolderManifest,
  type OnboardFolderManifest,
  type OnboardFolderMode,
} from "./workflows";

export type LocalSourceProvider = "local_folder";
export type LocalSourceFileKind = "DOC" | "BINARY" | "CODE" | "CONFIG" | "OTHER";
export type LocalSourceSkippedReason = "ignored" | "too_large" | "read_error";
export type LocalSourceReindexKind = "doc" | "code";
export type LocalSourceReindexMode = "incremental" | "full";

export interface LocalSourceFile {
  path: string;
  kind: LocalSourceFileKind;
  format: string | null;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
}

export interface LocalSourceSkippedFile {
  path: string;
  reason: LocalSourceSkippedReason;
  sizeBytes?: number;
}

export interface LocalSourceSummary {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<LocalSourceFileKind, number>;
  skipped: number;
}

export interface LocalSourceSnapshot {
  version: "snipara.local_source_snapshot.v1";
  generatedAt: string;
  root: string;
  provider: LocalSourceProvider;
  revision: string;
  recursive: boolean;
  maxFiles: number;
  maxFileBytes: number;
  summary: LocalSourceSummary;
  files: LocalSourceFile[];
  skipped: {
    total: number;
    byReason: Record<LocalSourceSkippedReason, number>;
    samples: LocalSourceSkippedFile[];
  };
  warnings: string[];
}

export interface LocalSourceSnapshotOptions {
  dir?: string;
  recursive?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface LocalSourceComparison {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

export interface LocalSourceStatusResult {
  root: string;
  snapshotPath: string;
  previous: LocalSourceSnapshot | null;
  current: LocalSourceSnapshot;
  comparison: LocalSourceComparison;
}

export interface LocalSourceSyncOptions extends LocalSourceSnapshotOptions {
  prefix?: string;
  mode?: OnboardFolderMode;
  deleteMissing?: boolean;
  apply?: boolean;
  reindex?: boolean;
  reindexKind?: LocalSourceReindexKind;
  reindexMode?: LocalSourceReindexMode;
  includeGraph?: boolean;
  json?: boolean;
}

export interface LocalSourceSyncResult {
  root: string;
  snapshotPath: string;
  snapshot: LocalSourceSnapshot;
  comparison: LocalSourceComparison;
  documents: {
    onboarding: Pick<OnboardFolderManifest, "source" | "classification" | "summary" | "warnings">;
    dryRun: OnboardFolderManifest["dryRun"];
  };
  codeOverlay: {
    cachePath: string;
    summary: LocalCodeOverlaySummary;
  };
  apply: null | {
    sync: Record<string, unknown>;
    reindex?: Record<string, unknown>;
  };
  warnings: string[];
}

const SNAPSHOT_RELATIVE_PATH = path.join(".snipara", "source", "latest.json");
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

const DOCUMENT_FORMATS = new Map<string, { kind: LocalSourceFileKind; format: string }>([
  [".adoc", { kind: "DOC", format: "adoc" }],
  [".markdown", { kind: "DOC", format: "markdown" }],
  [".md", { kind: "DOC", format: "md" }],
  [".mdx", { kind: "DOC", format: "mdx" }],
  [".rst", { kind: "DOC", format: "rst" }],
  [".txt", { kind: "DOC", format: "txt" }],
  [".docx", { kind: "BINARY", format: "docx" }],
  [".pdf", { kind: "BINARY", format: "pdf" }],
  [".pptx", { kind: "BINARY", format: "pptx" }],
  [".svg", { kind: "BINARY", format: "svg" }],
  [".vsdx", { kind: "BINARY", format: "vsdx" }],
]);

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".tsx",
  ".ts",
]);

const CONFIG_FILES = new Set([
  ".env.example",
  ".gitignore",
  ".sniparaignore",
  "AGENTS.md",
  "Dockerfile",
  "Makefile",
  "compose.yaml",
  "docker-compose.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "turbo.json",
]);

const CONFIG_EXTENSIONS = new Set([".json", ".toml", ".yaml", ".yml", ".ini", ".cfg"]);

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".snipara",
  ".svn",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\/+/, "");
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readSniparaIgnore(root: string): string[] {
  const ignorePath = path.join(root, ".sniparaignore");
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
  return sniparaIgnore.some((pattern) => matchesIgnorePattern(normalized, pattern));
}

function isIgnoredDirectory(relativePath: string, sniparaIgnore: string[]): boolean {
  const normalized = normalizeRepoPath(relativePath);
  if (!normalized) {
    return false;
  }
  if (DEFAULT_IGNORED_DIRS.has(path.basename(normalized))) {
    return true;
  }
  return isIgnored(`${normalized}/`, sniparaIgnore);
}

function classifySourceFile(filePath: string): {
  kind: LocalSourceFileKind;
  format: string | null;
} {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const doc = DOCUMENT_FORMATS.get(ext);
  if (doc) {
    return doc;
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return { kind: "CODE", format: ext.slice(1) };
  }
  if (CONFIG_FILES.has(base) || CONFIG_EXTENSIONS.has(ext)) {
    return { kind: "CONFIG", format: ext ? ext.slice(1) : base.toLowerCase() };
  }
  return { kind: "OTHER", format: ext ? ext.slice(1) : null };
}

function emptyKindCounts(): Record<LocalSourceFileKind, number> {
  return {
    DOC: 0,
    BINARY: 0,
    CODE: 0,
    CONFIG: 0,
    OTHER: 0,
  };
}

function emptySkippedCounts(): Record<LocalSourceSkippedReason, number> {
  return {
    ignored: 0,
    too_large: 0,
    read_error: 0,
  };
}

function resolveSourceRoot(dir?: string): string {
  return path.resolve(dir ?? process.cwd());
}

export function getLocalSourceSnapshotPath(cwd: string = process.cwd()): string {
  return path.join(resolveSourceRoot(cwd), SNAPSHOT_RELATIVE_PATH);
}

export function buildLocalSourceSnapshot(
  options: LocalSourceSnapshotOptions = {}
): LocalSourceSnapshot {
  const root = resolveSourceRoot(options.dir);
  const recursive = options.recursive ?? true;
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const now = new Date().toISOString();
  const sniparaIgnore = readSniparaIgnore(root);
  const files: LocalSourceFile[] = [];
  const skippedSamples: LocalSourceSkippedFile[] = [];
  const skippedByReason = emptySkippedCounts();
  const warnings: string[] = [];
  const stack = [root];

  const addSkipped = (filePath: string, reason: LocalSourceSkippedReason, sizeBytes?: number) => {
    skippedByReason[reason] += 1;
    if (skippedSamples.length < 20) {
      skippedSamples.push({ path: filePath, reason, ...(sizeBytes ? { sizeBytes } : {}) });
    }
  };

  while (stack.length > 0 && files.length < maxFiles) {
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
      if (files.length >= maxFiles) {
        break;
      }
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRepoPath(path.relative(root, absolutePath));
      if (!relativePath) {
        continue;
      }
      if (entry.isDirectory()) {
        if (recursive && !isIgnoredDirectory(relativePath, sniparaIgnore)) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (isIgnored(relativePath, sniparaIgnore)) {
        addSkipped(relativePath, "ignored");
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        addSkipped(relativePath, "read_error");
        continue;
      }
      if (stat.size > maxFileBytes) {
        addSkipped(relativePath, "too_large", stat.size);
        continue;
      }

      let content: Buffer;
      try {
        content = fs.readFileSync(absolutePath);
      } catch {
        addSkipped(relativePath, "read_error");
        continue;
      }
      const classification = classifySourceFile(relativePath);
      files.push({
        path: relativePath,
        kind: classification.kind,
        format: classification.format,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: sha256(content),
      });
    }
  }

  if (files.length >= maxFiles) {
    warnings.push(`Stopped after ${maxFiles} files. Increase --max-files for larger folders.`);
  }

  const byKind = emptyKindCounts();
  let totalBytes = 0;
  for (const file of files) {
    byKind[file.kind] += 1;
    totalBytes += file.sizeBytes;
  }

  const revision = `sha256:${sha256(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      }))
    )
  )}`;

  return {
    version: "snipara.local_source_snapshot.v1",
    generatedAt: now,
    root,
    provider: "local_folder",
    revision,
    recursive,
    maxFiles,
    maxFileBytes,
    summary: {
      totalFiles: files.length,
      totalBytes,
      byKind,
      skipped: Object.values(skippedByReason).reduce((sum, count) => sum + count, 0),
    },
    files,
    skipped: {
      total: Object.values(skippedByReason).reduce((sum, count) => sum + count, 0),
      byReason: skippedByReason,
      samples: skippedSamples,
    },
    warnings,
  };
}

export function writeLocalSourceSnapshot(snapshot: LocalSourceSnapshot): string {
  const snapshotPath = getLocalSourceSnapshotPath(snapshot.root);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshotPath;
}

export function readLocalSourceSnapshot(cwd: string = process.cwd()): LocalSourceSnapshot | null {
  const snapshotPath = getLocalSourceSnapshotPath(cwd);
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as LocalSourceSnapshot;
    return parsed?.version === "snipara.local_source_snapshot.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function compareLocalSourceSnapshots(
  previous: LocalSourceSnapshot | null,
  current: LocalSourceSnapshot
): LocalSourceComparison {
  if (!previous) {
    return {
      added: current.files.map((file) => file.path),
      modified: [],
      deleted: [],
      unchanged: 0,
    };
  }

  const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const file of current.files) {
    const before = previousByPath.get(file.path);
    if (!before) {
      added.push(file.path);
    } else if (before.sha256 !== file.sha256) {
      modified.push(file.path);
    } else {
      unchanged += 1;
    }
  }

  const deleted = previous.files
    .filter((file) => !currentByPath.has(file.path))
    .map((file) => file.path);

  return { added, modified, deleted, unchanged };
}

export function buildLocalSourceStatus(
  options: LocalSourceSnapshotOptions = {}
): LocalSourceStatusResult {
  const root = resolveSourceRoot(options.dir);
  const previous = readLocalSourceSnapshot(root);
  const current = buildLocalSourceSnapshot({ ...options, dir: root });
  return {
    root,
    snapshotPath: getLocalSourceSnapshotPath(root),
    previous,
    current,
    comparison: compareLocalSourceSnapshots(previous, current),
  };
}

export async function buildLocalSourceSyncResult(
  options: LocalSourceSyncOptions = {}
): Promise<LocalSourceSyncResult> {
  const root = resolveSourceRoot(options.dir);
  const previous = readLocalSourceSnapshot(root);
  const snapshot = buildLocalSourceSnapshot({ ...options, dir: root });
  const comparison = compareLocalSourceSnapshots(previous, snapshot);
  const snapshotPath = writeLocalSourceSnapshot(snapshot);
  const reindex = options.reindex ?? true;
  const reindexKind = options.reindexKind ?? "doc";
  const reindexMode = options.reindexMode ?? "incremental";
  const onboardManifest = buildOnboardFolderManifest({
    dir: root,
    recursive: options.recursive ?? true,
    prefix: options.prefix,
    mode: options.mode ?? "mixed",
    sourceKind: "local_agent",
    sourceProvider: "local_folder",
    deleteMissing: options.deleteMissing ?? false,
    reindex,
    reindexKind,
    reindexMode,
    snapshotAt: snapshot.generatedAt,
  });
  const codeOverlay = buildLocalCodeOverlay({
    cwd: root,
    mode: "working_tree",
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
  });
  const codeOverlayCachePath = writeLocalCodeOverlayCache(codeOverlay);

  let applyResult: LocalSourceSyncResult["apply"] = null;
  if (options.apply) {
    if (onboardManifest.sync.documents.length === 0) {
      throw new Error("No supported documents found to apply.");
    }
    if (onboardManifest.dryRun.invalid_metadata > 0) {
      throw new Error("Document manifest has invalid metadata; run without --apply first.");
    }
    if (!isConfigured({ cwd: root })) {
      throw new Error("Hosted Snipara is not configured. Run snipara-companion login first.");
    }

    const client = createClient(30000, { cwd: root });
    const sync = await client.syncDocuments(
      onboardManifest.sync.documents,
      onboardManifest.sync.deleteMissing
    );
    const reindexResult = onboardManifest.sync.reindex
      ? await client.reindex({
          kind: onboardManifest.sync.reindexKind,
          mode: onboardManifest.sync.reindexMode,
        })
      : undefined;
    applyResult = {
      sync,
      ...(reindexResult ? { reindex: reindexResult } : {}),
    };
  }

  return {
    root,
    snapshotPath,
    snapshot,
    comparison,
    documents: {
      onboarding: {
        source: onboardManifest.source,
        classification: onboardManifest.classification,
        summary: onboardManifest.summary,
        warnings: onboardManifest.warnings,
      },
      dryRun: onboardManifest.dryRun,
    },
    codeOverlay: {
      cachePath: codeOverlayCachePath,
      summary: summarizeLocalCodeOverlay(codeOverlay),
    },
    apply: applyResult,
    warnings: [...snapshot.warnings, ...onboardManifest.warnings],
  };
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printComparison(comparison: LocalSourceComparison): void {
  console.log(
    `Delta: +${comparison.added.length} ~${comparison.modified.length} -${comparison.deleted.length} =${comparison.unchanged}`
  );
}

function printSnapshot(snapshot: LocalSourceSnapshot, snapshotPath?: string): void {
  console.log(chalk.bold("Local Source Snapshot"));
  console.log(`Root: ${snapshot.root}`);
  console.log(`Revision: ${snapshot.revision.slice(0, 23)}`);
  console.log(`Files: ${snapshot.summary.totalFiles}`);
  console.log(
    `Kinds: docs ${snapshot.summary.byKind.DOC}, binary ${snapshot.summary.byKind.BINARY}, code ${snapshot.summary.byKind.CODE}, config ${snapshot.summary.byKind.CONFIG}, other ${snapshot.summary.byKind.OTHER}`
  );
  console.log(`Skipped: ${snapshot.skipped.total}`);
  if (snapshotPath) {
    console.log(`Snapshot: ${snapshotPath}`);
  }
  for (const warning of snapshot.warnings) {
    console.log(chalk.yellow(`Warning: ${warning}`));
  }
}

function printStatus(result: LocalSourceStatusResult): void {
  printSnapshot(result.current);
  console.log(`Cached: ${result.previous ? result.snapshotPath : "none"}`);
  printComparison(result.comparison);
}

function printSyncResult(result: LocalSourceSyncResult): void {
  printSnapshot(result.snapshot, result.snapshotPath);
  printComparison(result.comparison);
  console.log("");
  console.log(chalk.bold("Documents"));
  console.log(`Would sync: ${result.documents.dryRun.would_sync}/${result.documents.dryRun.total}`);
  console.log(
    `Mode: ${result.documents.onboarding.classification.mode} (${Math.round(
      result.documents.onboarding.classification.confidence * 100
    )}%)`
  );
  console.log("");
  console.log(chalk.bold("Code Overlay"));
  console.log(`Files: ${result.codeOverlay.summary.counts.files}`);
  console.log(`Symbols: ${result.codeOverlay.summary.counts.symbols}`);
  console.log(`Imports: ${result.codeOverlay.summary.counts.imports}`);
  console.log(`Overlay: ${result.codeOverlay.summary.overlayKind}`);
  console.log(`Cache: ${result.codeOverlay.cachePath}`);
  if (result.apply) {
    console.log("");
    console.log(chalk.bold("Hosted Apply"));
    console.log("Documents uploaded through hosted sync.");
  }
  for (const warning of result.warnings) {
    console.log(chalk.yellow(`Warning: ${warning}`));
  }
}

export async function sourceSnapshotCommand(
  options: LocalSourceSnapshotOptions & { json?: boolean } = {}
): Promise<void> {
  const snapshot = buildLocalSourceSnapshot(options);
  const snapshotPath = writeLocalSourceSnapshot(snapshot);
  if (options.json) {
    printJson({ snapshotPath, snapshot });
    return;
  }
  printSnapshot(snapshot, snapshotPath);
}

export async function sourceStatusCommand(
  options: LocalSourceSnapshotOptions & { json?: boolean } = {}
): Promise<void> {
  const result = buildLocalSourceStatus(options);
  if (options.json) {
    printJson(result);
    return;
  }
  printStatus(result);
}

export async function sourceSyncCommand(options: LocalSourceSyncOptions = {}): Promise<void> {
  const result = await buildLocalSourceSyncResult(options);
  if (options.json) {
    printJson(result);
    return;
  }
  printSyncResult(result);
}

export async function sourceWatchCommand(
  options: LocalSourceSyncOptions & { once?: boolean; intervalMs?: number } = {}
): Promise<void> {
  const intervalMs = positiveInteger(options.intervalMs, 5000);
  if (options.once) {
    await sourceSyncCommand(options);
    return;
  }

  while (true) {
    await sourceSyncCommand(options);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
