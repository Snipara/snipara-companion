/**
 * Local query cache for hosted context retrieval.
 *
 * Caches context/query results on disk so repeated hook lookups (especially
 * `pre-tool`) stay fast and resilient when offline. Matches use three
 * strategies — exact, nearby, and warm (similarity-based) — with configurable
 * TTLs, entry/byte caps, and similarity thresholds (overridable via RLM_CACHE_*
 * env vars). Query text is normalized and stop-words are stripped before
 * matching.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  normalizeSessionMemoriesResult,
  type ContextQueryResult,
  type SessionMemoriesResult,
} from "../api/client";
import { findWorkspaceRoot } from "../config/store";

type CacheStrategy = "exact" | "nearby" | "warm";

const CACHE_VERSION = 2;
const WARM_SNAPSHOT_VERSION = 1;
const SEARCH_MODE = "hybrid";
const DEFAULT_TTL_MS = readPositiveInt("RLM_CACHE_TTL_MS", 15 * 60 * 1000);
const DEFAULT_WARM_TTL_MS = readPositiveInt("RLM_WARM_CONTEXT_TTL_MS", 60 * 60 * 1000);
const DEFAULT_MAX_ENTRIES = readPositiveInt("RLM_CACHE_MAX_ENTRIES", 250);
const DEFAULT_MAX_BYTES = readPositiveInt("RLM_CACHE_MAX_BYTES", 24 * 1024 * 1024);
const DEFAULT_NEARBY_SIMILARITY = readPositiveFloat("RLM_CACHE_NEARBY_SIMILARITY", 0.82);
const DEFAULT_WARM_SIMILARITY = readPositiveFloat("RLM_CACHE_WARM_SIMILARITY", 0.72);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "edit",
  "file",
  "files",
  "for",
  "glob",
  "grep",
  "in",
  "json",
  "of",
  "or",
  "path",
  "paths",
  "read",
  "search",
  "the",
  "to",
  "tool",
  "write",
]);

interface CacheIndexEntry {
  key: string;
  fileName: string;
  workspaceKey: string;
  workspaceRoot: string;
  projectId?: string;
  sessionId?: string;
  query: string;
  normalizedQuery: string;
  queryTokens: string[];
  maxTokens: number;
  searchMode: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  sizeBytes: number;
  sections: number;
}

interface WarmSnapshotEntry {
  title: string;
  content: string;
  tier: "durable-memory" | "session-context";
  tokens: string[];
}

interface WarmSnapshotMeta {
  workspaceKey: string;
  workspaceRoot: string;
  projectId?: string;
  sessionId?: string;
  fileName: string;
  createdAt: number;
  expiresAt: number;
  entries: number;
  sizeBytes: number;
}

interface CacheIndex {
  version: number;
  entries: CacheIndexEntry[];
  warmSnapshots: WarmSnapshotMeta[];
}

interface PersistedCachePayload {
  version: number;
  storedAt: number;
  result: ContextQueryResult;
}

interface PersistedWarmSnapshot {
  version: number;
  workspaceKey: string;
  workspaceRoot: string;
  projectId?: string;
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
  entries: WarmSnapshotEntry[];
}

export interface QueryCacheScope {
  cwd?: string;
  projectId?: string;
  sessionId?: string;
}

export interface QueryCacheLookup {
  query: string;
  maxTokens: number;
}

export interface QueryCacheHit {
  strategy: CacheStrategy;
  result: ContextQueryResult;
  sourceQuery: string;
  similarity?: number;
}

export interface WarmSnapshotResult {
  storedEntries: number;
  fileName?: string;
}

interface CacheScopeState {
  cwd: string;
  workspaceRoot: string;
  workspaceKey: string;
  projectId?: string;
  sessionId?: string;
}

export class LocalQueryCache {
  private readonly scope: CacheScopeState;
  private readonly ttlMs: number;
  private readonly warmTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(scope: QueryCacheScope = {}) {
    this.scope = resolveScope(scope);
    this.ttlMs = DEFAULT_TTL_MS;
    this.warmTtlMs = DEFAULT_WARM_TTL_MS;
    this.maxEntries = DEFAULT_MAX_ENTRIES;
    this.maxBytes = DEFAULT_MAX_BYTES;
  }

  lookup(options: QueryCacheLookup): QueryCacheHit | null {
    const normalizedQuery = normalizeQuery(options.query, this.scope.workspaceRoot);
    if (!normalizedQuery) {
      return null;
    }

    const key = buildCacheKey(this.scope.workspaceKey, normalizedQuery, options.maxTokens);
    const index = this.loadIndex();
    const exactEntry = index.entries.find((entry) => entry.key === key);
    if (exactEntry) {
      const exactResult = this.readEntry(exactEntry, index);
      if (exactResult) {
        return {
          strategy: "exact",
          result: exactResult,
          sourceQuery: exactEntry.query,
        };
      }
    }

    const queryTokens = tokenizeQuery(normalizedQuery);
    const nearbyEntry = this.findNearbyEntry(
      index,
      normalizedQuery,
      queryTokens,
      options.maxTokens
    );
    if (nearbyEntry) {
      const result = this.readEntry(nearbyEntry.entry, index);
      if (result) {
        return {
          strategy: "nearby",
          result,
          sourceQuery: nearbyEntry.entry.query,
          similarity: nearbyEntry.similarity,
        };
      }
    }

    return this.lookupWarmSnapshot(index, options.query, queryTokens);
  }

  save(options: QueryCacheLookup, result: ContextQueryResult): void {
    const normalizedQuery = normalizeQuery(options.query, this.scope.workspaceRoot);
    if (!normalizedQuery) {
      return;
    }

    const key = buildCacheKey(this.scope.workspaceKey, normalizedQuery, options.maxTokens);
    const fileName = `${key}.json`;
    const filePath = path.join(getCacheDir(), fileName);
    const now = Date.now();
    const payload: PersistedCachePayload = {
      version: CACHE_VERSION,
      storedAt: now,
      result,
    };
    const content = JSON.stringify(payload);

    ensureCacheDir();
    try {
      fs.writeFileSync(filePath, content, "utf8");
    } catch {
      return;
    }

    const index = this.loadIndex();
    index.entries = index.entries.filter((entry) => entry.key !== key);
    index.entries.push({
      key,
      fileName,
      workspaceKey: this.scope.workspaceKey,
      workspaceRoot: this.scope.workspaceRoot,
      projectId: this.scope.projectId,
      sessionId: this.scope.sessionId,
      query: options.query,
      normalizedQuery,
      queryTokens: tokenizeQuery(normalizedQuery),
      maxTokens: options.maxTokens,
      searchMode: SEARCH_MODE,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.ttlMs,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      sections: result.sections.length,
    });
    this.persistIndex(index);
  }

  storeWarmSnapshot(result: SessionMemoriesResult): WarmSnapshotResult {
    const entries = extractWarmSnapshotEntries(result);
    const index = this.loadIndex();
    const fileName = `warm-${this.scope.workspaceKey}.json`;
    const filePath = path.join(getCacheDir(), fileName);

    index.warmSnapshots = index.warmSnapshots.filter(
      (snapshot) => snapshot.workspaceKey !== this.scope.workspaceKey
    );

    if (entries.length === 0) {
      tryDeleteFile(filePath);
      this.persistIndex(index);
      return { storedEntries: 0 };
    }

    const now = Date.now();
    const snapshot: PersistedWarmSnapshot = {
      version: WARM_SNAPSHOT_VERSION,
      workspaceKey: this.scope.workspaceKey,
      workspaceRoot: this.scope.workspaceRoot,
      projectId: this.scope.projectId,
      sessionId: this.scope.sessionId,
      createdAt: now,
      expiresAt: now + this.warmTtlMs,
      entries,
    };
    const content = JSON.stringify(snapshot);

    ensureCacheDir();
    try {
      fs.writeFileSync(filePath, content, "utf8");
    } catch {
      return { storedEntries: 0 };
    }

    index.warmSnapshots.push({
      workspaceKey: this.scope.workspaceKey,
      workspaceRoot: this.scope.workspaceRoot,
      projectId: this.scope.projectId,
      sessionId: this.scope.sessionId,
      fileName,
      createdAt: now,
      expiresAt: now + this.warmTtlMs,
      entries: entries.length,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });
    this.persistIndex(index);
    return { storedEntries: entries.length, fileName };
  }

  clear(): number {
    const cacheDir = getCacheDir();
    if (!fs.existsSync(cacheDir)) {
      return 0;
    }

    const files = fs.readdirSync(cacheDir).filter((file) => file.endsWith(".json"));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    return files.length;
  }

  private loadIndex(): CacheIndex {
    ensureCacheDir();
    const indexFile = getIndexFile();
    if (!fs.existsSync(indexFile)) {
      return emptyIndex();
    }

    try {
      const content = fs.readFileSync(indexFile, "utf8");
      const parsed = JSON.parse(content) as Partial<CacheIndex>;
      const index: CacheIndex = {
        version: parsed.version === CACHE_VERSION ? CACHE_VERSION : CACHE_VERSION,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        warmSnapshots: Array.isArray(parsed.warmSnapshots) ? parsed.warmSnapshots : [],
      };

      return this.pruneIndex(index);
    } catch {
      return emptyIndex();
    }
  }

  private persistIndex(index: CacheIndex): void {
    const pruned = this.pruneIndex(index);
    ensureCacheDir();
    try {
      fs.writeFileSync(getIndexFile(), JSON.stringify(pruned, null, 2), "utf8");
    } catch {
      // Ignore cache persistence failures.
    }
  }

  private pruneIndex(index: CacheIndex): CacheIndex {
    const now = Date.now();
    const cacheDir = getCacheDir();

    index.entries = index.entries.filter((entry) => {
      if (entry.expiresAt <= now) {
        tryDeleteFile(path.join(cacheDir, entry.fileName));
        return false;
      }
      if (!fs.existsSync(path.join(cacheDir, entry.fileName))) {
        return false;
      }
      return true;
    });

    index.warmSnapshots = index.warmSnapshots.filter((snapshot) => {
      if (snapshot.expiresAt <= now) {
        tryDeleteFile(path.join(cacheDir, snapshot.fileName));
        return false;
      }
      if (!fs.existsSync(path.join(cacheDir, snapshot.fileName))) {
        return false;
      }
      return true;
    });

    index.entries.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);

    let totalBytes =
      index.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
      index.warmSnapshots.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);

    while (index.entries.length > this.maxEntries || totalBytes > this.maxBytes) {
      const removed = index.entries.pop();
      if (!removed) {
        break;
      }
      totalBytes -= removed.sizeBytes;
      tryDeleteFile(path.join(cacheDir, removed.fileName));
    }

    return index;
  }

  private readEntry(entry: CacheIndexEntry, index: CacheIndex): ContextQueryResult | null {
    const filePath = path.join(getCacheDir(), entry.fileName);
    if (!fs.existsSync(filePath)) {
      index.entries = index.entries.filter((candidate) => candidate.key !== entry.key);
      this.persistIndex(index);
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as PersistedCachePayload;
      if (parsed.version !== CACHE_VERSION || !isContextQueryResult(parsed.result)) {
        throw new Error("invalid cache payload");
      }

      entry.lastAccessedAt = Date.now();
      this.persistIndex(index);
      return parsed.result;
    } catch {
      tryDeleteFile(filePath);
      index.entries = index.entries.filter((candidate) => candidate.key !== entry.key);
      this.persistIndex(index);
      return null;
    }
  }

  private findNearbyEntry(
    index: CacheIndex,
    normalizedQuery: string,
    queryTokens: string[],
    maxTokens: number
  ): { entry: CacheIndexEntry; similarity: number } | null {
    const candidates = index.entries
      .filter(
        (entry) =>
          entry.workspaceKey === this.scope.workspaceKey &&
          entry.searchMode === SEARCH_MODE &&
          entry.maxTokens === maxTokens &&
          entry.queryTokens.length > 0
      )
      .map((entry) => ({
        entry,
        similarity: computeSimilarity(
          normalizedQuery,
          queryTokens,
          entry.normalizedQuery,
          entry.queryTokens
        ),
      }))
      .filter((candidate) => candidate.similarity >= DEFAULT_NEARBY_SIMILARITY)
      .sort((left, right) => {
        if (right.similarity !== left.similarity) {
          return right.similarity - left.similarity;
        }
        return right.entry.lastAccessedAt - left.entry.lastAccessedAt;
      });

    return candidates[0] ?? null;
  }

  private lookupWarmSnapshot(
    index: CacheIndex,
    query: string,
    queryTokens: string[]
  ): QueryCacheHit | null {
    if (queryTokens.length === 0) {
      return null;
    }

    const snapshotMeta = index.warmSnapshots.find(
      (snapshot) =>
        snapshot.workspaceKey === this.scope.workspaceKey &&
        (!snapshot.sessionId ||
          !this.scope.sessionId ||
          snapshot.sessionId === this.scope.sessionId)
    );
    if (!snapshotMeta) {
      return null;
    }

    const filePath = path.join(getCacheDir(), snapshotMeta.fileName);
    if (!fs.existsSync(filePath)) {
      index.warmSnapshots = index.warmSnapshots.filter(
        (snapshot) => snapshot.workspaceKey !== this.scope.workspaceKey
      );
      this.persistIndex(index);
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const snapshot = JSON.parse(content) as PersistedWarmSnapshot;
      if (
        snapshot.version !== WARM_SNAPSHOT_VERSION ||
        snapshot.workspaceKey !== this.scope.workspaceKey ||
        !Array.isArray(snapshot.entries)
      ) {
        throw new Error("invalid warm snapshot");
      }

      const matches = snapshot.entries
        .map((entry) => ({
          entry,
          similarity: computeWarmSimilarity(queryTokens, entry.tokens),
        }))
        .filter((candidate) => candidate.similarity >= DEFAULT_WARM_SIMILARITY)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, 2);

      if (matches.length === 0) {
        return null;
      }

      return {
        strategy: "warm",
        result: {
          sections: matches.map(({ entry, similarity }) => ({
            title: `${warmSnapshotTierLabel(entry.tier)}: ${entry.title} (${Math.round(similarity * 100)}%)`,
            content: entry.content,
            file: "",
            lines: [0, 0] as [number, number],
            relevance_score: similarity,
            token_count: approximateTokenCount(entry.content),
            truncated: false,
          })),
          total_tokens: matches.reduce(
            (sum, { entry }) => sum + approximateTokenCount(entry.content),
            0
          ),
          max_tokens: 0,
          query,
          suggestions: [],
        },
        sourceQuery: "session-bootstrap",
        similarity: matches[0]?.similarity,
      };
    } catch {
      tryDeleteFile(filePath);
      index.warmSnapshots = index.warmSnapshots.filter(
        (snapshot) => snapshot.workspaceKey !== this.scope.workspaceKey
      );
      this.persistIndex(index);
      return null;
    }
  }
}

export function createLocalQueryCache(scope: QueryCacheScope = {}): LocalQueryCache {
  return new LocalQueryCache(scope);
}

function resolveScope(scope: QueryCacheScope): CacheScopeState {
  const cwd = path.resolve(scope.cwd ?? process.cwd());
  const workspaceRoot = normalizeFilePath(findWorkspaceRoot(cwd, true) ?? cwd);
  const workspaceKey = hashString(
    JSON.stringify({ projectId: scope.projectId ?? "", workspaceRoot })
  );
  return {
    cwd,
    workspaceRoot,
    workspaceKey,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
  };
}

function normalizeQuery(query: string, workspaceRoot: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedRoot = normalizeFilePath(workspaceRoot);
  let normalized = normalizeFilePath(trimmed);
  if (normalizedRoot) {
    const escapedRoot = escapeRegExp(normalizedRoot);
    normalized = normalized.replace(new RegExp(escapedRoot, "gi"), "$workspace");
  }

  return normalized.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeQuery(value: string): string[] {
  const normalized = value
    .replace(/[$]/g, " ")
    .replace(/[\\/]/g, " ")
    .replace(/[^a-z0-9._-]+/gi, " ")
    .toLowerCase();

  const tokens = new Set<string>();
  for (const part of normalized.split(/\s+/)) {
    if (!part) {
      continue;
    }
    for (const nested of part.split(/[._-]+/)) {
      const token = nested.trim();
      if (token.length < 2 || STOP_WORDS.has(token)) {
        continue;
      }
      if (/^\d+$/.test(token) && token.length < 4) {
        continue;
      }
      tokens.add(token);
    }
  }

  return Array.from(tokens).sort();
}

function computeSimilarity(
  normalizedQuery: string,
  queryTokens: string[],
  candidateQuery: string,
  candidateTokens: string[]
): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const querySet = new Set(queryTokens);
  const candidateSet = new Set(candidateTokens);
  let intersection = 0;
  for (const token of querySet) {
    if (candidateSet.has(token)) {
      intersection += 1;
    }
  }

  if (intersection === 0) {
    return 0;
  }

  const overlap = intersection / Math.min(querySet.size, candidateSet.size);
  const union = new Set([...querySet, ...candidateSet]).size;
  const jaccard = intersection / union;
  const prefixBoost =
    normalizedQuery.includes(candidateQuery) || candidateQuery.includes(normalizedQuery) ? 0.1 : 0;

  return Math.min(1, overlap * 0.75 + jaccard * 0.25 + prefixBoost);
}

function computeWarmSimilarity(queryTokens: string[], warmTokens: string[]): number {
  if (queryTokens.length === 0 || warmTokens.length === 0) {
    return 0;
  }

  const querySet = new Set(queryTokens);
  const warmSet = new Set(warmTokens);
  let intersection = 0;
  for (const token of querySet) {
    if (warmSet.has(token)) {
      intersection += 1;
    }
  }

  if (intersection === 0) {
    return 0;
  }

  const overlap = intersection / Math.min(querySet.size, warmSet.size);
  const union = new Set([...querySet, ...warmSet]).size;
  return Math.min(1, overlap * 0.7 + (intersection / union) * 0.3);
}

function buildCacheKey(workspaceKey: string, normalizedQuery: string, maxTokens: number): string {
  return hashString(`${workspaceKey}::${SEARCH_MODE}::${maxTokens}::${normalizedQuery}`);
}

function extractWarmSnapshotEntries(result: SessionMemoriesResult): WarmSnapshotEntry[] {
  const normalized = normalizeSessionMemoriesResult(result);
  const entries: WarmSnapshotEntry[] = [];

  const addEntries = (
    tier: "durable-memory" | "session-context",
    value: Array<Record<string, unknown>>
  ): void => {
    for (const record of value) {
      const title =
        readFirstString(record, ["title", "category", "type"]) || warmSnapshotTierLabel(tier);
      const content = readFirstString(record, ["text", "content", "summary", "description"]) || "";
      const normalizedContent = content.replace(/\s+/g, " ").trim();
      if (!normalizedContent) {
        continue;
      }

      entries.push({
        title,
        content: normalizedContent,
        tier,
        tokens: tokenizeQuery(normalizedContent),
      });
    }
  };

  addEntries("durable-memory", normalized.critical.memories);
  addEntries("session-context", normalized.daily.memories);

  return entries.slice(0, 8);
}

function warmSnapshotTierLabel(tier: WarmSnapshotEntry["tier"]): string {
  return tier === "durable-memory" ? "Durable Memory" : "Session Context";
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function isContextQueryResult(value: unknown): value is ContextQueryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const result = value as Partial<ContextQueryResult>;
  return Array.isArray(result.sections) && typeof result.query === "string";
}

function approximateTokenCount(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.3));
}

function emptyIndex(): CacheIndex {
  return {
    version: CACHE_VERSION,
    entries: [],
    warmSnapshots: [],
  };
}

function ensureCacheDir(): void {
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function tryDeleteFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCacheDir(): string {
  return path.join(os.homedir(), ".snipara", "cache", "context-v2");
}

function getIndexFile(): string {
  return path.join(getCacheDir(), "index.json");
}
