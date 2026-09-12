import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface SessionCheckpoint {
  sessionId: string;
  summary: string;
  files: string[];
}

export interface SessionCloseout {
  version: "snipara.session_closeout.v1";
  workspace: string;
  projectId: string;
  checkpoint: SessionCheckpoint;
  status: "pending" | "saved" | "skipped" | "error";
  updatedAt: string;
  entryId?: string;
  journalDate?: string;
  eventDelivered?: boolean;
  error?: string;
}

// Only bounded session summaries and file names belong in a checkpoint, never
// raw transcripts or command output. Redact common credentials before disk/network.
export function checkpointText(value: string, limit = 12000): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|snp|rlm)[_-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED KEY]")
    .replace(
      /\b([\w-]*(?:api[_-]?key|token|password|passwd|secret)[\w-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]"
    )
    .trim()
    .slice(0, limit);
}

export function normalizeSessionCheckpoint(input: {
  sessionId: string;
  summary?: string;
  files?: string[];
}): SessionCheckpoint {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.sessionId)) {
    throw new Error(
      "Session id must contain 1-200 letters, digits, dots, colons, underscores or hyphens"
    );
  }
  return {
    sessionId: input.sessionId,
    summary: checkpointText(input.summary ?? ""),
    files: [
      ...new Set((input.files ?? []).map((file) => checkpointText(file, 500)).filter(Boolean)),
    ]
      .sort()
      .slice(0, 100),
  };
}

export function sessionCloseoutPath(
  cwd: string,
  projectId: string,
  checkpoint: SessionCheckpoint
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectId, checkpoint }))
    .digest("hex");
  return path.join(cwd, ".snipara", "companion", "session-closeouts", `${digest}.json`);
}

export function lockSessionCloseout(file: string): number {
  const lockPath = `${file}.lock`;
  if (fs.existsSync(lockPath)) {
    const owner = Number(fs.readFileSync(lockPath, "utf8"));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          fs.unlinkSync(lockPath);
        }
      }
    }
  }
  const lock = fs.openSync(lockPath, "wx", 0o600);
  fs.writeSync(lock, String(process.pid));
  return lock;
}

export function readSessionCloseout(file: string): SessionCloseout | undefined {
  if (!fs.existsSync(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as SessionCloseout;
  if (
    value.version !== "snipara.session_closeout.v1" ||
    typeof value.workspace !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.checkpoint?.sessionId !== "string" ||
    typeof value.checkpoint.summary !== "string" ||
    !Array.isArray(value.checkpoint.files) ||
    !value.checkpoint.files.every((file) => typeof file === "string") ||
    (value.status === "saved" && (typeof value.entryId !== "string" || !value.entryId.trim())) ||
    !["pending", "saved", "skipped", "error"].includes(value.status)
  ) {
    throw new Error("Invalid session closeout receipt");
  }
  return value;
}

export function writeSessionCloseout(file: string, value: SessionCloseout): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}
