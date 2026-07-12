import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import {
  DEFAULT_WORKER_CONTEXT_WINDOW,
  buildWorkerProfile,
  WORKER_PROFILE_RISK_CEILINGS,
  inferWorkerReasoningFromModel,
  normalizeWorkerProfile,
  type WorkerProfile,
  type WorkerProfileCliTransport,
  type WorkerProfileOpenAITransport,
} from "../contracts/project-intelligence";
import { findWorkspaceRoot } from "../config/store";

export const WORKER_REGISTRY_DIR_RELATIVE_PATH = path.join(".snipara", "workers");
export const LOCAL_WORKERS_RELATIVE_PATH = path.join(
  WORKER_REGISTRY_DIR_RELATIVE_PATH,
  "local.json"
);
export const WORKER_REGISTRY_INDEX_RELATIVE_PATH = path.join(
  WORKER_REGISTRY_DIR_RELATIVE_PATH,
  "index.json"
);
const ADAPTIVE_ROUTING_POLICY_RELATIVE_PATH = path.join(".snipara", "adaptive-routing.json");

export const WORKER_REGISTRY_INDEX_VERSION = "snipara.worker_registry_index.v1" as const;

interface LegacyWorkersConfig {
  schemaVersion: "snipara.local_workers.v1";
  updatedAt: string;
  defaultWorkerId: string;
  workers: LegacyLocalWorkerDeclaration[];
}

export interface LegacyLocalWorkerDeclaration {
  id: string;
  workerRole: string;
  endpointType: "local";
  provider: string;
  baseUrl: string;
  model?: string;
  preferModel?: string;
  capabilities: string[];
  writeScope: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalWorkerDeclaration {
  id: string;
  workerRole: string;
  endpointType: "local";
  provider: string;
  baseUrl: string;
  command?: string;
  model?: string;
  preferModel?: string;
  capabilities: string[];
  reasoning: "low" | "medium" | "high";
  writeScope: string[];
  createdAt: string;
  updatedAt: string;
}

interface WorkerRegistryIndex {
  schemaVersion: typeof WORKER_REGISTRY_INDEX_VERSION;
  updatedAt: string;
  defaultWorkerId: string;
}

export interface LocalWorkersConfig {
  schemaVersion: "snipara.local_workers.v1";
  updatedAt: string;
  defaultWorkerId: string;
  workers: LocalWorkerDeclaration[];
}

export interface LocalWorkerRoutingDefaults {
  worker: LocalWorkerDeclaration;
  routeLocalWorkers: true;
  routingWorkerRole: string;
  routingLocalBaseUrl: string;
  routingLocalModel?: string;
  routingLocalPreferModel?: string;
  routingLocalProvider: string;
  routingPreferredEndpoints: string[];
  routingAllowedEndpoints: string[];
  plannerRetainsReasoning: true;
}

export interface LocalWorkerAddOptions {
  id?: string;
  role?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  preferModel?: string;
  capabilities?: string[];
  writeScope?: string[];
  contextWindow?: number;
  reasoning?: "low" | "medium" | "high";
  default?: boolean;
  json?: boolean;
  transport?: "openai_http" | "cli";
  command?: string;
}

export interface LocalWorkerStatusOptions {
  json?: boolean;
}

export interface LocalWorkerListOptions {
  json?: boolean;
}

export interface LocalWorkerRemoveOptions {
  id: string;
  json?: boolean;
}

export interface LocalWorkerProbeOptions {
  baseUrl?: string;
  provider?: string;
  model?: string;
  preferModel?: string;
  role?: string;
  workerId?: string;
  capabilities?: string[];
  writeScope?: string[];
  reasoning?: "low" | "medium" | "high";
  contextWindow?: number;
  json?: boolean;
}

export interface LocalWorkerProbeResult {
  catalog: unknown;
  suggestion?: LocalWorkerDeclaration;
}

export function workersLocalAddCommand(options: LocalWorkerAddOptions): void {
  const result = addLocalWorker(options);
  if (options.json) {
    printJson(result);
    return;
  }

  console.log(chalk.bold("Local worker declared"));
  printKeyValue("Worker:", result.worker.id);
  printKeyValue("Role:", result.worker.workerRole);
  printKeyValue("Provider:", result.worker.provider);
  printKeyValue("Base URL:", result.worker.baseUrl);
  if (result.worker.model) {
    printKeyValue("Model:", result.worker.model);
  } else if (result.worker.preferModel) {
    printKeyValue("Prefer model:", result.worker.preferModel);
  }
  printKeyValue("Config:", result.workerConfigPath);
  printKeyValue("Routing policy:", result.policyPath);
}

export function workersLocalStatusCommand(options: LocalWorkerStatusOptions = {}): void {
  const config = readLocalWorkersConfig();
  const result = {
    configured: Boolean(config),
    path: pathForWorkerRegistryDir(),
    defaultWorkerId: config?.defaultWorkerId ?? null,
    workers: config?.workers ?? [],
  };

  if (options.json) {
    printJson(result);
    return;
  }

  if (!config || config.workers.length === 0) {
    console.log("No local workers declared. Run 'snipara-companion workers local add'.");
    return;
  }

  console.log(chalk.bold("Local workers"));
  for (const worker of config.workers) {
    const defaultMarker = worker.id === config.defaultWorkerId ? " (default)" : "";
    const model = worker.model
      ? ` model=${worker.model}`
      : worker.preferModel
        ? ` prefer=${worker.preferModel}`
        : worker.command
          ? " cli"
          : "";
    const transportLabel = worker.command ? "cli" : "openai_http";
    console.log(
      `- ${worker.id}${defaultMarker}: ${worker.workerRole} ${transportLabel} ${worker.baseUrl}${model}`
    );
  }
}

export function workersLocalListCommand(options: LocalWorkerListOptions = {}): void {
  const config = readLocalWorkersConfig();
  const result = {
    configured: Boolean(config && config.workers.length > 0),
    path: pathForWorkerRegistryDir(),
    defaultWorkerId: config?.defaultWorkerId ?? null,
    workers: config?.workers ?? [],
  };

  if (options.json) {
    printJson(result);
    return;
  }

  if (!result.configured) {
    console.log("No local workers declared. Run 'snipara-companion workers local add'.");
    return;
  }

  console.log(chalk.bold("Declared local workers"));
  for (const worker of result.workers) {
    const defaultMarker = worker.id === config?.defaultWorkerId ? " (default)" : "";
    const model = worker.model
      ? ` model=${worker.model}`
      : worker.preferModel
        ? ` prefer=${worker.preferModel}`
        : "";
    const command = worker.command ? ` command=${worker.command}` : "";
    console.log(
      `- ${worker.id}${defaultMarker}: ${worker.workerRole} at ${worker.baseUrl}${model}${command}`
    );
  }
}

export function workersLocalRemoveCommand(options: LocalWorkerRemoveOptions): void {
  const result = removeLocalWorker(options.id);
  if (options.json) {
    printJson(result);
    return;
  }

  if (result.removed) {
    console.log(chalk.bold("Local worker removed"));
    printKeyValue("Worker:", result.removed.id);
    if (result.defaultWorkerId) {
      printKeyValue("Default:", result.defaultWorkerId);
    }
  } else {
    console.log(chalk.red(`No local worker found for id=${options.id}`));
  }
}

export function workersLocalProbeCommand(options: LocalWorkerProbeOptions): LocalWorkerProbeResult {
  const role = normalizeWorkerRole(options.role);
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:1234");
  const provider = normalizeProvider(stringValue(options.provider) ?? "lm-studio");
  const model = stringValue(options.model);
  const preferModel = stringValue(options.preferModel);
  const declaredReasoning = options.reasoning;
  const inferredReasoning = inferWorkerReasoningFromModel(model || preferModel);
  const candidateReasoning = declaredReasoning || inferredReasoning;
  const catalog = runOrchestratorLocalCatalog({
    baseUrl,
    workerRole: role,
    capabilities: normalizeStringList(options.capabilities),
    writeScope: normalizeStringList(options.writeScope),
    model,
    preferModel,
  });
  const catalogContextWindow = resolveContextWindowFromCatalog(catalog, model, preferModel);
  const contextWindow = normalizeContextWindow(
    options.contextWindow ?? catalogContextWindow ?? DEFAULT_WORKER_CONTEXT_WINDOW
  );

  const modelsSeen = normalizeStringList((catalog as { models?: unknown }).models);
  const workerId = normalizeWorkerId(
    stringValue(options.workerId) ?? model ?? preferModel ?? `${provider}-${role}`
  );
  const suggestion =
    modelsSeen.length > 0
      ? toLocalWorkerDeclaration(
          buildWorkerProfile({
            workerId,
            label: options.workerId ?? `${role} worker from probe`,
            transport: {
              kind: "openai_http",
              baseUrl,
              ...(model ? { model } : {}),
              ...(preferModel ? { preferModel } : {}),
              provider,
            },
            capabilities: {
              roles: [role],
              languages:
                role === "documentation"
                  ? ["markdown", "text"]
                  : ["typescript", "javascript", "python"],
              contextWindow,
              toolUse: false,
            },
            ceilings: {
              writeScope: normalizeStringList(options.writeScope),
              riskCeiling: WORKER_PROFILE_RISK_CEILINGS[0],
              privacyClass: "local",
            },
            reasoning: candidateReasoning,
            probe: {
              probedAt: new Date().toISOString(),
              source: "workers probe",
              modelsSeen,
            },
          })
        )
      : undefined;

  return {
    catalog,
    ...(suggestion ? { suggestion } : {}),
  };
}

export function workersLocalProbePrintCommand(options: LocalWorkerProbeOptions): void {
  const payload = workersLocalProbeCommand(options);
  printJson(payload);
}

export function addLocalWorker(options: LocalWorkerAddOptions): {
  worker: LocalWorkerDeclaration;
  config: LocalWorkersConfig;
  workerConfigPath: string;
  policyPath: string;
} {
  const now = new Date().toISOString();
  const transport = normalizeWorkerTransport(options);
  const workerRole = normalizeWorkerRole(options.role);
  const workerId = normalizeWorkerId(options.id ?? transportIdentifierSeed(options, workerRole));
  const existing = readLocalWorkersConfig();
  const existingWorker = existing?.workers.find((worker) => worker.id === workerId);
  const explicitReasoning = options.reasoning;
  const derivedReasoning = inferWorkerReasoningFromModel(
    transport.kind === "openai_http" ? (transport.model ?? transport.preferModel) : undefined
  );
  const candidateReasoning = explicitReasoning ?? derivedReasoning;
  const contextWindow = normalizeContextWindow(options.contextWindow);

  const profile = buildWorkerProfile({
    workerId,
    label: `${workerRole} ${workerId}`,
    transport,
    capabilities: {
      roles: [workerRole],
      languages:
        normalizeStringList(options.capabilities).length > 0
          ? normalizeStringList(options.capabilities)
          : defaultCapabilitiesForWorker(workerRole),
      contextWindow,
      toolUse: false,
    },
    ceilings: {
      writeScope: normalizeStringList(options.writeScope),
      riskCeiling: WORKER_PROFILE_RISK_CEILINGS[0],
      privacyClass: transport.kind === "openai_http" ? "local" : "cloud",
    },
    reasoning: candidateReasoning,
    createdAt: existingWorker?.createdAt ?? now,
    updatedAt: now,
  });

  const declaration = toLocalWorkerDeclaration(profile);
  const existingWorkers = readWorkerProfileDeclarations();
  const updatedWorkers = [
    ...existingWorkers.filter((candidate) => candidate.id !== declaration.id),
    declaration,
  ].sort((left, right) => left.id.localeCompare(right.id));

  const defaultWorkerId = resolveDefaultWorkerIdForWrite({
    existing,
    updatedWorkers,
    requestedWorkerId: declaration.id,
    optionsDefault: options.default,
  });

  const config: LocalWorkersConfig = {
    schemaVersion: "snipara.local_workers.v1",
    updatedAt: now,
    defaultWorkerId,
    workers: updatedWorkers,
  };

  const workerConfigPath = pathForWorkerFile(workerId);
  writeJsonFile(workerConfigPath, profile);
  writeWorkerRegistryIndex(defaultWorkerId);

  const policyPath = upsertLocalAdaptiveRoutingPolicy(workerRole);

  return {
    worker: declaration,
    config,
    workerConfigPath,
    policyPath,
  };
}

export function removeLocalWorker(workerId: string): {
  removed: LocalWorkerDeclaration | null;
  config: LocalWorkersConfig | null;
  defaultWorkerId: string | null;
} {
  const id = normalizeWorkerId(workerId);
  const config = readLocalWorkersConfig();
  if (!config) {
    return { removed: null, config: null, defaultWorkerId: null };
  }

  const removed = config.workers.find((worker) => worker.id === id) ?? null;
  const normalized = config.workers.filter((worker) => worker.id !== id);
  if (!removed) {
    return { removed: null, config, defaultWorkerId: config.defaultWorkerId };
  }

  const now = new Date().toISOString();
  const workerFilePath = pathForWorkerFile(id);
  if (fs.existsSync(workerFilePath)) {
    fs.rmSync(workerFilePath);
  }

  const nextDefaultWorkerId =
    id === config.defaultWorkerId ? (normalized[0]?.id ?? "") : config.defaultWorkerId;

  if (normalized.length === 0) {
    clearWorkerRegistryIndex();
    return {
      removed,
      config: {
        schemaVersion: "snipara.local_workers.v1",
        updatedAt: now,
        defaultWorkerId: "",
        workers: [],
      },
      defaultWorkerId: null,
    };
  }

  const nextConfig: LocalWorkersConfig = {
    ...config,
    updatedAt: now,
    defaultWorkerId: nextDefaultWorkerId,
    workers: normalized,
  };
  writeWorkerRegistryIndex(nextDefaultWorkerId);

  return {
    removed,
    config: nextConfig,
    defaultWorkerId: nextDefaultWorkerId,
  };
}

export function resolveLocalWorkerRoutingDefaults(
  options: {
    workerId?: string;
    workerRole?: string;
  } = {}
): LocalWorkerRoutingDefaults | null {
  const registry = readWorkerProfileDeclarations();
  const config = readLocalWorkersConfig();

  if ((!registry || registry.length === 0) && options.workerId) {
    throw new Error(`Local worker ${options.workerId} is not declared.`);
  }
  if (!registry || registry.length === 0) {
    return null;
  }

  const defaultWorkerId = config?.defaultWorkerId;
  const requestedId = stringValue(options.workerId);
  const requestedRole = normalizeWorkerRole(options.workerRole);

  const worker =
    (requestedId ? registry.find((candidate) => candidate.id === requestedId) : undefined) ??
    (requestedRole
      ? registry.find((candidate) => candidate.workerRole === requestedRole)
      : undefined) ??
    registry.find((candidate) => candidate.id === defaultWorkerId) ??
    registry.find((candidate) => candidate.id === requestedRole) ??
    registry[0];

  if (!worker) {
    return null;
  }

  if (requestedId && worker.id !== requestedId) {
    throw new Error(`Local worker ${requestedId} is not declared.`);
  }

  if (!worker.baseUrl || worker.baseUrl === "cli://command") {
    return null;
  }

  if (!worker.model && !worker.preferModel) {
    const hasCatalogHint = true;
    void hasCatalogHint;
  }

  return {
    worker,
    routeLocalWorkers: true,
    routingWorkerRole: worker.workerRole,
    routingLocalBaseUrl: worker.baseUrl,
    ...(worker.model ? { routingLocalModel: worker.model } : {}),
    ...(worker.preferModel ? { routingLocalPreferModel: worker.preferModel } : {}),
    routingLocalProvider: worker.provider,
    routingPreferredEndpoints: ["local"],
    routingAllowedEndpoints: ["local"],
    plannerRetainsReasoning: true,
  };
}

export function readLocalWorkersConfig(): LocalWorkersConfig | null {
  migrateLegacyWorkersIfNeeded();
  const profiles = readWorkerProfileDeclarations();
  const defaultWorkerId = readWorkerRegistryDefaultWorkerId();

  if (profiles.length === 0) {
    return null;
  }

  return {
    schemaVersion: "snipara.local_workers.v1",
    updatedAt: new Date(0).toISOString(),
    defaultWorkerId: defaultWorkerId ?? profiles[0].id,
    workers: profiles,
  };
}

function readWorkerProfileDeclarations(): LocalWorkerDeclaration[] {
  const dir = pathForWorkerRegistryDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const profiles: LocalWorkerDeclaration[] = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".json")) {
      continue;
    }
    if (dirent.name === "local.json" || dirent.name === "index.json") {
      continue;
    }

    const parsed = readJsonRecord(path.join(dir, dirent.name));
    if (!parsed) {
      continue;
    }
    const profile = normalizeWorkerProfileRecord(parsed);
    if (!profile) {
      continue;
    }

    profiles.push(toLocalWorkerDeclaration(profile));
  }

  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

function migrateLegacyWorkersIfNeeded(): void {
  const dir = pathForWorkerRegistryDir();
  if (!fs.existsSync(dir)) {
    return;
  }

  const hasWorkerProfiles = fs
    .readdirSync(dir, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "index.json" &&
        entry.name !== "local.json"
    );
  if (hasWorkerProfiles) {
    return;
  }

  const legacy = readLegacyLocalWorkersConfig();
  if (!legacy || legacy.workers.length === 0) {
    return;
  }

  for (const worker of legacy.workers) {
    const profile = toProfileFromLegacyWorker(worker);
    writeJsonFile(pathForWorkerFile(profile.workerId), profile);
  }
  writeWorkerRegistryIndex(legacy.defaultWorkerId);
}

function readLegacyLocalWorkersConfig(): LegacyWorkersConfig | null {
  const filePath = pathForLegacyLocalWorkersConfig();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = readJsonRecord(filePath);
  if (!parsed || parsed.schemaVersion !== "snipara.local_workers.v1") {
    return null;
  }

  const workers = Array.isArray(parsed.workers)
    ? parsed.workers
        .map(normalizeLegacyWorkerDeclaration)
        .filter((worker): worker is LegacyLocalWorkerDeclaration => Boolean(worker))
    : [];
  const defaultWorkerId = stringValue(parsed.defaultWorkerId) ?? workers[0]?.id;
  if (!defaultWorkerId) {
    return null;
  }

  return {
    schemaVersion: "snipara.local_workers.v1",
    updatedAt: stringValue(parsed.updatedAt) ?? new Date(0).toISOString(),
    defaultWorkerId,
    workers,
  };
}

function normalizeWorkerProfileRecord(value: Record<string, unknown>): WorkerProfile | null {
  const candidate = normalizeWorkerProfile(value);
  if (!candidate) {
    return null;
  }
  const workerId = stringValue(candidate.workerId);
  const transport = candidate.transport;
  if (!workerId || !transport || !candidate.label) {
    return null;
  }

  if (transport.kind === "openai_http") {
    const baseUrl = normalizeBaseUrl(transport.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return {
      ...candidate,
      workerId,
      transport: {
        ...transport,
        baseUrl,
        provider: normalizeProvider(transport.provider ?? "lm-studio"),
      },
    } as WorkerProfile;
  }

  if (transport.kind === "cli") {
    const command = stringValue((transport as WorkerProfileCliTransport).command);
    if (!command) {
      return null;
    }
    const cliTransport = transport as WorkerProfileCliTransport;
    return {
      ...candidate,
      workerId,
      transport: {
        kind: "cli",
        command,
        ...(stringValue(cliTransport.shell) ? { shell: stringValue(cliTransport.shell) } : {}),
        ...(Array.isArray(cliTransport.args)
          ? {
              args: cliTransport.args
                .map((item) => stringValue(item))
                .filter((item): item is string => Boolean(item)),
            }
          : {}),
      },
    } as WorkerProfile;
  }

  return null;
}

function toProfileFromLegacyWorker(worker: LegacyLocalWorkerDeclaration): WorkerProfile {
  const modelHint = worker.model || worker.preferModel;
  return buildWorkerProfile({
    workerId: worker.id,
    label: `${worker.workerRole} worker`,
    transport: {
      kind: "openai_http",
      baseUrl: worker.baseUrl,
      ...(worker.model ? { model: worker.model } : {}),
      ...(worker.preferModel ? { preferModel: worker.preferModel } : {}),
      provider: worker.provider,
    },
    capabilities: {
      roles: [normalizeWorkerRole(worker.workerRole)],
      languages: normalizeWorkerProfileLanguages(worker.capabilities),
      contextWindow: DEFAULT_WORKER_CONTEXT_WINDOW,
      toolUse: false,
    },
    ceilings: {
      writeScope: normalizeStringList(worker.writeScope),
      riskCeiling: WORKER_PROFILE_RISK_CEILINGS[0],
      privacyClass: "local",
    },
    reasoning: inferWorkerReasoningFromModel(modelHint),
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
    hints: { costTier: "free", latencyTier: "balanced" },
  });
}

function toLocalWorkerDeclaration(profile: WorkerProfile): LocalWorkerDeclaration {
  if (profile.transport.kind !== "openai_http") {
    const transport = profile.transport as WorkerProfileCliTransport;
    const command = stringValue(transport.command);
    return {
      id: profile.workerId,
      workerRole: profile.capabilities.roles[0] ?? "coding",
      endpointType: "local",
      provider: "custom",
      baseUrl: "cli://command",
      reasoning: profile.reasoning,
      ...(command ? { command } : {}),
      capabilities: normalizeWorkerCapabilities(profile.capabilities.roles),
      writeScope: profile.ceilings.writeScope,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  return {
    id: profile.workerId,
    workerRole: profile.capabilities.roles[0] ?? "coding",
    endpointType: "local",
    provider: normalizeProvider(profile.transport.provider ?? "lm-studio"),
    baseUrl: profile.transport.baseUrl,
    ...(stringValue(profile.transport.model)
      ? { model: stringValue(profile.transport.model) }
      : {}),
    ...(stringValue(profile.transport.preferModel) && !profile.transport.model
      ? { preferModel: stringValue(profile.transport.preferModel) }
      : {}),
    capabilities: normalizeWorkerCapabilities(profile.capabilities.roles),
    reasoning: profile.reasoning,
    writeScope: profile.ceilings.writeScope,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function resolveDefaultWorkerIdForWrite(input: {
  existing: LocalWorkersConfig | null;
  updatedWorkers: LocalWorkerDeclaration[];
  requestedWorkerId: string;
  optionsDefault?: boolean;
}): string {
  if (input.optionsDefault === false) {
    return (
      input.existing?.defaultWorkerId || input.updatedWorkers[0]?.id || input.requestedWorkerId
    );
  }
  if (input.existing?.workers.some((worker) => worker.id === input.requestedWorkerId)) {
    return input.requestedWorkerId;
  }
  return input.updatedWorkers[0]?.id || input.requestedWorkerId;
}

function writeWorkerRegistryIndex(defaultWorkerId: string): void {
  const index: WorkerRegistryIndex = {
    schemaVersion: WORKER_REGISTRY_INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    defaultWorkerId,
  };
  writeJsonFile(pathForWorkerRegistryIndex(), index);
}

function readWorkerRegistryDefaultWorkerId(): string | null {
  const index = readWorkerRegistryIndex();
  if (index?.defaultWorkerId) {
    return index.defaultWorkerId;
  }

  const legacy = readLegacyLocalWorkersConfig();
  return legacy?.defaultWorkerId ?? null;
}

function readWorkerRegistryIndex(): WorkerRegistryIndex | null {
  const filePath = pathForWorkerRegistryIndex();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = readJsonRecord(filePath);
  if (!parsed || parsed.schemaVersion !== WORKER_REGISTRY_INDEX_VERSION) {
    return null;
  }
  const defaultWorkerId = stringValue(parsed.defaultWorkerId);
  if (!defaultWorkerId) {
    return null;
  }
  return {
    schemaVersion: WORKER_REGISTRY_INDEX_VERSION,
    updatedAt: stringValue(parsed.updatedAt) ?? new Date(0).toISOString(),
    defaultWorkerId,
  };
}

function clearWorkerRegistryIndex(): void {
  const filePath = pathForWorkerRegistryIndex();
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
}

function upsertLocalAdaptiveRoutingPolicy(workerRole: string): string {
  const policyPath = pathForAdaptiveRoutingPolicy();
  const existing = readJsonRecord(policyPath) ?? {};
  const next = {
    ...existing,
    mode: stringValue(existing.mode) ?? "catalog",
    plannerRetainsReasoning: existing.plannerRetainsReasoning !== false,
    preferLocalWorkers: true,
    allowedEndpointTypes: uniqueStrings([
      ...normalizeStringList(existing.allowedEndpointTypes),
      "local",
      "cloud",
    ]),
    preferredEndpointTypes: uniqueStrings([
      "local",
      ...normalizeStringList(existing.preferredEndpointTypes),
    ]),
    allowedWorkerClasses: uniqueStrings([
      ...normalizeStringList(existing.allowedWorkerClasses),
      workerRole,
      "documentation",
      "tests",
      "review",
    ]),
    catalogLimit: typeof existing.catalogLimit === "number" ? existing.catalogLimit : 8,
  };
  writeJsonFile(policyPath, next);
  return policyPath;
}

function runOrchestratorLocalCatalog(options: {
  baseUrl: string;
  workerRole: string;
  capabilities: string[];
  writeScope: string[];
  model?: string;
  preferModel?: string;
}): unknown {
  const args = ["local-model-catalog", "--json", "--worker-role", options.workerRole];
  if (options.baseUrl) {
    args.push("--base-url", options.baseUrl);
  }
  for (const capability of options.capabilities) {
    args.push("--capability", capability);
  }
  for (const scope of options.writeScope) {
    args.push("--write-scope", scope);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.preferModel) {
    args.push("--prefer-model", options.preferModel);
  }

  try {
    const result = execFileSync("snipara-orchestrator", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    return result ? JSON.parse(result) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local worker probe failed: ${message}`);
  }
}

function resolveWorkerRegistryRoot(): string {
  return (
    findWorkspaceRoot(process.env.SNIPARA_WORKSPACE_DIR || process.cwd(), true) || process.cwd()
  );
}

function pathForWorkerRegistryDir(): string {
  return path.resolve(resolveWorkerRegistryRoot(), WORKER_REGISTRY_DIR_RELATIVE_PATH);
}

function pathForLegacyLocalWorkersConfig(): string {
  return path.resolve(resolveWorkerRegistryRoot(), LOCAL_WORKERS_RELATIVE_PATH);
}

function pathForWorkerRegistryIndex(): string {
  return path.resolve(resolveWorkerRegistryRoot(), WORKER_REGISTRY_INDEX_RELATIVE_PATH);
}

function pathForAdaptiveRoutingPolicy(): string {
  return path.resolve(resolveWorkerRegistryRoot(), ADAPTIVE_ROUTING_POLICY_RELATIVE_PATH);
}

function resolveContextWindowFromCatalog(
  catalog: unknown,
  explicitModel: string | undefined,
  preferredModel: string | undefined
): number | undefined {
  const payload = isRecord(catalog) ? catalog : {};
  const explicitModelLower = explicitModel?.toLowerCase();
  const preferredModelLower = preferredModel?.toLowerCase();
  const workerEndpoints = isRecord(payload["workerEndpoints"]) ? payload["workerEndpoints"] : {};
  const modelEntries = Array.isArray(payload.models) ? payload.models : [];

  const parsedEntries = Object.values(workerEndpoints)
    .map((entry): { model?: string; contextWindow: number | undefined } | null => {
      if (!isRecord(entry)) {
        return null;
      }
      const model = stringValue(entry.model);
      const contextWindow = coerceContextWindow(entry.contextWindow);
      if (contextWindow === undefined) {
        return null;
      }
      return {
        ...(model ? { model } : {}),
        contextWindow,
      };
    })
    .filter((entry): entry is { model?: string; contextWindow: number } => {
      if (entry === null) {
        return false;
      }
      const contextWindow = entry.contextWindow;
      return typeof contextWindow === "number" && contextWindow > 0;
    });

  let fallbackContextWindow: number | undefined;
  for (const entry of parsedEntries) {
    if (!entry.contextWindow) {
      continue;
    }
    if (fallbackContextWindow === undefined) {
      fallbackContextWindow = entry.contextWindow;
    }
    if (explicitModelLower && entry.model) {
      const loweredModel = entry.model.toLowerCase();
      if (loweredModel === explicitModelLower || loweredModel.includes(explicitModelLower)) {
        return entry.contextWindow;
      }
    }
    if (preferredModelLower && entry.model) {
      const loweredModel = entry.model.toLowerCase();
      if (loweredModel.includes(preferredModelLower)) {
        return entry.contextWindow;
      }
    }
  }
  if (fallbackContextWindow) {
    return fallbackContextWindow;
  }

  for (const item of modelEntries) {
    const model = isRecord(item) ? stringValue(item.id) : stringValue(item);
    const modelWindow = isRecord(item)
      ? coerceContextWindow(
          item.contextWindow ??
            item.context_length ??
            item.contextLength ??
            item.maxContext ??
            item.max_context ??
            item.max_tokens ??
            item.maxModelLen
        )
      : undefined;
    if (!modelWindow) {
      continue;
    }
    if (explicitModelLower && model) {
      const loweredModel = model.toLowerCase();
      if (loweredModel === explicitModelLower || loweredModel.includes(explicitModelLower)) {
        return modelWindow;
      }
    }
    if (preferredModelLower && model) {
      const loweredModel = model.toLowerCase();
      if (loweredModel.includes(preferredModelLower)) {
        return modelWindow;
      }
    }
    fallbackContextWindow = fallbackContextWindow ?? modelWindow;
  }

  return fallbackContextWindow;
}

function normalizeContextWindow(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_WORKER_CONTEXT_WINDOW;
}

function coerceContextWindow(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? Math.trunc(value) : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function transportIdentifierSeed(options: LocalWorkerAddOptions, role: string): string {
  if (options.transport === "cli" && stringValue(options.command)) {
    return stringValue(options.command) ?? "local-cli";
  }
  return (
    stringValue(options.model) ?? stringValue(options.preferModel) ?? `${options.provider}-${role}`
  );
}

function normalizeWorkerTransport(
  options: LocalWorkerAddOptions
): WorkerProfileOpenAITransport | WorkerProfileCliTransport {
  const transport = stringValue(options.transport) ?? "openai_http";
  if (transport === "cli") {
    const command = stringValue(options.command);
    if (!command) {
      throw new Error("CLI transport requires --command.");
    }
    return {
      kind: "cli",
      command,
    } as WorkerProfileCliTransport;
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:1234");
  const model = stringValue(options.model);
  const preferModel = stringValue(options.preferModel);
  return {
    kind: "openai_http",
    baseUrl,
    ...(model ? { model } : {}),
    ...(preferModel ? { preferModel } : {}),
    provider: normalizeProvider(stringValue(options.provider) ?? "lm-studio"),
  } as WorkerProfileOpenAITransport;
}

function normalizeProvider(value: string): string {
  const normalized = stringValue(value) ?? "lm-studio";
  return normalized.includes(" ") ? normalized.replace(/\s+/g, "-").toLowerCase() : normalized;
}

function normalizeLegacyWorkerDeclaration(value: unknown): LegacyLocalWorkerDeclaration | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringValue(value.id);
  const baseUrl = normalizeBaseUrl(stringValue(value.baseUrl) ?? "");
  if (!id || !baseUrl) {
    return null;
  }

  return {
    id,
    workerRole: normalizeWorkerRole(value.workerRole),
    endpointType: "local",
    provider: normalizeProvider(stringValue(value.provider) ?? "lm-studio"),
    baseUrl,
    ...(stringValue(value.model) ? { model: stringValue(value.model) } : {}),
    ...(stringValue(value.preferModel) ? { preferModel: stringValue(value.preferModel) } : {}),
    capabilities:
      normalizeStringList(value.capabilities).length > 0
        ? normalizeStringList(value.capabilities)
        : defaultCapabilitiesForWorker(normalizeWorkerRole(value.workerRole)),
    writeScope:
      normalizeStringList(value.writeScope).length > 0 ? normalizeStringList(value.writeScope) : [],
    createdAt: stringValue(value.createdAt) ?? new Date(0).toISOString(),
    updatedAt: stringValue(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function pathForWorkerFile(workerId: string): string {
  return path.join(pathForWorkerRegistryDir(), `${workerId}.json`);
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeWorkerId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.startsWith("local-") ? normalized : `local-${normalized || "worker"}`;
}

function normalizeWorkerRole(value: unknown): string {
  const normalized = stringValue(value)?.toLowerCase() ?? "coding";
  if (normalized === "testing") {
    return "tests";
  }
  return normalized || "coding";
}

function normalizeBaseUrl(value: string): string {
  const trimmed = stringValue(value) ?? "http://127.0.0.1:1234";
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local worker base URL must use http or https.");
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeWorkerProfileLanguages(value: string[]): string[] {
  return value.length > 0 ? value : ["typescript"];
}

function normalizeWorkerCapabilities(values: string[]): string[] {
  return values.length > 0
    ? uniqueStrings(values.map((value) => String(value).trim()).filter(Boolean))
    : ["code", "repo_scan", "refactor"];
}

function defaultCapabilitiesForWorker(workerRole: string): string[] {
  if (workerRole === "documentation") {
    return ["docs_write", "summarize", "structured_output"];
  }
  if (workerRole === "tests") {
    return ["test_write", "test_debug", "structured_output"];
  }
  if (workerRole === "review") {
    return ["code_review", "risk_review", "structured_output"];
  }
  return ["code", "refactor", "repo_scan", "structured_output"];
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return uniqueStrings(values.map(stringValue).filter((item): item is string => Boolean(item)));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const stringified = String(value).trim();
  return stringified || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printKeyValue(label: string, value: string | number): void {
  console.log(`${chalk.cyan(label)} ${value}`);
}
