import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CanvasStore, HISTORY_LIMIT } from "../server/store.ts";
import { SessionManager } from "../server/sessions.ts";

const label = (s: CanvasStore, id: string) => s.browserState().nodes.find((n) => n.id === id)?.label;
const rename = (s: CanvasStore, id: string, text: string, fork?: { base: number; id: string }) =>
  s.applyPatch(s.revision, [{ op: "update_node", id, label: text }], "user", undefined, undefined, fork);

function drawn() {
  const s = new CanvasStore("t");
  s.replaceDiagram(0, "flowchart TD\n  a[A] --> b[B]", "keep", "agent");
  return s;
}

test("every change is a revision made from the one before it", () => {
  const s = drawn();
  rename(s, "a", "A2");
  const { head, revisions } = s.revisionList();
  assert.equal(head, 2);
  assert.deepEqual(revisions.map((r) => [r.revision, r.parent, r.source]), [[2, 1, "user"], [1, 0, "agent"], [0, null, "user"]]);
  assert.equal(revisions[0].ops[0].op, "update_node");
});

test("an edit on an earlier revision continues from it; going back to the later one works the same way", () => {
  const s = drawn(); // 1
  rename(s, "a", "v2"); // 2
  rename(s, "a", "v3"); // 3
  assert.equal(s.revisionState(2).nodes.find((n) => n.id === "a")?.label, "v2");
  assert.equal(s.revisionState(2).viewing, 2);

  rename(s, "b", "B4", { base: 2, id: "f1" }); // 4, made from 2
  assert.equal(label(s, "a"), "v2", "revision 2's content came back");
  assert.equal(label(s, "b"), "B4");
  assert.equal(s.browserState().fork, "f1");
  // More requests of the same fork apply to the latest revision as usual.
  rename(s, "b", "B5", { base: 2, id: "f1" });
  assert.equal(label(s, "a"), "v2");

  rename(s, "a", "v6", { base: 3, id: "f2" }); // back to 3
  assert.equal(label(s, "b"), "B");
  assert.deepEqual(s.revisionList().revisions.slice(0, 4).map((r) => [r.revision, r.parent]), [[6, 3], [5, 4], [4, 2], [3, 2]]);
  assert.equal(s.revisionList().revisions[0].ops[0].op, "restore_revision");

  // Agents that knew an earlier revision re-read the snapshot.
  const changes = s.changesSince(3);
  assert.ok("snapshotRequired" in changes && /went back to revision 3/.test(changes.reason));
});

test("a failed edit on an earlier revision changes nothing", () => {
  const s = drawn();
  rename(s, "a", "v2");
  assert.throws(() => s.applyPatch(s.revision, [{ op: "remove_node", id: "nope" }], "user", undefined, undefined, { base: 1, id: "x" }));
  assert.equal(label(s, "a"), "v2");
  assert.equal(s.revision, 2);
});

test("undo belongs to each revision: continuing from an earlier one brings back its undo steps", () => {
  const s = drawn();
  rename(s, "a", "one"); // 2
  rename(s, "a", "two"); // 3
  rename(s, "a", "three"); // 4
  assert.equal(s.browserState().history.undo.length, 3);
  assert.equal(s.revisionState(3).history.undo.length, 2);

  // Undo pressed while previewing revision 3 undoes revision 3's last step.
  const r = s.undo(1, { base: 3, id: "u" });
  assert.equal(label(s, "a"), "one");
  assert.deepEqual(r.steps.map((st) => st.ops[0].op), ["update_node"]);
  assert.equal(s.revisionList().revisions[0].parent, 3);
  assert.equal(s.browserState().history.redo.length, 1);

  // Revision 4 still has its own three steps.
  assert.equal(s.revisionState(4).history.undo.length, 3);
});

test("several steps undo at once as one revision; the list keeps the last steps only", () => {
  const s = drawn();
  for (let i = 0; i < HISTORY_LIMIT + 3; i++) rename(s, "a", `v${i}`);
  assert.equal(s.browserState().history.undo.length, HISTORY_LIMIT);
  const before = s.revision;
  const r = s.undo(3);
  assert.equal(s.revision, before + 1);
  assert.equal(r.steps.length, 3);
  assert.equal(label(s, "a"), `v${HISTORY_LIMIT - 1}`);
  assert.equal(s.browserState().history.redo.length, 3);
  s.redo(3);
  assert.equal(label(s, "a"), `v${HISTORY_LIMIT + 2}`);
});

test("moves are undo steps too, without a revision", () => {
  const s = drawn();
  s.setLayout({ a: { x: 0, y: 0 } });
  s.setLayout({ a: { x: 100, y: 50 } }, undefined, {}, "Moved A");
  const rev = s.revision;
  assert.deepEqual(s.browserState().history.undo.map((h) => h.label), ["Moved A"]);
  const r = s.undo();
  assert.equal(s.revision, rev, "layout has no revision");
  assert.deepEqual(r.steps.map((h) => h.label), ["Moved A"]);
  assert.deepEqual(s.layout().a, { x: 0, y: 0 });
  s.redo();
  assert.deepEqual(s.layout().a, { x: 100, y: 50 });
});

test("sessions are saved as a folder of revisions; old single-file sessions still load and move into a folder", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canvas-rev-"));
  try {
    const legacy = drawn();
    rename(legacy, "a", "Old");
    writeFileSync(path.join(dir, "old.json"), JSON.stringify({ ...legacy.toStored(), name: "old" }));

    let sessions = new SessionManager(dir);
    const old = sessions.get("old");
    assert.equal(label(old, "a"), "Old");
    assert.deepEqual(old.revisionList().revisions.map((r) => r.revision), [2]);
    rename(old, "b", "New"); // 3
    rename(old, "b", "Newer"); // 4
    old.setLayout({ a: { x: 5, y: 5 } }, undefined, {}, "Moved A");
    sessions.flush();
    assert.deepEqual(readdirSync(path.join(dir, "old", "revisions")).sort(), ["2.json", "3.json", "4.json"]);
    assert.ok(readdirSync(path.join(dir, "old")).includes("legacy-v1.json"));
    assert.ok(!readdirSync(dir).includes("old.json"));

    sessions = new SessionManager(dir);
    const again = sessions.get("old");
    assert.equal(label(again, "b"), "Newer");
    assert.deepEqual(again.layout().a, { x: 5, y: 5 });
    assert.deepEqual(again.browserState().history.undo.map((h) => h.label ?? h.ops[0].op), ["update_node", "update_node", "Moved A"]);
    assert.equal(again.revisionState(3).nodes.find((n) => n.id === "b")?.label, "New", "earlier revisions read back from disk");
    rename(again, "a", "From 2", { base: 2, id: "f" });
    assert.equal(label(again, "b"), "B");
    again.undo(); // the undo steps of revision 2 came along
    assert.equal(label(again, "a"), "Old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing a session starts its revisions, undo and counters over, also on disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canvas-reset-"));
  try {
    let sessions = new SessionManager(dir);
    const s = sessions.get("default");
    for (let i = 0; i < 5; i++) s.applyPatch(s.revision, [{ op: "add_node", label: `Step ${i}` }], "user");
    sessions.flush();
    assert.equal(readdirSync(path.join(dir, "default", "revisions")).length, 6);
    const oldId = s.sessionId;
    s.reset("user");
    assert.equal(s.revision, 0);
    assert.notEqual(s.sessionId, oldId);
    assert.deepEqual(s.revisionList().revisions.map((r) => r.revision), [0]);
    assert.deepEqual(s.history(), { undo: [], redo: [] });
    const next = s.applyPatch(0, [{ op: "add_node", label: "Fresh" }], "user");
    assert.equal(next.revision, 1);
    assert.deepEqual(next.createdNodeIds, ["n1"], "node ids start over");
    sessions.flush();
    assert.deepEqual(readdirSync(path.join(dir, "default", "revisions")).sort(), ["0.json", "1.json"]);
    sessions = new SessionManager(dir);
    const again = sessions.get("default");
    assert.equal(again.revision, 1);
    assert.deepEqual(again.revisionList().revisions.map((r) => r.revision), [1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
