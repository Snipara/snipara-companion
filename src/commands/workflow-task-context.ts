/** Materialize task-local context through existing Hosted MCP and local context packs. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { packContext, retrieveContextPack } from "./context-pack";

type Data = Record<string, unknown>;
export type RetrievalAction = "decompose" | "context_query" | "multi_query";
export interface WorkflowTaskContextRequest {
  chunkIds?: string[];
  queries?: string[];
  maxTokens?: number;
  maxChunks?: number;
  timeoutMs?: number;
  operation?: { action: RetrievalAction; params: Data; bindings: Record<string, string> };
}
export interface TaskContextIdentity {
  workflowId: string;
  phaseId: string;
  taskId: string;
  attempt: number;
}
export interface WorkflowTaskContextReceipt extends TaskContextIdentity {
  version: "snipara.workflow.task-context-receipt.v1";
  requestHash: string;
  packId: string;
  sha256: string;
  loadedAt: string;
  chunkIds: string[];
  authority: "local_client_observed";
  semanticUseVerified: false;
}
export interface LoadedTaskContext extends TaskContextIdentity {
  version: "snipara.workflow.loaded-context.v1";
  requestHash: string;
  output: Data;
  chunks: Array<{ id: string; content: string; sha256: string; source: Data }>;
  inputs: Array<{ taskId: string; attempt: number; packId: string; sha256: string }>;
  calls: Array<{ tool: string; argumentsSha256: string; responseSha256: string; durationMs: number }>;
}
const record = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export function taskContextRequestHash(request: WorkflowTaskContextRequest): string {
  return digest(JSON.stringify(canonical(request)));
}
function strings(value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(
    (item) => typeof item !== "string" || !item.trim() || item.length > 4096
  )) throw new Error(`Invalid task context ${label}`);
  return [...new Set(value as string[])];
}
function bound(value: unknown, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling)
    throw new Error("Invalid task context budget");
  return Number(value);
}
export function normalizeTaskContextRequest(value: unknown): WorkflowTaskContextRequest | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some((key) =>
    !["chunkIds", "queries", "maxTokens", "maxChunks", "timeoutMs", "operation"].includes(key)))
    throw new Error("Invalid task context request");
  const request: WorkflowTaskContextRequest = {
    maxTokens: bound(value.maxTokens, 4000, 16000),
    maxChunks: bound(value.maxChunks, 8, 16),
    timeoutMs: bound(value.timeoutMs, 30000, 120000),
  };
  if (value.chunkIds !== undefined) request.chunkIds = strings(value.chunkIds, "chunk IDs", 16);
  if (value.queries !== undefined) request.queries = strings(value.queries, "queries", 8);
  if (value.operation !== undefined) {
    const op = value.operation;
    if (!record(op) || !["decompose", "context_query", "multi_query"].includes(String(op.action)) ||
      !record(op.params) || !record(op.bindings) || Object.keys(op).some((key) =>
        !["action", "params", "bindings"].includes(key)) ||
      Object.entries(op.bindings).some(([key, id]) => !/^step[1-9]\d*$/.test(key) ||
        typeof id !== "string" || !id || id.length > 200) ||
      Buffer.byteLength(JSON.stringify(op), "utf8") > 32768)
      throw new Error("Invalid task retrieval operation");
    request.operation = { action: op.action as RetrievalAction, params: op.params,
      bindings: op.bindings as Record<string, string> };
    const allowed = op.action === "decompose"
      ? ["query", "question", "max_depth", "strategy", "hints"]
      : op.action === "context_query"
        ? ["query", "max_tokens", "search_mode", "auto_decompose", "include_all_tiers",
          "include_answer_pack", "include_metadata", "include_shared_context", "return_references", "retrieval_queries"]
        : ["queries", "max_tokens", "search_mode"];
    if (Object.keys(op.params).some((key) => !allowed.includes(key)))
      throw new Error("Unsupported task retrieval parameter; refusing to discard plan data");
  }
  if (!request.operation && !request.queries?.length && !request.chunkIds?.length)
    throw new Error("Task context requires a query or chunk reference");
  return request;
}

/** Only the small planner data-reference grammar is supported; never evaluate code. */
function resolve(value: unknown, bindings: Record<string, string>, outputFor: (id: string) => Data): unknown {
  if (typeof value === "string" && value.startsWith("$step")) {
    const match = /^\$(step[1-9]\d*)\.sub_queries(?:\[(\d+)(?:(:)(\d*))?\])?(\.query)?$/.exec(value);
    if (!match || !bindings[match[1]]) throw new Error("Unresolved task context binding");
    const output = outputFor(bindings[match[1]]);
    const queries = output.sub_queries;
    if (!Array.isArray(queries)) throw new Error("Task context binding has no sub_queries output");
    let result: unknown = queries;
    if (match[2] !== undefined) {
      const start = Number(match[2]);
      if (!match[3] && start >= queries.length) throw new Error("Task context binding index is out of range");
      result = match[3] ? queries.slice(start, match[4] ? Number(match[4]) : undefined) : queries[start];
    }
    if (match[5]) {
      if (!record(result) || typeof result.query !== "string")
        throw new Error("Task context binding does not select a query");
      result = result.query;
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, bindings, outputFor));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, resolve(item, bindings, outputFor)]
  ));
  return value;
}

export function readTaskContext(
  receipt: WorkflowTaskContextReceipt, identity: TaskContextIdentity,
  request: WorkflowTaskContextRequest, cwd = process.cwd()
): LoadedTaskContext {
  const pack = retrieveContextPack(receipt.packId, cwd);
  if (receipt.version !== "snipara.workflow.task-context-receipt.v1" ||
    receipt.sha256 !== pack.record.sha256 || digest(pack.content) !== receipt.sha256 ||
    receipt.requestHash !== taskContextRequestHash(request) ||
    Object.entries(identity).some(([key, value]) => receipt[key as keyof TaskContextIdentity] !== value))
    throw new Error("Task context receipt no longer matches its task or content");
  if (Buffer.byteLength(pack.content, "utf8") > Math.min(262144, (request.maxTokens ?? 4000) * 8))
    throw new Error("Saved task context exceeds its complete payload budget");
  const data: unknown = JSON.parse(pack.content);
  if (!record(data) || data.version !== "snipara.workflow.loaded-context.v1" ||
    data.requestHash !== receipt.requestHash || !record(data.output) || !Array.isArray(data.chunks) ||
    Object.entries(identity).some(([key, value]) => data[key] !== value))
    throw new Error("Invalid saved task context");
  return data as unknown as LoadedTaskContext;
}

export async function materializeTaskContext(input: {
  identity: TaskContextIdentity;
  request: WorkflowTaskContextRequest;
  callTool: (name: string, args: Data, timeoutMs: number) => Promise<unknown>;
  outputFor: (taskId: string) => { output: Data; receipt: WorkflowTaskContextReceipt };
  cwd?: string;
}): Promise<{ receipt: WorkflowTaskContextReceipt; context: LoadedTaskContext }> {
  const request = normalizeTaskContextRequest(input.request)!;
  const maxTokens = request.maxTokens!;
  const maxChunks = request.maxChunks!;
  const deadline = performance.now() + request.timeoutMs!;
  const calls: LoadedTaskContext["calls"] = [];
  const chunkIds = new Set(request.chunkIds ?? []);
  const evidenceIds = new Map<string, string>();
  const chunks: LoadedTaskContext["chunks"] = [];
  const inputs = new Map<string, LoadedTaskContext["inputs"][number]>();
  let output: Data = {};
  let usedTokens = 0;
  const call = async (name: string, args: Data): Promise<Data> => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error("Task context preparation deadline exceeded");
    const started = performance.now();
    const data = await input.callTool(name, args, remaining);
    if (!record(data) || data.error || Buffer.byteLength(JSON.stringify(data), "utf8") > 262144)
      throw new Error(`Task context ${name} failed or returned invalid data`);
    calls.push({ tool: name, argumentsSha256: digest(JSON.stringify(canonical(args))),
      responseSha256: digest(JSON.stringify(data)), durationMs: Math.round(performance.now() - started) });
    return data;
  };
  const query = async (text: unknown, budget: number, options: Data = {}): Promise<Data> => {
    const searchMode = options.search_mode ?? "hybrid";
    if (typeof text !== "string" || !text.trim() || text.length > 4096 ||
      !["hybrid", "keyword", "semantic"].includes(String(searchMode)))
      throw new Error("Invalid resolved task context query");
    for (const key of ["auto_decompose", "include_all_tiers", "include_answer_pack", "include_metadata", "include_shared_context"]) {
      if (options[key] !== undefined && typeof options[key] !== "boolean")
        throw new Error(`Invalid task retrieval option '${key}'`);
    }
    if (options.return_references !== undefined && options.return_references !== true)
      throw new Error("Task materialization requires reference-based retrieval");
    const result = await call("snipara_context_query", {
      ...options,
      query: text, max_tokens: budget, search_mode: searchMode,
      return_references: true, include_answer_pack: options.include_answer_pack ?? true,
      auto_decompose: options.auto_decompose ?? false,
    });
    if (!Array.isArray(result.section_refs) || result.section_refs.length === 0)
      throw new Error("Task context query returned no cited chunks");
    for (const ref of result.section_refs) {
      if (!record(ref) || typeof ref.chunk_id !== "string" || !ref.chunk_id)
        throw new Error("Task context query returned an invalid chunk reference");
      chunkIds.add(ref.chunk_id);
      if (typeof ref.evidence_id === "string") {
        if (evidenceIds.has(ref.chunk_id) && evidenceIds.get(ref.chunk_id) !== ref.evidence_id)
          throw new Error("Conflicting evidence identity for a task chunk");
        evidenceIds.set(ref.chunk_id, ref.evidence_id);
      }
    }
    return result;
  };
  if (request.operation) {
    const op = request.operation;
    const params = resolve(op.params, op.bindings, (id) => {
      const dependency = input.outputFor(id);
      const { taskId, attempt, packId, sha256 } = dependency.receipt;
      inputs.set(id, { taskId, attempt, packId, sha256 });
      return dependency.output;
    }) as Data;
    if (op.action === "decompose") {
      const text = params.query ?? params.question;
      if (typeof text !== "string" || !text.trim() || text.length > 4096)
        throw new Error("Invalid task decomposition query");
      output = await call("snipara_decompose", { ...params, query: text,
        ...(params.max_depth !== undefined ? { max_depth: bound(params.max_depth, 2, 5) } : {}) });
      if (!Array.isArray(output.sub_queries) || !output.sub_queries.length || output.sub_queries.length > 8 ||
        output.sub_queries.some((item) => !record(item) || typeof item.query !== "string" || !item.query.trim()))
        throw new Error("Task decomposition returned invalid subqueries");
    } else if (op.action === "context_query") {
      output = await query(params.query, Math.min(maxTokens, bound(params.max_tokens, maxTokens, 100000)), params);
    } else {
      if (!Array.isArray(params.queries) || params.queries.length > 8)
        throw new Error("Invalid resolved task multi-query");
      const total = Math.min(maxTokens, bound(params.max_tokens, maxTokens, 100000));
      const queries = params.queries.map((item) => typeof item === "string" ? { query: item } : item);
      if (queries.some((item) => !record(item))) throw new Error("Invalid task multi-query item");
      const items = queries as Data[];
      const explicit = items.reduce((sum, item) => sum + (item.max_tokens === undefined ? 0 : bound(item.max_tokens, 1, total)), 0);
      const unset = items.filter((item) => item.max_tokens === undefined).length;
      if (explicit > total || (unset && total - explicit < unset)) throw new Error("Task multi-query exceeds its budget");
      const results = [];
      for (const item of items) results.push(await query(item.query,
        item.max_tokens === undefined ? Math.floor((total - explicit) / unset) : Number(item.max_tokens), { search_mode: params.search_mode ?? "hybrid" }));
      output = { results, ...(items.length === 0 ? { emptyTail: true, queries_executed: 0 } : {}) };
    }
  }
  if (request.queries?.length) {
    const results = [];
    for (const text of request.queries) {
      results.push(await query(text, Math.max(1, Math.floor(maxTokens / request.queries.length))));
    }
    // Keep every query's caveats/answer pack and any decomposition output used by
    // downstream symbolic bindings. Chunks are deduplicated independently.
    output = request.operation ? { ...output, context_queries: results } : { results };
  }
  if (chunkIds.size > maxChunks) throw new Error("Task context exceeds its chunk budget");
  for (const id of chunkIds) {
    const chunk = await call("snipara_get_chunk", { chunk_id: id });
    if (chunk.found !== true || chunk.chunk_id !== id || chunk.truncated === true ||
      typeof chunk.content !== "string" || !chunk.content.trim())
      throw new Error(`Required task chunk is missing, truncated or mismatched: ${id}`);
    if (evidenceIds.has(id) && chunk.evidence_id !== evidenceIds.get(id))
      throw new Error(`Task chunk evidence changed during retrieval: ${id}`);
    const cost = typeof chunk.token_count === "number" && Number.isFinite(chunk.token_count) && chunk.token_count > 0
      ? chunk.token_count : Buffer.byteLength(chunk.content, "utf8");
    usedTokens += cost;
    if (usedTokens > maxTokens || Buffer.byteLength(chunk.content, "utf8") > maxTokens * 8)
      throw new Error("Required task chunks exceed the context budget");
    chunks.push({ id, content: chunk.content, sha256: digest(chunk.content), source: {
      file: chunk.file, lines: chunk.lines, title: chunk.title,
      evidenceId: chunk.evidence_id,
    } });
  }
  const requestHash = taskContextRequestHash(request);
  const context: LoadedTaskContext = { version: "snipara.workflow.loaded-context.v1",
    ...input.identity, requestHash, output, chunks, inputs: [...inputs.values()], calls };
  if (performance.now() > deadline) throw new Error("Task context preparation deadline exceeded");
  const pack = packContext({ cwd: input.cwd, content: JSON.stringify(context), kind: "tool_output",
    source: "hosted-snipara-task-context", label: `${input.identity.workflowId}/${input.identity.taskId}`,
    maxBytes: Math.min(262144, maxTokens * 8) });
  const receipt: WorkflowTaskContextReceipt = { version: "snipara.workflow.task-context-receipt.v1",
    ...input.identity, requestHash, packId: pack.record.id, sha256: pack.record.sha256,
    loadedAt: new Date().toISOString(), chunkIds: chunks.map((chunk) => chunk.id),
    authority: "local_client_observed", semanticUseVerified: false };
  return { receipt, context };
}
