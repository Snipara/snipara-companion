/** Read-only Controller snapshots. Reporting never grants execution authority. */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT_STATUSES = new Set([
  "active",
  "paused",
  "needs_human",
  "completed",
  "awaiting_acceptance",
  "accepted",
  "acceptance_failed",
  "acceptance_inconclusive",
  "stopped",
]);
const TASK_STATUSES = new Set([
  "pending",
  "ready",
  "assigned",
  "running",
  "retry_wait",
  "waiting_recovery",
  "recovery_standby",
  "completed",
  "skipped",
  "blocked",
  "needs_human",
  "canceled",
]);

export interface ControllerProgress {
  version: "snipara.companion_controller_progress.v1";
  controllerId: string;
  sourceHash: string;
  revision: number;
  reportedStatus: string;
  baseSha: string;
  updatedAt: string;
  freshness: "fresh" | "stale";
  tasks: Array<{
    taskId: string;
    reportedStatus: string;
    dependsOn: string[];
    workerId: string | null;
  }>;
  authority: "unverified_local_snapshot";
  executionAllowed: false;
  reviewRequired: true;
  nextAction: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error("Controller snapshot has an invalid identifier");
  }
  return value;
}

/** Strict whitelisted projection; provider config, prompts and secrets are excluded. */
export function readControllerProgress(
  file: string,
  cwd: string,
  now: Date = new Date()
): ControllerProgress {
  const resolved = path.resolve(cwd, file);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Controller snapshot must be a regular file");
    if (stat.size > MAX_BYTES) throw new Error("Controller snapshot exceeds 2 MiB");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, null);
      if (count === 0) break;
      read += count;
    }
    bytes = buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  if (bytes.length > MAX_BYTES) throw new Error("Controller snapshot exceeds 2 MiB");
  const state: unknown = JSON.parse(bytes.toString("utf8"));
  if (!record(state) || state.schemaVersion !== "snipara.project_controller.v1") {
    throw new Error("Unsupported Controller snapshot schema");
  }
  if (
    typeof state.workspaceRoot !== "string" ||
    fs.realpathSync(state.workspaceRoot) !== fs.realpathSync(cwd)
  ) {
    throw new Error("Controller snapshot belongs to a different workspace");
  }
  if (
    typeof state.status !== "string" ||
    !PROJECT_STATUSES.has(state.status) ||
    typeof state.revision !== "number" ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !record(state.tasks) ||
    Object.keys(state.tasks).length === 0 ||
    Object.keys(state.tasks).length > 256
  ) {
    throw new Error("Controller snapshot has invalid state or task bounds");
  }
  if (typeof state.baseSha !== "string" || !/^[a-f0-9]{40}$/i.test(state.baseSha)) {
    throw new Error("Controller snapshot has an invalid base SHA");
  }
  if (typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new Error("Controller snapshot has an invalid timestamp");
  }
  const updated = Date.parse(state.updatedAt);
  if (updated > now.getTime() + 60_000) throw new Error("Controller snapshot is future-dated");
  const tasks = Object.entries(state.tasks).map(([key, value]) => {
    boundedId(key);
    if (
      !record(value) ||
      value.id !== key ||
      typeof value.status !== "string" ||
      !TASK_STATUSES.has(value.status) ||
      !Array.isArray(value.dependsOn) ||
      value.dependsOn.length > 256
    ) {
      throw new Error("Controller snapshot has an invalid task or key mismatch");
    }
    const dependsOn = value.dependsOn.map(boundedId);
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(key)) {
      throw new Error("Controller snapshot has invalid dependencies");
    }
    return {
      taskId: key,
      reportedStatus: value.status,
      dependsOn,
      workerId: value.assignedWorkerId == null ? null : boundedId(value.assignedWorkerId),
    };
  });
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (tasks.some((task) => task.dependsOn.some((id) => !taskIds.has(id)))) {
    throw new Error("Controller snapshot has an unknown dependency");
  }
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Controller snapshot has cyclic dependencies");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taskIds) visit(id);
  const freshness = now.getTime() - updated > 30 * 60_000 ? "stale" : "fresh";
  return {
    version: "snipara.companion_controller_progress.v1",
    controllerId: boundedId(state.controllerId),
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
    revision: state.revision,
    reportedStatus: state.status,
    baseSha: state.baseSha.toLowerCase(),
    updatedAt: state.updatedAt,
    freshness,
    tasks,
    authority: "unverified_local_snapshot",
    executionAllowed: false,
    reviewRequired: true,
    nextAction:
      freshness === "stale"
        ? "Refresh Controller status before relying on this snapshot."
        : "Inspect source-bound proof and independent review; reported completion grants no authority.",
  };
}
