import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnBeforeDelete,
  type OnConnectEnd,
} from "@xyflow/react";
import { DIAGRAM_TYPES, awaitingAgent, type Anchor, type Annotation, type AnnotationKind, type ChangeOp, type ChangeStatus, type DiagramType, type EdgeEnds, type EdgeEndsPatch, type NodeShape } from "../../server/types.ts";
import { autoSides, contactEnds, resolveAnchors, type Rect } from "./anchors.ts";
import {
  ConflictError,
  connectSocket,
  describeAgentTool,
  describeOp,
  describeStep,
  fetchRevision,
  opTarget,
  setFork,
  SESSION,
  canvasRef,
  sessionUrl,
  postHistory,
  postLayout,
  postPatch,
  type AgentInfo,
  type SessionSummary,
  type BrowserState,
  type ChangeEvent,
  type Operation,
  type OpTarget,
  type PatchResponse,
  type SocketMessage,
} from "./api.ts";
import { ActionsContext, edgeTypes, nodeTypes, type CanvasActions, type CanvasEdge, type CanvasNode, type TypeAhead } from "./elements.tsx";
import { KIND_META } from "./kinds.ts";
import { DEFAULT_SIZE, dagreLayout, freeSpot, placeMissing, type Size, type XY } from "./layout.ts";
import { ChangeLegend, StateLegend, stateOrder, stateValue } from "./Legend.tsx";
import { OverflowTip } from "./OverflowTip.tsx";
import { walkItems } from "../../server/sequence.ts";
import { SequenceBar } from "./SequenceBar.tsx";
import { FrozenLanes, sequenceNodeTypes } from "./sequenceElements.tsx";
import type { SequenceLayout } from "./sequenceLayout.ts";
import { buildSequenceNodes, isDecoration } from "./sequenceNodes.ts";
import { useSequence } from "./useSequence.ts";
import { SelectionBar, nodeRect } from "./SelectionBar.tsx";
import { ActivityPanel, MarksPanel, MermaidPanel, type ActivityItem } from "./Sidebar.tsx";
import { ComparePanel, RevisionsPanel, UndoButton } from "./Revisions.tsx";
import { comparisonState, diffRevisions, type RevisionDiff } from "./diff.ts";
import { diagramPng, download, drawnBounds } from "./snapshot.ts";
import { buildVsdx, cubics } from "./vsdx.ts";

const TOUCH_HIGHLIGHT_MS = 4000;
/** Arrowhead colours for edge statuses (SVG markers can't use the CSS variables). */
const STATUS_COLOR: Record<ChangeStatus, string> = { new: "#16a34a", changed: "#d97706", removed: "#dc2626" };
const FIT = { padding: 0.25, duration: 300, maxZoom: 1.2 } as const;
const DEFAULT_LABEL: Record<NodeShape, string> = {
  action: "New step",
  decision: "Condition?",
  terminal: "Start",
  store: "Database",
  state: "New state",
  initial: "Start",
  final: "End",
  choice: "choice",
  any: "Any state",
};

const allNodeTypes = { ...nodeTypes, ...sequenceNodeTypes };

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Applies a stored placement (position, and the size the user gave the node, if any) to a React Flow node. */
const place = (n: CanvasNode, p: XY | undefined): CanvasNode =>
  p ? { ...n, position: { x: p.x, y: p.y }, width: p.w, height: undefined, data: { ...n.data, w: p.w, minHeight: p.h } } : n;

const READ_ONLY = "Comparing revisions is read-only: open a revision or go back to the latest to edit.";

/** "2 added, 1 changed, 1 removed" for the comparison banner. */
function compareSummary(d: RevisionDiff): string {
  const count = (c: string) => d.elements.filter((e) => e.change === c).length;
  const parts = [`${count("added")} added`, `${count("changed")} changed`, `${count("removed")} removed`].filter((p) => !p.startsWith("0 "));
  if (d.marks.length) parts.push(`${d.marks.length} mark${d.marks.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no changes to the diagram";
}

const samePlace = (a: XY | undefined, b: XY | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a, gap = 20) =>
  a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

/** Changes that can leave a flowchart's layout untidy: new, removed or reconnected elements, and new label text (sizes). */
const structural = (op: ChangeOp) =>
  ["add_node", "remove_node", "add_edge", "remove_edge"].includes(op.op) ||
  (op.op === "update_node" && (op.label !== undefined || op.shape !== undefined)) ||
  (op.op === "update_edge" && (op.from !== undefined || op.to !== undefined || op.label !== undefined));

/** Messages the page around the canvas (the tab menu) sends to it: to itself, or into a split-view pane. */
export type CanvasMessage = { type: "save-png" } | { type: "save-vsdx"; lines: "curved" | "straight" };

interface AppProps {
  /** Receives the server's session list whenever it changes (the tab strip lives outside the canvas). */
  onSessions: (sessions: SessionSummary[]) => void;
  /** Shown inside one half of a split view: compact top bar with the session name and a close button. */
  onClosePane?: () => void;
}

export default function App(props: AppProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ onSessions, onClosePane }: AppProps) {
  const rf = useReactFlow<CanvasNode, CanvasEdge>();
  const [state, setState] = useState<BrowserState | null>(null);
  const stateRef = useRef<BrowserState | null>(null);
  const [connected, setConnected] = useState(false);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  /** Node positions; mirrors the session's shared layout (incl. deleted nodes, so undo restores them in place). */
  const positions = useRef<Record<string, XY>>({});
  /** Local positions not yet confirmed by the server, protected from stale server echoes. */
  const unsentLayout = useRef<Record<string, XY>>({});
  /** Edge attachment points the user placed (editor-only, shared like positions). */
  const anchors = useRef<Record<string, EdgeEnds>>({});
  const unsentAnchors = useRef(new Set<string>());
  /** Bumped when anchors or node positions change, so edge ends are re-spread. */
  const [edgeVersion, setEdgeVersion] = useState(0);
  const dragging = useRef(new Set<string>());
  const sizes = useRef<Record<string, Size>>({});
  /** One-shot selection to apply on the next rebuild (for elements that arrive with the next server state). */
  const pendingSelect = useRef<Set<string> | null>(null);
  /** Undo groups waiting for a follow-up edit, keyed "node:<id>" / "mark:<id>" (e.g. naming a just-created node). */
  const pendingGroups = useRef(new Map<string, string>());
  /**
   * Revision shown for preview (null: the latest). Undo history lives on the server, per revision;
   * the first edit made while previewing continues from the previewed revision (see setFork).
   */
  const [viewing, setViewing] = useState<number | null>(null);
  const viewingRef = useRef<number | null>(null);
  const forkId = useRef<string | null>(null);
  /** The latest state from the server, kept while an earlier revision is shown. */
  const liveRef = useRef<BrowserState | null>(null);
  const [liveRevision, setLiveRevision] = useState(0);
  /** Two revisions compared on the canvas (read-only; shown as the newer one, with change colours). */
  const [compare, setCompare] = useState<{ diff: RevisionDiff; showMoves: boolean } | null>(null);
  const comparingRef = useRef(false);
  const dragStart = useRef<Record<string, XY>>({});
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const revisionWaiters = useRef<Array<() => void>>([]);
  /** Buffers keystrokes between "create node" and its editor gaining focus, so fast typists lose nothing. */
  const typeAhead = useRef<TypeAhead | null>(null);
  /** Last computed sequence timeline (sequence sessions only). */
  const seqLayout = useRef<SequenceLayout | null>(null);

  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activeMark, setActiveMark] = useState<number | null>(null);
  const [hoverMark, setHoverMark] = useState<number | null>(null);
  const [noteFocus, setNoteFocus] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [missingSession, setMissingSession] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  /** Connect mode: bumping a dragged step into another connects them (the dragged step returns to its place). */
  const [connectMode, setConnectMode] = useState(false);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  /** A step is being dragged: the floating bar hides so it neither trails the step nor covers the drop. */
  const [nodeDrag, setNodeDrag] = useState(false);
  /** Automatic arrow sides of the arrows on the dragged steps, as last drawn (redrawn when they change). */
  const dragSides = useRef("");
  /** Connect mode, during a drag: the step under the pointer, pending bumps, the arrow last touched. */
  /** Connect mode: the dragged box one move ago, and per box it ran into, the sides that touched first. */
  const contact = useRef<{ prev: Rect | null; ends: Map<string, { from: Anchor; to: Anchor }> }>({ prev: null, ends: new Map() });
  const bump = useRef<{ over: string | null | undefined; queue: Promise<unknown>; edge: string | null; bumped: boolean }>({ over: null, queue: Promise.resolve(), edge: null, bumped: false });
  /** Edges this browser just reversed, as they were then: the next click makes them two-way. */
  const reversedEdges = useRef(new Map<string, string>());
  /** Ends placed by hand before an edge was first reversed (null: none), restored when it is back as it was. */
  const endsBeforeReverse = useRef(new Map<string, EdgeEnds | null>());
  /** Sequence diagrams: keep lane names visible at the left edge while scrolling (remembered per browser). */
  const [freezeLanes, setFreezeLanes] = useState(() => {
    try {
      return localStorage.getItem("vc.freezeLanes") !== "0";
    } catch {
      return true;
    }
  });
  /** Flowcharts: re-tidy the layout after an agent changes the diagram's structure (remembered per browser). */
  const [autoTidy, setAutoTidy] = useState(() => {
    try {
      return localStorage.getItem("vc.autoTidy") !== "0";
    } catch {
      return true;
    }
  });
  const autoTidyRef = useRef(autoTidy);
  autoTidyRef.current = autoTidy;
  const toggleAutoTidy = useCallback(() => {
    setAutoTidy((on) => {
      try {
        localStorage.setItem("vc.autoTidy", on ? "0" : "1");
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
      return !on;
    });
  }, []);
  /** The right-hand panel with marks, activity and Mermaid; collapsed gives the canvas the full width (remembered per browser). */
  const [panelTab, setPanelTab] = useState<"current" | "revisions">("current");
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("vc.sidebar") !== "0";
    } catch {
      return true;
    }
  });
  const showSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    try {
      localStorage.setItem("vc.sidebar", open ? "1" : "0");
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }, []);
  const tidyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;
  const toggleFreezeLanes = useCallback(() => {
    setFreezeLanes((on) => {
      try {
        localStorage.setItem("vc.freezeLanes", on ? "0" : "1");
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
      return !on;
    });
  }, []);

  const sizeOf = useCallback((n: { id: string; shape: NodeShape }) => sizes.current[n.id] ?? DEFAULT_SIZE[n.shape], []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  // --- layout ------------------------------------------------------------------

  const fit = useCallback((ids?: string[]) => {
    // Legends float over the top-left of the canvas: keep the framed diagram to the right of them.
    const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
    const legend = document.querySelector(".legend-stack")?.getBoundingClientRect();
    const covered = pane && legend && legend.width > 0 ? legend.right - pane.left : 0;
    const options = covered ? { ...FIT, padding: { top: "12%" as const, bottom: "12%" as const, right: "6%" as const, left: `${Math.round(covered + 32)}px` as const } } : FIT;
    rf.fitView(ids?.length ? { ...options, nodes: ids.map((id) => ({ id })) } : options);
  }, [rf]);

  /** Whether all of these boxes (flow coordinates) lie inside the visible canvas. */
  const inView = useCallback((boxes: Array<{ x: number; y: number; width: number; height: number }>) => {
    const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (!pane) return true;
    const tl = rf.screenToFlowPosition({ x: pane.left, y: pane.top });
    const br = rf.screenToFlowPosition({ x: pane.right, y: pane.bottom });
    return boxes.every((b) => b.x >= tl.x && b.y >= tl.y && b.x + b.width <= br.x && b.y + b.height <= br.y);
  }, [rf]);

  /**
   * Sends positions to the session's shared layout (saved, and pushed to other browsers). `record`
   * names the undo step for the user's own moves; automatic placement is not recorded, and while an
   * earlier revision is previewed it stays local (only a real edit continues from that revision).
   */
  const shareLayout = useCallback((map: Record<string, XY>, record?: string, ends: Record<string, EdgeEndsPatch> = {}) => {
    if (!Object.keys(map).length && !Object.keys(ends).length) return;
    if (viewingRef.current !== null && (!record || comparingRef.current)) return;
    Object.assign(unsentLayout.current, map);
    postLayout(map, ends, record)
      .catch(() => undefined)
      .finally(() => {
        for (const [id, p] of Object.entries(map)) if (unsentLayout.current[id] === p) delete unsentLayout.current[id];
      });
  }, []);

  /** fit: "always", or "outside" to reframe only when part of the diagram ends up out of view. */
  const autoLayout = useCallback((record = false, fitMode: "always" | "outside" = "always") => {
    const s = stateRef.current;
    if (!s) return;
    const before = Object.fromEntries(s.nodes.map((n) => [n.id, positions.current[n.id]]).filter(([, p]) => p));
    // Tidy moves nodes but keeps the sizes the user gave them.
    const laid = Object.fromEntries(
      Object.entries(dagreLayout(s.nodes, s.edges, s.direction, sizeOf)).map(([id, p]) => [id, { ...positions.current[id], ...p }]),
    );
    Object.assign(positions.current, laid);
    // The user's own Tidy also puts hand-placed arrow ends back to automatic: after every box has moved,
    // ends pinned for the old places would make loops. Undo brings them back with the positions.
    const reset: Record<string, EdgeEndsPatch> = {};
    if (record && viewingRef.current === null) {
      for (const id of Object.keys(anchors.current)) reset[id] = { from: null, to: null };
      anchors.current = {};
    }
    const moved = Object.keys(laid).some((id) => !samePlace(before[id], laid[id])) || Object.keys(reset).length > 0;
    shareLayout(laid, record && moved ? "Tidied the layout" : undefined, reset);
    setNodes((nds) => nds.map((n) => place(n, positions.current[n.id])));
    setEdgeVersion((v) => v + 1);
    if (fitMode === "always" || !inView(s.nodes.map((n) => ({ ...positions.current[n.id], ...sizeOf(n) })))) setTimeout(() => fit(), 30);
  }, [fit, inView, shareLayout, sizeOf]);

  /**
   * Tidies after an agent's structural change (nodes or edges added, removed or reconnected, labels
   * that change a node's size), once new nodes are measured. A burst of changes tidies once, and it
   * waits while the user drags or types so nothing moves under their hands.
   */
  const scheduleTidy = useCallback(() => {
    clearTimeout(tidyTimer.current);
    tidyTimer.current = setTimeout(function run() {
      if (!autoTidyRef.current) return;
      if (dragging.current.size || editingRef.current) return void (tidyTimer.current = setTimeout(run, 500));
      autoLayout(false, "outside");
    }, 250);
  }, [autoLayout]);

  const setPosition = useCallback((id: string, pos: XY) => {
    positions.current[id] = pos;
    shareLayout({ [id]: pos });
    setNodes((nds) => nds.map((n) => (n.id === id ? place(n, pos) : n)));
  }, [shareLayout]);

  // --- server state → editor ---------------------------------------------------

  const flashTouched = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setTouched((prev) => new Set([...prev, ...ids]));
    setTimeout(() => {
      setTouched((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, TOUCH_HIGHLIGHT_MS);
  }, []);

  /** `switched`: another revision is shown (preview, or back to the latest): nothing carries over. */
  const receiveState = useCallback(
    (next: BrowserState, event?: ChangeEvent, switched = false) => {
      const prev = stateRef.current;
      if (!prev || prev.sessionId !== next.sessionId || switched) {
        positions.current = {};
        anchors.current = {};
        sizes.current = {};
        pendingGroups.current.clear();
        setActiveMark(null);
        setEditingId(null);
        if (prev && prev.sessionId !== next.sessionId) setActivity([]);
      }
      // The server's layout wins, except for nodes this tab is dragging or has just moved.
      for (const [id, p] of Object.entries(next.layout)) {
        if (!dragging.current.has(id) && !unsentLayout.current[id]) positions.current[id] = p;
      }
      for (const id of Object.keys(anchors.current)) if (!next.anchors[id] && !unsentAnchors.current.has(id)) delete anchors.current[id];
      for (const [id, ends] of Object.entries(next.anchors)) if (!unsentAnchors.current.has(id)) anchors.current[id] = ends;
      // Mostly-new graphs (first drawing, agent redraw) get a full layout; small edits keep the user's layout.
      const unplaced = next.nodes.filter((n) => !positions.current[n.id]).map((n) => n.id);
      const relayout = unplaced.length > 1 && unplaced.length > next.nodes.length / 2;
      positions.current = placeMissing(next.nodes, next.edges, next.direction, positions.current, sizeOf);
      if (!relayout) shareLayout(Object.fromEntries(unplaced.map((id) => [id, positions.current[id]])));

      stateRef.current = next;
      setState(next);
      // Frame a canvas when it first opens (saved positions may lie anywhere) and when a sequence timeline first appears.
      // Never on an empty canvas: React Flow would hold the fit back and zoom onto the first node the user adds.
      const empty = next.type === "sequence" ? !next.sequence.participants.length : !next.nodes.length;
      if (!empty && (!prev || switched || prev.sessionId !== next.sessionId || (next.type === "sequence" && prev.type !== next.type))) setTimeout(() => fit(), 80);
      // Cleared (or opened empty): back to 100% zoom, so the first new step is not drawn tiny at the old zoom.
      else if (empty && prev && prev.sessionId !== next.sessionId) rf.setViewport({ x: 0, y: 0, zoom: 1 });
      revisionWaiters.current.splice(0).forEach((fn) => fn());

      // The state being edited got a new value (id) from elsewhere: keep editing it, with what was typed so far.
      const renamed = event?.ops.find((op) => op.op === "update_node" && typeof op.newId === "string" && op.id === editingRef.current);
      if (renamed) {
        const typed = document.querySelector<HTMLTextAreaElement>("textarea.label-edit")?.value;
        if (typed !== undefined) typeAhead.current = { text: typed, then: null };
        setEditingId(renamed.newId as string);
      }
      if (event) {
        const items = event.ops.map((op, i) => ({
          key: `${event.revision}-${i}`,
          source: event.source,
          actor: event.actor,
          text: describeOp(op),
          target: opTarget(op),
        }));
        setActivity((a) => [...items.reverse(), ...a].slice(0, 60));
        if (event.source === "agent") {
          flashTouched([
            ...items.flatMap((i) => (i.target && "element" in i.target ? [i.target.element] : i.target ? [`#${i.target.mark}`] : [])),
            // An instance that moved: its chip, and the transition it took.
            ...event.ops.flatMap((op) => (op.op === "set_instance" ? [`inst:${op.id}`, ...(typeof op.via === "string" ? [op.via] : Array.isArray(op.via) ? (op.via as string[]) : [])] : [])),
          ]);
        }
      }
      // Laid out once real node sizes have been measured; autoLayout also fits the view.
      if (relayout || event?.ops.some((op) => op.op === "set_direction")) setTimeout(() => autoLayout(), 80);
      else if (event?.ops.some((op) => op.op === "replace_diagram")) setTimeout(() => fit(), 80);
      else if (next.type !== "sequence" && event?.source === "agent" && event.ops.some(structural)) scheduleTidy();
    },
    [autoLayout, fit, flashTouched, rf, scheduleTidy, shareLayout, sizeOf],
  );

  /** Positions moved in another browser (or tab) on the same session. */
  const receiveLayout = useCallback((map: Record<string, XY>, ends: Record<string, EdgeEnds> = {}) => {
    const apply = Object.fromEntries(Object.entries(map).filter(([id]) => !dragging.current.has(id) && !unsentLayout.current[id]));
    Object.assign(positions.current, apply);
    for (const [id, e] of Object.entries(ends)) {
      if (unsentAnchors.current.has(id)) continue;
      if (e.from || e.to) anchors.current[id] = e;
      else delete anchors.current[id];
    }
    setNodes((nds) => nds.map((n) => (apply[n.id] ? place(n, apply[n.id]) : n)));
    setEdgeVersion((v) => v + 1);
  }, []);

  // Handlers go through a ref: their identities change once React Flow initialises, and
  // reconnecting on that would open a second socket on every page load.
  const onSocketMessage = useRef<(m: SocketMessage) => void>(() => undefined);
  onSocketMessage.current = (m) => {
    if (m.type === "state") {
      setMissingSession(false);
      const prevLive = liveRef.current;
      liveRef.current = m.state;
      setLiveRevision(m.state.revision);
      if (viewingRef.current === null) return void receiveState(m.state, m.event);
      // Previewing: the edit this tab made on the previewed revision came back as the latest; or the session was cleared.
      if ((forkId.current && m.state.fork === forkId.current) || (prevLive && prevLive.sessionId !== m.state.sessionId)) {
        leavePreview();
        return void receiveState(m.state, m.event, m.state.fork !== forkId.current);
      }
      // Otherwise keep showing the preview; edits still check against the latest revision.
      if (stateRef.current) stateRef.current = { ...stateRef.current, revision: m.state.revision };
      revisionWaiters.current.splice(0).forEach((fn) => fn());
    } else if (m.type === "layout") {
      if (viewingRef.current === null) receiveLayout(m.positions, m.anchors);
    } else if (m.type === "history") {
      if (viewingRef.current === null && stateRef.current) {
        stateRef.current = { ...stateRef.current, history: m.history };
        setState(stateRef.current);
      }
    }
    else if (m.type === "agents") setAgents(m.agents);
    else if (m.type === "sessions") onSessions(m.sessions);
    else if (m.type === "error" && m.error === "session_not_found") setMissingSession(true);
  };
  useEffect(() => connectSocket((m) => onSocketMessage.current(m), setConnected), []);

  useEffect(() => {
    document.title = SESSION === "default" ? "Visual Agent Canvas" : `${SESSION} · Visual Agent Canvas`;
  }, []);

  // Rebuild React Flow elements whenever semantic state changes; keep selection/measurements.
  useEffect(() => {
    if (!state) return;
    if (state.type === "sequence") {
      const marks = new Map<string, number[]>();
      for (const a of state.annotations) for (const id of a.elementIds ?? []) marks.set(id, [...(marks.get(id) ?? []), a.id]);
      const select = pendingSelect.current;
      pendingSelect.current = null;
      const { nodes: built, layout } = buildSequenceNodes(state.sequence, (id) => marks.get(id) ?? [], new Map(rf.getNodes().map((n) => [n.id, n])), select);
      seqLayout.current = layout;
      setNodes(built as unknown as CanvasNode[]);
      setEdges([]);
      return;
    }
    const nodeMarks = new Map<string, number[]>();
    const edgeMarks = new Map<string, number[]>();
    for (const a of state.annotations) {
      a.nodeIds.forEach((id) => nodeMarks.set(id, [...(nodeMarks.get(id) ?? []), a.id]));
      a.edgeIds.forEach((id) => edgeMarks.set(id, [...(edgeMarks.get(id) ?? []), a.id]));
    }
    const select = pendingSelect.current;
    pendingSelect.current = null;
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return state.nodes.map((n) => {
        const p = positions.current[n.id];
        return {
          ...byId.get(n.id),
          id: n.id,
          type: n.shape,
          position: { x: p?.x ?? 0, y: p?.y ?? 0 },
          width: p?.w,
          height: undefined,
          ...(select ? { selected: select.has(n.id) } : {}),
          data: {
            label: n.label,
            shape: n.shape,
            marks: nodeMarks.get(n.id) ?? [],
            direction: state.direction,
            status: n.status,
            w: p?.w,
            minHeight: p?.h,
            moved: !!compare?.showMoves && compare.diff.moved.includes(n.id),
            ...(state.type === "state"
              ? { instances: state.instances.filter((i) => i.state === n.id && !i.orphaned).map(({ id, label, fields }) => ({ id, label, fields })) }
              : {}),
          },
        };
      });
    });
    const rect = (id: string) => {
      const p = positions.current[id];
      const shape = state.nodes.find((n) => n.id === id)?.shape;
      const size = sizes.current[id] ?? (shape ? DEFAULT_SIZE[shape] : undefined);
      return p && size ? { x: p.x, y: p.y, width: size.width, height: size.height } : undefined;
    };
    const ends = resolveAnchors(state.edges, state.direction, anchors.current, rect);
    setEdges((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      return state.edges.map((e) => ({
        ...byId.get(e.id),
        id: e.id,
        source: e.from,
        target: e.to,
        type: "canvas",
        ...(select ? { selected: select.has(e.id) } : {}),
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, ...(e.status ? { color: STATUS_COLOR[e.status] } : {}) },
        markerStart: e.both
          ? { type: MarkerType.ArrowClosed, width: 18, height: 18, orient: "auto-start-reverse", ...(e.status ? { color: STATUS_COLOR[e.status] } : {}) }
          : undefined,
        data: { label: e.label, marks: edgeMarks.get(e.id) ?? [], status: e.status, direction: state.direction, fromAny: e.from === "any", ...ends[e.id] },
      }));
    });
  }, [state, edgeVersion, compare]);

  useEffect(() => {
    const capture = (e: KeyboardEvent) => {
      const buf = typeAhead.current;
      if (!buf || buf.then || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1) buf.text += e.key;
      else if (e.key === "Backspace") buf.text = buf.text.slice(0, -1);
      else if (e.key === "Enter") buf.then = "enter";
      else if (e.key === "Tab") buf.then = "tab";
      else if (e.key === "Escape") typeAhead.current = null;
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, []);

  // --- editor → server ---------------------------------------------------------

  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const waitForRevision = (revision: number) =>
    (stateRef.current?.revision ?? 0) >= revision
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          revisionWaiters.current.push(resolve);
          setTimeout(resolve, 1500);
        });

  /**
   * Serialized so consecutive edits use the latest revision. On a conflict (the agent
   * committed in between) the edit is retried once against the fresh state; the server
   * still validates every reference, so nothing stale can slip through.
   */
  const send = useCallback(
    (operations: Operation[], group?: string): Promise<PatchResponse | undefined> => {
      if (comparingRef.current) {
        showToast(READ_ONLY);
        return Promise.resolve(undefined);
      }
      // A follow-up edit to a just-created node/mark joins its creation step (one undo removes both).
      if (!group && operations.length === 1 && "id" in operations[0]) {
        const op = operations[0];
        const key =
          op.op === "update_node"
            ? `node:${op.id}`
            : op.op === "update_annotation"
              ? `mark:${op.id}`
              : ["update_message", "update_note", "update_participant", "update_fragment"].includes(op.op)
                ? `seq:${op.id}`
                : undefined;
        if (key) {
          group = pendingGroups.current.get(key);
          pendingGroups.current.delete(key);
        }
      }
      const attempt = async (retry: boolean): Promise<PatchResponse | undefined> => {
        const s = stateRef.current;
        if (!s) return undefined;
        try {
          const res = await postPatch(s.revision, operations, group);
          await waitForRevision(res.revision);
          return res;
        } catch (err) {
          if (err instanceof ConflictError && retry) {
            await waitForRevision(s.revision + 1);
            return attempt(false);
          }
          showToast(err instanceof ConflictError ? "The agent changed the same thing at the same moment — please redo your last edit." : String((err as Error).message ?? err));
          return undefined;
        }
      };
      const p = queue.current.then(() => attempt(true));
      queue.current = p;
      return p;
    },
    [showToast],
  );

  /** Sets (or clears) where one edge end attaches; shared, saved and undoable like positions. */
  const setAnchor = useCallback((edge: string, end: "from" | "to", anchor: Anchor | null) => {
    if (comparingRef.current) return;
    const ends: EdgeEnds = { ...anchors.current[edge] };
    if (anchor) ends[end] = anchor;
    else delete ends[end];
    if (ends.from || ends.to) anchors.current[edge] = ends;
    else delete anchors.current[edge];
    unsentAnchors.current.add(edge);
    postLayout({}, { [edge]: { [end]: anchor } }, `Moved the ${end === "from" ? "start" : "end"} of edge ${edge}`)
      .catch(() => undefined)
      .finally(() => unsentAnchors.current.delete(edge));
    setEdgeVersion((v) => v + 1);
  }, []);

  /** An edge end dropped on a node: reconnect if it is another node, then pin the end where it was dropped. */
  const moveEdgeEnd = useCallback(
    (edgeId: string, end: "from" | "to", nodeId: string, anchor: Anchor | null) => {
      const edge = stateRef.current?.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      if (edge[end] !== nodeId) void send([{ op: "update_edge", id: edgeId, [end]: nodeId }]);
      setAnchor(edgeId, end, anchor);
    },
    [send, setAnchor],
  );

  /**
   * Ctrl+Z / Ctrl+Shift+Z, or several steps at once from the undo list. The server keeps the
   * history (per revision) and checks that the agent hasn't changed the same things since.
   * Runs in the send queue so it never races a pending edit.
   */
  const travel = useCallback(
    (direction: "undo" | "redo", steps = 1) => {
      const run = async () => {
        const s = stateRef.current;
        if (comparingRef.current) return showToast(READ_ONLY);
        if (!s?.history[direction].length) return;
        setEditingId(null);
        try {
          const res = await postHistory(direction, steps);
          await waitForRevision(res.revision);
          const [first, ...rest] = res.steps;
          showToast(`${direction === "undo" ? "Undone" : "Redone"}: ${first ? describeStep(first) : ""}${rest.length ? ` (+${rest.length} more step${rest.length > 1 ? "s" : ""})` : ""}`);
        } catch (err) {
          showToast(`${(err as Error).message.replace(/^can't/, "Can't")}`);
        }
      };
      queue.current = queue.current.then(run, run);
    },
    [showToast],
  );

  /** Shows an earlier revision (only in this tab); the latest one returns to live editing. */
  const openRevision = useCallback(
    async (revision: number) => {
      const live = liveRef.current;
      if (!live || revision === live.revision) return leavePreview(true);
      try {
        const preview = await fetchRevision(revision);
        endCompare();
        forkId.current = crypto.randomUUID();
        setFork({ base: revision, id: forkId.current });
        viewingRef.current = revision;
        setViewing(revision);
        receiveState(preview, undefined, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [receiveState, showToast],
  );

  /**
   * Compares two revisions (older first): the canvas shows the newer one, read-only, with what
   * was added, changed and removed since the older one; the side panel lists the changes.
   */
  const openCompare = useCallback(
    async (from: number, to: number) => {
      try {
        const [a, b] = await Promise.all([fetchRevision(from), fetchRevision(to)]);
        const diff = diffRevisions(a, b);
        forkId.current = null;
        setFork(null);
        comparingRef.current = true;
        viewingRef.current = to;
        setViewing(to);
        setCompare({ diff, showMoves: false });
        setPanelTab("current");
        receiveState(comparisonState(a, b, diff), undefined, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [receiveState, showToast],
  );

  function endCompare() {
    comparingRef.current = false;
    setCompare(null);
  }

  /** Back to the latest revision; `show` redraws it (not needed when it is about to arrive). */
  function leavePreview(show = false) {
    if (viewingRef.current === null) return;
    endCompare();
    viewingRef.current = null;
    forkId.current = null;
    setFork(null);
    setViewing(null);
    if (show && liveRef.current) receiveState(liveRef.current, undefined, true);
  }

  const selectOnly = useCallback((ids: string[]) => {
    const set = new Set(ids);
    pendingSelect.current = set;
    setNodes((nds) => nds.map((n) => ({ ...n, selected: set.has(n.id) })));
    setEdges((eds) => eds.map((e) => ({ ...e, selected: set.has(e.id) })));
  }, []);

  const seq = useSequence(
    useMemo(() => ({ stateRef, layoutRef: seqLayout, send, selectOnly, setEditingId, pendingGroups, typeAhead }), [selectOnly, send]),
  );
  const isSeq = state?.type === "sequence";
  const isState = state?.type === "state";

  /** Legend rows: select the elements and bring them (an edge: both its ends) into view. */
  const revealInGraph = useCallback(
    (ids: string[]) => {
      selectOnly(ids);
      const s = stateRef.current;
      fit(ids.flatMap((id) => {
        const edge = s?.edges.find((e) => e.id === id);
        return edge ? [edge.from, edge.to] : [id];
      }));
    },
    [fit, selectOnly],
  );

  /**
   * The shape N, D and T (and Tab, double-click) create: flowchart step / decision / start-end, or in
   * state diagrams state / choice / the initial state, then the final one.
   */
  const shapeFor = useCallback((key: "step" | "branch" | "end"): NodeShape | null => {
    const s = stateRef.current;
    if (s?.type !== "state") return key === "step" ? "action" : key === "branch" ? "decision" : "terminal";
    if (key === "step") return "state";
    if (key === "branch") return "choice";
    const has = (shape: NodeShape) => s.nodes.some((n) => n.shape === shape);
    return !has("initial") ? "initial" : !has("final") ? "final" : null;
  }, []);

  /** Decision branches get Yes, then No, automatically; easy to change afterwards. */
  const autoEdgeLabel = useCallback((fromId: string): { label?: string } => {
    const s = stateRef.current;
    if (s?.nodes.find((n) => n.id === fromId)?.shape !== "decision") return {};
    const used = new Set(s.edges.filter((e) => e.from === fromId).map((e) => e.label?.toLowerCase()));
    if (!used.has("yes")) return { label: "Yes" };
    if (!used.has("no")) return { label: "No" };
    return {};
  }, []);

  /** Creates a node centred on `center`, optionally connected, then selects it and opens its label editor. */
  const createNode = useCallback(
    async (shape: NodeShape, center: XY, link?: { id: string; as: "source" | "target" }, label?: string) => {
      // Start/end dots and choices have no label to type: keys typed meanwhile must not be held for an editor.
      const labelled = shape !== "initial" && shape !== "final" && shape !== "choice";
      typeAhead.current = labelled ? { text: "", then: null } : null;
      const group = crypto.randomUUID();
      const res = await send([{ op: "add_node", label: label ?? DEFAULT_LABEL[shape], shape }], group);
      const id = res?.createdNodeIds?.[0];
      if (!id) {
        typeAhead.current = null;
        return;
      }
      pendingGroups.current.set(`node:${id}`, group);
      const size = DEFAULT_SIZE[shape];
      const others = rf.getNodes().filter((n) => n.id !== id && !isDecoration(n.id)).map(nodeRect);
      const c = stateRef.current?.type === "sequence" ? center : freeSpot(center, size, others);
      setPosition(id, { x: c.x - size.width / 2, y: c.y - size.height / 2 });
      if (link) {
        const [from, to] = link.as === "source" ? [link.id, id] : [id, link.id];
        await send([{ op: "add_edge", from, to, ...autoEdgeLabel(from) }], group);
      }
      selectOnly([id]);
      if (labelled) setEditingId(id);
    },
    [autoEdgeLabel, rf, selectOnly, send, setPosition],
  );

  const pointerOrCenter = useCallback((): XY => {
    const pane = document.querySelector(".canvas-pane")?.getBoundingClientRect();
    const p = pointer.current ?? { x: pane ? pane.left + pane.width / 2 : innerWidth / 2, y: pane ? pane.top + pane.height / 2 : innerHeight / 2 };
    return rf.screenToFlowPosition(p);
  }, [rf]);

  /** Nodes whose label cannot be edited: start/end dots, choices (named by their id) and "any state". */
  const fixedLabel = useCallback((id: string) => {
    const shape = stateRef.current?.nodes.find((n) => n.id === id)?.shape;
    return shape === "initial" || shape === "final" || shape === "choice" || shape === "any";
  }, []);

  /** State diagrams: the one "any state" marker; transitions from it are possible from every state. */
  const addAnyState = useCallback(() => {
    if (stateRef.current?.nodes.some((n) => n.shape === "any")) {
      selectOnly(["any"]);
      return showToast("“Any state” is already there: draw more transitions from it");
    }
    void createNode("any", pointerOrCenter());
  }, [createNode, pointerOrCenter, selectOnly, showToast]);

  const addNext = useCallback(
    (fromId: string, linkId = fromId, kind?: { shape: NodeShape; label?: string }) => {
      const s = stateRef.current;
      if (s?.nodes.find((n) => n.id === fromId)?.shape === "final") return showToast("Nothing leads out of the end");
      const from = rf.getNode(fromId);
      if (!s || !from) return;
      const r = nodeRect(from);
      const shape = kind?.shape ?? shapeFor("step")!;
      const size = DEFAULT_SIZE[shape];
      const lr = s.direction === "LR";
      let center = lr ? { x: r.x + r.width + 80 + size.width / 2, y: r.y + r.height / 2 } : { x: r.x + r.width / 2, y: r.y + r.height + 70 + size.height / 2 };
      const others = rf.getNodes().map(nodeRect);
      for (let i = 0; i < 12; i++) {
        const box = { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size };
        if (!others.some((o) => overlaps(box, o))) break;
        center = lr ? { ...center, y: center.y + size.height + 40 } : { ...center, x: center.x + size.width + 40 };
      }
      setEditingId(null);
      void createNode(shape, center, { id: linkId, as: "source" }, kind?.label);
    },
    [createNode, rf, shapeFor, showToast],
  );

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    // Removal goes through the server (onBeforeDelete); everything else here is visual-only.
    const visual = changes.filter((c) => c.type !== "remove");
    if (visual.some((c) => c.type === "select")) pendingSelect.current = null;
    for (const c of visual) {
      if (c.type === "position" && c.position) positions.current[c.id] = { ...positions.current[c.id], ...c.position };
      if (c.type === "dimensions" && c.dimensions) sizes.current[c.id] = c.dimensions;
    }
    setNodes((nds) => applyNodeChanges(visual, nds));
  }, []);

  /** Undo-list name of a move: the step's label, or how many steps moved. */
  const movedText = useCallback((ids: string[]) => {
    const node = ids.length === 1 ? stateRef.current?.nodes.find((n) => n.id === ids[0]) : undefined;
    const name = node ? `"${node.label.length > 30 ? node.label.slice(0, 29) + "…" : node.label}"`.replace(/\n/g, " ") : `${ids.length} nodes`;
    return `Moved ${name}`;
  }, []);

  const onNodeDragStart = useCallback((_: unknown, __: unknown, dragged: CanvasNode[]) => {
    dragStart.current = Object.fromEntries(dragged.map((n) => [n.id, { ...positions.current[n.id], ...n.position }]));
    dragged.forEach((n) => dragging.current.add(n.id));
    bump.current.edge = null;
    // Whatever is under the pointer when the drag starts (a box lying under the dragged one) is not a
    // bump: only coming over a box during the drag connects.
    bump.current.over = undefined;
    contact.current = { prev: null, ends: new Map() };
    dragSides.current = "";
    setNodeDrag(true);
  }, []);

  /**
   * One click per step: reversed → arrowheads at both ends → back as it was. State diagrams have no
   * two-way transitions, so there it only reverses. A reversed edge loses ends placed by hand.
   */
  const cycleDirection = useCallback(
    (ids: string[]) => {
      const s = stateRef.current;
      if (!s || s.type === "sequence") return Promise.resolve(undefined);
      const ops: Operation[] = [];
      // A reversed arrow keeps its line: its ends swap attachment points instead of being placed anew.
      const keepLine: Record<string, EdgeEndsPatch> = {};
      const was: Record<string, EdgeEnds | undefined> = {};
      for (const id of ids) {
        const e = s.edges.find((x) => x.id === id);
        if (!e) continue;
        const key = `${e.from}>${e.to}`;
        if (s.type === "flowchart" && !e.both && reversedEdges.current.get(id) === key) {
          ops.push({ op: "update_edge", id, both: true });
          reversedEdges.current.delete(id);
          continue;
        }
        ops.push({ op: "update_edge", id, from: e.to, to: e.from, ...(e.both ? { both: false } : {}) });
        if (e.both) reversedEdges.current.delete(id);
        else reversedEdges.current.set(id, `${e.to}>${e.from}`);
        const drawn = rf.getEdge(id)?.data;
        let ends: EdgeEnds | null;
        if (e.both && endsBeforeReverse.current.has(id)) {
          // Back as it was: the ends it had then (automatic ones are automatic again).
          ends = endsBeforeReverse.current.get(id) ?? null;
          endsBeforeReverse.current.delete(id);
        } else {
          if (!endsBeforeReverse.current.has(id)) endsBeforeReverse.current.set(id, anchors.current[id] ?? null);
          const at = (a: Anchor | undefined) => (a ? { side: a.side, t: a.t } : undefined);
          const from = at(drawn?.to ?? anchors.current[id]?.to);
          const to = at(drawn?.from ?? anchors.current[id]?.from);
          ends = from || to ? { ...(from ? { from } : {}), ...(to ? { to } : {}) } : null;
          // Automatic ends that would land on the same sides anyway (boxes side by side) stay automatic,
          // so the arrow keeps following its boxes when they move later.
          const rect = (nid: string) => {
            const n = rf.getNode(nid);
            return n ? nodeRect(n) : undefined;
          };
          const auto = autoSides(s.direction, rect(e.to), rect(e.from));
          if (!anchors.current[id] && from?.side === auto.from && to?.side === auto.to) ends = null;
        }
        was[id] = anchors.current[id];
        if (ends) anchors.current[id] = ends;
        else delete anchors.current[id];
        keepLine[id] = { from: ends?.from ?? null, to: ends?.to ?? null };
        unsentAnchors.current.add(id);
      }
      if (!ops.length) return Promise.resolve(undefined);
      // Sent after the edge turns, so the turned edge is drawn with the swapped ends straight away.
      const done = () => Object.keys(keepLine).forEach((id) => unsentAnchors.current.delete(id));
      return send(ops).then(async (res) => {
        if (res) await postLayout({}, keepLine, undefined, true).catch(() => undefined);
        else {
          // Not turned (read-only view, or refused): the ends stay as they were.
          for (const [id, e] of Object.entries(was)) {
            if (e) anchors.current[id] = e;
            else delete anchors.current[id];
          }
        }
        done();
        return res;
      });
    },
    [rf, send],
  );

  // Zoom with the mouse alone: turn the wheel while holding the left button (the wheel alone pans).
  // Zooms around the pointer; works on empty canvas and while dragging a step.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let left = false;
    const down = (e: PointerEvent) => e.button === 0 && (left = true);
    const up = (e: PointerEvent) => e.button === 0 && (left = false);
    const reset = () => (left = false);
    const onWheel = (e: WheelEvent) => {
      if (!(left || e.buttons & 1) || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const box = pane.querySelector(".react-flow")?.getBoundingClientRect();
      if (!box) return;
      const { x, y, zoom } = rf.getViewport();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const next = Math.min(2, Math.max(0.2, zoom * Math.pow(2, -delta / 300)));
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      void rf.setViewport({ x: px - ((px - x) * next) / zoom, y: py - ((py - y) * next) / zoom, zoom: next });
    };
    pane.addEventListener("wheel", onWheel, { capture: true, passive: false });
    pane.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("blur", reset);
    return () => {
      pane.removeEventListener("wheel", onWheel, { capture: true });
      pane.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("blur", reset);
    };
  }, [rf]);

  /** Connect mode: the step under the pointer while one step is dragged, other than the dragged one. */
  const connectHit = useCallback(
    (event: MouseEvent | TouchEvent, dragged: CanvasNode[]): string | null => {
      if (!connectMode || dragged.length !== 1 || stateRef.current?.type === "sequence") return null;
      const pt = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!pt) return null;
      const p = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      const hit = rf
        .getNodes()
        .filter((n) => n.id !== dragged[0].id && !isDecoration(n.id))
        .map((n) => ({ id: n.id, r: nodeRect(n) }))
        .filter(({ r }) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height)
        .at(-1);
      return hit?.id ?? null;
    },
    [connectMode, rf],
  );

  /**
   * Connect mode, in one drag: each time the dragged step comes over another step, the first time
   * connects them and every further time turns that arrow one step (reversed → both ends → as it was).
   * Bumps run one after another, each on the state the previous one left.
   */
  const bumpInto = useCallback(
    (from: string, target: string, touched?: { from: Anchor; to: Anchor }) => {
      const b = bump.current;
      b.bumped = true;
      b.queue = b.queue.then(async () => {
        const existing = stateRef.current?.edges.findLast((e) => (e.from === from && e.to === target) || (e.from === target && e.to === from));
        // The dragged step covers the arrow, so each bump says what it did.
        const say = (prefix: string) => {
          const s = stateRef.current;
          const e = s?.edges.find((x) => x.id === b.edge);
          const name = (id: string) => s?.nodes.find((n) => n.id === id)?.label || id;
          if (e) showToast(`${prefix}${name(e.from)} ${e.both ? "↔" : "→"} ${name(e.to)}`);
        };
        if (existing) {
          b.edge = existing.id;
          await cycleDirection([existing.id]);
          say("");
          return;
        }
        const res = await send([{ op: "add_edge", from, to: target, ...autoEdgeLabel(from) }]);
        b.edge = res?.createdEdgeIds?.[0] ?? null;
        // The new arrow runs between the sides that touched first, in the same undo step.
        const id = b.edge;
        if (id && touched && viewingRef.current === null) {
          anchors.current[id] = touched;
          unsentAnchors.current.add(id);
          await postLayout({}, { [id]: touched }, undefined, true)
            .catch(() => undefined)
            .finally(() => unsentAnchors.current.delete(id));
        }
        say("Connected ");
      });
    },
    [autoEdgeLabel, cycleDirection, send, showToast],
  );

  const onNodeDrag = useCallback(
    (event: MouseEvent | TouchEvent, _: unknown, dragged: CanvasNode[]) => {
      // Arrows on the dragged steps turn to the sides facing their other step as it moves.
      const s = stateRef.current;
      if (s && s.type !== "sequence") {
        const ids = new Set(dragged.map((n) => n.id));
        const rect = (id: string) => {
          const n = rf.getNode(id);
          return n ? nodeRect(n) : undefined;
        };
        const sig = s.edges
          .filter((e) => ids.has(e.from) || ids.has(e.to))
          .map((e) => {
            const x = autoSides(s.direction, rect(e.from), rect(e.to));
            return `${e.id}:${x.from}${x.to}`;
          })
          .join(",");
        if (dragSides.current && sig !== dragSides.current) setEdgeVersion((v) => v + 1);
        dragSides.current = sig;
      }
      const hit = connectHit(event, dragged);
      setConnectTarget(hit);
      // Which sides touch first, for each box the dragged one runs into.
      const c = contact.current;
      if (connectMode && dragged.length === 1) {
        const cur = nodeRect(dragged[0]);
        for (const n of rf.getNodes()) {
          if (n.id === dragged[0].id || isDecoration(n.id)) continue;
          const r = nodeRect(n);
          const on = (a: Rect) => a.x < r.x + r.width && a.x + a.width > r.x && a.y < r.y + r.height && a.y + a.height > r.y;
          if (on(cur) && (!c.prev || !on(c.prev))) c.ends.set(n.id, contactEnds(c.prev, cur, r));
        }
        c.prev = cur;
      }
      const b = bump.current;
      if (b.over === undefined) b.over = hit;
      else if (hit !== b.over) {
        b.over = hit;
        if (hit) {
          const r = rf.getNode(hit);
          bumpInto(dragged[0].id, hit, c.ends.get(hit) ?? (r ? contactEnds(null, nodeRect(dragged[0]), nodeRect(r)) : undefined));
        }
      }
    },
    [bumpInto, connectHit, connectMode, rf],
  );

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, __: unknown, dragged: CanvasNode[]) => {
      const before = dragStart.current;
      const b = bump.current;
      setConnectTarget(null);
      setNodeDrag(false);
      b.over = null;
      if (b.bumped) {
        // Connect mode: the dragged step goes back where it was; the arrow it last touched is selected.
        b.bumped = false;
        const from = dragged[0].id;
        dragging.current.delete(from);
        const home = before[from];
        if (home) {
          positions.current[from] = home;
          setNodes((nds) => nds.map((n) => (n.id === from ? place(n, home) : n)));
        }
        // Arrow sides follow where the boxes are, now the step is back home.
        void b.queue.then(() => {
          setEdgeVersion((v) => v + 1);
          if (b.edge) selectOnly([b.edge]);
        });
        return;
      }
      const after = Object.fromEntries(dragged.map((n) => [n.id, { ...positions.current[n.id], ...n.position }]));
      dragged.forEach((n) => dragging.current.delete(n.id));
      if (dragged.some((n) => before[n.id] && (before[n.id].x !== n.position.x || before[n.id].y !== n.position.y))) {
        shareLayout(after, movedText(Object.keys(after)));
        setEdgeVersion((v) => v + 1);
      }
    },
    [movedText, selectOnly, shareLayout],
  );

  // The step a dragged step would connect to in connect mode is highlighted.
  useEffect(() => {
    setNodes((nds) =>
      nds.some((n) => (n.id === connectTarget) !== !!n.className?.includes("connect-target"))
        ? nds.map((n) => ({ ...n, className: n.id === connectTarget ? "connect-target" : undefined }))
        : nds,
    );
  }, [connectTarget, nodes.length]);

  /** Dragging a mark's bubble moves every element it wraps; `delta` null ends the drag (one undo step). */
  const groupDrag = useRef<Record<string, XY> | null>(null);
  const dragGroup = useCallback(
    (ids: string[], delta: XY | null) => {
      if (!groupDrag.current) {
        groupDrag.current = Object.fromEntries(ids.filter((id) => positions.current[id]).map((id) => [id, { ...positions.current[id] }]));
        ids.forEach((id) => dragging.current.add(id));
      }
      const before = groupDrag.current;
      if (delta) {
        const moved = Object.fromEntries(Object.entries(before).map(([id, p]) => [id, { ...p, x: p.x + delta.x, y: p.y + delta.y }]));
        Object.assign(positions.current, moved);
        setNodes((nds) => nds.map((n) => (moved[n.id] ? place(n, moved[n.id]) : n)));
        return;
      }
      groupDrag.current = null;
      ids.forEach((id) => dragging.current.delete(id));
      const after = Object.fromEntries(Object.keys(before).map((id) => [id, { ...positions.current[id] }]));
      if (Object.keys(before).some((id) => before[id].x !== after[id].x || before[id].y !== after[id].y)) {
        shareLayout(after, movedText(Object.keys(after)));
        setEdgeVersion((v) => v + 1);
      }
    },
    [movedText, shareLayout],
  );

  /** End of a resize (drag a corner of a selected node): the size is layout, shared and undoable like a move. */
  const resizeNode = useCallback(
    (id: string, r: { x: number; y: number; width: number; height: number }) => {
      const after = { x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height) };
      positions.current[id] = after;
      shareLayout({ [id]: after }, movedText([id]).replace(/^Moved/, "Resized"));
      setNodes((nds) => nds.map((n) => (n.id === id ? place(n, after) : n)));
    },
    [movedText, shareLayout],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    if (changes.some((c) => c.type === "select")) pendingSelect.current = null;
    setEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), eds));
  }, []);

  const onBeforeDelete: OnBeforeDelete<CanvasNode, CanvasEdge> = useCallback(
    async ({ nodes: delNodes, edges: delEdges }) => {
      if (stateRef.current?.type === "sequence") {
        const ops = seq.deleteOps(delNodes.map((n) => n.id).filter((id) => !isDecoration(id)));
        if (ops.length) void send(ops);
        return false;
      }
      const gone = new Set(delNodes.map((n) => n.id));
      const ops: Operation[] = [
        ...delEdges.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => ({ op: "remove_edge" as const, id: e.id })),
        ...delNodes.map((n) => ({ op: "remove_node" as const, id: n.id })),
      ];
      if (ops.length) void send(ops);
      return false;
    },
    [send, seq],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) void send([{ op: "add_edge", from: c.source, to: c.target, ...autoEdgeLabel(c.source) }]);
    },
    [autoEdgeLabel, send],
  );

  /** Dropping a connector on a node body connects to it; on empty canvas it creates a connected step. */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, cs) => {
      if (cs.isValid || !cs.fromNode) return;
      const fromId = cs.fromNode.id;
      if (stateRef.current?.type === "sequence") {
        // Dropped on a lane header: message at the end; anywhere else: on the nearest lane, at that point in time.
        const { clientX, clientY } = "changedTouches" in event ? event.changedTouches[0] : event;
        const hit = document.elementFromPoint(clientX, clientY)?.closest(".react-flow__node-seqParticipant")?.getAttribute("data-id");
        if (hit) void seq.addMessage({ from: fromId, to: hit });
        else seq.messageAt(rf.screenToFlowPosition({ x: clientX, y: clientY }), fromId);
        return;
      }
      const asSource = cs.fromHandle?.type !== "target";
      const { clientX, clientY } = "changedTouches" in event ? event.changedTouches[0] : event;
      const hit = document.elementFromPoint(clientX, clientY)?.closest(".react-flow__node")?.getAttribute("data-id");
      if (hit && hit !== fromId) {
        const [from, to] = asSource ? [fromId, hit] : [hit, fromId];
        void send([{ op: "add_edge", from, to, ...autoEdgeLabel(from) }]);
      } else if (!hit) {
        void createNode(shapeFor("step")!, rf.screenToFlowPosition({ x: clientX, y: clientY }), { id: fromId, as: asSource ? "source" : "target" });
      }
    },
    [autoEdgeLabel, createNode, rf, send, seq, shapeFor],
  );

  const onPaneDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      const el = e.target as Element;
      if (el.closest(".react-flow__pane") && !el.closest(".react-flow__node, .react-flow__edge, .selection-bar")) {
        const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (stateRef.current?.type === "sequence") seq.messageAt(at);
        else void createNode("action", at);
      }
    },
    [createNode, rf, seq],
  );

  // --- marks -------------------------------------------------------------------

  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);

  /**
   * Box selection also picks up edges attached to the boxed nodes; the ring already covers
   * those, so only edges chosen away from the selected nodes become explicit targets.
   */
  const markTargets = useCallback((): { nodeIds: string[]; edgeIds: string[]; elementIds?: string[] } => {
    if (stateRef.current?.type === "sequence") return { nodeIds: [], edgeIds: [], elementIds: selectedNodes.map((n) => n.id).filter((id) => !isDecoration(id)) };
    const nodeIds = selectedNodes.map((n) => n.id);
    const picked = new Set(nodeIds);
    const edgeIds = selectedEdges.filter((e) => !picked.has(e.source) && !picked.has(e.target)).map((e) => e.id);
    return { nodeIds, edgeIds };
  }, [selectedEdges, selectedNodes]);

  const createMark = useCallback(
    async (kind?: AnnotationKind) => {
      const targets = markTargets();
      if (!targets.nodeIds.length && !targets.edgeIds.length && !targets.elementIds?.length) return;
      const group = crypto.randomUUID();
      const res = await send([{ op: "add_annotation", ...targets, ...(kind ? { kind } : {}) }], group);
      const id = res?.createdAnnotationIds?.[0];
      if (id) {
        pendingGroups.current.set(`mark:${id}`, group);
        showSidebar(true);
        setPanelTab("current");
        setActiveMark(id);
        setNoteFocus(id);
      }
    },
    [markTargets, send, showSidebar],
  );

  const markElements = (a: Annotation) => {
    const s = stateRef.current;
    const endpoints = a.edgeIds.flatMap((id) => {
      const e = s?.edges.find((x) => x.id === id);
      return e ? [e.from, e.to] : [];
    });
    const elements = a.elementIds ?? [];
    return { select: [...a.nodeIds, ...a.edgeIds, ...elements], frame: [...new Set([...a.nodeIds, ...endpoints, ...elements])] };
  };

  const activateMark = useCallback(
    (a: Annotation) => {
      setActiveMark(a.id);
      showSidebar(true);
      const { select, frame } = markElements(a);
      selectOnly(select);
      if (frame.length) fit(frame);
    },
    [fit, selectOnly, showSidebar],
  );

  const focusMarkById = useCallback(
    (id: number) => {
      const a = stateRef.current?.annotations.find((x) => x.id === id);
      if (a) activateMark(a);
    },
    [activateMark],
  );

  const reveal = useCallback(
    (t: OpTarget) => {
      if (!t) return;
      if ("mark" in t) return focusMarkById(t.mark);
      const s = stateRef.current;
      if (s?.type === "sequence") {
        if (rf.getNode(t.element)) {
          selectOnly([t.element]);
          fit([t.element]);
        }
        return;
      }
      const edge = s?.edges.find((e) => e.id === t.element);
      if (edge) {
        selectOnly([edge.id]);
        fit([edge.from, edge.to]);
      } else if (s?.nodes.some((n) => n.id === t.element)) {
        selectOnly([t.element]);
        fit([t.element]);
      }
    },
    [fit, focusMarkById, rf, selectOnly],
  );

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${what} copied — paste it into the agent chat`);
      } catch {
        showToast("Clipboard not available in this browser");
      }
    },
    [showToast],
  );

  /** Downloads the whole diagram as a PNG, without the selection or editing handles. */
  const savePng = useCallback(async () => {
    const all = rf.getNodes();
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!all.length || !viewport) return showToast("Nothing to save yet: the canvas is empty");
    const selected = [...all, ...rf.getEdges()].filter((x) => x.selected).map((x) => x.id);
    selectOnly([]);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    try {
      const bounds = drawnBounds(viewport, (p) => rf.screenToFlowPosition(p, { snapToGrid: false })) ?? rf.getNodesBounds(all);
      download(await diagramPng(viewport, bounds), `${SESSION}.png`);
    } catch (err) {
      showToast(`Could not make the image: ${(err as Error).message}`);
    } finally {
      selectOnly(selected);
    }
  }, [rf, selectOnly, showToast]);

  /** Downloads the flowchart as a Visio file (for Miro, Lucidchart, draw.io), laid out as on the canvas, marks included. */
  const saveVsdx = useCallback((lines: "curved" | "straight") => {
    const s = stateRef.current;
    if (s?.type === "sequence") return showToast("Visio export is for flowcharts; save sequence diagrams as PNG");
    if (!s?.nodes.length) return showToast("Nothing to save yet: the canvas is empty");
    const toFlow = (x: number, y: number) => rf.screenToFlowPosition({ x, y }, { snapToGrid: false });
    const flowBox = (el: Element) => {
      const r = el.getBoundingClientRect();
      const a = toFlow(r.left, r.top);
      const b = toFlow(r.right, r.bottom);
      return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    };
    const edgePath = (id: string) =>
      document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"] path.react-flow__edge-path`);
    const nodes = s.nodes.flatMap((n) => {
      const node = rf.getInternalNode(n.id);
      if (!node) return [];
      const { x, y } = node.internals.positionAbsolute;
      return [{ ...n, x, y, width: node.measured.width ?? 0, height: node.measured.height ?? 0 }];
    });
    const edges = s.edges.flatMap((e) => {
      const path = edgePath(e.id);
      if (!path) return [];
      const at = (length: number) => {
        const { x, y } = path.getPointAtLength(length);
        return { x, y };
      };
      const length = path.getTotalLength();
      const drawn = cubics(path.getAttribute("d") ?? "");
      return [{ ...e, start: at(0), end: at(length), mid: at(length / 2), curve: drawn?.curve }];
    });
    const marks = s.annotations.flatMap((mark) => {
      const ring = document.querySelector(`.ring[data-mark="${mark.id}"]`);
      if (ring) return [{ mark, box: flowBox(ring) }];
      // Marks on edges only have no outline on the canvas, just a chip on the edge: the note goes by its middle.
      const edge = edges.find((e) => mark.edgeIds.includes(e.id));
      if (!edge) return [];
      // Halfway along the drawn edge (where its chip is), not between its ends: a looping edge's ends can be far from its line.
      const mid = lines === "curved" ? edge.mid : { x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2 };
      return [{ mark, box: { x: mid.x + 20, y: mid.y, width: 0, height: 0 }, outline: false }];
    });
    // State diagrams: the instance chips as drawn, and the States legend in lifecycle order.
    const state =
      s.type === "state"
        ? (() => {
            const instances = s.instances.flatMap((i) => {
              const chip = i.orphaned ? null : document.querySelector(`.instance[data-instance="${CSS.escape(i.id)}"]`);
              return chip ? [{ id: i.id, label: i.label, state: i.state, fields: i.fields, ...flowBox(chip) }] : [];
            });
            const { ordered, unreachable, deadEnds, stuckChoices, starts, ends } = stateOrder(s.nodes, s.edges);
            const title = (id: string) => (id === "final" ? "End" : (s.nodes.find((n) => n.id === id)?.label.split("\n")[0] ?? id));
            const fromAny = s.edges.filter((e) => e.from === "any");
            const legendNotes = [
              ...(fromAny.length ? ["From any state:", ...fromAny.map((e) => `${e.label ? `${e.label} → ` : "→ "}${title(e.to)}`)] : []),
              ...stuckChoices.map((id) => `⚠ Choice ${id} has no way out`),
            ];
            const legend = ordered.map((n) => ({
              id: n.id,
              label: n.label,
              count: instances.filter((i) => i.state === n.id).length,
              tags: [
                ...(starts.has(n.id) ? ["start"] : []),
                ...(ends.has(n.id) ? ["end"] : []),
                ...(unreachable.has(n.id) ? ["unreachable"] : []),
                ...(deadEnds.has(n.id) ? ["dead end"] : []),
              ],
            }));
            return { instances, legend, legendNotes };
          })()
        : {};
    try {
      const file = new Blob([buildVsdx({ title: s.title || SESSION, nodes, edges, marks, lines, ...state })], { type: "application/vnd.ms-visio.drawing" });
      const url = URL.createObjectURL(file);
      download(url, `${SESSION}.vsdx`);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      showToast(`Could not make the Visio file: ${(err as Error).message}`);
    }
  }, [rf, showToast]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<CanvasMessage>) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === "save-png") void savePng();
      if (e.data?.type === "save-vsdx") saveVsdx(e.data.lines === "straight" ? "straight" : "curved");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [savePng, saveVsdx]);

  const changeDirection = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    const reset: Record<string, EdgeEndsPatch> = Object.fromEntries(Object.keys(anchors.current).map((id) => [id, { from: null, to: null }]));
    const ok = await send([{ op: "set_direction", direction: s.direction === "TD" ? "LR" : "TD" }]);
    // Hand-placed ends belong to the old direction's sides: back to automatic, in the same undo step.
    if (ok && Object.keys(reset).length && viewingRef.current === null) {
      anchors.current = {};
      setEdgeVersion((v) => v + 1);
      await postLayout({}, reset, undefined, true).catch(() => undefined);
    }
  }, [send]);


  // --- keyboard ----------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || editingId) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        travel(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectOnly([...nodes.map((n) => n.id).filter((id) => !isDecoration(id)), ...edges.map((x) => x.id)]);
        return;
      }
      if (mod || e.altKey) return;
      const single = selectedNodes.length + selectedEdges.length === 1 ? (selectedNodes[0]?.id ?? selectedEdges[0]?.id) : undefined;
      const s = stateRef.current;
      if (s?.type === "sequence") {
        const handledSeq = sequenceKey(e.key, single, s);
        if (handledSeq !== undefined) {
          if (handledSeq) e.preventDefault();
          return;
        }
      }
      const handled = (() => {
        switch (e.key) {
          case "n":
          case "N":
            return void createNode(shapeFor("step")!, pointerOrCenter()), true;
          case "d":
          case "D":
            return void createNode(shapeFor("branch")!, pointerOrCenter()), true;
          case "a":
          case "A":
            if (stateRef.current?.type !== "state") return false;
            return addAnyState(), true;
          case "t":
          case "T": {
            const shape = shapeFor("end");
            if (!shape) return showToast("This state diagram already has its start and end"), true;
            return void createNode(shape, pointerOrCenter()), true;
          }
          case "Tab":
            return selectedNodes.length === 1 && !selectedEdges.length ? (addNext(selectedNodes[0].id), true) : false;
          case "Enter":
          case "F2":
            // Start/end dots, choices and "any state" have no label to edit (and would leave the editor waiting).
            return single && !fixedLabel(single) ? (setEditingId(single), true) : false;
          case "m":
          case "M":
            return selectedNodes.length || selectedEdges.length ? (void createMark(), true) : false;
          case "l":
          case "L":
            return autoLayout(true), true;
          case "r":
          case "R":
            return selectedEdges.length ? (cycleDirection(selectedEdges.map((x) => x.id)), true) : false;
          case "c":
          case "C":
            if (s?.type === "sequence") return false;
            return setConnectMode((on) => !on), true;
          case "f":
          case "F":
            return fit(), true;
          case "?":
            return setHelpOpen((h) => !h), true;
          case "s":
          case "S":
            return showSidebar(!sidebarOpen), true;
          case "Escape":
            setConnectMode(false);
            setHelpOpen(false);
            setActiveMark(null);
            selectOnly([]);
            return true;
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
    };
    /** Sequence keys: true = handled, false = ignored, undefined = fall through to the shared keys. */
    const sequenceKey = (key: string, single: string | undefined, s: BrowserState): boolean | undefined => {
      const lane = single ? s.sequence.participants.find((p) => p.id === single) : undefined;
      const item = single && !lane ? [...walkItems(s.sequence.items)].find((l) => l.item.id === single)?.item : undefined;
      switch (key) {
        case "n":
        case "N":
          if (item?.type === "message") seq.nextMessage(item.id);
          else if (lane) void seq.addMessage({ from: lane.id });
          else void seq.addMessage(item ? { position: { after: item.id } } : {});
          return true;
        case "p":
        case "P":
          return void seq.addParticipant(), true;
        case "Tab":
          return item?.type === "message" ? (seq.nextMessage(item.id), true) : false;
        case "Enter":
        case "F2":
          if (!single || item?.type === "activate" || item?.type === "deactivate") return false;
          return setEditingId(item?.type === "fragment" ? `${single}::0` : single), true;
        case "ArrowLeft":
        case "ArrowRight":
          return item ? (seq.moveItem(item.id, key === "ArrowLeft" ? "earlier" : "later"), true) : false;
        case "ArrowUp":
        case "ArrowDown":
          return lane ? (seq.moveLane(lane.id, key === "ArrowUp" ? "up" : "down"), true) : false;
        case "d":
        case "D":
        case "t":
        case "T":
        case "l":
        case "L":
          return false;
        default:
          return undefined;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addAnyState, addNext, autoLayout, createMark, createNode, cycleDirection, edges, editingId, fit, nodes, pointerOrCenter, selectOnly, selectedEdges, selectedNodes, seq, showSidebar, sidebarOpen, travel]);

  // --- render ------------------------------------------------------------------

  const actions: CanvasActions = useMemo(
    () => ({
      editingId,
      setEditingId,
      renameNode: (id, label) => {
        // A hand-drawn state still has its generated id (n7): its value follows the name it gets, like an enum constant.
        const s = stateRef.current;
        const value = s?.type === "state" && /^n\d+$/.test(id) ? stateValue(label) : null;
        const free = value && value !== id && !s!.nodes.some((n) => n.id === value) && !s!.edges.some((e) => e.id === value);
        void send([{ op: "update_node", id, label, ...(free ? { newId: value } : {}) }]);
        if (free) pendingSelect.current = new Set([value]);
        return free ? value : id;
      },
      relabelEdge: (id, label) => void send([{ op: "update_edge", id, label: label || null }]),
      addNext,
      focusMark: focusMarkById,
      hoverMark: setHoverMark,
      activeMark: hoverMark ?? activeMark,
      markKinds: Object.fromEntries((state?.annotations ?? []).map((a) => [a.id, a.kind ?? "none"])),
      touched,
      takeTypeAhead: () => {
        const buf = typeAhead.current;
        typeAhead.current = null;
        return buf;
      },
      editSequence: seq.editSequence,
      resizeNode,
      moveEdgeEnd,
      nextMessage: seq.nextMessage,
    }),
    [activeMark, addNext, editingId, focusMarkById, hoverMark, moveEdgeEnd, resizeNode, send, seq, state, touched],
  );

  const singleEdge = selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0] : undefined;
  /** Marks the agent answered or asked about; shown on the panel button while the panel is hidden. */
  const waitingForUser = state?.annotations.filter((a) => !awaitingAgent(a)).length ?? 0;
  const decisionEdge = !!singleEdge && state?.nodes.find((n) => n.id === singleEdge.source)?.shape === "decision";

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">
        <header className="topbar">
          {onClosePane ? (
            <span className="pane-title">
              <strong title={state?.title}>{SESSION}</strong>
              <button className="icon" onClick={onClosePane} title="Close this side of the split view">
                ✕
              </button>
            </span>
          ) : (
            <strong className="title">Visual Agent Canvas</strong>
          )}
          <span className={`status ${connected ? "on" : "off"}`} title={`Revision ${state?.revision ?? "–"} · saved on the server`}>
            {connected ? "● live" : "○ reconnecting…"}
          </span>
          <AgentPresence agents={agents} />
          <div className="spacer" />
          {isSeq ? (
            <div className="toolgroup">
              <button onClick={() => void seq.addParticipant()} title="Add a participant lane (P)">
                ☰ Participant <kbd>P</kbd>
              </button>
              <button onClick={() => void seq.addMessage()} title="Add a message at the end (N) — or double-click a lane at the point in time">
                → Message <kbd>N</kbd>
              </button>
              <button
                onClick={() => {
                  const first = stateRef.current?.sequence.participants[0]?.id;
                  if (first) void send([{ op: "add_note", participants: [first], text: "Note" }]);
                }}
                disabled={!state?.sequence.participants.length}
                title="Add a note at the end (then change its lane or text)"
              >
                ▤ Note
              </button>
              <button
                className={freezeLanes ? "on" : ""}
                onClick={toggleFreezeLanes}
                title="Keep lane names visible at the left edge when you scroll along the timeline"
              >
                📌 Lane names
              </button>
            </div>
          ) : (
            <div className="toolgroup">
              <button onClick={() => createNode(shapeFor("step")!, pointerOrCenter())} title={`Add ${isState ? "state" : "step"} (N) — or double-click the canvas`}>
                {isState ? "▢ State" : "▭ Step"} <kbd>N</kbd>
              </button>
              <button onClick={() => createNode(shapeFor("branch")!, pointerOrCenter())} title={`Add ${isState ? "choice" : "decision"} (D)`}>
                {isState ? "◇ Choice" : "◇ Decision"} <kbd>D</kbd>
              </button>
              <button
                onClick={() => {
                  const shape = shapeFor("end");
                  if (shape) void createNode(shape, pointerOrCenter());
                  else showToast("This state diagram already has its start and end");
                }}
                title={isState ? "Add the initial state, then the final state (T)" : "Add start / end (T)"}
              >
                {isState ? "● Start/End" : "⬭ Start/End"} <kbd>T</kbd>
              </button>
              {isState && (
                <button
                  onClick={addAnyState}
                  title="Add “any state”: draw from it what is possible from every state (cancel, delete…), once instead of from each state (A)"
                >
                  ✱ Any state <kbd>A</kbd>
                </button>
              )}
              <button
                className={connectMode ? "on" : ""}
                aria-pressed={connectMode}
                onClick={() => setConnectMode((on) => !on)}
                title={`Connect mode ${connectMode ? "on" : "off"}: drag a ${isState ? "state" : "step"} into another to connect them, again to turn the arrow (C, Esc leaves)`}
              >
                ⤳ Connect <kbd>C</kbd>
              </button>
            </div>
          )}
          <div className="toolgroup">
            <UndoButton items={state?.history.undo ?? []} onUndo={(steps) => travel("undo", steps)} />
            <button onClick={() => travel("redo")} disabled={!state?.history.redo.length} title="Redo (Ctrl+Shift+Z)">
              ↷
            </button>
          </div>
          <div className="toolgroup">
            {!isSeq && (
              <>
                <button onClick={() => autoLayout(true)} disabled={!nodes.length} title="Tidy layout (L)">
                  ⤧ Tidy
                </button>
                <button
                  className="tidy-auto"
                  role="switch"
                  aria-checked={autoTidy}
                  onClick={toggleAutoTidy}
                  title={`Auto-tidy ${autoTidy ? "on" : "off"}: tidy the layout by itself after an agent adds, removes, reconnects or relabels steps (your own edits keep your layout)`}
                >
                  <span className="switch" aria-hidden />
                  Auto
                </button>
              </>
            )}
            <button onClick={() => fit()} disabled={!nodes.length} title="Fit to screen (F)">
              ⛶ Fit
            </button>
            {!isSeq && (
              <button onClick={changeDirection} title="Switch flow direction (re-lays out)">
                {state?.direction === "LR" ? "→ Left-right" : "↓ Top-down"}
              </button>
            )}
          </div>
          <div className="toolgroup">
            <button
              className={`sidebar-toggle${sidebarOpen ? " on" : ""}`}
              aria-pressed={sidebarOpen}
              onClick={() => showSidebar(!sidebarOpen)}
              title={`${sidebarOpen ? "Hide" : "Show"} the side panel with marks, activity and Mermaid (S)`}
            >
              ◨ Panel
              {!sidebarOpen && !!waitingForUser && (
                <span className="count" title={`${waitingForUser} mark${waitingForUser === 1 ? "" : "s"} waiting for you`}>
                  {waitingForUser}
                </span>
              )}
            </button>
            <button onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">
              ?
            </button>
          </div>
        </header>

        <div className="main">
          <div
            ref={paneRef}
            className={`canvas-pane${connectMode && !isSeq ? " connect-mode" : ""}`}
            onMouseMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
            onMouseLeave={() => (pointer.current = null)}
            onDoubleClick={onPaneDoubleClick}
          >
            <ReactFlow<CanvasNode, CanvasEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={allNodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onBeforeDelete={onBeforeDelete}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onEdgeDoubleClick={(ev, e) => !ev.altKey && setEditingId(e.id)}
              onEdgeClick={(ev, e) => {
                // Alt-click (Option-click): next direction step without selecting the arrow first.
                if (!ev.altKey || compare) return;
                ev.preventDefault();
                cycleDirection([e.id]);
              }}
              onPaneClick={() => setActiveMark(null)}
              deleteKeyCode={editingId ? null : ["Backspace", "Delete"]}
              multiSelectionKeyCode={["Meta", "Control", "Shift"]}
              selectionOnDrag
              selectionMode={isSeq ? SelectionMode.Full : SelectionMode.Partial}
              panOnDrag={[1, 2]}
              panOnScroll
              edgesReconnectable={false}
              nodesDraggable={!compare}
              nodesConnectable={!compare}
              zoomOnDoubleClick={false}
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1.2} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="minimap" style={{ width: 150, height: 100 }} />
              {state && (
                <Panel position="top-left" className="legend-stack">
                  {!compare && (
                    <ChangeLegend
                      nodes={isSeq ? [...state.sequence.participants, ...[...walkItems(state.sequence.items)].map((l) => l.item)] : state.nodes}
                      edges={isSeq ? [] : state.edges}
                      onReveal={revealInGraph}
                      onAccept={() => void send([{ op: "accept_changes" }]).then((r) => r && showToast("Changes accepted — Ctrl+Z to undo"))}
                    />
                  )}
                  {/* Hidden while comparing: the canvas then also shows removed states, which are not part of the lifecycle. */}
                  {isState && !compare && <StateLegend nodes={state.nodes} edges={state.edges} instances={state.instances} onReveal={revealInGraph} />}
                </Panel>
              )}
              {isSeq && freezeLanes && state && seqLayout.current && (
                <FrozenLanes participants={state.sequence.participants} laneY={seqLayout.current.laneY} onSelect={(id) => selectOnly([id])} />
              )}
              <MarkRings
                annotations={state?.annotations ?? []}
                nodes={nodes}
                edges={isSeq ? [] : (state?.edges ?? [])}
                active={hoverMark ?? activeMark}
                onFocus={focusMarkById}
                onDrag={isSeq ? undefined : dragGroup}
              />
              {!editingId && isSeq && state && (
                <SequenceBar
                  sequence={state.sequence}
                  allNodes={nodes}
                  nodes={selectedNodes.filter((n) => !isDecoration(n.id))}
                  send={(ops) => void send(ops)}
                  onMark={createMark}
                  onEdit={() => {
                    const id = selectedNodes[0]?.id;
                    if (id) setEditingId(stateRef.current?.sequence && rf.getNode(id)?.type === "seqFragment" ? `${id}::0` : id);
                  }}
                  onNext={seq.nextMessage}
                  onMessageFrom={(from) => void seq.addMessage({ from })}
                  onMove={seq.moveItem}
                  onMoveLane={seq.moveLane}
                  onWrap={(kind) => void seq.wrap(kind, selectedNodes.map((n) => n.id))}
                  onAddSection={seq.addSection}
                  onDelete={() => void rf.deleteElements({ nodes: selectedNodes.map((n) => ({ id: n.id })) })}
                />
              )}
              {!editingId && !isSeq && !nodeDrag && (
                <SelectionBar
                  allNodes={nodes}
                  nodes={selectedNodes}
                  edges={selectedEdges}
                  decisionEdge={decisionEdge}
                  diagram={state?.type === "state" ? "state" : "flowchart"}
                  onMark={createMark}
                  onShape={(shape) => void send([{ op: "update_node", id: selectedNodes[0].id, shape }])}
                  onStatus={(status: ChangeStatus | null) =>
                    void send([
                      ...selectedNodes.map((n) => ({ op: "update_node" as const, id: n.id, status })),
                      ...selectedEdges.map((e) => ({ op: "update_edge" as const, id: e.id, status })),
                    ])
                  }
                  onAddNext={(kind) => addNext(selectedNodes[0].id, selectedNodes[0].id, kind)}
                  onEdit={() => {
                    const id = selectedNodes[0]?.id ?? selectedEdges[0]?.id;
                    if (id && !fixedLabel(id)) setEditingId(id);
                  }}
                  onEdgeLabel={(label) => void send([{ op: "update_edge", id: selectedEdges[0].id, label }])}
                  onDirection={() => cycleDirection(selectedEdges.map((e) => e.id))}
                  onDelete={() =>
                    void rf.deleteElements({ nodes: selectedNodes.map((n) => ({ id: n.id })), edges: selectedEdges.map((e) => ({ id: e.id })) })
                  }
                />
              )}
            </ReactFlow>
            {missingSession ? (
              <MissingSession />
            ) : (
              state &&
              (isSeq ? !state.sequence.participants.length && !state.sequence.items.length : !state.nodes.length) && (
                <EmptyState onCopy={copy} type={state.type} onSwitch={(type) => void send([{ op: "set_diagram_type", type }])} />
              )
            )}
            {isState && state.instances.some((i) => i.orphaned) && (
              <div className="orphan-tray" title="Their state was deleted. The agent can move them with set_instance, or undo brings the state back.">
                <b>Not in any state</b>
                {state.instances
                  .filter((i) => i.orphaned)
                  .map((i) => (
                    <span key={i.id} className="instance" title={`was in ${i.state}`}>
                      <span className="instance-dot" aria-hidden />
                      {i.label}
                    </span>
                  ))}
              </div>
            )}
            <ContextHint nodes={selectedNodes.length} edges={selectedEdges.length} editing={!!editingId} empty={!nodes.length} sequence={isSeq} stateDiagram={isState} />
            {compare && (
              <div className="preview-banner compare">
                <span>
                  Comparing <b>r{compare.diff.from}</b> → <b>r{compare.diff.to}</b>: {compareSummary(compare.diff)}. Read-only.
                </span>
                <button onClick={() => void openRevision(compare.diff.to)}>Open r{compare.diff.to}</button>
                <button onClick={() => leavePreview(true)}>Back to latest</button>
              </div>
            )}
            {viewing !== null && !compare && (
              <div className="preview-banner">
                <span>
                  Viewing <b>revision {viewing}</b> (latest is {liveRevision}). An edit here continues from it as revision {liveRevision + 1}.
                </span>
                <button onClick={() => leavePreview(true)}>Back to latest</button>
              </div>
            )}
            {toast && (
              <div className="toast" onClick={() => setToast(null)}>
                {toast}
              </div>
            )}
          </div>

          {sidebarOpen && (
            <aside className="sidebar">
              <div className="panel-tabs" role="tablist">
                <button role="tab" aria-selected={panelTab === "current"} className={panelTab === "current" ? "on" : ""} onClick={() => setPanelTab("current")}>
                  {compare ? "Changes" : viewing === null ? "Current" : `Revision ${viewing}`}
                </button>
                <button role="tab" aria-selected={panelTab === "revisions"} className={panelTab === "revisions" ? "on" : ""} onClick={() => setPanelTab("revisions")}>
                  Revisions <span className="count">{liveRevision}</span>
                </button>
              </div>
              {panelTab === "revisions" && (
                <RevisionsPanel
                  head={liveRevision}
                  viewing={viewing}
                  compared={compare ? [compare.diff.from, compare.diff.to] : null}
                  onOpen={(r) => void openRevision(r)}
                  onCompare={(a, b) => void openCompare(a, b)}
                />
              )}
              {panelTab === "current" && compare && (
                <ComparePanel
                  diff={compare.diff}
                  showMoves={compare.showMoves}
                  onShowMoves={(showMoves) => setCompare({ ...compare, showMoves })}
                  onReveal={reveal}
                  onClose={() => leavePreview(true)}
                />
              )}
              {panelTab === "current" && !compare && state && (
                <MarksPanel
                  state={state}
                  activeMark={activeMark}
                  noteFocus={noteFocus}
                  selectionSize={selectedNodes.length + selectedEdges.length}
                  touched={touched}
                  send={send}
                  onActivate={activateMark}
                  onHover={setHoverMark}
                  onRetarget={(a) => void send([{ op: "update_annotation", id: a.id, ...markTargets() }])}
                  onCopy={copy}
                />
              )}
              {panelTab === "current" && !compare && <ActivityPanel items={activity} onReveal={reveal} />}
              {panelTab === "current" && !compare && <MermaidPanel diagram={state?.diagram ?? ""} onCopy={copy} />}
            </aside>
          )}
        </div>
        <OverflowTip />
        {helpOpen && <HelpOverlay sequence={isSeq} onClose={() => setHelpOpen(false)} />}
      </div>
    </ActionsContext.Provider>
  );
}

// --- annotation rings (editor-only geometry) -----------------------------------

function MarkRings({
  annotations,
  nodes,
  edges,
  active,
  onFocus,
  onDrag,
}: {
  annotations: Annotation[];
  nodes: CanvasNode[];
  edges: Array<{ id: string; from: string; to: string }>;
  active: number | null;
  onFocus: (id: number) => void;
  /** Flowcharts only: moves the ring's nodes by a flow-space delta (null = drag ended). */
  onDrag?: (ids: string[], delta: XY | null) => void;
}) {
  const zoom = useStore((s) => s.transform[2]);
  const drag = useRef<{ ids: string[]; x: number; y: number; moved: boolean } | null>(null);
  // Arrows between a ring's own nodes belong inside it: a loop or detour bulging past the nodes would
  // otherwise leave the ring and come back in. Their drawn extents are measured after each render.
  const [edgeBoxes, setEdgeBoxes] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const inner = new Map(
    annotations.map((a) => {
      const own = new Set(a.nodeIds);
      return [a.id, edges.filter((e) => own.has(e.from) && own.has(e.to)).map((e) => e.id)] as const;
    }),
  );
  const innerKey = [...new Set([...inner.values()].flat())].sort().join(" ");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const next: typeof edgeBoxes = {};
      for (const id of innerKey ? innerKey.split(" ") : []) {
        const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"] path.react-flow__edge-path`);
        const b = path?.getBBox();
        if (b) next[id] = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
      }
      setEdgeBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    });
    return () => cancelAnimationFrame(frame);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rings: Array<{ a: Annotation; x: number; y: number; w: number; h: number }> = [];
  for (const a of annotations) {
    const nodeRects = [...a.nodeIds, ...(a.elementIds ?? [])].map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n?.position).map(nodeRect);
    if (!nodeRects.length) continue;
    const rects = [...nodeRects, ...(inner.get(a.id) ?? []).flatMap((id) => (edgeBoxes[id] ? [edgeBoxes[id]] : []))];
    const x1 = Math.min(...rects.map((r) => r.x));
    const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.width));
    const y2 = Math.max(...rects.map((r) => r.y + r.height));
    // Nest rings that overlap earlier ones so each stays visible.
    const stack = rings.filter((r) => r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1).length;
    const pad = 16 + stack * 10;
    rings.push({ a, x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad });
  }
  return (
    <ViewportPortal>
      {rings.map(({ a, x, y, w, h }) => (
        <div
          key={a.id}
          className={`ring kind-${a.kind ?? "none"}${active === a.id ? " active" : ""}`}
          data-mark={a.id}
          style={{ transform: `translate(${x}px, ${y}px) rotate(${a.id % 2 ? -0.6 : 0.5}deg)`, width: w, height: h }}
        >
          <button
            className={`ring-badge nodrag nopan${onDrag ? " movable" : ""}`}
            title={onDrag ? "Click to open · drag to move everything in this mark" : undefined}
            onPointerDown={(e) => {
              if (!onDrag || e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { ids: a.nodeIds, x: e.clientX, y: e.clientY, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (!d.moved && Math.hypot(dx, dy) < 4) return;
              d.moved = true;
              onDrag?.(d.ids, { x: dx / zoom, y: dy / zoom });
            }}
            onPointerUp={() => {
              if (drag.current?.moved) onDrag?.(drag.current.ids, null);
              else drag.current = null;
            }}
            onClick={() => {
              const moved = drag.current?.moved;
              drag.current = null;
              if (!moved) onFocus(a.id);
            }}
            aria-label={`Open mark #${a.id}`}
          >
            <span>#{a.id}</span>
            {a.kind && <span className="ring-kind">{KIND_META[a.kind].icon}</span>}
            {a.text && <span className="ring-text">{a.text}</span>}
            {!!a.replies?.length && <span className="ring-replies" title={`${a.replies.length} replies`}>💬 {a.replies.length}</span>}
          </button>
        </div>
      ))}
    </ViewportPortal>
  );
}

// --- chrome ------------------------------------------------------------------

const ago = (at: number) => {
  const secs = Math.round((Date.now() - at) / 1000);
  return secs < 10 ? "just now" : secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.round(secs / 60)}m ago` : "a while ago";
};

/** One chip per agent that used this session, most recent first. */
function AgentPresence({ agents }: { agents: AgentInfo[] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!agents.length) {
    return (
      <span className="agent idle" data-tip={`No agent has used this session yet. Tell your agent to use ${canvasRef()}.`}>
        No agent yet
      </span>
    );
  }
  const sorted = [...agents].sort((a, b) => b.at - a.at);
  return (
    <span className="agents">
      {sorted.slice(0, 3).map((a) => (
        <span key={a.name} className={`agent${Date.now() - a.at < 5000 ? " busy" : ""}`} data-tip={`${a.name}: last MCP call ${ago(a.at)}`}>
          <b>{a.name}</b> {describeAgentTool(a.tool)} · {ago(a.at)}
        </span>
      ))}
      {sorted.length > 3 && <span className="agent idle" data-tip={sorted.slice(3).map((a) => a.name).join(", ")}>+{sorted.length - 3}</span>}
    </span>
  );
}

function MissingSession() {
  return (
    <div className="empty">
      <div className="empty-card">
        <h2>No session “{SESSION}”</h2>
        <p className="muted">It may have been deleted. Create it from the session menu, or go back to the default canvas.</p>
        <p>
          <a href={sessionUrl("default")}>Open the default session</a>
        </p>
      </div>
    </div>
  );
}

function ContextHint({
  nodes,
  edges,
  editing,
  empty,
  sequence,
  stateDiagram,
}: {
  nodes: number;
  edges: number;
  editing: boolean;
  empty: boolean;
  sequence: boolean;
  stateDiagram?: boolean;
}) {
  let hint: string;
  if (sequence) {
    if (editing) hint = "Enter save · Shift+Enter new line · Tab save & next message · Esc cancel";
    else if (nodes === 1) hint = "Enter edit · ← → earlier / later · ↑ ↓ move lane · N next message · M mark · Del delete";
    else if (nodes) hint = `${nodes} selected · group them with alt / par / loop… on the bar · M mark · Del delete`;
    else if (empty) hint = "P add a participant · N add a message · ? shortcuts";
    else hint = "Double-click a lane to add a message there · drag from a lane's ● onto another lane · drag to select · ? shortcuts";
    return <div className="context-hint">{hint}</div>;
  }
  if (editing) hint = "Enter save · Tab save & add next step · Esc cancel";
  else if (nodes === 1 && !edges) hint = `Enter rename · Tab add next ${stateDiagram ? "state" : "step"} · M mark · drag a handle to connect · Del delete`;
  else if (edges === 1 && !nodes) hint = "Enter edit label · R direction · M mark · drag an end along the border or onto another node · double-click an end: automatic · Del delete";
  else if (nodes || edges) hint = `${nodes + edges} selected · drag any selected node to move them together · M mark selection · Del delete`;
  else if (empty) hint = "Double-click to add a step · ? shortcuts";
  else hint = "Drag to select · Space-drag or scroll to pan · Ctrl+scroll or left button + scroll to zoom · double-click to add · Alt-click an arrow: direction · ? shortcuts";
  return <div className="context-hint">{hint}</div>;
}

interface ChannelSetupInfo {
  setups: Array<{ where: string; command: string }>;
  start: string;
}

/**
 * Optional setup for live notifications. The server works out the register command for where it
 * runs (Windows, WSL, Linux, macOS; its folder and node binary), so it can be copied as is.
 */
function ChannelSetup({ onCopy }: { onCopy: (text: string, what: string) => void }) {
  const [info, setInfo] = useState<ChannelSetupInfo | null>(null);
  const load = () => {
    if (!info) fetch("/api/channel-setup").then((r) => r.json()).then(setInfo, () => undefined);
  };
  const copyLine = (text: string) => (
    <button className="copyline" onClick={() => onCopy(text, "Command")} title="Copy">
      <code>{text}</code> <span>⧉</span>
    </button>
  );
  return (
    <details className="channel-setup" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>Optional: let a running Claude Code session react to your marks by itself</summary>
      <span>Register the channel bridge once, in a terminal where Claude Code runs:</span>
      {info?.setups.map((s) => (
        <div key={s.where} className="channel-option">
          <span className="channel-where">{s.where}</span>
          {copyLine(s.command)}
        </div>
      ))}
      {!info && <span className="muted">Loading…</span>}
      <span className="muted">
        Registered before? Run <code>claude mcp remove visual-canvas-channel --scope user</code> first. Or, in this canvas folder, run{" "}
        <code>npm run channel:register</code>.
      </span>
      <span>Then start Claude Code with the channel enabled:</span>
      {copyLine(info?.start ?? "claude --dangerously-load-development-channels server:visual-canvas-channel")}
      <span className="muted">
        Channels are a Claude Code research preview. A self-built channel like this one can only be loaded with this development flag, which shows a
        warning screen at every start (choose <i>I am using this for local development</i>). The no-warning <code>--channels</code> option only takes
        approved plugins. Plain <code>claude</code> keeps working, just without the automatic notices. Needs a claude.ai login or Console API key; on
        Team/Enterprise an Owner must enable Channels.
      </span>
    </details>
  );
}

const TYPE_NAME: Record<DiagramType, string> = { flowchart: "flowchart", sequence: "sequence diagram", state: "state diagram" };
const TYPE_PITCH: Record<DiagramType, string> = {
  flowchart: "a flowchart (business logic)",
  sequence: "a sequence diagram (timeline, concurrency)",
  state: "a state diagram (lifecycle of an order, ticket…)",
};

function EmptyState({ onCopy, type, onSwitch }: { onCopy: (text: string, what: string) => void; type: DiagramType; onSwitch: (type: DiagramType) => void }) {
  const sequence = type === "sequence";
  const cmd = `claude mcp add --transport http --scope user visual-canvas ${location.origin}/mcp`;
  const prompt = sequence
    ? `At high detail, inspect <feature> and show its timing and concurrency (workers, transactions, locks, retries) as a sequence diagram on ${canvasRef()}. No code changes.`
    : type === "state"
      ? `Inspect <entity> and show its lifecycle (states and the events that move it between them) as a state diagram on ${canvasRef()}. No code changes.`
      : `At low detail, inspect <feature> and show its business logic on ${canvasRef()}. No code changes.`;
  const skill = `mkdir -p ~/.claude/skills/visual-canvas && curl -s ${location.origin}/skill.md -o ~/.claude/skills/visual-canvas/SKILL.md`;
  return (
    <div className="empty">
      <div className="empty-card">
        <h2>Start a visual discussion</h2>
        <ol>
          <li>
            <span>Connect your agent once</span>
            <button className="copyline" onClick={() => onCopy(cmd, "Command")} title="Copy">
              <code>{cmd}</code> <span>⧉</span>
            </button>
          </li>
          <li>
            <span>
              Optional: install the drawing skill (detail levels <i>low / medium / high</i>, conventions). Agents can also fetch it themselves with{" "}
              <code>canvas_get_visualization_skill</code>.
            </span>
            <button className="copyline" onClick={() => onCopy(skill, "Install command")} title="Copy">
              <code>{skill}</code> <span>⧉</span>
            </button>
          </li>
          <li>
            <span>Ask it to draw</span>
            <button className="copyline" onClick={() => onCopy(prompt, "Prompt")} title="Copy">
              <code>{prompt}</code> <span>⧉</span>
            </button>
          </li>
          <li>
            <span>Then edit, select and press <kbd>M</kbd> to mark — the agent sees each mark as #N.</span>
          </li>
          <li>
            <ChannelSetup onCopy={onCopy} />
          </li>
        </ol>
        <p className="muted">
          {sequence
            ? "Or sketch yourself: press P for a participant lane and N for a message."
            : type === "state"
              ? "Or sketch yourself: T for the start, N for a state, Tab for the next one."
              : "Or sketch yourself: double-click anywhere, or press N."}
        </p>
        <p className="muted">
          This canvas is a <b>{TYPE_NAME[type]}</b>. Use{" "}
          {DIAGRAM_TYPES.filter((t) => t !== type).map((t, i) => (
            <span key={t}>
              {i > 0 && " or "}
              <button className="linklike" onClick={() => onSwitch(t)}>
                {TYPE_PITCH[t]}
              </button>
            </span>
          ))}{" "}
          instead.
        </p>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["N / D / T", "Add step / decision / start-end (at the mouse)"],
  ["Double-click canvas", "Add step there"],
  ["Enter or F2", "Edit label of the selected node or edge"],
  ["Tab", "Add a connected next step (also while typing a label)"],
  ["Shift+Enter", "While typing: add a detail line inside the step; start it with + / - / ~ for added / dropped / modified"],
  ["New / Changed / Removed", "Selection bar: colour the selection as part of a proposed change (click again to clear)"],
  ["Drag from a handle", "Connect; drop on empty canvas to create a connected step"],
  ["C", "Connect mode on / off: drag a step into another to connect them; out and back in again (still dragging) changes the arrow's direction"],
  ["R or ⇄", "Selected arrow: reverse → arrowheads at both ends → as it was"],
  ["Alt-click an arrow", "The same direction step, without selecting it first (Option-click on a Mac)"],
  ["M", "Mark the selection (then type the note)"],
  ["Drag on canvas", "Box-select (touching counts)"],
  ["Shift / Ctrl-click", "Add to selection"],
  ["Drag a selected node", "Move the whole selection together"],
  ["Drag a mark's label", "Move every element the mark wraps (click it to open the note)"],
  ["Ctrl+A", "Select all"],
  ["Del / Backspace", "Delete selection"],
  ["Space-drag, scroll", "Pan · Ctrl+scroll, left button + scroll, or pinch to zoom"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo your own changes (incl. moves); never undoes the agent's"],
  ["Alt+N (Option+N)", "New session tab (Ctrl/Cmd+N too, where the browser does not keep it for a new window)"],
  ["L / F", "Tidy layout / fit to screen"],
  ["S", "Show / hide the side panel (marks, activity, Mermaid)"],
  ["Esc", "Clear selection"],
];

const SEQUENCE_SHORTCUTS: Array<[string, string]> = [
  ["P / N", "Add a participant lane / a message (after the selection)"],
  ["Double-click a lane", "Add a message from that lane at that point in time"],
  ["Drag from a lane's ●", "Drop on another lane: message to it, at the drop point"],
  ["Enter or F2", "Edit text; Shift+Enter adds a line"],
  ["Tab", "Next message (a request is answered by a reply)"],
  ["← / →", "Move the selected item earlier / later (also into and out of blocks)"],
  ["↑ / ↓", "Move the selected lane up / down"],
  ["Select items + alt / par / loop…", "Group them in a block; par makes each item its own concurrent branch"],
  ["M · Del · Ctrl+Z", "Mark · delete · undo, as in flowcharts"],
  ["S", "Show / hide the side panel (marks, activity, Mermaid)"],
  ["Alt+N (Option+N)", "New session tab (Ctrl/Cmd+N too, where the browser does not keep it for a new window)"],
  ["Steps 1, 2, 3…", "Logical order only, not time; concurrent and alternative work shares step numbers"],
];

function HelpOverlay({ onClose, sequence }: { onClose: () => void; sequence: boolean }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Keyboard & mouse</h2>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </header>
        <dl>
          {(sequence ? SEQUENCE_SHORTCUTS : SHORTCUTS).map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
