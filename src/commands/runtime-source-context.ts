/** Bind existing, exact task-context packs to the reviewed Controller handoff. */
import { createHash } from "node:crypto";
import { readBridgeSource, writeBridgeImmutable, parseBridgeJson } from "./controller-bridge-io";
import { retrieveContextPack } from "./context-pack";
import { readTaskContext, type WorkflowTaskContextReceipt, type WorkflowTaskContextRequest } from "./workflow-task-context";

type Data = Record<string, unknown>;
export const RUNTIME_SOURCE_CONTEXT_VERSION = "snipara.runtime.source-context.v1";
export const RUNTIME_CONTEXT_MAP_VERSION = "snipara.workflow.runtime-context-map.v1";
export interface RuntimeSourceContext {
  schemaVersion: typeof RUNTIME_SOURCE_CONTEXT_VERSION;
  receipt: WorkflowTaskContextReceipt;
  content: string;
  targetTaskId?: string;
  targetAttempt?: number;
}
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: string): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.toString("utf8") !== value) throw new Error("Runtime source context must be valid Unicode");
  return createHash("sha256").update(bytes).digest("hex");
};
const sha = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

export function validateRuntimeSourceContext(value: unknown, targetTaskId?: string): RuntimeSourceContext {
  if (!record(value) || value.schemaVersion !== RUNTIME_SOURCE_CONTEXT_VERSION ||
    Object.keys(value).some((key) => !["schemaVersion", "receipt", "content", "targetTaskId", "targetAttempt"].includes(key)) ||
    !record(value.receipt) || typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > 131072)
    throw new Error("Invalid complete runtime source-context envelope");
  const receipt = value.receipt;
  if (receipt.version !== "snipara.workflow.task-context-receipt.v1" ||
    Object.keys(receipt).some((key) => !["version","workflowId","phaseId","taskId","attempt","requestHash","packId","sha256","loadedAt","chunkIds","authority","semanticUseVerified"].includes(key)) ||
    ![receipt.workflowId, receipt.phaseId, receipt.taskId].every(id) ||
    !Number.isSafeInteger(receipt.attempt) || Number(receipt.attempt) < 1 || Number(receipt.attempt) > 100 ||
    typeof receipt.packId !== "string" || !receipt.packId || receipt.packId.length > 200 ||
    typeof receipt.loadedAt !== "string" || !receipt.loadedAt || receipt.loadedAt.length > 100 ||
    !sha(receipt.requestHash) || !sha(receipt.sha256) || hash(value.content) !== receipt.sha256 ||
    !Array.isArray(receipt.chunkIds) || receipt.chunkIds.length > 16 ||
    receipt.chunkIds.some((item) => typeof item !== "string" || !item || item.length > 1000) ||
    new Set(receipt.chunkIds).size !== receipt.chunkIds.length ||
    receipt.authority !== "local_client_observed" || receipt.semanticUseVerified !== false)
    throw new Error("Runtime source-context receipt is invalid or changed");
  if (value.targetTaskId !== undefined && !id(value.targetTaskId)) throw new Error("Invalid runtime context target task");
  if (targetTaskId !== undefined && (value.targetTaskId ?? receipt.taskId) !== targetTaskId)
    throw new Error("Runtime source-context target differs from the consumer task");
  if (value.targetAttempt !== undefined && (!Number.isSafeInteger(value.targetAttempt) || Number(value.targetAttempt) < 1 || Number(value.targetAttempt) > 100))
    throw new Error("Invalid runtime context target attempt");
  const body: unknown = parseBridgeJson(value.content);
  if (!record(body) || body.version !== "snipara.workflow.loaded-context.v1" ||
    ["workflowId", "phaseId", "taskId", "attempt", "requestHash"].some((key) => body[key] !== receipt[key]) ||
    !record(body.output) || !Array.isArray(body.inputs) || !Array.isArray(body.calls) ||
    !Array.isArray(body.chunks) || body.chunks.length > 16)
    throw new Error("Runtime source-context body differs from its receipt");
  const chunkIds = body.chunks.map((chunk) => {
    if (!record(chunk) || typeof chunk.id !== "string" || !chunk.id || typeof chunk.content !== "string" || !record(chunk.source) ||
      !sha(chunk.sha256) || hash(chunk.content) !== chunk.sha256)
      throw new Error("Runtime source chunk bytes do not match their hash");
    return chunk.id;
  });
  if (new Set(chunkIds).size !== chunkIds.length || chunkIds.length !== receipt.chunkIds.length ||
    chunkIds.some((chunkId,index) => (receipt.chunkIds as unknown[])[index] !== chunkId))
    throw new Error("Runtime source-context chunk membership differs from its receipt");
  return value as unknown as RuntimeSourceContext;
}

export function readRuntimeContextMap(cwd: string, file: string): {
  source: { path: string; sha256: string };
  contexts: Map<string, RuntimeSourceContext>;
} {
  const saved = readBridgeSource(cwd, file), value = saved.value;
  if (!record(value) || value.schemaVersion !== RUNTIME_CONTEXT_MAP_VERSION || !id(value.workflowId) ||
    !Array.isArray(value.bindings) || !value.bindings.length || value.bindings.length > 256)
    throw new Error("Invalid runtime task-context map");
  const contexts = new Map<string, RuntimeSourceContext>();
  for (const item of value.bindings) {
    if (!record(item) || !id(item.workPackageId) || contexts.has(item.workPackageId))
      throw new Error("Invalid or duplicate runtime work-package binding");
    const context = validateRuntimeSourceContext({schemaVersion:RUNTIME_SOURCE_CONTEXT_VERSION,
      receipt:item.receipt, content:item.content});
    if (context.receipt.workflowId !== value.workflowId) throw new Error("Runtime context map crosses workflows");
    contexts.set(item.workPackageId, context);
  }
  return {source:{path:saved.relative,sha256:saved.hash},contexts};
}

export function exportWorkflowRuntimeContexts(options: { cwd: string; mappingFile: string; output: string }): unknown {
  const current = readBridgeSource(options.cwd, ".snipara/workflow/current.json").value;
  const mapping = readBridgeSource(options.cwd, options.mappingFile).value;
  if (!record(current) || !id(current.workflowId) || !Array.isArray(current.phases) ||
    !Array.isArray(mapping) || !mapping.length || mapping.length > 256)
    throw new Error("Expected a workflow and explicit work-package/phase/task mapping");
  const used = new Set<string>();
  const phases = current.phases;
  const bindings = mapping.map((item: unknown) => {
    if (!record(item) || ![item.workPackageId, item.phaseId, item.taskId].every(id) || used.has(String(item.workPackageId)))
      throw new Error("Invalid or duplicate workflow runtime-context mapping");
    used.add(String(item.workPackageId));
    const phase = phases.find((raw: unknown) => record(raw) && raw.id === item.phaseId) as Data | undefined;
    const task = phase && Array.isArray(phase.tasks) ? phase.tasks.find((raw: unknown) => record(raw) && raw.id === item.taskId) as Data | undefined : undefined;
    if (!task || !record(task.contextReceipt) || !record(task.contextRequest))
      throw new Error("Mapped task has no observed task-context receipt");
    const receipt = task.contextReceipt as unknown as WorkflowTaskContextReceipt;
    readTaskContext(receipt, {workflowId:String(current.workflowId),phaseId:String(item.phaseId),
      taskId:String(item.taskId),attempt:Number(task.attempt)}, task.contextRequest as WorkflowTaskContextRequest, options.cwd);
    const pack = retrieveContextPack(receipt.packId, options.cwd);
    validateRuntimeSourceContext({schemaVersion:RUNTIME_SOURCE_CONTEXT_VERSION,receipt,content:pack.content});
    return {workPackageId:item.workPackageId,receipt,content:pack.content};
  });
  const value = {schemaVersion:RUNTIME_CONTEXT_MAP_VERSION,workflowId:current.workflowId,bindings};
  const sha256 = writeBridgeImmutable(options.cwd, options.output, value);
  return {path:options.output,sha256,workPackages:bindings.length,dispatchObserved:false,semanticUseVerified:false};
}
