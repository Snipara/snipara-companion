/**
 * `session` commands — local session lifecycle.
 *
 * `session-end` persists an explicit checkpoint and keeps a local receipt.
 * The session id rotates only after confirmed persistence; `session status` and
 * `session reset` inspect and clear local session state. All commands no-op
 * cleanly when the workspace is not configured.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "../api/client";
import { isConfigured, loadConfig, saveConfig } from "../config/store";
import { emitCanonicalEvent } from "./events";
import {
  normalizeSessionCheckpoint,
  lockSessionCloseout,
  readSessionCloseout,
  sessionCloseoutPath,
  writeSessionCloseout,
  type SessionCloseout,
} from "../session/checkpoint";

export interface SessionEndOptions {
  summary?: string;
  files?: string[];
  sessionId?: string;
  retry?: string;
  json?: boolean;
}

function printCloseout(report: SessionCloseout, file: string, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ...report, reportPath: file }, null, 2));
    return;
  }
  const message =
    report.status === "saved"
      ? `Session saved to journal (${report.checkpoint.files.length} files; entry ${report.entryId})`
      : report.status === "skipped"
        ? "Session checkpoint skipped: no summary or files supplied"
        : "Session NOT saved; local checkpoint retained for retry";
  console.log(`${message}\nReceipt: ${file}`);
  if (report.status === "error" || report.status === "pending") {
    console.error(`Retry: snipara-companion session-end --retry ${JSON.stringify(file)}`);
  }
  if (report.status === "saved" && report.eventDelivered === false) {
    console.error("Journal saved; automation event delivery was not confirmed.");
  }
}

/**
 * Session end handler: Persist session context
 */
export async function sessionEndCommand(options: SessionEndOptions = {}): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    console.log(
      options.json
        ? JSON.stringify({ status: "skipped", reason: "not_configured", reportPath: null })
        : "Not configured. Run 'npx -y snipara-companion@latest init' first."
    );
    return;
  }

  const cwd = path.resolve(process.env.SNIPARA_WORKSPACE_DIR || process.cwd());
  const config = loadConfig();
  const previous = options.retry ? readSessionCloseout(path.resolve(options.retry)) : undefined;
  if (
    options.retry &&
    (!previous || previous.workspace !== cwd || previous.projectId !== config.projectId)
  ) {
    throw new Error("Retry receipt does not belong to this workspace and project");
  }
  const checkpoint = normalizeSessionCheckpoint(
    previous?.checkpoint ?? {
      sessionId: options.sessionId ?? config.sessionId ?? `sess_${randomUUID()}`,
      summary: options.summary,
      files: options.files,
    }
  );
  const file = sessionCloseoutPath(cwd, config.projectId!, checkpoint);
  const existing = readSessionCloseout(file);
  if (existing?.status === "saved" && existing.entryId) {
    printCloseout(existing, file, options.json);
    return;
  }
  const report: SessionCloseout = {
    version: "snipara.session_closeout.v1",
    workspace: cwd,
    projectId: config.projectId!,
    checkpoint,
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A second Stop hook must not write the same checkpoint concurrently.
  const lock = lockSessionCloseout(file);
  try {
    const confirmed = readSessionCloseout(file);
    if (confirmed?.status === "saved" && confirmed.entryId) {
      printCloseout(confirmed, file, options.json);
      return;
    }
    writeSessionCloseout(file, report);
    try {
      const result = await createClient(15000).persistSession(checkpoint);
      report.status = result.status;
      report.entryId = result.entry_id;
      report.journalDate = result.date;
    } catch {
      report.status = "error";
      report.error =
        "Hosted journal persistence was not confirmed. The checkpoint is retained locally.";
      process.exitCode = 1;
    }
    // Record the journal receipt before telemetry or session rotation. Retrying
    // a confirmed checkpoint must never append a duplicate journal entry.
    writeSessionCloseout(file, report);
    report.eventDelivered = await emitCanonicalEvent(
      {
        eventType: "session_end",
        sessionId: checkpoint.sessionId,
        payload: {
          persisted: report.status === "saved",
          persistence_status: report.status,
          files_tracked: checkpoint.files.length,
          ...(report.entryId ? { journal_entry_id: report.entryId } : {}),
        },
      },
      { timeoutMs: 2000 }
    );
    writeSessionCloseout(file, report);
    writeSessionCloseout(path.join(cwd, ".snipara", "companion", "session-closeout.json"), report);
    if (
      report.status === "saved" &&
      !options.sessionId &&
      loadConfig().sessionId === checkpoint.sessionId
    ) {
      saveConfig({ sessionId: `sess_${randomUUID()}` });
    }
    printCloseout(report, file, options.json);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(`${file}.lock`);
  }
}

/**
 * Get current session status
 */
export async function sessionStatusCommand(): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }

  const config = loadConfig();

  console.log("\n📊 Session Status\n");
  console.log(`Session ID: ${config.sessionId || "none"}`);
  const reportFile = path.join(
    process.env.SNIPARA_WORKSPACE_DIR || process.cwd(),
    ".snipara",
    "companion",
    "session-closeout.json"
  );
  const report = readSessionCloseout(reportFile);
  if (report) {
    console.log(`Last checkpoint: ${report.status}${report.entryId ? ` (${report.entryId})` : ""}`);
    console.log(`Receipt: ${reportFile}`);
  }

  try {
    const client = createClient(5000);
    const status = await client.getSession();

    console.log(`Files tracked: ${status.files_tracked}`);
    console.log("Status: Active");
  } catch {
    console.log("Status: Offline (cannot reach API)");
  }

  console.log();
}

/**
 * Reset session (start fresh)
 */
export function sessionResetCommand(): void {
  const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  saveConfig({ sessionId: newSessionId });

  console.log("✓ Session reset");
  console.log(`New session ID: ${newSessionId}`);
}
