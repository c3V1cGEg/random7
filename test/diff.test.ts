import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasStore } from "../server/store.ts";
import { comparisonState, diffRevisions, lineDiff } from "../client/src/diff.ts";
import type { SeqMessage } from "../server/sequence.ts";

const summary = (d: ReturnType<typeof diffRevisions>) => d.elements.map((c) => `${c.change} ${c.type} ${c.id}${c.fields.length ? ` (${c.fields.join(",")})` : ""}`);

test("compare: flowchart elements, marks, moves and the Mermaid text between two revisions", () => {
  const s = new CanvasStore("t");
  s.replaceDiagram(0, "flowchart TD\n  a[Start] --> b[Check]\n  b --> c[Done]", "keep", "agent");
  s.setLayout({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 0, y: 200 } });
  s.applyPatch(s.revision, [{ op: "add_annotation", nodeIds: ["b"], text: "Why?" }], "user");
  const from = s.revision;
  const ab = s.browserState().edges.find((e) => e.from === "a")!.id;
  const bc = s.browserState().edges.find((e) => e.from === "b")!.id;
  s.applyPatch(
    s.revision,
    [
      { op: "update_node", id: "b", label: "Check stock" },
      { op: "remove_node", id: "c" },
      { op: "add_node", id: "d", label: "Ship", shape: "action" },
      { op: "add_edge", from: "b", to: "d" },
      { op: "update_annotation", id: 1, kind: "question" },
      { op: "reply_annotation", id: 1, text: "Because" },
    ],
    "user",
  );
  s.setLayout({ a: { x: 40, y: 0 } });
  const a = s.revisionState(from);
  const b = s.browserState();
  const d = diffRevisions(a, b);
  assert.equal(d.from, from);
  const newEdge = b.edges.find((e) => e.to === "d")!.id;
  assert.deepEqual(summary(d).sort(), [
    `added edge ${newEdge}`,
    "added node d",
    "changed node b (text)",
    `removed edge ${bc}`,
    "removed node c",
  ]);
  assert.equal(d.elements.find((c) => c.id === "b")!.before, "Check");
  assert.match(d.elements.find((c) => c.id === newEdge)!.name, /Check stock → Ship/);
  assert.deepEqual(d.marks.map((m) => [m.id, m.change, m.fields, m.newReplies]), [[1, "changed", ["kind", "replies"], 1]]);
  assert.deepEqual(d.moved, ["a"]);
  assert.ok(!d.elements.some((c) => c.id === ab));
  assert.ok(d.text.some((l) => l.op === "-" && l.line.includes("Done")));
  assert.ok(d.text.some((l) => l.op === "+" && l.line.includes("Ship")));

  // Drawn as the newer revision with the removed elements put back where they were.
  const shown = comparisonState(a, b, d);
  assert.deepEqual(shown.nodes.map((n) => [n.id, n.status]), [["c", "removed"], ["a", undefined], ["b", "changed"], ["d", "new"]]);
  assert.deepEqual(shown.layout.c, { x: 0, y: 200 });
  assert.equal(shown.edges.find((e) => e.id === bc)?.status, "removed");
  assert.deepEqual(shown.history, { undo: [], redo: [] });
});

test("compare: sequence messages changed, added and moved in order", () => {
  const s = new CanvasStore("t");
  s.replaceDiagram(0, "sequenceDiagram\n  participant A\n  participant B\n  A->>B: one\n  B->>A: two\n  A->>B: three", "keep", "agent");
  const a = s.browserState();
  const b = structuredClone(a);
  const [m1, m2, m3] = b.sequence.items as SeqMessage[];
  m2.text = "TWO";
  b.sequence.items = [m3, m1, m2, { ...m1, id: "m99", text: "four" }];
  const d = diffRevisions(a, b);
  const byId = new Map(d.elements.map((c) => [c.id, c]));
  assert.equal(byId.get("m99")?.change, "added");
  assert.deepEqual(byId.get(m2.id)?.fields, ["text"]);
  assert.equal(byId.get(m2.id)?.before, "two");
  assert.deepEqual(byId.get(m3.id)?.fields, ["position"], "the one that moved to the top");
  assert.ok(!byId.has(m1.id));
  const shown = comparisonState(a, b, d);
  assert.deepEqual(shown.sequence.items.map((i) => i.status), ["changed", undefined, "changed", "new"]);
});

test("line diff keeps common lines and marks the rest", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc\nd").map((l) => l.op + l.line), [" a", "+x", "-b", " c", "+d"]);
  assert.deepEqual(lineDiff("", "a"), [{ op: "+", line: "a" }]);
});
