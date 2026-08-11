import contract from "./why-capture-confidence-v1.json";

export const WHY_CAPTURE_CONFIDENCE_VERSION = contract.version;

export type WhyCaptureExecutionOutcome = "completed" | "partial" | "blocked" | "abandoned";

export interface WhyCaptureConfidenceInput {
  candidateType: "DECISION" | "CONTEXT";
  decision?: string | null;
  rationale?: string | null;
  sourceKind: string;
  executionOutcome?: WhyCaptureExecutionOutcome;
}

export function calculateWhyCaptureConfidence(input: WhyCaptureConfidenceInput): number {
  const executionOutcome = input.executionOutcome ?? "completed";
  let confidence = contract.base;
  if (
    input.candidateType === "DECISION" &&
    Boolean(input.decision?.trim()) &&
    Boolean(input.rationale?.trim()) &&
    contract.validatedExecutionOutcomes.includes(executionOutcome)
  ) {
    confidence += contract.decisionRationaleBonus;
  }
  if (input.sourceKind !== "manual") {
    confidence += contract.nonManualSourceBonus;
  }

  const scale = 10 ** contract.decimalPlaces;
  return Math.min(contract.maximum, Math.round(confidence * scale) / scale);
}

export const WHY_CAPTURE_CONFIDENCE_TEST_VECTORS = contract.vectors;
