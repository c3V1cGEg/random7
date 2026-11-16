import type { ReactNode } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { CHANGE_STATUSES, type AnnotationKind, type ChangeStatus, type NodeShape } from "../../server/types.ts";
import type { CanvasEdge, CanvasNode } from "./elements.tsx";
import { KIND_META, QUICK_KINDS, STATUS_META } from "./kinds.ts";
import { DEFAULT_SIZE } from "./layout.ts";

export interface SelectionBarProps {
  allNodes: CanvasNode[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Selected single edge leaves a decision node: offer Yes/No chips. */
  decisionEdge: boolean;
  onMark(kind?: AnnotationKind): void;
  onShape(shape: NodeShape): void;
  /** Sets the proposal status on the whole selection; null marks it existing. */
  onStatus(status: ChangeStatus | null): void;
  onAddNext(): void;
  onEdit(): void;
  onEdgeLabel(label: string): void;
  onDelete(): void;
}

const SHAPES: Array<[NodeShape, string, string]> = [
  ["action", "▭", "Step"],
  ["decision", "◇", "Decision"],
  ["terminal", "⬭", "Start / End"],
  ["store", "⛁", "Data store (database, queue table, file)"],
];

export function nodeRect(n: CanvasNode) {
  const s = n.measured?.width
    ? { width: n.measured.width, height: n.measured.height ?? 0 }
    : n.width
      ? { width: n.width, height: n.height ?? 0 }
      : DEFAULT_SIZE[n.data.shape];
  return { x: n.position.x, y: n.position.y, ...s };
}

/** Positions its children above the selection (Figma/Notion style), constant size at any zoom. */
export function FloatingBar({ allNodes, nodes, edges, children }: { allNodes: CanvasNode[]; nodes: CanvasNode[]; edges: CanvasEdge[]; children: ReactNode }) {
  const zoom = useStore((s) => s.transform[2]);
  if (!nodes.length && !edges.length) return null;

  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const points: Array<{ x: number; y: number }> = [];
  for (const n of nodes) {
    const r = nodeRect(n);
    points.push({ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height });
  }
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const ra = nodeRect(a);
    const rb = nodeRect(b);
    // Above both end nodes, so the bar never covers the edge's draggable ends.
    points.push({ x: (ra.x + ra.width / 2 + rb.x + rb.width / 2) / 2, y: Math.min(ra.y, rb.y) });
  }
  if (!points.length) return null;
  const minX = Math.min(...points.map((q) => q.x));
  const maxX = Math.max(...points.map((q) => q.x));
  const minY = Math.min(...points.map((q) => q.y));

  return (
    <ViewportPortal>
      <div
        className="selection-bar nodrag nopan"
        style={{ transform: `translate(${(minX + maxX) / 2}px, ${minY - 22}px) scale(${1 / zoom}) translate(-50%, -100%)` }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </ViewportPortal>
  );
}

/** Mark-kind chips shared by both diagram types. */
export function MarkChips({ onMark }: { onMark(kind?: AnnotationKind): void }) {
  return (
    <span className="group" aria-label="Mark selection">
      {QUICK_KINDS.map((k) => (
        <button
          key={k ?? "none"}
          className={`chip kind-${k ?? "none"}`}
          title={k ? `Mark as ${KIND_META[k].label.toLowerCase()}` : "Mark selection (M)"}
          onClick={() => onMark(k)}
        >
          <span className="dot">{KIND_META[k ?? "none"].icon}</span>
          {k ? null : "Mark"}
        </button>
      ))}
    </span>
  );
}

/** New / Changed / Removed toggles for the whole selection. */
export function StatusChips({ statuses, onStatus }: { statuses: Array<ChangeStatus | undefined>; onStatus(status: ChangeStatus | null): void }) {
  return (
    <span className="group" aria-label="Change status">
      {CHANGE_STATUSES.map((st) => {
        const on = statuses.every((x) => x === st);
        return (
          <button
            key={st}
            className={`tool status-chip status-${st}${on ? " on" : ""}`}
            title={on ? `${STATUS_META[st].label}: click again to mark as existing` : `Mark as ${STATUS_META[st].label.toLowerCase()} — ${STATUS_META[st].hint.toLowerCase()}`}
            onClick={() => onStatus(on ? null : st)}
          >
            {STATUS_META[st].label}
          </button>
        );
      })}
    </span>
  );
}

/** Contextual toolbar for flowchart selections. */
export function SelectionBar(p: SelectionBarProps) {
  if (!p.nodes.length && !p.edges.length) return null;
  const single = p.nodes.length + p.edges.length === 1;
  const singleNode = single && p.nodes.length === 1 ? p.nodes[0] : undefined;
  const singleEdge = single && p.edges.length === 1 ? p.edges[0] : undefined;

  return (
    <FloatingBar allNodes={p.allNodes} nodes={p.nodes} edges={p.edges}>
      <MarkChips onMark={p.onMark} />
      <StatusChips statuses={[...p.nodes, ...p.edges].map((x) => x.data?.status)} onStatus={p.onStatus} />
      {singleNode && (
        <span className="group">
          {SHAPES.map(([shape, icon, label]) => (
            <button
              key={shape}
              className={`tool${singleNode.data.shape === shape ? " on" : ""}`}
              title={label}
              onClick={() => singleNode.data.shape !== shape && p.onShape(shape)}
            >
              {icon}
            </button>
          ))}
          <button className="tool" title="Rename (Enter)" onClick={p.onEdit}>
            ✎
          </button>
          <button className="tool wide" title="Add connected next step (Tab)" onClick={p.onAddNext}>
            + Next
          </button>
        </span>
      )}
      {singleEdge && (
        <span className="group">
          {p.decisionEdge &&
            ["Yes", "No"].map((l) => (
              <button key={l} className={`tool wide${singleEdge.data?.label === l ? " on" : ""}`} onClick={() => p.onEdgeLabel(l)}>
                {l}
              </button>
            ))}
          <button className="tool wide" title="Edit label (Enter)" onClick={p.onEdit}>
            ✎ Label
          </button>
        </span>
      )}
      <span className="group">
        <button className="tool danger" title="Delete (Del)" onClick={p.onDelete}>
          🗑
        </button>
      </span>
    </FloatingBar>
  );
}
