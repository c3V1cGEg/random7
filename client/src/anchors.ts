// Edge attachment points (editor-only geometry). An edge end sits on a side of its node's box at a
// fraction `t` along that side. Ends the user placed keep their anchor; the rest are spread out
// automatically so several arrows into one node never share a single point.

import type { Anchor, Direction, EdgeEnds, GraphEdge, NodeShape, Side } from "../../server/types.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An edge end as drawn: the anchor, and whether the user placed it. */
export interface EndAnchor extends Anchor {
  manual: boolean;
}

export const flowSides = (direction: Direction): { from: Side; to: Side } =>
  direction === "LR" ? { from: "right", to: "left" } : { from: "bottom", to: "top" };

/**
 * Anchors for every edge end. Automatic ends that share a node side are spread along it, ordered by
 * where the edge's other node lies so neighbouring arrows do not cross.
 */
export function resolveAnchors(
  edges: GraphEdge[],
  direction: Direction,
  manual: Record<string, EdgeEnds>,
  center: (nodeId: string) => { x: number; y: number } | undefined,
): Record<string, { from: EndAnchor; to: EndAnchor }> {
  const sides = flowSides(direction);
  const across = (id: string) => (direction === "LR" ? center(id)?.y : center(id)?.x) ?? 0;
  const groups = new Map<string, Array<{ edge: string; end: "from" | "to"; order: number }>>();
  const out: Record<string, { from: EndAnchor; to: EndAnchor }> = {};
  for (const e of edges) {
    const ends = {} as { from: EndAnchor; to: EndAnchor };
    for (const end of ["from", "to"] as const) {
      const placed = manual[e.id]?.[end];
      if (placed) ends[end] = { ...placed, manual: true };
      else {
        ends[end] = { side: sides[end], t: 0.5, manual: false };
        const key = `${end === "from" ? e.from : e.to}:${sides[end]}`;
        const other = end === "from" ? e.to : e.from;
        groups.set(key, [...(groups.get(key) ?? []), { edge: e.id, end, order: across(other) }]);
      }
    }
    out[e.id] = ends;
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.order - b.order);
    const step = Math.min(0.2, 0.8 / group.length);
    group.forEach((g, i) => (out[g.edge][g.end].t = 0.5 + (i - (group.length - 1) / 2) * step));
  }
  return out;
}

/** The point on the node's outline for an anchor (diamonds: where the line to the box point crosses the diamond). */
export function anchorPoint(r: Rect, shape: NodeShape | undefined, a: Anchor): { x: number; y: number } {
  const p =
    a.side === "top" ? { x: r.x + a.t * r.width, y: r.y }
    : a.side === "bottom" ? { x: r.x + a.t * r.width, y: r.y + r.height }
    : a.side === "left" ? { x: r.x, y: r.y + a.t * r.height }
    : { x: r.x + r.width, y: r.y + a.t * r.height };
  if (shape !== "decision") return p;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const k = 1 / (Math.abs(dx) / (r.width / 2) + Math.abs(dy) / (r.height / 2) || 1);
  return { x: cx + dx * k, y: cy + dy * k };
}

/** The anchor on `r` closest to a point (used when the user drops an edge end). */
export function nearestAnchor(r: Rect, p: { x: number; y: number }): Anchor {
  const clamp = (v: number) => Math.round(Math.min(0.95, Math.max(0.05, v)) * 1000) / 1000;
  const dist: Array<[Side, number]> = [
    ["top", Math.abs(p.y - r.y)],
    ["bottom", Math.abs(p.y - (r.y + r.height))],
    ["left", Math.abs(p.x - r.x)],
    ["right", Math.abs(p.x - (r.x + r.width))],
  ];
  const side = dist.sort((a, b) => a[1] - b[1])[0][0];
  const t = side === "top" || side === "bottom" ? (p.x - r.x) / r.width : (p.y - r.y) / r.height;
  return { side, t: clamp(t) };
}
