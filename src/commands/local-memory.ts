import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveProject } from "../project/resolver";
import type { RecallResult, SessionMemoriesResult } from "../api/client";

export interface LocalMemoryOptions {
  cwd?: string;
  namespaceId?: string;
  storePath?: string;
  python?: string;
}

export interface LocalMemoryAvailability {
  available: boolean;
  provider: "snipara-memory";
  namespaceId: string;
  storePath: string;
  python?: string;
  version?: string;
  reason?: string;
  installCommand: string;
}

export interface LocalMemoryRecallOptions extends LocalMemoryOptions {
  query: string;
  limit?: number;
  minConfidence?: number;
  includeArchived?: boolean;
  types?: string[];
}

type PythonJsonResult<T> =
  | {
      ok: true;
      python: string;
      data: T;
    }
  | {
      ok: false;
      python?: string;
      error: string;
    };

const LOCAL_MEMORY_INSTALL_COMMAND = "pip install snipara-memory";

const LOCAL_MEMORY_RECALL_SCRIPT = `
import asyncio
import json
import sys
import time
from dataclasses import asdict

from snipara_memory.adapters import JsonFileMemoryStore
from snipara_memory.domain import MemoryService, RecallQuery, MemoryType

def lower(value):
    return str(value).lower() if value is not None else None

def memory_status(value):
    return "ACTIVE" if str(value) == "ACTIVE" else "INVALIDATED"

def serialize_memory(match):
    memory = asdict(match.memory)
    return {
        "memory_id": memory.get("id", ""),
        "content": memory.get("content", ""),
        "type": lower(memory.get("type") or "FACT"),
        "scope": lower(memory.get("scope") or "PROJECT"),
        "category": memory.get("category"),
        "status": memory_status(memory.get("status")),
        "relevance": float(match.score),
        "confidence": float(memory.get("confidence") or 0),
        "created_at": str(memory.get("created_at") or ""),
        "last_accessed_at": str(memory.get("last_accessed_at") or ""),
        "access_count": int(memory.get("access_count") or 0),
    }

async def main():
    args = json.load(sys.stdin)
    started = time.time()
    service = MemoryService(store=JsonFileMemoryStore(args["store_path"]))
    types = [MemoryType(value.upper()) for value in args.get("types", [])]
    matches = await service.semantic_recall(
        RecallQuery(
            namespace_id=args["namespace_id"],
            query=args["query"],
            limit=int(args.get("limit") or 8),
            min_confidence=float(args.get("min_confidence") or 0),
            include_archived=bool(args.get("include_archived") or False),
            types=types,
        )
    )
    print(json.dumps({
        "provider": "snipara-memory",
        "query": args["query"],
        "namespace_id": args["namespace_id"],
        "store_path": args["store_path"],
        "memories": [serialize_memory(match) for match in matches],
        "warnings": [],
        "total_searched": len(matches),
        "timing_ms": int((time.time() - started) * 1000),
    }, default=str))

asyncio.run(main())
`;

const LOCAL_MEMORY_SESSION_SCRIPT = `
import asyncio
import json
import sys
from dataclasses import asdict

from snipara_memory.adapters import JsonFileMemoryStore
from snipara_memory.domain import MemoryService

def serialize_memory(memory):
    item = asdict(memory)
    return {
        "id": item.get("id"),
        "memory_id": item.get("id"),
        "content": item.get("content"),
        "title": item.get("title"),
        "type": str(item.get("type", "")).lower(),
        "category": item.get("category"),
        "confidence": item.get("confidence"),
        "created_at": str(item.get("created_at") or ""),
    }

def tier(memories):
    entries = [serialize_memory(memory) for memory in memories]
    token_estimate = sum(max(1, len((entry.get("content") or "").split())) for entry in entries)
    return {"memories": entries, "count": len(entries), "tokens": token_estimate}

async def main():
    args = json.load(sys.stdin)
    service = MemoryService(store=JsonFileMemoryStore(args["store_path"]))
    bundle = await service.get_session_memories(
        args["namespace_id"],
        critical_limit=int(args.get("critical_limit") or 12),
        daily_limit=int(args.get("daily_limit") or 20),
        archive_limit=int(args.get("archive_limit") or 20),
    )
    critical = tier(bundle.critical)
    daily = tier(bundle.daily)
    archive = tier(bundle.archive)
    print(json.dumps({
        "provider": "snipara-memory",
        "namespace_id": args["namespace_id"],
        "store_path": args["store_path"],
        "critical": critical,
        "daily": daily,
        "archive": archive,
        "total_tokens": critical["tokens"] + daily["tokens"] + archive["tokens"],
        "message": "Loaded local session memory from snipara-memory.",
    }, default=str))

asyncio.run(main())
`;

function defaultStorePath(): string {
  return process.env.SNIPARA_MEMORY_STORE_PATH || path.join(os.homedir(), ".snipara-memory", "store.json");
}

export function resolveLocalMemoryNamespace(options: LocalMemoryOptions = {}): string {
  return (
    options.namespaceId ||
    process.env.SNIPARA_MEMORY_NAMESPACE ||
    resolveProject({ cwd: options.cwd ?? process.cwd() }).identifier
  );
}

function resolvePythonCandidates(options: LocalMemoryOptions = {}): string[] {
  return [
    options.python,
    process.env.SNIPARA_MEMORY_PYTHON,
    "python3",
    "python",
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
}

function runPythonJson<T>(
  script: string,
  input: Record<string, unknown>,
  options: LocalMemoryOptions = {}
): PythonJsonResult<T> {
  let lastError = "Python is not available.";

  for (const python of resolvePythonCandidates(options)) {
    const result = spawnSync(python, ["-c", script], {
      input: JSON.stringify(input),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });

    if (result.error) {
      lastError = result.error.message;
      continue;
    }
    if (result.status !== 0) {
      lastError = (result.stderr || result.stdout || `Python exited ${result.status}`).trim();
      continue;
    }

    try {
      return {
        ok: true,
        python,
        data: JSON.parse(result.stdout) as T,
      };
    } catch (error) {
      return {
        ok: false,
        python,
        error: `Invalid snipara-memory JSON output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    ok: false,
    error: lastError,
  };
}

export function detectLocalMemory(options: LocalMemoryOptions = {}): LocalMemoryAvailability {
  const namespaceId = resolveLocalMemoryNamespace(options);
  const storePath = options.storePath || defaultStorePath();
  const probe = runPythonJson<string>(
    "import importlib.metadata, json\nprint(json.dumps(importlib.metadata.version('snipara-memory')))",
    {},
    options
  );

  return {
    available: probe.ok,
    provider: "snipara-memory",
    namespaceId,
    storePath,
    python: probe.ok ? probe.python : probe.python,
    version: probe.ok ? probe.data : undefined,
    reason: probe.ok ? undefined : probe.error,
    installCommand: LOCAL_MEMORY_INSTALL_COMMAND,
  };
}

export async function recallLocalMemory(
  options: LocalMemoryRecallOptions
): Promise<(RecallResult & { provider: "snipara-memory"; namespace_id: string; store_path: string })> {
  const namespaceId = resolveLocalMemoryNamespace(options);
  const storePath = options.storePath || defaultStorePath();
  const result = runPythonJson<
    RecallResult & { provider: "snipara-memory"; namespace_id: string; store_path: string }
  >(
    LOCAL_MEMORY_RECALL_SCRIPT,
    {
      namespace_id: namespaceId,
      store_path: storePath,
      query: options.query,
      limit: options.limit ?? 8,
      min_confidence: options.minConfidence ?? 0,
      include_archived: options.includeArchived ?? false,
      types: options.types ?? [],
    },
    options
  );

  if (!result.ok) {
    throw new Error(
      `snipara-memory local recall unavailable: ${result.error}. Install with: ${LOCAL_MEMORY_INSTALL_COMMAND}`
    );
  }

  return result.data;
}

export async function loadLocalSessionMemories(
  options: LocalMemoryOptions & {
    criticalLimit?: number;
    dailyLimit?: number;
    archiveLimit?: number;
  } = {}
): Promise<SessionMemoriesResult & { provider: "snipara-memory"; namespace_id: string; store_path: string }> {
  const namespaceId = resolveLocalMemoryNamespace(options);
  const storePath = options.storePath || defaultStorePath();
  const result = runPythonJson<
    SessionMemoriesResult & { provider: "snipara-memory"; namespace_id: string; store_path: string }
  >(
    LOCAL_MEMORY_SESSION_SCRIPT,
    {
      namespace_id: namespaceId,
      store_path: storePath,
      critical_limit: options.criticalLimit ?? 12,
      daily_limit: options.dailyLimit ?? 20,
      archive_limit: options.archiveLimit ?? 20,
    },
    options
  );

  if (!result.ok) {
    throw new Error(
      `snipara-memory local session bundle unavailable: ${result.error}. Install with: ${LOCAL_MEMORY_INSTALL_COMMAND}`
    );
  }

  return result.data;
}
