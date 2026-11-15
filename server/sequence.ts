// Sequence diagrams: the semantic model, its Mermaid `sequenceDiagram` subset, and tree helpers.
// Mermaid has no ids for messages, notes or fragments, so each one is preceded by an
// `%%@<id> [status]` comment line: still valid Mermaid, and stable across edits.

import { validateId } from "./mermaid.ts";
import { CHANGE_STATUSES, CanvasError, LIMITS, type ChangeStatus } from "./types.ts";

export const SEQ_ARROWS = ["->>", "-->>", "->", "-->", "-x", "--x", "-)", "--)"] as const;
export type SeqArrow = (typeof SEQ_ARROWS)[number];
export const FRAGMENT_KINDS = ["alt", "opt", "loop", "par", "critical", "break"] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];
export const NOTE_PLACEMENTS = ["over", "left of", "right of"] as const;
export type NotePlacement = (typeof NOTE_PLACEMENTS)[number];

/** Keyword that starts each further section of a fragment (null: the kind has one section). */
export const SECTION_KEYWORD: Record<FragmentKind, string | null> = {
  alt: "else",
  par: "and",
  critical: "option",
  opt: null,
  loop: null,
  break: null,
};

export interface SeqParticipant {
  id: string;
  label: string;
  kind: "participant" | "actor";
  status?: ChangeStatus;
}

export interface SeqMessage {
  type: "message";
  id: string;
  from: string;
  to: string;
  arrow: SeqArrow;
  text: string;
  /** `A->>+B`: the message activates its target. */
  activate?: boolean;
  /** `B-->>-A`: the message ends its sender's activation. */
  deactivate?: boolean;
  status?: ChangeStatus;
}

export interface SeqNote {
  type: "note";
  id: string;
  placement: NotePlacement;
  /** One participant, or two for `over A,B`. */
  participants: string[];
  text: string;
  status?: ChangeStatus;
}

export interface SeqActivation {
  type: "activate" | "deactivate";
  id: string;
  participant: string;
  status?: ChangeStatus;
}

export interface SeqSection {
  label: string;
  items: SeqItem[];
}

export interface SeqFragment {
  type: "fragment";
  id: string;
  kind: FragmentKind;
  sections: SeqSection[];
  status?: ChangeStatus;
}

export type SeqItem = SeqMessage | SeqNote | SeqActivation | SeqFragment;

export interface Sequence {
  participants: SeqParticipant[];
  items: SeqItem[];
  autonumber?: boolean;
}

export const emptySequence = (): Sequence => ({ participants: [], items: [] });

/** Id prefix for generated ids of each item type. */
export const ID_PREFIX = { message: "m", note: "t", fragment: "f", activate: "a", deactivate: "a", participant: "p" } as const;

// --- tree helpers --------------------------------------------------------------

export interface ItemLocation {
  item: SeqItem;
  list: SeqItem[];
  index: number;
  /** Enclosing fragment and section index (undefined at top level). */
  parent?: SeqFragment;
  section?: number;
}

export function* walkItems(items: SeqItem[], parent?: SeqFragment, section?: number): Generator<ItemLocation> {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    yield { item, list: items, index, parent, section };
    if (item.type === "fragment") {
      for (let s = 0; s < item.sections.length; s++) yield* walkItems(item.sections[s].items, item, s);
    }
  }
}

export function findItem(seq: Sequence, id: string): ItemLocation | undefined {
  for (const loc of walkItems(seq.items)) if (loc.item.id === id) return loc;
  return undefined;
}

export function allIds(seq: Sequence): string[] {
  return [...seq.participants.map((p) => p.id), ...[...walkItems(seq.items)].map((l) => l.item.id)];
}

/** Participants an item refers to (a fragment: everything inside it). */
export function itemParticipants(item: SeqItem): string[] {
  switch (item.type) {
    case "message":
      return [item.from, item.to];
    case "note":
      return item.participants;
    case "activate":
    case "deactivate":
      return [item.participant];
    case "fragment":
      return item.sections.flatMap((s) => s.items.flatMap(itemParticipants));
  }
}

export function countItems(seq: Sequence): number {
  return [...walkItems(seq.items)].length;
}

// --- text escaping ----------------------------------------------------------------

/** Mermaid sequence text: `#` and `;` as entity codes, line breaks as `<br>`. */
export function encodeText(text: string): string {
  return text.replace(/#/g, "#35;").replace(/;/g, "#59;").replace(/\n/g, "<br>");
}

export function decodeText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#59;/g, ";")
    .replace(/#quot;/g, '"')
    .replace(/#35;/g, "#");
}

/** Message/note text: trimmed lines, at most LIMITS.labelLines of them. */
export function normalizeText(text: string, multiline = true): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = multiline ? lines.join("\n") : lines.join(" ");
  if (lines.length > LIMITS.labelLines) throw new CanvasError("too_large", `text has at most ${LIMITS.labelLines} lines`);
  if (out.length > LIMITS.labelLength) throw new CanvasError("too_large", `text exceeds ${LIMITS.labelLength} characters`);
  return out;
}

// --- serialize ----------------------------------------------------------------------

export function sequenceToMermaid(seq: Sequence): string {
  const lines = ["sequenceDiagram"];
  if (seq.autonumber) lines.push("    autonumber");
  for (const p of seq.participants) {
    if (p.status) lines.push(`    %%@${p.id} ${p.status}`);
    lines.push(`    ${p.kind} ${p.id}${p.label !== p.id ? ` as ${encodeText(p.label)}` : ""}`);
  }
  const emit = (items: SeqItem[], depth: number) => {
    const pad = "    ".repeat(depth);
    for (const item of items) {
      lines.push(`${pad}%%@${item.id}${item.status ? ` ${item.status}` : ""}`);
      switch (item.type) {
        case "message":
          lines.push(`${pad}${item.from}${item.arrow}${item.activate ? "+" : item.deactivate ? "-" : ""}${item.to}: ${encodeText(item.text)}`);
          break;
        case "note":
          lines.push(`${pad}Note ${item.placement} ${item.participants.join(",")}: ${encodeText(item.text)}`);
          break;
        case "activate":
        case "deactivate":
          lines.push(`${pad}${item.type} ${item.participant}`);
          break;
        case "fragment":
          item.sections.forEach((s, i) => {
            const keyword = i === 0 ? item.kind : SECTION_KEYWORD[item.kind];
            lines.push(`${pad}${keyword}${s.label ? ` ${encodeText(s.label)}` : ""}`);
            emit(s.items, depth + 1);
          });
          lines.push(`${pad}end`);
          break;
      }
    }
  };
  emit(seq.items, 1);
  return lines.join("\n");
}

// --- parse ----------------------------------------------------------------------------

const ID = "[A-Za-z][A-Za-z0-9_]*";
const ARROW_RE = SEQ_ARROWS.slice()
  .sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[()]/g, "\\$&"))
  .join("|");
const MESSAGE = new RegExp(`^(${ID})\\s*(${ARROW_RE})\\s*([+-]?)\\s*(${ID})\\s*:(.*)$`);
const PARTICIPANT = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`);
const NOTE = new RegExp(`^note\\s+(over|left of|right of)\\s+(${ID})(?:\\s*,\\s*(${ID}))?\\s*:(.*)$`, "i");
const ACTIVATION = new RegExp(`^(activate|deactivate)\\s+(${ID})$`);
const ID_COMMENT = /^%%@(\S+)(?:\s+(\S+))?\s*$/;
const UNSUPPORTED = /^(title|box|rect|create|destroy|links?|properties|details|accTitle|accDescr|<<->>)\b/;

export interface SequenceParseResult {
  sequence: Sequence;
  /** Ids that were generated because the source had no `%%@id` line for the item. */
  generatedIds: string[];
}

/**
 * Parses the supported `sequenceDiagram` subset. `allocate(prefix, taken)` produces ids for
 * items without an `%%@id` comment (the store makes sure they were never used in the session).
 */
export function parseSequence(source: string, allocate: (prefix: string, taken: Set<string>) => string): SequenceParseResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const seq = emptySequence();
  const participants = new Map<string, SeqParticipant>();
  let header = false;
  let meta: { id: string; status?: ChangeStatus; lineNo: number } | undefined;
  // Stack of open fragments; items are appended to the innermost open section.
  const stack: SeqFragment[] = [];
  const pendingIds: Array<{ item: SeqItem; lineNo: number }> = [];
  const target = () => {
    const f = stack.at(-1);
    return f ? f.sections.at(-1)!.items : seq.items;
  };
  const participant = (id: string, lineNo: number) => {
    if (!participants.has(id)) {
      try {
        validateId(id, "participant");
      } catch (err) {
        throw lineError(lineNo, (err as Error).message);
      }
      const p: SeqParticipant = { id, label: id, kind: "participant" };
      participants.set(id, p);
      seq.participants.push(p);
    }
    return id;
  };
  const takeMeta = (item: SeqItem, lineNo: number) => {
    if (meta) {
      item.id = meta.id;
      if (meta.status) item.status = meta.status;
      meta = undefined;
    }
    pendingIds.push({ item, lineNo });
    target().push(item);
  };
  const text = (raw: string, lineNo: number) => {
    try {
      return normalizeText(decodeText(raw));
    } catch (err) {
      throw lineError(lineNo, (err as Error).message);
    }
  };

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = raw.trim();
    if (!line) return;
    if (line.startsWith("%%")) {
      const m = ID_COMMENT.exec(line);
      if (m) {
        if (meta) throw lineError(lineNo, `two %%@ id lines in a row (${meta.id}, ${m[1]})`);
        const status = m[2];
        if (status !== undefined && !(CHANGE_STATUSES as readonly string[]).includes(status)) {
          throw lineError(lineNo, `unknown status "${status}"; use ${CHANGE_STATUSES.join(", ")}`);
        }
        meta = { id: m[1], status: status as ChangeStatus | undefined, lineNo };
      }
      return;
    }
    if (line.endsWith(";")) line = line.slice(0, -1).trimEnd();
    if (!header) {
      if (line !== "sequenceDiagram") throw lineError(lineNo, `diagram must start with "sequenceDiagram"`);
      header = true;
      return;
    }
    if (line === "autonumber") {
      seq.autonumber = true;
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = PARTICIPANT.exec(line))) {
      const [, kind, id, label] = m;
      if (participants.has(id) && participants.get(id)!.label !== id) throw lineError(lineNo, `participant ${id} is declared twice`);
      participant(id, lineNo);
      const p = participants.get(id)!;
      p.kind = kind as SeqParticipant["kind"];
      if (label !== undefined) p.label = text(label, lineNo).replace(/\n/g, " ") || id;
      if (meta) {
        if (meta.id !== id) throw lineError(meta.lineNo, `%%@${meta.id} must name the participant on the next line (${id})`);
        if (meta.status) p.status = meta.status;
        meta = undefined;
      }
      return;
    }
    if ((m = MESSAGE.exec(line))) {
      const [, from, arrow, sign, to, body] = m;
      const item: SeqMessage = {
        type: "message",
        id: "",
        from: participant(from, lineNo),
        to: participant(to, lineNo),
        arrow: arrow as SeqArrow,
        text: text(body, lineNo),
      };
      if (sign === "+") item.activate = true;
      if (sign === "-") item.deactivate = true;
      takeMeta(item, lineNo);
      return;
    }
    if ((m = NOTE.exec(line))) {
      const [, placement, a, b, body] = m;
      const place = placement.toLowerCase() as NotePlacement;
      if (b && place !== "over") throw lineError(lineNo, `only "Note over A,B" can span two participants`);
      takeMeta(
        { type: "note", id: "", placement: place, participants: [participant(a, lineNo), ...(b ? [participant(b, lineNo)] : [])], text: text(body, lineNo) },
        lineNo,
      );
      return;
    }
    if ((m = ACTIVATION.exec(line))) {
      takeMeta({ type: m[1] as "activate" | "deactivate", id: "", participant: participant(m[2], lineNo) }, lineNo);
      return;
    }
    const word = line.split(/\s/)[0];
    const rest = line.slice(word.length).trim();
    if ((FRAGMENT_KINDS as readonly string[]).includes(word)) {
      const f: SeqFragment = { type: "fragment", id: "", kind: word as FragmentKind, sections: [{ label: text(rest, lineNo).replace(/\n/g, " "), items: [] }] };
      takeMeta(f, lineNo);
      stack.push(f);
      return;
    }
    if (word === "else" || word === "and" || word === "option") {
      const f = stack.at(-1);
      if (!f || SECTION_KEYWORD[f.kind] !== word) {
        throw lineError(lineNo, `"${word}" is only valid inside ${Object.entries(SECTION_KEYWORD).filter(([, k]) => k === word).map(([k]) => k).join("/")}`);
      }
      if (meta) throw lineError(meta.lineNo, `%%@ id lines cannot precede "${word}"`);
      f.sections.push({ label: text(rest, lineNo).replace(/\n/g, " "), items: [] });
      return;
    }
    if (word === "end") {
      if (!stack.pop()) throw lineError(lineNo, `"end" without an open alt/opt/loop/par/critical/break`);
      if (meta) throw lineError(meta.lineNo, `%%@ id lines cannot precede "end"`);
      return;
    }
    if (UNSUPPORTED.test(line)) throw lineError(lineNo, `"${word}" is not supported in this canvas subset`);
    if (/<<-+>>/.test(line)) throw lineError(lineNo, `bidirectional arrows are not supported; use two messages`);
    throw lineError(
      lineNo,
      `could not parse "${line.length > 50 ? line.slice(0, 50) + "…" : line}". Supported: participant/actor, A->>B: text (arrows ${SEQ_ARROWS.join(" ")}, optional +/-), Note over|left of|right of A[,B]: text, activate/deactivate A, alt/else, opt, loop, par/and, critical/option, break, end`,
    );
  });

  if (!header) throw new CanvasError("mermaid_syntax", `diagram must start with "sequenceDiagram"`);
  if (stack.length) throw new CanvasError("mermaid_syntax", `${stack.length} fragment(s) not closed with "end" (${stack.map((f) => f.kind).join(", ")})`);
  if (meta) throw lineError(meta.lineNo, `%%@${meta.id} is not followed by a statement`);

  // Explicit ids first, so generated ones never collide with them.
  const taken = new Set<string>(participants.keys());
  for (const { item, lineNo } of pendingIds) {
    if (!item.id) continue;
    try {
      validateId(item.id, item.type);
    } catch (err) {
      throw lineError(lineNo, (err as Error).message);
    }
    if (taken.has(item.id)) throw lineError(lineNo, `id ${item.id} is used more than once`);
    taken.add(item.id);
  }
  const generatedIds: string[] = [];
  for (const { item } of pendingIds) {
    if (item.id) continue;
    item.id = allocate(ID_PREFIX[item.type === "fragment" ? "fragment" : item.type], taken);
    taken.add(item.id);
    generatedIds.push(item.id);
  }
  return { sequence: seq, generatedIds };
}

function lineError(lineNo: number, msg: string): CanvasError {
  return new CanvasError("mermaid_syntax", `line ${lineNo}: ${msg}`);
}
