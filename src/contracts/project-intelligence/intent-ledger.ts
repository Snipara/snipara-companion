import {
  SENSITIVE_SURFACES,
  anchorMatchesFile,
  confidenceBand,
  decisionText,
  matchesAnyText,
  normalizeConfidenceScore,
  normalizeText,
  surfaceFiles,
  uniqueStrings,
  type ProjectRealityCheckDecisionInput,
  type ProjectRealityCheckDocumentInput,
  type ProjectRealityCheckEvidenceRef,
  type ProjectRealityCheckInput,
  type ProjectRealityCheckIntentInput,
  type ProjectRealityCheckIntentPolicy,
} from "./shared";

export const PROJECT_INTENT_LEDGER_VERSION = "intent-ledger-v1" as const;

export const PROJECT_INTENT_LEDGER_STATUSES = [
  "approved",
  "review_pending",
  "stale",
  "superseded",
  "contradicted",
] as const;

export const PROJECT_INTENT_LEDGER_COVERAGE_STATES = ["linked", "partial", "missing"] as const;

export type ProjectIntentLedgerStatus = (typeof PROJECT_INTENT_LEDGER_STATUSES)[number];
export type ProjectIntentLedgerCoverageState =
  (typeof PROJECT_INTENT_LEDGER_COVERAGE_STATES)[number];

export interface ProjectIntentLedgerConfidence {
  score: number;
  band: "high" | "medium" | "low";
  state: "confirmed" | "review_pending" | "weak" | "stale" | "conflicted";
  reasonCodes: string[];
}

export interface ProjectIntentLedgerStaleness {
  state: "fresh" | "stale" | "unknown";
  horizonDays?: number | null;
  reason?: string | null;
}

export interface ProjectIntentLedgerExtraction {
  mode: "structured_fields" | "structured_sections" | "legacy_source_fields";
  sourceFields: string[];
  fallbackUsed: boolean;
}

export interface ProjectIntentLedgerEntry {
  id: string;
  title: string;
  status: ProjectIntentLedgerStatus;
  source: "decision" | "document";
  sourceDecisionId?: string | null;
  sourceDocumentPath?: string | null;
  intent: {
    goal: string;
    constraints: string[];
    antiGoals: string[];
    rejectedAlternatives: string[];
  };
  extraction: ProjectIntentLedgerExtraction;
  affectedAnchors: string[];
  owner?: string | null;
  evidence: ProjectRealityCheckEvidenceRef[];
  confidence: ProjectIntentLedgerConfidence;
  staleness: ProjectIntentLedgerStaleness;
  reasonCodes: string[];
  recommendedActions: string[];
  caveats: string[];
}

export interface ProjectIntentLedgerSummary {
  version: typeof PROJECT_INTENT_LEDGER_VERSION;
  coverage: ProjectIntentLedgerCoverageState;
  totalIntentCount: number;
  linkedIntentCount: number;
  missingAnchorCount: number;
  entries: ProjectIntentLedgerEntry[];
  missingAnchors: string[];
  evidence: ProjectRealityCheckEvidenceRef[];
  reasonCodes: string[];
  caveats: string[];
}

export const PROJECT_INTENT_LEDGER_DEFAULT_FRESHNESS_HORIZON_DAYS = 90 as const;

export const DEFAULT_PROJECT_INTENT_LEDGER_POLICY: Required<ProjectRealityCheckIntentPolicy> = {
  freshnessHorizonDays: PROJECT_INTENT_LEDGER_DEFAULT_FRESHNESS_HORIZON_DAYS,
};

const DECISION_STATUS_ALIASES: Record<ProjectIntentLedgerStatus, string[]> = {
  approved: ["approved", "accepted", "active", "confirmed"],
  review_pending: ["review_pending", "pending_review", "pending", "candidate", "draft"],
  stale: ["stale", "expired", "deprecated"],
  superseded: ["superseded", "replaced", "overridden"],
  contradicted: ["contradicted", "conflicted", "conflict"],
};

const INTENT_SECTION_ALIASES = {
  goal: ["goal", "intent", "why", "purpose", "rationale"],
  constraints: ["constraint", "constraints", "rule", "rules", "must"],
  antiGoals: ["anti_goal", "anti_goals", "avoid", "forbidden", "do_not"],
  rejectedAlternatives: [
    "rejected_alternative",
    "rejected_alternatives",
    "rejected",
    "not_chosen",
    "alternative_rejected",
    "alternatives_rejected",
  ],
  owner: ["owner", "owners"],
  freshnessHorizonDays: ["freshness_horizon_days", "horizon_days", "staleness_horizon_days"],
} as const;

const INTENT_DOCUMENT_KIND_TOKENS = [
  "adr",
  "decision",
  "intent",
  "rationale",
  "constraint",
  "architecture",
  "runbook",
];

interface ParsedIntentSections {
  goal?: string | null;
  constraints: string[];
  antiGoals: string[];
  rejectedAlternatives: string[];
  owner?: string | null;
  freshnessHorizonDays?: number | null;
  sourceFields: string[];
}

function normalizeIdentifier(value: string | null | undefined): string {
  const normalized: string[] = [];
  let previousWasSeparator = false;

  for (const char of value?.trim().toLowerCase() ?? "") {
    const code = char.charCodeAt(0);
    const isAlphaNumeric = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);

    if (isAlphaNumeric) {
      normalized.push(char);
      previousWasSeparator = false;
      continue;
    }

    if (!previousWasSeparator && normalized.length > 0) {
      normalized.push("_");
      previousWasSeparator = true;
    }
  }

  if (normalized[normalized.length - 1] === "_") normalized.pop();
  return normalized.join("");
}

function statusFromDecisionStatus(
  decision: ProjectRealityCheckDecisionInput
): ProjectIntentLedgerStatus {
  const status = normalizeIdentifier(decision.status);
  if (!status) return "review_pending";

  for (const [ledgerStatus, aliases] of Object.entries(DECISION_STATUS_ALIASES)) {
    if (aliases.includes(status)) return ledgerStatus as ProjectIntentLedgerStatus;
  }

  const statusParts = status.split("_").filter(Boolean);
  for (const [ledgerStatus, aliases] of Object.entries(DECISION_STATUS_ALIASES)) {
    if (aliases.some((alias) => statusParts.includes(alias))) {
      return ledgerStatus as ProjectIntentLedgerStatus;
    }
  }

  return "review_pending";
}

function intentConfidence(
  score: number,
  status: ProjectIntentLedgerStatus,
  reasonCodes: string[]
): ProjectIntentLedgerConfidence {
  return {
    score,
    band: confidenceBand(score),
    state:
      status === "approved"
        ? "confirmed"
        : status === "stale"
          ? "stale"
          : status === "contradicted"
            ? "conflicted"
            : score < 0.55
              ? "weak"
              : "review_pending",
    reasonCodes,
  };
}

function normalizeFreshnessHorizonDays(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function resolveFreshnessHorizonDays(
  specificValue: number | null | undefined,
  policy: ProjectRealityCheckIntentPolicy
): number | null {
  return (
    normalizeFreshnessHorizonDays(specificValue) ??
    normalizeFreshnessHorizonDays(policy.freshnessHorizonDays) ??
    null
  );
}

function stalenessFromStatus(
  status: ProjectIntentLedgerStatus,
  freshnessHorizonDays: number | null
): ProjectIntentLedgerStaleness {
  if (status === "stale" || status === "superseded") {
    return {
      state: "stale",
      reason:
        status === "superseded"
          ? "The source decision is marked as superseded."
          : "The source decision is marked as stale.",
    };
  }
  if (status === "review_pending") {
    return {
      state: "unknown",
      reason: "The intent has not been reviewed as current project truth.",
    };
  }
  return {
    state: "fresh",
    horizonDays: freshnessHorizonDays,
    reason:
      freshnessHorizonDays === null
        ? "No freshness horizon was supplied by source metadata or policy."
        : null,
  };
}

function intentEntryMatchesFile(entry: ProjectIntentLedgerEntry, file: string): boolean {
  return entry.affectedAnchors.some((anchor) => anchorMatchesFile(anchor, file));
}

function inferDecisionAnchors(
  decision: ProjectRealityCheckDecisionInput,
  changedFiles: string[]
): string[] {
  const explicitAnchors = uniqueStrings(decision.affectedAnchors ?? []);
  if (explicitAnchors.length > 0) return explicitAnchors;

  const text = normalizeText(decisionText(decision));
  const inferred = SENSITIVE_SURFACES.flatMap((surface) =>
    matchesAnyText(text, surface.patterns) ? surfaceFiles(surface, changedFiles) : []
  );
  return uniqueStrings(inferred);
}

function normalizeIntentPhrase(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("- ") || normalized.startsWith("* ")) {
    normalized = normalized.slice(2).trim();
  }

  const dotIndex = normalized.indexOf(". ");
  if (dotIndex > 0) {
    const prefix = normalized.slice(0, dotIndex);
    if ([...prefix].every((char) => char >= "0" && char <= "9")) {
      normalized = normalized.slice(dotIndex + 2).trim();
    }
  }

  return normalized;
}

function splitExplicitIntentList(value: string | null | undefined): string[] {
  if (!value) return [];
  return uniqueStrings(value.split(";").map(normalizeIntentPhrase).filter(Boolean)).slice(0, 6);
}

function normalizeIntentList(values: Array<string | null | undefined>): string[] {
  return uniqueStrings(values.flatMap((value) => splitExplicitIntentList(value))).slice(0, 8);
}

function emptyParsedIntentSections(): ParsedIntentSections {
  return {
    constraints: [],
    antiGoals: [],
    rejectedAlternatives: [],
    sourceFields: [],
  };
}

function intentSectionKey(
  label: string
): keyof Omit<ParsedIntentSections, "sourceFields"> | undefined {
  const normalized = normalizeIdentifier(label);
  for (const [key, aliases] of Object.entries(INTENT_SECTION_ALIASES)) {
    if ((aliases as readonly string[]).includes(normalized)) {
      return key as keyof Omit<ParsedIntentSections, "sourceFields">;
    }
  }
  return undefined;
}

function separatorIndex(value: string): number {
  const colon = value.indexOf(":");
  const equals = value.indexOf("=");
  if (colon < 0) return equals;
  if (equals < 0) return colon;
  return Math.min(colon, equals);
}

function addSectionValue(
  parsed: ParsedIntentSections,
  key: keyof Omit<ParsedIntentSections, "sourceFields">,
  value: string
): void {
  const normalizedValue = normalizeIntentPhrase(value);
  if (!normalizedValue) return;

  parsed.sourceFields.push(key);
  if (key === "goal") {
    parsed.goal = parsed.goal ?? normalizedValue;
    return;
  }
  if (key === "owner") {
    parsed.owner = parsed.owner ?? normalizedValue;
    return;
  }
  if (key === "freshnessHorizonDays") {
    parsed.freshnessHorizonDays =
      parsed.freshnessHorizonDays ?? normalizeFreshnessHorizonDays(Number(normalizedValue));
    return;
  }

  parsed[key].push(...splitExplicitIntentList(normalizedValue));
}

function parseIntentSections(value: string | null | undefined): ParsedIntentSections {
  const parsed = emptyParsedIntentSections();
  if (!value) return parsed;

  let currentKey: keyof Omit<ParsedIntentSections, "sourceFields"> | undefined;
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  for (const rawLine of lines) {
    const line = normalizeIntentPhrase(rawLine);
    if (!line) continue;

    const splitAt = separatorIndex(line);
    if (splitAt > 0) {
      const maybeKey = intentSectionKey(line.slice(0, splitAt));
      if (maybeKey) {
        currentKey = maybeKey;
        addSectionValue(parsed, maybeKey, line.slice(splitAt + 1));
        continue;
      }
    }

    if (currentKey && (rawLine.trim().startsWith("- ") || rawLine.trim().startsWith("* "))) {
      addSectionValue(parsed, currentKey, line);
    }
  }

  return {
    ...parsed,
    constraints: uniqueStrings(parsed.constraints).slice(0, 8),
    antiGoals: uniqueStrings(parsed.antiGoals).slice(0, 8),
    rejectedAlternatives: uniqueStrings(parsed.rejectedAlternatives).slice(0, 8),
    sourceFields: uniqueStrings(parsed.sourceFields),
  };
}

function hasStructuredIntentFields(intent: ProjectRealityCheckIntentInput | null | undefined) {
  return Boolean(
    intent?.goal ||
    intent?.owner ||
    intent?.freshnessHorizonDays ||
    (intent?.constraints?.length ?? 0) > 0 ||
    (intent?.antiGoals?.length ?? 0) > 0 ||
    (intent?.rejectedAlternatives?.length ?? 0) > 0
  );
}

function extractionMetadata(input: {
  structuredFields: boolean;
  structuredSections: ParsedIntentSections;
  fallbackUsed: boolean;
}): ProjectIntentLedgerExtraction {
  const sectionFields = input.structuredSections.sourceFields.map((field) => `section:${field}`);
  return {
    mode: input.structuredFields
      ? "structured_fields"
      : sectionFields.length > 0
        ? "structured_sections"
        : "legacy_source_fields",
    sourceFields: uniqueStrings([
      input.structuredFields ? "intent" : undefined,
      ...sectionFields,
    ]).slice(0, 12),
    fallbackUsed: input.fallbackUsed,
  };
}

function textHasAnyToken(value: string, tokens: string[]): boolean {
  const normalized = normalizeIdentifier(value);
  const parts = normalized.split("_").filter(Boolean);
  return tokens.some((token) => parts.includes(token));
}

function documentLooksLikeIntent(doc: ProjectRealityCheckDocumentInput): boolean {
  if (hasStructuredIntentFields(doc.intent)) return true;
  if (parseIntentSections(doc.contentPreview).sourceFields.length > 0) return true;
  return [doc.path, doc.title, doc.kind].some((value) =>
    textHasAnyToken(value ?? "", INTENT_DOCUMENT_KIND_TOKENS)
  );
}

function buildDecisionIntentEntry(
  decision: ProjectRealityCheckDecisionInput,
  changedFiles: string[],
  policy: ProjectRealityCheckIntentPolicy
): ProjectIntentLedgerEntry {
  const status = statusFromDecisionStatus(decision);
  const anchors = inferDecisionAnchors(decision, changedFiles);
  const sectionIntent = parseIntentSections(
    [decision.scope, decision.rationale, decision.decision].join("\n")
  );
  const structuredFields = hasStructuredIntentFields(decision.intent);
  const fallbackGoal = decision.rationale || decision.decision || decision.title;
  const goal = decision.intent?.goal || sectionIntent.goal || fallbackGoal;
  const confidenceScore = normalizeConfidenceScore(
    decision.confidenceScore,
    status === "approved" ? 0.86 : 0.66
  );
  const freshnessHorizonDays = resolveFreshnessHorizonDays(
    decision.intent?.freshnessHorizonDays ??
      decision.freshnessHorizonDays ??
      sectionIntent.freshnessHorizonDays,
    policy
  );
  const reasonCodes = uniqueStrings([
    "decision_intent",
    status === "approved" ? "reviewed_source" : "review_needed",
    anchors.length > 0 ? "affected_anchors_present" : "affected_anchors_missing",
    structuredFields ? "structured_intent_fields" : undefined,
    sectionIntent.sourceFields.length > 0 ? "structured_intent_sections" : undefined,
    goal === fallbackGoal ? "legacy_goal_fallback" : undefined,
  ]);

  return {
    id: `intent:${decision.id}`,
    title: decision.title,
    status,
    source: "decision",
    sourceDecisionId: decision.id,
    sourceDocumentPath: null,
    intent: {
      goal,
      constraints: uniqueStrings([
        ...(decision.constraints ?? []),
        ...(decision.intent?.constraints ?? []),
        ...sectionIntent.constraints,
      ]).slice(0, 8),
      antiGoals: normalizeIntentList([
        ...(decision.antiGoals ?? []),
        ...(decision.intent?.antiGoals ?? []),
        ...sectionIntent.antiGoals,
      ]),
      rejectedAlternatives: normalizeIntentList([
        ...(decision.rejectedAlternatives ?? []),
        ...(decision.intent?.rejectedAlternatives ?? []),
        ...sectionIntent.rejectedAlternatives,
      ]),
    },
    extraction: extractionMetadata({
      structuredFields,
      structuredSections: sectionIntent,
      fallbackUsed: goal === fallbackGoal,
    }),
    affectedAnchors: anchors,
    owner: decision.intent?.owner ?? sectionIntent.owner ?? decision.owner ?? null,
    evidence:
      decision.evidence && decision.evidence.length > 0
        ? decision.evidence
        : [
            {
              kind: "decision",
              label: `${decision.id}: ${decision.title}`,
              sourceRef: decision.id,
              strength: confidenceScore,
            },
          ],
    confidence: intentConfidence(confidenceScore, status, reasonCodes),
    staleness: stalenessFromStatus(status, freshnessHorizonDays),
    reasonCodes,
    recommendedActions:
      status === "approved"
        ? ["Keep this intent linked when changing its affected anchors."]
        : ["Review this intent candidate before treating it as governing project truth."],
    caveats: [
      "Intent Ledger V1 preserves source-backed intent; it does not infer unstated architecture rules.",
    ],
  };
}

function buildDocumentIntentEntry(
  doc: ProjectRealityCheckDocumentInput,
  policy: ProjectRealityCheckIntentPolicy
): ProjectIntentLedgerEntry {
  const sectionIntent = parseIntentSections(doc.contentPreview);
  const structuredFields = hasStructuredIntentFields(doc.intent);
  const goal = doc.intent?.goal ?? sectionIntent.goal ?? doc.title ?? doc.path;
  const reasonCodes = uniqueStrings([
    "document_intent_candidate",
    "review_needed",
    structuredFields ? "structured_intent_fields" : undefined,
    sectionIntent.sourceFields.length > 0 ? "structured_intent_sections" : undefined,
    goal === doc.path || goal === doc.title ? "legacy_goal_fallback" : undefined,
  ]);
  const confidenceScore = textHasAnyToken(doc.kind ?? "", ["adr", "decision"]) ? 0.66 : 0.58;
  const freshnessHorizonDays = resolveFreshnessHorizonDays(
    doc.intent?.freshnessHorizonDays ??
      doc.freshnessHorizonDays ??
      sectionIntent.freshnessHorizonDays,
    policy
  );
  const affectedAnchors = uniqueStrings(
    doc.affectedAnchors && doc.affectedAnchors.length > 0 ? doc.affectedAnchors : [doc.path]
  );
  return {
    id: `intent:doc:${doc.path}`,
    title: doc.title || doc.path,
    status: "review_pending",
    source: "document",
    sourceDecisionId: null,
    sourceDocumentPath: doc.path,
    intent: {
      goal,
      constraints: uniqueStrings([
        ...(doc.intent?.constraints ?? []),
        ...sectionIntent.constraints,
      ]).slice(0, 4),
      antiGoals: normalizeIntentList([
        ...(doc.intent?.antiGoals ?? []),
        ...sectionIntent.antiGoals,
      ]),
      rejectedAlternatives: normalizeIntentList([
        ...(doc.intent?.rejectedAlternatives ?? []),
        ...sectionIntent.rejectedAlternatives,
      ]),
    },
    extraction: extractionMetadata({
      structuredFields,
      structuredSections: sectionIntent,
      fallbackUsed: goal === doc.path || goal === doc.title,
    }),
    affectedAnchors,
    owner: doc.intent?.owner ?? sectionIntent.owner ?? doc.owner ?? null,
    evidence: [
      {
        kind: "document",
        label: doc.title ? `${doc.path}: ${doc.title}` : doc.path,
        sourceRef: doc.sourceRef ?? doc.path,
        strength: confidenceScore,
      },
    ],
    confidence: intentConfidence(confidenceScore, "review_pending", reasonCodes),
    staleness: {
      state: "unknown",
      reason: "Document-derived intent candidates need review before becoming governing truth.",
      horizonDays: freshnessHorizonDays,
    },
    reasonCodes,
    recommendedActions: ["Promote, reject, or link this document intent candidate to a decision."],
    caveats: [
      "Document candidates are weaker than reviewed decisions until authority is confirmed.",
    ],
  };
}

export function buildProjectIntentLedger(
  input: ProjectRealityCheckInput,
  changedFilesOverride?: string[]
): ProjectIntentLedgerSummary {
  const changedFiles = uniqueStrings(changedFilesOverride ?? input.changedFiles);
  const policy = {
    ...DEFAULT_PROJECT_INTENT_LEDGER_POLICY,
    ...(input.intentPolicy ?? {}),
  };
  const decisionEntries = (input.decisions ?? []).map((decision) =>
    buildDecisionIntentEntry(decision, changedFiles, policy)
  );
  const decisionDocumentPaths = new Set(
    decisionEntries.flatMap((entry) =>
      entry.evidence.map((evidence) => evidence.sourceRef).filter(Boolean)
    )
  );
  const documentEntries = (input.documents ?? [])
    .filter(documentLooksLikeIntent)
    .filter((doc) => !decisionDocumentPaths.has(doc.path))
    .map((doc) => buildDocumentIntentEntry(doc, policy));
  const entries = [...decisionEntries, ...documentEntries];
  const linkedIntentIds = new Set(
    entries
      .filter((entry) => changedFiles.some((file) => intentEntryMatchesFile(entry, file)))
      .map((entry) => entry.id)
  );
  const missingAnchors = changedFiles.filter(
    (file) => !entries.some((entry) => intentEntryMatchesFile(entry, file))
  );
  const coverage: ProjectIntentLedgerCoverageState =
    changedFiles.length === 0 || (entries.length > 0 && missingAnchors.length === 0)
      ? "linked"
      : entries.length === 0
        ? "missing"
        : "partial";
  const reasonCodes = uniqueStrings([
    coverage === "linked" ? "intent_coverage_linked" : undefined,
    coverage === "partial" ? "intent_coverage_partial" : undefined,
    coverage === "missing" ? "intent_coverage_missing" : undefined,
    entries.some((entry) => entry.status === "review_pending")
      ? "intent_review_pending"
      : undefined,
    entries.some((entry) => entry.staleness.state !== "fresh")
      ? "intent_freshness_unknown"
      : undefined,
  ]);

  return {
    version: PROJECT_INTENT_LEDGER_VERSION,
    coverage,
    totalIntentCount: entries.length,
    linkedIntentCount: linkedIntentIds.size,
    missingAnchorCount: missingAnchors.length,
    entries: entries.slice(0, 20),
    missingAnchors: missingAnchors.slice(0, 20),
    evidence: entries.flatMap((entry) => entry.evidence).slice(0, 10),
    reasonCodes,
    caveats: [
      "Intent Ledger V1 is a deterministic projection from supplied decisions and documents.",
      coverage === "missing"
        ? "Missing intent means no linked source was supplied for this scope, not that no governing intent exists."
        : undefined,
    ].filter((item): item is string => Boolean(item)),
  };
}
