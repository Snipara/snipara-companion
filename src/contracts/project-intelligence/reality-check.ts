import {
  ARCHITECTURE_RULES,
  SENSITIVE_SURFACES,
  decisionMatchesChangedFiles,
  decisionText,
  hasPattern,
  makeScopedId,
  matchesAnyText,
  normalizeText,
  surfaceFiles,
  uniqueStrings,
  type ProjectRealityCheckDecisionInput,
  type ProjectRealityCheckEvidenceRef,
  type ProjectRealityCheckFindingType,
  type ProjectRealityCheckInput,
  type ProjectRealityCheckSeverity,
} from "./shared";
import { buildProjectIntentLedger, type ProjectIntentLedgerSummary } from "./intent-ledger";
import {
  buildProjectUnknownRegistry,
  type ProjectUnknownRegistrySummary,
} from "./unknown-registry";

export const PROJECT_REALITY_CHECK_VERSION = "project-reality-check-v0" as const;

export const PROJECT_REALITY_CHECK_STATUSES = [
  "pass",
  "advisory",
  "review_required",
  "blocking",
] as const;

export type ProjectRealityCheckStatus = (typeof PROJECT_REALITY_CHECK_STATUSES)[number];

export interface ProjectRealityCheckFinding {
  id: string;
  type: ProjectRealityCheckFindingType;
  severity: ProjectRealityCheckSeverity;
  title: string;
  summary: string;
  changedFiles: string[];
  decisionIds: string[];
  evidence: ProjectRealityCheckEvidenceRef[];
  reasonCodes: string[];
  recommendedActions: string[];
  caveats: string[];
}

export interface ProjectRealityCheckResult {
  version: typeof PROJECT_REALITY_CHECK_VERSION;
  generatedAt: string;
  status: ProjectRealityCheckStatus;
  score: number;
  source: ProjectRealityCheckInput["source"];
  summary: string;
  changedFileCount: number;
  findingCount: number;
  findings: ProjectRealityCheckFinding[];
  intentLedger: ProjectIntentLedgerSummary;
  unknownRegistry: ProjectUnknownRegistrySummary;
  requiredActions: string[];
  watchItems: string[];
  reasonCodes: string[];
  caveats: string[];
}
function findingSeverityScore(severity: ProjectRealityCheckSeverity): number {
  if (severity === "blocking") return 0;
  if (severity === "review_required") return 30;
  if (severity === "watch") return 70;
  return 90;
}

function resultStatusFromFindings(
  findings: ProjectRealityCheckFinding[]
): ProjectRealityCheckStatus {
  if (findings.some((finding) => finding.severity === "blocking")) return "blocking";
  if (findings.some((finding) => finding.severity === "review_required")) return "review_required";
  if (findings.some((finding) => finding.severity === "watch")) return "advisory";
  return "pass";
}

function makeFindingId(type: ProjectRealityCheckFindingType, key: string, files: string[]): string {
  return makeScopedId("reality", type, key, files);
}

function testFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((file) =>
    /(^|\/)(__tests__|tests?|e2e)(\/|$)|(\.test|\.spec)\.[jt]sx?$/i.test(file)
  );
}

function docEvidence(input: ProjectRealityCheckInput): ProjectRealityCheckEvidenceRef[] {
  return (input.documents ?? []).slice(0, 5).map((doc) => ({
    kind: "document",
    label: doc.title ? `${doc.path}: ${doc.title}` : doc.path,
    sourceRef: doc.sourceRef ?? doc.path,
    strength: 0.6,
  }));
}

function symbolEvidence(input: ProjectRealityCheckInput): ProjectRealityCheckEvidenceRef[] {
  return (input.symbols ?? []).slice(0, 5).map((symbol) => ({
    kind: "code",
    label: `${symbol.qualifiedName} (${symbol.modulePath})`,
    sourceRef: symbol.modulePath,
    strength: 0.7,
  }));
}

function decisionEvidence(
  decisions: ProjectRealityCheckDecisionInput[]
): ProjectRealityCheckEvidenceRef[] {
  return decisions.slice(0, 5).map((decision) => ({
    kind: "decision",
    label: `${decision.id}: ${decision.title}`,
    sourceRef: decision.id,
    strength: decision.confidenceScore ?? 0.8,
  }));
}

export function buildProjectRealityCheck(
  input: ProjectRealityCheckInput
): ProjectRealityCheckResult {
  const changedFiles = uniqueStrings(input.changedFiles);
  const dirtyFiles = uniqueStrings(input.dirtyFiles ?? []);
  const diffText = normalizeText(input.diffSummary);
  const tests = testFiles(changedFiles);
  const findings: ProjectRealityCheckFinding[] = [];
  const decisions = input.decisions ?? [];
  const contextEvidence = [...docEvidence(input), ...symbolEvidence(input)];
  const intentLedger = buildProjectIntentLedger(input, changedFiles);

  for (const surface of SENSITIVE_SURFACES) {
    const files = surfaceFiles(surface, changedFiles);
    if (files.length === 0) continue;

    const relatedDecisions = decisions.filter(
      (decision) =>
        decisionMatchesChangedFiles(decision, files) ||
        matchesAnyText(normalizeText(decisionText(decision)), surface.patterns)
    );
    const hasVerification =
      tests.length > 0 ||
      hasPattern(input.verificationChecklist ?? [], surface.verificationPatterns);
    const hasRiskTerm = matchesAnyText(diffText, surface.riskTerms);
    const severity: ProjectRealityCheckSeverity =
      surface.defaultSeverity === "watch"
        ? relatedDecisions.length > 0 && !hasVerification
          ? "review_required"
          : "watch"
        : hasVerification && !hasRiskTerm
          ? "watch"
          : surface.defaultSeverity;

    const reasonCodes = uniqueStrings([
      surface.key,
      relatedDecisions.length > 0 ? "linked_decision_touched" : "no_linked_decision",
      hasVerification ? "verification_present" : "verification_missing",
      hasRiskTerm ? "risk_term_in_diff" : undefined,
    ]);
    const recommendedActions = [
      hasVerification
        ? `Verify the ${surface.label.toLowerCase()} tests cover the changed behavior.`
        : `Add or cite verification for the ${surface.label.toLowerCase()} change before merge.`,
      relatedDecisions.length > 0
        ? "Review the linked decision intent and supersede it if the implementation intentionally changes the rule."
        : "Capture or link the governing intent if this surface has no reviewed decision.",
    ];

    findings.push({
      id: makeFindingId(surface.type, surface.key, files),
      type: surface.type,
      severity,
      title: `${surface.label} needs a reality check`,
      summary: `${files.length} changed file(s) touch ${surface.label.toLowerCase()} with ${
        relatedDecisions.length > 0
          ? `${relatedDecisions.length} linked decision(s)`
          : "no linked decision"
      } and ${hasVerification ? "some verification evidence" : "no obvious verification evidence"}.`,
      changedFiles: files.slice(0, 12),
      decisionIds: relatedDecisions.map((decision) => decision.id).slice(0, 8),
      evidence: [...decisionEvidence(relatedDecisions), ...contextEvidence].slice(0, 8),
      reasonCodes,
      recommendedActions,
      caveats: [
        "V0 uses path, decision, document, and verification signals; it does not prove semantic causality.",
      ],
    });
  }

  for (const rule of ARCHITECTURE_RULES) {
    const matchedGroups = rule.files.filter((patterns) =>
      changedFiles.some((file) => patterns.test(file))
    );
    if (matchedGroups.length < 2) continue;
    const files = changedFiles.filter((file) => rule.files.some((pattern) => pattern.test(file)));
    findings.push({
      id: makeFindingId("architecture_drift", rule.key, files),
      type: "architecture_drift",
      severity: "watch",
      title: rule.title,
      summary:
        "This change spans architectural boundaries. Verify that the dependency direction and runtime ownership still match the intended architecture.",
      changedFiles: files.slice(0, 12),
      decisionIds: [],
      evidence: contextEvidence.slice(0, 6),
      reasonCodes: [rule.key, "cross_boundary_change"],
      recommendedActions: [
        "Check that the changed modules do not introduce a forbidden runtime dependency.",
        "Document the boundary intent if this cross-boundary change is intentional.",
      ],
      caveats: [
        "Architecture drift V0 is boundary-based; import-level drift needs code graph confirmation.",
      ],
    });
  }

  if (
    changedFiles.length > 0 &&
    intentLedger.linkedIntentCount === 0 &&
    (input.source === "pull_request" || findings.length > 0)
  ) {
    findings.push({
      id: makeFindingId("decision_vs_code", "missing_intent", changedFiles),
      type: "decision_vs_code",
      severity: findings.some((finding) => finding.severity === "review_required")
        ? "watch"
        : "info",
      title: "No governing intent was linked",
      summary:
        "No reviewed decision or intent was linked to this change. This is an unknown, not proof that no constraint exists.",
      changedFiles: changedFiles.slice(0, 12),
      decisionIds: [],
      evidence: contextEvidence.slice(0, 6),
      reasonCodes: ["missing_intent", "unknown_governing_decision"],
      recommendedActions: [
        "Link an existing decision or capture a review-pending intent if this change establishes a durable rule.",
      ],
      caveats: [
        "A missing linked decision can reflect retrieval/index freshness rather than missing project truth.",
      ],
    });
  }

  if (dirtyFiles.length > 0 && input.source === "local") {
    findings.push({
      id: makeFindingId("verification_vs_claim", "dirty_worktree", dirtyFiles),
      type: "verification_vs_claim",
      severity: "watch",
      title: "Dirty local files are part of the reality check",
      summary: `${dirtyFiles.length} dirty file(s) were included in the local scan; verify they are intentional before push.`,
      changedFiles: dirtyFiles.slice(0, 12),
      decisionIds: [],
      evidence: dirtyFiles.slice(0, 6).map((file) => ({
        kind: "repository" as const,
        label: file,
        sourceRef: file,
        strength: 0.5,
      })),
      reasonCodes: ["dirty_working_tree"],
      recommendedActions: [
        "Review dirty files separately from committed PR or upstream diff evidence.",
      ],
      caveats: [
        "Dirty working-tree evidence is local-only and will not exist in hosted PR checks until committed.",
      ],
    });
  }

  const status = resultStatusFromFindings(findings);
  const score =
    findings.length === 0
      ? 95
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              Math.min(...findings.map((finding) => findingSeverityScore(finding.severity))) -
                Math.max(0, findings.length - 1) * 4
            )
          )
        );
  const requiredActions = uniqueStrings(
    findings
      .filter(
        (finding) => finding.severity === "review_required" || finding.severity === "blocking"
      )
      .flatMap((finding) => finding.recommendedActions)
  ).slice(0, 10);
  const watchItems = uniqueStrings(
    findings
      .filter((finding) => finding.severity === "watch" || finding.severity === "info")
      .map((finding) => finding.summary)
  ).slice(0, 10);
  const reasonCodes = uniqueStrings(findings.flatMap((finding) => finding.reasonCodes)).slice(
    0,
    20
  );
  const unknownRegistry = buildProjectUnknownRegistry({
    realityCheck: input,
    changedFiles,
    dirtyFiles,
    findings,
    intentLedger,
  });
  const caveats = uniqueStrings([
    "Project Reality Check V0 is advisory and evidence-backed; it is not deterministic repository simulation.",
    input.source === "local"
      ? "Local results may include dirty files that hosted PR checks cannot see."
      : "PR results are scoped to GitHub-provided PR files and indexed Snipara context.",
  ]);

  return {
    version: PROJECT_REALITY_CHECK_VERSION,
    generatedAt: new Date().toISOString(),
    status,
    score,
    source: input.source,
    summary:
      findings.length === 0
        ? "No contradiction-to-reality finding was detected for this scope."
        : `${findings.length} reality check finding(s): ${status.replace("_", " ")}.`,
    changedFileCount: changedFiles.length,
    findingCount: findings.length,
    findings,
    intentLedger,
    unknownRegistry,
    requiredActions,
    watchItems,
    reasonCodes: uniqueStrings([
      ...reasonCodes,
      ...intentLedger.reasonCodes,
      ...unknownRegistry.reasonCodes,
    ]).slice(0, 30),
    caveats,
  };
}

export function renderProjectRealityCheckMarkdown(result: ProjectRealityCheckResult): string {
  const lines = [
    `- Status: ${result.status}; score ${result.score}/100.`,
    `- Scope: ${result.changedFileCount} changed file(s), ${result.findingCount} finding(s).`,
    `- Summary: ${result.summary}`,
  ];

  lines.push(
    "",
    "Intent Ledger:",
    `- Coverage: ${result.intentLedger.coverage}; ${result.intentLedger.linkedIntentCount}/${result.intentLedger.totalIntentCount} intent(s) linked to this scope.`
  );
  for (const entry of result.intentLedger.entries.slice(0, 5)) {
    lines.push(
      `- ${entry.status.toUpperCase()} ${entry.id}: ${entry.title}`,
      `  Intent: ${entry.intent.goal}`,
      `  Confidence: ${entry.confidence.band} (${Math.round(entry.confidence.score * 100)}%).`
    );
    if (entry.affectedAnchors.length > 0) {
      lines.push(`  Anchors: ${entry.affectedAnchors.slice(0, 5).join(", ")}`);
    }
  }
  if (result.intentLedger.missingAnchors.length > 0) {
    lines.push(
      `- Missing linked intent for: ${result.intentLedger.missingAnchors
        .slice(0, 8)
        .map((file) => `\`${file}\``)
        .join(", ")}`
    );
  }

  lines.push(
    "",
    "Unknown Registry:",
    `- Status: ${result.unknownRegistry.status}; ${result.unknownRegistry.unknownCount} unknown(s), ${result.unknownRegistry.riskCount} risk item(s).`
  );
  for (const unknown of result.unknownRegistry.unknowns.slice(0, 6)) {
    lines.push(
      `- ${unknown.severity.toUpperCase()} ${unknown.category}: ${unknown.title}`,
      `  ${unknown.summary}`
    );
    if (unknown.scope.length > 0) {
      lines.push(
        `  Scope: ${unknown.scope
          .slice(0, 5)
          .map((item) => `\`${item}\``)
          .join(", ")}`
      );
    }
    if (unknown.resolutionActions.length > 0) {
      lines.push(`  Resolve: ${unknown.resolutionActions[0]}`);
    }
  }

  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of result.findings.slice(0, 8)) {
      lines.push(
        `- ${finding.severity.toUpperCase()} ${finding.type}: ${finding.title}`,
        `  ${finding.summary}`
      );
      if (finding.changedFiles.length > 0) {
        lines.push(`  Files: ${finding.changedFiles.map((file) => `\`${file}\``).join(", ")}`);
      }
      if (finding.decisionIds.length > 0) {
        lines.push(`  Decisions: ${finding.decisionIds.join(", ")}`);
      }
      if (finding.recommendedActions.length > 0) {
        lines.push(`  Action: ${finding.recommendedActions[0]}`);
      }
    }
  }

  if (result.requiredActions.length > 0) {
    lines.push("", "Required actions:");
    lines.push(...result.requiredActions.map((action) => `- ${action}`));
  }

  if (result.watchItems.length > 0) {
    lines.push("", "Watch items:");
    lines.push(...result.watchItems.map((item) => `- ${item}`));
  }

  if (result.caveats.length > 0) {
    lines.push("", "Caveats:");
    lines.push(...result.caveats.map((caveat) => `- ${caveat}`));
  }

  return lines.join("\n");
}
