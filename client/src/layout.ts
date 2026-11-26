// Editor-only layout (layer C). Positions never leave the browser.

import dagre from "@dagrejs/dagre";
import type { Direction, GraphEdge, GraphNode, NodeShape } from "../../server/types.ts";

/** Node placement: position, plus the size the user gave it by resizing (if any). */
export interface XY {
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_SIZE: Record<NodeShape, Size> = {
  action: { width: 180, height: 56 },
  decision: { width: 170, height: 100 },
  terminal: { width: 160, height: 44 },
  store: { width: 150, height: 72 },
  state: { width: 160, height: 52 },
  initial: { width: 28, height: 28 },
  final: { width: 34, height: 34 },
  choice: { width: 44, height: 44 },
  any: { width: 112, height: 34 },
};

type SizeOf = (n: GraphNode) => Size;

export function dagreLayout(nodes: GraphNode[], edges: GraphEdge[], direction: Direction, sizeOf: SizeOf): Record<string, XY> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction === "LR" ? "LR" : "TB", nodesep: 50, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { ...sizeOf(n) }); // dagre mutates the label object
  // Labelled edges get room for their label plus the mark badge that can sit above the next node.
  for (const e of edges) g.setEdge(e.from, e.to, e.label ? { width: Math.min(e.label.length * 6.5, 240) + 16, height: 40 } : {});
  dagre.layout(g);
  const out: Record<string, XY> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    const s = sizeOf(n);
    out[n.id] = { x: p.x - s.width / 2, y: p.y - s.height / 2 };
  }
  return out;
}

/**
 * Assigns positions to nodes that do not have one yet, without moving any
 * existing node. New nodes are placed relative to an already-placed neighbour,
 * using the offset dagre would have used, then nudged to avoid overlaps.
 */
export function placeMissing(
  nodes: GraphNode[],
  edges: GraphEdge[],
  direction: Direction,
  positions: Record<string, XY>,
  sizeOf: SizeOf,
): Record<string, XY> {
  const missing = nodes.filter((n) => !positions[n.id]);
  if (!missing.length) return positions;
  const next = { ...positions };
  const laid = dagreLayout(nodes, edges, direction, sizeOf);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (missing.length === nodes.length) {
    return laid;
  }

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }

  const pending = new Set(missing.map((n) => n.id));
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const id of [...pending]) {
      const anchor = (neighbours.get(id) ?? []).find((nb) => next[nb] && !pending.has(nb));
      if (!anchor) continue;
      const p = { x: next[anchor].x + laid[id].x - laid[anchor].x, y: next[anchor].y + laid[id].y - laid[anchor].y };
      next[id] = avoidOverlap(p, sizeOf(byId.get(id)!), next, byId, sizeOf, direction);
      pending.delete(id);
      progress = true;
    }
  }

  if (pending.size) {
    // Disconnected new nodes: put them beside the existing drawing, keeping their relative layout.
    let maxX = -Infinity;
    let minY = Infinity;
    for (const [id, p] of Object.entries(next)) {
      const n = byId.get(id);
      if (!n) continue;
      maxX = Math.max(maxX, p.x + sizeOf(n).width);
      minY = Math.min(minY, p.y);
    }
    const group = [...pending];
    const gx = Math.min(...group.map((id) => laid[id].x));
    const gy = Math.min(...group.map((id) => laid[id].y));
    for (const id of group) {
      const p = { x: maxX + 80 + laid[id].x - gx, y: minY + laid[id].y - gy };
      next[id] = avoidOverlap(p, sizeOf(byId.get(id)!), next, byId, sizeOf, direction);
    }
  }
  return next;
}

function avoidOverlap(
  p: XY,
  size: Size,
  placed: Record<string, XY>,
  byId: Map<string, GraphNode>,
  sizeOf: SizeOf,
  direction: Direction,
): XY {
  const gap = 24;
  const hits = (q: XY) =>
    Object.entries(placed).some(([id, o]) => {
      const n = byId.get(id);
      if (!n) return false;
      const s = sizeOf(n);
      return q.x < o.x + s.width + gap && q.x + size.width + gap > o.x && q.y < o.y + s.height + gap && q.y + size.height + gap > o.y;
    });
  let q = { ...p };
  for (let i = 0; i < 60 && hits(q); i++) {
    q = direction === "TD" ? { x: q.x + 60, y: q.y } : { x: q.x, y: q.y + 50 };
  }
  return q;
}
