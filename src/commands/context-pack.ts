/**
 * `context-pack` commands — local, no-account reversible output packs.
 *
 * Packs tool output, logs, diffs, or notes into `.snipara/context-pack` so an
 * agent can retrieve exact content later without uploading raw output to
 * hosted Snipara. Hosted policy/receipts can be layered on top later; this file
 * is deliberately local-only.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findWorkspaceRoot } from "../config/store";

export type ContextPackKind = "tool_output" | "log" | "diff" | "file" | "text" | "note";

export interface ContextPackRecord {
  version: "snipara.context_pack.v1";
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: ContextPackKind;
  label: string | null;
  source: string | null;
  tags: string[];
  repoRoot: string;
  sha256: string;
  bytes: number;
  lineCount: number;
  contentType: "text/plain";
  contentEncoding: "utf8";
  preview: string;
  expiresAt: string | null;
  sensitive: boolean;
  warnings: Array<{ code: string; message: string }>;
  storage: {
    baseRelativePath: string;
    manifestRelativePath: string;
    blobRelativePath: string;
  };
}

export interface ContextPackLatestPointer {
  version: "snipara.context_pack.latest.v1";
  id: string;
  updatedAt: string;
  manifestRelativePath: string;
}

export interface PackContextOptions {
  cwd?: string;
  content: string;
  label?: string;
  source?: string;
  kind?: string;
  tags?: string[];
  ttlDays?: number;
  maxBytes?: number;
  allowSensitive?: boolean;
  now?: Date;
}

export interface ContextPackPackCommandOptions {
  cwd?: string;
  text?: string;
  file?: string;
  input?: string;
  label?: string;
  source?: string;
  kind?: string;
  tags?: string[];
  ttlDays?: number;
  maxBytes?: number;
  allowSensitive?: boolean;
  json?: boolean;
}

export interface ContextPackRetrieveCommandOptions {
  cwd?: string;
  output?: string;
  metadataOnly?: boolean;
  json?: boolean;
}

export interface ContextPackStatsCommandOptions {
  cwd?: string;
  json?: boolean;
}

export interface ContextPackCleanCommandOptions {
  cwd?: string;
  all?: boolean;
  expired?: boolean;
  olderThanDays?: number;
  dryRun?: boolean;
  json?: boolean;
  now?: Date;
}

export interface ContextPackStoragePaths {
  repoRoot: string;
  baseDir: string;
  blobsDir: string;
  manifestsDir: string;
  latestPath: string;
}

export interface PackContextResult {
  record: ContextPackRecord;
  created: boolean;
  baseDir: string;
  manifestPath: string;
  blobPath: string;
}

export interface RetrieveContextPackResult {
  record: ContextPackRecord;
  content: string;
  baseDir: string;
  manifestPath: string;
  blobPath: string;
}

export interface ContextPackStats {
  version: "snipara.context_pack.stats.v1";
  baseDir: string;
  totalPacks: number;
  totalBytes: number;
  sensitivePacks: number;
  expiredPacks: number;
  kinds: Record<string, number>;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  latestId: string | null;
}

export interface ContextPackCleanResult {
  version: "snipara.context_pack.clean.v1";
  baseDir: string;
  dryRun: boolean;
  selected: number;
  deleted: number;
  deletedIds: string[];
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const BASE_RELATIVE_PATH = path.join(".snipara", "context-pack");
const BLOBS_RELATIVE_PATH = path.join(BASE_RELATIVE_PATH, "blobs");
const MANIFESTS_RELATIVE_PATH = path.join(BASE_RELATIVE_PATH, "items");
const LATEST_RELATIVE_PATH = path.join(BASE_RELATIVE_PATH, "latest.json");
const STORAGE_GITIGNORE_CONTENT = "*\n!.gitignore\n";
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/g, "$1[REDACTED]"],
  [/\b(sk|snp|rlm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]{8,}@/gi, "$1[REDACTED]@"],
  [
    /\b(api[_-]?key|access[_-]?token|token|password|secret|private[_-]?key)\b\s*[:=]\s*(?:"[^"\s]{8,}"|'[^'\s]{8,}'|[A-Za-z0-9][A-Za-z0-9_+=/.-]{7,})/gi,
    "$1=[REDACTED]",
  ],
];

function resolveRepoRoot(cwd: string): string {
  return findWorkspaceRoot(path.resolve(cwd), true) ?? path.resolve(cwd);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const relative = path.relative(repoRoot, absolutePath);
  return normalizeRelativePath(relative || path.basename(absolutePath));
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeKind(kind?: string): ContextPackKind {
  const normalized = (kind ?? "tool_output")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  switch (normalized) {
    case "tool_output":
    case "tool":
    case "output":
      return "tool_output";
    case "log":
    case "diff":
    case "file":
    case "text":
    case "note":
      return normalized;
    default:
      throw new Error(
        "Unsupported context pack kind. Use one of: tool_output, log, diff, file, text, note."
      );
  }
}

function uniqueStrings(values?: string[]): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : undefined;
}

function ensureDir(dir: string, mode: number = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function maybeReadJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function ensureStorageGitignore(paths: ContextPackStoragePaths): void {
  ensureDir(paths.baseDir);
  const gitignorePath = path.join(paths.baseDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, STORAGE_GITIGNORE_CONTENT, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).length;
}

function buildPreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function redactSecretLikeContent(content: string): string {
  return SECRET_REDACTION_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    content
  );
}

function hasSecretPattern(content: string): boolean {
  return redactSecretLikeContent(content) !== content;
}

function expiryFromTtl(now: Date, ttlDays?: number): string | null {
  const normalizedTtlDays = optionalPositiveInteger(ttlDays);
  if (!normalizedTtlDays) {
    return null;
  }
  return new Date(now.getTime() + normalizedTtlDays * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(record: ContextPackRecord, now: Date): boolean {
  return record.expiresAt !== null && Date.parse(record.expiresAt) <= now.getTime();
}

function isOlderThan(record: ContextPackRecord, days: number, now: Date): boolean {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return Date.parse(record.createdAt) <= cutoff;
}

function isContextPackRecord(value: unknown): value is ContextPackRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<ContextPackRecord>;
  return (
    record.version === "snipara.context_pack.v1" &&
    typeof record.id === "string" &&
    typeof record.sha256 === "string" &&
    typeof record.storage?.blobRelativePath === "string" &&
    typeof record.storage.manifestRelativePath === "string"
  );
}

function latestPointer(paths: ContextPackStoragePaths): ContextPackLatestPointer | null {
  const pointer = maybeReadJsonFile<ContextPackLatestPointer>(paths.latestPath);
  if (
    pointer?.version === "snipara.context_pack.latest.v1" &&
    typeof pointer.id === "string" &&
    typeof pointer.manifestRelativePath === "string"
  ) {
    return pointer;
  }
  return null;
}

function readManifest(
  paths: ContextPackStoragePaths,
  manifestPath: string
): ContextPackRecord | null {
  const record = maybeReadJsonFile<unknown>(manifestPath);
  if (!isContextPackRecord(record)) {
    return null;
  }
  return {
    ...record,
    repoRoot: paths.repoRoot,
  };
}

function listManifestPaths(paths: ContextPackStoragePaths): string[] {
  if (!fs.existsSync(paths.manifestsDir)) {
    return [];
  }

  return fs
    .readdirSync(paths.manifestsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(paths.manifestsDir, name));
}

function loadRecords(paths: ContextPackStoragePaths): ContextPackRecord[] {
  return listManifestPaths(paths)
    .map((manifestPath) => readManifest(paths, manifestPath))
    .filter((record): record is ContextPackRecord => record !== null);
}

function recordManifestPath(paths: ContextPackStoragePaths, id: string): string {
  return path.join(paths.manifestsDir, `${id}.json`);
}

function recordBlobPath(paths: ContextPackStoragePaths, sha: string): string {
  return path.join(paths.blobsDir, `${sha}.txt`);
}

function writeLatestPointer(paths: ContextPackStoragePaths, record: ContextPackRecord): void {
  writeJsonFile(paths.latestPath, {
    version: "snipara.context_pack.latest.v1",
    id: record.id,
    updatedAt: record.updatedAt,
    manifestRelativePath: record.storage.manifestRelativePath,
  } satisfies ContextPackLatestPointer);
}

function refreshLatestPointer(paths: ContextPackStoragePaths): void {
  const records = loadRecords(paths).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (records.length === 0) {
    if (fs.existsSync(paths.latestPath)) {
      fs.rmSync(paths.latestPath);
    }
    return;
  }
  writeLatestPointer(paths, records[0]);
}

export function getContextPackStoragePaths(cwd: string = process.cwd()): ContextPackStoragePaths {
  const repoRoot = resolveRepoRoot(cwd);
  const baseDir = path.join(repoRoot, BASE_RELATIVE_PATH);
  return {
    repoRoot,
    baseDir,
    blobsDir: path.join(repoRoot, BLOBS_RELATIVE_PATH),
    manifestsDir: path.join(repoRoot, MANIFESTS_RELATIVE_PATH),
    latestPath: path.join(repoRoot, LATEST_RELATIVE_PATH),
  };
}

export function packContext(options: PackContextOptions): PackContextResult {
  const paths = getContextPackStoragePaths(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const content = options.content;
  const bytes = Buffer.byteLength(content, "utf8");
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);

  if (bytes === 0) {
    throw new Error(
      "context-pack pack requires non-empty content from --text, --file, argument, or stdin."
    );
  }
  if (bytes > maxBytes) {
    throw new Error(`Context pack input is ${bytes} bytes, above the ${maxBytes} byte limit.`);
  }

  const digest = sha256(content);
  const id = `cpack_${digest.slice(0, 16)}`;
  const manifestPath = recordManifestPath(paths, id);
  const blobPath = recordBlobPath(paths, digest);
  const existing = readManifest(paths, manifestPath);
  const sensitive = hasSecretPattern(content);
  if (sensitive && !options.allowSensitive) {
    throw new Error(
      "Context pack input looks secret-like. Raw content would stay local, but packing it requires --allow-sensitive."
    );
  }
  const warnings = sensitive
    ? [
        {
          code: "secret_like_content_detected",
          message:
            "This pack is local-only and its manifest preview is redacted, but the exact blob contains secret-like content.",
        },
      ]
    : [];
  const previewContent = sensitive ? redactSecretLikeContent(content) : content;
  const createdAt = existing?.createdAt ?? nowIso;
  const record: ContextPackRecord = {
    version: "snipara.context_pack.v1",
    id,
    createdAt,
    updatedAt: nowIso,
    kind: options.kind ? normalizeKind(options.kind) : (existing?.kind ?? "tool_output"),
    label: options.label?.trim() || existing?.label || null,
    source: options.source?.trim() || existing?.source || null,
    tags: uniqueStrings([...(existing?.tags ?? []), ...(options.tags ?? [])]),
    repoRoot: paths.repoRoot,
    sha256: digest,
    bytes,
    lineCount: countLines(content),
    contentType: "text/plain",
    contentEncoding: "utf8",
    preview: buildPreview(previewContent),
    expiresAt: expiryFromTtl(now, options.ttlDays) ?? existing?.expiresAt ?? null,
    sensitive,
    warnings,
    storage: {
      baseRelativePath: normalizeRelativePath(BASE_RELATIVE_PATH),
      manifestRelativePath: normalizeRelativePath(path.relative(paths.repoRoot, manifestPath)),
      blobRelativePath: normalizeRelativePath(path.relative(paths.repoRoot, blobPath)),
    },
  };

  ensureStorageGitignore(paths);
  ensureDir(paths.blobsDir);
  ensureDir(paths.manifestsDir);
  if (!fs.existsSync(blobPath)) {
    fs.writeFileSync(blobPath, content, { encoding: "utf8", mode: 0o600 });
  }
  writeJsonFile(manifestPath, record);
  writeLatestPointer(paths, record);

  return {
    record,
    created: existing === null,
    baseDir: paths.baseDir,
    manifestPath,
    blobPath,
  };
}

export function resolveContextPackRecord(
  idOrRef: string,
  cwd: string = process.cwd()
): { paths: ContextPackStoragePaths; record: ContextPackRecord; manifestPath: string } {
  const paths = getContextPackStoragePaths(cwd);
  const query = idOrRef.trim();
  if (!query) {
    throw new Error("A context pack id, hash prefix, or 'latest' is required.");
  }

  if (query === "latest") {
    const pointer = latestPointer(paths);
    if (!pointer) {
      throw new Error("No latest context pack is available.");
    }
    const manifestPath = path.join(paths.repoRoot, pointer.manifestRelativePath);
    const record = readManifest(paths, manifestPath);
    if (!record) {
      throw new Error(`Latest context pack manifest is missing or invalid: ${pointer.id}`);
    }
    return { paths, record, manifestPath };
  }

  const directId = query.startsWith("cpack_") ? query : `cpack_${query}`;
  const directManifestPath = recordManifestPath(paths, directId);
  const directRecord = readManifest(paths, directManifestPath);
  if (directRecord) {
    return { paths, record: directRecord, manifestPath: directManifestPath };
  }

  const matches = loadRecords(paths).filter(
    (record) =>
      record.id.startsWith(query) ||
      record.id.startsWith(directId) ||
      record.sha256.startsWith(query)
  );
  if (matches.length === 0) {
    throw new Error(`Context pack not found: ${idOrRef}`);
  }
  if (matches.length > 1) {
    throw new Error(`Context pack reference is ambiguous: ${idOrRef}`);
  }
  const record = matches[0];
  return { paths, record, manifestPath: recordManifestPath(paths, record.id) };
}

export function retrieveContextPack(
  idOrRef: string,
  cwd: string = process.cwd()
): RetrieveContextPackResult {
  const { paths, record, manifestPath } = resolveContextPackRecord(idOrRef, cwd);
  const blobPath = path.join(paths.repoRoot, record.storage.blobRelativePath);
  if (!fs.existsSync(blobPath)) {
    throw new Error(`Context pack blob is missing for ${record.id}`);
  }

  return {
    record,
    content: fs.readFileSync(blobPath, "utf8"),
    baseDir: paths.baseDir,
    manifestPath,
    blobPath,
  };
}

export function buildContextPackStats(
  options: ContextPackStatsCommandOptions = {}
): ContextPackStats {
  const paths = getContextPackStoragePaths(options.cwd ?? process.cwd());
  const records = loadRecords(paths);
  const now = new Date();
  const kinds: Record<string, number> = {};

  for (const record of records) {
    kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
  }

  const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pointer = latestPointer(paths);
  return {
    version: "snipara.context_pack.stats.v1",
    baseDir: paths.baseDir,
    totalPacks: records.length,
    totalBytes: records.reduce((total, record) => total + record.bytes, 0),
    sensitivePacks: records.filter((record) => record.sensitive).length,
    expiredPacks: records.filter((record) => isExpired(record, now)).length,
    kinds,
    oldestCreatedAt: sorted[0]?.createdAt ?? null,
    newestCreatedAt: sorted[sorted.length - 1]?.createdAt ?? null,
    latestId: pointer?.id ?? null,
  };
}

export function cleanContextPacks(
  options: ContextPackCleanCommandOptions = {}
): ContextPackCleanResult {
  const paths = getContextPackStoragePaths(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  const olderThanDays = optionalPositiveInteger(options.olderThanDays);
  const records = loadRecords(paths);
  const selected = records.filter((record) => {
    if (options.all) {
      return true;
    }
    if (olderThanDays !== undefined && isOlderThan(record, olderThanDays, now)) {
      return true;
    }
    if (options.expired !== false && isExpired(record, now)) {
      return true;
    }
    return false;
  });

  if (!options.dryRun) {
    for (const record of selected) {
      fs.rmSync(recordManifestPath(paths, record.id), { force: true });
      fs.rmSync(path.join(paths.repoRoot, record.storage.blobRelativePath), { force: true });
    }
    refreshLatestPointer(paths);
  }

  return {
    version: "snipara.context_pack.clean.v1",
    baseDir: paths.baseDir,
    dryRun: Boolean(options.dryRun),
    selected: selected.length,
    deleted: options.dryRun ? 0 : selected.length,
    deletedIds: selected.map((record) => record.id),
  };
}

function readPackContent(options: ContextPackPackCommandOptions): {
  content: string;
  source?: string;
  kind?: string;
} {
  if (options.file) {
    const filePath = path.resolve(options.cwd ?? process.cwd(), options.file);
    const content = fs.readFileSync(filePath, "utf8");
    const paths = getContextPackStoragePaths(options.cwd ?? process.cwd());
    return {
      content,
      source: options.source ?? toRepoRelative(paths.repoRoot, filePath),
      kind: options.kind ?? "file",
    };
  }
  if (options.text !== undefined) {
    return { content: options.text, source: options.source, kind: options.kind ?? "text" };
  }
  if (options.input !== undefined) {
    return { content: options.input, source: options.source, kind: options.kind };
  }
  throw new Error("context-pack pack requires --text, --file, an argument, or piped stdin.");
}

function printPackResult(result: PackContextResult): void {
  console.log(`${result.created ? "Packed" : "Updated"} local context pack: ${result.record.id}`);
  console.log(`Stored under: ${result.record.storage.baseRelativePath}`);
  console.log(`Bytes: ${result.record.bytes}`);
  console.log(`Retrieve: snipara-companion context-pack retrieve ${result.record.id}`);
  if (result.record.warnings.length > 0) {
    for (const warning of result.record.warnings) {
      console.warn(`Warning: ${warning.message}`);
    }
  }
  console.log("Raw content stayed local; no hosted upload was performed.");
}

function printStats(stats: ContextPackStats): void {
  console.log(`Local context packs: ${stats.totalPacks}`);
  console.log(`Bytes: ${stats.totalBytes}`);
  console.log(`Expired: ${stats.expiredPacks}`);
  console.log(`Sensitive-looking: ${stats.sensitivePacks}`);
  console.log(`Storage: ${stats.baseDir}`);
}

function printCleanResult(result: ContextPackCleanResult): void {
  const action = result.dryRun ? "Selected" : "Deleted";
  console.log(`${action} context packs: ${result.dryRun ? result.selected : result.deleted}`);
  if (result.deletedIds.length > 0) {
    console.log(`Ids: ${result.deletedIds.join(", ")}`);
  }
}

export async function contextPackPackCommand(
  options: ContextPackPackCommandOptions
): Promise<void> {
  const input = readPackContent(options);
  const result = packContext({
    cwd: options.cwd,
    content: input.content,
    label: options.label,
    source: input.source,
    kind: input.kind,
    tags: options.tags,
    ttlDays: options.ttlDays,
    maxBytes: options.maxBytes,
    allowSensitive: options.allowSensitive,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printPackResult(result);
}

export async function contextPackRetrieveCommand(
  idOrRef: string,
  options: ContextPackRetrieveCommandOptions = {}
): Promise<void> {
  const result = retrieveContextPack(idOrRef, options.cwd);
  if (options.output) {
    const outputPath = path.resolve(options.cwd ?? process.cwd(), options.output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, result.content, { encoding: "utf8", mode: 0o600 });
    if (options.json) {
      const payload = options.metadataOnly
        ? {
            record: result.record,
            baseDir: result.baseDir,
            manifestPath: result.manifestPath,
            blobPath: result.blobPath,
            outputPath,
          }
        : { ...result, outputPath };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Wrote context pack ${result.record.id} to ${outputPath}`);
    return;
  }
  if (options.json) {
    const payload = options.metadataOnly
      ? {
          record: result.record,
          baseDir: result.baseDir,
          manifestPath: result.manifestPath,
          blobPath: result.blobPath,
        }
      : result;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  process.stdout.write(result.content);
}

export async function contextPackStatsCommand(
  options: ContextPackStatsCommandOptions = {}
): Promise<void> {
  const stats = buildContextPackStats(options);
  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  printStats(stats);
}

export async function contextPackCleanCommand(
  options: ContextPackCleanCommandOptions = {}
): Promise<void> {
  const result = cleanContextPacks(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printCleanResult(result);
}
