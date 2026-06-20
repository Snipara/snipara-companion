import type { ProjectIntelligenceJudgmentCard } from "./judgment-card";

export type ProjectPolicyGateSeverity = "advisory" | "required_action" | "block";
export type ProjectPolicyGateSurface =
  | "release"
  | "schema"
  | "auth"
  | "billing"
  | "deploy"
  | "package_surface";
export type ProjectPolicyGateSampleMode =
  | "not_applicable"
  | "structural"
  | "explicit_contract"
  | "sample_gated";

export interface ProjectPolicyGateSampleGate {
  mode: ProjectPolicyGateSampleMode;
  satisfied: boolean;
  observedSamples: number;
  requiredSamples: number;
  rationale: string;
}

export interface ProjectPolicyGateAudit {
  registryVersion: "project-intelligence.policy-gates.registry.v1";
  source: string;
  reasonCodes: string[];
  humanOverrideAllowed: boolean;
  humanOverrideRequiresReason: boolean;
}

export interface ProjectPolicyGateDecision {
  id: string;
  surface: ProjectPolicyGateSurface;
  severity: ProjectPolicyGateSeverity;
  title: string;
  rationale: string;
  evidence: string[];
  requiredActions: string[];
  suggestedCommands: string[];
  sampleGate: ProjectPolicyGateSampleGate;
  audit: ProjectPolicyGateAudit;
}

export interface ProjectPolicyGatesSummary {
  advisory: number;
  requiredAction: number;
  block: number;
  strongestSeverity: ProjectPolicyGateSeverity;
  affectedSurfaces: ProjectPolicyGateSurface[];
}

export interface ProjectPolicyGatesResult {
  version: "project-intelligence.policy-gates.v1";
  generatedAt: string;
  registryVersion: "project-intelligence.policy-gates.registry.v1";
  release: boolean;
  summary: ProjectPolicyGatesSummary;
  gates: ProjectPolicyGateDecision[];
  suggestedCommands: string[];
}

export interface EvaluateProjectPolicyGatesInput {
  task?: string;
  release?: boolean;
  changedFiles?: string[];
  diffSummary?: string;
  skipGuard?: boolean;
  skipPackageReview?: boolean;
  guard?: {
    status?: number | null;
    payload?: Record<string, unknown>;
    error?: string;
    stderr?: string;
  };
  packageReview?: {
    status?: string;
    error?: string;
    command?: string;
  };
  judgmentCard?: ProjectIntelligenceJudgmentCard;
}

const REGISTRY_VERSION = "project-intelligence.policy-gates.registry.v1" as const;

function normalizeChangedFiles(changedFiles: string[] | undefined): string[] {
  return [...new Set((changedFiles ?? []).map((file) => file.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedRecord(root: unknown, keys: string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current) || !isRecord(current[key])) {
      return {};
    }
    current = current[key];
  }
  return isRecord(current) ? current : {};
}

function combinedText(input: EvaluateProjectPolicyGatesInput): string {
  return [input.task, input.diffSummary, ...(input.changedFiles ?? [])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function hasFile(changedFiles: string[], pattern: RegExp): boolean {
  return changedFiles.some((file) => pattern.test(file));
}

function hasText(input: EvaluateProjectPolicyGatesInput, pattern: RegExp): boolean {
  return pattern.test(combinedText(input));
}

function structuralSampleGate(rationale: string): ProjectPolicyGateSampleGate {
  return {
    mode: "structural",
    satisfied: true,
    observedSamples: 0,
    requiredSamples: 0,
    rationale,
  };
}

function explicitContractSampleGate(rationale: string): ProjectPolicyGateSampleGate {
  return {
    mode: "explicit_contract",
    satisfied: true,
    observedSamples: 0,
    requiredSamples: 0,
    rationale,
  };
}

function notApplicableSampleGate(rationale: string): ProjectPolicyGateSampleGate {
  return {
    mode: "not_applicable",
    satisfied: true,
    observedSamples: 0,
    requiredSamples: 0,
    rationale,
  };
}

function gate(input: {
  id: string;
  surface: ProjectPolicyGateSurface;
  severity: ProjectPolicyGateSeverity;
  title: string;
  rationale: string;
  evidence?: string[];
  requiredActions?: string[];
  suggestedCommands?: string[];
  sampleGate?: ProjectPolicyGateSampleGate;
  source: string;
  reasonCodes?: string[];
}): ProjectPolicyGateDecision {
  return {
    id: input.id,
    surface: input.surface,
    severity: input.severity,
    title: input.title,
    rationale: input.rationale,
    evidence: input.evidence ?? [],
    requiredActions: input.requiredActions ?? [],
    suggestedCommands: input.suggestedCommands ?? [],
    sampleGate:
      input.sampleGate ??
      structuralSampleGate("This gate is based on structural file or command evidence."),
    audit: {
      registryVersion: REGISTRY_VERSION,
      source: input.source,
      reasonCodes: input.reasonCodes ?? [],
      humanOverrideAllowed: input.severity !== "block",
      humanOverrideRequiresReason: true,
    },
  };
}

function guardEvaluation(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return (
    firstNonEmptyRecord(
      nestedRecord(payload, ["hosted", "data", "evaluation"]),
      nestedRecord(payload, ["data", "evaluation"]),
      nestedRecord(payload, ["evaluation"])
    ) ?? {}
  );
}

function firstNonEmptyRecord(
  ...records: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  return records.find((record) => Object.keys(record).length > 0);
}

function gateSummary(gates: ProjectPolicyGateDecision[]): ProjectPolicyGatesSummary {
  const advisory = gates.filter((item) => item.severity === "advisory").length;
  const requiredAction = gates.filter((item) => item.severity === "required_action").length;
  const block = gates.filter((item) => item.severity === "block").length;
  const strongestSeverity: ProjectPolicyGateSeverity =
    block > 0 ? "block" : requiredAction > 0 ? "required_action" : "advisory";
  return {
    advisory,
    requiredAction,
    block,
    strongestSeverity,
    affectedSurfaces: [...new Set(gates.map((item) => item.surface))] as ProjectPolicyGateSurface[],
  };
}

function packageReviewCommand(input: EvaluateProjectPolicyGatesInput): string {
  return input.packageReview?.command ?? "npm view snipara-companion version bin dist-tags --json";
}

export function evaluateProjectPolicyGates(
  input: EvaluateProjectPolicyGatesInput
): ProjectPolicyGatesResult {
  const changedFiles = normalizeChangedFiles(input.changedFiles);
  const gates: ProjectPolicyGateDecision[] = [];

  if (input.release) {
    gates.push(
      gate({
        id: "policy:release:release-mode",
        surface: "release",
        severity: "advisory",
        title: "Release mode enabled",
        rationale:
          "Production-oriented runs must preserve release guard, package surface review, verification evidence, and phase/final commit auditability.",
        evidence: ["--release"],
        requiredActions: [
          "Keep phase/final commit summaries tied to the checks actually executed.",
          "Run final promotion and deploy only after required-action gates are resolved.",
        ],
        suggestedCommands: [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
        ],
        sampleGate: notApplicableSampleGate(
          "Release mode is a deterministic operator choice, not an outcome-calibrated threshold."
        ),
        source: "release_mode",
        reasonCodes: ["release_mode"],
      })
    );
  }

  if (input.release && input.skipGuard) {
    gates.push(
      gate({
        id: "policy:release:guard-skipped",
        surface: "release",
        severity: "required_action",
        title: "Release guard was skipped",
        rationale:
          "A production run without the pre-deploy collaboration guard must carry explicit human audit evidence before deploy.",
        evidence: ["--skip-guard"],
        requiredActions: ["Run or explicitly justify skipping the pre-deploy collaboration guard."],
        suggestedCommands: [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
        ],
        sampleGate: explicitContractSampleGate(
          "The collaboration guard is an explicit release contract and does not rely on sample calibration."
        ),
        source: "release_guard",
        reasonCodes: ["release_guard_skipped"],
      })
    );
  }

  const guardEval = guardEvaluation(input.guard?.payload);
  const guardDecision = stringValue(guardEval.decision)?.toUpperCase();
  if (
    guardDecision === "BLOCKED" ||
    (input.release && input.guard?.status !== undefined && input.guard.status !== 0)
  ) {
    gates.push(
      gate({
        id: "policy:release:guard-block",
        surface: "release",
        severity: "block",
        title: "Collaboration guard blocks release",
        rationale:
          "Explicit guard blocks are stronger than outcome-calibrated advisories and must be resolved before promotion or deploy.",
        evidence: [
          guardDecision ? `guard decision ${guardDecision}` : `guard exit ${input.guard?.status}`,
          ...(input.guard?.error ? [input.guard.error] : []),
        ],
        requiredActions: ["Resolve the blocking collaboration guard finding before release."],
        suggestedCommands: [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
        ],
        sampleGate: explicitContractSampleGate(
          "Explicit guard contradictions can block without statistical sample gating."
        ),
        source: "collaboration_guard",
        reasonCodes: ["guard_blocked"],
      })
    );
  } else if (guardDecision === "REVIEW_REQUIRED" || guardDecision === "REQUIRES_ACK") {
    gates.push(
      gate({
        id: "policy:release:guard-review",
        surface: "release",
        severity: "required_action",
        title: "Collaboration guard requires review",
        rationale: "Review-only guard findings need explicit acknowledgement before release.",
        evidence: [`guard decision ${guardDecision}`],
        requiredActions: ["Review and acknowledge the collaboration guard finding."],
        suggestedCommands: [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
        ],
        sampleGate: explicitContractSampleGate(
          "Guard review contracts are explicit operational evidence, not statistical thresholds."
        ),
        source: "collaboration_guard",
        reasonCodes: ["guard_review_required"],
      })
    );
  }

  if (input.judgmentCard?.canProceed === "block") {
    gates.push(
      gate({
        id: "policy:release:judgment-card-block",
        surface: "release",
        severity: "block",
        title: "Judgment Card blocks release",
        rationale:
          "The Project Intelligence Judgment Card reached a blocking state and must not be bypassed by weaker policy gates.",
        evidence: [`judgment state ${input.judgmentCard.state}`],
        requiredActions: input.judgmentCard.requiredActions.map((action) => action.title),
        suggestedCommands: input.judgmentCard.requiredActions
          .map((action) => action.command)
          .filter((command): command is string => Boolean(command)),
        sampleGate: explicitContractSampleGate(
          "Judgment Card block status is an explicit contradiction contract."
        ),
        source: "judgment_card",
        reasonCodes: ["judgment_card_block"],
      })
    );
  }

  if (
    hasFile(changedFiles, /(^|\/)(schema\.prisma|prisma\/migrations\/|migrations\/)/) ||
    hasFile(changedFiles, /^(packages\/database\/prisma|apps\/mcp-server\/prisma)\//) ||
    hasText(input, /\b(schema|migration|prisma|database)\b/)
  ) {
    gates.push(
      gate({
        id: "policy:schema:production-migration",
        surface: "schema",
        severity: "required_action",
        title: "Schema or migration surface touched",
        rationale:
          "Production schema changes require JS/Python schema sync, an idempotent SQL migration, and deploy replay through the migration path.",
        evidence: changedFiles.filter((file) => /schema\.prisma|prisma|migrations?/.test(file)),
        requiredActions: [
          "Keep JS Prisma schema and Python Prisma mirror synchronized.",
          "Use an idempotent SQL migration for Vaultbrix production.",
          "Do not use destructive Prisma commands.",
        ],
        suggestedCommands: [
          "pnpm --filter @snipara/database prisma validate",
          "deploy/infomaniak/migrate-vaultbrix.sh <migration.sql>",
          "deploy/infomaniak/deploy-zero-downtime.sh all --migrate <migration.sql>",
        ],
        source: "file_pattern",
        reasonCodes: ["schema_surface", "migration_required"],
      })
    );
  }

  if (
    hasFile(
      changedFiles,
      /(^|\/)(auth|oauth|session|sessions|middleware|webhooks?|api-keys?|tokens?)\b/i
    ) ||
    hasFile(changedFiles, /(requireAuth|auth\.ts|webhook|jwt|secret)/i) ||
    hasText(input, /\b(auth|oauth|session|webhook secret|api key|jwt|token|permission)\b/)
  ) {
    gates.push(
      gate({
        id: "policy:auth:security-surface",
        surface: "auth",
        severity: "required_action",
        title: "Auth or secret-sensitive surface touched",
        rationale:
          "Authentication, authorization, webhook, and token changes need focused security checks and sanitized evidence before release.",
        evidence: changedFiles.filter((file) =>
          /(auth|oauth|session|middleware|webhook|token|secret|jwt)/i.test(file)
        ),
        requiredActions: [
          "Run focused auth or webhook regression tests.",
          "Verify unauthorized access fails without logging secrets.",
        ],
        suggestedCommands: ["pnpm --filter @snipara/web type-check"],
        source: "file_pattern",
        reasonCodes: ["auth_surface", "secret_sensitive"],
      })
    );
  }

  if (
    hasFile(
      changedFiles,
      /(^|\/)(billing|stripe|subscription|subscriptions|checkout|portal|pricing|entitlement|usage-limit|usage_limit)\b/i
    ) ||
    hasText(
      input,
      /\b(billing|stripe|subscription|checkout|portal|entitlement|quota|usage limit)\b/
    )
  ) {
    gates.push(
      gate({
        id: "policy:billing:entitlement-surface",
        surface: "billing",
        severity: "required_action",
        title: "Billing or entitlement surface touched",
        rationale:
          "Billing and entitlement changes require plan, quota, checkout, and portal verification before production release.",
        evidence: changedFiles.filter((file) =>
          /(billing|stripe|subscription|checkout|portal|pricing|entitlement|quota)/i.test(file)
        ),
        requiredActions: [
          "Run focused billing or entitlement tests.",
          "Verify plan/quota behavior for free, paid, and missing-subscription states.",
        ],
        suggestedCommands: ["pnpm --filter @snipara/web type-check"],
        source: "file_pattern",
        reasonCodes: ["billing_surface", "entitlement_surface"],
      })
    );
  }

  if (
    hasFile(changedFiles, /^(deploy|\.github\/workflows)\//) ||
    hasFile(
      changedFiles,
      /(^|\/)(Dockerfile|docker-compose|compose\.ya?ml|traefik|scheduled|cron)/i
    ) ||
    hasText(input, /\b(deploy|deployment|ci|github actions|scheduled job|cron|production)\b/)
  ) {
    gates.push(
      gate({
        id: "policy:deploy:production-surface",
        surface: "deploy",
        severity: "required_action",
        title: "Deploy, CI, or runtime surface touched",
        rationale:
          "Deployment and runtime automation changes need guard, build, health, and smoke evidence before promotion.",
        evidence: changedFiles.filter(
          (file) =>
            /^(deploy|\.github\/workflows)\//.test(file) ||
            /(Dockerfile|compose|traefik|scheduled|cron)/i.test(file)
        ),
        requiredActions: [
          "Run the pre-deploy collaboration guard.",
          "Verify production health and deployed marker after deploy.",
        ],
        suggestedCommands: [
          "snipara-companion collaboration guard --profile pre-deploy --enforce --ack-review-only",
          "curl -sS https://www.snipara.com/api/health",
          "curl -sS https://api.snipara.com/health",
        ],
        source: "file_pattern",
        reasonCodes: ["deploy_surface", "runtime_surface"],
      })
    );
  }

  const packageSurfaceTouched =
    hasFile(changedFiles, /^packages\//) ||
    hasFile(changedFiles, /^apps\/mcp-server\/snipara-mcp\//) ||
    hasFile(changedFiles, /(^|\/)(package\.json|pyproject\.toml|pnpm-lock\.yaml)$/) ||
    hasText(input, /\b(package surface|npm|pypi|npx|publish|pack smoke)\b/);
  if (packageSurfaceTouched) {
    const reviewStatus = input.packageReview?.status ?? "missing";
    gates.push(
      gate({
        id: "policy:package:runtime-surface",
        surface: "package_surface",
        severity: "required_action",
        title: "Package runtime surface touched",
        rationale:
          "User-facing package changes need pack smoke, version/publish decisions, and latest-runtime verification before completion.",
        evidence: [
          ...changedFiles.filter((file) =>
            /^packages\/|snipara-mcp|package\.json|pyproject\.toml|pnpm-lock\.yaml/.test(file)
          ),
          `package review ${reviewStatus}`,
        ],
        requiredActions: [
          "Run the relevant package smoke test.",
          "Bump and publish touched package surfaces when latest runtime behavior changes.",
          "Verify the published latest command or package output.",
        ],
        suggestedCommands: [
          packageReviewCommand(input),
          "pnpm --filter snipara-companion pack:smoke",
          "npx snipara-companion@latest --help",
        ],
        source: "file_pattern",
        reasonCodes: [
          "package_surface",
          reviewStatus === "skipped" ? "package_review_skipped" : "package_review_required",
        ],
      })
    );
  }

  const summary = gateSummary(gates);
  const suggestedCommands = [
    ...new Set(gates.flatMap((item) => item.suggestedCommands).filter(Boolean)),
  ];

  return {
    version: "project-intelligence.policy-gates.v1",
    generatedAt: new Date().toISOString(),
    registryVersion: REGISTRY_VERSION,
    release: Boolean(input.release),
    summary,
    gates,
    suggestedCommands,
  };
}

export function formatPolicyGateDecision(gateDecision: ProjectPolicyGateDecision): string[] {
  const lines = [
    `- [${gateDecision.severity}] ${gateDecision.surface}: ${gateDecision.title}`,
    `  Rationale: ${gateDecision.rationale}`,
  ];
  if (gateDecision.requiredActions.length > 0) {
    lines.push(`  Required: ${gateDecision.requiredActions[0]}`);
  }
  if (gateDecision.suggestedCommands[0]) {
    lines.push(`  Command: ${gateDecision.suggestedCommands[0]}`);
  }
  lines.push(
    `  Audit: override ${gateDecision.audit.humanOverrideAllowed ? "allowed with reason" : "not allowed"}; sample gate ${gateDecision.sampleGate.mode}`
  );
  return lines;
}
