// Editing actions for sequence diagrams. Every action is an ordinary patch (same validation,
// undo and live sync as flowchart edits); ordering only changes through explicit moves.

import { useCallback, useMemo, type MutableRefObject } from "react";
import { SECTION_KEYWORD, findItem, type FragmentKind, type SeqArrow, type SeqItem, type Sequence } from "../../server/sequence.ts";
import type { BrowserState, Operation, PatchResponse } from "./api.ts";
import type { TypeAhead } from "./elements.tsx";
import { SEQ, positionAtX, type SequenceLayout } from "./sequenceLayout.ts";

type Position = NonNullable<Extract<Operation, { op: "move_item" }>["position"]>;

export const ARROW_LABELS: Record<SeqArrow, string> = {
  "->>": "→ request",
  "-->>": "⇢ reply",
  "-)": "→) async",
  "--)": "⇢) async reply",
  "-x": "→✕ fails",
  "--x": "⇢✕ fails (reply)",
  "->": "— plain",
  "-->": "┄ dotted",
};

export const FRAGMENT_DEFAULTS: Record<FragmentKind, { label: string; more?: string[]; hint: string }> = {
  alt: { label: "success", more: ["failure"], hint: "Alternatives (if / else): success vs failure, commit vs rollback" },
  opt: { label: "only if …", hint: "Optional: happens only under a condition" },
  loop: { label: "repeat …", hint: "Loop / retry" },
  par: { label: "branch 1", more: ["branch 2"], hint: "Concurrent branches: each selected item becomes its own branch" },
  critical: { label: "lock held", more: ["lock not available"], hint: "Critical section (lock / transaction) with its failure options" },
  break: { label: "on …", hint: "Break: stops the flow here (abort)" },
};

interface Deps {
  stateRef: MutableRefObject<BrowserState | null>;
  layoutRef: MutableRefObject<SequenceLayout | null>;
  send(ops: Operation[], group?: string): Promise<PatchResponse | undefined>;
  selectOnly(ids: string[]): void;
  setEditingId(id: string | null): void;
  pendingGroups: MutableRefObject<Map<string, string>>;
  typeAhead: MutableRefObject<TypeAhead | null>;
}

const seq = (d: Deps): Sequence | undefined => d.stateRef.current?.sequence;

/** Position one step earlier or later: into/out of neighbouring fragments, so repeated presses reach anywhere. */
export function neighbourPosition(s: Sequence, id: string, dir: "earlier" | "later"): Position | null {
  const loc = findItem(s, id);
  if (!loc) return null;
  if (dir === "later") {
    const next = loc.list[loc.index + 1];
    if (next) return next.type === "fragment" ? { in: next.id, section: 0, index: 0 } : { after: next.id };
    if (!loc.parent) return null;
    return loc.section! + 1 < loc.parent.sections.length ? { in: loc.parent.id, section: loc.section! + 1, index: 0 } : { after: loc.parent.id };
  }
  const prev = loc.list[loc.index - 1];
  if (prev) return prev.type === "fragment" ? { in: prev.id, section: prev.sections.length - 1 } : { before: prev.id };
  if (!loc.parent) return null;
  return loc.section! > 0 ? { in: loc.parent.id, section: loc.section! - 1 } : { before: loc.parent.id };
}

export function useSequence(d: Deps) {
  const { send, selectOnly, setEditingId, pendingGroups, typeAhead } = d;

  /** Creates something, then selects it and opens its editor; a follow-up rename joins the same undo step. */
  const create = useCallback(
    async (ops: Operation[], edit: (id: string) => string = (id) => id, group = crypto.randomUUID()) => {
      typeAhead.current = { text: "", then: null };
      const res = await send(ops, group);
      const id = res?.createdElementIds?.at(-1);
      if (!id) {
        typeAhead.current = null;
        return undefined;
      }
      pendingGroups.current.set(`seq:${id}`, group);
      selectOnly([id]);
      setEditingId(edit(id));
      return id;
    },
    [pendingGroups, selectOnly, send, setEditingId, typeAhead],
  );

  const addParticipant = useCallback(() => {
    const n = (seq(d)?.participants.length ?? 0) + 1;
    return create([{ op: "add_participant", label: `Participant ${n}` }]);
  }, [create, d]);

  /** New message; creates lanes first when there are fewer than two. */
  const addMessage = useCallback(
    async (opts: { from?: string; to?: string; position?: Position; arrow?: SeqArrow } = {}) => {
      const s = seq(d);
      if (!s) return;
      const group = crypto.randomUUID();
      const lanes = s.participants.map((p) => p.id);
      while (lanes.length < 2) {
        const res = await send([{ op: "add_participant", label: `Participant ${lanes.length + 1}` }], group);
        const id = res?.createdElementIds?.[0];
        if (!id) return;
        lanes.push(id);
      }
      const from = opts.from ?? lanes[0];
      const to = opts.to ?? lanes[(lanes.indexOf(from) + 1) % lanes.length];
      return create([{ op: "add_message", from, to, text: "New message", arrow: opts.arrow ?? "->>", ...(opts.position ? { position: opts.position } : {}) }], undefined, group);
    },
    [create, d, send],
  );

  /** Tab on a message: the natural next message (a reply goes back, anything else continues from the target). */
  const nextMessage = useCallback(
    (id: string) => {
      const s = seq(d);
      const item = s && findItem(s, id)?.item;
      setEditingId(null);
      if (!s || item?.type !== "message") return;
      const lanes = s.participants.map((p) => p.id);
      const to = item.from !== item.to ? item.from : lanes[(lanes.indexOf(item.to) + 1) % lanes.length];
      const reply = item.arrow === "->>" && to === item.from;
      void addMessage({ from: item.to, to, arrow: reply ? "-->>" : "->>", position: { after: id } });
    },
    [addMessage, d, setEditingId],
  );

  /** Message from the lane nearest to flow y, inserted where flow x falls on the timeline. */
  const messageAt = useCallback(
    (p: { x: number; y: number }, from?: string) => {
      const s = seq(d);
      const layout = d.layoutRef.current;
      if (!s || !layout || !s.participants.length) return void addMessage();
      const nearest = [...s.participants].sort((a, b) => Math.abs(layout.laneY[a.id] - p.y) - Math.abs(layout.laneY[b.id] - p.y))[0].id;
      const lanes = s.participants.map((x) => x.id);
      const src = from ?? nearest;
      const to = from ? nearest : lanes[lanes.indexOf(nearest) + 1] ?? lanes[lanes.indexOf(nearest) - 1] ?? nearest;
      const position = p.x < SEQ.timelineX ? { index: 0 } : positionAtX(layout, p.x);
      void addMessage({ from: src, to, position });
    },
    [addMessage, d],
  );

  const editSequence = useCallback(
    (id: string, text: string, section?: number) => {
      const s = seq(d);
      if (!s) return;
      if (s.participants.some((p) => p.id === id)) return void send([{ op: "update_participant", id, label: text }]);
      const item = findItem(s, id)?.item;
      if (item?.type === "message") void send([{ op: "update_message", id, text }]);
      else if (item?.type === "note") void send([{ op: "update_note", id, text }]);
      else if (item?.type === "fragment") {
        const labels = item.sections.map((x, i) => (i === (section ?? 0) ? text : x.label));
        void send([{ op: "update_fragment", id, labels }]);
      }
    },
    [d, send],
  );

  const moveItem = useCallback(
    (id: string, dir: "earlier" | "later") => {
      const s = seq(d);
      const position = s && neighbourPosition(s, id, dir);
      if (position) void send([{ op: "move_item", id, position }]);
    },
    [d, send],
  );

  const moveLane = useCallback(
    (id: string, dir: "up" | "down") => {
      const lanes = seq(d)?.participants.map((p) => p.id) ?? [];
      const i = lanes.indexOf(id);
      if (dir === "up" && i > 0) void send([{ op: "update_participant", id, before: lanes[i - 1] }]);
      if (dir === "down" && i >= 0 && i < lanes.length - 1) void send([{ op: "update_participant", id, before: lanes[i + 2] ?? null }]);
    },
    [d, send],
  );

  /** Wraps selected sibling items in a fragment; for par, each item becomes its own concurrent branch. */
  const wrap = useCallback(
    async (kind: FragmentKind, ids: string[]) => {
      const s = seq(d);
      if (!s || !ids.length) return;
      const ordered = ids
        .map((id) => findItem(s, id))
        .filter((l) => !!l)
        .sort((a, b) => a.index - b.index)
        .map((l) => l.item.id);
      const def = FRAGMENT_DEFAULTS[kind];
      const branches = kind === "par" ? Math.max(2, ordered.length) : 0;
      const labels = kind === "par" ? Array.from({ length: branches }, (_, i) => `branch ${i + 1}`) : [def.label, ...(def.more ?? [])];
      const group = crypto.randomUUID();
      const res = await send([{ op: "add_fragment", kind, label: labels[0], sections: labels.slice(1), wrap: ordered }], group);
      const id = res?.createdElementIds?.[0];
      if (!id) return;
      if (kind === "par" && ordered.length > 1) {
        await send(ordered.slice(1).map((item, i) => ({ op: "move_item" as const, id: item, position: { in: id, section: i + 1, index: 0 } })), group);
      }
      pendingGroups.current.set(`seq:${id}`, group);
      selectOnly([id]);
      setEditingId(`${id}::0`);
    },
    [d, pendingGroups, selectOnly, send, setEditingId],
  );

  const addSection = useCallback(
    (id: string) => {
      const item = seq(d) && findItem(seq(d)!, id)?.item;
      if (item?.type !== "fragment" || !SECTION_KEYWORD[item.kind]) return;
      const label = item.kind === "par" ? `branch ${item.sections.length + 1}` : SECTION_KEYWORD[item.kind]!;
      void send([{ op: "update_fragment", id, labels: [...item.sections.map((x) => x.label), label] }]).then(() => setEditingId(`${id}::${item.sections.length}`));
    },
    [d, send, setEditingId],
  );

  /** Remove operations for a selection: skips items inside selected fragments or on removed lanes. */
  const deleteOps = useCallback(
    (ids: string[]): Operation[] => {
      const s = seq(d);
      if (!s) return [];
      const lanes = new Set(ids.filter((id) => s.participants.some((p) => p.id === id)));
      const chosen = new Set(ids);
      const ops: Operation[] = [];
      for (const id of ids) {
        if (lanes.has(id)) continue;
        const loc = findItem(s, id);
        if (!loc) continue;
        if (insideSelected(s, id, chosen) || refersTo(loc.item, lanes)) continue;
        ops.push({ op: "remove_item", id });
      }
      return [...ops, ...[...lanes].map((id) => ({ op: "remove_participant" as const, id }))];
    },
    [d],
  );

  return useMemo(
    () => ({ addParticipant, addMessage, nextMessage, messageAt, editSequence, moveItem, moveLane, wrap, addSection, deleteOps }),
    [addMessage, addParticipant, addSection, deleteOps, editSequence, messageAt, moveItem, moveLane, nextMessage, wrap],
  );
}

function insideSelected(s: Sequence, id: string, chosen: Set<string>): boolean {
  let parent = findItem(s, id)?.parent;
  while (parent) {
    if (chosen.has(parent.id)) return true;
    parent = findItem(s, parent.id)?.parent;
  }
  return false;
}

function refersTo(item: SeqItem, lanes: Set<string>): boolean {
  if (item.type === "message") return lanes.has(item.from) || lanes.has(item.to);
  if (item.type === "note") return item.participants.some((p) => lanes.has(p));
  if (item.type === "activate" || item.type === "deactivate") return lanes.has(item.participant);
  return false;
}
