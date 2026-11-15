import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSequence, sequenceToMermaid, findItem } from "../server/sequence.ts";
import { CanvasStore } from "../server/store.ts";
import { CanvasError } from "../server/types.ts";

const WORKERS = `sequenceDiagram
    participant API as API
    participant Q as Queue table
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant DB as Database

    API->>Q: Enqueue work
    par Worker 1
        W1->>Q: Select eligible batch
        Q-->>W1: Batch A
        W1->>+DB: Process batch A in transaction
        alt All records succeed
            DB-->>-W1: Commit
        else Processing fails
            DB--x W1: Rollback
        end
    and Worker 2
        W2->>Q: Select another eligible batch
        Q-->>W2: Batch B
        W2->>DB: Process batch B in transaction
    end
    Note over W1,W2: Concurrent execution; no fixed real-time offsets`;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanvasError, `expected CanvasError, got ${err}`);
    return err.code;
  }
  assert.fail("expected an error");
}

let n = 0;
const alloc = (prefix: string, taken: Set<string>) => {
  let id;
  do id = `${prefix}${++n}`;
  while (taken.has(id));
  return id;
};

test("parses the requirements example, generates ids and round-trips through %%@ lines", () => {
  n = 0;
  const { sequence, generatedIds } = parseSequence(WORKERS, alloc);
  assert.deepEqual(sequence.participants.map((p) => `${p.id}:${p.label}`), ["API:API", "Q:Queue table", "W1:Worker 1", "W2:Worker 2", "DB:Database"]);
  assert.equal(sequence.items.length, 3);
  const par = sequence.items[1];
  assert.equal(par.type === "fragment" && par.kind, "par");
  assert.equal(par.type === "fragment" && par.sections.map((s) => s.label).join("|"), "Worker 1|Worker 2");
  const alt = par.type === "fragment" ? par.sections[0].items[3] : undefined;
  assert.equal(alt?.type === "fragment" && alt.sections.length, 2);
  const commit = alt?.type === "fragment" ? alt.sections[0].items[0] : undefined;
  assert.equal(commit?.type === "message" && commit.deactivate, true);
  assert.equal(generatedIds.length, 12);
  // `;` is a Mermaid statement separator, so it is written as an entity.
  const text = sequenceToMermaid(sequence);
  assert.match(text, /Note over W1,W2: Concurrent execution#59; no fixed real-time offsets/);
  assert.match(text, /W1->>\+DB: Process batch A in transaction/);
  assert.match(text, /DB--xW1: Rollback/);
  const again = parseSequence(text, () => assert.fail("ids must come from the %%@ lines"));
  assert.deepEqual(again.sequence, sequence);
  assert.equal(sequenceToMermaid(again.sequence), text);
});

test("unsupported or malformed sequence syntax is rejected with a line number, never dropped", () => {
  const bad = [
    "sequenceDiagram\n  rect rgb(0,0,0)\n  end",
    "sequenceDiagram\n  box Aqua Group\n  end",
    "sequenceDiagram\n  A<<->>B: hi",
    "sequenceDiagram\n  alt x\n  A->>B: y",
    "sequenceDiagram\n  else x",
    "sequenceDiagram\n  opt a\n  and b\n  end",
    "sequenceDiagram\n  %%@m1\n  %%@m2\n  A->>B: x",
    "sequenceDiagram\n  %%@m1 shiny\n  A->>B: x",
    "sequenceDiagram\n  %%@m1\n  A->>B: x\n  %%@m1\n  A->>B: y",
    "sequenceDiagram\n  A => B: x",
  ];
  for (const src of bad) assert.equal(code(() => parseSequence(src, alloc)), "mermaid_syntax", src);
  assert.match((() => { try { parseSequence(bad[0], alloc); } catch (e) { return (e as Error).message; } })()!, /^line 2: "rect" is not supported/);
});

function seqStore() {
  const s = new CanvasStore("seq");
  s.replaceDiagram(0, WORKERS, "clear", "agent", "planner");
  return s;
}

test("replace_diagram switches the session type; flowchart ops are refused on a sequence", () => {
  const s = seqStore();
  assert.equal(s.snapshot().type, "sequence");
  assert.match(s.snapshot().diagram, /^sequenceDiagram\n/);
  assert.match(s.snapshot().diagram, /%%@m1\n {4}API->>Q: Enqueue work/);
  assert.equal(code(() => s.applyPatch(1, [{ op: "add_node", label: "x" }], "agent")), "wrong_diagram_type");
  assert.equal(code(() => s.applyPatch(1, [{ op: "set_diagram_type", type: "flowchart" }], "agent")), "not_empty");
  s.replaceDiagram(1, 'flowchart TD\n a["A"]', "keep", "agent");
  assert.equal(s.snapshot().type, "flowchart");
  assert.equal(s.browserState().sequence.items.length, 0);
});

test("sequence ops: messages, positions, wrap, move, notes and generated ids", () => {
  const s = seqStore();
  const r = s.applyPatch(
    1,
    [
      { op: "add_participant", id: "LOG", label: "Audit log", before: "DB" },
      { op: "add_message", from: "W1", to: "LOG", text: "Write audit row", arrow: "-)", position: { after: "m4" } },
      { op: "add_note", participants: ["W2"], placement: "right of", text: "waits for lock", position: { in: "f1", section: 1 } },
    ],
    "agent",
  );
  assert.deepEqual(r.createdElementIds, ["LOG", "m10", "t2"]);
  const seq = s.browserState().sequence;
  assert.deepEqual(seq.participants.map((p) => p.id), ["API", "Q", "W1", "W2", "LOG", "DB"]);
  assert.equal(findItem(seq, "m10")?.index, 3);
  assert.equal(findItem(seq, "t2")?.parent?.id, "f1");

  // Wrap two consecutive messages in a loop, then move it after the par block.
  s.applyPatch(2, [{ op: "add_fragment", kind: "loop", label: "until queue is empty", wrap: ["m3", "m4"] }], "user");
  let loc = findItem(s.browserState().sequence, "m3")!;
  assert.equal(loc.parent?.kind, "loop");
  const loopId = loc.parent!.id;
  s.applyPatch(3, [{ op: "move_item", id: loopId, position: { after: "f1" } }], "user");
  loc = findItem(s.browserState().sequence, loopId)!;
  assert.equal(loc.parent, undefined);
  assert.equal(loc.list[loc.index - 1].id, "f1");
  assert.equal(code(() => s.applyPatch(4, [{ op: "move_item", id: "f1", position: { in: "f2" } }], "user")), "invalid_patch");
  assert.equal(code(() => s.applyPatch(4, [{ op: "add_fragment", kind: "alt", wrap: ["m1", "m10"] }], "user")), "invalid_patch");
  assert.equal(code(() => s.applyPatch(4, [{ op: "add_message", from: "W1", to: "NOPE", text: "x" }], "user")), "not_found");
  assert.equal(code(() => s.applyPatch(4, [{ op: "update_fragment", id: "f2", labels: ["only one"] }], "user")), "invalid_patch");
  s.applyPatch(4, [{ op: "update_fragment", id: "f2", labels: ["ok", "failed", "timed out"] }], "user");
  assert.match(s.snapshot().diagram, /else timed out\n\s+end/);
  // Everything still round-trips through Mermaid.
  const copy = new CanvasStore();
  copy.replaceDiagram(0, s.snapshot().diagram, "clear", "agent");
  assert.equal(copy.snapshot().diagram, s.snapshot().diagram);
});

test("marks target sequence elements and are pruned when they disappear", () => {
  const s = seqStore();
  const r = s.applyPatch(1, [{ op: "add_annotation", elementIds: ["m4", "m9"], kind: "question", text: "Check race condition" }], "user");
  assert.deepEqual(r.createdAnnotationIds, [1]);
  assert.deepEqual(s.snapshot().annotations[0].elementIds, ["m4", "m9"]);
  assert.equal(code(() => s.applyPatch(2, [{ op: "add_annotation", nodeIds: ["m4"] }], "user")), "not_found");
  // Removing the DB lane removes its messages, which prunes the mark down to nothing.
  const res = s.applyPatch(2, [{ op: "remove_participant", id: "DB" }], "agent");
  assert.ok(res.sideEffects?.some((fx) => fx.op === "update_annotation" && fx.orphaned === true));
  assert.doesNotMatch(s.snapshot().diagram, /DB/);
  assert.equal(s.snapshot().annotations[0].orphaned, true);
});

test("undo restores the sequence and refuses when the agent changed it since", () => {
  const s = seqStore();
  const before = s.snapshot().diagram;
  s.applyPatch(1, [{ op: "remove_item", id: "f1" }], "user");
  assert.doesNotMatch(s.snapshot().diagram, /par Worker/);
  s.undo();
  assert.equal(s.snapshot().diagram, before);
  s.redo();
  s.applyPatch(s.revision, [{ op: "update_message", id: "m1", text: "agent edit" }], "agent");
  assert.equal(code(() => s.undo()), "undo_conflict");
});

test("statuses, accept_changes, set_diagram_type and the stored form", () => {
  const s = new CanvasStore("seq2", undefined, "sequence");
  assert.equal(s.snapshot().diagram, "sequenceDiagram");
  s.applyPatch(
    0,
    [
      { op: "add_participant", id: "A" },
      { op: "add_participant", id: "B", status: "new" },
      { op: "add_message", from: "A", to: "B", text: "new call", status: "new" },
      { op: "add_message", from: "A", to: "A", text: "old step", status: "removed" },
    ],
    "user",
  );
  assert.match(s.snapshot().diagram, /%%@B new\n {4}participant B/);
  assert.match(s.snapshot().diagram, /%%@m\d+ removed/);
  const restored = CanvasStore.fromStored(JSON.parse(JSON.stringify(s.toStored())));
  assert.equal(restored.snapshot().diagram, s.snapshot().diagram);
  assert.equal(restored.applyPatch(1, [{ op: "add_message", from: "A", to: "B", text: "x" }], "user").createdElementIds?.[0], "m3");
  s.applyPatch(1, [{ op: "accept_changes" }], "user");
  assert.doesNotMatch(s.snapshot().diagram, /old step| new\n| removed\n/);
  const empty = new CanvasStore();
  empty.applyPatch(0, [{ op: "set_diagram_type", type: "sequence" }], "user");
  assert.equal(empty.snapshot().type, "sequence");
  empty.undo();
  assert.equal(empty.snapshot().type, "flowchart");
});
