/**
 * `pre-tool` command — PreToolUse hook context retrieval.
 *
 * Invoked by editor / Claude Code hooks before a tool runs. It extracts a query
 * from the raw tool input (see QUERY_FIELDS), fetches relevant project context
 * from hosted Snipara (served through a local query cache), and runs Stuck
 * Guard. Designed to be fast and fail-soft: when unconfigured or offline it
 * returns nothing rather than blocking the tool call.
 */
import { createClient, type ContextQueryResult } from "../api/client";
import { isConfigured, loadConfig } from "../config/store";
import { createLocalQueryCache } from "../cache/query-cache";
import { buildCanonicalEvent, emitCanonicalEvent } from "./events";
import { buildToolCallPayload, evaluateAndPrintStuckGuard } from "./stuck-guard";

interface ParsedToolInput {
  queryParts: string[];
  rawInput?: string;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  return [];
}

const QUERY_FIELDS = [
  "query",
  "pattern",
  "glob",
  "regex",
  "search",
  "qualified_name",
  "symbol_key",
  "from",
  "to",
  "from_symbol_key",
  "to_symbol_key",
  "file_path",
  "path",
  "file",
];

const TOOL_FIELDS = ["tool_name", "tool", "name"];
const COLLECTION_FIELDS = ["paths", "files"];
const NESTED_INPUT_FIELDS = ["tool_input", "toolInput", "input", "arguments", "args", "params"];

function collectQueryParts(value: unknown, queryParts: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    queryParts.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectQueryParts(item, queryParts, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const field of TOOL_FIELDS) {
    queryParts.push(...normalizeStringArray(record[field]));
  }

  for (const field of QUERY_FIELDS) {
    queryParts.push(...normalizeStringArray(record[field]));
  }

  for (const field of COLLECTION_FIELDS) {
    queryParts.push(...normalizeStringArray(record[field]));
  }

  for (const field of NESTED_INPUT_FIELDS) {
    collectQueryParts(record[field], queryParts, depth + 1);
  }
}

function parseToolInput(toolInput?: string): ParsedToolInput | null {
  if (!toolInput) {
    return null;
  }

  const trimmed = toolInput.trim();
  if (trimmed === "") {
    return null;
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { queryParts: [trimmed], rawInput: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const queryParts: string[] = [];
    collectQueryParts(parsed, queryParts);

    return { queryParts };
  } catch {
    return { queryParts: [trimmed], rawInput: trimmed };
  }
}

export function resolveQueryFromToolInput(toolInput?: string, tool?: string): string | null {
  const parsed = parseToolInput(toolInput);
  if (!parsed) {
    return null;
  }

  const parts = new Set<string>();

  if (tool && tool.trim() !== "") {
    parts.add(tool.trim());
  }

  for (const part of parsed.queryParts) {
    if (part.trim() !== "") {
      parts.add(part.trim());
    }
  }

  const query = Array.from(parts).join(" ").trim();
  return query === "" ? null : query;
}

/**
 * Format context result for Claude injection
 */
function formatAnswerPackSource(source?: {
  title?: string;
  file?: string;
  lines?: [number, number] | number[];
  quality_score?: number | null;
}): string {
  if (!source) {
    return "";
  }

  const details: string[] = [];
  if (source.file) {
    details.push(source.file);
  } else if (source.title) {
    details.push(source.title);
  }
  if (Array.isArray(source.lines) && source.lines.length >= 2) {
    details.push(`lines ${source.lines[0]}-${source.lines[1]}`);
  }
  if (typeof source.quality_score === "number") {
    details.push(`quality ${source.quality_score.toFixed(2)}`);
  }

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function appendAnswerPack(parts: string[], result: ContextQueryResult): void {
  const pack = result.answer_pack;
  if (!pack) {
    return;
  }

  parts.push("<!-- Snipara Answer Pack: source-grounded response plan -->");
  parts.push("## Answer Pack");
  parts.push("");

  if (pack.source_facts && pack.source_facts.length > 0) {
    parts.push("### Source facts");
    for (const fact of pack.source_facts.slice(0, 8)) {
      parts.push(`- ${fact.claim}${formatAnswerPackSource(fact.source)}`);
    }
    parts.push("");
  }

  if (pack.caveats && pack.caveats.length > 0) {
    parts.push("### Caveats");
    for (const caveat of pack.caveats.slice(0, 5)) {
      parts.push(`- ${caveat.claim}${formatAnswerPackSource(caveat.source)}`);
    }
    parts.push("");
  }

  if (pack.what_not_to_claim && pack.what_not_to_claim.length > 0) {
    parts.push("### Do not claim without evidence");
    for (const item of pack.what_not_to_claim.slice(0, 5)) {
      parts.push(`- ${item}`);
    }
    parts.push("");
  }

  if (pack.verification_checklist && pack.verification_checklist.length > 0) {
    parts.push("### Verification checklist");
    for (const item of pack.verification_checklist.slice(0, 5)) {
      parts.push(`- ${item}`);
    }
    parts.push("");
  }
}

function formatContextOutput(result: ContextQueryResult): string {
  const parts: string[] = [];
  const toolRecommendation =
    result.recommended_tool && result.recommended_tool_arguments
      ? JSON.stringify(result.recommended_tool_arguments)
      : null;

  appendAnswerPack(parts, result);

  if (result.sections.length > 0) {
    if (parts.length > 0) {
      parts.push("---");
      parts.push("");
    }
    parts.push("<!-- Snipara Context: Relevant documentation sections -->");
    parts.push("");

    for (const section of result.sections) {
      parts.push(`## ${section.title}`);
      if (section.file) {
        const quality =
          typeof section.quality_score === "number"
            ? ` | quality ${section.quality_score.toFixed(2)}`
            : "";
        const flags =
          section.quality_flags && section.quality_flags.length > 0
            ? ` | flags ${section.quality_flags.join(",")}`
            : "";
        parts.push(
          `*Source: ${section.file} (lines ${section.lines[0]}-${section.lines[1]})${quality}${flags}*`
        );
      }
      parts.push("");
      parts.push(section.content);
      parts.push("");
    }
  }

  if (toolRecommendation) {
    if (parts.length > 0) {
      parts.push("---");
    }
    parts.push("<!-- Snipara Routing: structural code query detected -->");
    parts.push(`Suggested MCP tool: ${result.recommended_tool} ${toolRecommendation}`);
    parts.push("");
  }

  if (result.suggestions && result.suggestions.length > 0) {
    parts.push("---");
    parts.push("**Related topics:** " + result.suggestions.join(", "));
    parts.push("");
  }

  parts.push(`<!-- Snipara: ${result.total_tokens} tokens used -->`);

  return parts.length > 1 ? parts.join("\n") : "";
}

/**
 * Pre-tool handler: Query Snipara for relevant context
 */
export async function preToolCommand(options: {
  query?: string;
  toolInput?: string;
  tool?: string;
  maxTokens?: number;
  noCache?: boolean;
  stuckGuardOnly?: boolean;
}): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    // Silently exit if not configured (don't break Claude workflow)
    process.exit(0);
  }

  const {
    maxTokens = 1200,
    noCache = false,
    stuckGuardOnly = process.env.SNIPARA_STUCK_GUARD_ONLY === "1",
  } = options;
  const query = options.query || resolveQueryFromToolInput(options.toolInput, options.tool);
  const config = loadConfig();
  const cache = createLocalQueryCache({
    cwd: process.cwd(),
    projectId: config.projectId,
    sessionId: config.sessionId,
  });

  if (!query) {
    process.exit(0);
  }

  const stuckGuardEvent = buildCanonicalEvent({
    eventType: "tool_call",
    payload: buildToolCallPayload({
      hook: "pre-tool",
      tool: options.tool || "unknown",
      toolInput: options.toolInput,
      query,
    }),
  });

  try {
    await evaluateAndPrintStuckGuard({
      event: stuckGuardEvent,
      sessionId: stuckGuardEvent.session_id,
      includeRecent: true,
      limit: 50,
      timeoutMs: 3000,
    });
  } catch (error) {
    if (process.env.RLM_DEBUG) {
      console.error(
        `[Snipara] Stuck Guard error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  if (stuckGuardOnly) {
    process.exit(0);
  }

  // Check cache first
  if (!noCache) {
    const cached = cache.lookup({ query, maxTokens });
    if (cached) {
      await emitCanonicalEvent({
        eventType: "tool_call",
        payload: {
          hook: "pre-tool",
          tool: options.tool || "unknown",
          query,
          cache_hit: true,
          cache_strategy: cached.strategy,
          cache_source_query: cached.sourceQuery,
          ...(typeof cached.similarity === "number"
            ? { cache_similarity: Number(cached.similarity.toFixed(3)) }
            : {}),
        },
      });

      const output = formatContextOutput(cached.result);
      if (output) {
        console.log(output);
      }
      process.exit(0);
    }
  }

  try {
    const client = createClient(5000); // 5s timeout for pre-tool
    const result = await client.queryContext(query, maxTokens);
    await emitCanonicalEvent({
      eventType: "tool_call",
      payload: {
        hook: "pre-tool",
        tool: options.tool || "unknown",
        query,
        cache_hit: false,
        returned_sections: result.sections.length,
      },
    });

    // Save to cache
    if (!noCache) {
      cache.save({ query, maxTokens }, result);
    }

    // Output formatted context for Claude to inject
    const output = formatContextOutput(result);
    if (output) {
      console.log(output);
    }
  } catch (error) {
    // Silently fail - don't break Claude workflow
    // Optionally log to stderr for debugging
    if (process.env.RLM_DEBUG) {
      console.error(`[Snipara] Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
}

/**
 * Clear the query cache
 */
export function clearCache(): void {
  const cleared = createLocalQueryCache().clear();
  console.log(cleared > 0 ? `Cleared ${cleared} cached entries.` : "Cache is empty.");
}
