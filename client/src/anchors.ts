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
  // Boxes on top of each other (one being dragged over the other): the flow's sides.
  if (vGap <= 0 && hGap <= 0) return sides;
  // Facing sides, all four possible: above or below joins top and bottom, beside joins left and right.
  // Diagonal places lean to the flow's axis (top-down: top and bottom) unless clearly more beside than
  // above; boxes in a row or a column always face each other.
  const vertical =
    direction === "LR"
      ? hGap <= 0 || (vGap >= SIDE_BY_SIDE && vGap > 2 * hGap)
      : vGap >= SIDE_BY_SIDE && (hGap <= 0 || 2 * vGap >= hGap);
  const cy = (r: Rect) => r.y + r.height / 2;
  const cx = (r: Rect) => r.x + r.width / 2;
  if (vertical) return cy(to) >= cy(from) ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
  return cx(to) >= cx(from) ? { from: "right", to: "left" } : { from: "left", to: "right" };
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

/**
 * Connect mode: where an arrow between a dragged box and the box it ran into attaches, on the sides
 * that touched first and at the middle of where they touched. `prev` is the dragged box one move
 * before it touched (null if it already lay on the other box when the drag began); `cur` is where it
 * touched. `from` is on the dragged box, `to` on the other.
 */
export function contactEnds(prev: Rect | null, cur: Rect, target: Rect): { from: Anchor; to: Anchor } {
  const t = (v: number) => Math.round(Math.min(0.95, Math.max(0.05, v)) * 1000) / 1000;
  const cx = (r: Rect) => r.x + r.width / 2;
  const cy = (r: Rect) => r.y + r.height / 2;
  let horizontal: boolean;
  const p = prev ?? cur;
  const gapX = Math.max(target.x - (p.x + p.width), p.x - (target.x + target.width));
  const gapY = Math.max(target.y - (p.y + p.height), p.y - (target.y + target.height));
  if (prev && (gapX > 0 || gapY > 0)) horizontal = gapX >= gapY; // the gap that closed last is the side that touched
  else horizontal = Math.abs(cx(cur) - cx(target)) / (cur.width + target.width) >= Math.abs(cy(cur) - cy(target)) / (cur.height + target.height);
  if (horizontal) {
    const lo = Math.max(cur.y, target.y), hi = Math.min(cur.y + cur.height, target.y + target.height);
    const mid = lo <= hi ? (lo + hi) / 2 : (cy(cur) + cy(target)) / 2;
    const leftOf = cx(cur) < cx(target);
    return {
      from: { side: leftOf ? "right" : "left", t: t((mid - cur.y) / cur.height) },
      to: { side: leftOf ? "left" : "right", t: t((mid - target.y) / target.height) },
    };
  }
  const lo = Math.max(cur.x, target.x), hi = Math.min(cur.x + cur.width, target.x + target.width);
  const mid = lo <= hi ? (lo + hi) / 2 : (cx(cur) + cx(target)) / 2;
  const above = cy(cur) < cy(target);
  return {
    from: { side: above ? "bottom" : "top", t: t((mid - cur.x) / cur.width) },
    to: { side: above ? "top" : "bottom", t: t((mid - target.x) / target.width) },
  };
}
