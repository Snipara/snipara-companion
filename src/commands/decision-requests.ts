import * as fs from "node:fs";
import * as path from "node:path";
import {
  DECISION_REQUEST_RELATIVE_DIR,
  buildDecisionResponse,
  decisionRequestStatus,
  isDecisionRequest,
  stableDecisionJsonStringify,
  type DecisionRequest,
  type DecisionResponse,
} from "../contracts/project-intelligence";

export interface DecisionRequestWriteResult {
  status: "written" | "duplicate_pending" | "duplicate_resolved";
  requestId: string;
  fingerprint: string;
  path?: string;
  relativePath?: string;
}

export interface ResolvedDecisionRecord {
  schemaVersion: "snipara.decision_resolution.v0";
  request: DecisionRequest;
  response: DecisionResponse;
}

export interface DecisionRequestListEntry {
  request: DecisionRequest;
  status: "pending" | "expired_pending";
  path: string;
  relativePath: string;
}

export function decisionPendingDir(cwd: string = process.cwd()): string {
  return path.join(cwd, DECISION_REQUEST_RELATIVE_DIR, "pending");
}

export function decisionResolvedDir(cwd: string = process.cwd()): string {
  return path.join(cwd, DECISION_REQUEST_RELATIVE_DIR, "resolved");
}

export function ensureDecisionDirs(cwd: string = process.cwd()): void {
  fs.mkdirSync(decisionPendingDir(cwd), { recursive: true });
  fs.mkdirSync(decisionResolvedDir(cwd), { recursive: true });
}

export function writeDecisionRequest(
  request: DecisionRequest,
  cwd: string = process.cwd()
): DecisionRequestWriteResult {
  ensureDecisionDirs(cwd);
  const resolvedFingerprints = listResolvedDecisionRecords(cwd).map(
    (record) => record.request.fingerprint
  );
  if (resolvedFingerprints.includes(request.fingerprint)) {
    return {
      status: "duplicate_resolved",
      requestId: request.requestId,
      fingerprint: request.fingerprint,
    };
  }
  const pending = listPendingDecisionRequests(cwd);
  const existing = pending.find((entry) => entry.request.fingerprint === request.fingerprint);
  if (existing) {
    return {
      status: "duplicate_pending",
      requestId: existing.request.requestId,
      fingerprint: existing.request.fingerprint,
      path: existing.path,
      relativePath: existing.relativePath,
    };
  }
  const filePath = path.join(decisionPendingDir(cwd), `${request.requestId}.json`);
  fs.writeFileSync(filePath, `${stableDecisionJsonStringify(request)}\n`, "utf8");
  return {
    status: "written",
    requestId: request.requestId,
    fingerprint: request.fingerprint,
    path: filePath,
    relativePath: toProjectRelativePath(filePath, cwd),
  };
}

export function listPendingDecisionRequests(
  cwd: string = process.cwd()
): DecisionRequestListEntry[] {
  ensureDecisionDirs(cwd);
  const resolved = new Set(
    listResolvedDecisionRecords(cwd).map((record) => record.request.fingerprint)
  );
  return fs
    .readdirSync(decisionPendingDir(cwd))
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(decisionPendingDir(cwd), fileName))
    .sort()
    .map((filePath) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!isDecisionRequest(parsed)) {
        throw new Error(
          `Invalid decision request artifact: ${toProjectRelativePath(filePath, cwd)}`
        );
      }
      const status = decisionRequestStatus(parsed, resolved);
      return {
        request: parsed,
        status: status === "resolved" ? "pending" : status,
        path: filePath,
        relativePath: toProjectRelativePath(filePath, cwd),
      };
    });
}

export function listResolvedDecisionRecords(cwd: string = process.cwd()): ResolvedDecisionRecord[] {
  fs.mkdirSync(decisionResolvedDir(cwd), { recursive: true });
  return fs
    .readdirSync(decisionResolvedDir(cwd))
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(decisionResolvedDir(cwd), fileName))
    .sort()
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")) as ResolvedDecisionRecord)
    .filter((record) => record?.schemaVersion === "snipara.decision_resolution.v0");
}

export function resolveDecisionRequest(options: {
  requestId: string;
  choice: string;
  reviewer: string;
  note?: string;
  appliedActions?: string[];
  cwd?: string;
}): { request: DecisionRequest; response: DecisionResponse; resolvedPath: string } {
  const cwd = options.cwd ?? process.cwd();
  ensureDecisionDirs(cwd);
  const entry = listPendingDecisionRequests(cwd).find(
    (candidate) =>
      candidate.request.requestId === options.requestId ||
      candidate.request.fingerprint === options.requestId
  );
  if (!entry) {
    throw new Error(`No pending decision request matched '${options.requestId}'.`);
  }
  if (!entry.request.options.includes(options.choice)) {
    throw new Error(
      `Invalid choice '${options.choice}'. Valid options: ${entry.request.options.join(", ")}.`
    );
  }
  const response = buildDecisionResponse({
    requestId: entry.request.requestId,
    choice: options.choice,
    reviewer: options.reviewer,
    note: options.note,
    appliedActions: options.appliedActions ?? [],
  });
  const record: ResolvedDecisionRecord = {
    schemaVersion: "snipara.decision_resolution.v0",
    request: entry.request,
    response,
  };
  const resolvedPath = path.join(decisionResolvedDir(cwd), `${entry.request.requestId}.json`);
  fs.writeFileSync(resolvedPath, `${stableDecisionJsonStringify(record)}\n`, "utf8");
  fs.unlinkSync(entry.path);
  return { request: entry.request, response, resolvedPath };
}

export function decisionPendingCount(cwd: string = process.cwd()): number {
  return listPendingDecisionRequests(cwd).filter((entry) => entry.status === "pending").length;
}

function toProjectRelativePath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`.replace(/\\/g, "/");
}
