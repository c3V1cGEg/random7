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

/** How close (px) two boxes may come along the flow and still count as side by side. */
const SIDE_BY_SIDE = 16;

/**
 * The sides an automatic edge leaves and enters by. Along the flow by default (bottom → top when
 * top-down), but two boxes side by side across the flow (a row when top-down, a column when
 * left-right) are joined on their facing sides, so the arrow is a short straight line instead of a
 * loop under one box and over the other.
 */
export function autoSides(direction: Direction, from: Rect | undefined, to: Rect | undefined): { from: Side; to: Side } {
  const sides = flowSides(direction);
  if (!from || !to) return sides;
  const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(b0 - a1, a0 - b1);
  const vGap = gap(from.y, from.y + from.height, to.y, to.y + to.height);
  const hGap = gap(from.x, from.x + from.width, to.x, to.x + to.width);
  if (direction === "LR") {
    if (hGap >= SIDE_BY_SIDE || vGap <= 0) return sides;
    return to.y > from.y ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
  }
  if (vGap >= SIDE_BY_SIDE || hGap <= 0) return sides;
  return to.x > from.x ? { from: "right", to: "left" } : { from: "left", to: "right" };
}

/**
 * Anchors for every edge end. Automatic ends that share a node side are spread along it, ordered by
 * where the edge's other node lies so neighbouring arrows do not cross.
 */
export function resolveAnchors(
  edges: GraphEdge[],
  direction: Direction,
  manual: Record<string, EdgeEnds>,
  rect: (nodeId: string) => Rect | undefined,
): Record<string, { from: EndAnchor; to: EndAnchor }> {
  const groups = new Map<string, Array<{ edge: string; end: "from" | "to"; order: number }>>();
  const out: Record<string, { from: EndAnchor; to: EndAnchor }> = {};
  const center = (id: string) => {
    const r = rect(id);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: 0, y: 0 };
  };
  for (const e of edges) {
    const sides = autoSides(direction, rect(e.from), rect(e.to));
    const ends = {} as { from: EndAnchor; to: EndAnchor };
    for (const end of ["from", "to"] as const) {
      const placed = manual[e.id]?.[end];
      if (placed) ends[end] = { ...placed, manual: true };
      else {
        const side = sides[end];
        ends[end] = { side, t: 0.5, manual: false };
        const key = `${end === "from" ? e.from : e.to}:${side}`;
        const other = center(end === "from" ? e.to : e.from);
        groups.set(key, [...(groups.get(key) ?? []), { edge: e.id, end, order: side === "top" || side === "bottom" ? other.x : other.y }]);
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
  // Distance to each side as a segment, not as an endless line: a point just right of a flat box is
  // nearest its right side, though it is level with the bottom line too.
  const outX = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const outY = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  const dist: Array<[Side, number]> = [
    ["top", Math.hypot(outX, p.y - r.y)],
    ["bottom", Math.hypot(outX, p.y - (r.y + r.height))],
    ["left", Math.hypot(p.x - r.x, outY)],
    ["right", Math.hypot(p.x - (r.x + r.width), outY)],
  ];
  const side = dist.sort((a, b) => a[1] - b[1])[0][0];
  const t = side === "top" || side === "bottom" ? (p.x - r.x) / r.width : (p.y - r.y) / r.height;
  return { side, t: clamp(t) };
}
