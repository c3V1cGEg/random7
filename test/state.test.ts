import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStateDiagram, stateToMermaid } from "../server/stateDiagram.ts";
import { CanvasStore } from "../server/store.ts";
import { CanvasError } from "../server/types.ts";

const ORDER = `stateDiagram-v2
    direction LR
    state "Draft" as Draft
    state "Payment failed" as Failed
    Failed : card declined
    Failed : retry possible for 24h
    state paymentOk <<choice>>
    %%@e1
    [*] --> Draft
    %%@e2
    Draft --> Submitted : submit
    %%@e3
    Submitted --> paymentOk : payment result
    %%@e4
    paymentOk --> Paid : [approved]
    %%@e5
    paymentOk --> Failed : [declined]
    %%@e6 new
    Failed --> Submitted : retry
    Paid --> [*]
    class Failed changed`;

const throwsSyntax = (src: string, pattern: RegExp) =>
  assert.throws(() => parseStateDiagram(src), (e: unknown) => e instanceof CanvasError && e.code === "mermaid_syntax" && pattern.test(e.message));

test("state diagram: parses states, pseudo-states, choices, details, ids and statuses", () => {
  const { graph, generatedEdgeIds } = parseStateDiagram(ORDER);
  assert.equal(graph.direction, "LR");
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId.initial, { id: "initial", label: "Start", shape: "initial" });
  assert.deepEqual(byId.final, { id: "final", label: "End", shape: "final" });
  assert.equal(byId.Failed.label, "Payment failed\ncard declined\nretry possible for 24h");
  assert.equal(byId.Failed.status, "changed");
  assert.equal(byId.Submitted.label, "Submitted");
  assert.equal(byId.paymentOk.shape, "choice");
  assert.deepEqual(graph.edges.find((e) => e.id === "e6"), { id: "e6", from: "Failed", to: "Submitted", label: "retry", status: "new" });
  assert.deepEqual(graph.edges.find((e) => e.id === "e4")?.label, "[approved]");
  assert.deepEqual(generatedEdgeIds, ["e7"]);
});

test("state diagram: serializing and parsing again gives the same graph", () => {
  const first = parseStateDiagram(ORDER).graph;
  const text = stateToMermaid(first);
  assert.match(text, /^stateDiagram-v2\n {4}direction LR/);
  assert.match(text, /state "Payment failed" as Failed\n {4}Failed : card declined/);
  assert.match(text, /%%@e6 new\n {4}Failed --> Submitted : retry/);
  assert.match(text, /\[\*\] --> Draft/);
  const again = parseStateDiagram(text);
  const sorted = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sorted(again.graph.nodes), sorted(first.nodes));
  assert.deepEqual(again.graph.edges, first.edges);
  assert.equal(stateToMermaid(again.graph), text);
  assert.deepEqual(again.generatedEdgeIds, []);
});

test("state diagram: unsupported constructs are rejected with a line number", () => {
  throwsSyntax("flowchart TD\n a --> b", /stateDiagram-v2/);
  throwsSyntax("stateDiagram-v2\n state Active {\n  A --> B\n }", /line 2: composite states/);
  throwsSyntax("stateDiagram-v2\n state f <<fork>>", /fork, join/);
  throwsSyntax("stateDiagram-v2\n note right of A : x", /notes are not supported/);
  throwsSyntax("stateDiagram-v2\n A --> B --> C", /one transition per line/);
  throwsSyntax("stateDiagram-v2\n %%@e1\n state A", /line 2: %%@e1 must be followed by a transition/);
  throwsSyntax("stateDiagram-v2\n initial --> A", /reserved for \[\*\]/);
  throwsSyntax("stateDiagram-v2\n A:::new --> B", /":::" classes/);
});

test("state session: replace_diagram sets the type, the snapshot round-trips", () => {
  const s = new CanvasStore();
  const res = s.replaceDiagram(0, ORDER, "clear", "agent");
  assert.equal(res.type, "state");
  const snap = s.snapshot();
  assert.equal(snap.type, "state");
  assert.deepEqual(snap.instances, []);
  const s2 = new CanvasStore();
  s2.replaceDiagram(0, snap.diagram, "clear", "agent");
  assert.equal(s2.snapshot().diagram, snap.diagram);
});

test("state session: shapes are checked against the diagram type; pseudo-states are unique", () => {
  const s = new CanvasStore("x", undefined, "state");
  const r = s.applyPatch(0, [{ op: "add_node", label: "Open" }, { op: "add_node", label: "x", shape: "initial" }], "agent");
  assert.deepEqual(r.createdNodeIds, ["n1", "initial"]);
  assert.match(s.snapshot().diagram, /state "Open" as n1/);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as CanvasError).code;
    }
  };
  assert.equal(code(() => s.applyPatch(s.revision, [{ op: "add_node", label: "x", shape: "action" }], "agent")), "invalid_shape");
  assert.equal(code(() => s.applyPatch(s.revision, [{ op: "add_node", label: "x", shape: "initial" }], "agent")), "duplicate_id");
  assert.equal(code(() => s.applyPatch(s.revision, [{ op: "add_edge", from: "n1", to: "initial" }], "agent")), "invalid_transition");
  const flow = new CanvasStore();
  assert.equal(code(() => flow.applyPatch(0, [{ op: "add_node", label: "x", shape: "state" }], "agent")), "invalid_shape");
  assert.equal(code(() => flow.applyPatch(0, [{ op: "set_instance", id: "o1", label: "x", state: "a" }], "agent")), "wrong_diagram_type");
});

test("instances: create, move along a transition, fields, orphaning, undo", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, ORDER, "clear", "agent");
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", label: "Order #1042", state: "Draft", fields: { total: "€120.00" } }], "agent");
  assert.deepEqual(s.snapshot().instances, [{ id: "o1042", label: "Order #1042", state: "Draft", fields: { total: "€120.00" } }]);
  // The Mermaid text describes the type only.
  assert.doesNotMatch(s.snapshot().diagram, /1042/);

  const moved = s.revision;
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Submitted", via: "e2" }], "agent");
  const change = s.changesSince(moved);
  assert.ok("changes" in change);
  assert.deepEqual(change.changes[0].ops, [{ op: "set_instance", id: "o1042", from: "Draft", state: "Submitted", via: "e2" }]);
  assert.throws(() => s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Paid", via: "e2" }], "agent"), /e2 does not start at Submitted/);
  assert.throws(() => s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "paymentOk" }], "agent"), /only be in a state/);
  // Through a choice point: a path of transitions.
  assert.throws(() => s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Paid", via: "e4" }], "agent"), /does not start at Submitted/);
  assert.throws(() => s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Paid", via: ["e3", "e5"] }], "agent"), /does not lead to Paid/);
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Paid", via: ["e3", "e4"] }], "agent");
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Submitted" }], "agent");
  assert.throws(() => s.applyPatch(s.revision, [{ op: "set_instance", id: "o2", state: "Draft" }], "agent"), /needs label and state/);

  // Deleting its state orphans the instance; it keeps the last state id.
  const r = s.applyPatch(s.revision, [{ op: "remove_node", id: "Submitted" }], "user");
  assert.ok(r.sideEffects?.some((fx) => fx.op === "set_instance" && fx.orphaned === true));
  assert.deepEqual(s.snapshot().instances?.[0], { id: "o1042", label: "Order #1042", state: "Submitted", fields: { total: "€120.00" }, orphaned: true });
  // Undo brings the state back, and the instance with it.
  s.undo();
  assert.equal(s.snapshot().instances?.[0].orphaned, undefined);

  // User-made instance changes are undoable too.
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1042", state: "Paid", fields: null }], "user");
  assert.equal(s.snapshot().instances?.[0].fields, undefined);
  s.undo();
  assert.deepEqual(s.snapshot().instances?.[0].fields, { total: "€120.00" });
  assert.equal(s.snapshot().instances?.[0].state, "Submitted");
});

test("instances: kept across save/load, cleared when the session becomes a flowchart", () => {
  const s = new CanvasStore();
  s.replaceDiagram(0, ORDER, "clear", "agent");
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1", label: "Order #1", state: "Paid" }], "agent");
  const loaded = CanvasStore.fromStored(JSON.parse(JSON.stringify(s.toStored())));
  assert.equal(loaded.type, "state");
  assert.deepEqual(loaded.snapshot().instances, [{ id: "o1", label: "Order #1", state: "Paid" }]);
  assert.equal(loaded.snapshot().diagram, s.snapshot().diagram);

  const r = s.replaceDiagram(s.revision, 'flowchart TD\n a["A"]', "keep", "agent");
  assert.ok(r.sideEffects?.some((fx) => fx.op === "remove_instance" && fx.id === "o1"));
  assert.equal(s.snapshot().instances, undefined);
  assert.equal(s.browserState().instances.length, 0);
});

test("state legend: states in lifecycle order (through choices), unreachable ones last", async () => {
  const { stateOrder } = await import("../client/src/Legend.tsx");
  const { graph } = parseStateDiagram(`${ORDER}\n    state "Archived" as Archived`);
  const { ordered, unreachable } = stateOrder(graph.nodes, graph.edges);
  assert.deepEqual(
    ordered.map((n) => n.id),
    ["Draft", "Submitted", "Paid", "Failed", "Archived"],
  );
  assert.deepEqual([...unreachable], ["Archived"]);
});

test("any state: one source for transitions possible from every state; round-trips; nothing leads into it", () => {
  const src = `stateDiagram-v2
    state "Open" as OPEN
    state "Done" as DONE
    state "Any state" as any
    %%@e1
    [*] --> OPEN
    %%@e2
    OPEN --> DONE : finish
    %%@e3
    any --> [*] : deleted`;
  const { graph } = parseStateDiagram(src);
  assert.deepEqual(graph.nodes.find((n) => n.id === "any"), { id: "any", label: "Any state", shape: "any" });
  assert.equal(stateToMermaid(parseStateDiagram(stateToMermaid(graph)).graph), stateToMermaid(graph));
  throwsSyntax(`stateDiagram-v2\n OPEN --> any`, /nothing leads into "any"/);

  const s = new CanvasStore();
  s.replaceDiagram(0, src, "clear", "agent");
  assert.throws(() => s.applyPatch(s.revision, [{ op: "add_edge", from: "DONE", to: "any" }], "agent"), /nothing leads into/);
  assert.throws(() => s.applyPatch(s.revision, [{ op: "add_node", label: "x", shape: "any" }], "agent"), /already has its any state/);
  // An instance can take an any-state transition from wherever it is.
  s.applyPatch(s.revision, [{ op: "set_instance", id: "c1", label: "Comment 1", state: "DONE" }], "agent");
  s.applyPatch(s.revision, [{ op: "set_instance", id: "c1", state: "final", via: "e3" }], "agent");
  assert.equal(s.snapshot().instances?.[0].state, "final");
});

test("states legend: dead ends, and what any state leads to counts as reachable", async () => {
  const { stateOrder } = await import("../client/src/Legend.tsx");
  const dead = parseStateDiagram(`stateDiagram-v2\n [*] --> A\n A --> B\n state "Gone" as Gone\n any --> Gone : archive`).graph;
  const order = stateOrder(dead.nodes, dead.edges);
  assert.deepEqual(order.ordered.map((n) => n.id), ["A", "B", "Gone"]);
  assert.deepEqual([...order.unreachable], []);
  // B and Gone have no way out, but any --> Gone is one from every state... Gone itself included.
  assert.deepEqual([...order.deadEnds], []);
  const noAny = parseStateDiagram(`stateDiagram-v2\n [*] --> A\n A --> B\n A --> [*]`).graph;
  assert.deepEqual([...stateOrder(noAny.nodes, noAny.edges).deadEnds], ["B"]);
  const stuck = parseStateDiagram(`stateDiagram-v2\n state c <<choice>>\n [*] --> A\n A --> c : review\n A --> [*]`).graph;
  assert.deepEqual(stateOrder(stuck.nodes, stuck.edges).stuckChoices, ["c"]);
});

test("states legend: start and end tags look through choice points", async () => {
  const { stateOrder } = await import("../client/src/Legend.tsx");
  const g = parseStateDiagram(`stateDiagram-v2
    state author <<choice>>
    state done <<choice>>
    [*] --> author
    author --> Waiting : [by the user]
    author --> AgentNote : [by the agent]
    AgentNote --> Waiting : user replies
    Waiting --> Answered : agent replies
    Answered --> done : closed?
    done --> [*] : [yes]
    done --> Waiting : [no]`).graph;
  const { starts, ends } = stateOrder(g.nodes, g.edges);
  assert.deepEqual([...starts].sort(), ["AgentNote", "Waiting"]);
  assert.deepEqual([...ends], ["Answered"]);
});

test("rename a state's value: transitions, marks, instances and its place follow; undo restores", () => {
  const s = new CanvasStore("x", undefined, "state");
  s.applyPatch(0, [{ op: "add_node", label: "x", shape: "initial" }, { op: "add_node", label: "In progress" }, { op: "add_edge", from: "initial", to: "n1" }], "user");
  s.setLayout({ n1: { x: 10, y: 20 } });
  s.applyPatch(s.revision, [{ op: "add_annotation", nodeIds: ["n1"], text: "?" }, { op: "set_instance", id: "t1", label: "Ticket 1", state: "n1" }], "user");
  s.applyPatch(s.revision, [{ op: "update_node", id: "n1", label: "In progress", newId: "InProgress" }], "user");
  assert.match(s.snapshot().diagram, /state "In progress" as InProgress\n[\s\S]*\[\*\] --> InProgress/);
  assert.deepEqual(s.snapshot().annotations[0].nodeIds, ["InProgress"]);
  assert.equal(s.snapshot().instances?.[0].state, "InProgress");
  assert.deepEqual(s.layout().InProgress, { x: 10, y: 20 });
  assert.throws(() => s.applyPatch(s.revision, [{ op: "update_node", id: "InProgress", newId: "final" }], "user"), /reserved/);
  assert.throws(() => s.applyPatch(s.revision, [{ op: "update_node", id: "initial", newId: "Begin" }], "user"), /keeps its id/);
  s.undo();
  assert.match(s.snapshot().diagram, /as n1/);
  assert.equal(s.snapshot().instances?.[0].state, "n1");
});

test("an unconnected start or end is visible to the agent and survives a redraw", () => {
  const s = new CanvasStore("x", undefined, "state");
  s.applyPatch(0, [{ op: "add_node", label: "x", shape: "initial" }, { op: "add_node", label: "x", shape: "final" }], "user");
  const text = s.snapshot().diagram;
  assert.match(text, /%%@initial\n {4}%%@final/);
  s.replaceDiagram(s.revision, text, "keep", "agent");
  assert.deepEqual(s.browserState().nodes.map((n) => n.id).sort(), ["final", "initial"]);
});

test("a state's value from its name reads like an enum constant", async () => {
  const { stateValue } = await import("../client/src/Legend.tsx");
  assert.equal(stateValue("In progress"), "InProgress");
  assert.equal(stateValue("Zahlung fehlgeschlagen\nmore"), "ZahlungFehlgeschlagen");
  assert.equal(stateValue("2nd try"), null);
  // Reserved words get a suffix instead of failing the rename (and losing the typed name with it).
  assert.equal(stateValue("End"), "EndState");
  assert.equal(stateValue("Class"), "ClassState");
  assert.equal(stateValue("State"), "StateState");
  assert.equal(stateValue("Final"), "Final"); // ids are case-sensitive: only "final" is reserved
});

test("state ids: Mermaid keywords and reserved ids are refused everywhere", () => {
  throwsSyntax("stateDiagram-v2\n [*] --> state", /Mermaid keyword/);
  throwsSyntax('stateDiagram-v2\n state "Say "hi"" as A', /#quot;/);
  const s = new CanvasStore("x", undefined, "state");
  assert.throws(() => s.applyPatch(0, [{ op: "add_node", id: "note", label: "x" }], "agent"), /Mermaid keyword/);
  s.applyPatch(0, [{ op: "add_node", label: "x" }], "agent");
  assert.throws(() => s.applyPatch(s.revision, [{ op: "update_node", id: "n1", newId: "End" }], "agent"), /reserved Mermaid keyword/);
  // Switching back to a flowchart goes back to top-down.
  const t = new CanvasStore("y", undefined, "state");
  t.applyPatch(0, [{ op: "set_diagram_type", type: "flowchart" }], "user");
  assert.equal(t.browserState().direction, "TD");
});

test("state diagrams run left to right unless asked otherwise", () => {
  assert.equal(parseStateDiagram("stateDiagram-v2\n [*] --> A").graph.direction, "LR");
  assert.equal(parseStateDiagram("stateDiagram-v2\n direction TB\n [*] --> A").graph.direction, "TD");
  assert.equal(new CanvasStore("x", undefined, "state").browserState().direction, "LR");
  const switched = new CanvasStore();
  switched.applyPatch(0, [{ op: "set_diagram_type", type: "state" }], "user");
  assert.equal(switched.browserState().direction, "LR");
  assert.equal(new CanvasStore().browserState().direction, "TD"); // flowcharts stay top-down
});

test("comparing revisions of a state diagram lists state, transition and instance changes", async () => {
  const { diffRevisions } = await import("../client/src/diff.ts");
  const s = new CanvasStore();
  s.replaceDiagram(0, ORDER, "clear", "agent");
  s.applyPatch(s.revision, [{ op: "set_instance", id: "o1", label: "Order #1", state: "Draft" }], "agent");
  const before = s.revisionState(s.revision);
  s.applyPatch(s.revision, [{ op: "update_node", id: "Paid", newId: "PAID", label: "Paid in full" }, { op: "set_instance", id: "o1", state: "Submitted", via: "e2" }], "agent");
  const d = diffRevisions(before, s.revisionState(s.revision));
  const summary = d.elements.map((c) => `${c.change} ${c.type} ${c.id}${c.fields.length ? ` [${c.fields.join(",")}]` : ""}`).sort();
  assert.deepEqual(summary, [
    "added node PAID",
    "changed edge e4 [ends]",
    "changed edge e7 [ends]",
    "changed instance o1 [state]",
    "removed node Paid",
  ]);
  const moved = d.elements.find((c) => c.id === "o1")!;
  assert.equal(moved.name, "Order #1 (Draft → Submitted)");
  assert.equal(moved.target, "Submitted");
});
