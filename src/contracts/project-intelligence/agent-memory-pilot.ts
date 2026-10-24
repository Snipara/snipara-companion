import { createHash } from "node:crypto";
import { resolveAgentContext } from "./agent-context";
import { stableDecisionJsonStringify } from "./decision-request";

export const MEMORY_PILOT_VERSION = "snipara.agent_memory_pilot.v1" as const;
type Scalar = string | number | boolean | null;
export type PilotAssertion =
  | { kind: "json_value"; keys: string[]; value: Scalar }
  | { kind: "source_excerpt"; text: string }
  | { kind: "interpretation"; text: string };

export interface PilotCandidate {
  id: string;
  sourceId: string;
  sourceHash: string;
  scope: "agent" | "project" | "team";
  category: string;
  assertion: PilotAssertion;
}

export interface MemoryPilotRequest {
  schemaVersion: typeof MEMORY_PILOT_VERSION;
  taskId: string;
  producer: string;
  candidates: PilotCandidate[];
}

/** Supplied by the adapter after reading the trusted local manifest's allowlist. */
export interface PilotSource {
  id: string;
  content?: string;
  unavailable?: "missing" | "unsafe_path" | "too_large";
}

export type PilotOutcome =
  | "auto_validated"
  | "auto_invalidated"
  | "needs_evidence"
  | "needs_human"
  | "excluded";
export interface PilotDecision {
  id: string;
  scope: PilotCandidate["scope"];
  category: string;
  candidateHash: string;
  sourceId: string;
  sourceHash: string | null;
  outcome: PilotOutcome;
  status: "ACTIVE" | "INVALIDATED" | "CANDIDATE" | "EXCLUDED";
  reason: string;
  duplicateOf?: string;
  /** Exact source observations only. Never an execution or business approval. */
  observation?: Exclude<PilotAssertion, { kind: "interpretation" }>;
}

export interface MemoryPilotReceipt {
  schemaVersion: typeof MEMORY_PILOT_VERSION;
  projectId: string;
  taskId: string;
  producerId: string;
  consumerId: string;
  manifestHash: string;
  requestHash: string;
  decisions: PilotDecision[];
  delta: { id: string; before: string | null; after: string; reason: string }[];
  previousReceiptHash: string | null;
  receiptHash: string;
  limits: string[];
}

export function pilotContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown pilot field");
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
}
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
}

function hasSensitiveValue(value: string): boolean {
  return (
    /\b(?:api[_-]?key|password|passwd|secret|private[_-]?key)\b["']?\s*[:=]\s*["']?\S+/i.test(
      value
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bsnp[-_][A-Za-z0-9._~+/=-]{8,}|\bgh[pousr]_[A-Za-z0-9_]{16,}|-----BEGIN .*PRIVATE KEY-----/i.test(
      value
    )
  );
}

/** Preserve JSON source meaning before JavaScript's numeric conversion. */
function unambiguousJson(content: string): unknown {
  const parsed: unknown = JSON.parse(content);
  const tokens =
    content.match(
      /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}[\]:,]|true|false|null/g
    ) ?? [];
  const stack: (Set<string> | null)[] = [];
  // Compare decimal lexemes, not binary floating point. Bound exponents first.
  const decimal = (raw: string): string => {
    const [mantissa, exponent = "0"] = raw.toLowerCase().split("e");
    const exp = Number(exponent);
    if (!Number.isSafeInteger(exp) || Math.abs(exp) > 308) throw new Error("Unbounded JSON number");
    let digits = mantissa.replace(".", "").replace(/^-/, "");
    let scale = exp - (mantissa.split(".")[1]?.length ?? 0);
    digits = digits.replace(/^0+/, "");
    if (!digits) return "0";
    while (digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      scale++;
    }
    return `${mantissa.startsWith("-") ? "-" : ""}${digits}e${scale}`;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set<string>() : null);
      if (stack.length > 128) throw new Error("JSON nesting limit");
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack[stack.length - 1];
      const key: string = JSON.parse(token);
      if (keys?.has(key)) throw new Error("Duplicate JSON key");
      keys?.add(key);
    } else if (/^-?[0-9]/.test(token)) {
      if (!Number.isFinite(Number(token)) || decimal(token) !== decimal(String(Number(token))))
        throw new Error("Lossy JSON number");
    }
  }
  return parsed;
}

export function parseMemoryPilotRequest(value: unknown): MemoryPilotRequest {
  if (!object(value)) throw new Error("Expected pilot request object");
  exactKeys(value, ["schemaVersion", "taskId", "producer", "candidates"]);
  if (
    value.schemaVersion !== MEMORY_PILOT_VERSION ||
    !identifier(value.taskId) ||
    !identifier(value.producer) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 100
  )
    throw new Error("Invalid pilot request");
  const ids = new Set<string>();
  for (const row of value.candidates) {
    if (!object(row)) throw new Error("Invalid candidate");
    exactKeys(row, ["id", "sourceId", "sourceHash", "scope", "category", "assertion"]);
    if (
      !identifier(row.id) ||
      ids.has(row.id) ||
      !identifier(row.sourceId) ||
      !identifier(row.category) ||
      typeof row.sourceHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(row.sourceHash) ||
      !["agent", "project", "team"].includes(String(row.scope)) ||
      !object(row.assertion)
    )
      throw new Error("Invalid candidate identity, scope or evidence");
    ids.add(row.id);
    const assertion = row.assertion;
    if (assertion.kind === "json_value") {
      exactKeys(assertion, ["kind", "keys", "value"]);
      if (
        !Array.isArray(assertion.keys) ||
        assertion.keys.length < 1 ||
        assertion.keys.length > 16 ||
        assertion.keys.some(
          (key) =>
            typeof key !== "string" ||
            key.length > 128 ||
            !key.length ||
            ["__proto__", "prototype", "constructor"].includes(key)
        ) ||
        !(
          assertion.value === null ||
          typeof assertion.value === "boolean" ||
          (typeof assertion.value === "number" &&
            Number.isFinite(assertion.value) &&
            Math.abs(assertion.value) <= Number.MAX_SAFE_INTEGER) ||
          (typeof assertion.value === "string" && assertion.value.length <= 4000)
        )
      )
        throw new Error("Invalid JSON observation");
    } else if (assertion.kind === "source_excerpt" || assertion.kind === "interpretation") {
      exactKeys(assertion, ["kind", "text"]);
      if (!boundedText(assertion.text)) throw new Error("Invalid observation text");
    } else throw new Error("Unsupported assertion kind");
    if (
      hasSensitiveValue(stableDecisionJsonStringify(assertion)) ||
      (assertion.kind === "json_value" &&
        (assertion.keys as string[]).some((key) =>
          /password|passwd|secret|token|api[_-]?key|private[_-]?key/i.test(key)
        ))
    )
      throw new Error("Sensitive observations cannot be persisted");
  }
  return value as unknown as MemoryPilotRequest;
}

export function verifyMemoryPilotReceipt(value: unknown): asserts value is MemoryPilotReceipt {
  if (
    !object(value) ||
    value.schemaVersion !== MEMORY_PILOT_VERSION ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > 100 ||
    !identifier(value.projectId) ||
    !identifier(value.taskId) ||
    !identifier(value.producerId) ||
    !identifier(value.consumerId)
  )
    throw new Error("Invalid previous receipt");
  const { receiptHash, ...body } = value;
  if (receiptHash !== pilotContentHash(stableDecisionJsonStringify(body)))
    throw new Error("Previous receipt integrity mismatch");
  const ids = new Set<string>();
  for (const item of value.decisions) {
    if (
      !object(item) ||
      !identifier(item.id) ||
      ids.has(item.id) ||
      typeof item.candidateHash !== "string" ||
      !["auto_validated", "auto_invalidated", "needs_evidence", "needs_human", "excluded"].includes(
        String(item.outcome)
      )
    )
      throw new Error("Invalid previous decision");
    ids.add(item.id);
  }
}

export function evaluateMemoryPilot(input: {
  manifest: unknown;
  request: unknown;
  consumer: string;
  sources: PilotSource[];
  previous?: unknown;
}): MemoryPilotReceipt {
  const request = parseMemoryPilotRequest(input.request);
  if (
    !object(input.manifest) ||
    !object(input.manifest.project) ||
    !identifier(input.manifest.project.id)
  )
    throw new Error("Pilot requires a stable manifest project id");
  const projectId = input.manifest.project.id;
  const producer = resolveAgentContext({
    manifest: input.manifest,
    agent: request.producer,
    task: request.taskId,
  });
  const consumer = resolveAgentContext({
    manifest: input.manifest,
    agent: input.consumer,
    task: request.taskId,
  });
  if (
    input.sources.length > 200 ||
    new Set(input.sources.map((source) => source.id)).size !== input.sources.length
  )
    throw new Error("Duplicate or excessive sources");
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const prior = input.previous;
  if (prior !== undefined) {
    verifyMemoryPilotReceipt(prior);
    if (
      prior.projectId !== projectId ||
      prior.taskId !== request.taskId ||
      prior.producerId !== producer.agent.agentId
    )
      throw new Error("Previous receipt belongs to another task, project or producer");
  }
  const seen = new Map<string, string>();
  let observationBytes = 0;
  const observationBudget = Math.min(producer.budget.memoryTokens, consumer.budget.memoryTokens);
  const decisions = request.candidates.map((candidate): PilotDecision => {
    const candidateHash = pilotContentHash(stableDecisionJsonStringify(candidate));
    const base = {
      id: candidate.id,
      scope: candidate.scope,
      category: candidate.category,
      candidateHash,
      sourceId: candidate.sourceId,
      sourceHash: null as string | null,
    };
    const result = (outcome: PilotOutcome, reason: string): PilotDecision => ({
      ...base,
      outcome,
      reason,
      status:
        outcome === "auto_validated"
          ? "ACTIVE"
          : outcome === "auto_invalidated"
            ? "INVALIDATED"
            : outcome === "excluded"
              ? "EXCLUDED"
              : "CANDIDATE",
    });
    // Re-evaluate policy on every resume; previous validation grants no access.
    if (
      !producer.sources.some((s) => s.id === candidate.sourceId) ||
      !consumer.sources.some((s) => s.id === candidate.sourceId)
    )
      return result("excluded", "source_outside_profile");
    const allowed =
      candidate.scope === "agent"
        ? producer.agent.agentId === consumer.agent.agentId &&
          candidate.category === producer.memory.defaultWrite.category
        : producer.memory.promotion.some(
            (target) => target.scope === candidate.scope && target.category === candidate.category
          ) &&
          consumer.memory.recall.some(
            (target) => target.scope === candidate.scope && target.category === candidate.category
          );
    if (!allowed) return result("excluded", "target_outside_profile");
    const source = sources.get(candidate.sourceId);
    if (!source || source.content === undefined)
      return result("needs_evidence", source?.unavailable ?? "missing");
    if (Buffer.byteLength(source.content) > 1_048_576) return result("needs_evidence", "too_large");
    base.sourceHash = pilotContentHash(source.content);
    const sourceChanged = base.sourceHash !== candidate.sourceHash;
    const assertion = candidate.assertion;
    if (assertion.kind === "interpretation")
      return result("needs_human", "semantic_judgment_not_proven_by_source_bytes");
    let matches: boolean;
    if (assertion.kind === "source_excerpt") {
      matches = source.content.includes(assertion.text);
    } else {
      let actual: unknown;
      try {
        actual = unambiguousJson(source.content);
      } catch {
        return result("needs_evidence", "source_not_unambiguous_json");
      }
      for (const key of assertion.keys) {
        if (
          (object(actual) || (Array.isArray(actual) && /^(0|[1-9][0-9]{0,8})$/.test(key))) &&
          Object.prototype.hasOwnProperty.call(actual, key)
        ) {
          actual = (actual as Record<string, unknown>)[key];
        } else {
          actual = undefined;
          break;
        }
      }
      matches = actual === assertion.value;
    }
    if (!matches) return result("auto_invalidated", "observation_contradicted");
    const evidenceKey = pilotContentHash(
      stableDecisionJsonStringify({
        source: candidate.sourceId,
        hash: base.sourceHash,
        assertion,
        scope: candidate.scope,
        category: candidate.category,
      })
    );
    const duplicateOf = seen.get(evidenceKey);
    if (duplicateOf) return { ...result("excluded", "duplicate_evidence"), duplicateOf };
    // Conservative byte allowance for source text; this is not model token telemetry.
    const bytes = Buffer.byteLength(stableDecisionJsonStringify(assertion));
    if (observationBytes + bytes > observationBudget)
      return result("excluded", "memory_budget_exceeded");
    observationBytes += bytes;
    seen.set(evidenceKey, candidate.id);
    return {
      ...result(
        "auto_validated",
        sourceChanged ? "reverified_after_source_change" : "exact_source_observation"
      ),
      observation: assertion,
    };
  });
  const previous = prior as MemoryPilotReceipt | undefined;
  const previousDecisions = new Map(previous?.decisions.map((d) => [d.id, d]) ?? []);
  const delta: MemoryPilotReceipt["delta"] = [];
  for (const decision of decisions) {
    const before = previousDecisions.get(decision.id);
    if (
      !before ||
      before.outcome !== decision.outcome ||
      before.candidateHash !== decision.candidateHash ||
      before.sourceHash !== decision.sourceHash
    ) {
      delta.push({
        id: decision.id,
        before: before?.outcome ?? null,
        after: decision.outcome,
        reason: decision.reason,
      });
    }
    previousDecisions.delete(decision.id);
  }
  for (const before of previousDecisions.values())
    delta.push({
      id: before.id,
      before: before.outcome,
      after: "not_present",
      reason: "not_present_is_not_deletion_or_invalidation",
    });
  const body = {
    schemaVersion: MEMORY_PILOT_VERSION,
    projectId,
    taskId: request.taskId,
    producerId: producer.agent.agentId,
    consumerId: consumer.agent.agentId,
    manifestHash: producer.manifestHash,
    requestHash: pilotContentHash(stableDecisionJsonStringify(request)),
    decisions,
    delta,
    previousReceiptHash: previous?.receiptHash ?? null,
    limits: [
      "Local manifest is the trust boundary, not authenticated hosted agent isolation.",
      "Automatic review validates source observations, never business truth, execution success or permission to act.",
      "Observation JSON bytes are capped by both profiles' memory token allowances; receipt metadata is separate.",
      "Receipt hashes detect drift; they are not signatures or independent evidence.",
      "No hosted memory is mutated. Existing hosted review policy is unchanged.",
    ],
  };
  return {
    ...body,
    receiptHash: pilotContentHash(stableDecisionJsonStringify(body)),
  };
}
