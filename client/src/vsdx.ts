import type { Annotation, ChangeStatus, GraphEdge, GraphNode } from "../../server/types.ts";
import { KIND_META, STATUS_META } from "./kinds.ts";
import { zip } from "./zip.ts";

/**
 * Visio (.vsdx) export of a flowchart as laid out on the canvas: shapes where the nodes are, connectors from where each
 * edge leaves its node to where it arrives (glued there) following its curve or straight, and each mark as a dashed outline with a note holding its thread.
 * Miro, Lucidchart and draw.io import .vsdx as editable shapes. Coordinates come in as flow pixels.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface XY {
  x: number;
  y: number;
}

export interface ExportNode extends GraphNode, Box {}
/** A cubic bezier piece of a drawn edge: control points and where it ends (it starts where the one before ended). */
export interface Cubic {
  c1: XY;
  c2: XY;
  to: XY;
}
export interface ExportEdge extends GraphEdge {
  /** Where the drawn edge leaves its source and reaches its target. */
  start: XY;
  end: XY;
  /** The drawn curve from `start`, for curved connectors; without it the connector is straight. */
  curve?: Cubic[];
  /** Halfway along the drawn edge, where a curved connector's label goes. */
  mid?: XY;
}
export interface ExportMark {
  mark: Annotation;
  /** The outline drawn around what the mark points at, or where its note goes when `outline` is false. */
  box: Box;
  outline?: boolean;
}
/** State diagrams: an instance chip where the canvas shows it. */
export interface ExportInstance extends Box {
  id: string;
  label: string;
  state: string;
  fields?: Record<string, string>;
}
/** State diagrams: one row of the States legend. */
export interface ExportLegendRow {
  id: string;
  label: string;
  count: number;
  tags: string[];
}
export interface ExportDiagram {
  title: string;
  /** State diagrams: instance chips, and the States legend (drawn left of the diagram). */
  instances?: ExportInstance[];
  legend?: ExportLegendRow[];
  /** Lines under the legend's states, as on the canvas: transitions from any state, warnings. */
  legendNotes?: string[];
  nodes: ExportNode[];
  edges: ExportEdge[];
  marks: ExportMark[];
  /** Connectors that follow each edge's drawn curve (round the boxes, as on the canvas), or straight lines that are easier to rearrange. */
  lines: "curved" | "straight";
}

/**
 * The cubic pieces of an SVG path made of absolute M, L, C and S commands (as the canvas draws its edges),
 * or null for anything else. Lines become cubics with their control points on the line.
 */
export function cubics(d: string): { start: XY; curve: Cubic[] } | null {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const curve: Cubic[] = [];
  let start: XY | null = null;
  let at: XY = { x: 0, y: 0 };
  let i = 0;
  const point = (): XY => {
    const x = Number(tokens[i++]);
    const y = Number(tokens[i++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("bad number");
    return { x, y };
  };
  try {
    while (i < tokens.length) {
      const command = tokens[i++];
      do {
        if (command === "M" && !start) start = at = point();
        else if (command === "L") {
          const to = point();
          curve.push({ c1: { x: at.x + (to.x - at.x) / 3, y: at.y + (to.y - at.y) / 3 }, c2: { x: at.x + (2 * (to.x - at.x)) / 3, y: at.y + (2 * (to.y - at.y)) / 3 }, to });
          at = to;
        } else if (command === "C") {
          curve.push({ c1: point(), c2: point(), to: point() });
          at = curve[curve.length - 1].to;
        } else if (command === "S") {
          // The first control point mirrors the previous piece's second one.
          const prev = curve[curve.length - 1];
          const c1 = prev ? { x: 2 * at.x - prev.c2.x, y: 2 * at.y - prev.c2.y } : at;
          curve.push({ c1, c2: point(), to: point() });
          at = curve[curve.length - 1].to;
        } else return null;
      } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
    }
  } catch {
    return null;
  }
  return start && curve.length ? { start, curve } : null;
}

const PX = 96; // flow pixels per inch, Visio's unit
const MARGIN = 48;
const INK = "#1f2328";
const BORDER = "#3b3f46";
const EDGE = "#4a4f57";
const FILL: Record<GraphNode["shape"], string> = {
  action: "#ffffff",
  terminal: "#f1f4f8",
  decision: "#fffaf0",
  store: "#f4f7fb",
  state: "#ffffff",
  initial: "#1f2937",
  final: "#1f2937",
  choice: "#fffaf0",
  any: "#f6f8fa",
};
const STATUS: Record<ChangeStatus, { line: string; fill: string }> = {
  new: { line: "#16a34a", fill: "#dcfce7" },
  changed: { line: "#d97706", fill: "#fef3c7" },
  removed: { line: "#dc2626", fill: "#fee2e2" },
};
const KIND_COLOR: Record<keyof typeof KIND_META, string> = {
  none: "#d9930d",
  question: "#2f6fde",
  "needs-testing": "#8a4fd8",
  incorrect: "#d33c3c",
  attention: "#e07b12",
  suggestion: "#2e9a5b",
  decision: "#c0398a",
  uncertain: "#7d8590",
  custom: "#1a9aa0",
};
const INSTANCE = { line: "#7c4dff", fill: "#f1ebff", ink: "#3b1f8f" };
const LEGEND_WIDTH = 250;
const LEGEND_FONT = 12;
const NOTE_WIDTH = 260;
const NOTE_FONT = 12;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const num = (n: number) => String(Math.round(n * 10000) / 10000);
const cell = (name: string, v: number | string, unit?: string) =>
  `<Cell N="${name}" V="${typeof v === "number" ? num(v) : esc(v)}"${unit ? ` U="${unit}"` : ""}/>`;
const row = (type: string, ix: number, cells: Record<string, number>) =>
  `<Row T="${type}" IX="${ix}">${Object.entries(cells).map(([n, v]) => cell(n, v)).join("")}</Row>`;
const geometry = (ix: number, rows: string[], { noFill = false } = {}) =>
  `<Section N="Geometry" IX="${ix}">${cell("NoFill", noFill ? 1 : 0)}${cell("NoLine", 0)}${cell("NoShow", 0)}${rows.join("")}</Section>`;
const font = (px: number) => cell("Size", px / PX, "PT");

/** Visio Shape Data: shown in Visio's Shape Data window and imported as data by Lucidchart and draw.io. */
const shapeData = (fields: Array<[string, string]>) =>
  fields.length
    ? `<Section N="Property">${fields
        .map(
          ([label, value], i) =>
            `<Row N="${label.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?![A-Za-z])/, "f") || `f${i}`}">` +
            cell("Value", value, "STR") + cell("Label", label) + cell("Type", 0) + cell("Invisible", 0) +
            `</Row>`,
        )
        .join("")}</Section>`
    : "";

/** Character rows: 0 normal, 1 bold, plus strike-through for removed elements. */
function characters(color: string, px: number, strike = false) {
  const rowOf = (ix: number, bold: boolean) =>
    `<Row IX="${ix}">${cell("Color", color)}${font(px)}${cell("Style", bold ? 1 : 0)}${cell("Strikethru", strike ? 1 : 0)}</Row>`;
  return `<Section N="Character">${rowOf(0, false)}${rowOf(1, true)}</Section>`;
}
const paragraph = (align: "left" | "center") => `<Section N="Paragraph"><Row IX="0">${cell("HorzAlign", align === "left" ? 0 : 1)}</Row></Section>`;
/** Text whose first line is bold (`cp` picks the character row) when `boldFirst`. */
const text = (lines: string[], boldFirst: boolean) =>
  boldFirst && lines.length
    ? `<Text><cp IX="1"/>${esc(lines[0])}${lines.length > 1 ? `\n<cp IX="0"/>${esc(lines.slice(1).join("\n"))}` : ""}</Text>`
    : `<Text><cp IX="0"/>${esc(lines.join("\n"))}</Text>`;

const DETAIL: Record<string, string> = { "+": "+ ", "-": "− ", "~": "~ " };
/** Node label as the canvas shows it: a title, then detail lines with their +/−/~ markers. */
const labelLines = (label: string) => {
  const [title, ...details] = label.split("\n");
  return [title, ...details.map((l) => (DETAIL[l[0]] && l[1] === " " ? DETAIL[l[0]] + l.slice(2) : `· ${l}`))];
};

/** Rough line count of `s` wrapped to `width` pixels of `px`-sized text. */
const wrappedLines = (s: string, width: number, px: number) =>
  s.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((line.length * px * 0.55) / width)), 0);

export function buildVsdx(diagram: ExportDiagram): Uint8Array<ArrayBuffer> {
  const d = diagram.lines === "straight" ? { ...diagram, edges: diagram.edges.map((e) => facing(e, diagram.nodes)) } : diagram;
  const notes = d.marks.map((m) => ({ ...m, ...markNote(m) }));
  const instances = d.instances ?? [];
  const drawn: Box[] = [...d.nodes, ...instances];
  const legend = d.legend?.length ? legendBox(d.legend, d.legendNotes ?? [], drawn) : undefined;
  const all: Box[] = [
    ...drawn,
    ...(legend ? [legend.box] : []),
    ...d.edges.flatMap((e) => edgePoints(e, d.lines).map((p) => ({ ...p, width: 0, height: 0 }))),
    ...notes.flatMap((n) => (n.outline === false ? [n.note] : [n.box, n.note])),
  ];
  const x0 = Math.min(...all.map((b) => b.x)) - MARGIN;
  const y0 = Math.min(...all.map((b) => b.y)) - MARGIN;
  const pageW = (Math.max(...all.map((b) => b.x + b.width)) + MARGIN - x0) / PX;
  const pageH = (Math.max(...all.map((b) => b.y + b.height)) + MARGIN - y0) / PX;
  // Page coordinates: inches, origin at the bottom left.
  const X = (x: number) => (x - x0) / PX;
  const Y = (y: number) => pageH - (y - y0) / PX;

  let nextId = 1;
  const shapes: string[] = [];
  const connects: string[] = [];
  const nodeShape = new Map<string, { id: number; node: ExportNode; points: XY[] }>();

  // Mark outlines go first so they sit behind the diagram.
  for (const { mark, box, outline } of notes) {
    if (outline === false) continue;
    const color = KIND_COLOR[mark.kind ?? "none"];
    shapes.push(
      `<Shape ID="${nextId++}" NameU="Mark ${mark.id} outline" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        xform(X(box.x), Y(box.y + box.height), box.width / PX, box.height / PX) +
        cell("FillForegnd", color) + cell("FillForegndTrans", 0.93) + cell("FillPattern", 1) +
        cell("LineColor", color) + cell("LineWeight", 2.5 / PX) + cell("LinePattern", 2) + cell("Rounding", 28 / PX) +
        geometry(0, rect(box.width / PX, box.height / PX)) +
        `</Shape>`,
    );
  }

  for (const node of d.nodes) {
    const id = nextId++;
    nodeShape.set(node.id, { id, node, points: [] });
  }
  // Each edge end becomes a connection point where the edge meets its node, so imports keep the side it attaches to.
  const ends = d.edges.map((e) => {
    const from = nodeShape.get(e.from);
    const to = nodeShape.get(e.to);
    return {
      from: from && { shape: from, ix: from.points.push(e.start) - 1 },
      to: to && { shape: to, ix: to.points.push(e.end) - 1 },
    };
  });

  const occupied = new Set(instances.map((i) => i.state));
  for (const { id, node, points } of nodeShape.values()) {
    const w = node.width / PX;
    const h = node.height / PX;
    const status = node.status && STATUS[node.status];
    const pseudo = node.shape === "initial" || node.shape === "final" || node.shape === "choice";
    const lines = pseudo ? [] : labelLines(node.label);
    const detailed = lines.length > 1;
    // An occupied state gets the canvas's purple outline (unless a proposal colour already marks it).
    const line = status?.line ?? (occupied.has(node.id) && !pseudo ? INSTANCE.line : BORDER);
    const weight = status ? 2.2 : occupied.has(node.id) && !pseudo ? 2.4 : 1.6;
    shapes.push(
      `<Shape ID="${id}" NameU="${esc(node.id)}" Name="${esc(node.id)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        xform(X(node.x), Y(node.y + node.height), w, h) +
        cell("FillForegnd", node.shape === "final" ? "#ffffff" : (status?.fill ?? FILL[node.shape])) + cell("FillPattern", 1) +
        cell("LineColor", line) + cell("LineWeight", (node.shape === "final" ? 2 : weight) / PX) +
        cell("LinePattern", node.status === "removed" || node.shape === "any" ? 2 : 1) +
        cell("Rounding", node.shape === "action" ? 8 / PX : node.shape === "terminal" || node.shape === "any" ? h / 2 : node.shape === "state" ? 16 / PX : 0) +
        textMargins(node.shape, w, h) +
        // A choice is named by its id, written under the diamond as on the canvas.
        (node.shape === "choice"
          ? cell("TxtPinX", w / 2) + cell("TxtPinY", -8 / PX) + cell("TxtWidth", Math.max(w, (node.id.length * 7 + 8) / PX)) +
            cell("TxtHeight", 14 / PX) + cell("TxtLocPinX", Math.max(w, (node.id.length * 7 + 8) / PX) / 2) + cell("TxtLocPinY", 7 / PX)
          : "") +
        cell("VerticalAlign", detailed && node.shape !== "decision" ? 0 : 1) +
        characters(node.shape === "choice" ? "#6b7280" : node.status === "removed" ? "#7f1d1d" : INK, node.shape === "choice" ? 10.5 : 13, node.status === "removed") +
        paragraph(detailed && node.shape !== "decision" ? "left" : "center") +
        `<Section N="Connection">${points.map((p, ix) => row("Connection", ix, { X: (p.x - node.x) / PX, Y: (node.y + node.height - p.y) / PX })).join("")}</Section>` +
        (node.shape === "state" ? shapeData([["Value", node.id], ["Instances", String(instances.filter((i) => i.state === node.id).length)]]) : "") +
        outline(node.shape, w, h) +
        (node.shape === "choice" ? text([node.id], false) : node.shape === "any" ? text(["✱ Any state"], false) : pseudo ? "" : text(lines, detailed)) +
        `</Shape>`,
    );
    if (node.shape === "final") {
      const inset = Math.min(node.width, node.height) * 0.2;
      const dw = (node.width - 2 * inset) / PX;
      const dh = (node.height - 2 * inset) / PX;
      shapes.push(
        `<Shape ID="${nextId++}" NameU="${esc(node.id)} dot" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
          xform(X(node.x + inset), Y(node.y + node.height - inset), dw, dh) +
          cell("FillForegnd", FILL.final) + cell("FillPattern", 1) + cell("LinePattern", 0) +
          geometry(0, [ellipse(0, 0, dw, dh)]) +
          `</Shape>`,
      );
    }
    if (node.status) shapes.push(statusTag(nextId++, node, node.status, X, Y));
  }

  d.edges.forEach((e, i) => {
    const id = nextId++;
    const status = e.status && STATUS[e.status];
    const label = e.label?.trim();
    const labelW = label ? (Math.max(...label.split("\n").map((l) => l.length)) * 12 * 0.6 + 16) / PX : 0;
    const labelH = label ? (label.split("\n").length * 16 + 6) / PX : 0;
    const look =
      cell("BeginX", X(e.start.x)) + cell("BeginY", Y(e.start.y)) + cell("EndX", X(e.end.x)) + cell("EndY", Y(e.end.y)) +
      cell("ObjType", 2) +
      cell("LineColor", status?.line ?? EDGE) + cell("LineWeight", (status ? 2.4 : 1.6) / PX) +
      // Removed transitions, and those possible from every state ("any state"), are dashed as on the canvas.
      cell("LinePattern", e.status === "removed" || e.from === "any" ? 2 : 1) + cell("EndArrow", 13) + cell("EndArrowSize", 2);
    // The label: a box sized to its text, centred at (x, y) in the connector's own frame, turned by `angle` to read horizontally.
    const labelAt = (x: number, y: number, angle: number) =>
      label
        ? cell("TxtPinX", x) + cell("TxtPinY", y) + cell("TxtWidth", labelW) + cell("TxtHeight", labelH) +
          cell("TxtLocPinX", labelW / 2) + cell("TxtLocPinY", labelH / 2) + cell("TxtAngle", angle) + cell("TextBkgnd", status?.fill ?? "#ffffff")
        : "";
    // A Visio connector's frame: as long as the edge, turned to its angle, pinned at its middle, the begin point at its left.
    const xs = [X(e.start.x), X(e.end.x)];
    const ys = [Y(e.start.y), Y(e.end.y)];
    const length = Math.max(Math.hypot(xs[1] - xs[0], ys[1] - ys[0]), 0.01);
    const angle = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]);
    const curved = d.lines === "curved" && !!e.curve?.length;
    // A curve bows out of the line; the frame gets a height for its points to be fractions of.
    const height = curved ? 1 : 0;
    const local = (p: XY) => {
      const dx = X(p.x) - xs[0];
      const dy = Y(p.y) - ys[0];
      return { x: dx * Math.cos(angle) + dy * Math.sin(angle), y: height / 2 - dx * Math.sin(angle) + dy * Math.cos(angle) };
    };
    const rel = (p: XY) => ({ X: local(p).x / length, Y: local(p).y / height });
    const mid = curved ? local(e.mid ?? e.curve![Math.floor(e.curve!.length / 2)].c2) : { x: length / 2, y: 0 };
    const body =
      cell("PinX", (xs[0] + xs[1]) / 2) + cell("PinY", (ys[0] + ys[1]) / 2) + cell("Width", length) + cell("Height", height) +
      cell("LocPinX", length / 2) + cell("LocPinY", height / 2) + cell("Angle", angle) + look +
      labelAt(mid.x, mid.y, -angle) +
      characters(INK, 12) + paragraph("center") +
      geometry(
        0,
        curved
          ? [
              row("RelMoveTo", 1, rel(e.start)),
              ...e.curve!.map((c, ix) => {
                const [a, b, to] = [rel(c.c1), rel(c.c2), rel(c.to)];
                return row("RelCubBezTo", ix + 2, { X: to.X, Y: to.Y, A: a.X, B: a.Y, C: b.X, D: b.Y });
              }),
            ]
          : [row("MoveTo", 1, { X: 0, Y: 0 }), row("LineTo", 2, { X: length, Y: 0 })],
        { noFill: true },
      );
    shapes.push(
      `<Shape ID="${id}" NameU="${esc(e.id)}" Name="${esc(e.id)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        body +
        (label ? text([label], false) : "") +
        `</Shape>`,
    );
    const { from, to } = ends[i];
    if (from) connects.push(glue(id, "BeginX", 9, from.shape.id, from.ix));
    if (to) connects.push(glue(id, "EndX", 12, to.shape.id, to.ix));
  });

  // Instance chips: pills where the canvas shows them, their fields as Shape Data.
  for (const inst of instances) {
    const w = inst.width / PX;
    const h = inst.height / PX;
    shapes.push(
      `<Shape ID="${nextId++}" NameU="${esc(inst.id)}" Name="${esc(inst.label)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        xform(X(inst.x), Y(inst.y + inst.height), w, h) +
        cell("FillForegnd", INSTANCE.fill) + cell("FillPattern", 1) + cell("LineColor", INSTANCE.line) + cell("LineWeight", 1 / PX) +
        cell("Rounding", h / 2) + cell("LeftMargin", 6 / PX) + cell("RightMargin", 6 / PX) + cell("TopMargin", 0) + cell("BottomMargin", 0) +
        characters(INSTANCE.ink, 11.5) +
        paragraph("center") +
        shapeData([["Id", inst.id], ["State", inst.state], ...Object.entries(inst.fields ?? {})]) +
        geometry(0, rect(w, h)) +
        text([`● ${inst.label}`], true) +
        `</Shape>`,
    );
  }

  if (legend) {
    const { box, lines } = legend;
    shapes.push(
      `<Shape ID="${nextId++}" NameU="States legend" Name="States" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        xform(X(box.x), Y(box.y + box.height), box.width / PX, box.height / PX) +
        cell("FillForegnd", "#ffffff") + cell("FillPattern", 1) + cell("LineColor", "#d0d7de") + cell("LineWeight", 1 / PX) + cell("Rounding", 8 / PX) +
        cell("LeftMargin", 10 / PX) + cell("RightMargin", 10 / PX) + cell("TopMargin", 8 / PX) + cell("BottomMargin", 8 / PX) +
        cell("VerticalAlign", 0) +
        characters(INK, LEGEND_FONT) +
        paragraph("left") +
        geometry(0, rect(box.width / PX, box.height / PX)) +
        text(lines, true) +
        `</Shape>`,
    );
  }

  // Notes last so they sit on top.
  for (const { mark, note, lines } of notes) {
    const color = KIND_COLOR[mark.kind ?? "none"];
    shapes.push(
      `<Shape ID="${nextId++}" NameU="Mark ${mark.id}" Name="Mark #${mark.id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
        xform(X(note.x), Y(note.y + note.height), note.width / PX, note.height / PX) +
        cell("FillForegnd", "#ffffff") + cell("FillPattern", 1) +
        cell("LineColor", color) + cell("LineWeight", 2 / PX) + cell("Rounding", 8 / PX) +
        cell("LeftMargin", 8 / PX) + cell("RightMargin", 8 / PX) + cell("TopMargin", 6 / PX) + cell("BottomMargin", 6 / PX) +
        cell("VerticalAlign", 0) +
        characters(INK, NOTE_FONT) +
        paragraph("left") +
        geometry(0, rect(note.width / PX, note.height / PX)) +
        text(lines, true) +
        `</Shape>`,
    );
  }

  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/app.xml", data: APP },
    { name: "docProps/core.xml", data: core(d.title) },
    { name: "visio/document.xml", data: DOCUMENT },
    { name: "visio/_rels/document.xml.rels", data: rels([["pages", "pages/pages.xml"]]) },
    { name: "visio/pages/pages.xml", data: pages(d.title, pageW, pageH) },
    { name: "visio/pages/_rels/pages.xml.rels", data: rels([["page", "page1.xml"]]) },
    {
      name: "visio/pages/page1.xml",
      data: `${XML}<PageContents ${NS} xml:space="preserve"><Shapes>${shapes.join("")}</Shapes>${connects.length ? `<Connects>${connects.join("")}</Connects>` : ""}</PageContents>`,
    },
  ]);
}

/** The States legend as one text box: a title, then a line per state; placed left of the diagram, top-aligned. */
function legendBox(rows: ExportLegendRow[], notes: string[], drawn: Box[]) {
  const lines = [
    `STATES (${rows.length})`,
    ...rows.map((r) => {
      const [title] = r.label.split("\n");
      return `${title}${title !== r.id ? ` [${r.id}]` : ""}${r.tags.length ? ` (${r.tags.join(", ")})` : ""}${r.count ? ` · ${r.count}` : ""}`;
    }),
    ...(notes.length ? ["", ...notes] : []),
  ];
  const height = wrappedLines(lines.join("\n"), LEGEND_WIDTH - 20, LEGEND_FONT) * LEGEND_FONT * 1.4 + 18;
  const left = Math.min(...drawn.map((b) => b.x));
  const top = Math.min(...drawn.map((b) => b.y));
  return { lines, box: { x: left - LEGEND_WIDTH - 48, y: top, width: LEGEND_WIDTH, height } };
}

/** The note for a mark: its kind and text, then the thread; placed above the outline like the badge on the canvas. */
function markNote({ mark, box, outline }: ExportMark) {
  const kind = KIND_META[mark.kind ?? "none"];
  const author = mark.by === "agent" ? `${mark.agent ?? "Agent"} asks: ` : "";
  const lines = [
    `#${mark.id} ${kind.icon} ${kind.label}`,
    ...(mark.text ? [`${author}${mark.text}`] : []),
    ...(mark.replies ?? []).map((r) => `${r.by === "agent" ? (r.agent ?? "Agent") : "You"}: ${r.text}`),
  ];
  const height = wrappedLines(lines.join("\n"), NOTE_WIDTH - 16, NOTE_FONT) * NOTE_FONT * 1.35 + 16;
  // Overlaps the top of an outline like the badge does; clears an edge label.
  return { lines, note: { x: box.x - 10, y: box.y - height + (outline === false ? -6 : 4), width: NOTE_WIDTH, height } };
}

function statusTag(id: number, node: ExportNode, status: ChangeStatus, X: (x: number) => number, Y: (y: number) => number) {
  const label = STATUS_META[status].label.toUpperCase();
  const w = label.length * 7 + 10;
  const h = 15;
  const x = node.shape === "decision" ? node.x + node.width / 2 - w / 2 : node.x + node.width - 8 - w;
  const y = node.shape === "decision" ? node.y + node.height - 2 - h : node.y + node.height + 9 - h;
  return (
    `<Shape ID="${id}" NameU="${esc(node.id)} status" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
    xform(X(x), Y(y + h), w / PX, h / PX) +
    cell("FillForegnd", STATUS[status].line) + cell("FillPattern", 1) + cell("LinePattern", 0) + cell("Rounding", 3 / PX) +
    cell("LeftMargin", 0) + cell("RightMargin", 0) + cell("TopMargin", 0) + cell("BottomMargin", 0) +
    characters("#ffffff", 9.5) +
    paragraph("center") +
    geometry(0, rect(w / PX, h / PX)) +
    text([label], true) +
    `</Shape>`
  );
}

/** Position and size, with the pin at the centre; `left`/`bottom` in page inches. */
const xform = (left: number, bottom: number, w: number, h: number) =>
  cell("PinX", left + w / 2) + cell("PinY", bottom + h / 2) + cell("Width", w) + cell("Height", h) +
  cell("LocPinX", w / 2) + cell("LocPinY", h / 2) + cell("Angle", 0);

const rect = (w: number, h: number) => [
  row("MoveTo", 1, { X: 0, Y: 0 }),
  row("LineTo", 2, { X: w, Y: 0 }),
  row("LineTo", 3, { X: w, Y: h }),
  row("LineTo", 4, { X: 0, Y: h }),
  row("LineTo", 5, { X: 0, Y: 0 }),
];

/** An ellipse filling the box at (x, y) of size w×h, in a shape's local inches. */
const ellipse = (x: number, y: number, w: number, h: number) =>
  row("Ellipse", 1, { X: x + w / 2, Y: y + h / 2, A: x + w, B: y + h / 2, C: x + w / 2, D: y + h });

function outline(shape: GraphNode["shape"], w: number, h: number) {
  // The final state's ring; its dot is a shape of its own (one shape has one fill colour).
  if (shape === "initial" || shape === "final") return geometry(0, [ellipse(0, 0, w, h)]);
  if (shape === "decision" || shape === "choice")
    return geometry(0, [
      row("MoveTo", 1, { X: w / 2, Y: 0 }),
      row("LineTo", 2, { X: w, Y: h / 2 }),
      row("LineTo", 3, { X: w / 2, Y: h }),
      row("LineTo", 4, { X: 0, Y: h / 2 }),
      row("LineTo", 5, { X: w / 2, Y: 0 }),
    ]);
  if (shape === "store") {
    // A cylinder: the body with elliptical caps, then the front rim of the lid.
    const ry = Math.min(h * 0.12, w / 4);
    const ratio = w / 2 / ry;
    return (
      geometry(0, [
        row("MoveTo", 1, { X: 0, Y: ry }),
        row("EllipticalArcTo", 2, { X: w, Y: ry, A: w / 2, B: 0, C: 0, D: ratio }),
        row("LineTo", 3, { X: w, Y: h - ry }),
        row("EllipticalArcTo", 4, { X: 0, Y: h - ry, A: w / 2, B: h, C: 0, D: ratio }),
        row("LineTo", 5, { X: 0, Y: ry }),
      ]) +
      geometry(1, [row("MoveTo", 1, { X: 0, Y: h - ry }), row("EllipticalArcTo", 2, { X: w, Y: h - ry, A: w / 2, B: h - 2 * ry, C: 0, D: ratio })], {
        noFill: true,
      })
    );
  }
  return geometry(0, rect(w, h));
}

/** Text insets matching the canvas padding, so text wraps inside the diamond and below the cylinder lid. */
function textMargins(shape: GraphNode["shape"], w: number, h: number) {
  const m =
    shape === "decision"
      ? { l: w * 0.22, r: w * 0.22, t: h * 0.12, b: h * 0.12 }
      : shape === "store"
        ? { l: 12 / PX, r: 12 / PX, t: 22 / PX, b: 10 / PX }
        : { l: 12 / PX, r: 12 / PX, t: 10 / PX, b: 10 / PX };
  return cell("LeftMargin", m.l) + cell("RightMargin", m.r) + cell("TopMargin", m.t) + cell("BottomMargin", m.b);
}

/**
 * A straight edge whose canvas end points away from the other end (a back edge leaving a node's bottom to loop up
 * round the side into its target's top) would cut through both nodes: that end moves to the middle of the side facing the other node.
 */
function facing(e: ExportEdge, nodes: ExportNode[]): ExportEdge {
  const from = nodes.find((n) => n.id === e.from);
  const to = nodes.find((n) => n.id === e.to);
  const centre = (n: ExportNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
  const side = (n: ExportNode, toward: XY): XY => {
    const c = centre(n);
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    return Math.abs(dy) * n.width >= Math.abs(dx) * n.height
      ? { x: c.x, y: dy < 0 ? n.y : n.y + n.height }
      : { x: dx < 0 ? n.x : n.x + n.width, y: c.y };
  };
  // Heading into its own node: the step from the end towards the other end points back past the node's centre.
  const away = (n: ExportNode, p: XY, other: XY) => {
    const c = centre(n);
    return (p.x - c.x) * (other.x - p.x) + (p.y - c.y) * (other.y - p.y) < 0;
  };
  let { start, end } = e;
  if (from && to && from !== to) {
    if (away(from, start, end)) start = side(from, centre(to));
    if (away(to, end, start)) end = side(to, centre(from));
  }
  return { ...e, start, end };
}

/** Points along a connector as drawn, for sizing the page and a curve's box (its control points can lie well outside the curve). */
function edgePoints(e: ExportEdge, lines: ExportDiagram["lines"]): XY[] {
  if (lines !== "curved" || !e.curve?.length) return [e.start, e.end];
  const points = [e.start];
  let from = e.start;
  for (const { c1, c2, to } of e.curve) {
    for (let k = 1; k <= 12; k++) {
      const t = k / 12;
      const [a, b, c, d] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
      points.push({ x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y });
    }
    from = to;
  }
  return points;
}

/** Glues an end of connector `from` to connection point `ix` of shape `to`. */
const glue = (from: number, end: "BeginX" | "EndX", fromPart: number, to: number, ix: number) =>
  `<Connect FromSheet="${from}" FromCell="${end}" FromPart="${fromPart}" ToSheet="${to}" ToCell="Connections.X${ix + 1}" ToPart="${100 + ix}"/>`;

// --- package parts -------------------------------------------------------------

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const NS = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.microsoft.com/visio/2010/relationships";

const CONTENT_TYPES =
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>` +
  `<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>` +
  `<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL}/document" Target="visio/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

const rels = (list: Array<[string, string]>) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  list.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${REL}/${type}" Target="${target}"/>`).join("") +
  `</Relationships>`;

const APP =
  `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
  `<Application>Visual Agent Canvas</Application></Properties>`;

const core = (title: string) =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `<dc:title>${esc(title)}</dc:title>` +
  `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created>` +
  `</cp:coreProperties>`;

/** One style every shape uses; the shapes set their own colours, so it only supplies defaults. */
const DOCUMENT =
  `${XML}<VisioDocument ${NS} xml:space="preserve">` +
  `<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">` +
  cell("GlueSettings", 9) + cell("SnapSettings", 65847) + cell("DynamicGridEnabled", 0) +
  `</DocumentSettings>` +
  `<Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors>` +
  `<FaceNames><FaceName NameU="Calibri" UnicodeRanges="-536859905 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/></FaceNames>` +
  `<StyleSheets><StyleSheet ID="0" NameU="No Style" Name="No Style">` +
  cell("EnableLineProps", 1) + cell("EnableFillProps", 1) + cell("EnableTextProps", 1) + cell("HideForApply", 0) +
  cell("LineWeight", 1 / PX) + cell("LineColor", "#000000") + cell("LinePattern", 1) + cell("Rounding", 0) +
  cell("BeginArrow", 0) + cell("EndArrow", 0) + cell("BeginArrowSize", 2) + cell("EndArrowSize", 2) + cell("LineCap", 0) +
  cell("FillForegnd", "#FFFFFF") + cell("FillBkgnd", "#FFFFFF") + cell("FillPattern", 1) + cell("FillForegndTrans", 0) +
  cell("ShdwPattern", 0) + cell("TextBkgnd", 0) +
  cell("LeftMargin", 4 / PX) + cell("RightMargin", 4 / PX) + cell("TopMargin", 4 / PX) + cell("BottomMargin", 4 / PX) +
  cell("VerticalAlign", 1) + cell("TextDirection", 0) +
  `<Section N="Character"><Row IX="0">${cell("Font", "Calibri")}${cell("Color", "#000000")}${font(13)}${cell("Style", 0)}</Row></Section>` +
  `<Section N="Paragraph"><Row IX="0">${cell("HorzAlign", 1)}${cell("SpLine", -1.2)}</Row></Section>` +
  `</StyleSheet></StyleSheets></VisioDocument>`;

const pages = (title: string, w: number, h: number) =>
  `${XML}<Pages ${NS} xml:space="preserve"><Page ID="0" NameU="${esc(title)}" Name="${esc(title)}">` +
  `<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">` +
  cell("PageWidth", w) + cell("PageHeight", h) + cell("PageScale", 1, "IN_F") + cell("DrawingScale", 1, "IN_F") +
  cell("DrawingSizeType", 0) + cell("DrawingScaleType", 0) + cell("InhibitSnap", 0) +
  `</PageSheet><Rel r:id="rId1"/></Page></Pages>`;
