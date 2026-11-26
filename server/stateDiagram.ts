// Parser/serializer for the Mermaid stateDiagram-v2 subset of "state" sessions. Like the flowchart
// subset, Mermaid is only the agent-facing interchange format: the store keeps the same normalized
// graph (states = nodes, transitions = edges) and round-trips through this subset.

import { decodeLabel, encodeLabel, normalizeLabel, normalizeNodeLabel, validateId, type ParseResult } from "./mermaid.ts";
import { ANY_ID, CHANGE_STATUSES, CanvasError, FINAL_ID, INITIAL_ID, type ChangeStatus, type Graph, type GraphEdge, type GraphNode } from "./types.ts";

/** The label of the "any state" source, as written in Mermaid (other renderers show it as a plain state). */
export const ANY_LABEL = "Any state";

export const STATE_HEADER = /^stateDiagram(-v2)?$/;

/** Mermaid keywords a state id cannot be: the flowchart ones (checked by validateId) plus the state-diagram ones. */
const STATE_KEYWORDS = new Set(["state", "note", "as"]);

/** Why `id` cannot be a state's id (its value), or null when it can. Shared by the parser, the operations and the editor. */
export function stateIdProblem(id: string): string | null {
  if (id === INITIAL_ID || id === FINAL_ID || id === ANY_ID) return `"${id}" is reserved in state diagrams`;
  if (STATE_KEYWORDS.has(id.toLowerCase())) return `"${id}" is a Mermaid keyword; name the state differently`;
  try {
    validateId(id, "state");
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

const STATUS_STYLE: Record<ChangeStatus, string> = {
  new: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
  changed: "fill:#fef3c7,stroke:#d97706,color:#78350f",
  removed: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:5 4",
};

const end = (id: string) => (id === INITIAL_ID || id === FINAL_ID ? "[*]" : id);

/** Mermaid text of a state session. Transition ids and statuses ride on `%%@id [status]` comment lines. */
export function stateToMermaid(graph: Graph): string {
  const lines = ["stateDiagram-v2", `    direction ${graph.direction === "LR" ? "LR" : "TB"}`];
  // A start or end not connected yet has no transition to appear in: it gets its own %%@ line.
  for (const id of [INITIAL_ID, FINAL_ID]) {
    if (graph.nodes.some((n) => n.id === id) && !graph.edges.some((e) => e.from === id || e.to === id)) lines.push(`    %%@${id}`);
  }
  for (const n of graph.nodes) {
    if (n.shape === "any") lines.push(`    state "${ANY_LABEL}" as ${ANY_ID}`);
    if (n.shape === "choice") lines.push(`    state ${n.id} <<choice>>`);
    if (n.shape !== "state") continue;
    const [title, ...details] = n.label.split("\n");
    lines.push(`    state "${encodeLabel(title)}" as ${n.id}`);
    for (const d of details) lines.push(`    ${n.id} : ${encodeLabel(d)}`);
  }
  for (const e of graph.edges) {
    lines.push(`    %%@${e.id}${e.status ? ` ${e.status}` : ""}`);
    lines.push(`    ${end(e.from)} --> ${end(e.to)}${e.label ? ` : ${encodeLabel(e.label)}` : ""}`);
  }
  const used = new Set<ChangeStatus>();
  for (const status of CHANGE_STATUSES) {
    const ids = graph.nodes.filter((n) => n.status === status && n.shape !== "initial" && n.shape !== "final").map((n) => n.id);
    if (ids.length) {
      used.add(status);
      lines.push(`    class ${ids.join(",")} ${status}`);
    }
  }
  for (const status of CHANGE_STATUSES) if (used.has(status)) lines.push(`    classDef ${status} ${STATUS_STYLE[status]}`);
  return lines.join("\n");
}

const UNSUPPORTED: Array<[RegExp, string]> = [
  [/^state\s.*\{\s*$/, "composite states (state X { … }) are not supported yet; draw the inner states at the top level"],
  [/^--$/, 'parallel regions ("--") are not supported'],
  [/<<(fork|join|history|deepHistory)>>/, "fork, join and history states are not supported; supported: <<choice>>"],
  [/^note\b/i, "notes are not supported; put the text in a state description (Id : text) or a mark"],
  [/^(\}|end)$/, "composite states are not supported"],
  [/^(title|accTitle|accDescr|click|style|scale)\b/, "is not supported in this canvas subset"],
  [/:::/, '":::" classes are not supported; use "class Id1,Id2 new|changed|removed"'],
];

export function parseStateDiagram(source: string): ParseResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let header = false;
  // Lifecycles read left to right; "direction TB" asks for top-down.
  let direction: "TD" | "LR" = "LR";
  const nodes = new Map<string, GraphNode>();
  const declared = new Set<string>();
  const pending: Array<{ id?: string; from: string; to: string; label?: string; status?: ChangeStatus; lineNo: number }> = [];
  const classes: Array<{ ids: string[]; status: ChangeStatus; lineNo: number }> = [];
  let marker: { id: string; status?: ChangeStatus; lineNo: number } | undefined;

  const stateId = (id: string, lineNo: number) => {
    if (id === INITIAL_ID || id === FINAL_ID) throw lineError(lineNo, `"${id}" is reserved for [*]; name the state differently`);
    if (id === ANY_ID) return id;
    const problem = stateIdProblem(id);
    if (problem) throw lineError(lineNo, problem);
    return id;
  };
  const touch = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, id === ANY_ID ? { id, label: ANY_LABEL, shape: "any" } : { id, label: id, shape: "state" });
    return nodes.get(id)!;
  };
  const declare = (id: string, lineNo: number) => {
    if (declared.has(id)) throw lineError(lineNo, `state ${id} is declared more than once`);
    declared.add(id);
  };
  const ref = (token: string, side: "from" | "to", lineNo: number): string => {
    if (token === "[*]") {
      const id = side === "from" ? INITIAL_ID : FINAL_ID;
      if (!nodes.has(id)) nodes.set(id, { id, label: side === "from" ? "Start" : "End", shape: side === "from" ? "initial" : "final" });
      return id;
    }
    return touch(stateId(token, lineNo)).id;
  };

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = raw.trim();
    if (!line) return;
    const idLine = /^%%@([A-Za-z][A-Za-z0-9_]*)(?:\s+([a-z]+))?\s*$/.exec(line);
    if (idLine && (idLine[1] === INITIAL_ID || idLine[1] === FINAL_ID)) {
      // An unconnected start or end ([*] only exists as one end of a transition).
      if (!header) throw lineError(lineNo, 'diagram must start with "stateDiagram-v2"');
      ref("[*]", idLine[1] === INITIAL_ID ? "from" : "to", lineNo);
      return;
    }
    if (idLine) {
      if (!header) throw lineError(lineNo, 'diagram must start with "stateDiagram-v2"');
      if (marker) throw lineError(marker.lineNo, `%%@${marker.id} must be followed by a transition`);
      marker = { id: idLine[1], ...(idLine[2] ? { status: checkStatus(idLine[2], lineNo) } : {}), lineNo };
      return;
    }
    if (line.startsWith("%%")) return;
    if (line.endsWith(";")) line = line.slice(0, -1).trimEnd();
    if (!header) {
      if (!STATE_HEADER.test(line)) throw lineError(lineNo, 'diagram must start with "stateDiagram-v2"');
      header = true;
      return;
    }
    for (const [re, msg] of UNSUPPORTED) if (re.test(line)) throw lineError(lineNo, msg.startsWith("is ") ? `"${line.split(/\s/)[0]}" ${msg}` : msg);

    const isTransition = /-->/.test(line.replace(/"[^"]*"/g, '""'));
    if (marker && !isTransition) throw lineError(marker.lineNo, `%%@${marker.id} must be followed by a transition`);

    const dir = /^direction\s+(LR|TB|TD|RL|BT)$/.exec(line);
    if (dir) {
      direction = dir[1] === "LR" || dir[1] === "RL" ? "LR" : "TD";
      return;
    }
    if (/^classDef\s/.test(line)) return; // colours for change classes are fixed by the canvas
    const cm = /^class\s+([A-Za-z]\w*(?:\s*,\s*[A-Za-z]\w*)*)\s+([A-Za-z][\w-]*)$/.exec(line);
    if (cm) {
      classes.push({ ids: cm[1].split(",").map((x) => x.trim()), status: checkStatus(cm[2], lineNo), lineNo });
      return;
    }
    if (/^class\b/.test(line)) throw lineError(lineNo, 'expected "class Id1,Id2 new|changed|removed"');

    // state "Label" as Id
    const named = /^state\s+"([^"]*)"\s+as\s+([A-Za-z]\w*)$/.exec(line);
    if (named) {
      const id = stateId(named[2], lineNo);
      declare(id, lineNo);
      const node = touch(id);
      if (id === ANY_ID) return; // its label is fixed
      const title = normalizeLabel(decodeLabel(named[1]));
      if (!title) throw lineError(lineNo, `state ${id} needs a label`);
      node.label = [title, ...node.label.split("\n").slice(1)].join("\n");
      return;
    }
    // state Id <<choice>>  |  state Id
    const plain = /^state\s+([A-Za-z]\w*)(?:\s+<<(\w+)>>)?$/.exec(line);
    if (plain) {
      const id = stateId(plain[1], lineNo);
      if (plain[2] && plain[2] !== "choice") throw lineError(lineNo, `<<${plain[2]}>> is not supported; supported: <<choice>>`);
      declare(id, lineNo);
      const node = touch(id);
      if (plain[2]) node.shape = "choice";
      return;
    }
    if (/^state\s+"[^"]*"[^"]/.test(line) && /^state\s+".*".*"/.test(line)) throw lineError(lineNo, 'a label cannot contain a double quote; write #quot; instead');
    if (/^state\b/.test(line)) throw lineError(lineNo, 'expected state "Label" as Id, state Id <<choice>> or state Id');

    if (isTransition) {
      const t = /^(\[\*\]|[A-Za-z]\w*)\s*-->\s*(\[\*\]|[A-Za-z]\w*)\s*(?::\s*(.*))?$/.exec(line);
      if (!t) throw lineError(lineNo, `expected "A --> B : label" (one transition per line), got "${truncate(line)}"`);
      const from = ref(t[1], "from", lineNo);
      const to = ref(t[2], "to", lineNo);
      if (to === ANY_ID) throw lineError(lineNo, `nothing leads into "${ANY_ID}": its transitions are the ones possible from every state`);
      const label = t[3] !== undefined ? normalizeLabel(decodeLabel(t[3])) || undefined : undefined;
      pending.push({ id: marker?.id, from, to, label, status: marker?.status, lineNo });
      marker = undefined;
      return;
    }

    // Id : description line (adds a detail line) | bare Id
    const desc = /^([A-Za-z]\w*)\s*:\s*(.*)$/.exec(line);
    if (desc) {
      if (desc[1] === ANY_ID) throw lineError(lineNo, `"${ANY_ID}" has no description lines`);
      const node = touch(stateId(desc[1], lineNo));
      const text = normalizeLabel(decodeLabel(desc[2]));
      if (text) {
        try {
          node.label = normalizeNodeLabel(`${node.label}\n${text}`);
        } catch (err) {
          throw lineError(lineNo, (err as Error).message);
        }
      }
      return;
    }
    if (/^[A-Za-z]\w*$/.test(line)) {
      touch(stateId(line, lineNo));
      return;
    }
    throw lineError(lineNo, `could not parse "${truncate(line)}"`);
  });

  if (!header) throw new CanvasError("mermaid_syntax", 'diagram must start with "stateDiagram-v2"');
  if (marker) throw lineError(marker.lineNo, `%%@${marker.id} must be followed by a transition`);
  for (const n of nodes.values()) {
    if (n.shape === "choice") n.label = n.id;
  }

  const edgeIds = new Set<string>();
  for (const p of pending) {
    if (p.id === undefined) continue;
    validateId(p.id, "transition");
    if (edgeIds.has(p.id)) throw lineError(p.lineNo, `transition id ${p.id} is used more than once`);
    if (nodes.has(p.id)) throw lineError(p.lineNo, `transition id ${p.id} collides with a state id`);
    edgeIds.add(p.id);
  }
  const generatedEdgeIds: string[] = [];
  const edges: GraphEdge[] = [];
  let counter = 1;
  for (const p of pending) {
    let id = p.id;
    if (id === undefined) {
      while (edgeIds.has(`e${counter}`) || nodes.has(`e${counter}`)) counter++;
      id = `e${counter}`;
      edgeIds.add(id);
      generatedEdgeIds.push(id);
    }
    edges.push({ id, from: p.from, to: p.to, ...(p.label ? { label: p.label } : {}), ...(p.status ? { status: p.status } : {}) });
  }
  for (const c of classes) {
    for (const id of c.ids) {
      const node = nodes.get(id);
      if (!node) throw lineError(c.lineNo, `class statement refers to unknown state ${id}`);
      node.status = c.status;
    }
  }
  return { graph: { direction, nodes: [...nodes.values()], edges }, generatedEdgeIds };
}

function checkStatus(name: string, lineNo: number): ChangeStatus {
  if (!(CHANGE_STATUSES as readonly string[]).includes(name)) {
    throw lineError(lineNo, `unknown status "${name}"; supported: ${CHANGE_STATUSES.join(", ")}`);
  }
  return name as ChangeStatus;
}

function lineError(lineNo: number, msg: string): CanvasError {
  return new CanvasError("mermaid_syntax", `line ${lineNo}: ${msg}`);
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
