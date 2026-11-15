// Semantics of the sequence-diagram patch operations. Like the flowchart operations they run
// against a draft model, so a patch either applies completely or not at all.

import { validateId } from "./mermaid.ts";
import type { Operation, Position } from "./ops.ts";
import {
  SECTION_KEYWORD,
  allIds,
  findItem,
  normalizeText,
  walkItems,
  type FragmentKind,
  type SeqFragment,
  type SeqItem,
  type SeqParticipant,
  type Sequence,
} from "./sequence.ts";
import { CanvasError, type ChangeOp, type ChangeStatus } from "./types.ts";

export interface SeqContext {
  sequence: Sequence;
  /** Every id used in this session; generated ids never reuse them. */
  usedIds: Set<string>;
  seqCounters: Record<string, number>;
}

export interface Created {
  elements: string[];
}

type SeqOp = Extract<
  Operation,
  {
    op:
      | "add_participant"
      | "update_participant"
      | "remove_participant"
      | "add_message"
      | "update_message"
      | "add_note"
      | "update_note"
      | "add_activation"
      | "add_fragment"
      | "update_fragment"
      | "remove_item"
      | "move_item";
  }
>;

export const SEQUENCE_OPS = new Set<string>([
  "add_participant",
  "update_participant",
  "remove_participant",
  "add_message",
  "update_message",
  "add_note",
  "update_note",
  "add_activation",
  "add_fragment",
  "update_fragment",
  "remove_item",
  "move_item",
]);

export function allocSeqId(ctx: SeqContext, prefix: string, taken?: Set<string>): string {
  const existing = new Set(allIds(ctx.sequence));
  for (;;) {
    ctx.seqCounters[prefix] = (ctx.seqCounters[prefix] ?? 0) + 1;
    const id = `${prefix}${ctx.seqCounters[prefix]}`;
    if (!ctx.usedIds.has(id) && !existing.has(id) && !taken?.has(id)) return id;
  }
}

export function applySequenceOp(ctx: SeqContext, op: SeqOp, log: ChangeOp[], sideEffects: ChangeOp[], created: Created): void {
  const seq = ctx.sequence;
  switch (op.op) {
    case "add_participant": {
      const id = op.id ?? allocSeqId(ctx, "p");
      claim(ctx, id, "participant");
      const p: SeqParticipant = { id, label: participantLabel(op.label, id), kind: op.kind ?? "participant" };
      if (op.status) p.status = op.status;
      const at = op.before !== undefined ? participantIndex(seq, op.before) : seq.participants.length;
      seq.participants.splice(at, 0, p);
      created.elements.push(id);
      log.push({ op: "add_participant", ...p, ...(op.before ? { before: op.before } : {}) });
      return;
    }
    case "update_participant": {
      const index = participantIndex(seq, op.id);
      const p = { ...seq.participants[index] };
      const entry: ChangeOp = { op: "update_participant", id: op.id };
      if (op.label !== undefined) p.label = entry.label = participantLabel(op.label, op.id);
      if (op.kind !== undefined) p.kind = entry.kind = op.kind;
      if (op.status !== undefined) setStatus(p, entry, op.status);
      seq.participants[index] = p;
      if (op.before !== undefined) {
        if (op.before === op.id) throw new CanvasError("invalid_patch", "a participant cannot move before itself");
        seq.participants.splice(index, 1);
        const at = op.before === null ? seq.participants.length : participantIndex(seq, op.before);
        seq.participants.splice(at, 0, p);
        entry.before = op.before;
      }
      log.push(entry);
      return;
    }
    case "remove_participant": {
      const index = participantIndex(seq, op.id);
      // Everything that refers to the lane goes with it (like edges of a removed flowchart node).
      for (const loc of [...walkItems(seq.items)].reverse()) {
        const it = loc.item;
        const refers =
          (it.type === "message" && (it.from === op.id || it.to === op.id)) ||
          (it.type === "note" && it.participants.includes(op.id)) ||
          ((it.type === "activate" || it.type === "deactivate") && it.participant === op.id);
        if (!refers) continue;
        loc.list.splice(loc.index, 1);
        const fx = { op: "remove_item", id: it.id, reason: `refers to removed participant ${op.id}` };
        log.push(fx);
        sideEffects.push(fx);
      }
      seq.participants.splice(index, 1);
      log.push({ op: "remove_participant", id: op.id });
      return;
    }
    case "add_message": {
      const id = op.id ?? allocSeqId(ctx, "m");
      claim(ctx, id, "message");
      const msg: SeqItem = {
        type: "message",
        id,
        from: requireParticipant(seq, op.from),
        to: requireParticipant(seq, op.to),
        arrow: op.arrow ?? "->>",
        text: normalizeText(op.text),
      };
      if (op.activate) msg.activate = true;
      if (op.deactivate) msg.deactivate = true;
      if (op.status) msg.status = op.status;
      checkActivationFlags(msg);
      insert(seq, msg, op.position);
      created.elements.push(id);
      log.push({ op: "add_message", ...msg, ...locationOf(seq, id) });
      return;
    }
    case "update_message": {
      const loc = requireItem(seq, op.id, "message");
      const msg = { ...loc.item } as Extract<SeqItem, { type: "message" }>;
      const entry: ChangeOp = { op: "update_message", id: op.id };
      if (op.from !== undefined) msg.from = entry.from = requireParticipant(seq, op.from);
      if (op.to !== undefined) msg.to = entry.to = requireParticipant(seq, op.to);
      if (op.text !== undefined) msg.text = entry.text = normalizeText(op.text);
      if (op.arrow !== undefined) msg.arrow = entry.arrow = op.arrow;
      if (op.activate !== undefined) flag(msg, "activate", op.activate, entry);
      if (op.deactivate !== undefined) flag(msg, "deactivate", op.deactivate, entry);
      if (op.status !== undefined) setStatus(msg, entry, op.status);
      checkActivationFlags(msg);
      loc.list[loc.index] = msg;
      log.push(entry);
      return;
    }
    case "add_note": {
      const id = op.id ?? allocSeqId(ctx, "t");
      claim(ctx, id, "note");
      const placement = op.placement ?? "over";
      const note: SeqItem = { type: "note", id, placement, participants: noteParticipants(seq, op.participants, placement), text: normalizeText(op.text) };
      if (op.status) note.status = op.status;
      insert(seq, note, op.position);
      created.elements.push(id);
      log.push({ op: "add_note", ...note, ...locationOf(seq, id) });
      return;
    }
    case "update_note": {
      const loc = requireItem(seq, op.id, "note");
      const note = { ...loc.item } as Extract<SeqItem, { type: "note" }>;
      const entry: ChangeOp = { op: "update_note", id: op.id };
      if (op.placement !== undefined) note.placement = entry.placement = op.placement;
      if (op.participants !== undefined) note.participants = entry.participants = op.participants;
      note.participants = noteParticipants(seq, note.participants, note.placement);
      if (op.text !== undefined) note.text = entry.text = normalizeText(op.text);
      if (op.status !== undefined) setStatus(note, entry, op.status);
      loc.list[loc.index] = note;
      log.push(entry);
      return;
    }
    case "add_activation": {
      const id = op.id ?? allocSeqId(ctx, "a");
      claim(ctx, id, "activation");
      const item: SeqItem = { type: op.action, id, participant: requireParticipant(seq, op.participant) };
      if (op.status) item.status = op.status;
      insert(seq, item, op.position);
      created.elements.push(id);
      log.push({ op: "add_activation", ...item, ...locationOf(seq, id) });
      return;
    }
    case "add_fragment": {
      const id = op.id ?? allocSeqId(ctx, "f");
      claim(ctx, id, "fragment");
      const labels = [op.label ?? "", ...(op.sections ?? [])].map((l) => normalizeText(l, false));
      checkSectionCount(op.kind, labels.length);
      const frag: SeqFragment = { type: "fragment", id, kind: op.kind, sections: labels.map((label) => ({ label, items: [] })) };
      if (op.status) frag.status = op.status;
      const position = op.position;
      if (op.wrap?.length) {
        const locs = op.wrap.map((w) => {
          const loc = findItem(seq, w);
          if (!loc) throw new CanvasError("not_found", `item ${w} does not exist`, { id: w });
          return loc;
        });
        const list = locs[0].list;
        if (locs.some((l) => l.list !== list)) throw new CanvasError("invalid_patch", "wrap: items must be siblings (same fragment section)");
        const indices = locs.map((l) => l.index).sort((a, b) => a - b);
        if (indices.some((v, i) => i > 0 && v !== indices[i - 1] + 1)) {
          throw new CanvasError("invalid_patch", "wrap: items must be consecutive; move the others out first");
        }
        frag.sections[0].items = list.splice(indices[0], indices.length);
        if (position) insert(seq, frag, position);
        else list.splice(indices[0], 0, frag);
      } else insert(seq, frag, position);
      created.elements.push(id);
      log.push({
        op: "add_fragment",
        id,
        kind: frag.kind,
        labels,
        ...(op.wrap?.length ? { wrap: op.wrap } : {}),
        ...(frag.status ? { status: frag.status } : {}),
        ...locationOf(seq, id),
      });
      return;
    }
    case "update_fragment": {
      const loc = requireItem(seq, op.id, "fragment");
      const frag = { ...(loc.item as SeqFragment) };
      frag.sections = [...frag.sections];
      const entry: ChangeOp = { op: "update_fragment", id: op.id };
      if (op.labels !== undefined) {
        const labels = op.labels.map((l) => normalizeText(l, false));
        frag.sections = resizeSections(frag, labels.length);
        frag.sections = frag.sections.map((s, i) => ({ ...s, label: labels[i] }));
        entry.labels = labels;
      }
      if (op.kind !== undefined) {
        frag.kind = entry.kind = op.kind;
        if (!SECTION_KEYWORD[op.kind] && frag.sections.length > 1) frag.sections = resizeSections(frag, 1);
      }
      checkSectionCount(frag.kind, frag.sections.length);
      if (op.status !== undefined) setStatus(frag, entry, op.status);
      loc.list[loc.index] = frag;
      log.push(entry);
      return;
    }
    case "remove_item": {
      const loc = findItem(seq, op.id);
      if (!loc) throw new CanvasError("not_found", `item ${op.id} does not exist`, { id: op.id });
      const contents = loc.item.type === "fragment" && op.keepContents ? loc.item.sections.flatMap((s) => s.items) : [];
      loc.list.splice(loc.index, 1, ...contents);
      log.push({ op: "remove_item", id: op.id, ...(op.keepContents && loc.item.type === "fragment" ? { keepContents: true } : {}) });
      return;
    }
    case "move_item": {
      const loc = findItem(seq, op.id);
      if (!loc) throw new CanvasError("not_found", `item ${op.id} does not exist`, { id: op.id });
      const anchor = op.position.after ?? op.position.before ?? op.position.in;
      if (anchor !== undefined && loc.item.type === "fragment") {
        const inside = new Set([op.id, ...[...walkItems(loc.item.sections.flatMap((s) => s.items))].map((l) => l.item.id)]);
        if (inside.has(anchor)) throw new CanvasError("invalid_patch", `cannot move fragment ${op.id} into itself`);
      } else if (anchor === op.id) {
        throw new CanvasError("invalid_patch", `cannot position ${op.id} relative to itself`);
      }
      loc.list.splice(loc.index, 1);
      insert(seq, loc.item, op.position);
      log.push({ op: "move_item", id: op.id, ...locationOf(seq, op.id) });
      return;
    }
  }
}

/** accept_changes for sequences: drop everything marked removed, clear all statuses. */
export function acceptSequenceChanges(ctx: SeqContext, log: ChangeOp[], sideEffects: ChangeOp[], created: Created) {
  const seq = ctx.sequence;
  for (const loc of [...walkItems(seq.items)].reverse()) {
    if (loc.item.status === "removed" && findItem(seq, loc.item.id)) applySequenceOp(ctx, { op: "remove_item", id: loc.item.id }, log, sideEffects, created);
  }
  for (const p of [...seq.participants]) {
    if (p.status === "removed") applySequenceOp(ctx, { op: "remove_participant", id: p.id }, log, sideEffects, created);
  }
  for (const p of seq.participants) if (p.status) applySequenceOp(ctx, { op: "update_participant", id: p.id, status: null }, log, sideEffects, created);
  for (const { item } of [...walkItems(seq.items)]) {
    if (!item.status) continue;
    const loc = findItem(seq, item.id)!;
    const next = { ...loc.item };
    delete next.status;
    loc.list[loc.index] = next;
    log.push({ op: `update_${item.type === "activate" || item.type === "deactivate" ? "activation" : item.type}`, id: item.id, status: null });
  }
}

/** Where an item sits, for change-log entries: `{after}` its previous sibling or `{in, section}`. */
export function locationOf(seq: Sequence, id: string): Record<string, unknown> {
  const loc = findItem(seq, id);
  if (!loc) return {};
  if (loc.index > 0) return { after: loc.list[loc.index - 1].id };
  if (loc.parent) return { in: loc.parent.id, section: loc.section };
  return { at: "start" };
}

// --- helpers --------------------------------------------------------------------------

function insert(seq: Sequence, item: SeqItem, pos?: Position) {
  const { list, index } = resolvePosition(seq, pos);
  list.splice(index, 0, item);
}

function resolvePosition(seq: Sequence, pos?: Position): { list: SeqItem[]; index: number } {
  if (!pos) return { list: seq.items, index: seq.items.length };
  const anchors = [pos.after, pos.before, pos.in].filter((x) => x !== undefined);
  if (anchors.length > 1) throw new CanvasError("invalid_position", "position: give only one of after, before, in");
  if (pos.after !== undefined || pos.before !== undefined) {
    const anchor = (pos.after ?? pos.before)!;
    const loc = findItem(seq, anchor);
    if (!loc) throw new CanvasError("not_found", `position: item ${anchor} does not exist`, { id: anchor });
    return { list: loc.list, index: loc.index + (pos.after !== undefined ? 1 : 0) };
  }
  let list = seq.items;
  if (pos.in !== undefined) {
    const loc = findItem(seq, pos.in);
    if (!loc || loc.item.type !== "fragment") throw new CanvasError("not_found", `position: fragment ${pos.in} does not exist`, { id: pos.in });
    const section = pos.section ?? loc.item.sections.length - 1;
    if (section >= loc.item.sections.length) {
      throw new CanvasError("invalid_position", `position: fragment ${pos.in} has ${loc.item.sections.length} section(s)`);
    }
    list = loc.item.sections[section].items;
  }
  return { list, index: Math.min(pos.index ?? list.length, list.length) };
}

function claim(ctx: SeqContext, id: string, what: string) {
  validateId(id, what);
  if (allIds(ctx.sequence).includes(id)) throw new CanvasError("duplicate_id", `id ${id} is already used`, { id });
  ctx.usedIds.add(id);
}

function participantIndex(seq: Sequence, id: string): number {
  const i = seq.participants.findIndex((p) => p.id === id);
  if (i < 0) throw new CanvasError("not_found", `participant ${id} does not exist`, { id });
  return i;
}

function requireParticipant(seq: Sequence, id: string): string {
  participantIndex(seq, id);
  return id;
}

function requireItem(seq: Sequence, id: string, type: SeqItem["type"]) {
  const loc = findItem(seq, id);
  if (!loc) throw new CanvasError("not_found", `${type} ${id} does not exist`, { id });
  if (loc.item.type !== type) throw new CanvasError("wrong_type", `${id} is a ${loc.item.type}, not a ${type}`, { id });
  return loc;
}

function participantLabel(label: string | undefined, id: string) {
  return normalizeText(label ?? "", false) || id;
}

function noteParticipants(seq: Sequence, ids: string[], placement: string): string[] {
  ids.forEach((id) => requireParticipant(seq, id));
  if (ids.length > 1 && placement !== "over") throw new CanvasError("invalid_patch", `only "over" notes can span two participants`);
  return ids.length === 2 && ids[0] === ids[1] ? [ids[0]] : ids;
}

function checkSectionCount(kind: FragmentKind, n: number) {
  if (!SECTION_KEYWORD[kind] && n > 1) throw new CanvasError("invalid_patch", `${kind} has a single section; use alt, par or critical for several`);
}

/** Grows with empty sections, or shrinks when the dropped sections are empty. */
function resizeSections(frag: SeqFragment, n: number) {
  const sections = [...frag.sections];
  while (sections.length < n) sections.push({ label: "", items: [] });
  const dropped = sections.slice(n);
  if (dropped.some((s) => s.items.length)) {
    throw new CanvasError("invalid_patch", `fragment ${frag.id}: move or remove the items of the sections being removed first`);
  }
  return sections.slice(0, n);
}

function checkActivationFlags(msg: { activate?: boolean; deactivate?: boolean }) {
  if (msg.activate && msg.deactivate) {
    throw new CanvasError("invalid_patch", "a message can either activate its target (+) or end its sender's activation (-), not both");
  }
}

function flag<T extends { activate?: boolean; deactivate?: boolean }>(target: T, key: "activate" | "deactivate", on: boolean, entry: ChangeOp) {
  if (on) target[key] = true;
  else delete target[key];
  entry[key] = on;
}

function setStatus(target: { status?: ChangeStatus }, entry: ChangeOp, status: ChangeStatus | null) {
  if (status) target.status = status;
  else delete target.status;
  entry.status = status;
}
