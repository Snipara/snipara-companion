import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import {
  buildIntentDetectionFromTimeline,
  type ProjectIntentDetectionResult,
} from "../contracts/project-intelligence";
import { listWorkflowContinuityDirectory, readWorkflowContinuityFile } from "./workflow-continuity";

export const ACTIVITY_TIMELINE_VERSION = "snipara.activity_timeline.v0" as const;
export const SESSION_SNAPSHOT_VERSION = "snipara.session_snapshot.v0" as const;
export const ACTIVITY_RELATIVE_DIR = path.join(".snipara", "activity");
export const ACTIVITY_TIMELINE_RELATIVE_PATH = path.join(ACTIVITY_RELATIVE_DIR, "timeline.jsonl");
export const SESSION_SNAPSHOT_RELATIVE_PATH = path.join(ACTIVITY_RELATIVE_DIR, "session.json");
const MAX_ACTIVITY_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVITY_TIMELINE_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVITY_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVITY_DIRECTORY_ENTRIES = 256;

export type ActivityEventSource =
  | "workflow"
  | "tool"
  | "team-sync"
  | "decision"
  | "producer-loop"
  | "journal"
  | "orchestrator";

export interface ActivityTimelineEvent {
  schemaVersion: typeof ACTIVITY_TIMELINE_VERSION;
  eventId: string;
  timestamp: string;
  source: ActivityEventSource;
  kind: string;
  title: string;
  summary?: string;
  workflowId?: string;
  phaseId?: string;
  actor?: string;
  outcome?: string;
  files: string[];
  refs: string[];
  metadata: Record<string, unknown>;
}

export interface SessionSnapshot {
  schemaVersion: typeof SESSION_SNAPSHOT_VERSION;
  generatedAt: string;
  source: {
    cwd: string;
    timelinePath: string;
    snapshotPath: string;
  };
  workflow: {
    id?: string;
    goal?: string;
    status?: string;
    currentPhaseId?: string;
    currentPhaseTitle?: string;
  } | null;
  activity: {
    totalEvents: number;
    latestEventAt?: string;
    latestEvents: ActivityTimelineEvent[];
    countsBySource: Record<string, number>;
    countsByKind: Record<string, number>;
  };
  decisions: {
    pendingCount: number;
    resolvedCount: number;
    recurringResolvedFingerprintCount: number;
  };
  producerLoop: {
    artifactCount: number;
    reviewedCount: number;
    rejectedCount: number;
    unreviewedCount: number;
    hardGateReady: false;
  };
  teamSync: {
    activeWorkCount: number;
    handoffCount: number;
    latestHandoffAt?: string;
  };
  summary: {
    latestActivityAt?: string;
    latestActivityTitle?: string;
    latestActivityKind?: string;
    risk: "none" | "watch" | "risk";
    riskReasons: string[];
    touchedFiles: string[];
    recommendedNextAction: string;
  };
  intentDetection: ProjectIntentDetectionResult;
  routing: {
    hardRoutingAllowed: false;
    reason: string;
  };
  performance: {
    buildMs: number;
  };
  caveats: string[];
}

interface AppendActivityInput {
  source: ActivityEventSource;
  kind: string;
  title: string;
  summary?: string;
  workflowId?: string;
  phaseId?: string;
  actor?: string;
  outcome?: string;
  files?: string[];
  refs?: string[];
  metadata?: Record<string, unknown>;
  timestamp?: string;
  cwd?: string;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)])
    );
  }
  return value;
}

function hashEvent(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function readActivityArtifact(filePath: string, cwd: string, limit: number): Buffer | null {
  try {
    return readWorkflowContinuityFile({ cwd, relativePath: path.relative(path.resolve(cwd), path.resolve(filePath)), maxBytes: limit });
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("Local activity artifact is unsafe, unavailable or exceeds its bounded read limit");
  }
}

function jsonRecord(content: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("Invalid local activity JSON object");
  } catch {
    throw new Error("Local activity JSON artifact is invalid");
  }
}

function safeReadJson(filePath: string, cwd: string): Record<string, unknown> | null {
  const content = readActivityArtifact(filePath, cwd, MAX_ACTIVITY_JSON_BYTES);
  return content ? jsonRecord(content) : null;
}

function readJsonDir(dir: string, cwd: string): Record<string, unknown>[] {
  let entries: string[];
  try {
    entries = listWorkflowContinuityDirectory({ cwd, relativePath: path.relative(path.resolve(cwd), path.resolve(dir)), maxEntries: MAX_ACTIVITY_DIRECTORY_ENTRIES });
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error("Local activity directory is unsafe, unavailable or exceeds its bounded entry limit");
  }
  const result: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const name of entries.filter((item) => item.endsWith(".json"))) {
    const content = readActivityArtifact(path.join(dir, name), cwd, MAX_ACTIVITY_JSON_BYTES);
    if (!content) continue;
    bytes += content.length;
    if (bytes > MAX_ACTIVITY_DIRECTORY_BYTES) throw new Error("Local activity directory exceeds its bounded byte limit");
    const record = jsonRecord(content);
    if (record) result.push(record);
  }
  return result;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function getActivityTimelinePath(cwd: string = process.cwd()): string {
  return path.join(cwd, ACTIVITY_TIMELINE_RELATIVE_PATH);
}

export function getSessionSnapshotPath(cwd: string = process.cwd()): string {
  return path.join(cwd, SESSION_SNAPSHOT_RELATIVE_PATH);
}

export function appendActivityEvent(input: AppendActivityInput): ActivityTimelineEvent {
  const cwd = input.cwd ?? process.cwd();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const seed = {
    timestamp,
    source: input.source,
    kind: input.kind,
    title: input.title,
    workflowId: input.workflowId,
    phaseId: input.phaseId,
    refs: input.refs ?? [],
  };
  const event: ActivityTimelineEvent = {
    schemaVersion: ACTIVITY_TIMELINE_VERSION,
    eventId: `act_${hashEvent(seed)}`,
    timestamp,
    source: input.source,
    kind: input.kind,
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.phaseId ? { phaseId: input.phaseId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    files: uniqueStrings(input.files ?? []),
    refs: uniqueStrings(input.refs ?? []),
    metadata: input.metadata ?? {},
  };
  const timelinePath = getActivityTimelinePath(cwd);
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.appendFileSync(timelinePath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function readActivityTimeline(
  options: {
    cwd?: string;
    limit?: number;
  } = {}
): ActivityTimelineEvent[] {
  const timelinePath = getActivityTimelinePath(options.cwd);
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;
  const content = readActivityArtifact(timelinePath, options.cwd ?? process.cwd(), MAX_ACTIVITY_TIMELINE_BYTES);
  const lines = content ? content.toString("utf8").split(/\r?\n/).filter(Boolean) : [];
  const events = lines
    .map((line) => {
      try {
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== "object" || !("timestamp" in event) || typeof event.timestamp !== "string")
          throw new Error("Invalid local activity event");
        return event as ActivityTimelineEvent;
      } catch {
        throw new Error("Local activity timeline contains an invalid event");
      }
    })
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  return limit ? events.slice(0, limit) : events;
}

function workflowSnapshot(cwd: string): SessionSnapshot["workflow"] {
  const state = safeReadJson(path.join(cwd, ".snipara", "workflow", "current.json"), cwd);
  if (!state) {
    return null;
  }
  const phases = Array.isArray(state.phases) ? (state.phases as Record<string, unknown>[]) : [];
  const currentPhase = phases.find((phase) => phase.id === state.currentPhaseId);
  return {
    id: typeof state.workflowId === "string" ? state.workflowId : undefined,
    goal: typeof state.goal === "string" ? state.goal : undefined,
    status: typeof state.status === "string" ? state.status : undefined,
    currentPhaseId: typeof state.currentPhaseId === "string" ? state.currentPhaseId : undefined,
    currentPhaseTitle:
      currentPhase && typeof currentPhase.title === "string" ? currentPhase.title : undefined,
  };
}

function countDecisionFingerprintRepeats(records: Record<string, unknown>[]): number {
  const counts = countBy(records, (record) => {
    const request = record.request;
    return request && typeof request === "object"
      ? String((request as Record<string, unknown>).fingerprint ?? "")
      : "";
  });
  return Object.values(counts).filter((count) => count > 1).length;
}

function producerLoopSummary(cwd: string): SessionSnapshot["producerLoop"] {
  const records = readJsonDir(path.join(cwd, ".snipara", "producer-loop"), cwd);
  let reviewedCount = 0;
  let rejectedCount = 0;
  let unreviewedCount = 0;
  for (const record of records) {
    const review = record.review;
    const calibration = record.calibration;
    const status =
      review && typeof review === "object"
        ? (review as Record<string, unknown>).status
        : calibration && typeof calibration === "object"
          ? (calibration as Record<string, unknown>).status
          : undefined;
    if (status === "sample_reviewed") reviewedCount += 1;
    else if (status === "sample_rejected") rejectedCount += 1;
    else unreviewedCount += 1;
  }
  return {
    artifactCount: records.length,
    reviewedCount,
    rejectedCount,
    unreviewedCount,
    hardGateReady: false,
  };
}

function teamSyncSnapshot(cwd: string): SessionSnapshot["teamSync"] {
  const state = safeReadJson(path.join(cwd, ".snipara", "team-sync", "session.json"), cwd);
  const work = Array.isArray(state?.work) ? (state?.work as Record<string, unknown>[]) : [];
  const handoffs = Array.isArray(state?.handoffs)
    ? (state?.handoffs as Record<string, unknown>[])
    : [];
  const latestHandoffAt = handoffs
    .map((handoff) => (typeof handoff.createdAt === "string" ? handoff.createdAt : undefined))
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    activeWorkCount: work.filter((item) => item.status === "active").length,
    handoffCount: handoffs.length,
    ...(latestHandoffAt ? { latestHandoffAt } : {}),
  };
}

function deriveSessionSnapshotSummary(args: {
  workflow: SessionSnapshot["workflow"];
  latestEvents: ActivityTimelineEvent[];
  pendingDecisionCount: number;
  producerLoop: SessionSnapshot["producerLoop"];
  teamSync: SessionSnapshot["teamSync"];
}): SessionSnapshot["summary"] {
  const riskReasons: string[] = [];
  if (args.pendingDecisionCount > 0) {
    riskReasons.push(`${args.pendingDecisionCount} pending decision request(s)`);
  }
  if (args.producerLoop.unreviewedCount > 0) {
    riskReasons.push(`${args.producerLoop.unreviewedCount} unreviewed Producer Loop artifact(s)`);
  }
  if (args.teamSync.activeWorkCount > 0) {
    riskReasons.push(`${args.teamSync.activeWorkCount} active Team Sync work item(s)`);
  }
  if (args.workflow?.status === "blocked") {
    riskReasons.push("workflow is blocked");
  }
  const touchedFiles = uniqueStrings(args.latestEvents.flatMap((event) => event.files)).slice(
    0,
    20
  );
  const latestActivity = args.latestEvents[0];
  const risk = riskReasons.length >= 2 ? "risk" : riskReasons.length === 1 ? "watch" : "none";
  const recommendedNextAction =
    args.workflow?.status === "completed"
      ? "Start the next managed workflow or export the timeline for handoff."
      : args.workflow?.currentPhaseId
        ? `Continue phase ${args.workflow.currentPhaseId} or commit it when verified.`
        : args.pendingDecisionCount > 0
          ? "Resolve pending decision requests before applying follow-up actions."
          : "Review the latest activity and run the next verification command.";

  return {
    ...(latestActivity?.timestamp ? { latestActivityAt: latestActivity.timestamp } : {}),
    ...(latestActivity?.title ? { latestActivityTitle: latestActivity.title } : {}),
    ...(latestActivity?.kind ? { latestActivityKind: latestActivity.kind } : {}),
    risk,
    riskReasons,
    touchedFiles,
    recommendedNextAction,
  };
}

export function buildSessionSnapshot(
  options: {
    cwd?: string;
    limit?: number;
  } = {}
): SessionSnapshot {
  const startedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const events = readActivityTimeline({ cwd });
  const latestEvents = events.slice(0, options.limit && options.limit > 0 ? options.limit : 20);
  const pendingDecisions = readJsonDir(path.join(cwd, ".snipara", "decisions", "pending"), cwd);
  const resolvedDecisions = readJsonDir(path.join(cwd, ".snipara", "decisions", "resolved"), cwd);
  const workflow = workflowSnapshot(cwd);
  const producerLoop = producerLoopSummary(cwd);
  const teamSync = teamSyncSnapshot(cwd);
  const snapshot: SessionSnapshot = {
    schemaVersion: SESSION_SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      cwd,
      timelinePath: getActivityTimelinePath(cwd),
      snapshotPath: getSessionSnapshotPath(cwd),
    },
    workflow,
    activity: {
      totalEvents: events.length,
      ...(events[0]?.timestamp ? { latestEventAt: events[0].timestamp } : {}),
      latestEvents,
      countsBySource: countBy(events, (event) => event.source),
      countsByKind: countBy(events, (event) => event.kind),
    },
    decisions: {
      pendingCount: pendingDecisions.length,
      resolvedCount: resolvedDecisions.length,
      recurringResolvedFingerprintCount: countDecisionFingerprintRepeats(resolvedDecisions),
    },
    producerLoop,
    teamSync,
    summary: deriveSessionSnapshotSummary({
      workflow,
      latestEvents,
      pendingDecisionCount: pendingDecisions.length,
      producerLoop,
      teamSync,
    }),
    intentDetection: buildIntentDetectionFromTimeline(
      latestEvents.map((event) => ({
        kind: event.kind,
        source: event.source,
        title: event.title,
        summary: event.summary,
        outcome: event.outcome,
        files: event.files,
        metadata: event.metadata,
      }))
    ),
    routing: {
      hardRoutingAllowed: false,
      reason:
        "Session Snapshot V0 is observational only; hard routing needs explicit policy and receipt gates.",
    },
    performance: {
      buildMs: Date.now() - startedAt,
    },
    caveats: [
      "Snapshot is derived from local artifacts and may not include hosted-only context.",
      "Append-only activity events are local evidence, not server-side attestation.",
    ],
  };
  return snapshot;
}

export function writeSessionSnapshot(
  options: { cwd?: string; limit?: number } = {}
): SessionSnapshot {
  const cwd = options.cwd ?? process.cwd();
  const snapshot = buildSessionSnapshot({ cwd, limit: options.limit });
  const snapshotPath = getSessionSnapshotPath(cwd);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export function readSessionSnapshot(cwd: string = process.cwd()): SessionSnapshot | null {
  const parsed = safeReadJson(getSessionSnapshotPath(cwd), cwd);
  if (
    parsed?.schemaVersion === SESSION_SNAPSHOT_VERSION &&
    parsed.summary &&
    parsed.intentDetection
  ) {
    return parsed as unknown as SessionSnapshot;
  }
  return null;
}
