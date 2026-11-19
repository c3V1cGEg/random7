// Spawns the real server and runs the spec's "minimum useful demo" path:
// agent draws via MCP -> user marks #1 via browser API -> agent reads #1 ->
// agent edits -> browser socket receives it live -> user deletes #1 -> agent sees it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let client: Client;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "canvas-e2e-"));

function startServer(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, CANVAS_PORT: String(PORT), CANVAS_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    proc.stdout!.on("data", (b) => b.toString().includes("MCP:") && resolve(proc));
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}

async function stopServer(proc: ChildProcess) {
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  await exited;
}

async function connect(name: string, query = "") {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp${query}`)));
  return c;
}

async function callWith(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

const call = (name: string, args: Record<string, unknown> = {}) => callWith(client, name, args);

async function userPatch(expectedRevision: number, operations: unknown[]) {
  const res = await fetch(`${BASE}/api/s/default/patch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ expectedRevision, operations }),
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  server = await startServer();
  client = await connect("e2e");
});

after(async () => {
  await client?.close();
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test("lists the canvas tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "canvas_apply_patch",
      "canvas_create_session",
      "canvas_get_capabilities",
      "canvas_get_changes",
      "canvas_get_snapshot",
      "canvas_get_visualization_skill",
      "canvas_list_sessions",
      "canvas_replace_diagram",
    ],
  );
});

test("minimum useful demo round trip", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=default`, { origin: BASE });
  const pushes: any[] = [];
  ws.on("message", (m) => pushes.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.once("open", r));

  const empty = await call("canvas_get_snapshot");
  assert.equal(empty.data.diagram, "flowchart TD");
  assert.deepEqual(empty.data.annotations, []);

  const drawn = await call("canvas_replace_diagram", {
    expectedRevision: empty.data.revision,
    annotations: "clear",
    mermaid: `flowchart TD
      n1(["Cycle starts"])
      n2["Select eligible records"]
      n3["Process batch in one transaction"]
      n4{"All records OK?"}
      n5["Commit"]
      n6["Rollback"]
      n1 e1@--> n2
      n2 e2@--> n3
      n3 e3@--> n4
      n4 e4@-->|Yes| n5
      n4 e5@-->|No| n6
      n6 e6@--> n2`,
  });
  assert.equal(drawn.isError, false, JSON.stringify(drawn.data));

  // Human marks three nodes with a note (as the browser would).
  const mark = await userPatch(drawn.data.revision, [
    { op: "add_annotation", nodeIds: ["n2", "n3", "n4"], kind: "question", text: "Selection logic may starve later records" },
  ]);
  assert.equal(mark.status, 200);
  assert.deepEqual(mark.data.createdAnnotationIds, [1]);

  // Agent reads #1 via changes; no coordinates anywhere.
  const changes = await call("canvas_get_changes", { sinceRevision: drawn.data.revision });
  assert.equal(changes.data.changes[0].source, "user");
  assert.deepEqual(changes.data.changes[0].ops[0].nodeIds, ["n2", "n3", "n4"]);
  assert.doesNotMatch(JSON.stringify(changes.data), /"(x|y|position|width)"/);

  // Stale revision is rejected.
  const stale = await call("canvas_apply_patch", { expectedRevision: drawn.data.revision, operations: [{ op: "remove_edge", id: "e6" }] });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.error, "revision_conflict");

  // Agent edits a node and an edge.
  const edit = await call("canvas_apply_patch", {
    expectedRevision: mark.data.revision,
    operations: [
      { op: "update_node", id: "n2", label: "Select eligible records (oldest first, skip deferred)" },
      { op: "add_node", id: "n7", label: "Defer failed records", shape: "action" },
      { op: "update_edge", id: "e5", to: "n7" },
      { op: "add_edge", id: "e7", from: "n7", to: "n6" },
    ],
  });
  assert.equal(edit.isError, false, JSON.stringify(edit.data));

  // Browser received the agent edit live.
  await waitFor(() => pushes.some((p) => p.state?.revision === edit.data.revision));
  const live = pushes.find((p) => p.state?.revision === edit.data.revision).state;
  assert.equal(live.nodes.find((n: any) => n.id === "n2").label, "Select eligible records (oldest first, skip deferred)");
  assert.equal(live.edges.find((e: any) => e.id === "e5").to, "n7");

  // User deletes #1; agent sees the deletion and #1 is not reused.
  const del = await userPatch(edit.data.revision, [{ op: "remove_annotation", id: 1 }]);
  assert.equal(del.status, 200);
  const after = await call("canvas_get_changes", { sinceRevision: edit.data.revision });
  assert.deepEqual(after.data.changes[0].ops, [{ op: "remove_annotation", id: 1 }]);
  const again = await userPatch(del.data.revision, [{ op: "add_annotation", edgeIds: ["e5"], text: "Does rollback leave these eligible?" }]);
  assert.deepEqual(again.data.createdAnnotationIds, [2]);

  const snap = await call("canvas_get_snapshot");
  assert.match(snap.data.diagram, /n4 e5@-->\|"No"\| n7/);
  assert.deepEqual(snap.data.annotations, [
    { id: 2, nodeIds: [], edgeIds: ["e5"], text: "Does rollback leave these eligible?", by: "user", awaitingReply: true },
  ]);
  ws.close();
});

test("rejects cross-origin and foreign-host requests", async () => {
  const res = await fetch(`${BASE}/api/s/default/patch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ expectedRevision: 0, operations: [{ op: "add_node", label: "x" }] }),
  });
  assert.equal(res.status, 403);
  const mcp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 403);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: "https://evil.example" });
  await new Promise<void>((resolve) => ws.on("error", () => resolve()));
});

test("sessions are independent canvases with their own numbering", async () => {
  const created = await call("canvas_create_session", { session: "Batch-Review", title: "Batch review" });
  assert.equal(created.data.session, "batch-review");
  const dup = await call("canvas_create_session", { session: "batch-review" });
  assert.equal(dup.data.error, "session_exists");
  const bad = await call("canvas_create_session", { session: "no spaces!" });
  assert.equal(bad.data.error, "invalid_session_name");

  const s0 = await call("canvas_get_snapshot", { session: "batch-review" });
  assert.equal(s0.data.diagram, "flowchart TD");
  const r = await call("canvas_apply_patch", {
    session: "batch-review",
    expectedRevision: s0.data.revision,
    operations: [{ op: "add_node", id: "x", label: "Only here" }, { op: "add_annotation", nodeIds: ["x"], text: "first" }],
  });
  assert.deepEqual(r.data.createdAnnotationIds, [1], "numbering is per session");
  const def = await call("canvas_get_snapshot");
  assert.ok(!def.data.diagram.includes("Only here"), "default session untouched");
  const missing = await call("canvas_get_snapshot", { session: "nope" });
  assert.equal(missing.data.error, "session_not_found");

  const list = await call("canvas_list_sessions");
  const names = list.data.sessions.map((s: { name: string }) => s.name);
  assert.ok(names.includes("default") && names.includes("batch-review"));
  assert.equal(list.data.sessions.find((s: { name: string }) => s.name === "batch-review").title, "Batch review");
});

test("each agent connection gets a distinguishable name used in the change log", async () => {
  const a = await connect("claude-code");
  const b = await connect("claude-code");
  const named = await connect("whatever", "?agent=reviewer");
  const nameOf = async (c: Client) => (await callWith(c, "canvas_get_capabilities")).data.you.agentName;
  assert.deepEqual([await nameOf(a), await nameOf(b), await nameOf(named)], ["claude-code", "claude-code-2", "reviewer"]);

  const snap = await callWith(named, "canvas_get_snapshot", { session: "batch-review" });
  await callWith(named, "canvas_apply_patch", {
    session: "batch-review",
    expectedRevision: snap.data.revision,
    operations: [{ op: "update_node", id: "x", label: "Renamed by reviewer" }],
  });
  const changes = await callWith(a, "canvas_get_changes", { session: "batch-review", sinceRevision: snap.data.revision });
  assert.equal(changes.data.changes[0].actor, "reviewer");
  await Promise.all([a.close(), b.close(), named.close()]);
});

test("layout is shared via the browser API but never shown to agents", async () => {
  const res = await fetch(`${BASE}/api/s/batch-review/layout`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ positions: { x: { x: 120, y: 80 }, ghost: { x: 1, y: 1 } } }),
  });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${BASE}/api/s/batch-review/state`)).json();
  assert.deepEqual(state.layout, { x: { x: 120, y: 80 } }, "unknown node ids are ignored");
  const snap = await call("canvas_get_snapshot", { session: "batch-review" });
  assert.doesNotMatch(JSON.stringify(snap.data), /layout|"x":120/);
});

test("edge attachment points are layout: shared, cleared with null, never shown to agents", async () => {
  const s0 = await call("canvas_get_snapshot", { session: "batch-review" });
  const r = await call("canvas_apply_patch", {
    session: "batch-review",
    expectedRevision: s0.data.revision,
    operations: [{ op: "add_node", id: "y", label: "Next" }, { op: "add_edge", id: "xy", from: "x", to: "y" }],
  });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const post = (anchors: unknown) =>
    fetch(`${BASE}/api/s/batch-review/layout`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ anchors }),
    });
  assert.equal((await post({ xy: { from: { side: "right", t: 0.25 }, to: { side: "top", t: 0.8 } }, ghost: { to: { side: "top", t: 0.5 } } })).status, 200);
  assert.equal((await post({ xy: { from: { side: "middle", t: 0.5 } } })).status, 400);
  let state = await (await fetch(`${BASE}/api/s/batch-review/state`)).json();
  assert.deepEqual(state.anchors, { xy: { from: { side: "right", t: 0.25 }, to: { side: "top", t: 0.8 } } });
  await post({ xy: { from: null } });
  state = await (await fetch(`${BASE}/api/s/batch-review/state`)).json();
  assert.deepEqual(state.anchors, { xy: { to: { side: "top", t: 0.8 } } });
  const snap = await call("canvas_get_snapshot", { session: "batch-review" });
  assert.doesNotMatch(JSON.stringify(snap.data), /anchors|"side"/);
});

test("sessions survive a restart, and connected agents keep working", async () => {
  const before = await call("canvas_get_snapshot", { session: "batch-review" });
  await stopServer(server);
  assert.ok(readdirSync(DATA_DIR).includes("batch-review"));
  server = await startServer();

  // Same client, old MCP connection id: served statelessly instead of failing.
  const after = await call("canvas_get_snapshot", { session: "batch-review" });
  assert.equal(after.isError, false, JSON.stringify(after.data));
  assert.deepEqual(after.data, before.data);
  const changes = await call("canvas_get_changes", { session: "batch-review", sinceRevision: before.data.revision - 1 });
  assert.equal(changes.data.snapshotRequired, true, "change log is not persisted; agents re-read the snapshot");
  const state = await (await fetch(`${BASE}/api/s/batch-review/state`)).json();
  assert.deepEqual(state.layout, { x: { x: 120, y: 80 } });
  const next = await call("canvas_apply_patch", {
    session: "batch-review",
    expectedRevision: after.data.revision,
    operations: [{ op: "add_annotation", nodeIds: ["x"] }],
  });
  assert.deepEqual(next.data.createdAnnotationIds, [2], "mark numbering continues after restart");
});

test("browser can delete a session but not the default one", async () => {
  const del = await fetch(`${BASE}/api/s/batch-review`, { method: "DELETE", headers: { origin: BASE } });
  assert.equal(del.status, 200);
  assert.ok(!readdirSync(DATA_DIR).includes("batch-review"));
  const delDefault = await fetch(`${BASE}/api/s/default`, { method: "DELETE", headers: { origin: BASE } });
  assert.equal(delDefault.status, 400);
});

test("a session exports to a file and imports back as a new session", async () => {
  const snap = await call("canvas_get_snapshot");
  await call("canvas_apply_patch", {
    expectedRevision: snap.data.revision,
    operations: [{ op: "add_node", id: "exp", label: "Exported step" }],
  });
  const exported = await fetch(`${BASE}/api/s/default/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition") ?? "", /default\.canvas\.json/);
  const file = await exported.text();

  const importAs = (body: string, name?: string) =>
    fetch(`${BASE}/api/sessions/import${name ? `?name=${name}` : ""}`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: BASE },
      body,
    });
  const taken = await importAs(file);
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "session_exists", message: 'session "default" already exists', name: "default" });

  const imported = await importAs(file, "restored");
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).name, "restored");
  const copy = await call("canvas_get_snapshot", { session: "restored" });
  assert.match(copy.data.diagram, /Exported step/);
  assert.notEqual(copy.data.sessionId, (await call("canvas_get_snapshot")).data.sessionId, "an import gets its own session id");
  await waitFor(() => readdirSync(DATA_DIR).includes("restored"));

  for (const bad of ["not json", "{}", JSON.stringify({ version: 1, name: "broken", model: {} })]) {
    const res = await importAs(bad, "broken");
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error, "invalid_session_file");
  }
});

test("marks are answered in their own thread, never by rewriting the user's note", async () => {
  const s0 = await call("canvas_get_snapshot");
  const made = await userPatch(s0.data.revision, [{ op: "add_annotation", nodeIds: ["exp"], text: "why is this here?" }]);
  const id = made.data.createdAnnotationIds[0];
  let snap = await call("canvas_get_snapshot");
  assert.equal(snap.data.annotations.find((a: { id: number }) => a.id === id).awaitingReply, true);

  const rewrite = await call("canvas_apply_patch", { expectedRevision: snap.data.revision, operations: [{ op: "update_annotation", id, text: "answered" }] });
  assert.equal(rewrite.data.error, "reply_instead");

  const reply = await call("canvas_apply_patch", {
    expectedRevision: snap.data.revision,
    operations: [
      { op: "update_node", id: "exp", label: "Exported step (kept for the export test)" },
      { op: "reply_annotation", id, text: "Renamed exp to say why it exists." },
    ],
  });
  assert.equal(reply.isError, false, JSON.stringify(reply.data));
  snap = await call("canvas_get_snapshot");
  const mark = snap.data.annotations.find((a: { id: number }) => a.id === id);
  assert.equal(mark.text, "why is this here?");
  assert.equal(mark.by, "user");
  assert.equal(mark.awaitingReply, undefined, "the agent had the last word");
  assert.deepEqual(
    mark.replies.map((r: { by: string; agent?: string; text: string }) => [r.by, typeof r.agent, r.text]),
    [["agent", "string", "Renamed exp to say why it exists."]],
  );

  const followUp = await userPatch(snap.data.revision, [{ op: "reply_annotation", id, text: "ok, but shorter" }]);
  assert.equal(followUp.status, 200);
  snap = await call("canvas_get_snapshot");
  assert.equal(snap.data.annotations.find((a: { id: number }) => a.id === id).awaitingReply, true, "a user follow-up reopens the thread");

  // The agent's own marks stay editable by the agent, and need no answer from it.
  const own = await call("canvas_apply_patch", { expectedRevision: snap.data.revision, operations: [{ op: "add_annotation", nodeIds: ["exp"], kind: "question", text: "keep it?" }] });
  const ownId = own.data.createdAnnotationIds[0];
  snap = await call("canvas_get_snapshot");
  const ownMark = snap.data.annotations.find((a: { id: number }) => a.id === ownId);
  assert.equal(ownMark.by, "agent");
  assert.equal(ownMark.awaitingReply, undefined);
  const edit = await call("canvas_apply_patch", { expectedRevision: snap.data.revision, operations: [{ op: "update_annotation", id: ownId, text: "keep it at all?" }] });
  assert.equal(edit.isError, false);
});

async function waitFor(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("sequence diagrams: MCP draw -> browser edit and mark -> MCP read -> agent edit -> live push", async () => {
  const created = await call("canvas_create_session", { session: "timeline", type: "sequence" });
  assert.equal(created.data.type, "sequence");
  const s0 = await call("canvas_get_snapshot", { session: "timeline" });
  assert.equal(s0.data.type, "sequence");
  const drawn = await call("canvas_replace_diagram", {
    session: "timeline",
    expectedRevision: s0.data.revision,
    annotations: "clear",
    mermaid: "sequenceDiagram\n participant API\n participant S as Service\n API->>+S: Get result\n S-->>-API: Result",
  });
  assert.deepEqual(drawn.data.generatedIds, ["m1", "m2"]);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=timeline`, { origin: BASE });
  const pushes: Array<{ type: string; state?: { sequence: { items: Array<{ id: string; text?: string }> } } }> = [];
  ws.on("message", (b) => pushes.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.once("open", r));

  // The browser adds a message after m1 and marks two events, exactly as the editor does.
  const user = await fetch(`${BASE}/api/s/timeline/patch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      expectedRevision: drawn.data.revision,
      operations: [
        { op: "add_message", from: "S", to: "S", text: "Validate", position: { after: "m1" } },
        { op: "add_annotation", elementIds: ["m1", "m2"], kind: "question", text: "Check race condition" },
      ],
    }),
  }).then((r) => r.json());
  assert.deepEqual(user.createdElementIds, ["m3"]);

  const snap = await call("canvas_get_snapshot", { session: "timeline" });
  assert.match(snap.data.diagram, /%%@m1\n {4}API->>\+S: Get result\n {4}%%@m3\n {4}S->>S: Validate\n/);
  assert.deepEqual(snap.data.annotations[0].elementIds, ["m1", "m2"]);
  assert.equal(JSON.stringify(snap.data).includes('"x"'), false, "no geometry for agents");
  const changes = await call("canvas_get_changes", { session: "timeline", sinceRevision: drawn.data.revision });
  assert.deepEqual(changes.data.changes[0].ops[0], { op: "add_message", type: "message", id: "m3", from: "S", to: "S", arrow: "->>", text: "Validate", after: "m1" });

  // A flowchart op is refused with guidance; a sequence op from the agent reaches the browser live.
  const wrong = await call("canvas_apply_patch", { session: "timeline", expectedRevision: snap.data.revision, operations: [{ op: "add_node", label: "x" }] });
  assert.equal(wrong.data.error, "wrong_diagram_type");
  await call("canvas_apply_patch", {
    session: "timeline",
    expectedRevision: snap.data.revision,
    operations: [{ op: "add_fragment", kind: "alt", label: "valid", sections: ["invalid"], wrap: ["m3"] }],
  });
  await new Promise((r) => setTimeout(r, 150));
  ws.close();
  const last = pushes.filter((p) => p.type === "state").at(-1);
  assert.ok(last?.state?.sequence.items.some((i) => i.id === "f1"), "browser received the fragment");
  assert.match((await call("canvas_get_snapshot")).data.diagram, /^flowchart/, "default flowchart session unaffected");
});

test("the visualization skill is served read-only over MCP and HTTP", async () => {
  const before = await call("canvas_list_sessions");
  const res = (await client.callTool({ name: "canvas_get_visualization_skill", arguments: {} })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: { skill_name: string; server_version: string; tools: string[]; skill_markdown: string };
  };
  assert.ok(!res.isError);
  const md = res.content[0].text;
  assert.match(md, /^---\nname: visual-canvas\ndescription: /);
  assert.equal(res.structuredContent?.skill_name, "visual-canvas");
  assert.equal(res.structuredContent?.skill_markdown, md, "clients that read only structuredContent still get the whole skill");
  assert.ok(res.structuredContent?.tools.includes("canvas_apply_patch"));
  const { tools } = await client.listTools();
  assert.deepEqual([...(res.structuredContent?.tools ?? [])].sort(), tools.map((t) => t.name).sort(), "skill lists exactly the live tools");
  const http = await fetch(`${BASE}/skill.md`);
  assert.equal(http.status, 200);
  assert.match(http.headers.get("content-type") ?? "", /markdown/);
  assert.equal(await http.text(), md);
  const after = await call("canvas_list_sessions");
  assert.deepEqual(
    after.data.sessions.map((s: { name: string; revision: number }) => [s.name, s.revision]),
    before.data.sessions.map((s: { name: string; revision: number }) => [s.name, s.revision]),
    "no canvas changed",
  );
});
