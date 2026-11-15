// Turns a computed sequence layout into React Flow nodes (all positioned by the layout, none draggable).

import type { Node } from "@xyflow/react";
import { walkItems, type Sequence } from "../../server/sequence.ts";
import { SEQ, laneRange, layoutSequence, type SequenceLayout } from "./sequenceLayout.ts";

export const BACKDROP_ID = "__seq_backdrop";
/** Nodes that are decoration, not semantic elements (never selected, marked or deleted). */
export const isDecoration = (id: string) => id.startsWith("__");

const fixed = { draggable: false, connectable: false } as const;

export function buildSequenceNodes(
  seq: Sequence,
  marksOf: (id: string) => number[],
  prev: Map<string, Node>,
  select: Set<string> | null,
): { nodes: Node[]; layout: SequenceLayout } {
  const layout = layoutSequence(seq);
  const { laneY } = layout;
  const nodes: Node[] = [];
  const selected = (id: string) => (select ? select.has(id) : (prev.get(id)?.selected ?? false));
  // Keep React Flow's measurements: a node without them has no handle bounds until re-measured,
  // so a drag started on a lane handle right after an update would silently fail.
  const push = (n: Node) => {
    const before = prev.get(n.id);
    nodes.push({ ...fixed, ...n, selected: selected(n.id), ...(before?.measured && before.type === n.type ? { measured: before.measured } : {}) });
  };

  const ox = SEQ.headerWidth + 12;
  const oy = SEQ.axisY - 34;
  const width = Math.max(layout.width + 80, SEQ.timelineX + 240) - ox;
  nodes.push({
    id: BACKDROP_ID,
    type: "seqBackdrop",
    position: { x: ox, y: oy },
    width,
    height: layout.height - oy + 60,
    selectable: false,
    focusable: false,
    zIndex: -20,
    ...fixed,
    data: {
      width,
      axisY: SEQ.axisY - oy,
      lanes: seq.participants.map((p) => ({ id: p.id, y: laneY[p.id] - oy })),
      bars: layout.bars.map((b) => ({ y: laneY[b.participant] - oy, x0: b.x0 - ox, x1: b.x1 - ox })),
      ticks: layout.events.filter((e) => e.item.type === "message" || e.item.type === "note").map((e) => ({ x: e.x - ox, step: e.step })),
    },
  });

  for (const p of seq.participants) {
    push({
      id: p.id,
      type: "seqParticipant",
      position: { x: 0, y: laneY[p.id] - 24 },
      width: SEQ.headerWidth,
      height: 48,
      zIndex: 5,
      connectable: true,
      data: { participant: p, marks: marksOf(p.id) },
    });
  }

  const numbers = new Map<string, number>();
  if (seq.autonumber) {
    let k = 0;
    for (const { item } of walkItems(seq.items)) if (item.type === "message") numbers.set(item.id, ++k);
  }

  for (const e of layout.events) {
    const it = e.item;
    const branch = e.branch?.index;
    if (it.type === "message") {
      const w = SEQ.slot - 18;
      const [a, b] = [laneY[it.from], laneY[it.to]];
      const self = it.from === it.to;
      const top = self ? a - 28 : Math.min(a, b) - 14;
      const height = self ? 56 : Math.abs(b - a) + 28;
      push({
        id: it.id,
        type: "seqMessage",
        position: { x: e.x - w / 2, y: top },
        width: w,
        height,
        zIndex: 10,
        data: { message: it, fromY: a - top, toY: b - top, marks: marksOf(it.id), ...(numbers.has(it.id) ? { number: numbers.get(it.id) } : {}), ...(branch !== undefined ? { branch } : {}) },
      });
    } else if (it.type === "note") {
      const w = SEQ.slot - 26;
      const ys = it.participants.map((p) => laneY[p]);
      const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
      const [top, height] =
        it.placement === "over" ? [lo - 30, hi - lo + 60] : it.placement === "left of" ? [lo - 100, 66] : [lo + 34, 66];
      push({ id: it.id, type: "seqNote", position: { x: e.x - w / 2, y: top }, width: w, height, zIndex: 11, data: { note: it, marks: marksOf(it.id) } });
    } else if (it.type === "activate" || it.type === "deactivate") {
      push({
        id: it.id,
        type: "seqActivation",
        position: { x: e.x - 27, y: laneY[it.participant] - 12 },
        width: 54,
        height: 24,
        zIndex: 12,
        data: { activation: it, marks: marksOf(it.id) },
      });
    }
  }

  for (const f of layout.frames) {
    const [lo, hi] = laneRange(f.fragment, laneY);
    const inset = f.depth * SEQ.depthInset;
    const top = lo - SEQ.framePadY + inset;
    push({
      id: f.fragment.id,
      type: "seqFragment",
      position: { x: f.x0, y: top },
      width: f.x1 - f.x0,
      height: hi + SEQ.framePadY - inset - top,
      zIndex: -10 + f.depth,
      data: { fragment: f.fragment, sections: f.sections.map((s) => ({ x: s.x - f.x0, label: s.label })), marks: marksOf(f.fragment.id) },
    });
  }
  return { nodes, layout };
}
