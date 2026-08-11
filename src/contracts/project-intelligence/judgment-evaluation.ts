export const JUDGMENT_EVALUATION_DATASET_VERSION =
  "snipara.judgment_evaluation_dataset.v1" as const;
export const JUDGMENT_EVALUATION_REPORT_VERSION = "snipara.judgment_evaluation_report.v1" as const;

export type JudgmentEvaluationGate = "visibility" | "confidence_adjustment" | "advisory_promotion";

export interface JudgmentEvaluationCase {
  id: string;
  observedAt: string;
  judgmentVersion: string;
  predictedProbability: number;
  predictedPositive: boolean;
  actualPositive: boolean;
  abstained: boolean;
  gate: JudgmentEvaluationGate;
  cohort?: {
    surface?: string | null;
    taskType?: string | null;
    riskLevel?: string | null;
    reasonCodes?: string[];
  };
}

export interface JudgmentEvaluationDataset {
  schemaVersion: typeof JUDGMENT_EVALUATION_DATASET_VERSION;
  capturedAt: string;
  cases: JudgmentEvaluationCase[];
}

export interface JudgmentEvaluationMetricThresholds {
  minSamples: number;
  minPrecision: number;
  minRecall: number;
  minF1: number;
  maxFalsePositiveRate: number;
  maxBrierScore: number;
  maxExpectedCalibrationError: number;
}

export interface JudgmentEvaluationGateThresholds {
  visibility: JudgmentEvaluationMetricThresholds;
  confidenceAdjustment: JudgmentEvaluationMetricThresholds;
  advisoryPromotion: JudgmentEvaluationMetricThresholds;
}
