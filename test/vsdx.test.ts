import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVsdx, cubics } from "../client/src/vsdx.ts";

/** Reads a stored (uncompressed) zip back into name → text, checking each entry's CRC-free framing. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  const text = new TextDecoder();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    assert.equal(view.getUint16(at + 8, true), 0, "stored");
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = text.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    files.set(name, text.decode(bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size)));
    at += 30 + nameLength + size;
  }
  return files;
}

test("vsdx export: shapes where the nodes are, glued connectors, marks as outline + note", () => {
  const files = unzip(
    buildVsdx({
      title: "Upload & scan",
      nodes: [
        { id: "a", label: "Upload", shape: "terminal", x: 0, y: 0, width: 160, height: 44 },
        { id: "b", label: "Scan\n+ archives", shape: "action", status: "changed", x: 0, y: 192, width: 180, height: 72 },
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "next <1>", start: { x: 80, y: 44 }, end: { x: 90, y: 192 } }],
      marks: [
        { mark: { id: 1, nodeIds: ["b"], edgeIds: [], kind: "question", text: "Why?", replies: [{ by: "agent", text: "Because", at: "" }] }, box: { x: -16, y: 176, width: 212, height: 104 } },
        { mark: { id: 2, nodeIds: [], edgeIds: ["e1"], text: "Edge note" }, box: { x: 60, y: 110, width: 40, height: 20 }, outline: false },
      ],
      lines: "straight",
    }),
  );
  assert.deepEqual([...files.keys()].filter((n) => n.startsWith("visio/")), [
    "visio/document.xml",
    "visio/_rels/document.xml.rels",
    "visio/pages/pages.xml",
    "visio/pages/_rels/pages.xml.rels",
    "visio/pages/page1.xml",
  ]);
  const page = files.get("visio/pages/page1.xml")!.replace(/<cp IX="\d"\/>/g, "");
  // 1 outline (the edge-only mark has none), 2 nodes, 1 status tag, 1 connector, 2 notes.
  assert.equal(page.match(/<Shape /g)?.length, 7);
  assert.equal(page.match(/<Connect /g)?.length, 2);
  assert.match(page, /FromCell="BeginX"[^>]*ToSheet="2"/);
  assert.match(page, /FromCell="EndX"[^>]*ToSheet="3"/);
  assert.match(page, /next &lt;1&gt;/);
  // Six rectangles of four lines each (outline, 2 nodes, tag, 2 notes), and one straight segment for the connector.
  assert.equal(page.match(/<Row T="LineTo"/g)?.length, 6 * 4 + 1);
  assert.match(page, /#1 \? Question\nWhy\?\nAgent: Because/);
  assert.match(page, /#2 # Note\nEdge note/);
  assert.match(page, /\+ archives/);
  assert.match(files.get("visio/pages/pages.xml")!, /Name="Upload &amp; scan"/);
});

test("vsdx export: canvas edge paths read as cubic pieces", () => {
  assert.deepEqual(cubics("M 0,0 C 0,70 100,70 100,35 S 200,0 200,70"), {
    start: { x: 0, y: 0 },
    curve: [
      { c1: { x: 0, y: 70 }, c2: { x: 100, y: 70 }, to: { x: 100, y: 35 } },
      { c1: { x: 100, y: 0 }, c2: { x: 200, y: 0 }, to: { x: 200, y: 70 } },
    ],
  });
  assert.deepEqual(cubics("M0,0L30,60")?.curve, [{ c1: { x: 10, y: 20 }, c2: { x: 20, y: 40 }, to: { x: 30, y: 60 } }]);
  assert.equal(cubics("M 0,0 A 5 5 0 0 1 10,10"), null);
});

// A back edge as the canvas draws it: out of the bottom of "b", round the side, into the top of "a" above it.
const loop = {
  title: "Loop",
  nodes: [
    { id: "a", label: "A", shape: "action" as const, x: 0, y: 0, width: 100, height: 40 },
    { id: "b", label: "B", shape: "action" as const, x: 0, y: 200, width: 100, height: 40 },
  ],
  edges: [
    {
      id: "back", from: "b", to: "a", label: "again",
      start: { x: 50, y: 240 }, end: { x: 50, y: 0 }, mid: { x: 180, y: 120 },
      curve: cubics("M 50,240 C 50,310 180,310 180,120 S 50,-70 50,0")!.curve,
    },
  ],
  marks: [],
};
const page = (lines: "curved" | "straight") =>
  unzip(buildVsdx({ ...loop, lines })).get("visio/pages/page1.xml")!;
const cellOf = (xml: string, name: string) => Number(xml.match(new RegExp(`<Cell N="${name}" V="([^"]+)"`))![1]);

test("vsdx export: curved lines follow the drawn curve", () => {
  const xml = page("curved");
  assert.equal(xml.match(/<Row T="RelCubBezTo"/g)?.length, 2);
  assert.equal(xml.match(/<Row T="LineTo"/g)?.length, 2 * 4); // just the two nodes
  const edge = xml.slice(xml.indexOf('NameU="back"'));
  // Leaves the bottom of b, arrives at the top of a: begin below end.
  assert.ok(cellOf(edge, "BeginY") < cellOf(edge, "EndY") - 2);
});

test("vsdx export: straight back edges leave the side facing their target", () => {
  const xml = page("straight");
  const edge = xml.slice(xml.indexOf('NameU="back"'));
  // Now from the top of b (y 200) to the bottom of a (y 40): 160 px apart, not 240.
  assert.ok(Math.abs(cellOf(edge, "EndY") - cellOf(edge, "BeginY") - 160 / 96) < 1e-3);
});

test("vsdx export: state diagrams get dots, a labelled choice, instance chips with Shape Data and a States legend", () => {
  const page = unzip(
    buildVsdx({
      title: "Orders",
      nodes: [
        { id: "initial", label: "Start", shape: "initial", x: 0, y: 12, width: 28, height: 28 },
        { id: "Draft", label: "Draft", shape: "state", x: 80, y: 0, width: 160, height: 52 },
        { id: "ok", label: "ok", shape: "choice", x: 300, y: 4, width: 44, height: 44 },
        { id: "final", label: "End", shape: "final", x: 400, y: 9, width: 34, height: 34 },
      ],
      edges: [{ id: "e1", from: "initial", to: "Draft", start: { x: 28, y: 26 }, end: { x: 80, y: 26 } }],
      marks: [],
      lines: "straight",
      instances: [{ id: "o1", label: "Order #1", state: "Draft", fields: { "total amount": "€5 & more" }, x: 110, y: 58, width: 90, height: 20 }],
      legend: [{ id: "Draft", label: "Draft", count: 1, tags: ["start"] }],
    }),
  ).get("visio/pages/page1.xml")!;
  const shape = (name: string) => page.match(new RegExp(`<Shape ID="\\d+" NameU="${name}"[^>]*>[\\s\\S]*?</Shape>`))?.[0] ?? "";
  // [*] are ellipses without text; the final ring has a separate filled dot.
  assert.match(shape("initial"), /<Row T="Ellipse"/);
  assert.doesNotMatch(shape("initial"), /<Text>/);
  assert.match(shape("final dot"), /<Row T="Ellipse"/);
  // The choice is a diamond, its id written under it.
  assert.match(shape("ok"), /<Text><cp IX="0"\/>ok<\/Text>/);
  assert.match(shape("ok"), /<Cell N="TxtPinY" V="-/);
  // A state: rounded, its enum value as Shape Data, purple outline while an instance is in it.
  assert.match(shape("Draft"), /<Cell N="Rounding" V="0.1667"\/>/);
  assert.match(shape("Draft"), /<Row N="Value"><Cell N="Value" V="Draft" U="STR"\/>/);
  assert.match(shape("Draft"), /<Cell N="LineColor" V="#7c4dff"\/>/);
  // The instance chip carries its fields (escaped) as Shape Data.
  assert.match(shape("o1"), /● Order #1/);
  assert.match(shape("o1"), /<Row N="total_amount"><Cell N="Value" V="€5 &amp; more" U="STR"\/><Cell N="Label" V="total amount"\/>/);
  // The legend sits left of the drawing.
  assert.match(shape("States legend"), /STATES \(1\)\n<cp IX="0"\/>Draft \(start\) · 1/);
});
