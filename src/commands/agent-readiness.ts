/**
 * Agent Readiness Audit - local, portable service-pack report for agent work.
 *
 * The audit is deliberately bounded: it reads local workflow/Team Sync evidence
 * plus explicit operator inputs and returns a deterministic checklist. It does
 * not validate hosted MCP auth, execute tests, or launch workers.
 */
import * as fs from "fs";
import * as path from "path";

export type AgentReadinessTarget =
  | "codex"
  | "claude-code"
  | "cursor"
  | "orca"
  | "windsurf"
  | "custom";

export type AgentReadinessCheckStatus = "pass" | "warning" | "fail" | "manual";
export type AgentReadinessGapSeverity = "low" | "medium" | "high" | "blocker";
export type AgentReadinessScoreBand = "ready" | "mostly_ready" | "needs_hardening" | "blocked";
export type AgentReadinessServiceTier = "launch_review" | "enablement_pack" | "hardening_sprint";

export interface AgentReadinessAuditCommandOptions {
  target?: string;
  task?: string;
  changedFiles?: string[];
  context?: string[];
  proof?: string[];
  acceptance?: string[];
  risk?: string[];
  dir?: string;
  output?: string;
  json?: boolean;
}

export interface AgentReadinessWorkflowState {
  present: boolean;
  path: string;
  status?: string;
  workflowId?: string;
  currentPhaseId?: string;
  completedPhases: number;
  pendingPhases: number;
}

export interface AgentReadinessTeamSyncState {
  present: boolean;
  path: string;
  activeWorkCount: number;
  handoffCount: number;
  latestActiveSummary?: string;
  latestHandoffSummary?: string;
}

export interface AgentReadinessProjectInstructions {
  present: boolean;
  path: string;
}

export interface AgentReadinessLocalSignals {
  workflow: AgentReadinessWorkflowState;
  teamSync: AgentReadinessTeamSyncState;
  projectInstructions: AgentReadinessProjectInstructions;
}

export interface AgentReadinessCheck {
  id: string;
  title: string;
  status: AgentReadinessCheckStatus;
  severity: AgentReadinessGapSeverity;
  score: number;
  maxScore: number;
  evidence: string[];
  action: string;
}

export interface AgentReadinessGap {
  checkId: string;
  severity: AgentReadinessGapSeverity;
  message: string;
  action: string;
}

export interface AgentReadinessRecommendedServicePack {
  id: AgentReadinessServiceTier;
  name: string;
  duration: string;
  fit: string;
  deliverables: string[];
  exitCriteria: string[];
}

export interface AgentReadinessAuditReport {
  version: "snipara.agent_readiness_audit.v1";
  generatedAt: string;
  target: {
    id: AgentReadinessTarget;
    label: string;
    posture: string;
  };
  task?: string;
  score: {
    total: number;
    band: AgentReadinessScoreBand;
    max: 100;
    summary: string;
  };
  checks: AgentReadinessCheck[];
  gaps: AgentReadinessGap[];
  explicitInputs: {
    changedFiles: string[];
    contextRefs: string[];
    proofGates: string[];
    acceptanceCriteria: string[];
    declaredRisks: string[];
  };
  localSignals: AgentReadinessLocalSignals;
  recommendedServicePack: AgentReadinessRecommendedServicePack;
  suggestedCommands: string[];
  caveats: string[];
}

interface BuildAgentReadinessAuditOptions extends AgentReadinessAuditCommandOptions {
  cwd?: string;
  now?: Date;
  localSignals?: AgentReadinessLocalSignals;
}

const TARGETS: Record<AgentReadinessTarget, { label: string; posture: string }> = {
  codex: {
    label: "Codex",
    posture: "Hosted MCP first, local companion workflow for phase state and proof gates.",
  },
  "claude-code": {
    label: "Claude Code",
    posture: "Local hooks and handoffs work well when proof gates are explicit.",
  },
  cursor: {
    label: "Cursor",
    posture: "Keep scope, decisions, and verification commands portable into the IDE session.",
  },
  orca: {
    label: "Orca",
    posture: "Use MCP plus companion handoffs; avoid assuming native Snipara task control.",
  },
  windsurf: {
    label: "Windsurf",
    posture: "Use portable context, proof, and resume artifacts around the IDE workflow.",
  },
  custom: {
    label: "Custom worker",
    posture: "Require an explicit adapter contract before delegating work.",
  },
};

function normalizeTarget(target: string | undefined): AgentReadinessTarget {
  const normalized = (target ?? "codex").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude_code") {
    return "claude-code";
  }
  if (normalized in TARGETS) {
    return normalized as AgentReadinessTarget;
  }
  return "custom";
}

function unique(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeTask(task: string | undefined): string | undefined {
  const normalized = task?.trim();
  return normalized ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function safeReadJson(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function relativePath(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

export function collectAgentReadinessLocalSignals(
  rootDir = process.cwd()
): AgentReadinessLocalSignals {
  const workflowPath = path.join(rootDir, ".snipara", "workflow", "current.json");
  const workflowJson = safeReadJson(workflowPath);
  const phases = recordList(workflowJson?.phases);
  const workflow: AgentReadinessWorkflowState = {
    present: Boolean(workflowJson),
    path: relativePath(rootDir, workflowPath),
    status: stringValue(workflowJson?.status),
    workflowId: stringValue(workflowJson?.workflowId),
    currentPhaseId: stringValue(workflowJson?.currentPhaseId),
    completedPhases: phases.filter((phase) => phase.status === "completed").length,
    pendingPhases: phases.filter((phase) => phase.status === "pending").length,
  };

  const teamSyncPath = path.join(rootDir, ".snipara", "team-sync", "session.json");
  const teamSyncJson = safeReadJson(teamSyncPath);
  const work = recordList(teamSyncJson?.work);
  const handoffs = recordList(teamSyncJson?.handoffs);
  const activeWork = work.filter((item) => item.status === "active");
  const latestActive = activeWork[activeWork.length - 1];
  const latestHandoff = handoffs[handoffs.length - 1];
  const teamSync: AgentReadinessTeamSyncState = {
    present: Boolean(teamSyncJson),
    path: relativePath(rootDir, teamSyncPath),
    activeWorkCount: activeWork.length,
    handoffCount: handoffs.length,
    latestActiveSummary: stringValue(latestActive?.summary),
    latestHandoffSummary: stringValue(latestHandoff?.summary),
  };

  const agentsPath = path.join(rootDir, "AGENTS.md");
  const projectInstructions: AgentReadinessProjectInstructions = {
    present: fs.existsSync(agentsPath),
    path: relativePath(rootDir, agentsPath),
  };

  return { workflow, teamSync, projectInstructions };
}

function check(input: {
  id: string;
  title: string;
  status: AgentReadinessCheckStatus;
  severity: AgentReadinessGapSeverity;
  score: number;
  maxScore: number;
  evidence: string[];
  action: string;
}): AgentReadinessCheck {
  return input;
}

function checkGap(item: AgentReadinessCheck): AgentReadinessGap | undefined {
  if (item.status === "pass") {
    return undefined;
  }

  return {
    checkId: item.id,
    severity: item.severity,
    message: `${item.title}: ${item.status}`,
    action: item.action,
  };
}

function scoreSummary(band: AgentReadinessScoreBand): string {
  switch (band) {
    case "ready":
      return "Ready for bounded delegation with visible proof gates.";
    case "mostly_ready":
      return "Mostly ready, but tighten the warnings before relying on repeated delegation.";
    case "needs_hardening":
      return "Needs hardening before this becomes a repeatable agent workflow.";
    case "blocked":
      return "Blocked for serious delegation until scope and proof gaps are closed.";
  }
}

function servicePack(
  band: AgentReadinessScoreBand,
  gaps: AgentReadinessGap[]
): AgentReadinessRecommendedServicePack {
  const hasBlocker = gaps.some((gap) => gap.severity === "blocker");
  if (band === "ready" && !hasBlocker) {
    return {
      id: "launch_review",
      name: "Agent Launch Review",
      duration: "0.5-1 day",
      fit: "The team already has workflow state, scope, and proof gates; the value is a final launch check.",
      deliverables: [
        "Delegation readiness report",
        "Target-specific handoff checklist",
        "Verification command list",
        "Residual risk register",
      ],
      exitCriteria: [
        "No blocker gaps remain",
        "Proof gates map to concrete commands or review evidence",
        "A handoff receipt path is agreed",
      ],
    };
  }

  if (band === "mostly_ready" && !hasBlocker) {
    return {
      id: "enablement_pack",
      name: "Agent Readiness Enablement Pack",
      duration: "1-2 days",
      fit: "The team has most primitives, but needs a repeatable operating contract.",
      deliverables: [
        "Work-package template",
        "Context and decision source map",
        "Proof gate checklist",
        "Team Sync and resume playbook",
        "Target agent handoff template",
      ],
      exitCriteria: [
        "Every delegated task has owner, scope, acceptance, and proof fields",
        "Companion workflow and Team Sync are active",
        "At least one target handoff is generated and reviewed",
      ],
    };
  }

  return {
    id: "hardening_sprint",
    name: "Agent Readiness Hardening Sprint",
    duration: "2-5 days",
    fit: "The workflow is not yet safe to repeat across agents without tightening contracts first.",
    deliverables: [
      "Repository readiness audit",
      "AGENTS.md and MCP startup contract review",
      "Work-package lifecycle hardening",
      "Proof gate and verification baseline",
      "First portable handoff artifact",
    ],
    exitCriteria: [
      "No blocker gaps remain",
      "Workflow resume and phase commits are visible",
      "Proof evidence is required before handoff or closure",
      "Target adapter assumptions are documented",
    ],
  };
}

function suggestedCommands(input: {
  target: AgentReadinessTarget;
  task?: string;
  changedFiles: string[];
  hasWorkflow: boolean;
  hasTeamSync: boolean;
  hasProof: boolean;
}): string[] {
  const commands: string[] = [];
  const task = input.task ?? "<task>";
  const files = input.changedFiles.length > 0 ? input.changedFiles.join(" ") : "<relevant-files>";

  if (!input.hasWorkflow) {
    commands.push(`snipara-companion workflow start --goal "${task}"`);
    commands.push("snipara-companion workflow phase-start readiness");
  }
  if (!input.hasTeamSync) {
    commands.push(`snipara-companion team-sync start-work --summary "${task}" --files ${files}`);
  }
  if (!input.hasProof) {
    commands.push(
      `snipara-companion handoff --summary "${task}" --next "define proof gates" --attention proof --files ${files}`
    );
  }

  commands.push(`snipara-companion verify --task "${task}" --changed-files ${files} --skip-impact`);
  commands.push(
    `snipara-companion agent-readiness audit --target ${input.target} --task "${task}" --changed-files ${files} --json`
  );

  return commands;
}

export function buildAgentReadinessAuditReport(
  options: BuildAgentReadinessAuditOptions = {}
): AgentReadinessAuditReport {
  const cwd = options.cwd ?? process.cwd();
  const localSignals = options.localSignals ?? collectAgentReadinessLocalSignals(cwd);
  const targetId = normalizeTarget(options.target);
  const target = TARGETS[targetId];
  const task = normalizeTask(options.task);
  const changedFiles = unique(options.changedFiles);
  const contextRefs = unique(options.context);
  const proofGates = unique(options.proof);
  const acceptanceCriteria = unique(options.acceptance);
  const declaredRisks = unique(options.risk);
  const hasWorkflow = localSignals.workflow.present && localSignals.workflow.status === "active";
  const hasTeamSync =
    localSignals.teamSync.present &&
    (localSignals.teamSync.activeWorkCount > 0 || localSignals.teamSync.handoffCount > 0);
  const hasProof = proofGates.length > 0 && acceptanceCriteria.length > 0;

  const checks: AgentReadinessCheck[] = [
    check({
      id: "scope",
      title: "Task scope is explicit",
      status:
        task && changedFiles.length > 0
          ? "pass"
          : task || changedFiles.length > 0
            ? "warning"
            : "fail",
      severity: task || changedFiles.length > 0 ? "medium" : "blocker",
      score: task && changedFiles.length > 0 ? 15 : task || changedFiles.length > 0 ? 8 : 0,
      maxScore: 15,
      evidence: [
        task ? `task: ${task}` : "missing task",
        changedFiles.length > 0
          ? `${changedFiles.length} changed/relevant file(s)`
          : "missing files",
      ],
      action: "Set --task and --changed-files so the agent gets a bounded work package.",
    }),
    check({
      id: "context_contract",
      title: "Context contract exists",
      status:
        contextRefs.length > 0 || localSignals.projectInstructions.present
          ? "pass"
          : localSignals.workflow.present
            ? "warning"
            : "fail",
      severity:
        contextRefs.length > 0 || localSignals.projectInstructions.present
          ? "low"
          : localSignals.workflow.present
            ? "medium"
            : "high",
      score:
        contextRefs.length > 0 || localSignals.projectInstructions.present
          ? 15
          : localSignals.workflow.present
            ? 8
            : 0,
      maxScore: 15,
      evidence: [
        contextRefs.length > 0
          ? `${contextRefs.length} explicit context ref(s)`
          : "no explicit context refs",
        localSignals.projectInstructions.present
          ? `${localSignals.projectInstructions.path} present`
          : `${localSignals.projectInstructions.path} missing`,
      ],
      action: "Attach source docs, decisions, or AGENTS.md instructions before delegating.",
    }),
    check({
      id: "workflow_continuity",
      title: "Workflow continuity is active",
      status: hasWorkflow ? "pass" : localSignals.workflow.present ? "warning" : "fail",
      severity: hasWorkflow ? "low" : localSignals.workflow.present ? "medium" : "high",
      score: hasWorkflow ? 15 : localSignals.workflow.present ? 8 : 0,
      maxScore: 15,
      evidence: [
        localSignals.workflow.present
          ? `${localSignals.workflow.path} status=${localSignals.workflow.status ?? "unknown"}`
          : `${localSignals.workflow.path} missing`,
        localSignals.workflow.currentPhaseId
          ? `current phase: ${localSignals.workflow.currentPhaseId}`
          : "no current phase",
      ],
      action: "Start or resume a companion workflow before handing work to another agent.",
    }),
    check({
      id: "team_sync",
      title: "Team Sync has resumable work or handoff evidence",
      status: hasTeamSync ? "pass" : localSignals.teamSync.present ? "warning" : "fail",
      severity: hasTeamSync ? "low" : "medium",
      score: hasTeamSync ? 10 : localSignals.teamSync.present ? 5 : 0,
      maxScore: 10,
      evidence: [
        localSignals.teamSync.present
          ? `${localSignals.teamSync.path} present`
          : `${localSignals.teamSync.path} missing`,
        `${localSignals.teamSync.activeWorkCount} active work item(s)`,
        `${localSignals.teamSync.handoffCount} handoff(s)`,
      ],
      action: "Record start-work or handoff evidence so the next agent can resume.",
    }),
    check({
      id: "proof_gates",
      title: "Proof gates and acceptance criteria are explicit",
      status: hasProof
        ? "pass"
        : proofGates.length > 0 || acceptanceCriteria.length > 0
          ? "warning"
          : "fail",
      severity: hasProof
        ? "low"
        : proofGates.length > 0 || acceptanceCriteria.length > 0
          ? "high"
          : "blocker",
      score: hasProof ? 20 : proofGates.length > 0 || acceptanceCriteria.length > 0 ? 10 : 0,
      maxScore: 20,
      evidence: [
        `${proofGates.length} proof gate(s)`,
        `${acceptanceCriteria.length} acceptance criterion/criteria`,
      ],
      action:
        "Define required proof and acceptance criteria; do not rely on a vague completion note.",
    }),
    check({
      id: "verification",
      title: "Verification path is derivable",
      status:
        changedFiles.length > 0 && (proofGates.length > 0 || acceptanceCriteria.length > 0)
          ? "pass"
          : changedFiles.length > 0 || proofGates.length > 0 || acceptanceCriteria.length > 0
            ? "warning"
            : "fail",
      severity:
        changedFiles.length > 0 && (proofGates.length > 0 || acceptanceCriteria.length > 0)
          ? "low"
          : "high",
      score:
        changedFiles.length > 0 && (proofGates.length > 0 || acceptanceCriteria.length > 0)
          ? 15
          : changedFiles.length > 0 || proofGates.length > 0 || acceptanceCriteria.length > 0
            ? 7
            : 0,
      maxScore: 15,
      evidence: [
        changedFiles.length > 0 ? "file scope available" : "file scope missing",
        proofGates.length > 0 || acceptanceCriteria.length > 0
          ? "proof or acceptance available"
          : "proof and acceptance missing",
      ],
      action: "Run or generate a verification plan before handoff, merge, or closure.",
    }),
    check({
      id: "target_adapter",
      title: "Target agent posture is declared",
      status: targetId === "custom" ? "manual" : "pass",
      severity: targetId === "custom" ? "medium" : "low",
      score: targetId === "custom" ? 5 : 10,
      maxScore: 10,
      evidence: [`target: ${target.label}`, target.posture],
      action: "For custom workers, write the adapter contract before delegation.",
    }),
  ];

  const rawScore = checks.reduce((sum, item) => sum + item.score, 0);
  const gaps = checks.flatMap((item) => {
    const gap = checkGap(item);
    return gap ? [gap] : [];
  });
  const hasBlocker = gaps.some((gap) => gap.severity === "blocker");
  const total = Math.min(100, Math.max(0, Math.round(rawScore)));
  const band: AgentReadinessScoreBand = hasBlocker
    ? "blocked"
    : total >= 85
      ? "ready"
      : total >= 70
        ? "mostly_ready"
        : total >= 50
          ? "needs_hardening"
          : "blocked";

  return {
    version: "snipara.agent_readiness_audit.v1",
    generatedAt: (options.now ?? new Date()).toISOString(),
    target: {
      id: targetId,
      label: target.label,
      posture: target.posture,
    },
    ...(task ? { task } : {}),
    score: {
      total,
      band,
      max: 100,
      summary: scoreSummary(band),
    },
    checks,
    gaps,
    explicitInputs: {
      changedFiles,
      contextRefs,
      proofGates,
      acceptanceCriteria,
      declaredRisks,
    },
    localSignals,
    recommendedServicePack: servicePack(band, gaps),
    suggestedCommands: suggestedCommands({
      target: targetId,
      task,
      changedFiles,
      hasWorkflow,
      hasTeamSync,
      hasProof,
    }),
    caveats: [
      "This is a local readiness audit. It does not validate hosted MCP auth or current dashboard state.",
      "The audit does not run tests, verify proofs, create branches, or launch agents.",
      "A pass means the delegation contract is inspectable; it is not a guarantee of successful execution.",
    ],
  };
}

function formatList(values: string[], empty = "none"): string {
  return values.length > 0 ? values.join(", ") : empty;
}

export function formatAgentReadinessAuditReport(report: AgentReadinessAuditReport): string {
  const lines: string[] = [];
  lines.push(`Agent Readiness Audit - ${report.target.label}`);
  lines.push(`Score: ${report.score.total}/${report.score.max} (${report.score.band})`);
  lines.push(report.score.summary);
  if (report.task) {
    lines.push(`Task: ${report.task}`);
  }
  lines.push("");
  lines.push("Checks");
  for (const item of report.checks) {
    lines.push(`- [${item.status}] ${item.title} (${item.score}/${item.maxScore})`);
    for (const evidence of item.evidence) {
      lines.push(`  evidence: ${evidence}`);
    }
    if (item.status !== "pass") {
      lines.push(`  action: ${item.action}`);
    }
  }
  lines.push("");
  lines.push("Inputs");
  lines.push(`- files: ${formatList(report.explicitInputs.changedFiles)}`);
  lines.push(`- context: ${formatList(report.explicitInputs.contextRefs)}`);
  lines.push(`- proof: ${formatList(report.explicitInputs.proofGates)}`);
  lines.push(`- acceptance: ${formatList(report.explicitInputs.acceptanceCriteria)}`);
  lines.push(`- risks: ${formatList(report.explicitInputs.declaredRisks)}`);
  lines.push("");
  lines.push(`Recommended service pack: ${report.recommendedServicePack.name}`);
  lines.push(`Fit: ${report.recommendedServicePack.fit}`);
  lines.push("Deliverables");
  for (const item of report.recommendedServicePack.deliverables) {
    lines.push(`- ${item}`);
  }
  lines.push("Exit criteria");
  for (const item of report.recommendedServicePack.exitCriteria) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("Suggested commands");
  for (const command of report.suggestedCommands) {
    lines.push(`- ${command}`);
  }
  lines.push("");
  lines.push("Caveats");
  for (const caveat of report.caveats) {
    lines.push(`- ${caveat}`);
  }
  return lines.join("\n");
}

function writeReport(outputPath: string, report: AgentReadinessAuditReport): void {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const content = outputPath.endsWith(".json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatAgentReadinessAuditReport(report)}\n`;
  fs.writeFileSync(absolute, content, "utf8");
}

export async function agentReadinessAuditCommand(
  options: AgentReadinessAuditCommandOptions
): Promise<void> {
  const cwd = path.resolve(options.dir ?? process.cwd());
  const report = buildAgentReadinessAuditReport({
    ...options,
    cwd,
    localSignals: collectAgentReadinessLocalSignals(cwd),
  });

  if (options.output) {
    writeReport(options.output, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatAgentReadinessAuditReport(report));
}
