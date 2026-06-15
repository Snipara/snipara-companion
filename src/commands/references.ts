/**
 * `references` commands — capture external doc references with provenance.
 *
 * `scan` walks local docs for external URLs and writes a manifest
 * (.snipara/references/manifest.json) with per-URL allow/deny status; `ingest`
 * fetches the allowed ones into source-backed Markdown snapshots and can upload
 * them to Snipara. Domain allow/deny lists gate every fetch, and snapshots keep
 * provenance so retrieved context is traceable to its source.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { createClient } from "../api/client";

const MANIFEST_VERSION = "snipara.references.v1";
const DEFAULT_MANIFEST_PATH = path.join(".snipara", "references", "manifest.json");
const DEFAULT_SNAPSHOT_DIR = path.join(".snipara", "references", "snapshots");
const DEFAULT_DESTINATION_PREFIX = "external-references";
const DEFAULT_SCAN_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".snipara",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);

type ReferenceStatus = "allowed" | "pending" | "denied" | "unsupported";

export interface ReferenceOccurrence {
  file: string;
  line: number;
  label?: string;
}

export interface ReferenceManifestItem {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  status: ReferenceStatus;
  reason: string;
  discoveredAt: string;
  occurrences: ReferenceOccurrence[];
  latestSnapshotPath?: string;
  latestFetchStatus?: number;
  latestFetchAt?: string;
  latestContentHash?: string;
  latestError?: string;
}

export interface ReferenceManifest {
  version: typeof MANIFEST_VERSION;
  generatedAt: string;
  root: string;
  allowDomains: string[];
  denyDomains: string[];
  items: ReferenceManifestItem[];
}

export interface ScanReferencesOptions {
  root?: string;
  output?: string;
  allowDomain?: string[];
  denyDomain?: string[];
  extensions?: string[];
  maxFiles?: number;
  json?: boolean;
}

export interface IngestReferencesOptions {
  manifest?: string;
  outputDir?: string;
  allowDomain?: string[];
  ids?: string[];
  max?: number;
  timeoutMs?: number;
  maxBytes?: number;
  destinationPrefix?: string;
  upload?: boolean;
  reindex?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface ScanSummary {
  manifest: ReferenceManifest;
  outputPath: string;
  scannedFiles: number;
  foundUrls: number;
  allowed: number;
  pending: number;
  denied: number;
  unsupported: number;
}

interface FetchSnapshot {
  item: ReferenceManifestItem;
  fetchedAt: string;
  status: number;
  statusText: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  contentHash: string;
  markdown: string;
  snapshotPath: string;
  destinationPath: string;
}

interface IngestSummary {
  manifestPath: string;
  selected: number;
  fetched: number;
  uploaded: number;
  failed: number;
  dryRun: boolean;
  snapshots: Array<{
    id: string;
    url: string;
    snapshotPath?: string;
    destinationPath?: string;
    status?: number;
    uploaded?: boolean;
    error?: string;
  }>;
}

function normalizeList(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => normalizeDomain(value))
        .filter(Boolean)
    )
  ).sort();
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function normalizeUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim().replace(/[),.;\]}>]+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function domainMatches(domain: string, patterns: string[]): boolean {
  const normalized = normalizeDomain(domain);
  return patterns.some((pattern) => {
    const candidate = normalizeDomain(pattern);
    return normalized === candidate || normalized.endsWith(`.${candidate}`);
  });
}

function classifyReference(
  url: string,
  allowDomains: string[],
  denyDomains: string[]
): { status: ReferenceStatus; reason: string; domain: string } {
  const parsed = new URL(url);
  const domain = normalizeDomain(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "unsupported", reason: "unsupported_protocol", domain };
  }
  if (domainMatches(domain, denyDomains)) {
    return { status: "denied", reason: "denylist_match", domain };
  }
  if (allowDomains.length === 0) {
    return { status: "pending", reason: "requires_allow_domain", domain };
  }
  if (domainMatches(domain, allowDomains)) {
    return { status: "allowed", reason: "allowlist_match", domain };
  }
  return { status: "pending", reason: "outside_allowlist", domain };
}

function referenceId(normalizedUrl: string): string {
  return crypto.createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 12);
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function toRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function walkFiles(
  root: string,
  extensions: Set<string>,
  maxFiles: number,
  files: string[] = []
): string[] {
  if (files.length >= maxFiles) {
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (files.length >= maxFiles) {
      break;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!DEFAULT_IGNORE_DIRS.has(entry.name)) {
        walkFiles(fullPath, extensions, maxFiles, files);
      }
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectReferenceItems(
  root: string,
  files: string[],
  allowDomains: string[],
  denyDomains: string[]
): ReferenceManifestItem[] {
  const byUrl = new Map<string, ReferenceManifestItem>();
  const discoveredAt = new Date().toISOString();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split(/\r?\n/);
    const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    const bareUrl = /https?:\/\/[^\s<>"'`]+/g;

    for (const [index, line] of lines.entries()) {
      const lineSeen = new Set<string>();
      const add = (rawUrl: string, label?: string): void => {
        const normalizedUrl = normalizeUrl(rawUrl);
        if (!normalizedUrl || lineSeen.has(normalizedUrl)) {
          return;
        }
        lineSeen.add(normalizedUrl);
        const classification = classifyReference(normalizedUrl, allowDomains, denyDomains);
        const existing = byUrl.get(normalizedUrl);
        const occurrence = {
          file: toRelative(root, file),
          line: index + 1,
          ...(label ? { label: label.trim() } : {}),
        };
        if (existing) {
          existing.occurrences.push(occurrence);
          return;
        }
        byUrl.set(normalizedUrl, {
          id: referenceId(normalizedUrl),
          url: rawUrl.trim(),
          normalizedUrl,
          domain: classification.domain,
          status: classification.status,
          reason: classification.reason,
          discoveredAt,
          occurrences: [occurrence],
        });
      };

      for (const match of line.matchAll(markdownLink)) {
        add(match[2] ?? "", match[1]);
      }
      for (const match of line.matchAll(bareUrl)) {
        add(match[0] ?? "");
      }
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => a.normalizedUrl.localeCompare(b.normalizedUrl));
}

export function scanReferences(options: ScanReferencesOptions = {}): ScanSummary {
  const root = path.resolve(options.root ?? process.cwd());
  const outputPath = path.resolve(root, options.output ?? DEFAULT_MANIFEST_PATH);
  const allowDomains = normalizeList(options.allowDomain);
  const denyDomains = normalizeList(options.denyDomain);
  const extensions = new Set(
    (options.extensions?.length ? options.extensions : Array.from(DEFAULT_SCAN_EXTENSIONS)).map(
      (extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase()
    )
  );
  const maxFiles = options.maxFiles ?? 500;
  const files = walkFiles(root, extensions, maxFiles);
  const items = collectReferenceItems(root, files, allowDomains, denyDomains);
  const manifest: ReferenceManifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    allowDomains,
    denyDomains,
    items,
  };

  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return {
    manifest,
    outputPath,
    scannedFiles: files.length,
    foundUrls: items.length,
    allowed: items.filter((item) => item.status === "allowed").length,
    pending: items.filter((item) => item.status === "pending").length,
    denied: items.filter((item) => item.status === "denied").length,
    unsupported: items.filter((item) => item.status === "unsupported").length,
  };
}

function readManifest(file: string): ReferenceManifest {
  const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as ReferenceManifest;
  if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.items)) {
    throw new Error(`${file} is not a ${MANIFEST_VERSION} manifest`);
  }
  return manifest;
}

function allowedForIngest(item: ReferenceManifestItem, allowDomains: string[]): boolean {
  return item.status === "allowed" || domainMatches(item.domain, allowDomains);
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function markdownForSnapshot(args: {
  item: ReferenceManifestItem;
  fetchedAt: string;
  status: number;
  statusText: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  body: string;
  bodyHash: string;
}): string {
  const content =
    args.contentType?.toLowerCase().includes("html") || /^\s*<!doctype html/i.test(args.body)
      ? textFromHtml(args.body)
      : args.body.trim();
  const referencedFrom = args.item.occurrences
    .map((occurrence) => {
      const label = occurrence.label ? ` (${occurrence.label})` : "";
      return `- ${occurrence.file}:${occurrence.line}${label}`;
    })
    .join("\n");

  return [
    `# External Reference: ${args.item.normalizedUrl}`,
    "",
    "## Provenance",
    "",
    `- Source URL: ${args.item.normalizedUrl}`,
    `- Domain: ${args.item.domain}`,
    `- Fetched At: ${args.fetchedAt}`,
    `- HTTP Status: ${args.status} ${args.statusText}`,
    `- Content-Type: ${args.contentType ?? "unknown"}`,
    `- ETag: ${args.etag ?? "unknown"}`,
    `- Last-Modified: ${args.lastModified ?? "unknown"}`,
    `- Content SHA256: ${args.bodyHash}`,
    "",
    "## Referenced From",
    "",
    referencedFrom || "- unknown",
    "",
    "## Content",
    "",
    content || "(empty response)",
    "",
  ].join("\n");
}

async function fetchReference(
  item: ReferenceManifestItem,
  outputDir: string,
  destinationPrefix: string,
  timeoutMs: number,
  maxBytes: number
): Promise<FetchSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(item.normalizedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "snipara-companion references/1",
        Accept:
          "text/markdown,text/plain,text/html,application/json,application/xml;q=0.8,*/*;q=0.5",
      },
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`content_length_exceeds_max_bytes:${contentLength}`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf-8") > maxBytes) {
      throw new Error(`response_exceeds_max_bytes:${Buffer.byteLength(body, "utf-8")}`);
    }

    const hash = contentHash(body);
    const slugSource = new URL(item.normalizedUrl).pathname.split("/").filter(Boolean).join("-");
    const fileName = `${sanitizeSegment(item.domain, "external")}-${sanitizeSegment(
      slugSource,
      item.id
    )}-${item.id}.md`;
    const snapshotPath = path.resolve(outputDir, fileName);
    const destinationPath = path.posix.join(
      destinationPrefix.replace(/^\/+|\/+$/g, "") || DEFAULT_DESTINATION_PREFIX,
      fileName
    );
    const markdown = markdownForSnapshot({
      item,
      fetchedAt,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      body,
      bodyHash: hash,
    });

    ensureParentDir(snapshotPath);
    fs.writeFileSync(snapshotPath, markdown, "utf-8");
    return {
      item,
      fetchedAt,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      contentHash: hash,
      markdown,
      snapshotPath,
      destinationPath,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function selectItems(
  manifest: ReferenceManifest,
  options: IngestReferencesOptions,
  allowDomains: string[]
): ReferenceManifestItem[] {
  const ids = new Set(options.ids ?? []);
  const selected = manifest.items.filter((item) => {
    if (ids.size > 0 && !ids.has(item.id)) {
      return false;
    }
    return allowedForIngest(item, allowDomains);
  });
  return typeof options.max === "number" && options.max > 0
    ? selected.slice(0, options.max)
    : selected;
}

export async function ingestReferences(
  options: IngestReferencesOptions = {}
): Promise<IngestSummary> {
  const manifestPath = path.resolve(options.manifest ?? DEFAULT_MANIFEST_PATH);
  const manifest = readManifest(manifestPath);
  const root = manifest.root ? path.resolve(manifest.root) : process.cwd();
  const allowDomains = normalizeList([
    ...(manifest.allowDomains ?? []),
    ...(options.allowDomain ?? []),
  ]);
  const outputDir = path.resolve(root, options.outputDir ?? DEFAULT_SNAPSHOT_DIR);
  const destinationPrefix = options.destinationPrefix ?? DEFAULT_DESTINATION_PREFIX;
  const items = selectItems(manifest, options, allowDomains);

  const summary: IngestSummary = {
    manifestPath,
    selected: items.length,
    fetched: 0,
    uploaded: 0,
    failed: 0,
    dryRun: Boolean(options.dryRun),
    snapshots: [],
  };

  if (options.dryRun) {
    summary.snapshots = items.map((item) => ({ id: item.id, url: item.normalizedUrl }));
    return summary;
  }

  const client = options.upload ? createClient(30000) : null;
  for (const item of items) {
    try {
      const snapshot = await fetchReference(
        item,
        outputDir,
        destinationPrefix,
        options.timeoutMs ?? 15000,
        options.maxBytes ?? 512 * 1024
      );
      summary.fetched += 1;
      item.latestSnapshotPath = path
        .relative(root, snapshot.snapshotPath)
        .split(path.sep)
        .join("/");
      item.latestFetchStatus = snapshot.status;
      item.latestFetchAt = snapshot.fetchedAt;
      item.latestContentHash = snapshot.contentHash;
      delete item.latestError;

      let uploaded = false;
      if (client) {
        await client.uploadDocument(snapshot.destinationPath, snapshot.markdown, {
          kind: "DOC",
          format: "md",
          metadata: {
            assetClass: "REFERENCE",
            usageMode: "historical_reference",
            sourceKind: "external_url",
            sourceUrl: item.normalizedUrl,
            sourceDomain: item.domain,
            sourceSnapshotAt: snapshot.fetchedAt,
            sourceContentHash: snapshot.contentHash,
            sourceHttpStatus: snapshot.status,
            sourceContentType: snapshot.contentType,
            sourceEtag: snapshot.etag,
            sourceLastModified: snapshot.lastModified,
            referencedFrom: item.occurrences,
            generatedBy: "snipara-companion references ingest",
          },
        });
        uploaded = true;
        summary.uploaded += 1;
      }
      summary.snapshots.push({
        id: item.id,
        url: item.normalizedUrl,
        snapshotPath: item.latestSnapshotPath,
        destinationPath: snapshot.destinationPath,
        status: snapshot.status,
        uploaded,
      });
    } catch (error) {
      summary.failed += 1;
      item.latestError = error instanceof Error ? error.message : String(error);
      summary.snapshots.push({
        id: item.id,
        url: item.normalizedUrl,
        error: item.latestError,
      });
    }
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  if (options.reindex && client) {
    await client.reindex({ kind: "doc", mode: "incremental" });
  }

  return summary;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function referencesScanCommand(options: ScanReferencesOptions): Promise<void> {
  const result = scanReferences(options);
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.bold("External References"));
  console.log(`Manifest: ${result.outputPath}`);
  console.log(`Files scanned: ${result.scannedFiles}`);
  console.log(`URLs found: ${result.foundUrls}`);
  console.log(`Allowed: ${result.allowed}`);
  console.log(`Pending allowlist: ${result.pending}`);
  console.log(`Denied: ${result.denied}`);
  if (result.pending > 0) {
    console.log(
      chalk.gray("Re-run with --allow-domain <domain> or pass --allow-domain to ingest.")
    );
  }
}

export async function referencesIngestCommand(options: IngestReferencesOptions): Promise<void> {
  const result = await ingestReferences(options);
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.bold("External Reference Ingest"));
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Selected: ${result.selected}`);
  if (result.dryRun) {
    console.log("Dry run: no fetch, local snapshot, upload, or manifest update performed.");
    return;
  }
  console.log(`Fetched: ${result.fetched}`);
  console.log(`Uploaded: ${result.uploaded}`);
  console.log(`Failed: ${result.failed}`);
  for (const snapshot of result.snapshots.slice(0, 10)) {
    const status = snapshot.error ? `failed: ${snapshot.error}` : `status ${snapshot.status}`;
    console.log(`- ${snapshot.url} (${status})`);
  }
}
