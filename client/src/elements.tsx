import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  NodeResizer,
  useInternalNode,
  useReactFlow,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import type { Anchor, ChangeStatus, Direction, NodeShape, Side } from "../../server/types.ts";
import { anchorPoint, nearestAnchor, type EndAnchor, type Rect } from "./anchors.ts";
import { STATUS_META } from "./kinds.ts";

export interface CanvasNodeData extends Record<string, unknown> {
  label: string;
  shape: NodeShape;
  marks: number[];
  direction: Direction;
  status?: ChangeStatus;
  /** Size the user resized the node to; the height still grows if the text needs more. */
  w?: number;
  minHeight?: number;
  /** Moved or resized between two compared revisions. */
  moved?: boolean;
  /** State diagrams: runtime instances currently in this state. */
  instances?: InstanceChip[];
}
export interface InstanceChip {
  id: string;
  label: string;
  fields?: Record<string, string>;
}
export interface CanvasEdgeData extends Record<string, unknown> {
  label?: string;
  marks: number[];
  status?: ChangeStatus;
  direction: Direction;
  /** State diagrams: a transition possible from every state (drawn dashed). */
  fromAny?: boolean;
  /** Where each end attaches to its node. */
  from: EndAnchor;
  to: EndAnchor;
}
export type CanvasNode = Node<CanvasNodeData>;
export type CanvasEdge = Edge<CanvasEdgeData>;

export interface CanvasActions {
  /** Node or edge whose label is being edited inline (ids share one namespace). */
  editingId: string | null;
  setEditingId(id: string | null): void;
  /** Returns the node's id afterwards (a state's id can follow its new name). */
  renameNode(id: string, label: string): string;
  relabelEdge(id: string, label: string): void;
  /** Creates a connected next step after `id` (placed by `id`'s node, linked from `linkId`, default `id`) and starts editing it. */
  addNext(id: string, linkId?: string): void;
  focusMark(id: number): void;
  /** Hovering a #N reference opens that mark's note, as hovering the mark itself does (null: hover ended). */
  hoverMark(id: number | null): void;
  activeMark: number | null;
  markKinds: Record<number, string>;
  /** Elements the agent changed in the last few seconds. */
  touched: ReadonlySet<string>;
  /** Keys typed while a new node was still being created; consumed by its editor. */
  takeTypeAhead(): TypeAhead | null;
  /** Sequence diagrams: new text of a participant/message/note, or a fragment section label. */
  editSequence(id: string, text: string, section?: number): void;
  /** Sequence diagrams: Tab while editing a message continues with the next message. */
  nextMessage(id: string): void;
  /** Flowcharts: the user finished resizing a node. */
  resizeNode(id: string, r: { x: number; y: number; width: number; height: number }): void;
  /** Flowcharts: an edge end was dropped on `nodeId` at `anchor` (null: back to automatic placement). */
  moveEdgeEnd(edgeId: string, end: "from" | "to", nodeId: string, anchor: Anchor | null): void;
}

export interface TypeAhead {
  text: string;
  then: "enter" | "tab" | null;
}

export const ActionsContext = createContext<CanvasActions>({
  editingId: null,
  setEditingId() {},
  renameNode: (id) => id,
  relabelEdge() {},
  addNext() {},
  focusMark() {},
  hoverMark() {},
  activeMark: null,
  markKinds: {},
  touched: new Set(),
  takeTypeAhead: () => null,
  editSequence() {},
  nextMessage() {},
  resizeNode() {},
  moveEdgeEnd() {},
});

export function MarkBadges({ marks }: { marks: number[] }) {
  const { focusMark, hoverMark, activeMark, markKinds } = useContext(ActionsContext);
  if (!marks.length) return null;
  return (
    <span className="badges">
      {marks.map((m) => (
        <button
          key={m}
          className={`badge kind-${markKinds[m] ?? "none"}${activeMark === m ? " active" : ""}`}
          onMouseEnter={() => hoverMark(m)}
          onMouseLeave={() => hoverMark(null)}
          onClick={(e) => {
            e.stopPropagation();
            focusMark(m);
          }}
        >
          #{m}
        </button>
      ))}
    </span>
  );
}

/**
 * Inline label editor. Enter commits, Esc cancels, Tab commits and (for nodes)
 * continues with a new connected step — the fast "type the flow" path.
 */
export function LabelEditor({
  value,
  placeholder,
  onCommit,
  onTab,
  takeTypeAhead,
  className,
}: {
  value: string;
  placeholder?: string;
  /** Called with the new text, or null when the user did not change it (or cancelled). */
  onCommit: (v: string | null) => void;
  onTab?: (v: string | null) => void;
  takeTypeAhead?: () => TypeAhead | null;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  // Compare against the text at edit start, so an untouched editor never overwrites a newer (agent) label.
  const initial = useRef(value);
  const changed = (v: string | null) => (v !== null && v.trim() !== initial.current.trim() ? v : null);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(changed(v));
  };
  const tab = (v: string) => {
    done.current = true;
    onTab?.(changed(v));
  };
  useEffect(() => {
    // A just-created node stays visibility:hidden until React Flow has measured it,
    // and focus() silently fails until then — so retry for a few frames.
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el) {
        if (frames++ < 30) raf = requestAnimationFrame(tryFocus);
        return;
      }
      const pre = takeTypeAhead?.();
      if (!pre || (!pre.text && !pre.then)) {
        el.select();
        return;
      }
      const text = pre.text || value;
      // Set the DOM value synchronously so keys typed from now on append after the buffered text.
      el.value = text;
      el.setSelectionRange(text.length, text.length);
      setDraft(text);
      if (pre.then === "enter") finish(text);
      else if (pre.then === "tab") tab(text);
    };
    tryFocus();
    return () => cancelAnimationFrame(raf);
  }, []); // once per editor
  return (
    <textarea
      ref={ref}
      className={`label-edit nodrag nowheel nopan ${className ?? ""}`}
      value={draft}
      placeholder={placeholder}
      rows={Math.min(8, draft.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 22)), 0))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          finish(null);
        } else if (e.key === "Tab" && onTab) {
          e.preventDefault();
          tab(e.currentTarget.value);
        }
      }}
    />
  );
}

function handles(direction: Direction) {
  const [target, source] = direction === "LR" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <>
      <Handle type="target" position={target} />
      <Handle type="source" position={source} />
    </>
  );
}

const DETAIL_PREFIX: Record<string, string> = { "+": "detail-added", "-": "detail-dropped", "~": "detail-modified" };

/** First line is the step's title; further lines list what happens inside it, diff-style (+ / - / ~). */
function LabelText({ label }: { label: string }) {
  const [title, ...details] = label.split("\n");
  return (
    <div className="label">
      {title}
      {details.length > 0 && (
        <ul className="details">
          {details.map((line, i) => {
            const cls = DETAIL_PREFIX[line[0]] && line[1] === " " ? DETAIL_PREFIX[line[0]] : "";
            return (
              <li key={i} className={cls}>
                {cls ? line.slice(2) : line}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NodeLabel({ id, label }: { id: string; label: string }) {
  const { editingId, setEditingId, renameNode, addNext, takeTypeAhead } = useContext(ActionsContext);
  if (editingId !== id) return <LabelText label={label} />;
  const save = (v: string | null) => {
    const next = v?.trim();
    return next ? renameNode(id, next) : id;
  };
  return (
    <LabelEditor
      value={label}
      takeTypeAhead={takeTypeAhead}
      onCommit={(v) => {
        setEditingId(null);
        save(v);
      }}
      onTab={(v) => {
        addNext(id, save(v));
      }}
    />
  );
}

/** "Order #1042" chips under the state an instance is in; fields show on hover. */
export function InstanceChips({ instances }: { instances: InstanceChip[] }) {
  const { touched } = useContext(ActionsContext);
  if (!instances.length) return null;
  return (
    <div className="instances">
      {instances.map((i) => (
        <span key={i.id} data-instance={i.id} className={`instance${touched.has(`inst:${i.id}`) ? " touched" : ""}`}>
          <span className="instance-dot" aria-hidden />
          {i.label}
          {i.fields && <span className="instance-more">ⓘ</span>}
          <span className="instance-card" role="tooltip">
            <b>{i.label}</b>
            <span className="muted">{i.id}</span>
            {i.fields && (
              <dl>
                {Object.entries(i.fields).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Initial and final pseudo-states ([*]) and choice points: fixed-size marks without a label to edit. */
const PseudoState = memo(function PseudoState({ id, data, selected }: NodeProps<CanvasNode>) {
  const { touched } = useContext(ActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [data.direction, id, updateNodeInternals]);
  return (
    <div
      className={`node node-${data.shape}${data.status ? ` status-${data.status}` : ""}${data.moved ? " diff-moved" : ""}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}${data.instances?.length ? " occupied" : ""}`}
      title={
        data.shape === "choice"
          ? `Choice: ${id}`
          : data.shape === "initial"
            ? "Initial state"
            : data.shape === "any"
              ? "Any state: its transitions are possible from every state"
              : "Final state"
      }
    >
      {data.shape === "any" && <span className="any-label">✱ Any state</span>}
      {data.shape === "choice" && (
        <svg className="diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon points="50,2 98,50 50,98 2,50" />
        </svg>
      )}
      {handles(data.direction)}
      {data.shape === "choice" && <span className="choice-id">{id}</span>}
      <MarkBadges marks={data.marks} />
      {data.instances && <InstanceChips instances={data.instances} />}
    </div>
  );
});

export const CanvasNodeView = memo(function CanvasNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const { setEditingId, touched, editingId, resizeNode } = useContext(ActionsContext);
  // Handles move sides when the direction flips; React Flow keeps the old anchors until told to re-measure.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [data.direction, id, updateNodeInternals]);
  const [live, setLive] = useState<{ height: number } | null>(null);
  // A resized node fills the width React Flow gives it; text never gets cut, the height grows instead.
  // Unresized nodes keep their shape's default size from CSS.
  const sized = live || data.w ? { width: "100%", minHeight: live?.height ?? data.minHeight } : undefined;
  // Text inside a diamond only fits if the diamond is ~2.3x the text height (with 22% side padding);
  // a wider diamond wraps into fewer lines, so it also gets shorter. Unresized diamonds widen until they
  // are no taller than 0.8x their width (up to 360px) instead of stretching into a tall spike.
  const ref = useRef<HTMLDivElement>(null);
  const [diamond, setDiamond] = useState<{ width?: number; height: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    const text = el?.querySelector<HTMLElement>(":scope > .label");
    if (data.shape !== "decision" || !el || !text) return;
    const heightFor = () => Math.max(100, Math.ceil(text.offsetHeight / 0.44) + 6);
    if (live || data.w) return setDiamond({ height: heightFor() });
    let width = 170;
    for (; ; width += 30) {
      el.style.width = `${width}px`;
      if (heightFor() <= width * 0.8 || width >= 360) break;
    }
    setDiamond({ width, height: heightFor() });
  }, [data.shape, data.label, data.w, live]);
  const style =
    data.shape === "decision"
      ? { width: diamond?.width, ...sized, minHeight: Math.max(diamond?.height ?? 100, (sized?.minHeight as number) ?? 0) }
      : sized;
  return (
    <>
    <NodeResizer
      isVisible={selected && editingId !== id}
      minWidth={90}
      minHeight={40}
      lineClassName="resize-line"
      handleClassName="resize-handle"
      onResize={(_, r) => setLive({ height: r.height })}
      onResizeEnd={(_, r) => {
        setLive(null);
        resizeNode(id, r);
      }}
    />
    <div
      ref={ref}
      style={style}
      className={`node node-${data.shape}${data.status ? ` status-${data.status}` : ""}${data.label.includes("\n") ? " has-details" : ""}${data.moved ? " diff-moved" : ""}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}${data.instances?.length ? " occupied" : ""}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditingId(id);
      }}
    >
      {data.shape === "decision" && (
        <svg className="diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon points="50,2 98,50 50,98 2,50" />
        </svg>
      )}
      {data.shape === "store" && (
        <svg className="cylinder" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <path d="M2,12 C2,-2 98,-2 98,12 L98,88 C98,102 2,102 2,88 Z" />
          <path className="rim" d="M2,12 C2,26 98,26 98,12" />
        </svg>
      )}
      {handles(data.direction)}
      {!(data.shape === "state" && data.label.split("\n")[0] === id) && <span className="node-id">{id}</span>}
      {data.status && <span className={`status-tag status-${data.status}`}>{STATUS_META[data.status].label}</span>}
      <MarkBadges marks={data.marks} />
      <NodeLabel id={id} label={data.label} />
      {data.instances && <InstanceChips instances={data.instances} />}
    </div>
    </>
  );
});

export const nodeTypes = {
  action: CanvasNodeView,
  terminal: CanvasNodeView,
  decision: CanvasNodeView,
  store: CanvasNodeView,
  state: CanvasNodeView,
  initial: PseudoState,
  final: PseudoState,
  choice: PseudoState,
  any: PseudoState,
};

const isBackEdge = (sx: number, sy: number, tx: number, ty: number, sp: Position) =>
  (sp === Position.Bottom && ty < sy - 100) || (sp === Position.Right && tx < sx - 100);

/**
 * Back-edges (loops against the flow direction) bulge out sideways instead of cutting through the
 * flow, on the outer side: `far` = bulge right (top-down) or down (left-right), away from the rest.
 */
function edgePath(sx: number, sy: number, tx: number, ty: number, sp: Position, tp: Position, far: boolean): [string, number, number] {
  if (sp === Position.Bottom && ty < sy - 100) {
    const offset = Math.max(90, (sy - ty) * 0.3);
    const side = far ? Math.max(sx, tx) + offset : Math.min(sx, tx) - offset;
    const mid = (sy + ty) / 2;
    return [`M ${sx},${sy} C ${sx},${sy + 70} ${side},${sy + 70} ${side},${mid} S ${tx},${ty - 70} ${tx},${ty}`, side, mid];
  }
  if (sp === Position.Right && tx < sx - 100) {
    const offset = Math.max(70, (sx - tx) * 0.3);
    const side = far ? Math.max(sy, ty) + offset : Math.min(sy, ty) - offset;
    const mid = (sx + tx) / 2;
    return [`M ${sx},${sy} C ${sx + 70},${sy} ${sx + 70},${side} ${mid},${side} S ${tx - 70},${ty} ${tx},${ty}`, mid, side];
  }
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition: sp, targetPosition: tp });
  return [path, lx, ly];
}

/** A node's box in flow coordinates: `a` along the flow direction, `c` across it. */
interface Box {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

/**
 * Where a forward edge that skips past other nodes should run (across-flow coordinate) to clear
 * them, or null when the direct curve is clear. Tries both sides and takes the shorter detour.
 */
function detourLane(boxes: Box[], start: number, end: number, cs: number, ct: number): number | null {
  if (end - start < 160) return null;
  const inSpan = boxes.filter((b) => b.a1 > start + 10 && b.a0 < end - 10);
  const lo = Math.min(cs, ct) - 8;
  const hi = Math.max(cs, ct) + 8;
  const blocking = inSpan.filter((b) => b.c1 > lo && b.c0 < hi);
  if (!blocking.length) return null;
  const clear = (lane: number, dir: 1 | -1) => {
    for (let moved = true; moved; ) {
      moved = false;
      for (const b of inSpan) {
        if (lane > b.c0 - 30 && lane < b.c1 + 30) {
          lane = dir > 0 ? b.c1 + 40 : b.c0 - 40;
          moved = true;
        }
      }
    }
    return lane;
  };
  const right = clear(Math.max(...blocking.map((b) => b.c1)) + 40, 1);
  const left = clear(Math.min(...blocking.map((b) => b.c0)) - 40, -1);
  const cost = (lane: number) => Math.abs(lane - cs) + Math.abs(lane - ct);
  return cost(left) < cost(right) ? left : right;
}

/** A forward edge that leaves along the flow, runs down a clear lane and comes back in to its target; label near the start. */
function detourPath(sx: number, sy: number, tx: number, ty: number, lane: number, lr: boolean): [string, number, number] {
  if (lr) {
    return [`M ${sx},${sy} C ${sx + 60},${sy} ${sx + 20},${lane} ${sx + 80},${lane} L ${tx - 80},${lane} C ${tx - 20},${lane} ${tx - 60},${ty} ${tx},${ty}`, Math.min(sx + 130, (sx + tx) / 2), lane];
  }
  return [`M ${sx},${sy} C ${sx},${sy + 60} ${lane},${sy + 20} ${lane},${sy + 80} L ${lane},${ty - 80} C ${lane},${ty - 20} ${tx},${ty - 60} ${tx},${ty}`, lane, Math.min(sy + 110, (sy + ty) / 2)];
}

const SIDE_POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

function useNodeRect(id: string): { rect: Rect; shape?: NodeShape } | null {
  const n = useInternalNode<CanvasNode>(id);
  if (!n?.measured.width || !n.measured.height) return null;
  const p = n.internals.positionAbsolute;
  return { rect: { x: p.x, y: p.y, width: n.measured.width, height: n.measured.height }, shape: n.data.shape };
}

export const CanvasEdgeView = memo(function CanvasEdgeView(props: EdgeProps<CanvasEdge>) {
  const { id, source, target, data, selected, markerEnd, markerStart } = props;
  const { editingId, setEditingId, relabelEdge, touched, moveEdgeEnd } = useContext(ActionsContext);
  const rf = useReactFlow();
  const store = useStoreApi<CanvasNode, CanvasEdge>();
  const src = useNodeRect(source);
  const tgt = useNodeRect(target);
  // An end being dragged follows the pointer until it is dropped on a node.
  const [drag, setDrag] = useState<{ end: "from" | "to"; x: number; y: number } | null>(null);
  const end = (which: "from" | "to", node: typeof src, fx: number, fy: number, fp: Position) => {
    if (drag?.end === which) return { x: drag.x, y: drag.y, pos: fp };
    const a = data?.[which];
    if (!a || !node) return { x: fx, y: fy, pos: fp };
    return { ...anchorPoint(node.rect, node.shape, a), pos: SIDE_POSITION[a.side] };
  };
  const s = end("from", src, props.sourceX, props.sourceY, props.sourcePosition);
  const t = end("to", tgt, props.targetX, props.targetY, props.targetPosition);
  const [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition] = [s.x, s.y, s.pos, t.x, t.y, t.pos];
  const back = isBackEdge(sourceX, sourceY, targetX, targetY, sourcePosition);
  const lr = data?.direction === "LR";
  // Centre of the other nodes across the flow axis; a loop bulges on the side away from them.
  const others = useStore((s) => {
    if (!back) return null;
    let sum = 0;
    let count = 0;
    for (const n of s.nodeLookup.values()) {
      if (n.id === source || n.id === target) continue;
      const p = n.internals.positionAbsolute;
      sum += lr ? p.y + (n.measured.height ?? 0) / 2 : p.x + (n.measured.width ?? 0) / 2;
      count++;
    }
    return count ? Math.round(sum / count) : null;
  });
  // A forward edge that skips ranks (e.g. "Reviewed → Done") would cut straight through the nodes in between.
  const lane = useStore((s) => {
    const forward = sourcePosition === (lr ? Position.Right : Position.Bottom);
    if (back || !forward) return null;
    const boxes: Box[] = [];
    for (const n of s.nodeLookup.values()) {
      if (n.id === source || n.id === target) continue;
      const p = n.internals.positionAbsolute;
      const w = n.measured.width ?? 0;
      const h = n.measured.height ?? 0;
      boxes.push(lr ? { a0: p.x, a1: p.x + w, c0: p.y, c1: p.y + h } : { a0: p.y, a1: p.y + h, c0: p.x, c1: p.x + w });
    }
    return lr ? detourLane(boxes, sourceX, targetX, sourceY, targetY) : detourLane(boxes, sourceY, targetY, sourceX, targetX);
  });
  const mid = lr ? (sourceY + targetY) / 2 : (sourceX + targetX) / 2;
  const far = others !== null && mid > others;
  const [path, lx, ly] =
    lane !== null
      ? detourPath(sourceX, sourceY, targetX, targetY, lane, lr)
      : edgePath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, far);
  const marks = data?.marks ?? [];
  const editing = editingId === id;
  const cls = [
    data?.status && `edge-status-${data.status}`,
    marks.length && "edge-marked",
    selected && "edge-selected",
    touched.has(id) && "edge-touched",
    data?.fromAny && "edge-any",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={20} className={cls} />
      {selected && !editing && (
        <EdgeLabelRenderer>
          {(["from", "to"] as const).map((which) => {
            const at = which === "from" ? s : t;
            const nodeId = which === "from" ? source : target;
            const flow = (e: { clientX: number; clientY: number }) => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
            return (
              <div
                key={which}
                className={`edge-knob nodrag nopan${data?.[which]?.manual ? " manual" : ""}${drag?.end === which ? " dragging" : ""}`}
                style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
                title="Drag along the border to move this end, or onto another node to reconnect. Double-click: automatic placement"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ end: which, ...flow(e) });
                }}
                onPointerMove={(e) => drag?.end === which && setDrag({ end: which, ...flow(e) })}
                onPointerUp={(e) => {
                  if (drag?.end !== which) return;
                  setDrag(null);
                  const p = flow(e);
                  // The node under the drop point (a little slack around its border), smallest first.
                  let hit: { id: string; rect: Rect } | null = null;
                  for (const n of store.getState().nodeLookup.values()) {
                    const w = n.measured.width ?? 0;
                    const h = n.measured.height ?? 0;
                    const { x, y } = n.internals.positionAbsolute;
                    if (p.x < x - 14 || p.x > x + w + 14 || p.y < y - 14 || p.y > y + h + 14) continue;
                    if (!hit || w * h < hit.rect.width * hit.rect.height) hit = { id: n.id, rect: { x, y, width: w, height: h } };
                  }
                  if (hit) moveEdgeEnd(id, which, hit.id, nearestAnchor(hit.rect, p));
                }}
                onPointerCancel={() => setDrag(null)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  moveEdgeEnd(id, which, nodeId, null);
                }}
              />
            );
          })}
        </EdgeLabelRenderer>
      )}
      {(data?.label || marks.length > 0 || editing) && (
        <EdgeLabelRenderer>
          <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {editing ? (
              <LabelEditor
                className="edge-edit"
                value={data?.label ?? ""}
                placeholder="label"
                onCommit={(v) => {
                  setEditingId(null);
                  if (v !== null) relabelEdge(id, v.trim());
                }}
              />
            ) : (
              data?.label && (
                <span className={`${selected ? "selected" : ""} ${data.status ? `status-${data.status}` : ""}`} onDoubleClick={() => setEditingId(id)}>
                  {data.label}
                </span>
              )
            )}
            <MarkBadges marks={marks} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { canvas: CanvasEdgeView };
