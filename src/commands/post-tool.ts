/**
 * `post-tool` command — PostToolUse hook file/result tracking.
 *
 * Invoked by editor / Claude Code hooks after a tool runs. It extracts the
 * accessed files from the (possibly nested) tool input, classifies the result
 * (success / failure / timeout), emits a canonical automation event, and runs
 * the memory guard. Fail-soft: tracking errors never break the host tool.
 */
import { createClient } from "../api/client";
import { isConfigured } from "../config/store";
import { emitCanonicalEvent } from "./events";
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
}): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    // Silently exit if not configured
    process.exit(0);
  }

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

    await emitCanonicalEvent({
      eventType: "tool_result",
      payload: buildToolResultPayload({
        hook: "post-tool",
        tool: options.tool || "unknown",
        toolInput: options.toolInput,
        result: options.result,
        exitCode: options.exitCode,
        status: options.status,
        files: uniqueFiles,
      }),
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
