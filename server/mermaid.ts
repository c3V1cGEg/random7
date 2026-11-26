// Parser/serializer for the constrained Mermaid flowchart subset used as the
// agent-facing interchange format. Mermaid is NOT the internal model; the store
// holds a normalized graph and only round-trips through this subset.

import type { ChangeStatus, Direction, FlowShape, Graph, GraphEdge, GraphNode, NodeShape } from "./types.ts";
import { CHANGE_STATUSES, CanvasError, LIMITS } from "./types.ts";

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_IDS = new Set(["end", "graph", "flowchart", "subgraph", "style", "classdef", "class", "click", "direction", "linkstyle"]);

export function validateId(id: string, what: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new CanvasError("invalid_id", `${what} id "${id}" must match ${ID_PATTERN.source}`);
  }
  if (RESERVED_IDS.has(id.toLowerCase())) {
    throw new CanvasError("invalid_id", `${what} id "${id}" is a reserved Mermaid keyword`);
  }
}

// --- text escaping -----------------------------------------------------------

/**
 * Labels are plain text. Mermaid quoted strings cannot contain `"`, so we use entity codes;
 * line breaks (node detail lines) are written as `<br>`.
 */
export function encodeLabel(text: string): string {
  return text.replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/\|/g, "#124;").replace(/\n/g, "<br>");
}

export function decodeLabel(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#124;/g, "|")
    .replace(/#35;/g, "#");
}

/** Single-line label (edges). */
export function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Node label: a title line plus optional detail lines (e.g. "+ write audit log row"). */
export function normalizeNodeLabel(text: string): string {
  const lines = text
    .split("\n")
    .map(normalizeLabel)
    .filter(Boolean);
  if (lines.length > LIMITS.labelLines) {
    throw new CanvasError("too_large", `a node label has at most ${LIMITS.labelLines} lines; split the logic into more nodes`);
  }
  return lines.join("\n");
}

const STATUS_STYLE: Record<ChangeStatus, string> = {
  new: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
  changed: "fill:#fef3c7,stroke:#d97706,color:#78350f",
  removed: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:5 4",
};

function checkStatus(name: string, lineNo: number): ChangeStatus {
  if (!(CHANGE_STATUSES as readonly string[]).includes(name)) {
    throw lineError(lineNo, `unknown class "${name}"; supported change classes: ${CHANGE_STATUSES.join(", ")}`);
  }
  return name as ChangeStatus;
}

// --- serialize ---------------------------------------------------------------

const SHAPE_WRAP: Record<FlowShape, [string, string]> = {
  action: ['["', '"]'],
  decision: ['{"', '"}'],
  terminal: ['(["', '"])'],
  store: ['[("', '")]'],
};

export function toMermaid(graph: Graph): string {
  const lines = [`flowchart ${graph.direction}`];
  for (const n of graph.nodes) {
    const [open, close] = SHAPE_WRAP[n.shape as FlowShape] ?? SHAPE_WRAP.action;
    lines.push(`    ${n.id}${open}${encodeLabel(n.label)}${close}${n.status ? `:::${n.status}` : ""}`);
  }
  for (const e of graph.edges) {
    const label = e.label ? `|"${encodeLabel(e.label)}"|` : "";
    lines.push(`    ${e.from} ${e.id}@-->${label} ${e.to}`);
  }
  // Edge classes need a separate statement; nodes carry theirs inline (:::status).
  const used = new Set<ChangeStatus>();
  for (const n of graph.nodes) if (n.status) used.add(n.status);
  for (const status of CHANGE_STATUSES) {
    const ids = graph.edges.filter((e) => e.status === status).map((e) => e.id);
    if (ids.length) {
      used.add(status);
      lines.push(`    class ${ids.join(",")} ${status}`);
    }
  }
  for (const status of CHANGE_STATUSES) if (used.has(status)) lines.push(`    classDef ${status} ${STATUS_STYLE[status]}`);
  return lines.join("\n");
}

// --- parse -------------------------------------------------------------------

export interface ParseResult {
  graph: Graph;
  /** Edge IDs that were generated because the source omitted `eN@`. */
  generatedEdgeIds: string[];
}

interface NodeRef {
  id: string;
  shape?: NodeShape;
  label?: string;
  status?: ChangeStatus;
}

const UNSUPPORTED_KEYWORDS = /^(subgraph|end|style|linkStyle|click|direction|accTitle|accDescr)\b/;

/** Consumes an optional `:::status` suffix after a node reference. */
function parseClassSuffix(ref: NodeRef, rest: string, lineNo: number): { ref: NodeRef; rest: string } {
  const m = /^:::([A-Za-z][\w-]*)/.exec(rest);
  if (!m) return { ref, rest };
  return { ref: { ...ref, status: checkStatus(m[1], lineNo) }, rest: rest.slice(m[0].length) };
}

/**
 * Parses a node reference such as `n1`, `n1["Label"]`, `n2{"Cond?"}`, `n3(["Start"])`
 * at the start of `src`. Returns the reference and the unconsumed remainder.
 */
function parseNodeRef(src: string, lineNo: number): { ref: NodeRef; rest: string } {
  const m = /^([A-Za-z][A-Za-z0-9_]*)/.exec(src);
  if (!m) throw lineError(lineNo, `expected a node id at "${truncate(src)}"`);
  const id = m[1];
  let rest = src.slice(id.length);
  const shapes: Array<[NodeShape, string, string]> = [
    ["terminal", "([", "])"],
    ["store", "[(", ")]"],
    ["action", "[", "]"],
    ["decision", "{", "}"],
  ];
  for (const [shape, open, close] of shapes) {
    if (!rest.startsWith(open)) continue;
    const body = rest.slice(open.length);
    let label: string;
    let consumed: number;
    if (body.startsWith('"')) {
      const end = body.indexOf('"', 1);
      if (end < 0) throw lineError(lineNo, `unterminated quoted label for node ${id}`);
      label = body.slice(1, end);
      if (!body.slice(end + 1).startsWith(close)) {
        throw lineError(lineNo, `expected "${close}" after label of node ${id}`);
      }
      consumed = end + 1 + close.length;
    } else {
      const end = body.indexOf(close);
      if (end < 0) throw lineError(lineNo, `expected "${close}" to close node ${id}`);
      label = body.slice(0, end);
      if (/[[\]{}()"]/.test(label)) {
        throw lineError(lineNo, `unquoted label for node ${id} contains brackets or quotes; wrap the label in "double quotes"`);
      }
      consumed = end + close.length;
    }
    rest = body.slice(consumed);
    let text: string;
    try {
      text = normalizeNodeLabel(decodeLabel(label));
    } catch (err) {
      throw lineError(lineNo, (err as Error).message);
    }
    return parseClassSuffix({ id, shape, label: text }, rest, lineNo);
  }
  if (/^[([{>]/.test(rest)) {
    throw lineError(lineNo, `unsupported node shape for ${id}; supported: id["action"], id{"decision"}, id(["start/end"]), id[("data store")]`);
  }
  return parseClassSuffix({ id }, rest, lineNo);
}

export function parseMermaid(source: string): ParseResult {
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  let direction: Direction | undefined;
  const nodes = new Map<string, GraphNode>();
  const declared = new Set<string>();
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const pendingEdges: Array<{ id?: string; from: string; to: string; label?: string; lineNo: number }> = [];
  const nodeStatus = new Map<string, ChangeStatus>();
  const classStatements: Array<{ ids: string[]; status: ChangeStatus; lineNo: number }> = [];

  const declare = (ref: NodeRef, lineNo: number) => {
    validateId(ref.id, "node");
    if (ref.status) nodeStatus.set(ref.id, ref.status);
    if (ref.shape === undefined) {
      if (!nodes.has(ref.id)) nodes.set(ref.id, { id: ref.id, label: ref.id, shape: "action" });
      return;
    }
    if (declared.has(ref.id)) throw lineError(lineNo, `node ${ref.id} is defined more than once`);
    declared.add(ref.id);
    nodes.set(ref.id, { id: ref.id, label: ref.label || ref.id, shape: ref.shape });
  };

  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = raw.trim();
    if (!line || line.startsWith("%%")) return;
    if (line.endsWith(";")) line = line.slice(0, -1).trimEnd();

    if (direction === undefined) {
      const h = /^(flowchart|graph)\s+(TD|TB|LR)$/.exec(line);
      if (!h) throw lineError(lineNo, `diagram must start with "flowchart TD" or "flowchart LR"`);
      direction = h[2] === "LR" ? "LR" : "TD";
      return;
    }
    if (/^classDef\s/.test(line)) return; // styling only; colours for change classes are fixed by the canvas
    const cm = /^class\s+([A-Za-z][\w]*(?:\s*,\s*[A-Za-z][\w]*)*)\s+([A-Za-z][\w-]*)$/.exec(line);
    if (cm) {
      classStatements.push({ ids: cm[1].split(",").map((x) => x.trim()), status: checkStatus(cm[2], lineNo), lineNo });
      return;
    }
    if (/^class\b/.test(line)) throw lineError(lineNo, `expected "class id1,id2 new|changed|removed"`);
    if (UNSUPPORTED_KEYWORDS.test(line)) {
      throw lineError(lineNo, `"${line.split(/\s/)[0]}" is not supported in this canvas subset`);
    }
    const unquoted = line.replace(/"[^"]*"/g, '""');
    if (unquoted.includes(";")) throw lineError(lineNo, `put one statement per line (";" separators are not supported)`);
    if (unquoted.includes("&")) throw lineError(lineNo, `"&" multi-node syntax is not supported; write one edge per line`);

    const left = parseNodeRef(line, lineNo);
    let rest = left.rest.trim();
    if (!rest) {
      declare(left.ref, lineNo);
      return;
    }

    // Edge: [edgeId@]-->[|label|] target
    const em = /^(?:([A-Za-z][A-Za-z0-9_]*)@)?-->\s*/.exec(rest);
    if (!em) {
      if (/^(-\.->|==>|---|-\.-|===|--[ox]|<-->|~~~|--\s)/.test(rest)) {
        throw lineError(lineNo, `only "-->" edges are supported (optionally "eN@-->" and "-->|label|")`);
      }
      throw lineError(lineNo, `could not parse "${truncate(rest)}"`);
    }
    rest = rest.slice(em[0].length);
    let label: string | undefined;
    if (rest.startsWith("|")) {
      const quoted = rest.startsWith('|"');
      const end = quoted ? rest.indexOf('"|', 2) + 1 : rest.indexOf("|", 1);
      if (end < 1) throw lineError(lineNo, "unterminated |edge label|");
      let l = rest.slice(1, end).trim();
      if (l.startsWith('"') && l.endsWith('"') && l.length >= 2) l = l.slice(1, -1);
      label = normalizeLabel(decodeLabel(l)) || undefined;
      rest = rest.slice(end + 1).trim();
    }
    const right = parseNodeRef(rest, lineNo);
    if (right.rest.trim()) {
      throw lineError(lineNo, `chained edges are not supported; write one edge per line`);
    }
    declare(left.ref, lineNo);
    declare(right.ref, lineNo);
    pendingEdges.push({ id: em[1], from: left.ref.id, to: right.ref.id, label, lineNo });
  });

  if (direction === undefined) throw new CanvasError("mermaid_syntax", `diagram must start with "flowchart TD" or "flowchart LR"`);

  // Assign edge IDs after all explicit ones are known so generated IDs never collide.
  for (const p of pendingEdges) {
    if (p.id === undefined) continue;
    validateId(p.id, "edge");
    if (edgeIds.has(p.id)) throw lineError(p.lineNo, `edge id ${p.id} is used more than once`);
    if (nodes.has(p.id)) throw lineError(p.lineNo, `edge id ${p.id} collides with a node id`);
    edgeIds.add(p.id);
  }
  const generatedEdgeIds: string[] = [];
  let counter = 1;
  for (const p of pendingEdges) {
    let id = p.id;
    if (id === undefined) {
      while (edgeIds.has(`e${counter}`) || nodes.has(`e${counter}`)) counter++;
      id = `e${counter}`;
      edgeIds.add(id);
      generatedEdgeIds.push(id);
    }
    edges.push({ id, from: p.from, to: p.to, ...(p.label ? { label: p.label } : {}) });
  }

  for (const [id, status] of nodeStatus) nodes.get(id)!.status = status;
  for (const c of classStatements) {
    for (const id of c.ids) {
      const target = nodes.get(id) ?? edges.find((e) => e.id === id);
      if (!target) throw lineError(c.lineNo, `class statement refers to unknown node or edge ${id} (edges need explicit ids: a e1@--> b)`);
      target.status = c.status;
    }
  }

  return { graph: { direction, nodes: [...nodes.values()], edges }, generatedEdgeIds };
}

function lineError(lineNo: number, msg: string): CanvasError {
  return new CanvasError("mermaid_syntax", `line ${lineNo}: ${msg}`);
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
