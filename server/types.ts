export type Direction = "TD" | "LR";
export type NodeShape = "action" | "decision" | "terminal" | "store";

export const NODE_SHAPES: readonly NodeShape[] = ["action", "decision", "terminal", "store"];
export const ANNOTATION_KINDS = [
  "question",
  "needs-testing",
  "incorrect",
  "attention",
  "suggestion",
  "uncertain",
  "custom",
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** Proposal status of a node or edge; absent means "existing, unchanged". Serialized as Mermaid classes. */
export const CHANGE_STATUSES = ["new", "changed", "removed"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const LIMITS = {
  labelLength: 300,
  labelLines: 8,
  textLength: 2000,
  nodes: 200,
  edges: 400,
  annotations: 200,
  opsPerPatch: 100,
  mermaidLength: 50_000,
  historyEvents: 200,
} as const;

export interface GraphNode {
  id: string;
  label: string;
  shape: NodeShape;
  status?: ChangeStatus;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  status?: ChangeStatus;
}

export interface Graph {
  direction: Direction;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const DIAGRAM_TYPES = ["flowchart", "sequence"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export interface Annotation {
  /** Session-local, monotonically increasing, never reused. */
  id: number;
  /** Flowchart targets. */
  nodeIds: string[];
  edgeIds: string[];
  /** Sequence-diagram targets: participants, messages, notes, activations, fragments. */
  elementIds?: string[];
  kind?: AnnotationKind;
  text?: string;
  /** True when every target of a previously targeted mark was deleted. */
  orphaned?: boolean;
}

export type ChangeSource = "agent" | "user";

/** Effective semantic operation as recorded in the change log (no geometry, ever). */
export type ChangeOp = { op: string } & Record<string, unknown>;

export interface ChangeEvent {
  revision: number;
  source: ChangeSource;
  /** Agent name (from its MCP connection) for agent changes. */
  actor?: string;
  ops: ChangeOp[];
}

/** Editor placement of a node: position, plus a size when the user resized it. */
export interface XY {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export class CanvasError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}
