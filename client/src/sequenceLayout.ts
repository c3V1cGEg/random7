// Left-to-right logical timeline for sequence diagrams (editor-only geometry, computed, never stored).
//
// - Each participant is a horizontal lane; lanes are stacked in declaration order.
// - Each message/note takes one slot and one logical step. Steps are ordering positions, not time.
// - alt/opt/loop/critical/break: sections are laid out one after another, and every
//   alternative restarts at the same step number (they are alternatives, not a sequence).
// - par: branches share the same steps. Units (top-level items of a branch) that start at the same
//   step are placed side by side in one band, so concurrent work lines up instead of being serialized.
// The layout depends only on the semantic model, so unchanged semantics never move.

import type { SeqFragment, SeqItem, Sequence } from "../../server/sequence.ts";

export const SEQ = {
  laneGap: 124,
  headerWidth: 150,
  timelineX: 200,
  slot: 168,
  activationSlot: 64,
  fragmentPad: 22,
  sectionGap: 26,
  emptySection: 90,
  axisY: -96,
  depthInset: 12,
  framePadY: 56,
} as const;

export interface PlacedEvent {
  item: SeqItem;
  /** Centre x of the item's slot. */
  x: number;
  /** Logical step (1-based); activation statements carry the step of the next event. */
  step: number;
  /** Concurrent branch (par fragment id + branch index) the item belongs to, innermost first. */
  branch?: { par: string; index: number };
}

export interface PlacedFrame {
  fragment: SeqFragment;
  x0: number;
  x1: number;
  depth: number;
  /** Start x of each section (sequential kinds) or null for par branches (they overlap). */
  sections: Array<{ x: number; label: string }>;
}

export interface SequenceLayout {
  laneY: Record<string, number>;
  events: PlacedEvent[];
  frames: PlacedFrame[];
  bars: Array<{ participant: string; x0: number; x1: number }>;
  width: number;
  height: number;
  lastStep: number;
}

interface Measure {
  width: number;
  steps: number;
}

function measureItem(item: SeqItem): Measure {
  switch (item.type) {
    case "message":
    case "note":
      return { width: SEQ.slot, steps: 1 };
    case "activate":
    case "deactivate":
      return { width: SEQ.activationSlot, steps: 0 };
    case "fragment":
      return item.kind === "par" ? measurePar(item) : measureSequential(item);
  }
}

function measureList(items: SeqItem[]): Measure {
  let width = 0;
  let steps = 0;
  for (const it of items) {
    const m = measureItem(it);
    width += m.width;
    steps += m.steps;
  }
  return { width, steps };
}

function measureSequential(f: SeqFragment): Measure {
  const parts = f.sections.map((s) => measureList(s.items));
  return {
    width: 2 * SEQ.fragmentPad + parts.reduce((w, p) => w + Math.max(p.width, SEQ.emptySection), 0) + (parts.length - 1) * SEQ.sectionGap,
    steps: Math.max(0, ...parts.map((p) => p.steps)),
  };
}

/** Units of all branches grouped by the step at which they start (relative to the fragment). */
function parBands(f: SeqFragment) {
  const bands = new Map<number, Array<{ item: SeqItem; branch: number; m: Measure }>>();
  let steps = 0;
  f.sections.forEach((s, branch) => {
    let at = 0;
    for (const item of s.items) {
      const m = measureItem(item);
      const band = bands.get(at) ?? [];
      band.push({ item, branch, m });
      bands.set(at, band);
      at += m.steps;
    }
    steps = Math.max(steps, at);
  });
  return { bands: [...bands.entries()].sort((a, b) => a[0] - b[0]), steps };
}

function measurePar(f: SeqFragment): Measure {
  const { bands, steps } = parBands(f);
  const inner = bands.reduce((w, [, units]) => w + units.reduce((u, x) => u + x.m.width, 0), 0);
  return { width: 2 * SEQ.fragmentPad + Math.max(inner, SEQ.emptySection), steps };
}

export function layoutSequence(seq: Sequence): SequenceLayout {
  const laneY: Record<string, number> = {};
  seq.participants.forEach((p, i) => (laneY[p.id] = i * SEQ.laneGap));
  const events: PlacedEvent[] = [];
  const frames: PlacedFrame[] = [];

  const placeItem = (item: SeqItem, x: number, step: number, depth: number, branch?: PlacedEvent["branch"]) => {
    const m = measureItem(item);
    if (item.type !== "fragment") {
      events.push({ item, x: x + m.width / 2, step, ...(branch ? { branch } : {}) });
      return m;
    }
    const frame: PlacedFrame = { fragment: item, x0: x, x1: x + m.width, depth, sections: [] };
    frames.push(frame);
    if (item.kind === "par") {
      const { bands } = parBands(item);
      let cx = x + SEQ.fragmentPad;
      for (const [offset, units] of bands) {
        for (const u of units) {
          placeItem(u.item, cx, step + offset, depth + 1, { par: item.id, index: u.branch });
          cx += u.m.width;
        }
      }
      frame.sections = item.sections.map((s) => ({ x: x, label: s.label }));
    } else {
      let cx = x + SEQ.fragmentPad;
      item.sections.forEach((s, i) => {
        frame.sections.push({ x: i === 0 ? x : cx - SEQ.sectionGap / 2, label: s.label });
        const w = placeList(s.items, cx, step, depth + 1, branch);
        cx += Math.max(w, SEQ.emptySection) + SEQ.sectionGap;
      });
    }
    return m;
  };

  const placeList = (items: SeqItem[], x: number, step: number, depth: number, branch?: PlacedEvent["branch"]) => {
    let cx = x;
    let s = step;
    for (const it of items) {
      const m = placeItem(it, cx, s, depth, branch);
      cx += m.width;
      s += m.steps;
    }
    return cx - x;
  };

  const width = placeList(seq.items, SEQ.timelineX, 1, 0);
  return {
    laneY,
    events,
    frames,
    bars: activationBars(seq, events, SEQ.timelineX + width),
    width: SEQ.timelineX + width,
    height: Math.max(0, seq.participants.length - 1) * SEQ.laneGap,
    lastStep: Math.max(0, ...events.map((e) => (e.item.type === "message" || e.item.type === "note" ? e.step : 0))),
  };
}

/**
 * Activation spans per participant, paired in source order (as Mermaid does). An activation
 * that is never closed runs to the end of the timeline.
 */
function activationBars(seq: Sequence, events: PlacedEvent[], end: number) {
  const x = new Map(events.map((e) => [e.item.id, e.x]));
  const open = new Map<string, number[]>();
  const bars: SequenceLayout["bars"] = [];
  const start = (p: string, at: number) => open.set(p, [...(open.get(p) ?? []), at]);
  const stop = (p: string, at: number) => {
    const stack = open.get(p);
    const from = stack?.pop();
    if (from !== undefined) bars.push({ participant: p, x0: Math.min(from, at), x1: Math.max(from, at) });
  };
  const walk = (items: SeqItem[]) => {
    for (const it of items) {
      const at = x.get(it.id) ?? 0;
      if (it.type === "activate") start(it.participant, at);
      else if (it.type === "deactivate") stop(it.participant, at);
      else if (it.type === "message") {
        if (it.deactivate) stop(it.from, at);
        if (it.activate) start(it.to, at);
      } else if (it.type === "fragment") it.sections.forEach((s) => walk(s.items));
    }
  };
  walk(seq.items);
  for (const [p, stack] of open) for (const from of stack) bars.push({ participant: p, x0: from, x1: end });
  return bars;
}

/** Lane index range an item spans (a fragment: everything inside; empty: the first lane). */
export function laneRange(item: SeqItem, laneY: Record<string, number>): [number, number] {
  const ys = participantsOf(item)
    .map((p) => laneY[p])
    .filter((y) => y !== undefined);
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 0];
}

function participantsOf(item: SeqItem): string[] {
  switch (item.type) {
    case "message":
      return [item.from, item.to];
    case "note":
      return item.participants;
    case "activate":
    case "deactivate":
      return [item.participant];
    case "fragment":
      return item.sections.flatMap((s) => s.items.flatMap(participantsOf));
  }
}

/**
 * Where a new item dropped at flow x belongs: after the last item (at any depth) whose slot
 * centre lies left of x, so it lands in that item's list (inside a fragment section if it is one).
 */
export function positionAtX(layout: SequenceLayout, x: number): { after: string } | { index: number } {
  let best: PlacedEvent | undefined;
  for (const e of layout.events) if (e.x < x && (!best || e.x > best.x)) best = e;
  return best ? { after: best.item.id } : { index: 0 };
}
