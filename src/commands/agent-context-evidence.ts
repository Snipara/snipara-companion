import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildAgentContextEvidenceReceipt,
  buildAgentContextEvidenceReport,
  buildAgentContextEvidenceTemplate,
  hashDecisionJsonValue,
  isAgentContextEvidenceReceipt,
  resolveAgentContext,
  type AgentContextEvidenceReceipt,
  type AgentContextEvidenceReport,
} from "../contracts/project-intelligence";
import {
  AGENT_CONTEXT_MANIFEST_DEFAULT_PATH,
  buildLocalAgentContextValidationReport,
} from "./agent-context";

export const AGENT_CONTEXT_EVIDENCE_DEFAULT_LEDGER = path.join(
  ".snipara",
  "agent-context",
  "evidence.jsonl"
);

export interface AgentContextEvidenceTemplateCommandOptions {
  agent: string;
  task: string;
  manifest?: string;
  output?: string;
  force?: boolean;
  json?: boolean;
  cwd?: string;
}

export interface AgentContextEvidenceRecordCommandOptions {
  from: string;
  manifest?: string;
  ledger?: string;
  json?: boolean;
  cwd?: string;
}

export interface AgentContextEvidenceStatusCommandOptions {
  manifest?: string;
  ledger?: string;
  enforce?: boolean;
  json?: boolean;
  cwd?: string;
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} ${filePath}: ${message}`);
  }
}

function readManifest(cwd: string, candidate?: string): unknown {
  return readJson(
    path.resolve(cwd, candidate ?? AGENT_CONTEXT_MANIFEST_DEFAULT_PATH),
    "Agent Context manifest"
  );
}

function validatedManifest(cwd: string, candidate?: string) {
  const manifest = readManifest(cwd, candidate);
  const validation = buildLocalAgentContextValidationReport({ cwd, manifest });
  if (!validation.manifest || validation.status === "invalid") {
    const errors = validation.findings
      .filter((finding) => finding.severity === "error")
      .map((finding) => finding.summary)
      .join(" ");
    throw new Error(`Invalid Agent Context manifest. ${errors}`.trim());
  }
  return validation.manifest;
}

function receiptHash(receipt: AgentContextEvidenceReceipt): string {
  const { receiptHash: _receiptHash, ...base } = receipt;
  return hashDecisionJsonValue(base);
}

export function readAgentContextEvidenceLedger(ledgerPath: string): AgentContextEvidenceReceipt[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const content = fs.readFileSync(ledgerPath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line, index) => {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON on evidence ledger line ${index + 1}: ${message}`);
    }
    if (!isAgentContextEvidenceReceipt(candidate)) {
      throw new Error(`Unsupported evidence receipt on ledger line ${index + 1}.`);
    }
    if (receiptHash(candidate) !== candidate.receiptHash) {
      throw new Error(`Evidence receipt hash mismatch on ledger line ${index + 1}.`);
    }
    return candidate;
  });
}

function writeJsonOutput(value: unknown, outputPath?: string, force = false): string | undefined {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    console.log(content.trimEnd());
    return undefined;
  }
  if (fs.existsSync(outputPath) && !force) {
    throw new Error(
      `Refusing to overwrite existing file ${outputPath}; pass --force to replace it.`
    );
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}

function formatStatus(report: AgentContextEvidenceReport, ledgerPath: string): string {
  const lines = [
    "# Agent Context AC-1 evidence",
    "",
    `Status: ${report.status}`,
    `Ledger: ${ledgerPath}`,
    `Tasks: ${report.receiptCount}/20`,
    `Roles: ${report.observedRoles.join(", ") || "none"}`,
    `Unresolved high-severity leaks: ${report.metrics.leaks.unresolvedHighSeverity}`,
    `Leaks without regression proof: ${report.metrics.leaks.withoutRegressionTest}`,
    `Repeated benefits: ${report.repeatedBenefitCodes.join(", ") || "none yet"}`,
    `Average observed tokens: ${report.metrics.tokens.averagePerTask ?? "n/a"}`,
    "",
    "## Exit gate",
    "",
    ...report.criteria.map(
      (criterion) => `- [${criterion.passed ? "pass" : "blocked"}] ${criterion.summary}`
    ),
  ];
  if (report.nextActions.length > 0) {
    lines.push("", "## Next actions", "", ...report.nextActions.map((action) => `- ${action}`));
  }
  if (report.repeatedRuntimeNeedCodes.length > 0) {
    lines.push(
      "",
      "AC-2 signal only: repeated runtime needs were observed, but an external design partner is still required."
    );
  }
  return lines.join("\n");
}

export async function agentContextEvidenceTemplateCommand(
  options: AgentContextEvidenceTemplateCommandOptions
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = validatedManifest(cwd, options.manifest);
  const resolution = resolveAgentContext({
    manifest,
    agent: options.agent,
    task: options.task,
  });
  const template = buildAgentContextEvidenceTemplate(resolution);
  const outputPath = options.output ? path.resolve(cwd, options.output) : undefined;
  const written = writeJsonOutput(template, outputPath, Boolean(options.force));
  if (written && !options.json) {
    console.log(`Wrote AC-1 evidence template: ${path.relative(cwd, written)}`);
    console.log("Complete the task evidence and proofRefs before recording it.");
  }
}

export async function agentContextEvidenceRecordCommand(
  options: AgentContextEvidenceRecordCommandOptions
): Promise<AgentContextEvidenceReceipt> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = validatedManifest(cwd, options.manifest);
  const evidencePath = path.resolve(cwd, options.from);
  const evidence = readJson(evidencePath, "AC-1 evidence input");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("AC-1 evidence input must be a JSON object.");
  }
  const agent = (evidence as Record<string, unknown>).agent;
  const task = (evidence as Record<string, unknown>).task;
  if (typeof agent !== "string" || typeof task !== "string") {
    throw new Error("AC-1 evidence input requires string agent and task fields.");
  }
  const resolution = resolveAgentContext({ manifest, agent, task });
  const receipt = buildAgentContextEvidenceReceipt({ resolution, evidence });
  const ledgerPath = path.resolve(cwd, options.ledger ?? AGENT_CONTEXT_EVIDENCE_DEFAULT_LEDGER);
  const existing = readAgentContextEvidenceLedger(ledgerPath);
  if (existing.some((candidate) => candidate.taskId === receipt.taskId)) {
    throw new Error(`Evidence taskId already exists in the ledger: ${receipt.taskId}.`);
  }
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(receipt)}\n`, "utf8");
  if (options.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`Recorded AC-1 evidence: ${receipt.taskId}`);
    console.log(`Ledger: ${path.relative(cwd, ledgerPath)}`);
    console.log(`Receipt: ${receipt.receiptHash}`);
  }
  return receipt;
}

export async function agentContextEvidenceStatusCommand(
  options: AgentContextEvidenceStatusCommandOptions = {}
): Promise<AgentContextEvidenceReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = validatedManifest(cwd, options.manifest);
  const ledgerPath = path.resolve(cwd, options.ledger ?? AGENT_CONTEXT_EVIDENCE_DEFAULT_LEDGER);
  const receipts = readAgentContextEvidenceLedger(ledgerPath);
  const report = buildAgentContextEvidenceReport({
    receipts,
    expectedRoles: Object.keys(manifest.roles),
  });
  console.log(
    options.json
      ? JSON.stringify(report, null, 2)
      : formatStatus(report, path.relative(cwd, ledgerPath))
  );
  if (options.enforce && report.status !== "ready") process.exitCode = 1;
  return report;
}
