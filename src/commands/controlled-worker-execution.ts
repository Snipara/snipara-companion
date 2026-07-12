import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import {
  buildControlledWorkerExecutionReceipt,
  controlledWorkerExecutionReceiptToUnifiedEnvelope,
  type ControlledWorkerExecutionMode,
  type ControlledWorkerExecutionReceipt,
  type ControlledWorkerExecutionStatus,
  type UnifiedReceiptEnvelope,
} from "../contracts/project-intelligence";
import { findWorkspaceRoot } from "../config/store";

const CONTROLLED_WORKER_EXECUTIONS_DIR = path.join(".snipara", "worker-executions");
const UNIFIED_RECEIPTS_DIR = path.join(".snipara", "unified-receipts");
const HIGH_RISK_COMMAND_PATTERN =
  /\b(git\s+push|git\s+reset|git\s+checkout\s+--|rm\s+-rf|prisma\s+migrate\s+reset|prisma\s+db\s+push\s+--accept-data-loss|npm\s+publish|pnpm\s+publish|twine\s+upload|deploy-zero-downtime|ssh\s+)\b/i;

export interface ControlledWorkerExecuteOptions {
  task: string;
  workerId?: string;
  workerRole?: string;
  endpointType?: "local" | "cloud" | "self_hosted" | "unknown";
  mode?: ControlledWorkerExecutionMode;
  command?: string;
  execute?: boolean;
  approvalReceipt?: string;
  outcomeReceipt?: string;
  writeScope?: string[];
  acceptance?: string[];
  proof?: string[];
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
  const command = stringValue(options.command);
  const risk = command ? commandRisk(command) : "none";
  const missingApproval = execute && !options.approvalReceipt;
  const missingCommand = execute && !command;
  const blocked = missingApproval || missingCommand || risk === "high";
  const reasonCodes = new Set<string>();
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";

  if (execute) reasonCodes.add("controlled_worker_execution_requested");
  if (!execute) reasonCodes.add("controlled_worker_execution_dry_run_only");
  if (missingApproval) reasonCodes.add("controlled_worker_execution_missing_approval");
  if (missingCommand) reasonCodes.add("controlled_worker_execution_missing_command");
  if (risk === "high") reasonCodes.add("controlled_worker_execution_high_risk_command_blocked");

  if (execute && command && !blocked) {
    const result = spawnSync(command, {
      cwd: workspaceRoot,
      encoding: "utf8",
      shell: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    exitCode = typeof result.status === "number" ? result.status : 1;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    reasonCodes.add(
      exitCode === 0
        ? "controlled_worker_execution_command_succeeded"
        : "controlled_worker_execution_command_failed"
    );
  }

  const status = statusForResult({ execute, blocked, exitCode });
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
    executed: execute && !blocked,
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
}): ControlledWorkerExecutionStatus {
  if (input.blocked) return "blocked";
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
