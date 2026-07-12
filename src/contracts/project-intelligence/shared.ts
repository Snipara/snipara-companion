export const PROJECT_REALITY_CHECK_FINDING_TYPES = [
  "decision_vs_code",
  "intent_vs_code",
  "docs_vs_code",
  "owner_vs_activity",
  "verification_vs_claim",
  "architecture_drift",
] as const;

export const PROJECT_REALITY_CHECK_SEVERITIES = [
  "info",
  "watch",
  "review_required",
  "blocking",
] as const;

export type ProjectRealityCheckFindingType = (typeof PROJECT_REALITY_CHECK_FINDING_TYPES)[number];
export type ProjectRealityCheckSeverity = (typeof PROJECT_REALITY_CHECK_SEVERITIES)[number];

export interface ProjectRealityCheckEvidenceRef {
  kind: "decision" | "document" | "code" | "test" | "workflow" | "repository" | "manual";
  label: string;
  sourceRef?: string | null;
  strength?: number | null;
}

export interface ProjectRealityCheckIntentInput {
  goal?: string | null;
  constraints?: string[];
  antiGoals?: string[];
  rejectedAlternatives?: string[];
  owner?: string | null;
  freshnessHorizonDays?: number | null;
}

export interface ProjectRealityCheckDecisionInput {
  id: string;
  title: string;
  decision?: string | null;
  rationale?: string | null;
  scope?: string | null;
  status?: string | null;
  owner?: string | null;
  confidenceScore?: number | null;
  affectedAnchors?: string[];
  constraints?: string[];
  antiGoals?: string[];
  rejectedAlternatives?: string[];
  intent?: ProjectRealityCheckIntentInput | null;
  freshnessHorizonDays?: number | null;
  evidence?: ProjectRealityCheckEvidenceRef[];
}

export interface ProjectRealityCheckDocumentInput {
  path: string;
  title?: string | null;
  contentPreview?: string | null;
  kind?: string | null;
  sourceRef?: string | null;
  intent?: ProjectRealityCheckIntentInput | null;
  owner?: string | null;
  freshnessHorizonDays?: number | null;
}

export interface ProjectRealityCheckSymbolInput {
  qualifiedName: string;
  modulePath: string;
  kind?: string | null;
}
export interface ProjectRealityCheckIntentPolicy {
  freshnessHorizonDays?: number | null;
}

export interface ProjectRealityCheckInput {
  source: "local" | "pull_request";
  task?: string | null;
  repository?: string | null;
  pullRequest?: {
    number: number;
    title: string;
    url?: string | null;
    headSha?: string | null;
    baseSha?: string | null;
  } | null;
  branch?: string | null;
  baseRef?: string | null;
  headRef?: string | null;
  changedFiles: string[];
  diffSummary?: string | null;
  decisions?: ProjectRealityCheckDecisionInput[];
  documents?: ProjectRealityCheckDocumentInput[];
  symbols?: ProjectRealityCheckSymbolInput[];
  verificationChecklist?: string[];
  dirtyFiles?: string[];
  intentPolicy?: ProjectRealityCheckIntentPolicy | null;
}
export interface SensitiveSurface {
  key: string;
  label: string;
  type: ProjectRealityCheckFindingType;
  patterns: RegExp[];
  verificationPatterns: RegExp[];
  riskTerms: RegExp[];
  defaultSeverity: ProjectRealityCheckSeverity;
}

export const SENSITIVE_SURFACES: SensitiveSurface[] = [
  {
    key: "billing_atomicity",
    label: "Billing or payment settlement",
    type: "intent_vs_code",
    patterns: [/billing/i, /payment/i, /settlement/i, /invoice/i, /stripe/i],
    verificationPatterns: [/test/i, /spec/i, /e2e/i, /vitest/i, /pytest/i],
    riskTerms: [/async/i, /queue/i, /retry/i, /eventual/i, /background/i, /worker/i],
    defaultSeverity: "review_required",
  },
  {
    key: "auth_security",
    label: "Authentication or authorization",
    type: "verification_vs_claim",
    patterns: [/auth/i, /session/i, /permission/i, /role/i, /oauth/i, /token/i],
    verificationPatterns: [/test/i, /spec/i, /e2e/i, /permission/i, /auth/i],
    riskTerms: [/bypass/i, /public/i, /admin/i, /token/i, /session/i],
    defaultSeverity: "review_required",
  },
  {
    key: "schema_migration",
    label: "Database schema or migration",
    type: "verification_vs_claim",
    patterns: [/schema\.prisma$/i, /prisma\/migrations/i, /migration/i, /sql$/i],
    verificationPatterns: [/migration/i, /schema/i, /prisma/i, /test/i],
    riskTerms: [/drop/i, /delete/i, /reset/i, /force/i, /accept-data-loss/i],
    defaultSeverity: "review_required",
  },
  {
    key: "package_surface",
    label: "Published package or agent surface",
    type: "verification_vs_claim",
    patterns: [/packages\//i, /package\.json$/i, /CHANGELOG\.md$/i, /README\.md$/i],
    verificationPatterns: [/pack/i, /smoke/i, /help/i, /test/i, /type-check/i],
    riskTerms: [/bin/i, /cli/i, /npx/i, /command/i, /public/i],
    defaultSeverity: "watch",
  },
  {
    key: "deployment_surface",
    label: "Deployment or production operations",
    type: "verification_vs_claim",
    patterns: [/deploy/i, /docker/i, /traefik/i, /infomaniak/i, /production/i],
    verificationPatterns: [/smoke/i, /health/i, /ready/i, /deploy/i, /test/i],
    riskTerms: [/production/i, /secret/i, /migrate/i, /zero-downtime/i],
    defaultSeverity: "review_required",
  },
];

export const ARCHITECTURE_RULES = [
  {
    key: "web_mcp_boundary",
    title: "Web/MCP runtime boundary needs review",
    files: [/apps\/web\//i, /apps\/mcp-server\//i],
  },
  {
    key: "database_runtime_boundary",
    title: "Database contract crosses runtime boundary",
    files: [/packages\/database\//i, /apps\/mcp-server\/prisma/i, /apps\/web\//i],
  },
];

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
    ),
  ];
}

export function normalizeText(value: string | null | undefined): string {
  return value?.toLowerCase() ?? "";
}

export function hasPattern(values: string[], patterns: RegExp[]): boolean {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

export function matchesAnyText(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
export function makeScopedId(prefix: string, type: string, key: string, files: string[]): string {
  const compactFiles = files
    .slice(0, 3)
    .map((file) =>
      file
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
    )
    .filter(Boolean)
    .join("-");
  return [prefix, type, key, compactFiles || "project"].join(":").slice(0, 180);
}

export function decisionMatchesChangedFiles(
  decision: ProjectRealityCheckDecisionInput,
  changedFiles: string[]
): boolean {
  const anchors = decision.affectedAnchors ?? [];
  if (anchors.length === 0) return false;
  return anchors.some((anchor) =>
    changedFiles.some((file) => file.includes(anchor) || anchor.includes(file))
  );
}

export function decisionText(decision: ProjectRealityCheckDecisionInput): string {
  return [
    decision.title,
    decision.decision,
    decision.rationale,
    decision.scope,
    decision.owner,
    ...(decision.constraints ?? []),
    ...(decision.antiGoals ?? []),
    ...(decision.rejectedAlternatives ?? []),
    decision.intent?.goal,
    decision.intent?.owner,
    ...(decision.intent?.constraints ?? []),
    ...(decision.intent?.antiGoals ?? []),
    ...(decision.intent?.rejectedAlternatives ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(score: number): ConfidenceBand {
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

export function normalizeConfidenceScore(
  value: number | null | undefined,
  fallback: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function anchorMatchesFile(anchor: string, file: string): boolean {
  const normalizedAnchor = anchor.replace(/^\.\//, "").trim();
  const normalizedFile = file.replace(/^\.\//, "").trim();
  return (
    normalizedAnchor.length > 0 &&
    normalizedFile.length > 0 &&
    (normalizedFile.includes(normalizedAnchor) || normalizedAnchor.includes(normalizedFile))
  );
}

export function surfaceFiles(surface: SensitiveSurface, changedFiles: string[]): string[] {
  return changedFiles.filter((file) => surface.patterns.some((pattern) => pattern.test(file)));
}
