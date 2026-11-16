// Spawns the real canvas server and the Claude Code channel bridge (as Claude Code would, over
// stdio) and checks which browser edits reach the agent as channel notifications.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const PORT = 4392;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "canvas-channel-"));
const QUIET_MS = 300;
let server: ChildProcess;
let channel: Client;
let agent: Client;

const ChannelNotification = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});
type Notification = z.infer<typeof ChannelNotification>["params"];
const received: Notification[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Notifications that arrive within `ms` after the last edit (bursts settle after QUIET_MS). */
async function collect(ms = QUIET_MS + 700): Promise<Notification[]> {
  await sleep(ms);
  return received.splice(0);
}

async function revision(session = "default"): Promise<number> {
  const res = await fetch(`${BASE}/api/s/${session}/state`);
  return ((await res.json()) as { revision: number }).revision;
}

async function userPatch(operations: unknown[], session = "default") {
  const res = await fetch(`${BASE}/api/s/${session}/patch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ expectedRevision: await revision(session), operations }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json() as Promise<{ revision: number; createdAnnotationIds?: number[] }>;
}

async function agentCall(name: string, args: Record<string, unknown>) {
  const res = (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, CANVAS_PORT: String(PORT), CANVAS_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on("data", (b) => b.toString().includes("MCP:") && resolve());
    server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });

  channel = new Client({ name: "claude-code", version: "1.0.0" });
  channel.setNotificationHandler(ChannelNotification, (n) => void received.push(n.params));
  await channel.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "server/channel.ts"],
      env: { ...(process.env as Record<string, string>), CANVAS_URL: BASE, CANVAS_CHANNEL_QUIET_MS: String(QUIET_MS) },
      stderr: "ignore",
    }),
  );
  // Wait until the bridge follows the event stream.
  for (let i = 0; i < 50; i++) {
    const res = (await channel.callTool({ name: "canvas_channel_watch", arguments: {} })) as { content: Array<{ text: string }> };
    if (JSON.parse(res.content[0].text).connectedToCanvas) break;
    await sleep(100);
  }

  agent = new Client({ name: "agent", version: "1.0.0" });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?agent=tester`)));
  await agentCall("canvas_replace_diagram", {
    expectedRevision: await revision(),
    annotations: "clear",
    mermaid: 'flowchart TD\n  a["Receive order"] e1@--> b{"Valid?"}\n  b e2@-->|"Yes"| c["Ship"]\n  b e3@-->|"No"| d["Reject"]',
  });
  await collect();
});

after(async () => {
  await agent?.close();
  await channel?.close();
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test("the bridge is a Claude Code channel with a watch tool", () => {
  assert.deepEqual(channel.getServerCapabilities()?.experimental, { "claude/channel": {} });
  assert.match(channel.getInstructions() ?? "", /canvas_get_changes/);
});

test("a label edit in the browser notifies once, with a pointer to the change", async () => {
  const before = await revision();
  const { revision: after } = await userPatch([{ op: "update_node", id: "c", label: "Ship order" }]);
  const [n, ...rest] = await collect();
  assert.equal(rest.length, 0);
  assert.equal(n.meta?.session, "default");
  assert.equal(n.meta?.revision, String(after));
  assert.equal(n.meta?.since_revision, String(before));
  assert.equal(n.meta?.categories, "mermaid");
  assert.match(n.content, /canvas_get_changes \{session: "default", sinceRevision: \d+\}/);
  assert.match(n.content, /Touched: c\./);
  assert.doesNotMatch(n.content, /Ship order/, "content is a pointer, never the user's text");
});

test("relationship changes notify", async () => {
  await userPatch([{ op: "add_edge", id: "e4", from: "d", to: "a", label: "Fix and resend" }]);
  const [n] = await collect();
  assert.equal(n?.meta?.categories, "mermaid");
  await userPatch([{ op: "remove_edge", id: "e4" }]);
  assert.equal((await collect()).length, 1);
});

test("moving, resizing or re-anchoring (layout only) never notifies", async () => {
  const res = await fetch(`${BASE}/api/s/default/layout`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ positions: { a: { x: 400, y: 10, w: 220 } }, anchors: { e1: { from: { side: "right", t: 0.5 } } }, client: "t" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await collect(), []);
});

test("agent edits do not notify the agent about its own work", async () => {
  await agentCall("canvas_apply_patch", { expectedRevision: await revision(), operations: [{ op: "update_node", id: "d", label: "Reject order" }] });
  assert.deepEqual(await collect(), []);
});

test("a burst of diagram and mark edits becomes one event covering both categories", async () => {
  const before = await revision();
  await userPatch([{ op: "update_node", id: "a", label: "Receive" }]);
  const { createdAnnotationIds } = await userPatch([{ op: "add_annotation", nodeIds: ["b"], kind: "question" }]);
  await userPatch([{ op: "update_annotation", id: createdAnnotationIds![0], text: "What makes an order valid?" }]);
  const notes = await collect();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].meta?.categories, "annotations,mermaid");
  assert.equal(notes[0].meta?.since_revision, String(before));
  assert.equal(notes[0].meta?.revision, String(await revision()));
  assert.match(notes[0].content, new RegExp(`#${createdAnnotationIds![0]}`));

  // Replies and deletions of marks notify too.
  await userPatch([{ op: "reply_annotation", id: createdAnnotationIds![0], text: "and who decides?" }]);
  assert.equal((await collect())[0]?.meta?.categories, "annotations");
  await userPatch([{ op: "remove_annotation", id: createdAnnotationIds![0] }]);
  assert.equal((await collect())[0]?.meta?.categories, "annotations");
});

test("sequence diagram edits notify; canvas_channel_watch limits sessions", async () => {
  await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: "seq", type: "sequence" }),
  });
  await userPatch([{ op: "add_participant", id: "A" }, { op: "add_participant", id: "B" }], "seq");
  const [n] = await collect();
  assert.equal(n?.meta?.session, "seq");

  await channel.callTool({ name: "canvas_channel_watch", arguments: { sessions: ["seq"] } });
  await userPatch([{ op: "update_node", id: "c", label: "Ship it" }]);
  assert.deepEqual(await collect(), [], "default is no longer watched");
  await userPatch([{ op: "add_message", from: "A", to: "B", text: "hello" }], "seq");
  assert.equal((await collect())[0]?.meta?.session, "seq");
  await channel.callTool({ name: "canvas_channel_watch", arguments: { sessions: ["*"] } });
});

test("the event stream refuses other web origins", async () => {
  const res = await fetch(`${BASE}/api/events`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});
