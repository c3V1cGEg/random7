import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  NodeResizer,
  useStore,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import type { ChangeStatus, Direction, NodeShape } from "../../server/types.ts";
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
}
export interface CanvasEdgeData extends Record<string, unknown> {
  label?: string;
  marks: number[];
  status?: ChangeStatus;
}
export type CanvasNode = Node<CanvasNodeData>;
export type CanvasEdge = Edge<CanvasEdgeData>;

export interface CanvasActions {
  /** Node or edge whose label is being edited inline (ids share one namespace). */
  editingId: string | null;
  setEditingId(id: string | null): void;
  renameNode(id: string, label: string): void;
  relabelEdge(id: string, label: string): void;
  /** Creates a connected next step after `id` and starts editing it. */
  addNext(id: string): void;
  focusMark(id: number): void;
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
}

export interface TypeAhead {
  text: string;
  then: "enter" | "tab" | null;
}

export const ActionsContext = createContext<CanvasActions>({
  editingId: null,
  setEditingId() {},
  renameNode() {},
  relabelEdge() {},
  addNext() {},
  focusMark() {},
  activeMark: null,
  markKinds: {},
  touched: new Set(),
  takeTypeAhead: () => null,
  editSequence() {},
  nextMessage() {},
  resizeNode() {},
});

export function MarkBadges({ marks }: { marks: number[] }) {
  const { focusMark, activeMark, markKinds } = useContext(ActionsContext);
  if (!marks.length) return null;
  return (
    <span className="badges">
      {marks.map((m) => (
        <button
          key={m}
          className={`badge kind-${markKinds[m] ?? "none"}${activeMark === m ? " active" : ""}`}
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
    if (next) renameNode(id, next);
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
        save(v);
        addNext(id);
      }}
    />
  );
}

export const CanvasNodeView = memo(function CanvasNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const { setEditingId, touched, editingId, resizeNode } = useContext(ActionsContext);
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
      className={`node node-${data.shape}${data.status ? ` status-${data.status}` : ""}${data.label.includes("\n") ? " has-details" : ""}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}`}
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
      <span className="node-id">{id}</span>
      {data.status && <span className={`status-tag status-${data.status}`}>{STATUS_META[data.status].label}</span>}
      <MarkBadges marks={data.marks} />
      <NodeLabel id={id} label={data.label} />
    </div>
    </>
  );
});

export const nodeTypes = { action: CanvasNodeView, terminal: CanvasNodeView, decision: CanvasNodeView, store: CanvasNodeView };

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

export const CanvasEdgeView = memo(function CanvasEdgeView(props: EdgeProps<CanvasEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const { editingId, setEditingId, relabelEdge, touched } = useContext(ActionsContext);
  const back = isBackEdge(sourceX, sourceY, targetX, targetY, sourcePosition);
  const lr = sourcePosition === Position.Right;
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
  const mid = lr ? (sourceY + targetY) / 2 : (sourceX + targetX) / 2;
  const far = others !== null && mid > others;
  const [path, lx, ly] = edgePath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, far);
  const marks = data?.marks ?? [];
  const editing = editingId === id;
  const cls = [
    data?.status && `edge-status-${data.status}`,
    marks.length && "edge-marked",
    selected && "edge-selected",
    touched.has(id) && "edge-touched",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={20} className={cls} />
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
