import {
  confidenceBand,
  makeScopedId,
  uniqueStrings,
  type ProjectRealityCheckEvidenceRef,
  type ProjectRealityCheckInput,
  type ProjectRealityCheckSeverity,
} from "./shared";
import type { ProjectIntentLedgerConfidence, ProjectIntentLedgerSummary } from "./intent-ledger";
import type { ProjectRealityCheckFinding } from "./reality-check";

export const PROJECT_UNKNOWN_REGISTRY_VERSION = "unknown-registry-v1" as const;

export const PROJECT_UNKNOWN_REGISTRY_CATEGORIES = [
  "missing_intent",
  "missing_verification",
  "intent_review_pending",
  "stale_intent",
  "dirty_local_evidence",
  "architecture_drift",
  "heuristic_calibration",
] as const;

export const PROJECT_UNKNOWN_REGISTRY_STATUSES = ["clear", "watch", "risk"] as const;

export type ProjectUnknownRegistryCategory = (typeof PROJECT_UNKNOWN_REGISTRY_CATEGORIES)[number];
export type ProjectUnknownRegistryStatus = (typeof PROJECT_UNKNOWN_REGISTRY_STATUSES)[number];

export interface ProjectUnknownRegistryEntry {
  id: string;
  category: ProjectUnknownRegistryCategory;
  severity: ProjectRealityCheckSeverity;
  title: string;
  summary: string;
  scope: string[];
  ownerCandidate?: string | null;
  confidence: ProjectIntentLedgerConfidence;
  linkedFindingIds: string[];
  linkedIntentIds: string[];
  evidence: ProjectRealityCheckEvidenceRef[];
  reasonCodes: string[];
  resolutionActions: string[];
  closureEvidenceRequired: string[];
  caveats: string[];
}

export interface ProjectUnknownRegistrySummary {
  version: typeof PROJECT_UNKNOWN_REGISTRY_VERSION;
  status: ProjectUnknownRegistryStatus;
  unknownCount: number;
  riskCount: number;
  watchCount: number;
  categories: ProjectUnknownRegistryCategory[];
  unknowns: ProjectUnknownRegistryEntry[];
  evidence: ProjectRealityCheckEvidenceRef[];
  reasonCodes: string[];
  caveats: string[];
}
function unknownId(category: ProjectUnknownRegistryCategory, key: string, scope: string[]) {
  return makeScopedId("unknown", category, key, scope);
}

function unknownStatusFromSeverity(
  unknowns: ProjectUnknownRegistryEntry[]
): ProjectUnknownRegistryStatus {
  if (
    unknowns.some(
      (unknown) => unknown.severity === "blocking" || unknown.severity === "review_required"
    )
  ) {
    return "risk";
  }
  if (unknowns.some((unknown) => unknown.severity === "watch")) return "watch";
  return "clear";
}

function unknownConfidence(
  score: number,
  state: ProjectIntentLedgerConfidence["state"],
  reasonCodes: string[]
): ProjectIntentLedgerConfidence {
  return {
    score,
    band: confidenceBand(score),
    state,
    reasonCodes,
  };
}

function makeUnknown(input: {
  category: ProjectUnknownRegistryCategory;
  severity: ProjectRealityCheckSeverity;
  title: string;
  summary: string;
  scope: string[];
  ownerCandidate?: string | null;
  confidenceScore: number;
  confidenceState?: ProjectIntentLedgerConfidence["state"];
  linkedFindingIds?: string[];
  linkedIntentIds?: string[];
  evidence?: ProjectRealityCheckEvidenceRef[];
  reasonCodes: string[];
  resolutionActions: string[];
  closureEvidenceRequired: string[];
  caveats?: string[];
}): ProjectUnknownRegistryEntry {
  return {
    id: unknownId(input.category, input.title, input.scope),
    category: input.category,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    scope: input.scope.slice(0, 12),
    ownerCandidate: input.ownerCandidate ?? null,
    confidence: unknownConfidence(
      input.confidenceScore,
      input.confidenceState ?? "review_pending",
      input.reasonCodes
    ),
    linkedFindingIds: input.linkedFindingIds ?? [],
    linkedIntentIds: input.linkedIntentIds ?? [],
    evidence: (input.evidence ?? []).slice(0, 8),
    reasonCodes: input.reasonCodes,
    resolutionActions: input.resolutionActions,
    closureEvidenceRequired: input.closureEvidenceRequired,
    caveats: input.caveats ?? [],
  };
}

export function buildProjectUnknownRegistry(input: {
  realityCheck: ProjectRealityCheckInput;
  changedFiles: string[];
  dirtyFiles: string[];
  findings: ProjectRealityCheckFinding[];
  intentLedger: ProjectIntentLedgerSummary;
}): ProjectUnknownRegistrySummary {
  const unknowns: ProjectUnknownRegistryEntry[] = [];

  if (input.intentLedger.missingAnchors.length > 0) {
    unknowns.push(
      makeUnknown({
        category: "missing_intent",
        severity: input.findings.some((finding) => finding.severity === "review_required")
          ? "review_required"
          : "watch",
        title: "Governing intent is not linked for part of this scope",
        summary:
          "At least one changed anchor has no linked reviewed decision or document intent. This is an unknown, not proof that no constraint exists.",
        scope: input.intentLedger.missingAnchors,
        confidenceScore: 0.86,
        linkedFindingIds: input.findings
          .filter((finding) => finding.reasonCodes.includes("missing_intent"))
          .map((finding) => finding.id),
        evidence: input.intentLedger.evidence,
        reasonCodes: ["missing_intent", "unknown_governing_decision"],
        resolutionActions: [
          "Link an existing decision, approve a review-pending intent, or create a new decision candidate.",
        ],
        closureEvidenceRequired: [
          "Reviewed decision, ADR, issue, PR Answer Pack, or final workflow commit linked to the changed anchor.",
        ],
        caveats: [
          "Retrieval/index freshness can make linked intent appear missing until context is refreshed.",
        ],
      })
    );
  }

  for (const entry of input.intentLedger.entries) {
    if (entry.status === "review_pending") {
      unknowns.push(
        makeUnknown({
          category: "intent_review_pending",
          severity: "watch",
          title: `Intent needs review: ${entry.title}`,
          summary:
            "A source-backed intent candidate exists, but it is not reviewed enough to act as governing project truth.",
          scope: entry.affectedAnchors,
          confidenceScore: entry.confidence.score,
          linkedIntentIds: [entry.id],
          evidence: entry.evidence,
          reasonCodes: ["intent_review_pending"],
          resolutionActions: ["Approve, reject, supersede, or link this intent candidate."],
          closureEvidenceRequired: ["Review receipt or approved ProjectDecision authority state."],
          caveats: entry.caveats,
        })
      );
    }
    if (entry.status === "stale" || entry.status === "superseded") {
      unknowns.push(
        makeUnknown({
          category: "stale_intent",
          severity: "review_required",
          title: `Intent may be stale: ${entry.title}`,
          summary:
            "A linked intent is stale or superseded; current implementation may no longer match the original rationale.",
          scope: entry.affectedAnchors,
          confidenceScore: 0.78,
          confidenceState: "stale",
          linkedIntentIds: [entry.id],
          evidence: entry.evidence,
          reasonCodes: ["stale_intent", entry.status],
          resolutionActions: [
            "Refresh, supersede, or archive the stale intent before relying on it.",
          ],
          closureEvidenceRequired: ["Updated decision or explicit supersession evidence."],
          caveats: entry.caveats,
        })
      );
    }
  }

  for (const finding of input.findings) {
    if (finding.reasonCodes.includes("verification_missing")) {
      unknowns.push(
        makeUnknown({
          category: "missing_verification",
          severity: finding.severity,
          title: `Verification gap: ${finding.title}`,
          summary:
            "The change touches a sensitive surface but no matching verification evidence was supplied.",
          scope: finding.changedFiles,
          confidenceScore: 0.82,
          linkedFindingIds: [finding.id],
          linkedIntentIds: finding.decisionIds.map((id) => `intent:${id}`),
          evidence: finding.evidence,
          reasonCodes: ["missing_verification", ...finding.reasonCodes],
          resolutionActions: finding.recommendedActions,
          closureEvidenceRequired: [
            "Focused test, smoke check, review proof, or verification checklist item linked to the changed behavior.",
          ],
          caveats: finding.caveats,
        })
      );
    }

    if (finding.type === "architecture_drift") {
      unknowns.push(
        makeUnknown({
          category: "architecture_drift",
          severity: finding.severity,
          title: finding.title,
          summary:
            "A boundary-spanning change needs architecture-intent confirmation before treating the current dependency shape as intended.",
          scope: finding.changedFiles,
          confidenceScore: 0.72,
          linkedFindingIds: [finding.id],
          evidence: finding.evidence,
          reasonCodes: ["architecture_drift_unknown", ...finding.reasonCodes],
          resolutionActions: finding.recommendedActions,
          closureEvidenceRequired: [
            "Architecture rule, reviewed decision, or code graph evidence proving the boundary is intentional.",
          ],
          caveats: finding.caveats,
        })
      );
    }

    if (
      finding.reasonCodes.includes("risk_term_in_diff") ||
      (finding.reasonCodes.includes("no_linked_decision") && finding.severity === "review_required")
    ) {
      unknowns.push(
        makeUnknown({
          category: "heuristic_calibration",
          severity: "watch",
          title: `Heuristic signal needs calibration: ${finding.title}`,
          summary:
            "Reality Check V1 used regex/path/free-text signals for this finding. Keep it advisory or narrow-scope until project-specific thresholds are calibrated.",
          scope: finding.changedFiles,
          confidenceScore: 0.68,
          confidenceState: "weak",
          linkedFindingIds: [finding.id],
          evidence: finding.evidence,
          reasonCodes: ["heuristic_calibration_needed", ...finding.reasonCodes],
          resolutionActions: [
            "Confirm the finding against structured intent, tests, or reviewed project-specific rules before broad CI gating.",
          ],
          closureEvidenceRequired: [
            "Reviewed calibration decision or false-positive/true-positive outcome history for this surface.",
          ],
          caveats: [
            "--enforce should remain opt-in for this finding family until calibration evidence exists.",
          ],
        })
      );
    }
  }

  if (input.dirtyFiles.length > 0) {
    unknowns.push(
      makeUnknown({
        category: "dirty_local_evidence",
        severity: "watch",
        title: "Local dirty evidence is not hosted truth",
        summary:
          "The local scan included dirty files that hosted PR checks and code graph indexes cannot see until committed.",
        scope: input.dirtyFiles,
        confidenceScore: 0.9,
        linkedFindingIds: input.findings
          .filter((finding) => finding.reasonCodes.includes("dirty_working_tree"))
          .map((finding) => finding.id),
        evidence: input.dirtyFiles.map((file) => ({
          kind: "repository" as const,
          label: file,
          sourceRef: file,
          strength: 0.5,
        })),
        reasonCodes: ["dirty_local_evidence", "hosted_context_gap"],
        resolutionActions: [
          "Commit, stash, or exclude dirty files before relying on hosted checks.",
        ],
        closureEvidenceRequired: ["Clean git status or explicit review of dirty files."],
        caveats: ["Dirty-file unknowns are local-only and should not be treated as PR evidence."],
      })
    );
  }

  const deduped = Array.from(
    new Map(unknowns.map((unknown) => [unknown.id, unknown])).values()
  ).slice(0, 24);
  const status = unknownStatusFromSeverity(deduped);
  return {
    version: PROJECT_UNKNOWN_REGISTRY_VERSION,
    status,
    unknownCount: deduped.length,
    riskCount: deduped.filter(
      (unknown) => unknown.severity === "review_required" || unknown.severity === "blocking"
    ).length,
    watchCount: deduped.filter((unknown) => unknown.severity === "watch").length,
    categories: uniqueStrings(
      deduped.map((unknown) => unknown.category)
    ) as ProjectUnknownRegistryCategory[],
    unknowns: deduped,
    evidence: deduped.flatMap((unknown) => unknown.evidence).slice(0, 12),
    reasonCodes: uniqueStrings(deduped.flatMap((unknown) => unknown.reasonCodes)).slice(0, 24),
    caveats: [
      "Unknown Registry V1 records evidence-backed gaps; closing an unknown requires source-backed evidence.",
      deduped.some((unknown) => unknown.category === "heuristic_calibration")
        ? "Heuristic calibration unknowns prevent regex/path findings from masquerading as fully calibrated truth."
        : undefined,
    ].filter((item): item is string => Boolean(item)),
  };
}
