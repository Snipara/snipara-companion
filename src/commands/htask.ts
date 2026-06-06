import { createClient } from "../api/client";
import { isConfigured } from "../config/store";

interface HTaskCreateOptions {
  swarmId: string;
  level?: string;
  title: string;
  description: string;
  owner: string;
  parentId?: string;
  priority?: string;
  etaTarget?: string;
  executionTarget?: string;
  workstreamType?: string;
  acceptanceCriteriaJson?: string;
  contextRefs?: string[];
  contextQuery?: string;
  evidenceRequiredJson?: string;
  isBlocking?: boolean;
  json?: boolean;
}

interface HTaskCreateFeatureOptions {
  swarmId: string;
  title: string;
  description: string;
  owner: string;
  parentId?: string;
  workstreams?: string[];
  workstreamOwners?: string[];
  json?: boolean;
}

interface HTaskNextOptions {
  swarmId: string;
  featureId?: string;
  workstreamType?: string;
  limit?: number;
  owner?: string;
  includeBlocked?: boolean;
  json?: boolean;
}

interface HTaskTreeOptions {
  swarmId: string;
  taskId?: string;
  maxDepth?: number;
  includeArchived?: boolean;
  includeCompleted?: boolean;
  json?: boolean;
}

interface HTaskCompleteOptions {
  swarmId: string;
  taskId: string;
  evidenceJson?: string;
  resultJson?: string;
  learningsJson?: string;
  decisionImpactJson?: string;
  createMemory?: boolean;
  json?: boolean;
}

function ensureConfigured(): void {
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }
}

function parseJsonOption<T>(label: string, rawValue?: string): T | undefined {
  if (!rawValue) {
    return undefined;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch (error) {
    throw new Error(
      `Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseKeyValueEntries(
  entries: string[] | undefined,
  label: string
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`Invalid ${label} entry '${entry}'. Expected KEY=value.`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid ${label} entry '${entry}'. Expected KEY=value.`);
    }
    result[key] = value;
  }
  return result;
}

function printResult(result: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

export async function htaskCreateCommand(options: HTaskCreateOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_htask_create", {
    swarm_id: options.swarmId,
    level: options.level,
    title: options.title,
    description: options.description,
    owner: options.owner,
    parent_id: options.parentId,
    priority: options.priority,
    eta_target: options.etaTarget,
    execution_target: options.executionTarget,
    workstream_type: options.workstreamType,
    acceptance_criteria: parseJsonOption<unknown[]>(
      "acceptance criteria",
      options.acceptanceCriteriaJson
    ),
    context_refs: options.contextRefs,
    context_query: options.contextQuery,
    evidence_required: parseJsonOption<unknown[]>(
      "evidence required",
      options.evidenceRequiredJson
    ),
    is_blocking: options.isBlocking,
  });

  printResult(result, options.json);
}

export async function htaskCreateFeatureCommand(options: HTaskCreateFeatureOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_htask_create_feature", {
    swarm_id: options.swarmId,
    title: options.title,
    description: options.description,
    owner: options.owner,
    parent_id: options.parentId,
    workstreams: options.workstreams,
    workstream_owners: parseKeyValueEntries(options.workstreamOwners, "workstream owner"),
  });

  printResult(result, options.json);
}

export async function htaskNextCommand(options: HTaskNextOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_htask_recommend_batch", {
    swarm_id: options.swarmId,
    feature_id: options.featureId,
    workstream_type: options.workstreamType,
    limit: options.limit,
    owner: options.owner,
    exclude_blocked: options.includeBlocked ? false : true,
  });

  printResult(result, options.json);
}

export async function htaskTreeCommand(options: HTaskTreeOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_htask_tree", {
    swarm_id: options.swarmId,
    task_id: options.taskId,
    max_depth: options.maxDepth,
    include_archived: options.includeArchived,
    include_completed: options.includeCompleted,
  });

  printResult(result, options.json);
}

export async function htaskCompleteCommand(options: HTaskCompleteOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_htask_complete", {
    swarm_id: options.swarmId,
    task_id: options.taskId,
    evidence: parseJsonOption<unknown>("evidence", options.evidenceJson),
    result: parseJsonOption<unknown>("result", options.resultJson),
    learnings: parseJsonOption<unknown[]>("learnings", options.learningsJson),
    decision_impact: parseJsonOption<unknown>("decision impact", options.decisionImpactJson),
    create_memory: options.createMemory,
  });

  printResult(result, options.json);
}
