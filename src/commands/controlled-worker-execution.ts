import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import chalk from "chalk";
import {
  buildControlledWorkerExecutionReceipt,
  controlledWorkerExecutionReceiptToUnifiedEnvelope,
  deriveWorkerTrustCategory,
  evaluateWorkerTrustGate,
  hashWorkerProfileContent,
  isWorkerTrustEvent,
  normalizeWorkerProfile,
  stableWorkerProfileJsonStringify,
  type ControlledWorkerExecutionMode,
  type ControlledWorkerExecutionReceipt,
  type ControlledWorkerExecutionStatus,
  type UnifiedReceiptEnvelope,
  type WorkerTrustCategory,
  type WorkerTrustEvent,
} from "../contracts/project-intelligence";
import { findWorkspaceRoot } from "../config/store";
import { listResolvedDecisionRecords } from "./decision-requests";

const CONTROLLED_WORKER_EXECUTIONS_DIR = path.join(".snipara", "worker-executions");
const UNIFIED_RECEIPTS_DIR = path.join(".snipara", "unified-receipts");
const HIGH_RISK_COMMAND_PATTERN =
  /\b(git\s+push|git\s+reset|git\s+checkout\s+--|rm\s+-rf|prisma\s+migrate\s+reset|prisma\s+db\s+push\s+--accept-data-loss|npm\s+publish|pnpm\s+publish|twine\s+upload|deploy-zero-downtime|ssh\s+)\b|[;&|`$<>]/i;

interface GitScopeSnapshot {
  head: string | null;
  files: Map<string, string>;
}

export interface ControlledWorkerExecuteOptions {
  task: string;
  workerId?: string;
  workerRole?: string;
  endpointType?: "local" | "cloud" | "self_hosted" | "unknown";
  mode?: ControlledWorkerExecutionMode;
  command?: string;
  commandArgs?: string[];
  execute?: boolean;
  approvalReceipt?: string;
  outcomeReceipt?: string;
  writeScope?: string[];
  acceptance?: string[];
  proof?: string[];
  workCategory?: WorkerTrustCategory;
  trustEvent?: string;
  profileHash?: string;
  provider?: string;
  model?: string;
  output?: string;
  projectId?: string;
  unifiedOutput?: string;
  dir?: string;
  json?: boolean;
}

export interface ControlledWorkerExecuteResult {
  executed: boolean;
  blocked: boolean;
  receiptPath: string;
  unifiedReceiptPath: string | null;
  receipt: ControlledWorkerExecutionReceipt;
  unifiedReceipt: UnifiedReceiptEnvelope<ControlledWorkerExecutionReceipt> | null;
}

export function controlledWorkerExecuteCommand(
  options: ControlledWorkerExecuteOptions
): ControlledWorkerExecuteResult {
  const workspaceRoot =
    findWorkspaceRoot(options.dir ?? process.cwd(), true) ?? path.resolve(options.dir ?? ".");
  const execute = Boolean(options.execute);
  const mode = normalizeMode(options.mode, execute);
  const commandArgs = normalizeCommandArgs(options.commandArgs);
  const legacyCommand = stringValue(options.command);
  const command = commandArgs.length > 0 ? commandArgs.join(" ") : legacyCommand;
  const risk = command ? commandRisk(command) : "none";
  const workCategory = deriveWorkerTrustCategory({
    declared: options.workCategory,
    task: options.task,
    writeScope: options.writeScope,
  });
  const profileHash = currentWorkerProfileHash(workspaceRoot, options.workerId);
  const trustEvent = loadWorkerTrustEvent({
    workspaceRoot,
    workerId: options.workerId,
    workCategory,
    eventPath: options.trustEvent,
  });
  const trustGate = evaluateWorkerTrustGate({
    event: mode === "auto_low_risk" ? trustEvent : null,
    workerId: options.workerId ?? "unassigned-worker",
    workCategory,
    profileHash: profileHash ?? "sha256:missing",
    requestedWriteScope: options.writeScope ?? [],
    risk: risk === "low" ? "low" : "high",
    explicitExecute: execute,
    proofRequired: options.proof ?? [],
  });
  const delegatedRequiresArgv = trustGate.delegated && commandArgs.length === 0;
  const delegated = trustGate.delegated && !delegatedRequiresArgv;
  const missingApproval = execute && !options.approvalReceipt && !delegated;
  const missingCommand = execute && !command;
  const missingProof = execute && (options.proof?.length ?? 0) === 0;
  const unsafeWriteScope = (options.writeScope ?? []).some((scope) => !isSafeScope(scope));
  const expectedProfileMismatch = Boolean(
    options.profileHash && options.profileHash !== profileHash
  );
  const beforeScopeSnapshot = delegated && execute ? gitScopeSnapshot(workspaceRoot) : null;
  const missingScopeProof = delegated && execute && !beforeScopeSnapshot;
  let blocked =
    missingApproval ||
    missingCommand ||
    missingProof ||
    risk === "high" ||
    delegatedRequiresArgv ||
    unsafeWriteScope ||
    expectedProfileMismatch ||
    missingScopeProof;
  const reasonCodes = new Set<string>();
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let durationMs: number | null = null;
  let executionAttempted = false;
  let changedFiles: string[] = [];
  let scopeViolations: string[] = [];

  if (execute) reasonCodes.add("controlled_worker_execution_requested");
  if (!execute) reasonCodes.add("controlled_worker_execution_dry_run_only");
  if (missingApproval) reasonCodes.add("controlled_worker_execution_missing_approval");
  if (missingCommand) reasonCodes.add("controlled_worker_execution_missing_command");
  if (missingProof) reasonCodes.add("controlled_worker_execution_missing_proof_contract");
  if (risk === "high") reasonCodes.add("controlled_worker_execution_high_risk_command_blocked");
  if (delegatedRequiresArgv)
    reasonCodes.add("controlled_worker_execution_delegation_requires_argv");
  if (unsafeWriteScope) reasonCodes.add("controlled_worker_execution_unsafe_write_scope");
  if (expectedProfileMismatch)
    reasonCodes.add("controlled_worker_execution_expected_profile_hash_mismatch");
  if (missingScopeProof)
    reasonCodes.add("controlled_worker_execution_delegation_requires_git_scope_proof");
  for (const reasonCode of trustGate.reasonCodes) reasonCodes.add(reasonCode);
  if (workCategory !== options.workCategory && options.workCategory) {
    reasonCodes.add("controlled_worker_execution_category_escalated");
  }

  if (execute && command && !blocked) {
    executionAttempted = true;
    const startedAt = Date.now();
    const result =
      commandArgs.length > 0
        ? spawnSync(commandArgs[0], commandArgs.slice(1), {
            cwd: workspaceRoot,
            encoding: "utf8",
            shell: false,
            timeout: 10 * 60 * 1000,
            maxBuffer: 1024 * 1024,
          })
        : spawnSync(command as string, {
            cwd: workspaceRoot,
            encoding: "utf8",
            shell: true,
            timeout: 10 * 60 * 1000,
            maxBuffer: 1024 * 1024,
          });
    durationMs = Date.now() - startedAt;
    exitCode = typeof result.status === "number" ? result.status : 1;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    reasonCodes.add(
      exitCode === 0
        ? "controlled_worker_execution_command_succeeded"
        : "controlled_worker_execution_command_failed"
    );
    if (delegated && beforeScopeSnapshot) {
      const afterScopeSnapshot = gitScopeSnapshot(workspaceRoot);
      if (!afterScopeSnapshot) {
        blocked = true;
        reasonCodes.add("controlled_worker_execution_scope_proof_unavailable_after_run");
      } else {
        changedFiles = changedPaths(beforeScopeSnapshot, afterScopeSnapshot, workspaceRoot);
        scopeViolations = changedFiles.filter(
          (filePath) =>
            !changedPathIsSafe(workspaceRoot, filePath) ||
            !(options.writeScope ?? []).some((scope) => scopeMatches(filePath, scope))
        );
        if (scopeViolations.length > 0) {
          blocked = true;
          reasonCodes.add("controlled_worker_execution_scope_violation");
          reasonCodes.add("worker_trust_demotion_required");
        }
      }
    }
  }

  const status = statusForResult({ execute, blocked, exitCode, executionAttempted });
  const receipt = buildControlledWorkerExecutionReceipt({
    task: options.task,
    mode,
    status,
    worker: {
      id: options.workerId,
      role: options.workerRole,
      endpointType: normalizeEndpointType(options.endpointType),
    },
    writeScope: options.writeScope,
    acceptanceCriteria: options.acceptance,
    proofRequired: options.proof,
    approvalReceiptId: options.approvalReceipt ?? null,
    outcomeReceiptId: options.outcomeReceipt ?? null,
    command: command ?? null,
    exitCode,
    stdout,
    stderr,
    durationMs,
    provider: options.provider,
    model: options.model,
    changedFiles,
    scopeViolations,
    trust: {
      eventId: trustEvent?.eventId ?? null,
      workCategory,
      profileHash: profileHash ?? null,
      state: trustEvent?.state ?? "probation_supervised",
      hardGateReady: delegated,
      approvalReceiptRequired: !delegated,
    },
    reasonCodes: Array.from(reasonCodes),
  });
  const receiptPath = path.resolve(
    workspaceRoot,
    options.output ?? path.join(CONTROLLED_WORKER_EXECUTIONS_DIR, `${receipt.receiptId}.json`)
  );
  writeJsonFile(receiptPath, receipt);
  const unifiedReceipt = options.projectId
    ? controlledWorkerExecutionReceiptToUnifiedEnvelope({
        projectId: options.projectId,
        receipt,
        producer: { surface: "companion", command: "workers execute" },
      })
    : null;
  const unifiedReceiptPath = unifiedReceipt
    ? path.resolve(
        workspaceRoot,
        options.unifiedOutput ??
          path.join(
            UNIFIED_RECEIPTS_DIR,
            `${unifiedReceipt.family}-${unifiedReceipt.receiptId}.json`
          )
      )
    : null;
  if (unifiedReceipt && unifiedReceiptPath) {
    writeJsonFile(unifiedReceiptPath, unifiedReceipt);
  }
  const result = {
    executed: executionAttempted,
    blocked,
    receiptPath,
    unifiedReceiptPath,
    receipt,
    unifiedReceipt,
  };

  if (options.json) {
    printJson(result);
    return result;
  }

  console.log(chalk.bold("Controlled Worker Execution V0"));
  printKeyValue("Receipt:", receipt.receiptId);
  printKeyValue("Status:", receipt.status);
  printKeyValue("Mode:", receipt.mode);
  printKeyValue("Executed:", result.executed ? "yes" : "no");
  printKeyValue("Receipt file:", receiptPath);
  if (unifiedReceiptPath) {
    printKeyValue("Unified receipt file:", unifiedReceiptPath);
  }
  if (blocked) {
    console.log(chalk.yellow("Execution blocked by policy guardrails."));
  }

  return result;
}

function normalizeCommandArgs(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function gitScopeSnapshot(workspaceRoot: string): GitScopeSnapshot | null {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (status.status !== 0) return null;
  const paths = new Set<string>();
  const entries = String(status.stdout ?? "").split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const state = entry.slice(0, 2);
    paths.add(entry.slice(3).replace(/\\/g, "/"));
    if (/[RC]/.test(state) && entries[index + 1]) {
      paths.add(entries[index + 1].replace(/\\/g, "/"));
      index += 1;
    }
  }
  const headResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  return {
    head: headResult.status === 0 ? String(headResult.stdout).trim() : null,
    files: new Map(
      [...paths].map((filePath) => [filePath, pathFingerprint(workspaceRoot, filePath)])
    ),
  };
}

function changedPaths(
  before: GitScopeSnapshot,
  after: GitScopeSnapshot,
  workspaceRoot: string
): string[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changed = [...paths].filter(
    (filePath) => before.files.get(filePath) !== after.files.get(filePath)
  );
  if (before.head && after.head && before.head !== after.head) {
    const commitDiff = spawnSync("git", ["diff", "--name-only", "-z", before.head, after.head], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (commitDiff.status === 0) {
      for (const filePath of String(commitDiff.stdout ?? "").split("\0")) {
        if (filePath) changed.push(filePath.replace(/\\/g, "/"));
      }
    }
  }
  return [...new Set(changed)].sort();
}

function pathFingerprint(workspaceRoot: string, relativePath: string): string {
  const candidate = path.resolve(workspaceRoot, relativePath);
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(candidate)}`;
    if (!stat.isFile()) return `mode:${stat.mode}:size:${stat.size}`;
    return `file:${stat.mode}:${createHash("sha256").update(fs.readFileSync(candidate)).digest("hex")}`;
  } catch {
    return "missing";
  }
}

function changedPathIsSafe(workspaceRoot: string, relativePath: string): boolean {
  const candidate = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return false;
  } catch {
    // Deleted paths are safe to classify from their normalized relative path.
  }
  return true;
}

function isSafeScope(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return Boolean(
    normalized &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split("/").includes("..") &&
    !normalized.includes("\0")
  );
}

function scopeMatches(filePath: string, allowed: string): boolean {
  const target = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const scope = allowed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!isSafeScope(target) || !isSafeScope(scope)) return false;
  if (scope === "**" || scope === "**/*") return true;
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3).replace(/\/$/, "");
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  return target === scope || target.startsWith(`${scope}/`);
}

function currentWorkerProfileHash(workspaceRoot: string, workerId?: string): string | undefined {
  if (!workerId) return undefined;
  const profilePath = path.resolve(workspaceRoot, ".snipara", "workers", `${workerId}.json`);
  if (!fs.existsSync(profilePath)) return undefined;
  try {
    const profile = normalizeWorkerProfile(JSON.parse(fs.readFileSync(profilePath, "utf8")));
    if (!profile) return undefined;
    return `sha256:${hashWorkerProfileContent(stableWorkerProfileJsonStringify(profile))}`;
  } catch {
    return undefined;
  }
}

function loadWorkerTrustEvent(input: {
  workspaceRoot: string;
  workerId?: string;
  workCategory: WorkerTrustCategory;
  eventPath?: string;
}): WorkerTrustEvent | null {
  if (!input.workerId) return null;
  const requestedEventPath = path.resolve(
    input.workspaceRoot,
    input.eventPath ??
      path.join(".snipara", "worker-trust", input.workerId, `${input.workCategory}.json`)
  );
  if (!fs.existsSync(requestedEventPath)) return null;
  const canonicalWorkspace = fs.realpathSync(input.workspaceRoot);
  const eventPath = fs.realpathSync(requestedEventPath);
  const relativeEventPath = path.relative(canonicalWorkspace, eventPath);
  if (relativeEventPath.startsWith("..") || path.isAbsolute(relativeEventPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    if (!isWorkerTrustEvent(parsed)) return null;
    const resolution = listResolvedDecisionRecords(canonicalWorkspace).find(
      (record) =>
        record.request.requestId === parsed.decision.requestId &&
        record.request.producer.kind === "worker_trust_promotion" &&
        record.response.requestId === parsed.decision.requestId &&
        record.response.choice === parsed.decision.responseChoice &&
        record.response.reviewer === parsed.decision.reviewer &&
        record.response.resolvedAt === parsed.decision.resolvedAt &&
        record.response.appliedActions.includes("worker_trust_event_written")
    );
    return resolution ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMode(
  value: ControlledWorkerExecutionMode | undefined,
  execute: boolean
): ControlledWorkerExecutionMode {
  if (value === "approval_required" || value === "auto_low_risk" || value === "dry_run") {
    return value;
  }
  return execute ? "approval_required" : "dry_run";
}

function normalizeEndpointType(
  value: ControlledWorkerExecuteOptions["endpointType"]
): "local" | "cloud" | "self_hosted" | "unknown" {
  if (value === "local" || value === "cloud" || value === "self_hosted" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function commandRisk(command: string): "none" | "low" | "high" {
  return HIGH_RISK_COMMAND_PATTERN.test(command) ? "high" : "low";
}

function statusForResult(input: {
  execute: boolean;
  blocked: boolean;
  exitCode: number | null;
  executionAttempted: boolean;
}): ControlledWorkerExecutionStatus {
  if (input.blocked) return input.executionAttempted ? "failed" : "blocked";
  if (!input.execute) return "planned";
  if (input.exitCode === 0) return "verification_required";
  return "failed";
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const stringified = String(value).trim();
  return stringified || undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printKeyValue(label: string, value: string | number): void {
  console.log(`${chalk.cyan(label)} ${value}`);
}
