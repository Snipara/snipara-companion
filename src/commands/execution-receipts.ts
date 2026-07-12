import {
  type ProjectIntelligenceEngineeringLeadProofVerification,
  type ProjectIntelligenceEngineeringLeadProofVerificationStatus,
} from "../contracts/project-intelligence";

export const ENGINEERING_LEAD_PROOF_VERIFICATION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface EngineeringLeadProofAuthenticityInput {
  verification: ProjectIntelligenceEngineeringLeadProofVerification;
  proofEvidenceProvided: boolean;
  selfAttestedProof?: boolean;
  now?: Date;
  maxAgeMs?: number;
}

export interface EngineeringLeadProofAuthenticity {
  effectiveStatus: ProjectIntelligenceEngineeringLeadProofVerificationStatus;
  sourceBacked: boolean;
  stale: boolean;
  reasonCodes: string[];
}

export function proofVerificationHasSourceEvidence(
  verification: ProjectIntelligenceEngineeringLeadProofVerification
): boolean {
  return (
    verification.source !== "unknown" &&
    Boolean(verification.sourceRef || verification.evidenceHash || verification.verifiedBy)
  );
}

export function evaluateProofVerificationAuthenticity(
  input: EngineeringLeadProofAuthenticityInput
): EngineeringLeadProofAuthenticity {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? ENGINEERING_LEAD_PROOF_VERIFICATION_MAX_AGE_MS;
  const verifiedAt = parseVerifiedAt(input.verification.verifiedAt);
  const hasTrustedSource = input.verification.source !== "unknown";
  const hasSourceEvidence = proofVerificationHasSourceEvidence(input.verification);
  const missingVerifiedAt =
    input.verification.status === "verified" && !input.verification.verifiedAt;
  const invalidVerifiedAt =
    input.verification.status === "verified" &&
    Boolean(input.verification.verifiedAt) &&
    !verifiedAt;
  const ageMs = verifiedAt ? now.getTime() - verifiedAt.getTime() : 0;
  const future = input.verification.status === "verified" && verifiedAt ? ageMs < 0 : false;
  const stale = input.verification.status === "verified" && verifiedAt ? ageMs > maxAgeMs : false;
  const sourceBacked =
    input.verification.status === "verified" &&
    hasTrustedSource &&
    hasSourceEvidence &&
    Boolean(verifiedAt) &&
    !future &&
    !stale;
  const reasonCodes = new Set<string>();

  if (input.selfAttestedProof) {
    reasonCodes.add("proof_verification_self_attested_proof_not_source_backed");
  }
  if (sourceBacked) {
    reasonCodes.add("proof_verification_source_backed");
  }
  if (input.verification.status === "verified" && !sourceBacked) {
    reasonCodes.add("proof_verification_verified_not_source_backed");
    reasonCodes.add("proof_verification_downgraded_verified");
    if (!hasTrustedSource) reasonCodes.add("proof_verification_missing_trusted_source");
    if (!hasSourceEvidence) reasonCodes.add("proof_verification_missing_source_evidence");
    if (missingVerifiedAt) reasonCodes.add("proof_verification_missing_verified_at");
    if (invalidVerifiedAt) reasonCodes.add("proof_verification_invalid_verified_at");
    if (future) reasonCodes.add("proof_verification_future_verified_at");
    if (stale) reasonCodes.add("proof_verification_stale");
  }

  return {
    effectiveStatus: sourceBacked
      ? "verified"
      : input.verification.status === "rejected"
        ? "rejected"
        : input.proofEvidenceProvided
          ? "provided"
          : input.verification.status === "unknown"
            ? "unknown"
            : "declared",
    sourceBacked,
    stale,
    reasonCodes: Array.from(reasonCodes),
  };
}

function parseVerifiedAt(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
