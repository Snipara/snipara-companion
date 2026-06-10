import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLocalCodeOverlay,
  type LocalCodeOverlayManifest,
  type LocalCodeOverlaySymbol,
} from "./code";
import {
  createClient,
  type CollaborationActorPayload,
  type CollaborationActorType,
  type CollaborationGuardDecision,
  type CollaborationGuardResponse,
  type CollaborationLeaseMode,
  type CollaborationLeaseResponse,
  type CollaborationLeaseStatus,
  type CollaborationLeaseSummary,
  type CollaborationResource,
  type CollaborationResourceKind,
  type CollaborationSessionResponse,
  type CollaborationStateResponse,
} from "../api/client";
import { loadConfig, type RLMConfig } from "../config/store";

export const COLLABORATION_STATE_RELATIVE_PATH = path.join(
  ".snipara",
  "collaboration",
  "session.json"
);

const RESOURCE_KINDS = new Set<CollaborationResourceKind>([
  "FILE",
  "ROUTE",
  "SYMBOL",
  "SCHEMA",
  "PACKAGE",
  "DEPLOY",
  "SURFACE",
  "CUSTOM",
]);

const LEASE_MODES = new Set<CollaborationLeaseMode>([
  "WATCH",
  "ADVISORY",
  "REQUIRES_ACK",
  "EXCLUSIVE",
  "HARD_BLOCK",
]);

const DEFAULT_WATCH_INTERVAL_SECONDS = 15;
const DEFAULT_WATCH_HEARTBEAT_TTL_SECONDS = 300;
const DEFAULT_LOCAL_CODE_MAX_FILES = 2000;
const HOSTED_GUARD_MAX_FILES = 450;
const HOSTED_GUARD_MAX_RESOURCES = 850;
const HOSTED_GUARD_MAX_SYMBOL_RESOURCES = 160;
const HOOK_BLOCK_PREFIX = "snipara:collaboration-guard";

type CollaborationGuardProfile =
  | "edit"
  | "pre-commit"
  | "pre-push"
  | "pre-deploy"
  | "migration"
  | "schema"
  | "release-package";

interface CliCriticalSurface {
  id: string;
  label: string;
  patterns: RegExp[];
}

const CRITICAL_SURFACES: CliCriticalSurface[] = [
  {
    id: "auth",
    label: "Auth and access",
    patterns: [
      /(^|\/)(auth|oauth|sso|session|sessions|permission|permissions|middleware)(\/|\.|-|_)/i,
      /(^|\/)(login|security|tokens?)(\/|\.|-|_)/i,
    ],
  },
  {
    id: "billing",
    label: "Billing and plan limits",
    patterns: [
      /(^|\/)(billing|stripe|subscription|subscriptions|invoice|invoices)(\/|\.|-|_)/i,
      /(^|\/)(pricing|usage-limits?|plans?)(\/|\.|-|_)/i,
    ],
  },
  {
    id: "database",
    label: "Database and schema",
    patterns: [/(^|\/)(prisma|migrations?|schema|database|db)(\/|\.|-|_)/i, /schema\.prisma$/i],
  },
  {
    id: "deployment",
    label: "Deployment and infrastructure",
    patterns: [
      /(^|\/)(deploy|docker|traefik|infra|infrastructure|k8s|terraform)(\/|\.|-|_)/i,
      /(^|\/)\.github\/workflows\//i,
    ],
  },
  {
    id: "mcp",
    label: "MCP contract",
    patterns: [
      /(^|\/)(mcp|mcp-server|snipara-mcp)(\/|\.|-|_)/i,
      /(tool-contract|tool_contract|mcp-tools)/i,
    ],
  },
  {
    id: "memory",
    label: "Memory and context persistence",
    patterns: [
      /(^|\/)(memory|memories|recall|remember|context-persistence)(\/|\.|-|_)/i,
      /(^|\/|[-_])memory(\/|\.|-|_)/i,
      /(memory-v2|session-context|shared-context)/i,
    ],
  },
];

interface HostedAttempt<T> {
  status: "skipped" | "ok" | "error";
  data?: T;
  error?: string;
}

interface CollaborationCommandOptions {
  summary?: string;
  files?: string[];
  resources?: string[];
  actor?: string;
  actorId?: string;
  actorType?: string;
  sessionId?: string;
  workSessionId?: string;
  swarmId?: string;
  client?: string;
  repository?: string;
  branch?: string;
  worktree?: string;
  action?: string;
  profile?: string;
  mode?: string;
  reason?: string;
  ttlSeconds?: string;
  heartbeatTtlSeconds?: string;
  intervalSeconds?: string;
  maxFiles?: string;
  leaseId?: string;
  all?: boolean;
  once?: boolean;
  autoClaim?: boolean;
  releaseStale?: boolean;
  persist?: boolean;
  enforce?: boolean;
  dir?: string;
  json?: boolean;
}

interface CollaborationHooksInstallOptions {
  dir?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface CollaborationLocalLeaseRecord {
  id: string;
  mode: CollaborationLeaseMode;
  status: CollaborationLeaseStatus;
  resources: CollaborationResource[];
  reason?: string;
  claimedAt?: string;
  expiresAt?: string | null;
}

export interface CollaborationLocalState {
  schemaVersion: "snipara.collaboration.v1";
  updatedAt: string;
  workSessionId?: string;
  sessionId?: string;
  actorId?: string;
  actorType?: CollaborationActorType;
  actorLabel?: string;
  client?: string;
  repository?: string;
  branch?: string;
  worktree?: string;
  task?: string;
  files: string[];
  resources: CollaborationResource[];
  leases: CollaborationLocalLeaseRecord[];
  lastGuard?: {
    decision: CollaborationGuardDecision;
    severity: string;
    checkedAt: string;
    action: string;
    resources: CollaborationResource[];
    conflictCount: number;
  };
}

interface ResolvedCollaborationContext {
  rootDir: string;
  config: RLMConfig;
  actor: Required<Pick<CollaborationActorPayload, "actorId" | "actorType" | "actorLabel">> & {
    sessionId?: string;
  };
  client: string;
  branch?: string;
  repository?: string;
  worktree?: string;
}

export function createEmptyCollaborationState(now = new Date()): CollaborationLocalState {
  return {
    schemaVersion: "snipara.collaboration.v1",
    updatedAt: now.toISOString(),
    files: [],
    resources: [],
    leases: [],
  };
}

export function getCollaborationStatePath(rootDir = process.cwd()): string {
  return path.join(rootDir, COLLABORATION_STATE_RELATIVE_PATH);
}

export function loadCollaborationState(rootDir = process.cwd()): CollaborationLocalState {
  const statePath = getCollaborationStatePath(rootDir);
  if (!fs.existsSync(statePath)) {
    return createEmptyCollaborationState();
  }

  let parsed: Partial<CollaborationLocalState>;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<CollaborationLocalState>;
  } catch {
    return createEmptyCollaborationState();
  }
  return {
    schemaVersion: "snipara.collaboration.v1",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    workSessionId: normalizeOptionalString(parsed.workSessionId),
    sessionId: normalizeOptionalString(parsed.sessionId),
    actorId: normalizeOptionalString(parsed.actorId),
    actorType: normalizeActorType(parsed.actorType),
    actorLabel: normalizeOptionalString(parsed.actorLabel),
    client: normalizeOptionalString(parsed.client),
    repository: normalizeOptionalString(parsed.repository),
    branch: normalizeOptionalString(parsed.branch),
    worktree: normalizeOptionalString(parsed.worktree),
    task: normalizeOptionalString(parsed.task),
    files: normalizeFiles(parsed.files),
    resources: normalizeResources(parsed.resources),
    leases: normalizeLocalLeases(parsed.leases),
    lastGuard: normalizeLastGuard(parsed.lastGuard),
  };
}

export function saveCollaborationState(
  state: CollaborationLocalState,
  rootDir = process.cwd()
): void {
  const statePath = getCollaborationStatePath(rootDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, statePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export function buildCollaborationActor(
  options: Pick<
    CollaborationCommandOptions,
    "actor" | "actorId" | "actorType" | "sessionId" | "client"
  >,
  config: RLMConfig
): ResolvedCollaborationContext["actor"] {
  const username = safeUsername();
  const hostname = os.hostname();
  const sessionId =
    normalizeOptionalString(options.sessionId) ?? normalizeOptionalString(config.sessionId);
  const client = normalizeOptionalString(options.client) ?? normalizeOptionalString(config.client);
  const actorType = normalizeActorType(options.actorType) ?? "AGENT";
  const actorId =
    normalizeOptionalString(options.actorId) ??
    normalizeOptionalString(process.env.SNIPARA_AGENT_ID) ??
    sessionId ??
    `${client ?? "snipara-companion"}:${username}@${hostname}`;
  const actorLabel =
    normalizeOptionalString(options.actor) ??
    normalizeOptionalString(process.env.SNIPARA_ACTOR_LABEL) ??
    `${client ?? "snipara-companion"} ${username}@${hostname}`;

  return {
    actorId,
    actorType,
    actorLabel,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function normalizeCollaborationFiles(files: string[] | undefined): string[] {
  return normalizeFiles(files);
}

export function parseCollaborationResources(values: string[] | undefined): CollaborationResource[] {
  return normalizeResources(
    (values ?? []).map((value) => {
      const separatorIndex = value.indexOf(":");
      if (separatorIndex <= 0) {
        throw new Error(`Resource must use KIND:id format: ${value}`);
      }

      const kind = normalizeResourceKind(value.slice(0, separatorIndex));
      if (!kind) {
        throw new Error(
          `Unsupported collaboration resource kind: ${value.slice(0, separatorIndex)}`
        );
      }

      const id = value.slice(separatorIndex + 1).trim();
      if (!id) {
        throw new Error(`Resource id is required for ${kind}`);
      }

      return {
        kind,
        id,
      };
    })
  );
}

export function deriveLocalCollaborationResourcesFromFiles(
  files: string[] | undefined,
  rootDir = process.cwd(),
  maxFiles = DEFAULT_LOCAL_CODE_MAX_FILES
): CollaborationResource[] {
  const normalizedFiles = normalizeFiles(files);
  const resources: CollaborationResource[] = [];
  const selectedFiles = new Set(normalizedFiles);

  for (const file of normalizedFiles) {
    resources.push({ kind: "FILE", id: file, label: file, sourcePath: file });

    const route = deriveNextRouteResource(file);
    if (route) {
      resources.push(route);
    }

    const packageResource = derivePackageResource(file);
    if (packageResource) {
      resources.push(packageResource);
    }

    const moduleResource = deriveModuleSymbolResource(file);
    if (moduleResource) {
      resources.push(moduleResource);
    }

    const testSurface = deriveTestSurfaceResource(file);
    if (testSurface) {
      resources.push(testSurface);
    }

    if (isPrismaSchemaPath(file)) {
      resources.push({
        kind: "SCHEMA",
        id: "prisma:tenant_snipara",
        label: "Prisma tenant_snipara schema",
        sourcePath: file,
      });
    }

    if (isDeploymentPath(file)) {
      resources.push({
        kind: "DEPLOY",
        id: "production-deployment",
        label: "Production deployment",
        sourcePath: file,
      });
    }

    for (const surface of classifyCriticalSurfaces(file)) {
      resources.push({
        kind: "SURFACE",
        id: surface.id,
        label: surface.label,
        sourcePath: file,
      });
    }
  }

  for (const symbol of readLocalOverlaySymbols(rootDir, maxFiles)) {
    if (!selectedFiles.has(normalizeRepoPath(symbol.filePath))) {
      continue;
    }
    resources.push({
      kind: "SYMBOL",
      id: `${symbol.kind}:${symbol.name}@${normalizeRepoPath(symbol.filePath)}:${symbol.line}`,
      label: `${symbol.name} (${normalizeRepoPath(symbol.filePath)}:${symbol.line})`,
      sourcePath: normalizeRepoPath(symbol.filePath),
    });
  }

  return normalizeResources(resources);
}

export async function collaborationStartCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const files = resolveCommandFiles(context.rootDir, options, true);
  const resources = resolveCommandResources(context, files, options);
  const task = normalizeOptionalString(options.summary) ?? state.task;
  const heartbeatTtlSeconds = parsePositiveInteger(options.heartbeatTtlSeconds, "heartbeat ttl");
  const hosted = await maybeStartHostedSession(context, {
    workSessionId: options.workSessionId ?? state.workSessionId,
    swarmId: options.swarmId,
    task,
    heartbeatTtlSeconds,
    files,
    resources,
  });
  const session = hosted.status === "ok" ? hosted.data?.session : undefined;
  const now = new Date().toISOString();

  Object.assign(state, {
    updatedAt: now,
    workSessionId:
      session?.id ??
      options.workSessionId ??
      state.workSessionId ??
      buildLocalSessionId(context, task, files),
    sessionId: context.actor.sessionId ?? state.sessionId,
    actorId: context.actor.actorId,
    actorType: context.actor.actorType,
    actorLabel: context.actor.actorLabel,
    client: context.client,
    repository: context.repository,
    branch: context.branch,
    worktree: context.worktree,
    task,
    files,
    resources: hosted.status === "ok" ? (hosted.data?.resources ?? resources) : resources,
  });
  saveCollaborationState(state, context.rootDir);

  printCollaborationResult(
    {
      action: "start",
      statePath: getCollaborationStatePath(context.rootDir),
      state,
      hosted,
    },
    options.json
  );
}

export async function collaborationClaimCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const files = resolveCommandFiles(context.rootDir, options, false);
  const resources = resolveCommandResources(context, files, options);
  ensureFilesOrResources(files, resources, "claim");
  const mode = normalizeLeaseMode(options.mode) ?? "ADVISORY";
  const ttlSeconds = parsePositiveInteger(options.ttlSeconds, "ttl seconds");
  const workSessionId = await ensureWorkSession(context, state, options, files);
  const hosted = await maybeCreateHostedLeases(context, {
    workSessionId,
    swarmId: options.swarmId,
    files,
    resources,
    mode,
    reason: options.reason,
    ttlSeconds,
  });
  const now = new Date().toISOString();

  if (hosted.status === "ok") {
    mergeLocalLeaseState(state, hosted.data?.leases ?? [], hosted.data?.resources ?? resources);
  }
  state.updatedAt = now;
  state.files = mergeStrings(state.files, files);
  state.resources = mergeResources(
    state.resources,
    hosted.status === "ok" ? (hosted.data?.resources ?? resources) : resources
  );
  saveCollaborationState(state, context.rootDir);

  if (hosted.status !== "ok") {
    process.exitCode = 2;
  }

  printCollaborationResult(
    {
      action: "claim",
      statePath: getCollaborationStatePath(context.rootDir),
      state,
      hosted,
    },
    options.json
  );
}

export async function collaborationGuardCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const profile = normalizeGuardProfile(options.profile) ?? "edit";
  const files = resolveGuardFiles(context, options, profile);
  const resources = resolveCommandResources(context, files, options, profile);
  ensureFilesOrResources(files, resources, "guard");
  const hostedPayload = buildHostedGuardPayload(files, resources);
  const hosted = await maybeEvaluateHostedGuard(context, {
    workSessionId: options.workSessionId ?? state.workSessionId,
    action: normalizeOptionalString(options.action) ?? profile,
    files: hostedPayload.files,
    resources: hostedPayload.resources,
    persist: options.persist !== false,
  });
  const evaluation = hosted.status === "ok" ? hosted.data?.evaluation : undefined;

  if (evaluation) {
    state.updatedAt = evaluation.evaluatedAt;
    state.lastGuard = {
      decision: evaluation.decision,
      severity: evaluation.severity,
      checkedAt: evaluation.evaluatedAt,
      action: normalizeOptionalString(options.action) ?? profile,
      resources: evaluation.resources,
      conflictCount: evaluation.conflicts.length,
    };
    state.files = mergeStrings(state.files, files);
    state.resources = mergeResources(state.resources, evaluation.resources);
    saveCollaborationState(state, context.rootDir);
  }

  if (hosted.status !== "ok" || shouldFailGuard(evaluation?.decision, Boolean(options.enforce))) {
    process.exitCode = 2;
  }

  printCollaborationResult(
    {
      action: "guard",
      statePath: getCollaborationStatePath(context.rootDir),
      state,
      hosted,
    },
    options.json
  );
}

export function buildCollaborationHooksInstallPlan(
  options: CollaborationHooksInstallOptions = {}
): Record<string, unknown> {
  const repoRoot = resolveRepoRoot(options.dir ?? process.cwd());
  const hooks = [
    installManagedCollaborationGitHook(repoRoot, "pre-commit", options),
    installManagedCollaborationGitHook(repoRoot, "pre-push", options),
  ];
  return {
    repoRoot,
    hooks: hooks.map((hook) => ({
      hook: hook.hook,
      path: hook.path,
      action: hook.action,
    })),
    dryRun: Boolean(options.dryRun),
    mode: "blocking",
  };
}

export async function collaborationHooksInstallCommand(
  options: CollaborationHooksInstallOptions
): Promise<void> {
  const result = buildCollaborationHooksInstallPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Collaboration Guard Git Hooks");
  for (const hook of result.hooks as Array<{ hook: string; path: string; action: string }>) {
    console.log(`${hook.hook}: ${hook.action} (${hook.path})`);
  }
  console.log("Mode: blocking");
}

export async function collaborationWatchCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  let state = loadCollaborationState(context.rootDir);
  const intervalSeconds =
    parsePositiveInteger(options.intervalSeconds, "interval seconds") ??
    DEFAULT_WATCH_INTERVAL_SECONDS;
  const heartbeatTtlSeconds =
    parsePositiveInteger(options.heartbeatTtlSeconds, "heartbeat ttl") ??
    DEFAULT_WATCH_HEARTBEAT_TTL_SECONDS;
  const ttlSeconds = parsePositiveInteger(options.ttlSeconds, "ttl seconds") ?? heartbeatTtlSeconds;
  const mode = normalizeLeaseMode(options.mode) ?? "WATCH";
  const autoClaim = options.autoClaim !== false;
  const releaseStale = options.releaseStale !== false;
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const result = await runCollaborationWatchTick(context, state, {
      ...options,
      heartbeatTtlSeconds: String(heartbeatTtlSeconds),
      ttlSeconds: String(ttlSeconds),
      mode,
      autoClaim,
      releaseStale,
    });
    state = result.state;
    printCollaborationResult(
      {
        action: "watch",
        statePath: getCollaborationStatePath(context.rootDir),
        state,
        hosted: result.sessionHosted,
        watch: {
          files: result.files,
          resources: result.resources,
          autoClaim,
          releaseStale,
          claimHosted: result.claimHosted,
          heartbeatHosted: result.heartbeatHosted,
          releaseHosted: result.releaseHosted,
        },
      },
      options.json
    );

    if (options.once || stopping) {
      break;
    }
    await sleep(intervalSeconds * 1000);
  } while (!stopping);
}

export async function collaborationReleaseCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const leaseIds = resolveReleaseLeaseIds(state, options);
  const hosted = await releaseHostedLeases(context, leaseIds, {
    reason: options.reason,
  });
  const released = hosted.status === "ok" ? (hosted.data ?? []) : [];
  const releasedIds = new Set(released.map((lease) => lease.lease.id));
  const now = new Date().toISOString();

  for (const lease of state.leases) {
    if (releasedIds.has(lease.id) || (hosted.status !== "ok" && leaseIds.includes(lease.id))) {
      lease.status = "RELEASED";
    }
  }
  state.updatedAt = now;
  saveCollaborationState(state, context.rootDir);

  if (hosted.status !== "ok") {
    process.exitCode = 2;
  }

  printCollaborationResult(
    {
      action: "release",
      statePath: getCollaborationStatePath(context.rootDir),
      state,
      hosted,
    },
    options.json
  );
}

export async function collaborationStatusCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const hosted = await maybeGetHostedState(context);

  printCollaborationResult(
    {
      action: "status",
      statePath: getCollaborationStatePath(context.rootDir),
      state,
      hosted,
    },
    options.json
  );
}

export async function collaborationIdeStatusCommand(
  options: CollaborationCommandOptions
): Promise<void> {
  const context = resolveCollaborationContext(options);
  const state = loadCollaborationState(context.rootDir);
  const hosted = await maybeGetHostedState(context);
  const hostedData = hosted.status === "ok" ? hosted.data : undefined;
  const payload = {
    version: "snipara.collaboration.ide-status.v1",
    generatedAt: new Date().toISOString(),
    repository: context.repository ?? state.repository ?? null,
    branch: context.branch ?? state.branch ?? null,
    local: {
      workSessionId: state.workSessionId ?? null,
      actorId: state.actorId ?? null,
      actorType: state.actorType ?? null,
      actorLabel: state.actorLabel ?? null,
      files: state.files,
      resources: state.resources,
      activeLeases: state.leases.filter((lease) => lease.status === "ACTIVE"),
      lastGuard: state.lastGuard ?? null,
    },
    hosted: {
      status: hosted.status,
      error: hosted.error,
      activeSessions: hostedData?.sessions ?? [],
      activeLeases: hostedData?.leases ?? [],
      recentEvents: hostedData?.events ?? [],
    },
  };

  if (options.json !== false) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Collaboration IDE status");
  console.log(`Repository: ${payload.repository ?? "unknown"}`);
  console.log(`Branch: ${payload.branch ?? "unknown"}`);
  console.log(`Hosted: ${hosted.status}`);
  console.log(`Active sessions: ${payload.hosted.activeSessions.length}`);
  console.log(`Active leases: ${payload.hosted.activeLeases.length}`);
}

function resolveCollaborationContext(
  options: CollaborationCommandOptions
): ResolvedCollaborationContext {
  const rootDir = path.resolve(options.dir ?? process.cwd());
  const config = loadConfig({ cwd: rootDir });
  const actor = buildCollaborationActor(options, config);
  return {
    rootDir,
    config,
    actor,
    client:
      normalizeOptionalString(options.client) ??
      normalizeOptionalString(config.client) ??
      "snipara-companion",
    branch:
      normalizeOptionalString(options.branch) ??
      readGitValue(rootDir, ["branch", "--show-current"]),
    repository: normalizeOptionalString(options.repository) ?? readRepositoryId(rootDir),
    worktree: normalizeOptionalString(options.worktree) ?? rootDir,
  };
}

async function ensureWorkSession(
  context: ResolvedCollaborationContext,
  state: CollaborationLocalState,
  options: CollaborationCommandOptions,
  files: string[]
): Promise<string> {
  if (options.workSessionId || state.workSessionId) {
    return options.workSessionId ?? state.workSessionId ?? "";
  }

  const hosted = await maybeStartHostedSession(context, {
    task:
      normalizeOptionalString(options.summary) ??
      normalizeOptionalString(options.reason) ??
      state.task ??
      "Collaboration claim",
    files,
  });

  const workSessionId =
    hosted.status === "ok"
      ? hosted.data?.session.id
      : buildLocalSessionId(context, normalizeOptionalString(options.reason), files);
  const now = new Date().toISOString();
  Object.assign(state, {
    updatedAt: now,
    workSessionId,
    sessionId: context.actor.sessionId ?? state.sessionId,
    actorId: context.actor.actorId,
    actorType: context.actor.actorType,
    actorLabel: context.actor.actorLabel,
    client: context.client,
    repository: context.repository,
    branch: context.branch,
    worktree: context.worktree,
  });
  saveCollaborationState(state, context.rootDir);

  return workSessionId ?? "";
}

function createHostedClient(context: ResolvedCollaborationContext) {
  if (!context.config.apiKey) {
    return null;
  }
  return createClient(15000, { cwd: context.rootDir });
}

async function maybeStartHostedSession(
  context: ResolvedCollaborationContext,
  input: {
    workSessionId?: string;
    swarmId?: string;
    task?: string;
    heartbeatTtlSeconds?: number;
    files?: string[];
    resources?: CollaborationResource[];
  }
): Promise<HostedAttempt<CollaborationSessionResponse>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    return {
      status: "ok",
      data: await client.startCollaborationSession({
        ...context.actor,
        workSessionId: input.workSessionId,
        swarmId: input.swarmId,
        client: context.client,
        repository: context.repository,
        branch: context.branch,
        worktree: context.worktree,
        task: input.task,
        heartbeatTtlSeconds: input.heartbeatTtlSeconds,
        files: input.files,
        resources: input.resources,
        metadata: input.resources?.length ? { resources: input.resources } : undefined,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function maybeCreateHostedLeases(
  context: ResolvedCollaborationContext,
  input: {
    workSessionId?: string;
    swarmId?: string;
    mode: CollaborationLeaseMode;
    reason?: string;
    ttlSeconds?: number;
    files: string[];
    resources: CollaborationResource[];
  }
): Promise<HostedAttempt<CollaborationLeaseResponse>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    return {
      status: "ok",
      data: await client.createCollaborationLeases({
        ...context.actor,
        workSessionId: input.workSessionId,
        swarmId: input.swarmId,
        mode: input.mode,
        reason: input.reason,
        ttlSeconds: input.ttlSeconds,
        files: input.files,
        resources: input.resources,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function maybeEvaluateHostedGuard(
  context: ResolvedCollaborationContext,
  input: {
    workSessionId?: string;
    action: string;
    persist: boolean;
    files: string[];
    resources: CollaborationResource[];
  }
): Promise<HostedAttempt<CollaborationGuardResponse>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    return {
      status: "ok",
      data: await client.evaluateCollaborationGuard({
        ...context.actor,
        workSessionId: input.workSessionId,
        action: input.action,
        files: input.files,
        resources: input.resources,
        persist: input.persist,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function maybeGetHostedState(
  context: ResolvedCollaborationContext
): Promise<HostedAttempt<CollaborationStateResponse>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    return {
      status: "ok",
      data: await client.getCollaborationState(),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function heartbeatHostedLeases(
  context: ResolvedCollaborationContext,
  leaseIds: string[]
): Promise<HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    const data = await Promise.all(
      leaseIds.map((leaseId) => client.updateCollaborationLease(leaseId, { action: "heartbeat" }))
    );
    return { status: "ok", data };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function releaseHostedLeases(
  context: ResolvedCollaborationContext,
  leaseIds: string[],
  input: { reason?: string }
): Promise<HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>>> {
  const client = createHostedClient(context);
  if (!client) {
    return { status: "skipped" };
  }

  try {
    const data = await Promise.all(
      leaseIds.map((leaseId) =>
        client.updateCollaborationLease(leaseId, {
          action: "release",
          reason: input.reason,
        })
      )
    );
    return { status: "ok", data };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function runCollaborationWatchTick(
  context: ResolvedCollaborationContext,
  state: CollaborationLocalState,
  options: CollaborationCommandOptions
): Promise<{
  state: CollaborationLocalState;
  files: string[];
  resources: CollaborationResource[];
  sessionHosted: HostedAttempt<CollaborationSessionResponse>;
  claimHosted: HostedAttempt<CollaborationLeaseResponse>;
  heartbeatHosted: HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>>;
  releaseHosted: HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>>;
}> {
  const files = resolveCommandFiles(context.rootDir, options, true);
  const resources = resolveCommandResources(context, files, options);
  const task = normalizeOptionalString(options.summary) ?? state.task ?? "Collaboration watch";
  const heartbeatTtlSeconds =
    parsePositiveInteger(options.heartbeatTtlSeconds, "heartbeat ttl") ??
    DEFAULT_WATCH_HEARTBEAT_TTL_SECONDS;
  const ttlSeconds = parsePositiveInteger(options.ttlSeconds, "ttl seconds") ?? heartbeatTtlSeconds;
  const mode = normalizeLeaseMode(options.mode) ?? "WATCH";
  const sessionHosted = await maybeStartHostedSession(context, {
    workSessionId: options.workSessionId ?? state.workSessionId,
    swarmId: options.swarmId,
    task,
    heartbeatTtlSeconds,
    files,
    resources,
  });
  const session = sessionHosted.status === "ok" ? sessionHosted.data?.session : undefined;
  const now = new Date().toISOString();
  const workSessionId =
    session?.id ??
    options.workSessionId ??
    state.workSessionId ??
    buildLocalSessionId(context, task, files);

  Object.assign(state, {
    updatedAt: now,
    workSessionId,
    sessionId: context.actor.sessionId ?? state.sessionId,
    actorId: context.actor.actorId,
    actorType: context.actor.actorType,
    actorLabel: context.actor.actorLabel,
    client: context.client,
    repository: context.repository,
    branch: context.branch,
    worktree: context.worktree,
    task,
    files,
    resources:
      sessionHosted.status === "ok" ? (sessionHosted.data?.resources ?? resources) : resources,
  });

  let heartbeatHosted: HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>> = {
    status: "skipped",
  };
  let claimHosted: HostedAttempt<CollaborationLeaseResponse> = { status: "skipped" };
  let releaseHosted: HostedAttempt<Array<{ lease: CollaborationLeaseSummary }>> = {
    status: "skipped",
  };

  if (options.autoClaim !== false && resources.length > 0) {
    const targetKeys = new Set(resources.map(localResourceKey));
    const activeLeases = state.leases.filter((lease) => lease.status === "ACTIVE");
    const matchingActiveLeases = activeLeases.filter((lease) =>
      lease.resources.some((resource) => targetKeys.has(localResourceKey(resource)))
    );
    const staleActiveLeases = activeLeases.filter(
      (lease) => !lease.resources.some((resource) => targetKeys.has(localResourceKey(resource)))
    );
    const claimedKeys = new Set(
      matchingActiveLeases.flatMap((lease) => lease.resources.map(localResourceKey))
    );
    const missingResources = resources.filter(
      (resource) => !claimedKeys.has(localResourceKey(resource))
    );

    if (matchingActiveLeases.length > 0) {
      heartbeatHosted = await heartbeatHostedLeases(
        context,
        matchingActiveLeases.map((lease) => lease.id)
      );
    }

    if (missingResources.length > 0) {
      claimHosted = await maybeCreateHostedLeases(context, {
        workSessionId,
        swarmId: options.swarmId,
        files: [],
        resources: missingResources,
        mode,
        reason: options.reason ?? `auto-claim ${task}`,
        ttlSeconds,
      });
      if (claimHosted.status === "ok") {
        mergeLocalLeaseState(
          state,
          claimHosted.data?.leases ?? [],
          claimHosted.data?.resources ?? missingResources
        );
      }
    }

    if (options.releaseStale !== false && staleActiveLeases.length > 0) {
      releaseHosted = await releaseHostedLeases(
        context,
        staleActiveLeases.map((lease) => lease.id),
        { reason: "Released by collaboration watch because the resource is no longer active." }
      );
      const releasedIds = new Set(
        releaseHosted.status === "ok"
          ? (releaseHosted.data ?? []).map((item) => item.lease.id)
          : staleActiveLeases.map((lease) => lease.id)
      );
      for (const lease of state.leases) {
        if (releasedIds.has(lease.id)) {
          lease.status = "RELEASED";
        }
      }
    }
  }

  state.updatedAt = new Date().toISOString();
  saveCollaborationState(state, context.rootDir);
  return {
    state,
    files,
    resources,
    sessionHosted,
    claimHosted,
    heartbeatHosted,
    releaseHosted,
  };
}

function resolveCommandFiles(
  rootDir: string,
  options: CollaborationCommandOptions,
  includeDirtyDefault: boolean
): string[] {
  const explicit = normalizeFiles(options.files);
  if (explicit.length > 0) {
    return explicit;
  }
  return includeDirtyDefault ? readGitDirtyFiles(rootDir) : [];
}

function resolveCommandResources(
  context: ResolvedCollaborationContext,
  files: string[],
  options: Pick<CollaborationCommandOptions, "resources" | "maxFiles">,
  profile: CollaborationGuardProfile = "edit"
): CollaborationResource[] {
  const explicit = parseCollaborationResources(options.resources);
  const maxFiles =
    parsePositiveInteger(options.maxFiles, "max files") ?? DEFAULT_LOCAL_CODE_MAX_FILES;
  return normalizeResources([
    ...explicit,
    ...deriveLocalCollaborationResourcesFromFiles(files, context.rootDir, maxFiles),
    ...deriveContextResources(context),
    ...deriveGuardProfileResources(profile, files),
  ]);
}

function resolveGuardFiles(
  context: ResolvedCollaborationContext,
  options: CollaborationCommandOptions,
  profile: CollaborationGuardProfile
): string[] {
  const explicit = normalizeFiles(options.files);
  if (explicit.length > 0) {
    return explicit;
  }
  const dirtyFiles = readGitDirtyFiles(context.rootDir);
  if (dirtyFiles.length > 0) {
    return dirtyFiles;
  }
  if (profile === "pre-push") {
    return readGitPrePushFiles(context.rootDir);
  }
  if (profile === "pre-deploy") {
    return ["deploy/infomaniak/deploy-zero-downtime.sh"];
  }
  if (profile === "migration" || profile === "schema") {
    return [
      "packages/database/prisma/schema.prisma",
      "apps/mcp-server/prisma/schema.prisma",
      "snipara-fastapi/prisma/schema.prisma",
      "packages/create-snipara/snipara-server/prisma/schema.prisma",
    ];
  }
  if (profile === "release-package") {
    return readGitChangedFiles(context.rootDir, ["diff", "--name-only", "HEAD~1..HEAD"]).filter(
      (file) => file.endsWith("package.json") || file.includes("/package.json")
    );
  }
  return [];
}

function readGitPrePushFiles(rootDir: string): string[] {
  const upstream = readGitValue(rootDir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upstream) {
    const upstreamFiles = readGitChangedFiles(rootDir, [
      "diff",
      "--name-only",
      `${upstream}...HEAD`,
    ]);
    if (upstreamFiles.length > 0) {
      return upstreamFiles;
    }
  }
  const headFiles = readGitChangedFiles(rootDir, ["diff", "--name-only", "HEAD~1..HEAD"]);
  return headFiles.length > 0
    ? headFiles
    : readGitChangedFiles(rootDir, ["show", "--name-only", "--format=", "HEAD"]);
}

function readGitChangedFiles(rootDir: string, args: string[]): string[] {
  const output = readGitValue(rootDir, args);
  return output ? normalizeFiles(output.split(/\r?\n/)) : [];
}

function resolveRepoRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  const gitRoot = readGitValue(resolved, ["rev-parse", "--show-toplevel"]);
  return gitRoot ? path.resolve(gitRoot) : resolved;
}

function deriveGuardProfileResources(
  profile: CollaborationGuardProfile,
  files: string[]
): CollaborationResource[] {
  const resources: CollaborationResource[] = [];
  if (profile === "pre-deploy") {
    resources.push(
      { kind: "DEPLOY", id: "production-deployment", label: "Production deployment" },
      { kind: "SURFACE", id: "deployment", label: "Deployment and infrastructure" }
    );
  }
  if (profile === "migration" || profile === "schema") {
    resources.push(
      { kind: "SCHEMA", id: "prisma:tenant_snipara", label: "Prisma tenant_snipara schema" },
      { kind: "SURFACE", id: "database", label: "Database and schema" }
    );
  }
  if (profile === "release-package") {
    resources.push({ kind: "SURFACE", id: "release-package", label: "Package release surface" });
  }
  if (profile === "pre-commit" || profile === "pre-push") {
    if (files.some(isPrismaSchemaPath)) {
      resources.push(
        { kind: "SCHEMA", id: "prisma:tenant_snipara", label: "Prisma tenant_snipara schema" },
        { kind: "SURFACE", id: "database", label: "Database and schema" }
      );
    }
    if (files.some(isDeploymentPath)) {
      resources.push(
        { kind: "DEPLOY", id: "production-deployment", label: "Production deployment" },
        { kind: "SURFACE", id: "deployment", label: "Deployment and infrastructure" }
      );
    }
    if (files.some((file) => file.endsWith("package.json") || file.includes("/package.json"))) {
      resources.push({
        kind: "SURFACE",
        id: "release-package",
        label: "Package release surface",
      });
    }
  }
  return resources;
}

function deriveContextResources(context: ResolvedCollaborationContext): CollaborationResource[] {
  const resources: CollaborationResource[] = [];
  if (context.repository && context.branch) {
    resources.push({
      kind: "SURFACE",
      id: `branch:${context.repository}:${context.branch}`,
      label: `Branch ${context.repository}:${context.branch}`,
    });
  } else if (context.branch) {
    resources.push({
      kind: "SURFACE",
      id: `branch:${context.branch}`,
      label: `Branch ${context.branch}`,
    });
  }
  const pullRequestId = normalizeOptionalString(process.env.GITHUB_REF_NAME)?.match(
    /^(\d+)\/merge$/
  )
    ? normalizeOptionalString(process.env.GITHUB_REF_NAME)
    : (normalizeOptionalString(process.env.GITHUB_PR_NUMBER) ??
      normalizeOptionalString(process.env.PR_NUMBER));
  if (context.repository && pullRequestId) {
    resources.push({
      kind: "SURFACE",
      id: `pr:${context.repository}:${pullRequestId}`,
      label: `PR ${context.repository}#${pullRequestId}`,
    });
  }
  return resources;
}

function readGitDirtyFiles(rootDir: string): string[] {
  const status = readGitRawValue(rootDir, ["status", "--porcelain=v1", "-z"]);
  if (!status) {
    return [];
  }

  return normalizeFiles(parseGitPorcelainZ(status));
}

function parseGitPorcelainZ(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const files: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return files;
}

function deriveNextRouteResource(filePath: string): CollaborationResource | null {
  const appRouterMatch = filePath.match(
    /^apps\/web\/src\/app\/(.+)\/(route|page|layout)\.(ts|tsx)$/
  );
  if (!appRouterMatch) {
    return null;
  }

  const route = appRouterMatch[1]
    .split("/")
    .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("@"))
    .map(normalizeRouteSegment)
    .join("/");
  const routePath = `/${route}`.replace(/\/+/g, "/");
  return {
    kind: "ROUTE",
    id: routePath === "/" ? "/" : routePath.replace(/\/$/, ""),
    label: routePath,
    sourcePath: filePath,
  };
}

function normalizeRouteSegment(segment: string): string {
  const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) {
    return `:${optionalCatchAll[1]}*`;
  }
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) {
    return `:${catchAll[1]}*`;
  }
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) {
    return `:${dynamic[1]}`;
  }
  return segment;
}

function derivePackageResource(filePath: string): CollaborationResource | null {
  const packageId = filePath.startsWith("packages/cli/")
    ? "snipara-companion"
    : filePath.startsWith("packages/create-snipara/")
      ? "create-snipara"
      : filePath.startsWith("packages/database/")
        ? "snipara-database"
        : filePath.startsWith("packages/snipara-openclaw-install/")
          ? "snipara-openclaw-install"
          : filePath.startsWith("packages/snipara-openclaw-hooks/")
            ? "snipara-openclaw-hooks"
            : filePath.startsWith("apps/mcp-server/snipara-mcp/")
              ? "snipara-mcp"
              : filePath.startsWith("apps/mcp-server/") || filePath.startsWith("snipara-fastapi/")
                ? "snipara-mcp-server"
                : filePath.startsWith("apps/web/")
                  ? "snipara-web"
                  : null;
  return packageId
    ? {
        kind: "PACKAGE",
        id: packageId,
        label: packageId,
        sourcePath: filePath,
      }
    : null;
}

function deriveModuleSymbolResource(filePath: string): CollaborationResource | null {
  if (!isSupportedCodePath(filePath)) {
    return null;
  }
  const withoutExtension = filePath.replace(/\.(ts|tsx|mts|cts|py|pyi|go)$/i, "");
  return {
    kind: "SYMBOL",
    id: `module:${withoutExtension}`,
    label: `Module ${withoutExtension}`,
    sourcePath: filePath,
  };
}

function deriveTestSurfaceResource(filePath: string): CollaborationResource | null {
  if (!isSupportedCodePath(filePath)) {
    return null;
  }
  const normalized = filePath
    .replace(/(^|\/)__tests__\//g, "$1")
    .replace(/\.(test|spec)\.(ts|tsx|py|go)$/i, ".$2")
    .replace(/\.(ts|tsx|mts|cts|py|pyi|go)$/i, "");
  return {
    kind: "SURFACE",
    id: `tests:${normalized}`,
    label: `Tests for ${normalized}`,
    sourcePath: filePath,
  };
}

function isSupportedCodePath(filePath: string): boolean {
  return /\.(ts|tsx|mts|cts|py|pyi|go)$/i.test(filePath);
}

function isPrismaSchemaPath(filePath: string): boolean {
  return filePath.endsWith("/prisma/schema.prisma") || filePath.includes("/prisma/migrations/");
}

function isDeploymentPath(filePath: string): boolean {
  return (
    filePath.startsWith("deploy/") ||
    filePath.includes("/deploy/") ||
    filePath.endsWith("docker-compose.yml") ||
    filePath.endsWith("Dockerfile")
  );
}

function classifyCriticalSurfaces(filePath: string): CliCriticalSurface[] {
  return CRITICAL_SURFACES.filter((surface) =>
    surface.patterns.some((pattern) => pattern.test(filePath))
  );
}

function readLocalOverlaySymbols(
  rootDir: string,
  maxFiles: number
): Array<Pick<LocalCodeOverlaySymbol, "filePath" | "kind" | "line" | "name">> {
  try {
    const overlay: LocalCodeOverlayManifest = buildLocalCodeOverlay({
      cwd: rootDir,
      mode: "working_tree",
      maxFiles,
    });
    return overlay.symbols;
  } catch {
    return [];
  }
}

function readRepositoryId(rootDir: string): string | undefined {
  const remote = readGitValue(rootDir, ["config", "--get", "remote.origin.url"]);
  if (!remote) {
    return undefined;
  }

  const githubMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (githubMatch) {
    return githubMatch[1].replace(/\.git$/, "");
  }
  return remote;
}

function readGitValue(rootDir: string, args: string[]): string | undefined {
  const output = readGitRawValue(rootDir, args);
  return output?.trim() || undefined;
}

function readGitRawValue(rootDir: string, args: string[]): string | undefined {
  try {
    const execOptions: ExecFileSyncOptionsWithStringEncoding = {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    };
    const output = execFileSync("git", args, execOptions);
    return output || undefined;
  } catch {
    return undefined;
  }
}

function collaborationHookBlockMarker(hookName: string, type: "start" | "end"): string {
  return `# ${HOOK_BLOCK_PREFIX} ${hookName}:${type}`;
}

function buildCollaborationGitHookBlock(hookName: "pre-commit" | "pre-push"): string {
  const profile = hookName === "pre-push" ? "pre-push" : "pre-commit";
  return [
    collaborationHookBlockMarker(hookName, "start"),
    "# Block unsafe parallel edits before code leaves the local worktree.",
    'if [ "${SNIPARA_COLLABORATION_GUARD:-1}" = "0" ]; then',
    '  echo "Snipara collaboration guard bypassed by SNIPARA_COLLABORATION_GUARD=0" >&2',
    "elif command -v snipara-companion >/dev/null 2>&1; then",
    `  snipara-companion collaboration guard --profile ${profile} --action ${profile} --enforce --json >/dev/null`,
    "else",
    '  echo "snipara-companion is required for the Snipara collaboration guard. Install it or set SNIPARA_COLLABORATION_GUARD=0 for an explicit emergency bypass." >&2',
    "  exit 1",
    "fi",
    collaborationHookBlockMarker(hookName, "end"),
  ].join("\n");
}

function mergeManagedCollaborationHookBlock(
  hookName: "pre-commit" | "pre-push",
  currentContent: string | null,
  block: string
): string {
  const startMarker = collaborationHookBlockMarker(hookName, "start");
  const endMarker = collaborationHookBlockMarker(hookName, "end");
  const managedBlockPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`,
    "m"
  );
  const base = currentContent && currentContent.trim() ? currentContent : "#!/usr/bin/env sh\n";
  const withShebang = base.startsWith("#!") ? base : `#!/usr/bin/env sh\n${base}`;
  const nextBlock = `${block}\n`;

  if (managedBlockPattern.test(withShebang)) {
    return ensureTrailingNewline(withShebang.replace(managedBlockPattern, nextBlock));
  }
  return ensureTrailingNewline(`${withShebang.trimEnd()}\n\n${nextBlock}`);
}

function resolveGitHooksDir(repoRoot: string): string {
  const gitHooksPath = readGitValue(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  const hooksDir = path.resolve(repoRoot, gitHooksPath ?? path.join(".git", "hooks"));
  const huskyUserHooksDir = path.dirname(hooksDir);
  if (
    path.basename(hooksDir) === "_" &&
    path.basename(huskyUserHooksDir) === ".husky" &&
    fs.existsSync(path.join(hooksDir, "h"))
  ) {
    return huskyUserHooksDir;
  }
  return hooksDir;
}

function installManagedCollaborationGitHook(
  repoRoot: string,
  hookName: "pre-commit" | "pre-push",
  options: CollaborationHooksInstallOptions
): { hook: string; path: string; action: "created" | "updated" | "unchanged"; content: string } {
  const hooksDir = resolveGitHooksDir(repoRoot);
  const hookPath = path.join(hooksDir, hookName);
  const currentContent = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null;
  const block = buildCollaborationGitHookBlock(hookName);
  const nextContent = mergeManagedCollaborationHookBlock(hookName, currentContent, block);
  const action =
    currentContent === null ? "created" : currentContent === nextContent ? "unchanged" : "updated";

  if (!options.dryRun && action !== "unchanged") {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, nextContent, "utf8");
    fs.chmodSync(hookPath, 0o755);
  } else if (!options.dryRun && fs.existsSync(hookPath)) {
    fs.chmodSync(hookPath, fs.statSync(hookPath).mode | 0o755);
  }

  return { hook: hookName, path: hookPath, action, content: nextContent };
}

function mergeLocalLeaseState(
  state: CollaborationLocalState,
  leases: CollaborationLeaseSummary[],
  resources: CollaborationResource[]
): void {
  const byId = new Map(state.leases.map((lease) => [lease.id, lease]));
  for (const lease of leases) {
    byId.set(lease.id, {
      id: lease.id,
      mode: lease.mode,
      status: lease.status,
      resources: resources.filter(
        (resource) => resource.kind === lease.resourceKind && resource.id === lease.resourceId
      ),
      reason: lease.reason ?? undefined,
      claimedAt: lease.claimedAt,
      expiresAt: lease.expiresAt,
    });
  }
  state.leases = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function localResourceKey(resource: CollaborationResource): string {
  return `${resource.kind}:${normalizeResourceId(resource.kind, resource.id)}`;
}

function resolveReleaseLeaseIds(
  state: CollaborationLocalState,
  options: CollaborationCommandOptions
): string[] {
  const explicit = normalizeOptionalString(options.leaseId);
  if (explicit) {
    return [explicit];
  }
  if (options.all) {
    return state.leases.filter((lease) => lease.status === "ACTIVE").map((lease) => lease.id);
  }
  const latestActive = [...state.leases].reverse().find((lease) => lease.status === "ACTIVE");
  if (latestActive) {
    return [latestActive.id];
  }
  throw new Error("No collaboration lease id provided and no active local lease was found");
}

function printCollaborationResult(payload: Record<string, unknown>, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const action = String(payload.action ?? "status");
  const state = payload.state as CollaborationLocalState;
  const hosted = payload.hosted as
    | HostedAttempt<
        | CollaborationSessionResponse
        | CollaborationLeaseResponse
        | CollaborationGuardResponse
        | CollaborationStateResponse
        | Array<{ lease: CollaborationLeaseSummary }>
      >
    | undefined;

  console.log(getCollaborationHeading(action));
  console.log(`State: ${payload.statePath}`);
  console.log(`Work session: ${state.workSessionId ?? "none"}`);
  console.log(`Actor: ${state.actorLabel ?? state.actorId ?? "unknown"}`);
  if (state.branch) {
    console.log(`Branch: ${state.branch}`);
  }
  if (state.files.length > 0) {
    console.log(`Files: ${formatList(state.files, 8)}`);
  }
  if (state.leases.length > 0) {
    console.log(
      `Local leases: ${state.leases.filter((lease) => lease.status === "ACTIVE").length} active`
    );
  }

  if (hosted?.status === "skipped") {
    console.log("Hosted collaboration: skipped (no API key configured)");
  } else if (hosted?.status === "error") {
    console.log(`Hosted collaboration unavailable: ${hosted.error}`);
  } else if (hosted?.status === "ok") {
    printHostedCollaboration(action, hosted.data);
  }
}

function printHostedCollaboration(
  action: string,
  data:
    | CollaborationSessionResponse
    | CollaborationLeaseResponse
    | CollaborationGuardResponse
    | CollaborationStateResponse
    | Array<{ lease: CollaborationLeaseSummary }>
    | undefined
): void {
  if (!data) {
    return;
  }

  if (action === "guard") {
    const result = data as CollaborationGuardResponse;
    console.log(`Guard: ${result.evaluation.decision} (${result.evaluation.severity})`);
    if (result.evaluation.conflicts.length > 0) {
      console.log(
        `Conflicts: ${formatList(
          result.evaluation.conflicts.map((conflict) => conflict.reason),
          4
        )}`
      );
    }
    if (result.evaluation.recommendedActions.length > 0) {
      console.log(`Recommended actions: ${formatList(result.evaluation.recommendedActions, 4)}`);
    }
    return;
  }

  if (action === "status") {
    const result = data as CollaborationStateResponse;
    console.log(`Hosted active sessions: ${result.sessions.length}`);
    console.log(`Hosted active leases: ${result.leases.length}`);
    return;
  }

  if (action === "claim") {
    const result = data as CollaborationLeaseResponse;
    console.log(`Hosted leases claimed: ${result.leases.length}`);
    console.log(`Resources: ${formatList(result.resources.map(formatResource), 8)}`);
    return;
  }

  if (action === "release" && Array.isArray(data)) {
    console.log(`Hosted leases released: ${data.length}`);
    return;
  }

  if (action === "start") {
    const result = data as CollaborationSessionResponse;
    console.log(`Hosted session: ${result.session.id}`);
    console.log(`Resources: ${formatList(result.resources.map(formatResource), 8)}`);
  }
}

function getCollaborationHeading(action: string): string {
  if (action === "guard") {
    return "Collaboration guard";
  }
  if (action === "status") {
    return "Collaboration status";
  }
  if (action === "watch") {
    return "Collaboration watch";
  }
  return `Collaboration ${action}`;
}

export interface HostedGuardPayload {
  files: string[];
  resources: CollaborationResource[];
  fileCount: number;
  resourceCount: number;
  filesTruncated: boolean;
  resourcesTruncated: boolean;
}

export function buildHostedGuardPayload(
  files: string[],
  resources: CollaborationResource[]
): HostedGuardPayload {
  const hostedFiles = files.slice(0, HOSTED_GUARD_MAX_FILES);
  const hostedResources = compactHostedGuardResources(resources);
  return {
    files: hostedFiles,
    resources: hostedResources,
    fileCount: files.length,
    resourceCount: resources.length,
    filesTruncated: hostedFiles.length < files.length,
    resourcesTruncated: hostedResources.length < normalizeResources(resources).length,
  };
}

export function compactHostedGuardResources(
  resources: CollaborationResource[]
): CollaborationResource[] {
  const normalized = normalizeResources(resources);
  if (normalized.length <= HOSTED_GUARD_MAX_RESOURCES) {
    return normalized;
  }

  const reservedSlots = HOSTED_GUARD_MAX_RESOURCES - 1;
  const nonSymbolResources = normalized.filter((resource) => resource.kind !== "SYMBOL");
  const symbolResources = normalized.filter((resource) => resource.kind === "SYMBOL");
  const selected = nonSymbolResources.slice(0, reservedSlots);
  const symbolSlots = Math.min(
    HOSTED_GUARD_MAX_SYMBOL_RESOURCES,
    Math.max(0, reservedSlots - selected.length)
  );
  selected.push(...symbolResources.slice(0, symbolSlots));

  const omittedCount = normalized.length - selected.length;
  selected.push({
    kind: "CUSTOM",
    id: "hosted-guard-resource-summary",
    label: `${omittedCount} guard resources omitted from hosted request`,
  });
  return normalizeResources(selected);
}

function ensureFilesOrResources(
  files: string[],
  resources: CollaborationResource[],
  command: string
): void {
  if (files.length === 0 && resources.length === 0) {
    throw new Error(`collaboration ${command} requires --files, --resource, or dirty git files`);
  }
}

function shouldFailGuard(
  decision: CollaborationGuardDecision | undefined,
  enforce: boolean
): boolean {
  if (!decision) {
    return true;
  }
  if (decision === "BLOCKED") {
    return true;
  }
  return enforce && (decision === "REQUIRES_ACK" || decision === "REVIEW_REQUIRED");
}

function buildLocalSessionId(
  context: ResolvedCollaborationContext,
  task: string | undefined,
  files: string[]
): string {
  const hash = createHash("sha1")
    .update([context.actor.actorId, context.branch ?? "", task ?? "", files.join(",")].join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `local_${hash}`;
}

function normalizeFiles(files: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (files ?? [])
        .map((file) => file.trim())
        .filter(Boolean)
        .map(normalizeRepoPath)
    )
  ).sort();
}

function normalizeResources(resources: unknown): CollaborationResource[] {
  if (!Array.isArray(resources)) {
    return [];
  }

  const byKey = new Map<string, CollaborationResource>();
  for (const item of resources) {
    const record = item as Partial<CollaborationResource>;
    const kind = normalizeResourceKind(record.kind);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!kind || !id) {
      continue;
    }
    const resource: CollaborationResource = {
      kind,
      id: normalizeResourceId(kind, id),
      ...(typeof record.label === "string" && record.label.trim()
        ? { label: record.label.trim() }
        : {}),
      ...(typeof record.sourcePath === "string" && record.sourcePath.trim()
        ? { sourcePath: normalizeRepoPath(record.sourcePath) }
        : {}),
    };
    byKey.set(`${resource.kind}:${resource.id}`, resource);
  }

  return Array.from(byKey.values()).sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)
  );
}

function mergeResources(
  current: CollaborationResource[],
  next: CollaborationResource[]
): CollaborationResource[] {
  return normalizeResources([...current, ...next]);
}

function normalizeLocalLeases(value: unknown): CollaborationLocalLeaseRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map<CollaborationLocalLeaseRecord | null>((item) => {
      const parsed = item as Partial<CollaborationLocalLeaseRecord>;
      const id = normalizeOptionalString(parsed.id);
      const mode = normalizeLeaseMode(parsed.mode);
      const status = normalizeLeaseStatus(parsed.status);
      if (!id || !mode || !status) {
        return null;
      }
      const lease: CollaborationLocalLeaseRecord = {
        id,
        mode,
        status,
        resources: normalizeResources(parsed.resources),
        expiresAt: parsed.expiresAt ?? null,
      };
      const reason = normalizeOptionalString(parsed.reason);
      const claimedAt = normalizeOptionalString(parsed.claimedAt);
      if (reason) {
        lease.reason = reason;
      }
      if (claimedAt) {
        lease.claimedAt = claimedAt;
      }
      return lease;
    })
    .filter((item): item is CollaborationLocalLeaseRecord => Boolean(item));
}

function normalizeLastGuard(value: unknown): CollaborationLocalState["lastGuard"] | undefined {
  const parsed = value as CollaborationLocalState["lastGuard"] | undefined;
  if (!parsed || !parsed.decision || !parsed.checkedAt) {
    return undefined;
  }
  return {
    decision: parsed.decision,
    severity: parsed.severity,
    checkedAt: parsed.checkedAt,
    action: parsed.action,
    resources: normalizeResources(parsed.resources),
    conflictCount: Number.isFinite(parsed.conflictCount) ? parsed.conflictCount : 0,
  };
}

function normalizeResourceKind(value: unknown): CollaborationResourceKind | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  return RESOURCE_KINDS.has(normalized as CollaborationResourceKind)
    ? (normalized as CollaborationResourceKind)
    : undefined;
}

function normalizeLeaseMode(value: unknown): CollaborationLeaseMode | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  return LEASE_MODES.has(normalized as CollaborationLeaseMode)
    ? (normalized as CollaborationLeaseMode)
    : undefined;
}

function normalizeGuardProfile(value: unknown): CollaborationGuardProfile | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (
    normalized === "edit" ||
    normalized === "pre-commit" ||
    normalized === "pre-push" ||
    normalized === "pre-deploy" ||
    normalized === "migration" ||
    normalized === "schema" ||
    normalized === "release-package"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeLeaseStatus(value: unknown): CollaborationLeaseStatus | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (
    normalized === "ACTIVE" ||
    normalized === "RELEASED" ||
    normalized === "EXPIRED" ||
    normalized === "OVERRIDDEN"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeActorType(value: unknown): CollaborationActorType | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "HUMAN" || normalized === "AGENT" || normalized === "SYSTEM") {
    return normalized;
  }
  return undefined;
}

function normalizeResourceId(kind: CollaborationResourceKind, id: string): string {
  const normalized = id.trim();
  if (kind === "FILE") {
    return normalizeRepoPath(normalized);
  }
  return normalized;
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .split(path.sep)
    .join("/")
    .replace(/^\.?\//, "");
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${label.replace(/\s+/g, "-")} must be a positive integer`);
  }
  return parsed;
}

function mergeStrings(current: string[], next: string[]): string[] {
  return Array.from(new Set([...current, ...next])).sort();
}

function formatList(values: string[], limit: number): string {
  const items = values.filter(Boolean);
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}

function formatResource(resource: CollaborationResource): string {
  return `${resource.kind}:${resource.id}`;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || "user";
  } catch {
    return "user";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
