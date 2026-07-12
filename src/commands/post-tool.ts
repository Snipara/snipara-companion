/**
 * `post-tool` command — PostToolUse hook file/result tracking.
 *
 * Invoked by editor / Claude Code hooks after a tool runs. It extracts the
 * accessed files from the (possibly nested) tool input, classifies the result
 * (success / failure / timeout), emits a canonical automation event, and runs
 * the memory guard. Fail-soft: tracking errors never break the host tool.
 */
import { execFileSync } from "node:child_process";
import { createClient } from "../api/client";
import { isConfigured } from "../config/store";
import {
  attachLocalContextPackReceipts,
  buildLocalContextPackReceipt,
  emitCanonicalEvent,
  type LocalContextPackReceiptPayload,
} from "./events";
import { packContext } from "./context-pack";
import { runMemoryGuardCheck } from "./memory-guard";
import {
  buildToolResultPayload,
  classifyToolResult,
  extractCommandFromToolInput,
} from "./stuck-guard";

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  return [];
}

const FILE_FIELDS = ["file_path", "path", "file"];
const FILE_COLLECTION_FIELDS = ["paths", "files"];
const NESTED_INPUT_FIELDS = ["tool_input", "toolInput", "input", "arguments", "args", "params"];
const FULL_GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;
const COMMIT_LIKE_GIT_COMMAND =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:command\s+)?git\s+(?:(?:-C|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+|--[a-z][a-z0-9-]*\s+)*(commit|revert|cherry-pick)\b/i;
const AMBIGUOUS_SHELL_COMMAND = /(?:&&|\|\||[;&|<>`\r\n]|\$\(|^\s*\(|\)\s*$)/;
const NON_COMMIT_RESULT =
  /(?:\bnothing to commit\b|\bnothing added to commit\b|\bno changes added to commit\b|\bnothing committed\b|\bcherry-pick is now empty\b|\bfatal:|\berror:|\baborting\b)/i;
const COMMIT_SHA_RESULT_PREFIX = /\b[0-9a-f]{7,40}\b/gi;

type CommitLikeGitOperation = "commit" | "revert" | "cherry-pick";

function commitLikeGitOperation(command?: string): CommitLikeGitOperation | undefined {
  if (!command || AMBIGUOUS_SHELL_COMMAND.test(command)) {
    return undefined;
  }

  const match = command.match(COMMIT_LIKE_GIT_COMMAND)?.[1]?.toLowerCase();
  if (match === "commit" || match === "revert" || match === "cherry-pick") {
    return match;
  }
  return undefined;
}

function reflogMatchesOperation(subject: string, operation: CommitLikeGitOperation): boolean {
  const normalized = subject.trim().toLowerCase();
  if (operation === "commit") {
    return /^commit(?:\s+\((?:initial|amend|merge)\))?:/.test(normalized);
  }
  if (operation === "revert") {
    return /^revert:/.test(normalized);
  }
  return /^(?:cherry-pick|commit\s+\(cherry-pick\)):/.test(normalized);
}

function readGitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resultConfirmsCommitSha(result: string | undefined, commitSha: string): boolean {
  if (!result) {
    return false;
  }
  const candidates = result.match(COMMIT_SHA_RESULT_PREFIX) ?? [];
  return candidates.some((candidate) => commitSha.startsWith(candidate.toLowerCase()));
}

/**
 * Return the only extra metadata allowed for a successful commit-like result.
 *
 * The command is used only as a local classification hint and is never copied
 * into this metadata. Git is invoked without a shell, the reflog must confirm
 * the requested operation, the current result must contain HEAD's SHA prefix,
 * and the emitted SHA must be a full commit object id.
 */
export function buildCommitResultMetadata(options: {
  tool?: string;
  toolInput?: string;
  result?: string;
  exitCode?: number;
  status?: string;
  cwd?: string;
}): { commitSha?: string } {
  const command = extractCommandFromToolInput(options.toolInput);
  const operation = commitLikeGitOperation(command);
  if (!operation) {
    return {};
  }

  const classification = classifyToolResult({
    tool: options.tool,
    command,
    result: options.result,
    exitCode: options.exitCode,
    status: options.status,
  });
  if (classification !== "success" || NON_COMMIT_RESULT.test(options.result ?? "")) {
    return {};
  }

  const cwd = options.cwd ?? process.cwd();
  const reflogSubject = readGitValue(cwd, ["reflog", "-1", "--format=%gs", "HEAD"]);
  if (!reflogSubject || !reflogMatchesOperation(reflogSubject, operation)) {
    return {};
  }

  const commitSha = readGitValue(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])?.toLowerCase();
  if (
    !commitSha ||
    !FULL_GIT_COMMIT_SHA.test(commitSha) ||
    !resultConfirmsCommitSha(options.result, commitSha)
  ) {
    return {};
  }
  return { commitSha };
}

function collectFiles(value: unknown, files: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    files.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFiles(item, files, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const field of FILE_FIELDS) {
    files.push(...normalizeStringArray(record[field]));
  }

  for (const field of FILE_COLLECTION_FIELDS) {
    files.push(...normalizeStringArray(record[field]));
  }

  for (const field of NESTED_INPUT_FIELDS) {
    collectFiles(record[field], files, depth + 1);
  }
}

export function extractFilesFromToolInput(toolInput?: string): string[] {
  if (!toolInput) {
    return [];
  }

  const trimmed = toolInput.trim();
  if (trimmed === "") {
    return [];
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return [trimmed];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const files: string[] = [];
    collectFiles(parsed, files);

    return files.filter((file) => file.trim() !== "");
  } catch {
    return [trimmed];
  }
}

/**
 * Post-tool handler: Track file access in session
 */
export async function postToolCommand(options: {
  file?: string;
  files?: string[];
  toolInput?: string;
  result?: string;
  tool?: string;
  exitCode?: number;
  status?: string;
  packResult?: boolean;
}): Promise<void> {
  // Collect files to track
  const filesToTrack: string[] = [];

  if (options.file) {
    filesToTrack.push(options.file);
  }

  if (options.files) {
    filesToTrack.push(...options.files);
  }

  if (options.toolInput) {
    filesToTrack.push(...extractFilesFromToolInput(options.toolInput));
  }

  const uniqueFiles = Array.from(new Set(filesToTrack));
  const command = extractCommandFromToolInput(options.toolInput);
  const classification = classifyToolResult({
    tool: options.tool,
    command,
    result: options.result,
    exitCode: options.exitCode,
    status: options.status,
  });
  const contextPackReceipts: LocalContextPackReceiptPayload[] = [];
  let contextPackSkipped: Record<string, unknown> | undefined;
  const shouldPackResult =
    Boolean(options.packResult) || process.env.SNIPARA_CONTEXT_PACK_RESULTS === "1";
  if (shouldPackResult && typeof options.result === "string" && options.result.trim() !== "") {
    try {
      const packed = packContext({
        content: options.result,
        kind: "tool_output",
        label: `${options.tool || "tool"} result`,
        source: command ?? options.tool ?? "post-tool",
        tags: ["post-tool", classification],
      });
      contextPackReceipts.push(
        buildLocalContextPackReceipt(packed.record, {
          operation: "pack",
          privacyLevel: packed.record.sensitive ? "sensitive" : "standard",
        })
      );
    } catch (error) {
      contextPackSkipped = {
        reason: error instanceof Error ? error.message : String(error),
        source: "post-tool",
      };
    }
  }

  // Check if configured after optional local packing. Packing is local-only and
  // should still work for no-account fallback workflows.
  if (!isConfigured()) {
    process.exit(0);
  }

  try {
    if (uniqueFiles.length > 0) {
      try {
        const client = createClient(2000); // 2s timeout for tracking
        await client.trackFiles(uniqueFiles);
      } catch (error) {
        if (process.env.RLM_DEBUG) {
          console.error(
            `[Snipara] Track error: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }
    }

    const payload = attachLocalContextPackReceipts(
      {
        ...buildToolResultPayload({
          hook: "post-tool",
          tool: options.tool || "unknown",
          toolInput: options.toolInput,
          result: options.result,
          exitCode: options.exitCode,
          status: options.status,
          files: uniqueFiles,
        }),
        ...buildCommitResultMetadata({
          tool: options.tool,
          toolInput: options.toolInput,
          result: options.result,
          exitCode: options.exitCode,
          status: options.status,
        }),
        ...(contextPackSkipped ? { local_context_pack_skipped: contextPackSkipped } : {}),
      },
      contextPackReceipts
    );

    await emitCanonicalEvent({
      eventType: "tool_result",
      payload,
    });

    if (classification === "failure" || classification === "timeout") {
      const guard = await runMemoryGuardCheck({
        trigger: "failure",
        files: uniqueFiles,
        command,
        result: options.result,
        exitCode: options.exitCode,
        status: options.status || classification,
        strict: false,
        recentFailures: false,
      });
      if (guard.triggered) {
        const lines = [
          "Snipara Memory Guard: A tool or command failed. Before retrying, read this guidance.",
        ];
        for (const memory of guard.memories.slice(0, 3)) {
          lines.push(`Memory: ${memory.content.slice(0, 260)}`);
        }
        for (const section of guard.contextSections.slice(0, 3)) {
          lines.push(`Context: ${section.title} (${section.file}) - ${section.preview}`);
        }
        if (guard.memories.length === 0 && guard.contextSections.length === 0) {
          lines.push("No relevant memory or source context was found.");
        }
        console.log(lines.join("\n"));
      }
    }
  } catch (error) {
    // Silently fail - tracking is optional
    if (process.env.RLM_DEBUG) {
      console.error(
        `[Snipara] Post-tool event error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
}
