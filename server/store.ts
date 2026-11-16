// Authoritative state of one named canvas session: the semantic model (layers A + B of
// the spec) plus the editor's shared layout, which is stored here for persistence and for
// sharing between browsers but never exposed to agents.

import { randomUUID } from "node:crypto";
import { parseMermaid, toMermaid, validateId, normalizeLabel, normalizeNodeLabel } from "./mermaid.ts";
import type { Operation } from "./ops.ts";
import { allIds, countItems, emptySequence, findItem, itemParticipants, parseSequence, sequenceToMermaid, walkItems, type Sequence } from "./sequence.ts";
import { SEQUENCE_OPS, acceptSequenceChanges, allocSeqId, applySequenceOp } from "./sequenceOps.ts";
import {
  CanvasError,
  LIMITS,
  awaitingAgent,
  type Annotation,
  type ChangeEvent,
  type ChangeOp,
  type ChangeSource,
  type ChangeStatus,
  type DiagramType,
  type Direction,
  type GraphEdge,
  type GraphNode,
  type Reply,
  type XY,
  SIDES,
  type EdgeEnds,
  type EdgeEndsPatch,
} from "./types.ts";

interface Model {
  type: DiagramType;
  /** Sequence diagrams (type "sequence"); empty for flowcharts. */
  sequence: Sequence;
  seqCounters: Record<string, number>;
  direction: Direction;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  annotations: Map<number, Annotation>;
  nextAnnotationId: number;
  nodeCounter: number;
  edgeCounter: number;
  /** Every node/edge id used in this session; generated ids never reuse them. */
  usedIds: Set<string>;
}

export interface AgentSnapshot {
  session: string;
  sessionId: string;
  revision: number;
  type: DiagramType;
  diagram: string;
  /** awaitingReply: the user has the last word on this mark and expects an answer in its thread. */
  annotations: Array<Annotation & { awaitingReply?: true }>;
}

export interface BrowserState {
  session: string;
  title?: string;
  sessionId: string;
  revision: number;
  type: DiagramType;
  sequence: Sequence;
  direction: Direction;
  nodes: GraphNode[];
  edges: GraphEdge[];
  annotations: Annotation[];
  diagram: string;
  /** Sizes of the user's undo/redo stacks. */
  history: { undo: number; redo: number };
  /** Editor-only node positions (also kept for deleted nodes, so undo restores them in place). */
  layout: Record<string, XY>;
  anchors: Record<string, EdgeEnds>;
}

/** On-disk form of a session. Undo history and the change log are intentionally not persisted. */
export interface StoredSession {
  version: 1;
  name: string;
  title?: string;
  sessionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  model: {
    type?: DiagramType;
    sequence?: Sequence;
    seqCounters?: Record<string, number>;
    direction: Direction;
    nodes: GraphNode[];
    edges: GraphEdge[];
    annotations: Annotation[];
    nextAnnotationId: number;
    nodeCounter: number;
    edgeCounter: number;
    usedIds: string[];
  };
  layout: Record<string, XY>;
  anchors?: Record<string, EdgeEnds>;
}

export interface SessionSummary {
  name: string;
  title?: string;
  type: DiagramType;
  revision: number;
  /** Flowchart nodes, or sequence participants + items. */
  nodes: number;
  marks: number;
  updatedAt: string;
}

export interface UndoResult {
  revision: number;
  ops: ChangeOp[];
}

/** Before/after values of every element one user action touched (undefined = absent). */
interface Delta {
  /** Sequences are restored as a whole (their order and nesting make per-element deltas fragile). */
  sequence?: [Sequence, Sequence];
  type?: [DiagramType, DiagramType];
  nodes: Map<string, [GraphNode | undefined, GraphNode | undefined]>;
  edges: Map<string, [GraphEdge | undefined, GraphEdge | undefined]>;
  annotations: Map<number, [Annotation | undefined, Annotation | undefined]>;
  direction?: [Direction, Direction];
}

interface HistoryEntry {
  /** Consecutive patches with the same group undo as one step (e.g. create node + connect + name it). */
  group?: string;
  delta: Delta;
}

const HISTORY_LIMIT = 100;

export interface PatchResult {
  revision: number;
  applied: number;
  createdNodeIds?: string[];
  createdEdgeIds?: string[];
  createdAnnotationIds?: number[];
  /** Sequence participants/items created by the patch. */
  createdElementIds?: string[];
  sideEffects?: ChangeOp[];
  /** For user patches: whether this created/extended an undo step (false for no-op edits). */
  undoable?: boolean;
}

export type StoreListener = (event: ChangeEvent) => void;
/** `origin` identifies the browser that sent the layout change, so it is not echoed back. */
export type LayoutListener = (positions: Record<string, XY>, origin?: string, anchors?: Record<string, EdgeEnds>) => void;

function emptyModel(type: DiagramType = "flowchart"): Model {
  return {
    type,
    sequence: emptySequence(),
    seqCounters: {},
    direction: "TD",
    nodes: new Map(),
    edges: new Map(),
    annotations: new Map(),
    nextAnnotationId: 1,
    nodeCounter: 0,
    edgeCounter: 0,
    usedIds: new Set(),
  };
}

function cloneModel(m: Model): Model {
  return {
    ...m,
    sequence: structuredClone(m.sequence),
    seqCounters: { ...m.seqCounters },
    nodes: new Map(m.nodes),
    edges: new Map(m.edges),
    annotations: new Map(m.annotations),
    usedIds: new Set(m.usedIds),
  };
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export class CanvasStore {
  readonly name: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  private model: Model = emptyModel();
  private layoutMap = new Map<string, XY>();
  /** Edge attachment points (editor-only, like positions; kept for deleted edges so undo restores them). */
  private anchorMap = new Map<string, EdgeEnds>();
  private layoutListeners = new Set<LayoutListener>();
  private _sessionId: string = randomUUID();
  private _revision = 0;
  /** Revision at which the current session started; history before it is meaningless. */
  private sessionStartRevision = 0;
  private events: ChangeEvent[] = [];
  private listeners = new Set<StoreListener>();
  /** Undo/redo covers the user's own edits only; agent edits are never undone by Ctrl+Z. */
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(name = "default", title?: string, type: DiagramType = "flowchart") {
    this.name = name;
    this.title = title;
    this.model.type = type;
    this.createdAt = this.updatedAt = new Date().toISOString();
  }

  get revision(): number {
    return this._revision;
  }
  get sessionId(): string {
    return this._sessionId;
  }
  get type(): DiagramType {
    return this.model.type;
  }

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLayout(fn: LayoutListener): () => void {
    this.layoutListeners.add(fn);
    return () => this.layoutListeners.delete(fn);
  }

  // --- layout (editor-only; no revision, never sent to agents) ---------------

  layout(): Record<string, XY> {
    return Object.fromEntries(this.layoutMap);
  }

  anchors(): Record<string, EdgeEnds> {
    return Object.fromEntries(this.anchorMap);
  }

  setLayout(positions: Record<string, XY>, origin?: string, anchors: Record<string, EdgeEndsPatch> = {}): void {
    const accepted: Record<string, XY> = {};
    for (const [id, p] of Object.entries(positions)) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      if (this.model.type !== "flowchart" || (!this.model.nodes.has(id) && !this.layoutMap.has(id))) continue;
      accepted[id] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
      const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1200, Math.max(40, Math.round(v))) : undefined);
      const w = size(p.w);
      const h = size(p.h);
      if (w && h) Object.assign(accepted[id], { w, h });
      this.layoutMap.set(id, accepted[id]);
    }
    const ends: Record<string, EdgeEnds> = {};
    for (const [id, patch] of Object.entries(anchors)) {
      if (this.model.type !== "flowchart" || (!this.model.edges.has(id) && !this.anchorMap.has(id))) continue;
      const next: EdgeEnds = { ...this.anchorMap.get(id) };
      for (const end of ["from", "to"] as const) {
        const a = patch?.[end];
        if (a === null) delete next[end];
        else if (a && SIDES.includes(a.side) && Number.isFinite(a.t)) next[end] = { side: a.side, t: Math.round(Math.min(1, Math.max(0, a.t)) * 1000) / 1000 };
      }
      if (next.from || next.to) this.anchorMap.set(id, next);
      else this.anchorMap.delete(id);
      ends[id] = next;
    }
    if (!Object.keys(accepted).length && !Object.keys(ends).length) return;
    this.touch();
    for (const fn of this.layoutListeners) fn(accepted, origin, ends);
  }

  // --- reads -----------------------------------------------------------------

  snapshot(): AgentSnapshot {
    return {
      session: this.name,
      sessionId: this._sessionId,
      revision: this._revision,
      type: this.model.type,
      diagram: this.mermaid(),
      annotations: this.annotationList().map((a) => (awaitingAgent(a) ? { ...a, awaitingReply: true as const } : a)),
    };
  }

  browserState(): BrowserState {
    return {
      session: this.name,
      ...(this.title ? { title: this.title } : {}),
      sessionId: this._sessionId,
      revision: this._revision,
      type: this.model.type,
      sequence: this.model.sequence,
      direction: this.model.direction,
      nodes: [...this.model.nodes.values()],
      edges: [...this.model.edges.values()],
      annotations: this.annotationList(),
      diagram: this.mermaid(),
      history: { undo: this.undoStack.length, redo: this.redoStack.length },
      layout: this.layout(),
      anchors: this.anchors(),
    };
  }

  summary(): SessionSummary {
    return {
      name: this.name,
      ...(this.title ? { title: this.title } : {}),
      type: this.model.type,
      revision: this._revision,
      nodes: this.model.type === "sequence" ? this.model.sequence.participants.length + countItems(this.model.sequence) : this.model.nodes.size,
      marks: this.model.annotations.size,
      updatedAt: this.updatedAt,
    };
  }

  toStored(): StoredSession {
    const m = this.model;
    return {
      version: 1,
      name: this.name,
      ...(this.title ? { title: this.title } : {}),
      sessionId: this._sessionId,
      revision: this._revision,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      model: {
        type: m.type,
        ...(m.type === "sequence" ? { sequence: m.sequence, seqCounters: m.seqCounters } : {}),
        direction: m.direction,
        nodes: [...m.nodes.values()],
        edges: [...m.edges.values()],
        annotations: [...m.annotations.values()],
        nextAnnotationId: m.nextAnnotationId,
        nodeCounter: m.nodeCounter,
        edgeCounter: m.edgeCounter,
        usedIds: [...m.usedIds],
      },
      layout: this.layout(),
      anchors: this.anchors(),
    };
  }

  /** Restores a saved session. The change log starts empty, so agents are told to re-read the snapshot. */
  static fromStored(data: StoredSession): CanvasStore {
    if (data?.version !== 1 || typeof data.name !== "string") throw new Error("unsupported session file");
    const store = new CanvasStore(data.name, data.title);
    store.createdAt = data.createdAt;
    store.updatedAt = data.updatedAt;
    store._sessionId = data.sessionId;
    store._revision = store.sessionStartRevision = data.revision;
    const m = data.model;
    store.model = {
      type: m.type === "sequence" ? "sequence" : "flowchart",
      sequence: m.sequence ?? emptySequence(),
      seqCounters: m.seqCounters ?? {},
      direction: m.direction === "LR" ? "LR" : "TD",
      nodes: new Map(m.nodes.map((n) => [n.id, n])),
      edges: new Map(m.edges.map((e) => [e.id, e])),
      annotations: new Map(m.annotations.map((a) => [a.id, a])),
      nextAnnotationId: m.nextAnnotationId,
      nodeCounter: m.nodeCounter,
      edgeCounter: m.edgeCounter,
      usedIds: new Set(m.usedIds),
    };
    const broken = integrityProblems(store.model);
    if (broken.length) throw new Error(broken[0]);
    store.layoutMap = new Map(Object.entries(data.layout ?? {}));
    store.anchorMap = new Map(Object.entries(data.anchors ?? {}));
    return store;
  }

  mermaid(): string {
    const m = this.model;
    if (m.type === "sequence") return sequenceToMermaid(m.sequence);
    return toMermaid({ direction: m.direction, nodes: [...m.nodes.values()], edges: [...m.edges.values()] });
  }

  private annotationList(): Annotation[] {
    return [...this.model.annotations.values()].sort((a, b) => a.id - b.id);
  }

  changesSince(sinceRevision: number):
    | { sessionId: string; revision: number; changes: ChangeEvent[] }
    | { sessionId: string; revision: number; snapshotRequired: true; reason: string } {
    const base = { sessionId: this._sessionId, revision: this._revision };
    if (sinceRevision > this._revision) {
      return { ...base, snapshotRequired: true, reason: "sinceRevision is ahead of the server; call canvas_get_snapshot" };
    }
    if (sinceRevision < this.sessionStartRevision) {
      return { ...base, snapshotRequired: true, reason: "the canvas session was reset after that revision; call canvas_get_snapshot" };
    }
    const oldest = this.events[0]?.revision ?? this._revision + 1;
    if (sinceRevision < this._revision && sinceRevision + 1 < oldest) {
      return { ...base, snapshotRequired: true, reason: "change history for that revision has expired; call canvas_get_snapshot" };
    }
    return { ...base, changes: this.events.filter((e) => e.revision > sinceRevision) };
  }

  // --- writes ----------------------------------------------------------------

  applyPatch(expectedRevision: number, ops: Operation[], source: ChangeSource, undoGroup?: string, actor?: string): PatchResult {
    this.checkRevision(expectedRevision);
    if (ops.length === 0) throw new CanvasError("invalid_patch", "operations must not be empty");
    if (ops.length > LIMITS.opsPerPatch) throw new CanvasError("invalid_patch", `at most ${LIMITS.opsPerPatch} operations per patch`);

    // Apply against a draft; commit only if every operation succeeds (atomic patch).
    const draft = cloneModel(this.model);
    const log: ChangeOp[] = [];
    const sideEffects: ChangeOp[] = [];
    const created = { nodes: [] as string[], edges: [] as string[], annotations: [] as number[], elements: [] as string[] };

    ops.forEach((op, index) => {
      try {
        applyOp(draft, op, log, sideEffects, created, { source, actor });
      } catch (err) {
        if (err instanceof CanvasError) {
          throw new CanvasError(err.code, `operation ${index} (${op.op}): ${err.message}`, {
            ...err.details,
            operationIndex: index,
            currentRevision: this._revision,
          });
        }
        throw err;
      }
    });
    enforceLimits(draft);

    const undoable = source === "user" ? this.recordHistory(diffModels(this.model, draft), undoGroup) : undefined;
    this.model = draft;
    this.commit(source, log, actor);
    return {
      revision: this._revision,
      applied: ops.length,
      ...(created.nodes.length ? { createdNodeIds: created.nodes } : {}),
      ...(created.edges.length ? { createdEdgeIds: created.edges } : {}),
      ...(created.annotations.length ? { createdAnnotationIds: created.annotations } : {}),
      ...(created.elements.length ? { createdElementIds: created.elements } : {}),
      ...(sideEffects.length ? { sideEffects } : {}),
      ...(undoable !== undefined ? { undoable } : {}),
    };
  }

  replaceDiagram(
    expectedRevision: number,
    mermaidSource: string,
    annotations: "keep" | "clear",
    source: ChangeSource,
    actor?: string,
  ): PatchResult & { generatedEdgeIds?: string[]; generatedIds?: string[]; type?: DiagramType } {
    this.checkRevision(expectedRevision);
    if (mermaidSource.length > LIMITS.mermaidLength) {
      throw new CanvasError("too_large", `diagram exceeds ${LIMITS.mermaidLength} characters`);
    }
    const header = mermaidSource.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("%%"));
    if (header?.replace(/;$/, "") === "sequenceDiagram") return this.replaceSequence(mermaidSource, annotations, source, actor);
    const { graph, generatedEdgeIds } = parseMermaid(mermaidSource);
    const draft = cloneModel(this.model);
    draft.type = "flowchart";
    draft.sequence = emptySequence();
    draft.direction = graph.direction;
    draft.nodes = new Map();
    draft.edges = new Map();
    for (const n of graph.nodes) {
      checkLabel(n.label);
      draft.nodes.set(n.id, n);
      draft.usedIds.add(n.id);
    }
    // Edge ids the parser generated could clash with ids deleted earlier in the session; re-allocate.
    const renamed = new Map<string, string>();
    for (const e of graph.edges) {
      let edge = e;
      if (generatedEdgeIds.includes(e.id)) {
        const fresh = allocId(draft, "e", (m) => graph.nodes.some((n) => n.id === m) || graph.edges.some((x) => x.id === m && x !== e) || renamed.has(m));
        renamed.set(fresh, e.id);
        edge = { ...e, id: fresh };
      }
      if (edge.label) checkLabel(edge.label);
      draft.edges.set(edge.id, edge);
      draft.usedIds.add(edge.id);
    }

    const sideEffects: ChangeOp[] = [];
    if (annotations === "clear") {
      for (const a of draft.annotations.values()) sideEffects.push({ op: "remove_annotation", id: a.id });
      draft.annotations = new Map();
    } else {
      pruneAnnotationTargets(draft, sideEffects);
    }
    enforceLimits(draft);

    this.model = draft;
    this.commit(
      source,
      [{ op: "replace_diagram", nodes: draft.nodes.size, edges: draft.edges.size, annotations }, ...sideEffects],
      actor,
    );
    const finalGenerated = [...draft.edges.keys()].filter((k) => renamed.has(k));
    return {
      revision: this._revision,
      applied: 1,
      ...(finalGenerated.length ? { generatedEdgeIds: finalGenerated } : {}),
      ...(sideEffects.length ? { sideEffects } : {}),
    };
  }

  private replaceSequence(mermaidSource: string, annotations: "keep" | "clear", source: ChangeSource, actor?: string) {
    const draft = cloneModel(this.model);
    const ctx = { sequence: draft.sequence, usedIds: draft.usedIds, seqCounters: draft.seqCounters };
    const { sequence, generatedIds } = parseSequence(mermaidSource, (prefix, taken) => allocSeqId({ ...ctx, sequence: emptySequence() }, prefix, taken));
    if (sequence.participants.length > LIMITS.nodes || countItems(sequence) > LIMITS.edges) {
      throw new CanvasError("too_large", `at most ${LIMITS.nodes} participants and ${LIMITS.edges} items; keep the diagram focused`);
    }
    draft.type = "sequence";
    draft.sequence = sequence;
    draft.nodes = new Map();
    draft.edges = new Map();
    for (const id of allIds(sequence)) draft.usedIds.add(id);
    const sideEffects: ChangeOp[] = [];
    if (annotations === "clear") {
      for (const a of draft.annotations.values()) sideEffects.push({ op: "remove_annotation", id: a.id });
      draft.annotations = new Map();
    } else {
      pruneAnnotationTargets(draft, sideEffects);
    }
    this.model = draft;
    this.commit(
      source,
      [{ op: "replace_diagram", type: "sequence", participants: sequence.participants.length, items: countItems(sequence), annotations }, ...sideEffects],
      actor,
    );
    return {
      revision: this._revision,
      applied: 1,
      type: "sequence" as const,
      ...(generatedIds.length ? { generatedIds } : {}),
      ...(sideEffects.length ? { sideEffects } : {}),
    };
  }

  /** Starts a fresh, empty session of the same diagram type. Annotation numbering restarts at #1. */
  reset(source: ChangeSource): { sessionId: string; revision: number } {
    this.model = emptyModel(this.model.type);
    this.layoutMap = new Map();
    this.anchorMap = new Map();
    this.touch();
    this.undoStack = [];
    this.redoStack = [];
    this._sessionId = randomUUID();
    this.events = [];
    this._revision++;
    this.sessionStartRevision = this._revision;
    const event: ChangeEvent = { revision: this._revision, source, ops: [{ op: "reset_session" }] };
    this.events.push(event);
    this.emit(event);
    return { sessionId: this._sessionId, revision: this._revision };
  }

  // --- undo / redo -----------------------------------------------------------

  undo(): UndoResult {
    return this.travel(this.undoStack, this.redoStack, "undo");
  }

  redo(): UndoResult {
    return this.travel(this.redoStack, this.undoStack, "redo");
  }

  /**
   * Restores one history step, but only if every element it touched is still exactly as that
   * step left it. If the agent changed any of them since, the step is dropped and a conflict
   * is reported instead of silently overwriting the agent's work.
   */
  private travel(from: HistoryEntry[], to: HistoryEntry[], direction: "undo" | "redo"): UndoResult {
    const entry = from.pop();
    if (!entry) throw new CanvasError("nothing_to_" + direction, `nothing to ${direction}`);
    const draft = cloneModel(this.model);
    const changed = applyDelta(draft, entry.delta, direction === "undo");
    if (changed.conflicts.length) {
      throw new CanvasError(
        `${direction}_conflict`,
        `can't ${direction}: ${changed.conflicts.slice(0, 3).join(", ")} changed since (probably by the agent)`,
        { ids: changed.conflicts },
      );
    }
    const broken = integrityProblems(draft);
    if (broken.length) {
      throw new CanvasError(`${direction}_conflict`, `can't ${direction}: ${broken[0]}`, { ids: broken });
    }
    to.push(entry);
    this.model = draft;
    this.commit("user", [{ op: direction }, ...changed.ops]);
    return { revision: this._revision, ops: changed.ops };
  }

  private recordHistory(delta: Delta, group?: string): boolean {
    if (isEmptyDelta(delta)) return false;
    this.redoStack = [];
    const top = this.undoStack.at(-1);
    if (group && top?.group === group) {
      top.delta = mergeDeltas(top.delta, delta);
      return true;
    }
    this.undoStack.push({ group, delta });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    return true;
  }

  private checkRevision(expected: number) {
    if (expected !== this._revision) {
      throw new CanvasError(
        "revision_conflict",
        `expectedRevision ${expected} is stale; current revision is ${this._revision}. Fetch changes or a snapshot and retry.`,
        { currentRevision: this._revision },
      );
    }
  }

  private touch() {
    this.updatedAt = new Date().toISOString();
  }

  private commit(source: ChangeSource, ops: ChangeOp[], actor?: string) {
    this._revision++;
    this.touch();
    const event: ChangeEvent = { revision: this._revision, source, ...(actor ? { actor } : {}), ops };
    this.events.push(event);
    if (this.events.length > LIMITS.historyEvents) this.events.splice(0, this.events.length - LIMITS.historyEvents);
    this.emit(event);
  }

  private emit(event: ChangeEvent) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("listener failed", err);
      }
    }
  }
}

// --- history helpers -------------------------------------------------------------

/** Structural equality that ignores key order (objects here are flat apart from id arrays). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return false;
  return ka.every((k) => JSON.stringify((a as Record<string, unknown>)[k]) === JSON.stringify((b as Record<string, unknown>)[k]));
}

function diffMap<K, V>(before: Map<K, V>, after: Map<K, V>): Map<K, [V | undefined, V | undefined]> {
  const out = new Map<K, [V | undefined, V | undefined]>();
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(k);
    const a = after.get(k);
    if (!same(b, a)) out.set(k, [b, a]);
  }
  return out;
}

function diffModels(before: Model, after: Model): Delta {
  return {
    ...(!same(before.sequence, after.sequence) ? { sequence: [before.sequence, after.sequence] as [Sequence, Sequence] } : {}),
    ...(before.type !== after.type ? { type: [before.type, after.type] as [DiagramType, DiagramType] } : {}),
    nodes: diffMap(before.nodes, after.nodes),
    edges: diffMap(before.edges, after.edges),
    annotations: diffMap(before.annotations, after.annotations),
    ...(before.direction !== after.direction ? { direction: [before.direction, after.direction] as [Direction, Direction] } : {}),
  };
}

function isEmptyDelta(d: Delta): boolean {
  return !d.nodes.size && !d.edges.size && !d.annotations.size && !d.direction && !d.sequence && !d.type;
}

function mergeMap<K, V>(older: Map<K, [V | undefined, V | undefined]>, newer: Map<K, [V | undefined, V | undefined]>) {
  const out = new Map(older);
  for (const [k, [b, a]] of newer) {
    const prev = out.get(k);
    const before = prev ? prev[0] : b;
    if (same(before, a)) out.delete(k);
    else out.set(k, [before, a]);
  }
  return out;
}

function mergeDeltas(older: Delta, newer: Delta): Delta {
  const direction: [Direction, Direction] | undefined =
    older.direction || newer.direction
      ? [older.direction?.[0] ?? newer.direction![0], newer.direction?.[1] ?? older.direction![1]]
      : undefined;
  const sequence: [Sequence, Sequence] | undefined =
    older.sequence || newer.sequence ? [older.sequence?.[0] ?? newer.sequence![0], newer.sequence?.[1] ?? older.sequence![1]] : undefined;
  const type: [DiagramType, DiagramType] | undefined =
    older.type || newer.type ? [older.type?.[0] ?? newer.type![0], newer.type?.[1] ?? older.type![1]] : undefined;
  return {
    ...(sequence && !same(sequence[0], sequence[1]) ? { sequence } : {}),
    ...(type && type[0] !== type[1] ? { type } : {}),
    nodes: mergeMap(older.nodes, newer.nodes),
    edges: mergeMap(older.edges, newer.edges),
    annotations: mergeMap(older.annotations, newer.annotations),
    ...(direction && direction[0] !== direction[1] ? { direction } : {}),
  };
}

/** Moves the touched elements from one side of the delta to the other; reports elements that drifted. */
function applyDelta(m: Model, d: Delta, undo: boolean): { ops: ChangeOp[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const removes: ChangeOp[] = [];
  const upserts: ChangeOp[] = [];
  const step = <K, V extends object>(map: Map<K, V>, entries: Map<K, [V | undefined, V | undefined]>, kind: string, label: (k: K) => string) => {
    for (const [k, [before, after]] of entries) {
      const [expected, target] = undo ? [after, before] : [before, after];
      const current = map.get(k);
      if (!same(current, expected)) {
        conflicts.push(label(k));
        continue;
      }
      if (target === undefined) {
        map.delete(k);
        removes.push({ op: `remove_${kind}`, id: k });
      } else {
        map.set(k, target);
        upserts.push({ op: current === undefined ? `add_${kind}` : `update_${kind}`, ...target });
      }
    }
  };
  step(m.edges, d.edges, "edge", (k) => k);
  step(m.nodes, d.nodes, "node", (k) => k);
  step(m.annotations, d.annotations, "annotation", (k) => `mark #${k}`);
  if (d.type) {
    const [expected, target] = undo ? [d.type[1], d.type[0]] : d.type;
    if (m.type !== expected) conflicts.push("diagram type");
    else {
      m.type = target;
      upserts.push({ op: "set_diagram_type", type: target });
    }
  }
  if (d.sequence) {
    const [expected, target] = undo ? [d.sequence[1], d.sequence[0]] : d.sequence;
    if (!same(m.sequence, expected)) conflicts.push("the sequence diagram");
    else {
      m.sequence = structuredClone(target);
      upserts.push({ op: "restore_sequence", note: "the sequence diagram was restored to an earlier state; re-read the snapshot" });
    }
  }
  if (d.direction) {
    const [expected, target] = undo ? [d.direction[1], d.direction[0]] : d.direction;
    if (m.direction !== expected) conflicts.push("direction");
    else {
      m.direction = target;
      upserts.push({ op: "set_direction", direction: target });
    }
  }
  // Removes first (edges before nodes), then additions/updates (nodes before edges).
  const order = (op: ChangeOp) => ["remove_annotation", "remove_edge", "remove_node", "set_diagram_type", "restore_sequence", "set_direction", "add_node", "update_node", "add_edge", "update_edge", "add_annotation", "update_annotation"].indexOf(op.op);
  return { ops: [...removes, ...upserts].sort((a, b) => order(a) - order(b)), conflicts };
}

function integrityProblems(m: Model): string[] {
  const problems: string[] = [];
  for (const e of m.edges.values()) {
    if (!m.nodes.has(e.from) || !m.nodes.has(e.to)) problems.push(`edge ${e.id} would point at a node that no longer exists`);
  }
  const participants = new Set(m.sequence.participants.map((p) => p.id));
  for (const { item } of walkItems(m.sequence.items)) {
    if (itemParticipants(item).some((p) => !participants.has(p))) problems.push(`${item.id} would refer to a participant that no longer exists`);
  }
  const elements = new Set(allIds(m.sequence));
  for (const a of m.annotations.values()) {
    if (a.nodeIds.some((id) => !m.nodes.has(id)) || a.edgeIds.some((id) => !m.edges.has(id)) || a.elementIds?.some((id) => !elements.has(id))) {
      problems.push(`mark #${a.id} would point at something that no longer exists`);
    }
  }
  return problems;
}

// --- operation semantics -------------------------------------------------------

/** Who applies a patch: marks and replies record their author, and agents may not rewrite the user's marks. */
interface Author {
  source: ChangeSource;
  actor?: string;
}

function applyOp(
  m: Model,
  op: Operation,
  log: ChangeOp[],
  sideEffects: ChangeOp[],
  created: { nodes: string[]; edges: string[]; annotations: number[]; elements: string[] },
  who: Author,
): void {
  if (SEQUENCE_OPS.has(op.op)) {
    requireType(m, "sequence", op.op);
    applySequenceOp({ sequence: m.sequence, usedIds: m.usedIds, seqCounters: m.seqCounters }, op as Parameters<typeof applySequenceOp>[1], log, sideEffects, created);
    pruneAnnotationTargets(m, sideEffects, log);
    return;
  }
  if (["add_node", "update_node", "remove_node", "add_edge", "update_edge", "remove_edge", "set_direction"].includes(op.op)) {
    requireType(m, "flowchart", op.op);
  }
  switch (op.op) {
    case "set_diagram_type": {
      if (op.type === m.type) return;
      if (m.nodes.size || m.sequence.participants.length || m.sequence.items.length) {
        throw new CanvasError("not_empty", `the canvas already holds a ${m.type}; switch types on an empty canvas, or redraw with canvas_replace_diagram`);
      }
      m.type = op.type;
      log.push({ op: "set_diagram_type", type: op.type });
      return;
    }
    case "add_node": {
      const id = op.id ?? allocId(m, "n");
      claimId(m, id, "node");
      const node: GraphNode = { id, label: checkNodeLabel(op.label), shape: (op.shape as GraphNode["shape"]) ?? "action" };
      if (op.status) node.status = op.status;
      m.nodes.set(id, node);
      created.nodes.push(id);
      log.push({ op: "add_node", ...node });
      return;
    }
    case "update_node": {
      const node = requireNode(m, op.id);
      const next = { ...node };
      const entry: ChangeOp = { op: "update_node", id: op.id };
      if (op.label !== undefined) next.label = entry.label = checkNodeLabel(op.label);
      if (op.shape !== undefined) next.shape = entry.shape = op.shape as GraphNode["shape"];
      if (op.status !== undefined) setStatus(next, entry, op.status);
      m.nodes.set(op.id, next);
      log.push(entry);
      return;
    }
    case "remove_node": {
      requireNode(m, op.id);
      // Deterministic policy: incident edges are removed with the node.
      for (const e of [...m.edges.values()]) {
        if (e.from === op.id || e.to === op.id) {
          m.edges.delete(e.id);
          const fx = { op: "remove_edge", id: e.id, reason: `incident to removed node ${op.id}` };
          log.push(fx);
          sideEffects.push(fx);
        }
      }
      m.nodes.delete(op.id);
      log.push({ op: "remove_node", id: op.id });
      pruneAnnotationTargets(m, sideEffects, log);
      return;
    }
    case "add_edge": {
      requireNode(m, op.from);
      requireNode(m, op.to);
      const id = op.id ?? allocId(m, "e");
      claimId(m, id, "edge");
      const edge: GraphEdge = { id, from: op.from, to: op.to };
      const label = op.label !== undefined ? checkLabel(op.label) : "";
      if (label) edge.label = label;
      if (op.status) edge.status = op.status;
      m.edges.set(id, edge);
      created.edges.push(id);
      log.push({ op: "add_edge", ...edge });
      return;
    }
    case "update_edge": {
      const edge = requireEdge(m, op.id);
      const next: GraphEdge = { ...edge };
      const entry: ChangeOp = { op: "update_edge", id: op.id };
      if (op.from !== undefined) next.from = entry.from = requireNode(m, op.from).id;
      if (op.to !== undefined) next.to = entry.to = requireNode(m, op.to).id;
      if (op.label !== undefined) {
        const label = op.label === null ? "" : checkLabel(op.label);
        if (label) next.label = label;
        else delete next.label;
        entry.label = label || null;
      }
      if (op.status !== undefined) setStatus(next, entry, op.status);
      m.edges.set(op.id, next);
      log.push(entry);
      return;
    }
    case "remove_edge": {
      requireEdge(m, op.id);
      m.edges.delete(op.id);
      log.push({ op: "remove_edge", id: op.id });
      pruneAnnotationTargets(m, sideEffects, log);
      return;
    }
    case "add_annotation": {
      if (m.annotations.size >= LIMITS.annotations) throw new CanvasError("too_large", `at most ${LIMITS.annotations} annotations`);
      const a: Annotation = {
        id: m.nextAnnotationId++,
        nodeIds: uniq(op.nodeIds ?? []).map((id) => requireNode(m, id).id),
        edgeIds: uniq(op.edgeIds ?? []).map((id) => requireEdge(m, id).id),
      };
      if (op.elementIds?.length) a.elementIds = uniq(op.elementIds).map((id) => requireElement(m, id));
      if (op.kind) a.kind = op.kind;
      const text = op.text?.trim();
      if (text) a.text = text;
      a.by = who.source;
      if (who.source === "agent" && who.actor) a.agent = who.actor;
      m.annotations.set(a.id, a);
      created.annotations.push(a.id);
      log.push({ op: "add_annotation", ...a });
      return;
    }
    case "update_annotation": {
      const a = m.annotations.get(op.id);
      if (!a) throw new CanvasError("not_found", `annotation #${op.id} does not exist`, { annotationId: op.id });
      if (who.source === "agent" && a.by !== "agent" && (op.text !== undefined || op.kind !== undefined)) {
        throw new CanvasError(
          "reply_instead",
          `mark #${op.id} is the user's: its text and kind stay as they wrote them. Answer it with {"op":"reply_annotation","id":${op.id},"text":"..."}`,
          { annotationId: op.id },
        );
      }
      const next: Annotation = { ...a };
      const entry: ChangeOp = { op: "update_annotation", id: op.id };
      if (op.nodeIds !== undefined) next.nodeIds = entry.nodeIds = uniq(op.nodeIds).map((id) => requireNode(m, id).id);
      if (op.edgeIds !== undefined) next.edgeIds = entry.edgeIds = uniq(op.edgeIds).map((id) => requireEdge(m, id).id);
      if (op.elementIds !== undefined) {
        const ids = uniq(op.elementIds).map((id) => requireElement(m, id));
        if (ids.length) next.elementIds = ids;
        else delete next.elementIds;
        entry.elementIds = ids;
      }
      if (op.kind !== undefined) {
        if (op.kind) next.kind = op.kind;
        else delete next.kind;
        entry.kind = op.kind;
      }
      if (op.text !== undefined) {
        const text = op.text?.trim();
        if (text) next.text = text;
        else delete next.text;
        entry.text = text || null;
      }
      if (next.orphaned && (next.nodeIds.length || next.edgeIds.length || next.elementIds?.length)) delete next.orphaned;
      m.annotations.set(op.id, next);
      log.push(entry);
      return;
    }
    case "reply_annotation": {
      const a = m.annotations.get(op.id);
      if (!a) throw new CanvasError("not_found", `annotation #${op.id} does not exist`, { annotationId: op.id });
      if ((a.replies?.length ?? 0) >= LIMITS.repliesPerMark) throw new CanvasError("too_large", `at most ${LIMITS.repliesPerMark} replies per mark`);
      const text = op.text.trim();
      if (!text) throw new CanvasError("invalid_patch", "a reply needs text");
      const reply: Reply = { by: who.source, ...(who.source === "agent" && who.actor ? { agent: who.actor } : {}), text, at: new Date().toISOString() };
      m.annotations.set(op.id, { ...a, replies: [...(a.replies ?? []), reply] });
      log.push({ op: "reply_annotation", id: op.id, ...reply });
      return;
    }
    case "remove_annotation": {
      if (!m.annotations.delete(op.id)) {
        throw new CanvasError("not_found", `annotation #${op.id} does not exist`, { annotationId: op.id });
      }
      log.push({ op: "remove_annotation", id: op.id });
      return;
    }
    case "set_direction": {
      m.direction = op.direction;
      log.push({ op: "set_direction", direction: op.direction });
      return;
    }
    case "accept_changes": {
      if (m.type === "sequence") {
        acceptSequenceChanges({ sequence: m.sequence, usedIds: m.usedIds, seqCounters: m.seqCounters }, log, sideEffects, created);
        pruneAnnotationTargets(m, sideEffects, log);
        return;
      }
      // Expands into ordinary operations so the log, undo and agents see exactly what happened.
      for (const e of [...m.edges.values()]) {
        if (e.status === "removed" && m.edges.has(e.id)) applyOp(m, { op: "remove_edge", id: e.id }, log, sideEffects, created, who);
      }
      for (const n of [...m.nodes.values()]) {
        if (n.status === "removed") applyOp(m, { op: "remove_node", id: n.id }, log, sideEffects, created, who);
      }
      for (const e of [...m.edges.values()]) if (e.status) applyOp(m, { op: "update_edge", id: e.id, status: null }, log, sideEffects, created, who);
      for (const n of [...m.nodes.values()]) if (n.status) applyOp(m, { op: "update_node", id: n.id, status: null }, log, sideEffects, created, who);
      return;
    }
  }
}

function setStatus(target: GraphNode | GraphEdge, entry: ChangeOp, status: ChangeStatus | null) {
  if (status) target.status = status;
  else delete target.status;
  entry.status = status;
}

/**
 * Policy for marks whose targets were deleted: drop the deleted ids, keep the
 * mark's id and text, and flag it `orphaned` if nothing is left. Never re-target.
 */
function pruneAnnotationTargets(m: Model, sideEffects: ChangeOp[], log?: ChangeOp[]) {
  const elements = new Set(allIds(m.sequence));
  for (const a of m.annotations.values()) {
    const nodeIds = a.nodeIds.filter((id) => m.nodes.has(id));
    const edgeIds = a.edgeIds.filter((id) => m.edges.has(id));
    const elementIds = a.elementIds?.filter((id) => elements.has(id));
    if (nodeIds.length === a.nodeIds.length && edgeIds.length === a.edgeIds.length && elementIds?.length === a.elementIds?.length) continue;
    const next: Annotation = { ...a, nodeIds, edgeIds };
    if (elementIds?.length) next.elementIds = elementIds;
    else delete next.elementIds;
    if (!nodeIds.length && !edgeIds.length && !elementIds?.length) next.orphaned = true;
    m.annotations.set(a.id, next);
    const fx: ChangeOp = { op: "update_annotation", id: a.id, nodeIds, edgeIds, ...(a.elementIds ? { elementIds: elementIds ?? [] } : {}), reason: "targets deleted" };
    if (next.orphaned) fx.orphaned = true;
    sideEffects.push(fx);
    log?.push(fx);
  }
}

function allocId(m: Model, prefix: "n" | "e", taken?: (id: string) => boolean): string {
  const key = prefix === "n" ? "nodeCounter" : "edgeCounter";
  for (;;) {
    const id = `${prefix}${++m[key]}`;
    if (!m.usedIds.has(id) && !m.nodes.has(id) && !m.edges.has(id) && !taken?.(id)) return id;
  }
}

function claimId(m: Model, id: string, what: "node" | "edge") {
  validateId(id, what);
  if (m.nodes.has(id) || m.edges.has(id)) {
    throw new CanvasError("duplicate_id", `id ${id} is already used by an existing node or edge`, { id });
  }
  m.usedIds.add(id);
}

function requireType(m: Model, type: DiagramType, op: string) {
  if (m.type !== type) {
    throw new CanvasError(
      "wrong_diagram_type",
      `${op} needs a ${type} canvas, but this session holds a ${m.type}` +
        (m.type === "sequence" ? "; use the sequence operations (add_message, add_participant, …)" : "; use the flowchart operations (add_node, add_edge, …)"),
    );
  }
}

function requireElement(m: Model, id: string): string {
  if (m.type !== "sequence") throw new CanvasError("wrong_diagram_type", "elementIds are for sequence diagrams; use nodeIds/edgeIds");
  if (!m.sequence.participants.some((p) => p.id === id) && !findItem(m.sequence, id)) {
    throw new CanvasError("not_found", `sequence element ${id} does not exist`, { id });
  }
  return id;
}

function requireNode(m: Model, id: string): GraphNode {
  const n = m.nodes.get(id);
  if (!n) throw new CanvasError("not_found", `node ${id} does not exist`, { id });
  return n;
}

function requireEdge(m: Model, id: string): GraphEdge {
  const e = m.edges.get(id);
  if (!e) throw new CanvasError("not_found", `edge ${id} does not exist`, { id });
  return e;
}

function checkLabel(label: string): string {
  const l = normalizeLabel(label);
  if (l.length > LIMITS.labelLength) throw new CanvasError("too_large", `label exceeds ${LIMITS.labelLength} characters`);
  return l;
}

function checkNodeLabel(label: string): string {
  const l = normalizeNodeLabel(label);
  if (l.length > LIMITS.labelLength) throw new CanvasError("too_large", `label exceeds ${LIMITS.labelLength} characters`);
  if (!l) throw new CanvasError("invalid_label", "node label must not be empty");
  return l;
}

function enforceLimits(m: Model) {
  if (m.nodes.size > LIMITS.nodes) throw new CanvasError("too_large", `at most ${LIMITS.nodes} nodes; keep the diagram focused`);
  if (m.edges.size > LIMITS.edges) throw new CanvasError("too_large", `at most ${LIMITS.edges} edges`);
}
