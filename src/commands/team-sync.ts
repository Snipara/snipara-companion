import * as fs from "fs";
import * as path from "path";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createClient,
  type TeamSyncChangesResponse,
  type TeamSyncHandoffResponse,
  type TeamSyncResumeResponse,
  type TeamSyncWhatChangedResult,
  type TeamSyncWorkBriefResponse,
} from "../api/client";
import { loadConfig } from "../config/store";
import {
  formatOrchestratorRecommendationReason,
  getOrchestratorRecommendation,
  type OrchestratorRecommendation,
} from "../runtime/detection";
import {
  writeOrchestratorHandoff,
  type WrittenOrchestratorHandoff,
} from "../runtime/orchestrator-handoff";
import { appendJournalCheckpoint, type JournalWriteResult } from "./journal";

export const TEAM_SYNC_STATE_RELATIVE_PATH = path.join(".snipara", "team-sync", "session.json");
const TEAM_SYNC_STALE_WORK_MS = 48 * 60 * 60 * 1000;
const TEAM_SYNC_AUTO_ARCHIVE_WORK_MS = 14 * 24 * 60 * 60 * 1000;

export type TeamSyncAttention = "note" | "watch" | "review" | "proof";
export type TeamSyncWorkStatus = "active" | "completed" | "archived";

export interface TeamSyncRecordInput {
  summary: string;
  files?: string[];
  branch?: string;
  actor?: string;
  next?: string;
  attention?: string;
  risk?: string;
  now?: Date;
}

export interface TeamSyncWorkRecord {
  id: string;
  type: "work";
  summary: string;
  files: string[];
  branch?: string;
  actor?: string;
  status: TeamSyncWorkStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completionReason?: string;
  archivedAt?: string;
  archiveReason?: string;
}

export interface TeamSyncHandoffRecord {
  id: string;
  type: "handoff";
  summary: string;
  files: string[];
  next?: string;
  attention?: TeamSyncAttention;
  actor?: string;
  createdAt: string;
}

export interface TeamSyncState {
  schemaVersion: "snipara.team-sync.v1";
  updatedAt: string;
  work: TeamSyncWorkRecord[];
  handoffs: TeamSyncHandoffRecord[];
}

export interface TeamSyncSummary {
  activeWorkCount: number;
  staleWorkCount: number;
  completedWorkCount: number;
  archivedWorkCount: number;
  handoffCount: number;
  files: string[];
  latestActiveWork?: TeamSyncWorkRecord;
  latestStaleWork?: TeamSyncWorkRecord;
  latestCompletedWork?: TeamSyncWorkRecord;
  latestArchivedWork?: TeamSyncWorkRecord;
  latestHandoff?: TeamSyncHandoffRecord;
}

interface TeamSyncCommandOptions {
  id?: string;
  summary?: string;
  files?: string[];
  branch?: string;
  actor?: string;
  next?: string;
  attention?: string;
  risk?: string;
  since?: string;
  dir?: string;
  includeSessionContext?: boolean;
  emitOrchestratorHandoff?: boolean;
  autoRouteOrchestrator?: boolean;
  orchestratorPolicySource?: string;
  output?: string;
  days?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface HostedAttempt<T> {
  status: "skipped" | "ok" | "error";
  data?: T;
  error?: string;
}

interface HostedTeamSyncContext {
  sessionId?: string;
  client?: string;
}

interface StartWorkBriefStatus {
  status: "loaded" | "skipped" | "error";
  hostedStatus: HostedAttempt<TeamSyncWorkBriefResponse>["status"];
  message: string;
  whatChangedLoaded: boolean;
  generatedAt?: string;
  evidenceLevel?: string;
  changeCount?: number;
  decisionCount?: number;
  staleAssumptionCount?: number;
  failedJobCount?: number;
  overlapCount?: number;
  nextActionCount?: number;
  firstNextAction?: string;
}

interface TeamSyncHandoffPayload {
  action: "handoff";
  record: TeamSyncHandoffRecord;
  journal: JournalWriteResult;
  statePath: string;
  summary: TeamSyncSummary;
  hosted: HostedAttempt<TeamSyncHandoffResponse>;
  orchestratorRecommendation: OrchestratorRecommendation | null;
  orchestratorHandoff: WrittenOrchestratorHandoff | null;
}

export interface TeamSyncSweepResult {
  action: "sweep";
  statePath: string;
  dryRun: boolean;
  thresholdDays: number;
  thresholdMs: number;
  archivedCount: number;
  archivedWork: TeamSyncWorkRecord[];
  summary: TeamSyncSummary;
}

export interface TeamSyncCompletionEvidenceOptions {
  summary?: string;
  workflowGoal?: string;
  files?: string[];
  reason?: string;
  now?: Date;
  dryRun?: boolean;
}

export interface AgenticHandoffArtifact {
  version: "snipara.agentic_handoff.v1";
  generatedAt: string;
  command: "snipara-companion handoff";
  record: TeamSyncHandoffRecord;
  statePath: string;
  hosted: {
    status: HostedAttempt<TeamSyncHandoffResponse>["status"];
    handoffId?: string;
    error?: string;
  };
  sections: {
    whatChanged: string[];
    verified: string[];
    risky: string[];
    remains: string[];
    whereToResume: string[];
  };
  suggestedCommands: string[];
}

export function buildTeamSyncStartWorkRecord(input: TeamSyncRecordInput): TeamSyncWorkRecord {
  const createdAt = (input.now ?? new Date()).toISOString();
  const files = normalizeFiles(input.files);
  const summary = requireSummary(input.summary);

  return {
    id: buildRecordId("work", createdAt, summary, files),
    type: "work",
    summary,
    files,
    branch: normalizeOptionalString(input.branch),
    actor: normalizeOptionalString(input.actor),
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

export function buildTeamSyncHandoffRecord(input: TeamSyncRecordInput): TeamSyncHandoffRecord {
  const createdAt = (input.now ?? new Date()).toISOString();
  const files = normalizeFiles(input.files);
  const summary = requireSummary(input.summary);

  return {
    id: buildRecordId("handoff", createdAt, summary, files),
    type: "handoff",
    summary,
    files,
    next: normalizeOptionalString(input.next),
    attention: normalizeAttention(input.attention ?? input.risk),
    actor: normalizeOptionalString(input.actor),
    createdAt,
  };
}

export function createEmptyTeamSyncState(now = new Date()): TeamSyncState {
  return {
    schemaVersion: "snipara.team-sync.v1",
    updatedAt: now.toISOString(),
    work: [],
    handoffs: [],
  };
}

export function buildTeamSyncSummary(
  state: TeamSyncState,
  since?: Date,
  now: Date = new Date()
): TeamSyncSummary {
  const work = since
    ? state.work.filter((item) => getWorkTimestamp(item) >= since.getTime())
    : state.work;
  const handoffs = since
    ? state.handoffs.filter((item) => new Date(item.createdAt).getTime() >= since.getTime())
    : state.handoffs;
  const activeWork = work.filter((item) => item.status === "active" && !isStaleWork(item, now));
  const staleWork = work.filter((item) => item.status === "active" && isStaleWork(item, now));
  const completedWork = work.filter((item) => item.status === "completed");
  const archivedWork = work.filter((item) => item.status === "archived");
  const files = new Set<string>();

  for (const item of [...work, ...handoffs]) {
    for (const file of item.files) {
      files.add(file);
    }
  }

  return {
    activeWorkCount: activeWork.length,
    staleWorkCount: staleWork.length,
    completedWorkCount: completedWork.length,
    archivedWorkCount: archivedWork.length,
    handoffCount: handoffs.length,
    files: Array.from(files).sort(),
    latestActiveWork: activeWork[activeWork.length - 1],
    latestStaleWork: staleWork[staleWork.length - 1],
    latestCompletedWork: completedWork[completedWork.length - 1],
    latestArchivedWork: archivedWork[archivedWork.length - 1],
    latestHandoff: handoffs[handoffs.length - 1],
  };
}

export function archiveInactiveTeamSyncWork(
  state: TeamSyncState,
  options: { now?: Date; thresholdMs?: number; dryRun?: boolean } = {}
): TeamSyncSweepResult["archivedWork"] {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const thresholdMs = options.thresholdMs ?? TEAM_SYNC_AUTO_ARCHIVE_WORK_MS;
  const thresholdDays = Math.round(thresholdMs / (24 * 60 * 60 * 1000));
  const candidates = state.work.filter(
    (item) => item.status === "active" && now.getTime() - getWorkTimestamp(item) > thresholdMs
  );

  if (!options.dryRun) {
    for (const item of candidates) {
      item.status = "archived";
      item.updatedAt = nowIso;
      item.archivedAt = nowIso;
      item.archiveReason = `No update for ${thresholdDays} day(s)`;
    }
    if (candidates.length > 0) {
      state.updatedAt = nowIso;
    }
  }

  return candidates;
}

export function completeTeamSyncWorkFromEvidence(
  state: TeamSyncState,
  options: TeamSyncCompletionEvidenceOptions = {}
): TeamSyncWorkRecord[] {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const workflowGoalText = normalizeCompletionText(options.workflowGoal);
  const summaryText = normalizeCompletionText(options.summary);
  const evidenceFiles = normalizeFiles(options.files);
  const candidates = state.work.filter(
    (item) =>
      item.status === "active" &&
      matchesCompletionEvidence(item, { workflowGoalText, summaryText, files: evidenceFiles })
  );

  if (!options.dryRun) {
    for (const item of candidates) {
      item.status = "completed";
      item.updatedAt = nowIso;
      item.completedAt = nowIso;
      item.completionReason =
        normalizeOptionalString(options.reason) ?? "Completed by workflow completion evidence";
    }
    if (candidates.length > 0) {
      state.updatedAt = nowIso;
    }
  }

  return candidates;
}

export function completeTeamSyncStateFromEvidence(
  rootDir = process.cwd(),
  options: TeamSyncCompletionEvidenceOptions = {}
): TeamSyncWorkRecord[] {
  const state = loadTeamSyncState(rootDir);
  const completedWork = completeTeamSyncWorkFromEvidence(state, options);
  if (!options.dryRun && completedWork.length > 0) {
    saveTeamSyncState(state, rootDir);
  }
  return completedWork;
}

export function autoArchiveTeamSyncState(
  rootDir = process.cwd(),
  now: Date = new Date()
): TeamSyncSweepResult["archivedWork"] {
  const state = loadTeamSyncState(rootDir);
  const archivedWork = archiveInactiveTeamSyncWork(state, { now });
  if (archivedWork.length > 0) {
    saveTeamSyncState(state, rootDir);
  }
  return archivedWork;
}

export function loadTeamSyncState(rootDir = process.cwd()): TeamSyncState {
  const statePath = getTeamSyncStatePath(rootDir);
  if (!fs.existsSync(statePath)) {
    return createEmptyTeamSyncState();
  }

  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<TeamSyncState>;
  return {
    schemaVersion: "snipara.team-sync.v1",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    work: Array.isArray(parsed.work) ? parsed.work.map(normalizeWorkRecord) : [],
    handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [],
  };
}

export function saveTeamSyncState(state: TeamSyncState, rootDir = process.cwd()): void {
  const statePath = getTeamSyncStatePath(rootDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getTeamSyncStatePath(rootDir = process.cwd()): string {
  return path.join(rootDir, TEAM_SYNC_STATE_RELATIVE_PATH);
}

export async function teamSyncStartWorkCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const state = loadTeamSyncState(rootDir);
  archiveInactiveTeamSyncWork(state);
  const branch =
    normalizeOptionalString(options.branch) ?? readGitValue(rootDir, ["branch", "--show-current"]);
  const record = buildTeamSyncStartWorkRecord({
    summary: options.summary ?? "",
    files: options.files,
    branch,
    actor: options.actor,
  });

  state.work.push(record);
  state.updatedAt = record.createdAt;
  saveTeamSyncState(state, rootDir);

  const summary = buildTeamSyncSummary(state);
  const hosted = await maybeCreateHostedWorkBrief(rootDir, {
    task: record.summary,
    branch: record.branch,
    changedFiles: record.files,
    recentFiles: record.files,
  });
  const startWorkBriefStatus = buildStartWorkBriefStatus(hosted);
  const shouldEmitOrchestratorHandoff =
    options.emitOrchestratorHandoff || options.autoRouteOrchestrator;
  const orchestratorRecommendation = buildTeamSyncOrchestratorRecommendation(
    "start-work",
    summary,
    hosted,
    {
      policyAutoRoute: options.autoRouteOrchestrator,
      policySource: options.orchestratorPolicySource,
    }
  );
  const orchestratorHandoff = maybeWriteTeamSyncOrchestratorHandoff(
    rootDir,
    "team-sync start-work",
    shouldEmitOrchestratorHandoff,
    orchestratorRecommendation,
    {
      query: record.summary,
      summary: record.summary,
      title: record.summary,
      changedFiles: summary.files,
      featureTitle: record.summary,
      workstreams: ["team-sync:start-work"],
    }
  );
  const journal = await appendJournalCheckpoint({
    action: "team-sync:start-work",
    summary: record.summary,
    branch: record.branch,
    actor: record.actor,
    files: record.files,
    cwd: rootDir,
  });

  printTeamSyncResult(
    {
      action: "start-work",
      record,
      journal,
      statePath: getTeamSyncStatePath(rootDir),
      summary,
      hosted,
      startWorkBriefStatus,
      orchestratorRecommendation,
      orchestratorHandoff,
    },
    options.json
  );
}

export async function teamSyncHandoffCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  autoArchiveTeamSyncState(rootDir);
  const payload = await createTeamSyncHandoffPayload(rootDir, {
    ...options,
    summary: options.summary ?? "",
  });

  printTeamSyncResult(payload as unknown as Record<string, unknown>, options.json);
}

async function createTeamSyncHandoffPayload(
  rootDir: string,
  options: TeamSyncCommandOptions & { summary: string }
): Promise<TeamSyncHandoffPayload> {
  const state = loadTeamSyncState(rootDir);
  archiveInactiveTeamSyncWork(state);
  const record = buildTeamSyncHandoffRecord({
    summary: options.summary,
    files: options.files,
    next: options.next,
    attention: options.attention ?? options.risk,
    actor: options.actor,
  });

  state.handoffs.push(record);
  state.updatedAt = record.createdAt;
  saveTeamSyncState(state, rootDir);

  const summary = buildTeamSyncSummary(state);
  const hosted = await maybeCreateHostedHandoff(rootDir, {
    summary: record.summary,
    task: summary.latestActiveWork?.summary ?? record.summary,
    nextStep: record.next,
    files: record.files,
    attention: mapHostedAttention(record.attention),
  });
  const shouldEmitOrchestratorHandoff =
    options.emitOrchestratorHandoff || options.autoRouteOrchestrator;
  const orchestratorRecommendation = buildTeamSyncOrchestratorRecommendation(
    "handoff",
    summary,
    hosted,
    {
      policyAutoRoute: options.autoRouteOrchestrator,
      policySource: options.orchestratorPolicySource,
    }
  );
  const orchestratorHandoff = maybeWriteTeamSyncOrchestratorHandoff(
    rootDir,
    "team-sync handoff",
    shouldEmitOrchestratorHandoff,
    orchestratorRecommendation,
    {
      query: [record.summary, record.next].filter(Boolean).join(" | ") || record.summary,
      summary: record.summary,
      title: summary.latestActiveWork?.summary ?? record.summary,
      changedFiles: summary.files,
      resumeSummary: record.next,
      featureTitle: summary.latestActiveWork?.summary ?? record.summary,
      workstreams: ["team-sync:handoff"],
    }
  );
  const journal = await appendJournalCheckpoint({
    action: "team-sync:handoff",
    summary: record.summary,
    actor: record.actor,
    next: record.next,
    attention: record.attention,
    files: record.files,
    cwd: rootDir,
  });

  return {
    action: "handoff",
    record,
    journal,
    statePath: getTeamSyncStatePath(rootDir),
    summary,
    hosted,
    orchestratorRecommendation,
    orchestratorHandoff,
  };
}

function readWorkflowSnapshot(rootDir: string):
  | {
      goal?: string;
      status?: string;
      currentPhaseId?: string;
      currentPhaseTitle?: string;
    }
  | undefined {
  const statePath = path.join(rootDir, ".snipara", "workflow", "current.json");
  if (!fs.existsSync(statePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      goal?: unknown;
      status?: unknown;
      currentPhaseId?: unknown;
      phases?: Array<{ id?: unknown; title?: unknown }>;
    };
    const currentPhaseId =
      typeof parsed.currentPhaseId === "string" ? parsed.currentPhaseId : undefined;
    const currentPhase = Array.isArray(parsed.phases)
      ? parsed.phases.find((phase) => phase.id === currentPhaseId)
      : undefined;
    return {
      goal: typeof parsed.goal === "string" ? parsed.goal : undefined,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      currentPhaseId,
      currentPhaseTitle: typeof currentPhase?.title === "string" ? currentPhase.title : undefined,
    };
  } catch {
    return undefined;
  }
}

function readGitStatusLines(rootDir: string): string[] {
  const status = readGitValue(rootDir, ["status", "--short"]);
  return status ? status.split(/\r?\n/).filter(Boolean) : [];
}

function resolveAgenticHandoffSummary(rootDir: string, explicitSummary?: string): string {
  const normalized = normalizeOptionalString(explicitSummary);
  if (normalized) {
    return normalized;
  }

  const summary = buildTeamSyncSummary(loadTeamSyncState(rootDir));
  if (summary.latestActiveWork?.summary) {
    return `Handoff: ${summary.latestActiveWork.summary}`;
  }

  const workflow = readWorkflowSnapshot(rootDir);
  if (workflow?.currentPhaseTitle) {
    return `Handoff: ${workflow.goal ?? "managed workflow"} / ${workflow.currentPhaseTitle}`;
  }
  if (workflow?.goal) {
    return `Handoff: ${workflow.goal}`;
  }

  return `Agent handoff ${new Date().toISOString()}`;
}

function hostedHandoffId(hosted: HostedAttempt<TeamSyncHandoffResponse>): string | undefined {
  return hosted.status === "ok" ? hosted.data?.handoff.id : undefined;
}

function hostedHandoffTests(hosted: HostedAttempt<TeamSyncHandoffResponse>): string[] {
  return hosted.status === "ok" ? (hosted.data?.handoff.tests ?? []) : [];
}

function buildAgenticHandoffArtifact(
  rootDir: string,
  payload: TeamSyncHandoffPayload
): AgenticHandoffArtifact {
  const workflow = readWorkflowSnapshot(rootDir);
  const gitStatus = readGitStatusLines(rootDir);
  const whatChanged = [payload.record.summary];
  const verified = [`Local handoff recorded at ${TEAM_SYNC_STATE_RELATIVE_PATH}.`];
  const risky: string[] = [];
  const remains: string[] = [];
  const whereToResume = [
    "snipara-companion status",
    "snipara-companion timeline",
    "snipara-companion workflow resume --include-session-context",
  ];

  if (payload.summary.latestActiveWork?.summary) {
    whatChanged.push(`Active work: ${payload.summary.latestActiveWork.summary}`);
  }
  if (payload.record.files.length > 0) {
    whatChanged.push(`Files: ${payload.record.files.join(", ")}`);
  }
  if (workflow?.goal) {
    whatChanged.push(`Workflow: ${workflow.goal}`);
  }

  if (payload.journal.status === "ok") {
    verified.push("Journal checkpoint appended.");
  } else if (payload.journal.error) {
    risky.push(`Journal checkpoint failed: ${payload.journal.error}`);
  }

  if (payload.hosted.status === "ok") {
    verified.push(`Hosted handoff published: ${hostedHandoffId(payload.hosted) ?? "recorded"}.`);
  } else if (payload.hosted.status === "error") {
    risky.push(`Hosted handoff unavailable: ${payload.hosted.error}`);
  }

  const tests = hostedHandoffTests(payload.hosted);
  if (tests.length > 0) {
    verified.push(`Hosted recommended tests: ${tests.join(", ")}`);
  }

  if (payload.record.attention && payload.record.attention !== "note") {
    risky.push(`Attention: ${payload.record.attention}.`);
  }
  if (payload.summary.staleWorkCount > 0) {
    risky.push(`${payload.summary.staleWorkCount} stale Team Sync work item(s) remain active.`);
  }
  if (gitStatus.length > 0) {
    risky.push(`${gitStatus.length} dirty git file(s) were present when handoff was generated.`);
  }

  remains.push(payload.record.next ?? "No explicit next step was provided.");
  if (workflow?.currentPhaseId) {
    remains.push(`Current workflow phase: ${workflow.currentPhaseId}.`);
    whereToResume.push(`snipara-companion workflow phase-start ${workflow.currentPhaseId}`);
  }

  return {
    version: "snipara.agentic_handoff.v1",
    generatedAt: new Date().toISOString(),
    command: "snipara-companion handoff",
    record: payload.record,
    statePath: payload.statePath,
    hosted: {
      status: payload.hosted.status,
      ...(hostedHandoffId(payload.hosted) ? { handoffId: hostedHandoffId(payload.hosted) } : {}),
      ...(payload.hosted.status === "error" ? { error: payload.hosted.error } : {}),
    },
    sections: {
      whatChanged,
      verified,
      risky: risky.length > 0 ? risky : ["No local risk was recorded."],
      remains,
      whereToResume,
    },
    suggestedCommands: whereToResume,
  };
}

function markdownList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

export function buildAgenticHandoffMarkdown(artifact: AgenticHandoffArtifact): string {
  return [
    "# Agent Handoff",
    "",
    `Generated: ${artifact.generatedAt}`,
    `Record: ${artifact.record.id}`,
    "",
    "## What Changed",
    markdownList(artifact.sections.whatChanged),
    "",
    "## What Is Verified",
    markdownList(artifact.sections.verified),
    "",
    "## What Is Risky",
    markdownList(artifact.sections.risky),
    "",
    "## What Remains",
    markdownList(artifact.sections.remains),
    "",
    "## Where To Resume",
    markdownList(artifact.sections.whereToResume),
    "",
  ].join("\n");
}

function writeAgenticHandoffArtifact(
  rootDir: string,
  output: string | undefined,
  artifact: AgenticHandoffArtifact
): string | undefined {
  if (!output) {
    return undefined;
  }

  const outputPath = path.resolve(rootDir, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = outputPath.toLowerCase().endsWith(".json")
    ? `${JSON.stringify(artifact, null, 2)}\n`
    : buildAgenticHandoffMarkdown(artifact);
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}

export async function agenticHandoffCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const summary = resolveAgenticHandoffSummary(rootDir, options.summary);
  const payload = await createTeamSyncHandoffPayload(rootDir, {
    ...options,
    summary,
  });
  const artifact = buildAgenticHandoffArtifact(rootDir, payload);
  const outputPath = writeAgenticHandoffArtifact(rootDir, options.output, artifact);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...artifact,
          ...(outputPath ? { outputPath } : {}),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(buildAgenticHandoffMarkdown(artifact));
  if (outputPath) {
    console.log(`Artifact written: ${outputPath}`);
  }
}

export async function teamSyncWhatChangedCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const since = parseSince(options.since);
  const state = loadTeamSyncState(rootDir);
  const archivedWork = archiveInactiveTeamSyncWork(state);
  if (archivedWork.length > 0) {
    saveTeamSyncState(state, rootDir);
  }
  const summary = buildTeamSyncSummary(state, since);
  const hosted = await maybeGetHostedWhatChanged(rootDir, {
    since: since?.toISOString(),
    recentFiles: summary.files.slice(0, 12),
  });
  const shouldEmitOrchestratorHandoff =
    options.emitOrchestratorHandoff || options.autoRouteOrchestrator;
  const orchestratorRecommendation = buildTeamSyncOrchestratorRecommendation(
    "what-changed",
    summary,
    hosted,
    {
      policyAutoRoute: options.autoRouteOrchestrator,
      policySource: options.orchestratorPolicySource,
    }
  );
  const orchestratorHandoff = maybeWriteTeamSyncOrchestratorHandoff(
    rootDir,
    "team-sync what-changed",
    shouldEmitOrchestratorHandoff,
    orchestratorRecommendation,
    {
      query: buildTeamSyncContinuityQuery("what-changed", summary),
      summary: buildTeamSyncContinuitySummary("what-changed", summary),
      title: "Team Sync What Changed",
      changedFiles: summary.files,
      resumeSummary: summary.latestHandoff?.summary ?? summary.latestActiveWork?.summary,
      featureTitle: summary.latestActiveWork?.summary ?? summary.latestHandoff?.summary ?? null,
      workstreams: ["team-sync:what-changed"],
    }
  );

  printTeamSyncResult(
    {
      action: "what-changed",
      since: since?.toISOString() ?? null,
      statePath: getTeamSyncStatePath(rootDir),
      summary,
      hosted,
      orchestratorRecommendation,
      orchestratorHandoff,
      compatibilityNotes: buildTeamSyncCompatibilityNotes("what-changed", options),
    },
    options.json
  );
}

export async function teamSyncCompleteWorkCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const state = loadTeamSyncState(rootDir);
  const archivedWork = archiveInactiveTeamSyncWork(state);
  const now = new Date().toISOString();
  const activeOrStale = state.work.filter((item) => item.status === "active");
  const record = options.id
    ? activeOrStale.find((item) => item.id === options.id)
    : activeOrStale[activeOrStale.length - 1];

  if (!record) {
    if (archivedWork.length > 0) {
      saveTeamSyncState(state, rootDir);
    }
    throw new Error(
      options.id
        ? `No active Team Sync work item found for id ${options.id}`
        : "No active Team Sync work item to complete"
    );
  }

  record.status = "completed";
  record.updatedAt = now;
  record.completedAt = now;
  record.completionReason = normalizeOptionalString(options.next);
  state.updatedAt = now;
  saveTeamSyncState(state, rootDir);
  const summary = buildTeamSyncSummary(state);
  const journal = await appendJournalCheckpoint({
    action: "team-sync:complete-work",
    summary: record.summary,
    outcome: "completed",
    actor: record.actor,
    next: record.completionReason,
    files: record.files,
    cwd: rootDir,
  });

  printTeamSyncResult(
    {
      action: "complete-work",
      record,
      journal,
      statePath: getTeamSyncStatePath(rootDir),
      summary,
      orchestratorRecommendation: buildTeamSyncOrchestratorRecommendation("complete-work", summary),
    },
    options.json
  );
}

export async function teamSyncResumeCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const state = loadTeamSyncState(rootDir);
  const archivedWork = archiveInactiveTeamSyncWork(state);
  if (archivedWork.length > 0) {
    saveTeamSyncState(state, rootDir);
  }
  const summary = buildTeamSyncSummary(state);
  const hosted = await maybeGetHostedResume(rootDir, {
    task: summary.latestActiveWork?.summary ?? summary.latestHandoff?.summary,
    recentFiles: summary.files.slice(0, 12),
  });
  const shouldEmitOrchestratorHandoff =
    options.emitOrchestratorHandoff || options.autoRouteOrchestrator;
  const orchestratorRecommendation = buildTeamSyncOrchestratorRecommendation(
    "resume",
    summary,
    hosted,
    {
      policyAutoRoute: options.autoRouteOrchestrator,
      policySource: options.orchestratorPolicySource,
    }
  );
  const orchestratorHandoff = maybeWriteTeamSyncOrchestratorHandoff(
    rootDir,
    "team-sync resume",
    shouldEmitOrchestratorHandoff,
    orchestratorRecommendation,
    {
      query: buildTeamSyncContinuityQuery("resume", summary),
      summary: buildTeamSyncContinuitySummary("resume", summary),
      title: "Team Sync Resume",
      changedFiles: summary.files,
      resumeSummary: summary.latestHandoff?.next ?? summary.latestActiveWork?.summary,
      featureTitle: summary.latestActiveWork?.summary ?? summary.latestHandoff?.summary ?? null,
      workstreams: ["team-sync:resume"],
    }
  );

  printTeamSyncResult(
    {
      action: "resume",
      statePath: getTeamSyncStatePath(rootDir),
      summary,
      hosted,
      orchestratorRecommendation,
      orchestratorHandoff,
      compatibilityNotes: buildTeamSyncCompatibilityNotes("resume", options),
      nextCommands: [
        "snipara-companion workflow resume --include-session-context",
        "snipara-companion team-sync what-changed",
      ],
    },
    options.json
  );
}

export async function teamSyncSweepCommand(options: TeamSyncCommandOptions): Promise<void> {
  const rootDir = resolveRootDir(options.dir);
  const thresholdDays = parsePositiveDays(options.days ?? "14");
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const state = loadTeamSyncState(rootDir);
  const archivedWork = archiveInactiveTeamSyncWork(state, {
    thresholdMs,
    dryRun: Boolean(options.dryRun),
  });
  if (!options.dryRun && archivedWork.length > 0) {
    saveTeamSyncState(state, rootDir);
  }
  const summary = buildTeamSyncSummary(state);
  const payload: TeamSyncSweepResult = {
    action: "sweep",
    statePath: getTeamSyncStatePath(rootDir),
    dryRun: Boolean(options.dryRun),
    thresholdDays,
    thresholdMs,
    archivedCount: archivedWork.length,
    archivedWork,
    summary,
  };

  printTeamSyncSweepResult(payload, options.json);
}

function printTeamSyncResult(payload: Record<string, unknown>, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const action = String(payload.action || "");
  const summary = payload.summary as TeamSyncSummary;
  console.log(getTeamSyncHeading(action));
  console.log(`State: ${payload.statePath}`);
  console.log(`Active work: ${summary.activeWorkCount}`);
  console.log(`Stale work: ${summary.staleWorkCount}`);
  console.log(`Completed work: ${summary.completedWorkCount}`);
  console.log(`Archived work: ${summary.archivedWorkCount}`);
  console.log(`Handoffs: ${summary.handoffCount}`);

  if (summary.files.length > 0) {
    console.log(`Files: ${summary.files.slice(0, 8).join(", ")}`);
  }
  if (summary.latestActiveWork) {
    console.log(`Latest active work: ${summary.latestActiveWork.summary}`);
  }
  if (summary.latestStaleWork) {
    console.log(`Latest stale work: ${summary.latestStaleWork.summary}`);
  }
  if (summary.latestCompletedWork) {
    console.log(`Latest completed work: ${summary.latestCompletedWork.summary}`);
  }
  if (summary.latestArchivedWork) {
    console.log(`Latest archived work: ${summary.latestArchivedWork.summary}`);
  }
  if (summary.latestHandoff) {
    console.log(`Latest handoff: ${summary.latestHandoff.summary}`);
    if (summary.latestHandoff.next) {
      console.log(`Next: ${summary.latestHandoff.next}`);
    }
  }
  const journal = payload.journal as { status?: string; error?: string } | undefined;
  if (journal?.status === "error" && journal.error) {
    console.log(`Journal checkpoint: ${journal.error}`);
  }
  if (action === "start-work") {
    printStartWorkBriefStatus(payload.startWorkBriefStatus as StartWorkBriefStatus | undefined);
  }

  const hosted = payload.hosted as
    | HostedAttempt<
        | TeamSyncWorkBriefResponse
        | TeamSyncChangesResponse
        | TeamSyncHandoffResponse
        | TeamSyncResumeResponse
      >
    | undefined;

  if (hosted?.status === "error") {
    console.log("");
    console.log(`Hosted Team Sync unavailable: ${hosted.error}`);
  } else if (hosted?.status === "ok") {
    if (action === "start-work") {
      printHostedWorkBrief((hosted.data as TeamSyncWorkBriefResponse).brief);
    } else if (action === "handoff") {
      printHostedHandoff((hosted.data as TeamSyncHandoffResponse).handoff);
    } else if (action === "what-changed") {
      printHostedWhatChanged((hosted.data as TeamSyncChangesResponse).whatChanged);
    } else if (action === "resume") {
      printHostedResumeContext(hosted.data as TeamSyncResumeResponse);
    }
  }

  const orchestratorRecommendation = payload.orchestratorRecommendation as
    | OrchestratorRecommendation
    | undefined;
  if (orchestratorRecommendation) {
    printTeamSyncOrchestratorRecommendation(orchestratorRecommendation);
  }
  const orchestratorHandoff = payload.orchestratorHandoff as WrittenOrchestratorHandoff | undefined;
  if (orchestratorHandoff) {
    printPreparedOrchestratorHandoff(orchestratorHandoff);
  }

  const compatibilityNotes = Array.isArray(payload.compatibilityNotes)
    ? payload.compatibilityNotes.filter((value): value is string => typeof value === "string")
    : [];
  if (compatibilityNotes.length > 0) {
    console.log("");
    for (const note of compatibilityNotes) {
      console.log(note);
    }
  }

  const nextCommands = Array.isArray(payload.nextCommands)
    ? payload.nextCommands.filter((value): value is string => typeof value === "string")
    : [];
  if (nextCommands.length > 0) {
    console.log("");
    console.log("Next commands:");
    for (const command of nextCommands) {
      console.log(`- ${command}`);
    }
  }
}

function printTeamSyncSweepResult(payload: TeamSyncSweepResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(payload.dryRun ? "Team Sync sweep preview" : "Team Sync sweep completed");
  console.log(`State: ${payload.statePath}`);
  console.log(`Threshold: ${payload.thresholdDays} day(s) without update`);
  console.log(`Archived work: ${payload.archivedCount}`);
  if (payload.archivedWork.length > 0) {
    console.log(
      `Items: ${formatList(
        payload.archivedWork.map((item) => item.summary),
        6
      )}`
    );
  }
  console.log(`Remaining stale work: ${payload.summary.staleWorkCount}`);
}

function printHostedWorkBrief(brief: TeamSyncWorkBriefResponse["brief"]): void {
  console.log("");
  console.log("Hosted Start Work Brief");
  console.log(`Evidence: ${brief.evidenceLevel}`);
  console.log(`Task: ${brief.task}`);
  if (brief.target.branch) {
    console.log(`Branch: ${brief.target.branch}`);
  }
  if (brief.likelyFiles.length > 0) {
    console.log(
      `Likely files: ${formatList(
        brief.likelyFiles.map((item) => item.path),
        6
      )}`
    );
  }
  if (brief.relevantDecisions.length > 0) {
    console.log(
      `Decisions: ${formatList(
        brief.relevantDecisions.map((item) => item.title),
        4
      )}`
    );
  }
  if (brief.activeCollisions.length > 0) {
    console.log(
      `Collisions: ${formatList(
        brief.activeCollisions.map((item) => `${item.path} (${item.severity})`),
        4
      )}`
    );
  }
  if (brief.recommendedTests.length > 0) {
    console.log(`Tests: ${formatList(brief.recommendedTests, 4)}`);
  }
  if (brief.recommendedActions.length > 0) {
    console.log(`Recommended actions: ${formatList(brief.recommendedActions, 4)}`);
  }
  if (brief.caveats.length > 0) {
    console.log(`Caveats: ${formatList(brief.caveats, 3)}`);
  }
}

function printStartWorkBriefStatus(status?: StartWorkBriefStatus): void {
  if (!status) {
    return;
  }

  console.log("");
  console.log(`Start Work Brief status: ${status.status} - ${status.message}`);
  if (status.status !== "loaded") {
    return;
  }

  console.log(
    `What Changed loaded: ${status.changeCount ?? 0} changes, ${status.decisionCount ?? 0} decisions, ${status.staleAssumptionCount ?? 0} stale assumptions, ${status.overlapCount ?? 0} overlaps, ${status.nextActionCount ?? 0} next actions.`
  );
  if (status.firstNextAction) {
    console.log(`First next action: ${status.firstNextAction}`);
  }
}

function buildTeamSyncCompatibilityNotes(
  action: "what-changed" | "resume",
  options: TeamSyncCommandOptions
): string[] {
  if (!options.includeSessionContext) {
    return [];
  }

  return [
    `Compatibility note: team-sync ${action} accepts --include-session-context, but short-lived session carryover still comes from snipara-companion workflow resume --include-session-context.`,
  ];
}

function printHostedWhatChanged(whatChanged: TeamSyncWhatChangedResult): void {
  console.log("");
  console.log("Hosted What Changed For Me");
  if (whatChanged.scope.branch) {
    console.log(`Branch: ${whatChanged.scope.branch}`);
  }
  console.log(
    `Summary: ${whatChanged.summary.changeCount} changes, ${whatChanged.summary.directChanges} direct, ${whatChanged.summary.decisionChanges} decisions, ${whatChanged.summary.staleAssumptions} stale assumptions`
  );
  if (whatChanged.changes.length > 0) {
    console.log(
      `Changed scopes: ${formatList(
        whatChanged.changes.map((item) => item.title),
        4
      )}`
    );
  }
  if (whatChanged.decisions.length > 0) {
    console.log(
      `Decisions: ${formatList(
        whatChanged.decisions.map((item) => item.title),
        4
      )}`
    );
  }
  if (whatChanged.staleAssumptions.length > 0) {
    console.log(
      `Stale assumptions: ${formatList(
        whatChanged.staleAssumptions.map((item) => item.reason),
        3
      )}`
    );
  }
  if (whatChanged.recommendedActions.length > 0) {
    console.log(`Recommended actions: ${formatList(whatChanged.recommendedActions, 4)}`);
  }
  if (whatChanged.caveats.length > 0) {
    console.log(`Caveats: ${formatList(whatChanged.caveats, 3)}`);
  }
}

function printHostedHandoff(handoff: TeamSyncHandoffResponse["handoff"]): void {
  console.log("");
  console.log("Hosted Handoff");
  console.log(`Handoff ID: ${handoff.id}`);
  console.log(`Attention: ${handoff.attention}`);
  if (handoff.nextStep) {
    console.log(`Next step: ${handoff.nextStep}`);
  }
  if (handoff.files.length > 0) {
    console.log(`Files: ${formatList(handoff.files, 6)}`);
  }
  if (handoff.tests.length > 0) {
    console.log(`Tests: ${formatList(handoff.tests, 4)}`);
  }
  if (handoff.caveats.length > 0) {
    console.log(`Caveats: ${formatList(handoff.caveats, 3)}`);
  }
}

function printHostedResumeContext(result: TeamSyncResumeResponse): void {
  console.log("");
  console.log("Hosted Resume Context");
  if (result.handoff) {
    console.log(`Latest hosted handoff: ${result.handoff.summary}`);
    console.log(`Match score: ${result.match.score}`);
    if (result.handoff.nextStep) {
      console.log(`Next step: ${result.handoff.nextStep}`);
    }
    if (result.handoff.blocker) {
      console.log(`Blocker: ${result.handoff.blocker}`);
    }
  }
  if (result.sessionContext?.checkpoints.length) {
    console.log(`Checkpoints: ${result.sessionContext.checkpoints.length}`);
  }
  if (result.sessionContext?.commands.length) {
    console.log(`Recent commands: ${formatList(result.sessionContext.commands, 4)}`);
  }
  if (result.recommendedActions.length > 0) {
    console.log(`Recommended actions: ${formatList(result.recommendedActions, 4)}`);
  }
  if (result.caveats.length > 0) {
    console.log(`Caveats: ${formatList(result.caveats, 3)}`);
  }
}

function printTeamSyncOrchestratorRecommendation(recommendation: OrchestratorRecommendation): void {
  console.log("");
  console.log("Orchestrator recommendation");
  console.log(`Level: ${recommendation.level}`);
  if (recommendation.policySource) {
    console.log(`Policy source: ${recommendation.policySource}`);
  }
  console.log(
    `Reasons: ${recommendation.reasons.map((reason) => formatOrchestratorRecommendationReason(reason)).join("; ")}`
  );
  if (recommendation.level === "auto") {
    console.log(
      "Companion auto-routed this continuity context to an orchestrator handoff by policy, without launching workers."
    );
  } else if (recommendation.orchestratorRequired) {
    console.log(
      "Companion recommends escalating this continuity context through snipara-orchestrator."
    );
  } else {
    console.log(
      "Companion can keep this continuity context local for now, with orchestrator as the next escalation path."
    );
  }
}

function printPreparedOrchestratorHandoff(handoff: WrittenOrchestratorHandoff): void {
  console.log("");
  console.log("Prepared Orchestrator Handoff");
  console.log(`Path: ${handoff.relativePath}`);
  console.log(`Command: ${handoff.command}`);
}

function maybeWriteTeamSyncOrchestratorHandoff(
  rootDir: string,
  sourceCommand: string,
  enabled: boolean | undefined,
  recommendation: OrchestratorRecommendation | null,
  input: {
    query: string;
    summary: string;
    title?: string | null;
    changedFiles?: string[];
    resumeSummary?: string;
    featureTitle?: string | null;
    workstreams?: string[];
  }
): WrittenOrchestratorHandoff | null {
  if (!enabled || !recommendation) {
    return null;
  }

  return writeOrchestratorHandoff({
    sourceCommand,
    recommendation,
    query: input.query,
    summary: input.summary,
    title: input.title ?? undefined,
    rootDir,
    changedFiles: input.changedFiles,
    resumeSummary: input.resumeSummary,
    featureTitle: input.featureTitle ?? undefined,
    workstreams: input.workstreams,
  });
}

function buildTeamSyncContinuityQuery(action: string, summary: TeamSyncSummary): string {
  return [
    `Review Team Sync ${action}`,
    summary.latestActiveWork?.summary,
    summary.latestHandoff?.summary,
    summary.latestHandoff?.next,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildTeamSyncContinuitySummary(action: string, summary: TeamSyncSummary): string {
  const activeSummary = summary.latestActiveWork?.summary ?? "No active work recorded.";
  const handoffSummary = summary.latestHandoff?.summary ?? "No handoff recorded.";
  return `Team Sync ${action}: ${activeSummary} ${handoffSummary}`.trim();
}

function buildTeamSyncOrchestratorRecommendation(
  action: string,
  summary: TeamSyncSummary,
  hosted?: HostedAttempt<
    | TeamSyncWorkBriefResponse
    | TeamSyncChangesResponse
    | TeamSyncHandoffResponse
    | TeamSyncResumeResponse
  >,
  options: {
    policyAutoRoute?: boolean;
    policySource?: string;
  } = {}
): OrchestratorRecommendation | null {
  const queryParts = [summary.latestActiveWork?.summary, summary.latestHandoff?.summary];

  if (action === "handoff" && summary.latestHandoff?.attention === "proof") {
    queryParts.push("proof gate required");
  }

  const recommendation = getOrchestratorRecommendation(
    queryParts.filter(Boolean).join(" | "),
    "full",
    {
      changedFilesCount: summary.files.length,
      hasActiveCollisions: hasTeamSyncCollisionSignal(action, hosted),
      policyAutoRoute: options.policyAutoRoute,
      policySource: options.policySource,
    }
  );

  return recommendation;
}

function hasTeamSyncCollisionSignal(
  action: string,
  hosted?: HostedAttempt<
    | TeamSyncWorkBriefResponse
    | TeamSyncChangesResponse
    | TeamSyncHandoffResponse
    | TeamSyncResumeResponse
  >
): boolean {
  if (hosted?.status !== "ok") {
    return false;
  }
  if (action === "start-work") {
    return (hosted.data as TeamSyncWorkBriefResponse).brief.activeCollisions.length > 0;
  }
  if (action === "what-changed") {
    return (hosted.data as TeamSyncChangesResponse).whatChanged.summary.overlapClusters > 0;
  }
  if (action === "resume") {
    return (hosted.data as TeamSyncResumeResponse).match.score >= 0.85;
  }
  return false;
}

async function maybeCreateHostedWorkBrief(
  rootDir: string,
  input: {
    task: string;
    branch?: string;
    changedFiles: string[];
    recentFiles: string[];
  }
): Promise<HostedAttempt<TeamSyncWorkBriefResponse>> {
  const client = createHostedClient(rootDir);
  if (!client) {
    return { status: "skipped" };
  }

  const context = readHostedContext(rootDir);
  try {
    return {
      status: "ok",
      data: await client.createTeamSyncWorkBrief({
        task: input.task,
        branch: input.branch,
        baseSha: readGitValue(rootDir, ["rev-parse", "HEAD"]),
        sessionId: context.sessionId,
        client: context.client,
        changedFiles: input.changedFiles,
        recentFiles: input.recentFiles,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

function buildStartWorkBriefStatus(
  hosted: HostedAttempt<TeamSyncWorkBriefResponse>
): StartWorkBriefStatus {
  if (hosted.status === "skipped") {
    return {
      status: "skipped",
      hostedStatus: hosted.status,
      message: "hosted project auth is not configured; only local Team Sync state was recorded",
      whatChangedLoaded: false,
    };
  }

  if (hosted.status === "error") {
    return {
      status: "error",
      hostedStatus: hosted.status,
      message: hosted.error ?? "hosted Start Work Brief could not be loaded",
      whatChangedLoaded: false,
    };
  }

  if (!hosted.data) {
    return {
      status: "error",
      hostedStatus: hosted.status,
      message: "hosted Start Work Brief response was empty",
      whatChangedLoaded: false,
    };
  }

  const { brief, whatChanged } = hosted.data;
  const nextActions = whatChanged.nextActions ?? [];
  return {
    status: "loaded",
    hostedStatus: hosted.status,
    message: "hosted Start Work Brief and What Changed context are loaded",
    whatChangedLoaded: true,
    generatedAt: brief.generatedAt,
    evidenceLevel: brief.evidenceLevel,
    changeCount: whatChanged.summary.changeCount,
    decisionCount: whatChanged.summary.decisionChanges,
    staleAssumptionCount: whatChanged.summary.staleAssumptions,
    failedJobCount: whatChanged.summary.failedJobs,
    overlapCount: whatChanged.summary.overlapClusters,
    nextActionCount: nextActions.length || whatChanged.recommendedActions.length,
    firstNextAction:
      nextActions[0]?.label ?? whatChanged.recommendedActions[0] ?? brief.recommendedActions[0],
  };
}

async function maybeCreateHostedHandoff(
  rootDir: string,
  input: {
    summary: string;
    task?: string;
    nextStep?: string;
    files: string[];
    attention?: "clear" | "watch" | "review" | "proof_required";
  }
): Promise<HostedAttempt<TeamSyncHandoffResponse>> {
  const client = createHostedClient(rootDir);
  if (!client) {
    return { status: "skipped" };
  }

  const context = readHostedContext(rootDir);
  try {
    return {
      status: "ok",
      data: await client.createTeamSyncHandoff({
        summary: input.summary,
        task: input.task,
        branch: readGitValue(rootDir, ["branch", "--show-current"]),
        baseSha: readGitValue(rootDir, ["rev-parse", "HEAD"]),
        headSha: readGitValue(rootDir, ["rev-parse", "HEAD"]),
        sessionId: context.sessionId,
        client: context.client,
        files: input.files,
        nextStep: input.nextStep,
        attention: input.attention,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function maybeGetHostedWhatChanged(
  rootDir: string,
  input: {
    since?: string;
    recentFiles: string[];
  }
): Promise<HostedAttempt<TeamSyncChangesResponse>> {
  const client = createHostedClient(rootDir);
  if (!client) {
    return { status: "skipped" };
  }

  const context = readHostedContext(rootDir);
  try {
    return {
      status: "ok",
      data: await client.getTeamSyncWhatChanged({
        since: input.since,
        branch: readGitValue(rootDir, ["branch", "--show-current"]),
        sessionId: context.sessionId,
        recentFiles: input.recentFiles,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

async function maybeGetHostedResume(
  rootDir: string,
  input: {
    task?: string;
    recentFiles: string[];
  }
): Promise<HostedAttempt<TeamSyncResumeResponse>> {
  const client = createHostedClient(rootDir);
  if (!client) {
    return { status: "skipped" };
  }

  const context = readHostedContext(rootDir);
  try {
    return {
      status: "ok",
      data: await client.getLatestTeamSyncHandoff({
        sessionId: context.sessionId,
        branch: readGitValue(rootDir, ["branch", "--show-current"]),
        task: input.task,
        recentFiles: input.recentFiles,
      }),
    };
  } catch (error) {
    return { status: "error", error: formatError(error) };
  }
}

function createHostedClient(rootDir: string) {
  const config = loadConfig({ cwd: rootDir });
  if (!config.apiKey) {
    return null;
  }

  return createClient(15000, { cwd: rootDir });
}

function readHostedContext(rootDir: string): HostedTeamSyncContext {
  const config = loadConfig({ cwd: rootDir });
  return {
    sessionId: normalizeOptionalString(config.sessionId),
    client: normalizeOptionalString(config.client),
  };
}

function resolveRootDir(dir?: string): string {
  return path.resolve(dir ?? process.cwd());
}

function matchesCompletionEvidence(
  item: TeamSyncWorkRecord,
  evidence: { workflowGoalText?: string; summaryText?: string; files: string[] }
): boolean {
  const itemText = normalizeCompletionText(item.summary);
  if (!itemText) {
    return false;
  }

  const evidenceTexts = [evidence.workflowGoalText, evidence.summaryText].filter(
    (value): value is string => Boolean(value)
  );
  if (evidenceTexts.some((text) => completionTextsMatch(itemText, text))) {
    return true;
  }

  if (evidence.workflowGoalText) {
    return false;
  }
  if (!teamSyncFilesOverlap(item.files, evidence.files)) {
    return false;
  }

  return Boolean(evidence.summaryText && significantTokenOverlap(itemText, evidence.summaryText));
}

function normalizeCompletionText(value: string | undefined): string | undefined {
  const normalized = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function completionTextsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 16 && longer.includes(shorter);
}

function teamSyncFilesOverlap(leftFiles: string[], rightFiles: string[]): boolean {
  if (leftFiles.length === 0 || rightFiles.length === 0) {
    return false;
  }

  return leftFiles.some((left) =>
    rightFiles.some((right) => normalizedFilePathOverlaps(left, right))
  );
}

function normalizedFilePathOverlaps(left: string, right: string): boolean {
  const leftPath = normalizeComparablePath(left);
  const rightPath = normalizeComparablePath(right);
  if (!leftPath || !rightPath) {
    return false;
  }
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}

function normalizeComparablePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

const COMPLETION_TOKEN_STOP_WORDS = new Set([
  "and",
  "api",
  "app",
  "dev",
  "fix",
  "for",
  "from",
  "into",
  "main",
  "prod",
  "production",
  "release",
  "the",
  "then",
  "to",
  "with",
  "work",
]);

function significantTokenOverlap(left: string, right: string): boolean {
  const leftTokens = completionTokens(left);
  const rightTokens = completionTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  const overlap = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return overlap >= 2 && overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.25;
}

function completionTokens(value: string): Set<string> {
  return new Set(
    value.split(" ").filter((token) => token.length >= 3 && !COMPLETION_TOKEN_STOP_WORDS.has(token))
  );
}

function requireSummary(summary: string): string {
  const normalized = summary.trim();
  if (!normalized) {
    throw new Error("Team Sync summary is required");
  }
  return normalized;
}

function normalizeFiles(files: string[] | undefined): string[] {
  return Array.from(new Set((files ?? []).map((file) => file.trim()).filter(Boolean))).sort();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeAttention(value: string | undefined): TeamSyncAttention | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "note" || normalized === "watch" || normalized === "review") {
    return normalized;
  }
  if (normalized === "proof" || normalized === "critical") {
    return "proof";
  }
  if (normalized === "high") {
    return "review";
  }
  if (normalized === "medium") {
    return "watch";
  }
  if (normalized === "low") {
    return "note";
  }
  return undefined;
}

function mapHostedAttention(
  value: TeamSyncAttention | undefined
): "clear" | "watch" | "review" | "proof_required" | undefined {
  if (value === "note") {
    return "clear";
  }
  if (value === "watch" || value === "review") {
    return value;
  }
  if (value === "proof") {
    return "proof_required";
  }
  return undefined;
}

function normalizeWorkRecord(record: unknown): TeamSyncWorkRecord {
  const parsed = record as Partial<TeamSyncWorkRecord>;
  const createdAt =
    typeof parsed.createdAt === "string" && parsed.createdAt
      ? parsed.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof parsed.updatedAt === "string" && parsed.updatedAt
      ? parsed.updatedAt
      : typeof parsed.completedAt === "string" && parsed.completedAt
        ? parsed.completedAt
        : createdAt;

  return {
    id: typeof parsed.id === "string" ? parsed.id : buildRecordId("work", createdAt, "", []),
    type: "work",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    files: normalizeFiles(parsed.files),
    branch: normalizeOptionalString(parsed.branch),
    actor: normalizeOptionalString(parsed.actor),
    status:
      parsed.status === "completed" || parsed.status === "archived" ? parsed.status : "active",
    createdAt,
    updatedAt,
    completedAt: normalizeOptionalString(parsed.completedAt),
    completionReason: normalizeOptionalString(parsed.completionReason),
    archivedAt: normalizeOptionalString(parsed.archivedAt),
    archiveReason: normalizeOptionalString(parsed.archiveReason),
  };
}

function parsePositiveDays(value: string): number {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive integer");
  }
  return days;
}

function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("--since must be an ISO date or date-time");
  }
  return date;
}

function getWorkTimestamp(item: TeamSyncWorkRecord): number {
  const updatedAt = new Date(item.updatedAt || item.completedAt || item.createdAt).getTime();
  if (!Number.isNaN(updatedAt)) {
    return updatedAt;
  }
  return new Date(item.createdAt).getTime();
}

function isStaleWork(item: TeamSyncWorkRecord, now: Date): boolean {
  return now.getTime() - getWorkTimestamp(item) > TEAM_SYNC_STALE_WORK_MS;
}

function getTeamSyncHeading(action: string): string {
  if (action === "what-changed") {
    return "Team Sync summary";
  }
  if (action === "resume") {
    return "Team Sync resume context";
  }
  return `Team Sync ${action} recorded`;
}

function formatList(values: string[], limit: number): string {
  const items = values.filter(Boolean);
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}

function readGitValue(rootDir: string, args: string[]): string | undefined {
  try {
    const execOptions: ExecFileSyncOptionsWithStringEncoding = {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    };
    const output = execFileSync("git", args, execOptions).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRecordId(
  prefix: string,
  createdAt: string,
  summary: string,
  files: string[]
): string {
  const hash = createHash("sha1")
    .update([createdAt, summary, files.join(",")].join("\n"))
    .digest("hex")
    .slice(0, 10);
  return `${prefix}_${hash}`;
}
