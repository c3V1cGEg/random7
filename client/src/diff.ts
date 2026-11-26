import type { BrowserState } from "../../server/store.ts";
import type { Annotation, ChangeStatus, GraphEdge, GraphNode, Instance, XY } from "../../server/types.ts";
import { walkItems, type SeqItem, type SeqParticipant, type Sequence } from "../../server/sequence.ts";

/**
 * Comparing two revisions. Ids are never reused within a session (not even across revisions made
 * from earlier ones), so the same id in both revisions is the same element.
 */

export type Change = "added" | "removed" | "changed";

export interface ElementChange {
  id: string;
  type: "node" | "edge" | "participant" | "message" | "note" | "activation" | "fragment" | "instance";
  /** What to show when the change is clicked, when that is not the element itself (an instance: its state). */
  target?: string;
  change: Change;
  /** How the element reads (in the newer revision, or the older one when removed). */
  name: string;
  /** What changed: text, shape, ends, status, arrow, kind, sections, position. */
  fields: string[];
  /** The text before, when it changed. */
  before?: string;
}

export interface MarkChange {
  id: number;
  change: Change;
  text: string;
  kind?: Annotation["kind"];
  /** kind, text, targets, replies, orphaned */
  fields: string[];
  newReplies: number;
}

export interface TextLine {
  /** " " same, "+" only in the newer revision, "-" only in the older one */
  op: " " | "+" | "-";
  line: string;
}

export interface RevisionDiff {
  /** The older and the newer revision (by number, whichever was picked first). */
  from: number;
  to: number;
  type: BrowserState["type"];
  elements: ElementChange[];
  marks: MarkChange[];
  /** Flowchart nodes that moved or were resized, and edges whose ends were moved by hand. */
  moved: string[];
  reanchored: string[];
  text: TextLine[];
}

const short = (s: string, n = 60) => {
  const one = s.split("\n")[0];
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** Compares the listed fields of each element in both lists, by id; order is kept (newer first, then removed). */
function compare<T extends { id: string }>(
  a: T[],
  b: T[],
  fields: Record<string, (x: T) => unknown>,
  describe: (x: T) => Omit<ElementChange, "id" | "change" | "fields" | "before">,
  textOf?: (x: T) => string,
): ElementChange[] {
  const before = new Map(a.map((x) => [x.id, x]));
  const after = new Set(b.map((x) => x.id));
  const out: ElementChange[] = [];
  for (const x of b) {
    const old = before.get(x.id);
    if (!old) {
      out.push({ id: x.id, change: "added", fields: [], ...describe(x) });
      continue;
    }
    const changed = Object.keys(fields).filter((f) => JSON.stringify(fields[f](old)) !== JSON.stringify(fields[f](x)));
    if (changed.length)
      out.push({ id: x.id, change: "changed", fields: changed, ...describe(x), ...(changed.includes("text") && textOf ? { before: textOf(old) } : {}) });
  }
  for (const x of a) if (!after.has(x.id)) out.push({ id: x.id, change: "removed", fields: [], ...describe(x) });
  return out;
}

function flowchartChanges(a: BrowserState, b: BrowserState): ElementChange[] {
  const label = (s: BrowserState, id: string) => short(s.nodes.find((n) => n.id === id)?.label ?? id, 24);
  const nodes = compare<GraphNode>(
    a.nodes,
    b.nodes,
    { text: (n) => n.label.split("\n")[0], details: (n) => n.label.split("\n").slice(1), shape: (n) => n.shape, status: (n) => n.status ?? null },
    (n) => ({ type: "node", name: short(n.label) }),
    (n) => n.label.split("\n")[0],
  );
  const edgeName = (e: GraphEdge) => {
    const s = b.nodes.some((n) => n.id === e.from) || !a.nodes.some((n) => n.id === e.from) ? b : a;
    const t = b.nodes.some((n) => n.id === e.to) || !a.nodes.some((n) => n.id === e.to) ? b : a;
    return `${label(s, e.from)} → ${label(t, e.to)}${e.label ? ` "${short(e.label, 30)}"` : ""}`;
  };
  const edges = compare<GraphEdge>(
    a.edges,
    b.edges,
    { ends: (e) => [e.from, e.to], text: (e) => e.label ?? "", status: (e) => e.status ?? null },
    (e) => ({ type: "edge", name: edgeName(e) }),
    (e) => e.label ?? "",
  );
  return [...nodes, ...edges];
}

/** State diagrams: instances placed, moved, changed or removed. */
function instanceChanges(a: BrowserState, b: BrowserState): ElementChange[] {
  const title = (s: BrowserState, id: string) => (id === "final" ? "End" : short(s.nodes.find((n) => n.id === id)?.label ?? id, 24));
  return compare<Instance>(
    a.instances ?? [],
    b.instances ?? [],
    { state: (i) => i.state, text: (i) => i.label, fields: (i) => i.fields ?? {}, orphaned: (i) => !!i.orphaned },
    (i) => {
      const old = (a.instances ?? []).find((x) => x.id === i.id);
      const inB = (b.instances ?? []).some((x) => x.id === i.id);
      const where = old && inB && old.state !== i.state ? `${title(a, old.state)} → ${title(b, i.state)}` : `in ${title(inB ? b : a, i.state)}`;
      return { type: "instance", name: `${short(i.label, 30)} (${where})`, target: i.state };
    },
    (i) => i.label,
  );
}

type SeqElement = (SeqParticipant | SeqItem) & { where?: string };

/** Every sequence element with where it sits: after which item and in which fragment section. */
function seqElements(seq: Sequence): SeqElement[] {
  const items = [...walkItems(seq.items)].map(({ item, parent, section }) => ({ ...item, where: parent ? `${parent.id}/${section}` : "" }));
  return [...seq.participants, ...items];
}

/** Ids of the items present in both that kept their order relative to each other (longest common subsequence). */
function keptOrder(a: string[], b: string[]): Set<string> {
  const inB = new Set(b);
  const inA = new Set(a);
  const x = a.filter((id) => inB.has(id));
  const y = b.filter((id) => inA.has(id));
  const kept = new Set<string>();
  if (x.length * y.length > 4_000_000) return new Set(x); // too big to compare the order: don't report reordering
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i] === y[j]) {
      kept.add(x[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return kept;
}

function sequenceChanges(a: BrowserState, b: BrowserState): ElementChange[] {
  const ea = seqElements(a.sequence);
  const eb = seqElements(b.sequence);
  const order = (els: SeqElement[]) => els.filter((e) => "type" in e).map((e) => e.id);
  const kept = keptOrder(order(ea), order(eb));
  const participant = (id: string) => (b.sequence.participants.find((p) => p.id === id) ?? a.sequence.participants.find((p) => p.id === id))?.label ?? id;
  const typeOf = (e: SeqElement): ElementChange["type"] =>
    !("type" in e) ? "participant" : e.type === "activate" || e.type === "deactivate" ? "activation" : e.type;
  const textOf = (e: SeqElement) => ("label" in e ? e.label : "text" in e ? e.text : "");
  const nameOf = (e: SeqElement): string => {
    if (!("type" in e)) return short(e.label);
    switch (e.type) {
      case "message":
        return `${short(participant(e.from), 20)} → ${short(participant(e.to), 20)}: ${short(e.text, 40)}`;
      case "note":
        return `Note: ${short(e.text, 40)}`;
      case "fragment":
        return `${e.kind} ${short(e.sections[0]?.label ?? "", 40)}`.trim();
      default:
        return `${e.type} ${short(participant(e.participant), 30)}`;
    }
  };
  const field = (pick: (e: SeqElement) => unknown) => pick;
  const out = compare<SeqElement>(
    ea,
    eb,
    {
      text: field(textOf),
      kind: field((e) => ("kind" in e ? e.kind : null)),
      ends: field((e) => ("from" in e ? [e.from, e.to] : "participants" in e ? [e.placement, ...e.participants] : "participant" in e ? e.participant : null)),
      arrow: field((e) => ("arrow" in e ? [e.arrow, !!e.activate, !!e.deactivate] : null)),
      sections: field((e) => ("sections" in e ? e.sections.map((s) => s.label) : null)),
      status: field((e) => e.status ?? null),
      position: field((e) => e.where ?? ""),
    },
    (e) => ({ type: typeOf(e), name: nameOf(e) }),
    textOf,
  );
  // Items and participants (each in their own order) that moved relative to the rest.
  const pa = a.sequence.participants.map((p) => p.id);
  const pb = b.sequence.participants.map((p) => p.id);
  const keptP = keptOrder(pa, pb);
  const ia = new Set(order(ea));
  const reordered = [...pb.filter((id) => pa.includes(id) && !keptP.has(id)), ...order(eb).filter((id) => ia.has(id) && !kept.has(id))];
  for (const id of reordered) {
    const c = out.find((x) => x.id === id);
    const e = eb.find((x) => x.id === id)!;
    if (c) {
      if (!c.fields.includes("position")) c.fields.push("position");
    } else out.push({ id, type: typeOf(e), change: "changed", name: nameOf(e), fields: ["position"] });
  }
  return out;
}

function markChanges(a: Annotation[], b: Annotation[]): MarkChange[] {
  const before = new Map(a.map((m) => [m.id, m]));
  const after = new Set(b.map((m) => m.id));
  const targets = (m: Annotation) => [...m.nodeIds, ...m.edgeIds, ...(m.elementIds ?? [])].sort().join(",");
  const out: MarkChange[] = [];
  for (const m of b) {
    const old = before.get(m.id);
    const base = { id: m.id, text: m.text ?? "", kind: m.kind };
    if (!old) {
      out.push({ ...base, change: "added", fields: [], newReplies: m.replies?.length ?? 0 });
      continue;
    }
    const fields = [
      (old.kind ?? null) !== (m.kind ?? null) && "kind",
      (old.text ?? "") !== (m.text ?? "") && "text",
      !!old.orphaned !== !!m.orphaned ? "orphaned" : targets(old) !== targets(m) && "targets",
    ].filter((f): f is string => !!f);
    const newReplies = Math.max(0, (m.replies?.length ?? 0) - (old.replies?.length ?? 0));
    if (newReplies) fields.push("replies");
    if (fields.length) out.push({ ...base, change: "changed", fields, newReplies });
  }
  for (const m of a) if (!after.has(m.id)) out.push({ id: m.id, text: m.text ?? "", kind: m.kind, change: "removed", fields: [], newReplies: 0 });
  return out;
}

/** Line diff (longest common subsequence); very long texts fall back to "all removed, all added". */
export function lineDiff(a: string, b: string): TextLine[] {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  if (x.length * y.length > 4_000_000) return [...x.map((line) => ({ op: "-" as const, line })), ...y.map((line) => ({ op: "+" as const, line }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: TextLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: " ", line: x[i] });
      i++;
      j++;
    } else if (j < y.length && (i === x.length || dp[i][j + 1] >= dp[i + 1][j])) out.push({ op: "+", line: y[j++] });
    else out.push({ op: "-", line: x[i++] });
  }
  return out;
}

const sameBox = (p?: XY, q?: XY) => !!p && !!q && p.x === q.x && p.y === q.y && (p.w ?? 0) === (q.w ?? 0) && (p.h ?? 0) === (q.h ?? 0);

/** What changed from revision `a` to revision `b` (the caller passes the older one first). */
export function diffRevisions(a: BrowserState, b: BrowserState): RevisionDiff {
  const from = a.viewing ?? a.revision;
  const to = b.viewing ?? b.revision;
  // Flowcharts and state diagrams are both nodes and edges.
  const flow = b.type !== "sequence";
  const both = (id: string) => a.nodes.some((n) => n.id === id) && b.nodes.some((n) => n.id === id);
  const bothEdge = (id: string) => a.edges.some((e) => e.id === id) && b.edges.some((e) => e.id === id);
  return {
    from,
    to,
    type: b.type,
    elements: a.type !== b.type ? [] : flow ? [...flowchartChanges(a, b), ...(b.type === "state" ? instanceChanges(a, b) : [])] : sequenceChanges(a, b),
    marks: markChanges(a.annotations, b.annotations),
    moved: flow ? b.nodes.filter((n) => both(n.id) && a.layout[n.id] && b.layout[n.id] && !sameBox(a.layout[n.id], b.layout[n.id])).map((n) => n.id) : [],
    reanchored: flow ? b.edges.filter((e) => bothEdge(e.id) && JSON.stringify(a.anchors[e.id] ?? {}) !== JSON.stringify(b.anchors[e.id] ?? {})).map((e) => e.id) : [],
    text: lineDiff(a.diagram, b.diagram),
  };
}

const STATUS: Record<Change, ChangeStatus> = { added: "new", changed: "changed", removed: "removed" };

/**
 * The newer revision drawn with the comparison as change colours: added and changed elements
 * marked, removed flowchart elements put back (where they were) as removed. The diagram's own
 * proposal colours are left out so they don't mix with the comparison.
 */
export function comparisonState(a: BrowserState, b: BrowserState, d: RevisionDiff): BrowserState {
  const status = new Map(d.elements.filter((c) => c.change !== "removed").map((c) => [c.id, STATUS[c.change]]));
  const removed = new Set(d.elements.filter((c) => c.change === "removed").map((c) => c.id));
  const mark = <T extends { id: string; status?: ChangeStatus }>(x: T): T => ({ ...x, status: status.get(x.id) });
  const gone = <T extends { id: string; status?: ChangeStatus }>(x: T): T => ({ ...x, status: "removed" });
  const layout = { ...b.layout };
  const anchors = { ...b.anchors };
  for (const n of a.nodes) if (removed.has(n.id) && a.layout[n.id]) layout[n.id] = a.layout[n.id];
  for (const e of a.edges) if (removed.has(e.id) && a.anchors[e.id]) anchors[e.id] = a.anchors[e.id];
  const seqItems = (items: SeqItem[]): SeqItem[] =>
    items.map((it) => (it.type === "fragment" ? { ...mark(it), sections: it.sections.map((s) => ({ ...s, items: seqItems(s.items) })) } : mark(it)));
  return {
    ...b,
    // Removed first, so they are drawn underneath whatever took their place.
    nodes: [...a.nodes.filter((n) => removed.has(n.id)).map(gone), ...b.nodes.map(mark)],
    edges: [...a.edges.filter((e) => removed.has(e.id)).map(gone), ...b.edges.map(mark)],
    sequence: { ...b.sequence, participants: b.sequence.participants.map(mark), items: seqItems(b.sequence.items) },
    layout,
    anchors,
    history: { undo: [], redo: [] },
  };
}
