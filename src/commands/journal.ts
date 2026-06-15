/**
 * Journal checkpoints — append-only continuity log helpers.
 *
 * Builds and appends checkpoint entries (action, summary, outcome, phase,
 * files, next step) used by workflow phase commits and Team Sync handoffs to
 * record a durable, tagged trail of what happened. Pure formatting plus a
 * fail-soft write that no-ops when the workspace is unconfigured.
 */
import { createClient } from "../api/client";
import { isConfigured } from "../config/store";

export interface JournalCheckpointPayload {
  action: string;
  summary: string;
  outcome?: string;
  workflowId?: string;
  phaseId?: string;
  phaseTitle?: string;
  branch?: string;
  actor?: string;
  next?: string;
  attention?: string;
  files?: string[];
  cwd?: string;
}

export interface JournalWriteResult {
  status: "skipped" | "ok" | "error";
  error?: string;
}

function uniqueStrings(values?: string[]): string[] {
  if (!values) {
    return [];
  }
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function journalTags(payload: JournalCheckpointPayload): string[] {
  const tags = [
    "companion",
    "checkpoint",
    payload.action,
    payload.workflowId ? "workflow" : null,
    payload.phaseId ? "phase" : null,
    payload.outcome ? `outcome:${payload.outcome}` : null,
  ];

  return tags.filter((tag): tag is string => Boolean(tag));
}

export function buildJournalCheckpointEntry(payload: JournalCheckpointPayload): {
  text: string;
  tags: string[];
} {
  const lines = [
    `Checkpoint: ${payload.action}`,
    `Summary: ${payload.summary}`,
    payload.workflowId ? `Workflow: ${payload.workflowId}` : null,
    payload.phaseId
      ? `Phase: ${payload.phaseId}${payload.phaseTitle ? ` (${payload.phaseTitle})` : ""}`
      : null,
    payload.outcome ? `Outcome: ${payload.outcome}` : null,
    payload.branch ? `Branch: ${payload.branch}` : null,
    payload.actor ? `Actor: ${payload.actor}` : null,
    payload.attention ? `Attention: ${payload.attention}` : null,
    payload.next ? `Next: ${payload.next}` : null,
    uniqueStrings(payload.files).length > 0
      ? `Files: ${uniqueStrings(payload.files).join(", ")}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return {
    text: lines.join("\n"),
    tags: journalTags(payload),
  };
}

export async function appendJournalCheckpoint(
  payload: JournalCheckpointPayload
): Promise<JournalWriteResult> {
  const cwd = payload.cwd;
  if (!isConfigured({ cwd })) {
    return { status: "skipped" };
  }

  const entry = buildJournalCheckpointEntry(payload);

  try {
    const client = createClient(15000, cwd ? { cwd } : {});
    await client.journalAppend(entry.text, entry.tags);
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
