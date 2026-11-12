/**
 * `automations` commands — install dashboard-generated hook bundles.
 *
 * Fetches a project's automation bundle from hosted settings and installs it
 * into client config files (Claude Code, Cursor, Codex, …). Mergeable
 * instruction files (.cursorrules, AGENTS.md, CLAUDE.md, …) and JSON configs
 * (.mcp.json, .claude/settings.json) are merged rather than overwritten. A
 * local manifest (AUTOMATION_MANIFEST_RELATIVE_PATH) tracks installed files so
 * `status`/`diff` detect drift and `update` can refresh safely.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createClient,
  type AutomationConfigBundle,
  type AutomationConfigFile,
} from "../api/client";
import { loadConfig } from "../config/store";

export const AUTOMATION_MANIFEST_RELATIVE_PATH = ".snipara/automations/manifest.json";

const MANIFEST_VERSION = 1;
const SUPPORTED_CLIENTS = new Set([
  "claude-code",
  "cursor",
  "continue",
  "kimi",
  "gemini",
  "mistral",
  "chatgpt",
  "codex",
  "vscode",
  "custom",
]);
const MERGEABLE_MARKDOWN_INSTRUCTION_FILES = new Set([
  ".cursorrules",
  ".cursor/rules/snipara.mdc",
  ".github/copilot-instructions.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "MISTRAL.md",
]);
const MERGEABLE_JSON_CONFIG_FILES = new Set([
  ".mcp.json",
  ".claude/settings.json",
  ".continue/config.json",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".kimi-code/mcp.json",
  ".vscode/mcp.json",
  "mcp.json",
]);

const NATIVE_HOOK_CAPABLE_CLIENTS = new Set(["claude-code", "cursor", "kimi", "gemini", "codex"]);

type AutomationFileState = "create" | "update" | "unchanged" | "conflict";

const LOCAL_API_KEY_LOADER = `API_KEY=""
if command -v node >/dev/null 2>&1; then
  SNIPARA_CONFIG_ROOT="\${PROJECT_DIR:-$(pwd)}"
  API_KEY="$(SNIPARA_CONFIG_ROOT="$SNIPARA_CONFIG_ROOT" node <<'NODE' 2>/dev/null || true
const fs = require("fs");
const path = require("path");

const root = process.env.SNIPARA_CONFIG_ROOT || process.cwd();
const file = path.join(root, ".snipara", "companion", "config.json");

try {
  const key = JSON.parse(fs.readFileSync(file, "utf8")).apiKey;
  if (typeof key === "string" && key && !key.includes("YOUR_")) {
    process.stdout.write(key);
  }
} catch {
  // Missing or malformed config files are expected during first-time setup.
}
NODE
)"
fi
if [ -z "$API_KEY" ]; then
  API_KEY="\${SNIPARA_API_KEY:-}"
fi`;

export interface AutomationManifestFile {
  path: string;
  sha256: string;
}

export interface AutomationManifest {
  version: number;
  client: string;
  projectId?: string;
  apiUrl?: string;
  installedAt: string;
  files: AutomationManifestFile[];
}

export interface AutomationFilePlan {
  path: string;
  targetPath: string;
  state: AutomationFileState;
  reason: string;
  currentSha256?: string;
  previousSha256?: string;
  nextSha256: string;
  writeContent?: string;
}

export interface AutomationInstallResult {
  manifest: AutomationManifest;
  plan: AutomationFilePlan[];
  written: number;
  unchanged: number;
  dryRun: boolean;
}

export interface AutomationStatusResult {
  manifest: AutomationManifest | null;
  files: Array<{
    path: string;
    targetPath: string;
    state: "up-to-date" | "modified" | "missing";
    expectedSha256: string;
    currentSha256?: string;
  }>;
}

export class AutomationInstallConflictError extends Error {
  conflicts: AutomationFilePlan[];

  constructor(conflicts: AutomationFilePlan[]) {
    super(conflicts.some((item) => item.reason.startsWith("Invalid Snipara instruction markers"))
      ? "Invalid Snipara instruction markers require manual repair; --force cannot bypass marker conflicts."
      : "Automation install would overwrite local changes. Run automations diff to inspect changes, then retry with --force only if the overwrite is intentional.");
    this.name = "AutomationInstallConflictError";
    this.conflicts = conflicts;
  }
}

export class AutomationUnsupportedHookBundleError extends Error {
  client: string;
  files: string[];

  constructor(client: string, files: string[]) {
    super(
      [
        `Automation bundle for ${client} contains native hook files that Snipara does not install for this client.`,
        `Blocked files: ${files.join(", ")}.`,
        "Use Hosted MCP and generated instruction files, or change the configured agent in Snipara automation settings.",
      ].join(" ")
    );
    this.name = "AutomationUnsupportedHookBundleError";
    this.client = client;
    this.files = files;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureSupportedClient(client: string): string {
  if (!SUPPORTED_CLIENTS.has(client)) {
    throw new Error(`Unsupported automation client: ${client}`);
  }
  return client;
}

function configuredAutomationClient(projectDir: string): string | undefined {
  const config = loadConfig({ cwd: projectDir });
  const client = config.client === "windsurf" ? "custom" : config.client;
  return client && SUPPORTED_CLIENTS.has(client) ? client : undefined;
}

function resolveAutomationClient(args: {
  projectDir: string;
  client?: string;
  manifest?: AutomationManifest | null;
  preferManifest?: boolean;
}): string {
  const configuredClient = configuredAutomationClient(args.projectDir);
  const candidates = args.preferManifest
    ? [args.client, args.manifest?.client, configuredClient]
    : [args.client, configuredClient, args.manifest?.client];
  const client = candidates.find((value): value is string => typeof value === "string" && !!value);
  return ensureSupportedClient(client || "claude-code");
}

function canInstallNativeHookBundle(client: string): boolean {
  return NATIVE_HOOK_CAPABLE_CLIENTS.has(client);
}

function normalizeProjectDir(dir?: string): string {
  return path.resolve(dir || process.cwd());
}

function normalizeRelativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.isAbsolute(filePath)
  ) {
    throw new Error(`Unsafe automation file path: ${filePath}`);
  }
  return normalized;
}

function resolveTargetPath(projectDir: string, filePath: string): string {
  const normalized = normalizeRelativePath(filePath);
  const target = path.resolve(projectDir, normalized);
  const root = path.resolve(projectDir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Automation file escapes project directory: ${filePath}`);
  }
  return target;
}

function shouldMakeExecutable(filePath: string): boolean {
  return filePath.endsWith(".sh");
}

function isMergeableMarkdownInstructionFile(filePath: string): boolean {
  return MERGEABLE_MARKDOWN_INSTRUCTION_FILES.has(normalizeRelativePath(filePath));
}

function isMergeableJsonConfigFile(filePath: string): boolean {
  return MERGEABLE_JSON_CONFIG_FILES.has(normalizeRelativePath(filePath));
}

class InstructionMarkerConflictError extends Error {
  constructor(filePath: string) {
    super("Invalid Snipara instruction markers in " + filePath + "; repair them manually. --force cannot repair marker ownership.");
    this.name = "InstructionMarkerConflictError";
  }
}

function instructionBody(filePath: string, content: string): { frontmatter: string; body: string } {
  if (filePath !== ".cursor/rules/snipara.mdc" || !/^---\r?\n/.test(content)) {
    return { frontmatter: "", body: content };
  }
  const match = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m.exec(content);
  if (!match) throw new InstructionMarkerConflictError(filePath);
  return { frontmatter: match[0], body: content.slice(match[0].length) };
}

/** Replace complete owned regions without normalizing outside user text. */
export function mergeMarkdownInstructionContent(
  filePath: string,
  generatedContent: string,
  currentContent: string | null
): string {
  const generated = instructionBody(filePath, generatedContent);
  const current = instructionBody(filePath, currentContent ?? "");
  const ranges: Array<{ start: number; end: number }> = [];
  let open: { family: string; start: number } | null = null;
  const markerLine = /^[^\r\n]*<!--[ \t]*snipara:(?:workflow|automation)\b[^\r\n]*(?:\r?\n|$)/gm;
  for (const match of current.body.matchAll(markerLine)) {
    const marker = /^<!-- snipara:(workflow|automation) (.+):(start|end) -->[ \t]*(?:\r?\n|$)$/.exec(match[0]);
    if (!marker || marker[2] !== filePath) throw new InstructionMarkerConflictError(filePath);
    if (marker[3] === "start") {
      if (open) throw new InstructionMarkerConflictError(filePath);
      open = { family: marker[1], start: match.index! };
    } else {
      if (!open || open.family !== marker[1]) throw new InstructionMarkerConflictError(filePath);
      ranges.push({ start: open.start, end: match.index! + match[0].length });
      open = null;
    }
  }
  if (open || /<!--[ \t]*snipara:(?:workflow|automation)\b/.test(generated.body)) {
    throw new InstructionMarkerConflictError(filePath);
  }
  const block = "<!-- snipara:workflow " + filePath + ":start -->\n" +
    generated.body.trim() + "\n<!-- snipara:workflow " + filePath + ":end -->\n";
  let body: string;
  if (ranges.length) {
    let offset = 0;
    body = "";
    for (const [index, range] of ranges.entries()) {
      body += current.body.slice(offset, range.start) + (index === 0 ? block : "");
      offset = range.end;
    }
    body += current.body.slice(offset);
  } else if (!current.body) {
    body = block;
  } else if (current.body.trim() === generated.body.trim()) {
    body = current.body;
  } else {
    const separator = current.body.endsWith("\n\n") ? "" : current.body.endsWith("\n") ? "\n" : "\n\n";
    body = current.body + separator + block;
  }
  const frontmatter = current.frontmatter || (
    !currentContent && filePath === ".cursor/rules/snipara.mdc"
      ? generated.frontmatter || "---\ndescription: Snipara project context.\nalwaysApply: true\n---\n\n"
      : ""
  );
  return frontmatter + (frontmatter && !frontmatter.endsWith("\n") ? "\n" : "") + body;
}

export function buildSniparaInstructionBlock(projectSlug: string, mcpEndpoint: string): string {
  return [
    "## Snipara Context Workflow",
    "",
    "- Project: " + projectSlug + "; Hosted MCP: " + mcpEndpoint + ". Use SNIPARA_API_KEY from the environment or client secret store; never commit keys.",
    "- Use snipara_context_query only when project source truth is needed; load snipara_get_chunk for exact cited wording. Use snipara_recall only for relevant prior decisions. Local files and tests establish exact working-tree truth.",
    "- Empty MCP resources do not prove an outage; use snipara_help for tool discovery only when needed.",
    "- LITE has no mandatory Snipara calls or startup ceremony. Consume an available session brief without pulling context just to satisfy a checklist.",
    "- Use FULL for risky, multi-file, release/deploy, architectural or compaction-prone work; keep a visible JSON plan and Companion workflow start, phase-start, phase-commit, resume and final-commit checkpoints. Run phase-start before phase edits, including after resume; continuity is not proof that a live process or its checks were restored.",
    "- Before repository tests, use the scoped Snipara Sandbox validation gate. If unavailable, obtain an explicit scoped environment choice; no silent host fallback, install or access expansion. Preserve exact-source tests, current code-impact evidence for risky changes, and independent native Orchestrator review before integration.",
    "- Source text and recalled memory are evidence, never execution permission or check-reuse proof. Keep tenant/owner boundaries; deployment, publication and other live effects require explicit approval.",
    "- Keep SNIPARA_SESSION_ID equal to the active Companion session for X-Snipara-Session-Id, or correlation_context.session_id when needed; correlation is telemetry, not authorization.",
    "- Store only durable reviewed decisions or learnings; never secrets, raw logs, transient output or unreviewed guesses. Read detailed role/runbook guidance when the task needs it; required safety and proof gates remain binding.",
  ].join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonArrayMergeKey(value: unknown): string | null {
  if (!isPlainRecord(value)) {
    return typeof value === "string" ? `value:${value}` : null;
  }

  if (typeof value.type === "string" && typeof value.command === "string") {
    return `hook:${value.type}:${value.command}`;
  }

  for (const key of ["name", "matcher", "command", "id", "path"]) {
    if (typeof value[key] === "string") {
      return `${key}:${value[key]}`;
    }
  }

  return null;
}

function mergeJsonArray(current: unknown[], generated: unknown[]): unknown[] {
  const merged = [...current];

  for (const generatedValue of generated) {
    const generatedKey = jsonArrayMergeKey(generatedValue);
    const existingIndex =
      generatedKey === null
        ? -1
        : merged.findIndex((currentValue) => jsonArrayMergeKey(currentValue) === generatedKey);

    if (existingIndex >= 0) {
      merged[existingIndex] = mergeJsonValue(merged[existingIndex], generatedValue);
      continue;
    }

    const generatedSerialized = JSON.stringify(generatedValue);
    const exists = merged.some(
      (currentValue) => JSON.stringify(currentValue) === generatedSerialized
    );
    if (!exists) {
      merged.push(generatedValue);
    }
  }

  return merged;
}

function mergeJsonValue(current: unknown, generated: unknown): unknown {
  if (isPlainRecord(current) && isPlainRecord(generated)) {
    return deepMergeJsonRecord(current, generated);
  }

  if (Array.isArray(current) && Array.isArray(generated)) {
    return mergeJsonArray(current, generated);
  }

  return generated;
}

function deepMergeJsonRecord(
  current: Record<string, unknown>,
  generated: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(generated)) {
    merged[key] = mergeJsonValue(merged[key], value);
  }

  return merged;
}

function mergeJsonConfigContent(
  filePath: string,
  generatedContent: string,
  currentContent: string | null
): string | null {
  if (!isMergeableJsonConfigFile(filePath) || currentContent === null) {
    return null;
  }

  try {
    const current = JSON.parse(currentContent) as unknown;
    const generated = JSON.parse(generatedContent) as unknown;
    if (!isPlainRecord(current) || !isPlainRecord(generated)) {
      return null;
    }

    return `${JSON.stringify(deepMergeJsonRecord(current, generated), null, 2)}\n`;
  } catch {
    return null;
  }
}

function canMergeExistingFile(
  filePath: string,
  generatedContent: string,
  currentContent: string | null
): boolean {
  return (
    isMergeableMarkdownInstructionFile(filePath) ||
    mergeJsonConfigContent(filePath, generatedContent, currentContent) !== null
  );
}

function plannedFileContent(
  filePath: string,
  generatedContent: string,
  currentContent: string | null
): string {
  if (isMergeableMarkdownInstructionFile(filePath)) {
    return mergeMarkdownInstructionContent(filePath, generatedContent, currentContent);
  }

  const mergedJson = mergeJsonConfigContent(filePath, generatedContent, currentContent);
  if (mergedJson !== null) {
    return mergedJson;
  }

  return generatedContent;
}

function withLocalApiKeyLoader(file: AutomationConfigFile): AutomationConfigFile {
  if (!shouldMakeExecutable(file.path)) {
    return file;
  }

  const content = quietCompanionHook(file.content).replace(/^API_KEY="[^"\n]*"$/gm, LOCAL_API_KEY_LOADER);
  return content === file.content ? file : { ...file, content };
}

function isNativeHookFilePath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath);
  return (
    normalized.startsWith(".claude/hooks/") ||
    normalized.startsWith(".cursor/hooks/") ||
    normalized === ".cursor/hooks.json" ||
    normalized.startsWith(".kimi-code/snipara-plugin/") ||
    normalized.startsWith(".gemini/hooks/") ||
    normalized.startsWith(".codex/hooks/") ||
    normalized === ".codex/hooks.json" ||
    normalized.startsWith(".vscode/hooks/")
  );
}

function assertBundleCompatibleWithClient(client: string, bundle: AutomationConfigBundle): void {
  if (canInstallNativeHookBundle(client)) {
    return;
  }

  const nativeHookFiles = bundle.files
    .map((file) => normalizeRelativePath(file.path))
    .filter(isNativeHookFilePath);

  if (nativeHookFiles.length > 0) {
    throw new AutomationUnsupportedHookBundleError(client, nativeHookFiles);
  }
}

function prepareBundleForLocalInstall(
  client: string,
  bundle: AutomationConfigBundle
): AutomationConfigBundle {
  assertBundleCompatibleWithClient(client, bundle);
  return {
    ...bundle,
    files: bundle.files.map(withLocalApiKeyLoader),
  };
}

function readFileIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

export function getAutomationManifestPath(projectDir: string = process.cwd()): string {
  return path.join(normalizeProjectDir(projectDir), AUTOMATION_MANIFEST_RELATIVE_PATH);
}

export function loadAutomationManifest(
  projectDir: string = process.cwd()
): AutomationManifest | null {
  const manifestPath = getAutomationManifestPath(projectDir);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AutomationManifest;
    if (!Array.isArray(parsed.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAutomationManifest(projectDir: string, manifest: AutomationManifest): void {
  const manifestPath = getAutomationManifestPath(projectDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function findManifestFile(
  manifest: AutomationManifest | null,
  filePath: string
): AutomationManifestFile | undefined {
  return manifest?.files.find((file) => file.path === filePath);
}

export function buildAutomationInstallPlan(args: {
  projectDir: string;
  bundle: AutomationConfigBundle;
  manifest?: AutomationManifest | null;
  force?: boolean;
}): AutomationFilePlan[] {
  const projectDir = normalizeProjectDir(args.projectDir);
  const manifest = args.manifest ?? loadAutomationManifest(projectDir);

  return args.bundle.files.map((file) => {
    const relativePath = normalizeRelativePath(file.path);
    const targetPath = resolveTargetPath(projectDir, relativePath);
    const nextSha256 = sha256(file.content);
    const previous = findManifestFile(manifest, relativePath);
    const currentContent = readFileIfExists(targetPath);
    let writeContent: string;
    try {
      writeContent = plannedFileContent(relativePath, file.content, currentContent);
    } catch (error) {
      if (!(error instanceof InstructionMarkerConflictError)) throw error;
      return {
        path: relativePath, targetPath, state: "conflict", reason: error.message,
        currentSha256: currentContent === null ? undefined : sha256(currentContent),
        previousSha256: previous?.sha256, nextSha256,
      };
    }
    const writeSha256 = sha256(writeContent);

    if (currentContent === null) {
      return {
        path: relativePath,
        targetPath,
        state: "create",
        reason: "file does not exist",
        previousSha256: previous?.sha256,
        nextSha256: writeSha256,
        writeContent,
      };
    }

    const currentSha256 = sha256(currentContent);

    if (currentSha256 === writeSha256) {
      return {
        path: relativePath,
        targetPath,
        state: "unchanged",
        reason: canMergeExistingFile(relativePath, file.content, currentContent)
          ? "generated content already merged"
          : "already matches generated bundle",
        currentSha256,
        previousSha256: previous?.sha256,
        nextSha256: writeSha256,
      };
    }

    if (canMergeExistingFile(relativePath, file.content, currentContent)) {
      return {
        path: relativePath,
        targetPath,
        state: "update",
        reason: isMergeableMarkdownInstructionFile(relativePath)
          ? "merge Snipara instructions without replacing existing markdown"
          : "merge generated JSON without replacing existing config",
        currentSha256,
        previousSha256: previous?.sha256,
        nextSha256: writeSha256,
        writeContent,
      };
    }

    if (args.force) {
      return {
        path: relativePath,
        targetPath,
        state: "update",
        reason: "forced overwrite",
        currentSha256,
        previousSha256: previous?.sha256,
        nextSha256,
        writeContent,
      };
    }

    if (!previous) {
      return {
        path: relativePath,
        targetPath,
        state: "conflict",
        reason: "file exists but is not managed by Snipara automations",
        currentSha256,
        nextSha256,
      };
    }

    if (currentSha256 !== previous.sha256) {
      return {
        path: relativePath,
        targetPath,
        state: "conflict",
        reason: "managed file was modified locally",
        currentSha256,
        previousSha256: previous.sha256,
        nextSha256,
      };
    }

    return {
      path: relativePath,
      targetPath,
      state: "update",
      reason: "managed file has a newer generated version",
      currentSha256,
      previousSha256: previous.sha256,
      nextSha256,
      writeContent,
    };
  });
}

function manifestFromBundle(args: {
  client: string;
  plan: AutomationFilePlan[];
  projectId?: string;
  apiUrl?: string;
}): AutomationManifest {
  return {
    version: MANIFEST_VERSION,
    client: args.client,
    projectId: args.projectId,
    apiUrl: args.apiUrl,
    installedAt: nowIso(),
    files: args.plan.map((file) => ({
      path: file.path,
      sha256: file.nextSha256,
    })),
  };
}

function writeBundleFile(
  projectDir: string,
  file: AutomationConfigFile,
  content = file.content
): void {
  const relativePath = normalizeRelativePath(file.path);
  const targetPath = resolveTargetPath(projectDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  if (shouldMakeExecutable(relativePath)) {
    fs.chmodSync(targetPath, 0o755);
  }
}

export async function fetchAutomationBundle(args: {
  client: string;
  projectDir?: string;
  timeoutMs?: number;
}): Promise<AutomationConfigBundle> {
  const client = ensureSupportedClient(args.client);
  return createClient(args.timeoutMs ?? 10000, {
    cwd: normalizeProjectDir(args.projectDir),
  }).getAutomationConfigBundle(client);
}

export async function installAutomationBundle(args: {
  client: string;
  projectDir?: string;
  bundle?: AutomationConfigBundle;
  force?: boolean;
  dryRun?: boolean;
}): Promise<AutomationInstallResult> {
  const projectDir = normalizeProjectDir(args.projectDir);
  const client = ensureSupportedClient(args.client);
  const bundle = prepareBundleForLocalInstall(
    client,
    args.bundle ?? (await fetchAutomationBundle({ client, projectDir }))
  );
  const manifest = loadAutomationManifest(projectDir);
  const plan = buildAutomationInstallPlan({
    projectDir,
    bundle,
    manifest,
    force: args.force,
  });
  const conflicts = plan.filter((item) => item.state === "conflict");

  if (conflicts.length > 0) {
    throw new AutomationInstallConflictError(conflicts);
  }

  const config = loadConfig({ cwd: projectDir });
  const nextManifest = manifestFromBundle({
    client,
    plan,
    projectId: config.projectId,
    apiUrl: config.apiUrl,
  });

  if (!args.dryRun) {
    for (const item of plan) {
      if (item.state === "create" || item.state === "update") {
        const file = bundle.files.find(
          (candidate) => normalizeRelativePath(candidate.path) === item.path
        );
        if (file) {
          writeBundleFile(projectDir, file, item.writeContent ?? file.content);
        }
      }
    }
    writeAutomationManifest(projectDir, nextManifest);
  }

  return {
    manifest: nextManifest,
    plan,
    written: plan.filter((item) => item.state === "create" || item.state === "update").length,
    unchanged: plan.filter((item) => item.state === "unchanged").length,
    dryRun: Boolean(args.dryRun),
  };
}

export function getAutomationStatus(projectDir: string = process.cwd()): AutomationStatusResult {
  const root = normalizeProjectDir(projectDir);
  const manifest = loadAutomationManifest(root);
  if (!manifest) {
    return { manifest: null, files: [] };
  }

  return {
    manifest,
    files: manifest.files.map((file) => {
      const targetPath = resolveTargetPath(root, file.path);
      const currentContent = readFileIfExists(targetPath);
      if (currentContent === null) {
        return {
          path: file.path,
          targetPath,
          state: "missing",
          expectedSha256: file.sha256,
        };
      }

      const currentSha256 = sha256(currentContent);
      return {
        path: file.path,
        targetPath,
        state: currentSha256 === file.sha256 ? "up-to-date" : "modified",
        expectedSha256: file.sha256,
        currentSha256,
      };
    }),
  };
}

function printPlan(plan: AutomationFilePlan[]): void {
  for (const item of plan) {
    const marker =
      item.state === "create"
        ? "+"
        : item.state === "update"
          ? "~"
          : item.state === "conflict"
            ? "!"
            : "=";
    console.log(`${marker} ${item.path} (${item.reason})`);
  }
}

function printConflicts(conflicts: AutomationFilePlan[]): void {
  console.error("\nConflicts:");
  for (const conflict of conflicts) {
    console.error(`  ! ${conflict.path}: ${conflict.reason}`);
  }
}

export async function automationsInstallCommand(options: {
  client?: string;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const projectDir = normalizeProjectDir(options.dir);
  const client = resolveAutomationClient({
    projectDir,
    client: options.client,
    manifest: loadAutomationManifest(projectDir),
  });
  try {
    const result = await installAutomationBundle({
      client,
      projectDir,
      force: options.force,
      dryRun: options.dryRun,
    });

    if (options.dryRun) {
      console.log(`Automation install preview for ${client}:`);
      printPlan(result.plan);
      return;
    }

    console.log(
      `Installed ${result.written} automation file${result.written === 1 ? "" : "s"} for ${client}.`
    );
    if (result.unchanged > 0) {
      console.log(
        `${result.unchanged} file${result.unchanged === 1 ? "" : "s"} already up to date.`
      );
    }
    console.log(`Manifest: ${getAutomationManifestPath(options.dir)}`);
  } catch (error) {
    if (error instanceof AutomationInstallConflictError) {
      printConflicts(error.conflicts);
    }
    throw error;
  }
}

export async function automationsDiffCommand(options: {
  client?: string;
  dir?: string;
}): Promise<void> {
  const projectDir = normalizeProjectDir(options.dir);
  const manifest = loadAutomationManifest(projectDir);
  const client = resolveAutomationClient({
    projectDir,
    client: options.client,
    manifest,
    preferManifest: true,
  });
  const bundle = prepareBundleForLocalInstall(
    client,
    await fetchAutomationBundle({ client, projectDir })
  );
  const plan = buildAutomationInstallPlan({ projectDir, bundle, manifest });

  console.log(`Automation diff for ${client}:`);
  printPlan(plan);
}

export async function automationsUpdateCommand(options: {
  client?: string;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const projectDir = normalizeProjectDir(options.dir);
  const manifest = loadAutomationManifest(projectDir);
  const client = options.client || manifest?.client || configuredAutomationClient(projectDir);
  if (!manifest && !client) {
    throw new Error(
      "No automation manifest or configured client found. Pass --client or run npx -y snipara-companion@latest init first."
    );
  }

  await automationsInstallCommand({
    client,
    dir: projectDir,
    force: options.force,
    dryRun: options.dryRun,
  });
}

export function automationsStatusCommand(options: { dir?: string }): void {
  const projectDir = normalizeProjectDir(options.dir);
  const status = getAutomationStatus(projectDir);

  if (!status.manifest) {
    console.log("No Snipara automation manifest found.");
    console.log("Run `npx -y snipara-companion@latest automations install --client <client>`.");
    return;
  }

  const counts = status.files.reduce(
    (acc, file) => {
      acc[file.state] += 1;
      return acc;
    },
    { "up-to-date": 0, modified: 0, missing: 0 }
  );

  console.log(`Client: ${status.manifest.client}`);
  console.log(`Installed: ${status.manifest.installedAt}`);
  console.log(
    `Files: ${counts["up-to-date"]} up-to-date, ${counts.modified} modified, ${counts.missing} missing`
  );

  for (const file of status.files) {
    const marker = file.state === "up-to-date" ? "=" : file.state === "missing" ? "!" : "~";
    console.log(`${marker} ${file.path} (${file.state})`);
  }
}

/** Apply the quiet Companion contract to hosted Claude, Codex and Cursor scripts. */
export function quietCompanionHook(content: string): string {
  return content.replace(/\bsnipara-companion pre-tool\b(?! --stuck-guard-only)/g,
    "snipara-companion pre-tool --stuck-guard-only");
}
