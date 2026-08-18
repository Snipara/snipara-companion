export const TASK_CANVAS_SCHEMA_VERSION = "snipara.task_canvas.v0" as const;

export const TASK_CANVAS_EVENT_TYPES = [
  "session_start",
  "session_end",
  "compact",
  "message_user",
  "message_assistant",
  "tool_call",
  "tool_result",
  "file_changed",
  "error_observed",
] as const;

export const TASK_CANVAS_NODE_KINDS = ["session", "task", "event", "omitted"] as const;
export const TASK_CANVAS_EDGE_KINDS = ["contains", "sequence", "correlates"] as const;
export const TASK_CANVAS_EVIDENCE_KINDS = [
  "execution_trace",
  "session_checkpoint",
  "local_context_pack",
] as const;
export const TASK_CANVAS_PRIVACY_LEVELS = ["standard", "sensitive", "restricted"] as const;
export const TASK_CANVAS_EDGE_CONFIDENCE = ["exact", "heuristic"] as const;

export type TaskCanvasEventType = (typeof TASK_CANVAS_EVENT_TYPES)[number];
export type TaskCanvasNodeKind = (typeof TASK_CANVAS_NODE_KINDS)[number];
export type TaskCanvasEdgeKind = (typeof TASK_CANVAS_EDGE_KINDS)[number];
export type TaskCanvasEvidenceKind = (typeof TASK_CANVAS_EVIDENCE_KINDS)[number];
export type TaskCanvasPrivacyLevel = (typeof TASK_CANVAS_PRIVACY_LEVELS)[number];
export type TaskCanvasEdgeConfidence = (typeof TASK_CANVAS_EDGE_CONFIDENCE)[number];

export interface TaskCanvasBudget {
  maxNodes: number;
  maxEdges: number;
  maxEvidenceRefsPerNode: number;
  maxLabelChars: number;
  maxSummaryChars: number;
  maxArrayItems: number;
}

export const DEFAULT_TASK_CANVAS_BUDGET: TaskCanvasBudget = {
  maxNodes: 80,
  maxEdges: 160,
  maxEvidenceRefsPerNode: 4,
  maxLabelChars: 96,
  maxSummaryChars: 240,
  maxArrayItems: 8,
};

export interface TaskCanvasEvidenceRef {
  kind: TaskCanvasEvidenceKind;
  id: string;
}

export interface TaskCanvasNode {
  id: string;
  kind: TaskCanvasNodeKind;
  eventType: TaskCanvasEventType | null;
  label: string;
  summary: string;
  privacyLevel: TaskCanvasPrivacyLevel;
  sessionId: string | null;
  task: string | null;
  timestamp: string | null;
  tool: string | null;
  files: string[];
  commands: string[];
  redacted: boolean;
  evidenceRefs: TaskCanvasEvidenceRef[];
}

export interface TaskCanvasEdge {
  id: string;
  kind: TaskCanvasEdgeKind;
  from: string;
  to: string;
  confidence: TaskCanvasEdgeConfidence;
  evidenceRefs: TaskCanvasEvidenceRef[];
}

export interface TaskCanvasMetadata {
  source: "execution_trace" | "session_checkpoint_fallback";
  inputEventCount: number;
  includedEventCount: number;
  omittedEventCount: number;
  includedEdgeCount: number;
  omittedEdgeCount: number;
  truncated: boolean;
  warnings: string[];
  caveats: string[];
}

export interface TaskCanvas {
  schemaVersion: typeof TASK_CANVAS_SCHEMA_VERSION;
  generatedAt: string;
  sessionId: string | null;
  budget: TaskCanvasBudget;
  nodes: TaskCanvasNode[];
  edges: TaskCanvasEdge[];
  metadata: TaskCanvasMetadata;
}
