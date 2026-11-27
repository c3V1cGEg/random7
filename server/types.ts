export type Direction = "TD" | "LR";
export type FlowShape = "action" | "decision" | "terminal" | "store";
/**
 * State-diagram shapes: a state, the initial/final pseudo-states ([*]), a choice point, and "any":
 * the one source of transitions that are possible from every state (cancel, delete, …).
 */
export type StateShape = "state" | "initial" | "final" | "choice" | "any";
export type NodeShape = FlowShape | StateShape;

export const FLOW_SHAPES: readonly FlowShape[] = ["action", "decision", "terminal", "store"];
export const STATE_SHAPES: readonly StateShape[] = ["state", "initial", "final", "choice", "any"];
export const NODE_SHAPES: readonly NodeShape[] = [...FLOW_SHAPES, ...STATE_SHAPES];
/** Fixed ids of the state diagram's pseudo-states (Mermaid writes both as [*]). */
export const INITIAL_ID = "initial";
export const FINAL_ID = "final";
/** Fixed id of the "any state" source; Mermaid writes it as an ordinary state named "Any state". */
export const ANY_ID = "any";
/** Shapes with a fixed id and label: there is at most one of each. */
export const FIXED_STATE_IDS: Partial<Record<StateShape, string>> = { initial: INITIAL_ID, final: FINAL_ID, any: ANY_ID };
export const ANNOTATION_KINDS = [
  "question",
  "needs-testing",
  "incorrect",
  "attention",
  "suggestion",
  "decision",
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
  repliesPerMark: 50,
  opsPerPatch: 100,
  mermaidLength: 50_000,
  historyEvents: 200,
  instances: 100,
  instanceFields: 12,
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
  /** Arrowheads at both ends (Mermaid `<-->`), e.g. a two-way sync. Flowcharts only. */
  both?: boolean;
}

export interface Graph {
  direction: Direction;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const DIAGRAM_TYPES = ["flowchart", "sequence", "state"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];
/** Diagram types drawn as nodes and edges (the flowchart model). */
export const isGraphType = (t: DiagramType): boolean => t === "flowchart" || t === "state";

/** A runtime object of a state diagram (e.g. "Order #1042") and the state it is in. Not part of the Mermaid text. */
export interface Instance {
  id: string;
  label: string;
  /** Id of the state node it is in. */
  state: string;
  /** Field values shown on hover, e.g. { total: "€120" }. */
  fields?: Record<string, string>;
  /** True when its state was deleted; it keeps the last state id. */
  orphaned?: boolean;
}

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
  /** Who wrote the mark; marks saved before this field existed are the user's. */
  by?: ChangeSource;
  /** Agent name, for marks the agent wrote. */
  agent?: string;
  /** The conversation about this mark, oldest first. The mark's own text is never rewritten to answer it. */
  replies?: Reply[];
  /** True when every target of a previously targeted mark was deleted. */
  orphaned?: boolean;
}

export interface Reply {
  by: ChangeSource;
  /** Agent name, for agent replies. */
  agent?: string;
  text: string;
  at: string;
}

/** A mark waits for the agent while the user has the last word: their own mark without replies, or a user reply last. */
export function awaitingAgent(a: Annotation): boolean {
  const last = a.replies?.at(-1);
  return last ? last.by === "user" : a.by !== "agent";
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

export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];
/** Where an edge end sits on its node's border: a side, and how far along it (0 = top/left end, 1 = bottom/right end). */
export interface Anchor {
  side: Side;
  t: number;
}
/** Editor-only: the attachment points the user chose for an edge (an end without one is placed automatically). */
export interface EdgeEnds {
  from?: Anchor;
  to?: Anchor;
}
/** An anchor update: null clears that end (back to automatic). */
export type EdgeEndsPatch = { from?: Anchor | null; to?: Anchor | null };

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
