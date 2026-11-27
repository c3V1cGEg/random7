import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMermaid, toMermaid } from "../server/mermaid.ts";
import { OperationSchema } from "../server/ops.ts";
import { CanvasStore } from "../server/store.ts";
import { CanvasError } from "../server/types.ts";

const SPEC_EXAMPLE = `flowchart TD
    n1["Select next eligible records"]
    n2["Process selected batch atomically"]
    n3{"Batch succeeded?"}
    n4["Commit changes"]
    n5["Rollback changes"]
    n6["Next selection cycle"]
    n1 e1@--> n2
    n2 e2@--> n3
    n3 e3@-->|Yes| n4
    n3 e4@-->|No| n5
    n4 e5@--> n6
    n5 e6@--> n6`;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanvasError, `expected CanvasError, got ${err}`);
    return err.code;
  }
  assert.fail("expected an error");
}

test("parses the spec example and round-trips", () => {
  const { graph, generatedEdgeIds } = parseMermaid(SPEC_EXAMPLE);
  assert.equal(graph.nodes.length, 6);
  assert.equal(graph.edges.length, 6);
  assert.deepEqual(generatedEdgeIds, []);
  assert.equal(graph.nodes[2].shape, "decision");
  assert.equal(graph.edges[2].label, "Yes");
  const again = parseMermaid(toMermaid(graph)).graph;
  assert.deepEqual(again, graph);
});

test("parses inline node definitions, terminals, escapes and generated edge ids", () => {
  const { graph, generatedEdgeIds } = parseMermaid(`flowchart LR
  s(["Start"]) --> a["Say #quot;hi#quot;"]
  a e7@-->|"ok | fine"| b{Done?}`);
  assert.equal(graph.direction, "LR");
  assert.equal(graph.nodes.find((n) => n.id === "s")?.shape, "terminal");
  assert.equal(graph.nodes.find((n) => n.id === "a")?.label, 'Say "hi"');
  assert.equal(graph.edges[1].label, "ok | fine");
  assert.deepEqual(generatedEdgeIds, ["e1"]);
  assert.match(toMermaid(graph), /Say #quot;hi#quot;/);
});

test("rejects unsupported constructs clearly", () => {
  for (const src of [
    "flowchart TD\n subgraph x\n a-->b\n end",
    "flowchart TD\n a -.-> b",
    "flowchart TD\n a --> b --> c",
    "flowchart TD\n a & b --> c",
    "sequenceDiagram\n a->>b: hi",
    "flowchart TD\n a((circle))",
    "flowchart TD\n a e1@--> b\n b e1@--> c",
    "flowchart TD\n a[\"x\"]\n a[\"y\"]",
    "flowchart TD\n a e1@--> e1",
  ]) {
    assert.ok(["mermaid_syntax", "invalid_id"].includes(code(() => parseMermaid(src))), src);
  }
});

test("patches are atomic and revision-checked", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  assert.equal(s.revision, 1);
  const before = s.snapshot();
  assert.equal(
    code(() =>
      s.applyPatch(1, [
        { op: "update_node", id: "n2", label: "changed" },
        { op: "update_node", id: "nope", label: "x" },
      ], "agent"),
    ),
    "not_found",
  );
  assert.deepEqual(s.snapshot(), before, "failed patch must not mutate");
  assert.equal(code(() => s.applyPatch(0, [{ op: "remove_edge", id: "e1" }], "agent")), "revision_conflict");
  assert.equal(code(() => s.applyPatch(1, [{ op: "add_node", id: "e1", label: "clash" }], "agent")), "duplicate_id");
});

test("annotation ids are monotonic and never reused; reset restarts numbering", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  const r1 = s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n1", "n2"], text: "starve?" }], "user");
  assert.deepEqual(r1.createdAnnotationIds, [1]);
  s.applyPatch(2, [{ op: "remove_annotation", id: 1 }], "user");
  const r2 = s.applyPatch(3, [{ op: "add_annotation", edgeIds: ["e4"], kind: "question" }], "user");
  assert.deepEqual(r2.createdAnnotationIds, [2]);
  s.reset("user");
  assert.equal(s.snapshot().annotations.length, 0);
  assert.equal(s.snapshot().diagram, "flowchart TD");
  const r3 = s.applyPatch(s.revision, [{ op: "add_node", label: "x" }], "user");
  s.applyPatch(r3.revision, [{ op: "add_annotation", nodeIds: r3.createdNodeIds }], "user");
  assert.equal(s.snapshot().annotations[0].id, 1);
});

test("removing targets prunes annotations and flags orphans deterministically", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  s.applyPatch(1, [
    { op: "add_annotation", nodeIds: ["n5"], edgeIds: ["e1"], text: "a" },
    { op: "add_annotation", edgeIds: ["e4"], text: "b" },
  ], "user");
  const res = s.applyPatch(2, [{ op: "remove_node", id: "n5" }], "agent");
  // n5 had incident edges e4 and e6
  const removedEdges = res.sideEffects!.filter((x) => x.op === "remove_edge").map((x) => x.id);
  assert.deepEqual(removedEdges.sort(), ["e4", "e6"]);
  const [a1, a2] = s.snapshot().annotations;
  assert.deepEqual([a1.nodeIds, a1.edgeIds, a1.orphaned], [[], ["e1"], undefined]);
  assert.deepEqual([a2.nodeIds, a2.edgeIds, a2.orphaned, a2.text], [[], [], true, "b"]);
  assert.ok(!s.snapshot().diagram.includes("n5"));
});

test("generated ids are not reused after deletion", () => {
  const s = new CanvasStore();
  const a = s.applyPatch(0, [{ op: "add_node", label: "a" }, { op: "add_node", label: "b" }], "user");
  assert.deepEqual(a.createdNodeIds, ["n1", "n2"]);
  s.applyPatch(1, [{ op: "remove_node", id: "n2" }], "user");
  const b = s.applyPatch(2, [{ op: "add_node", label: "c" }], "user");
  assert.deepEqual(b.createdNodeIds, ["n3"]);
});

test("changesSince reports semantic ops and falls back to snapshot", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  s.applyPatch(1, [{ op: "update_node", id: "n3", label: "All records OK?" }], "user");
  const c = s.changesSince(1);
  assert.ok("changes" in c);
  assert.deepEqual(c.changes, [
    { revision: 2, source: "user", ops: [{ op: "update_node", id: "n3", label: "All records OK?" }] },
  ]);
  const none = s.changesSince(2);
  assert.ok("changes" in none && none.changes.length === 0);
  s.reset("user");
  assert.ok("snapshotRequired" in s.changesSince(1));
  assert.ok("snapshotRequired" in s.changesSince(99));
});

test("replace with keep preserves marks on surviving ids", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n1", "n6"], text: "keep me" }], "user");
  s.replaceDiagram(2, SPEC_EXAMPLE.replace(/\n.*n6.*/g, ""), "keep", "agent");
  const [a] = s.snapshot().annotations;
  assert.deepEqual([a.id, a.nodeIds, a.text], [1, ["n1"], "keep me"]);
});

// --- undo / redo ---------------------------------------------------------------

function demo() {
  const s = new CanvasStore();
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent");
  return s;
}

test("undo/redo restores the user's own edit and keeps the agent's out of history", () => {
  const s = demo();
  assert.equal(s.browserState().history.undo.length, 0, "agent drawing is not undoable by the user");
  s.applyPatch(1, [{ op: "update_node", id: "n2", label: "Renamed" }], "user");
  const undone = s.undo();
  assert.deepEqual(undone.ops, [{ op: "update_node", id: "n2", label: "Process selected batch atomically", shape: "action" }]);
  assert.match(s.snapshot().diagram, /n2\["Process selected batch atomically"\]/);
  s.redo();
  assert.match(s.snapshot().diagram, /n2\["Renamed"\]/);
  assert.equal(code(() => s.redo()), "nothing_to_redo");
});

test("grouped patches undo as one step", () => {
  const s = demo();
  const a = s.applyPatch(1, [{ op: "add_node", label: "New step" }], "user", "g1");
  const id = a.createdNodeIds![0];
  s.applyPatch(2, [{ op: "add_edge", from: "n6", to: id }], "user", "g1");
  s.applyPatch(3, [{ op: "update_node", id, label: "Emit metrics" }], "user", "g1");
  assert.equal(s.browserState().history.undo.length, 1);
  s.undo();
  assert.equal(s.browserState().nodes.length, 6);
  assert.equal(s.browserState().edges.length, 6);
  s.redo();
  assert.match(s.snapshot().diagram, new RegExp(`${id}\\["Emit metrics"\\]`));
  assert.match(s.snapshot().diagram, new RegExp(`n6 e\\d+@--> ${id}`));
});

test("undoing a node deletion restores incident edges and mark targets with the same ids", () => {
  const s = demo();
  s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n5"], edgeIds: ["e4"], text: "x" }], "user");
  const before = s.snapshot();
  s.applyPatch(2, [{ op: "remove_node", id: "n5" }], "user");
  assert.equal(s.snapshot().annotations[0].orphaned, true);
  s.undo();
  const after = s.snapshot();
  assert.deepEqual(after.annotations, before.annotations);
  assert.deepEqual(new Set(after.diagram.split("\n")), new Set(before.diagram.split("\n")));
});

test("undoing a mark deletion brings back the same number; new marks still get fresh numbers", () => {
  const s = demo();
  s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n1"], text: "keep" }], "user");
  s.applyPatch(2, [{ op: "remove_annotation", id: 1 }], "user");
  s.undo();
  assert.equal(s.snapshot().annotations[0].id, 1);
  const r = s.applyPatch(s.revision, [{ op: "add_annotation", nodeIds: ["n2"] }], "user");
  assert.deepEqual(r.createdAnnotationIds, [2]);
  assert.equal(s.browserState().history.redo.length, 0, "a new user edit clears redo");
});

test("undo refuses to overwrite a later agent change and leaves the state untouched", () => {
  const s = demo();
  s.applyPatch(1, [{ op: "update_node", id: "n2", label: "User label" }], "user");
  s.applyPatch(2, [{ op: "update_node", id: "n2", label: "Agent label" }], "agent");
  const before = s.snapshot();
  assert.equal(code(() => s.undo()), "undo_conflict");
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.browserState().history.undo.length, 0, "the conflicting step is dropped");
});

test("undo refuses to orphan something the agent attached later", () => {
  const s = demo();
  const r = s.applyPatch(1, [{ op: "add_node", label: "User node" }], "user");
  const id = r.createdNodeIds![0];
  s.applyPatch(2, [{ op: "add_edge", from: "n1", to: id }], "agent");
  assert.equal(code(() => s.undo()), "undo_conflict");
  assert.ok(s.snapshot().diagram.includes(id));
});

test("unrelated agent edits do not block undo", () => {
  const s = demo();
  s.applyPatch(1, [{ op: "update_node", id: "n2", label: "User label" }], "user");
  s.applyPatch(2, [{ op: "update_node", id: "n4", label: "Agent elsewhere" }], "agent");
  s.undo();
  assert.match(s.snapshot().diagram, /n2\["Process selected batch atomically"\]/);
  assert.match(s.snapshot().diagram, /n4\["Agent elsewhere"\]/);
});

test("a session round-trips through its stored form", () => {
  const s = new CanvasStore("batch", "Batch review");
  s.replaceDiagram(0, SPEC_EXAMPLE, "clear", "agent", "claude-code");
  s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n2"], text: "keep" }, { op: "remove_node", id: "n6" }], "user");
  s.setLayout({ n1: { x: 10, y: 20 }, unknown: { x: 0, y: 0 } });
  const restored = CanvasStore.fromStored(JSON.parse(JSON.stringify(s.toStored())));
  assert.deepEqual(restored.snapshot(), s.snapshot());
  assert.deepEqual(restored.browserState().layout, { n1: { x: 10, y: 20 } });
  assert.equal(restored.browserState().title, "Batch review");
  const next = restored.applyPatch(restored.revision, [{ op: "add_node", label: "x" }, { op: "add_annotation" }], "user");
  assert.deepEqual(next.createdNodeIds, ["n7"], "generated ids are not reused after reload");
  assert.deepEqual(next.createdAnnotationIds, [2]);
});

const PROPOSAL = `flowchart TD
    n1["Load record"]
    n2["Save record<br>+ write audit log row per save<br>- send email"]:::changed
    n3["Notify downstream"]:::new
    n4["Legacy export"]
    n1 e1@--> n2
    n2 e2@--> n3
    n2 e3@--> n4
    class e2 new
    class e3,n4 removed
    classDef new fill:#0f0`;

test("change statuses and detail lines parse, round-trip and survive replace", () => {
  const { graph } = parseMermaid(PROPOSAL);
  const byId = Object.fromEntries([...graph.nodes, ...graph.edges].map((x) => [x.id, x]));
  assert.equal(byId.n1.status, undefined);
  assert.equal(byId.n2.status, "changed");
  assert.equal(byId.n3.status, "new");
  assert.equal(byId.n4.status, "removed");
  assert.equal(byId.e2.status, "new");
  assert.equal(byId.e3.status, "removed");
  assert.equal(graph.nodes[1].label, "Save record\n+ write audit log row per save\n- send email");
  const text = toMermaid(graph);
  assert.match(text, /n2\["Save record<br>\+ write audit log row per save<br>- send email"\]:::changed/);
  assert.match(text, /class e2 new/);
  assert.match(text, /classDef removed /);
  assert.deepEqual(parseMermaid(text).graph, graph);

  // Statuses inline on edge statements, and errors for unknown classes or targets.
  assert.equal(parseMermaid('flowchart TD\n a:::new --> b["B"]:::changed').graph.nodes.map((n) => n.status).join(), "new,changed");
  assert.equal(code(() => parseMermaid('flowchart TD\n a["A"]:::fancy')), "mermaid_syntax");
  assert.equal(code(() => parseMermaid("flowchart TD\n a\n class zz new")), "mermaid_syntax");
  assert.equal(code(() => parseMermaid(`flowchart TD\n a["${Array(10).fill("x").join("<br>")}"]`)), "mermaid_syntax");
});

test("<br> in JSON labels becomes a line break", () => {
  const op = OperationSchema.parse({ op: "add_node", label: "Save record<br>+ audit row<BR/>- email" });
  assert.equal(op.op === "add_node" && op.label, "Save record\n+ audit row\n- email");
  const msg = OperationSchema.parse({ op: "add_message", from: "A", to: "B", text: "Lock<br />retry" });
  assert.equal(msg.op === "add_message" && msg.text, "Lock\nretry");
});

test("status patches, accept_changes and undo", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, PROPOSAL, "clear", "agent");
  s.applyPatch(1, [{ op: "add_annotation", nodeIds: ["n4"], text: "really drop?" }], "user");
  s.applyPatch(2, [{ op: "update_node", id: "n1", status: "changed", label: "Load record\n~ by id" }], "agent");
  assert.match(s.snapshot().diagram, /n1\["Load record<br>~ by id"\]:::changed/);
  const r = s.applyPatch(3, [{ op: "accept_changes" }], "user");
  assert.equal(r.undoable, true);
  const after = s.browserState();
  assert.deepEqual(after.nodes.map((n) => n.id), ["n1", "n2", "n3"]);
  assert.ok(after.nodes.every((n) => !n.status) && after.edges.every((e) => !e.status));
  assert.equal(after.annotations[0].orphaned, true);
  assert.doesNotMatch(s.snapshot().diagram, /classDef/);
  s.undo();
  assert.match(s.snapshot().diagram, /n4\["Legacy export"\]:::removed/);
  assert.match(s.snapshot().diagram, /n3\["Notify downstream"\]:::new/);
  assert.deepEqual(s.browserState().annotations[0].nodeIds, ["n4"]);
  s.applyPatch(s.revision, [{ op: "update_edge", id: "e2", status: null }], "user");
  assert.doesNotMatch(s.snapshot().diagram, /class e2/);
});

test("two-way edges: <--> parses, round-trips, is set and cleared by update_edge, and undoes", () => {
  const { graph } = parseMermaid("flowchart LR\n app e1@<--> cache\n app <-->|sync| db\n db --> app");
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, !!e.both]), [["app", "cache", true], ["app", "db", true], ["db", "app", false]]);
  assert.match(toMermaid(graph), /app e1@<--> cache/);
  assert.deepEqual(parseMermaid(toMermaid(graph)).graph, graph);

  const s = demo();
  // The editor's direction cycle: reverse, then both ends, then back as it was.
  s.applyPatch(1, [{ op: "update_edge", id: "e1", from: "n2", to: "n1" }], "user");
  assert.match(s.snapshot().diagram, /n2 e1@--> n1/);
  s.applyPatch(2, [{ op: "update_edge", id: "e1", both: true }], "user");
  assert.match(s.snapshot().diagram, /n2 e1@<--> n1/);
  s.applyPatch(3, [{ op: "update_edge", id: "e1", from: "n1", to: "n2", both: false }], "user");
  assert.match(s.snapshot().diagram, /n1 e1@--> n2/);
  s.undo();
  assert.match(s.snapshot().diagram, /n2 e1@<--> n1/);
  assert.equal(s.browserState().edges.find((e) => e.id === "e1")?.both, true);

  const added = s.applyPatch(s.revision, [{ op: "add_edge", from: "n4", to: "n5", both: true }], "agent");
  assert.match(s.snapshot().diagram, new RegExp(`n4 ${added.createdEdgeIds![0]}@<--> n5`));
});

test("layout joined to the latest undo step undoes and redoes with it (a reversed arrow keeps its line)", () => {
  const s = demo();
  s.applyPatch(1, [{ op: "update_edge", id: "e1", from: "n2", to: "n1" }], "user");
  s.setLayout({}, undefined, { e1: { from: { side: "top", t: 0.5 }, to: { side: "bottom", t: 0.5 } } }, undefined, undefined, true);
  assert.deepEqual(s.browserState().anchors.e1, { from: { side: "top", t: 0.5 }, to: { side: "bottom", t: 0.5 } });
  const steps = s.undo().steps;
  assert.equal(steps.length, 1, "one step");
  assert.match(s.snapshot().diagram, /n1 e1@--> n2/);
  assert.equal(s.browserState().anchors.e1, undefined, "ends back to automatic");
  s.redo();
  assert.match(s.snapshot().diagram, /n2 e1@--> n1/);
  assert.deepEqual(s.browserState().anchors.e1, { from: { side: "top", t: 0.5 }, to: { side: "bottom", t: 0.5 } });
});

test("state diagrams have no two-way transitions", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, "stateDiagram-v2\n [*] --> Draft\n Draft --> Paid", "clear", "agent");
  const e = s.browserState().edges.find((x) => x.from === "Draft")!;
  assert.equal(code(() => s.applyPatch(1, [{ op: "update_edge", id: e.id, both: true }], "user")), "invalid_transition");
  s.applyPatch(1, [{ op: "update_edge", id: e.id, from: "Paid", to: "Draft" }], "user");
  assert.match(s.snapshot().diagram, /Paid --> Draft/);
});
