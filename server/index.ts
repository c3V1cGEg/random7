// One local process: serves the browser editor, the browser API/WebSocket and the MCP
// Streamable HTTP endpoint, all sharing one SessionManager of named canvas sessions.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.ts";
import { buildSkill } from "./skill.ts";
import { TOOL_SPECS, capabilities } from "./tools.ts";
import { PatchSchema } from "./ops.ts";
import { DEFAULT_SESSION, SessionManager } from "./sessions.ts";
import { semanticChange, type SemanticChange } from "./semantic.ts";
import type { CanvasStore } from "./store.ts";
import { CanvasError, SIDES } from "./types.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CANVAS_PORT ?? 4317);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.CANVAS_PERSIST === "0" ? null : path.resolve(process.env.CANVAS_DATA_DIR ?? path.join(ROOT, ".canvas-sessions"));
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const sessions = new SessionManager(DATA_DIR);
const app = createMcpExpressApp({ host: HOST }); // includes Host-header (DNS rebinding) validation

/** A malicious web page cannot forge Origin; reject any cross-origin request. */
function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!originAllowed(req.headers.origin)) {
    res.status(403).json({ error: "forbidden_origin", message: "cross-origin requests are not allowed" });
    return;
  }
  next();
});

// --- Agent identity and presence ----------------------------------------------------

const cleanName = (s: unknown) =>
  typeof s === "string" ? s.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) : "";

/**
 * Each MCP connection gets a display name: `?agent=<name>` from the connection URL if given,
 * otherwise the client's own name (e.g. "claude-code"), suffixed -2, -3… while another live
 * connection already uses it, so simultaneous agents are always distinguishable.
 */
const liveAgents = new Map<string, number>();

function allocateAgentName(requested: unknown, clientName: unknown): string {
  let name = cleanName(requested);
  if (!name) {
    const base = cleanName(clientName) || "agent";
    name = base;
    for (let i = 2; liveAgents.has(name); i++) name = `${base}-${i}`;
  }
  liveAgents.set(name, (liveAgents.get(name) ?? 0) + 1);
  return name;
}

function releaseAgentName(name: string) {
  const n = (liveAgents.get(name) ?? 1) - 1;
  if (n > 0) liveAgents.set(name, n);
  else liveAgents.delete(name);
}

/** Last tool call per agent per session, shown in the editor's presence bar. */
const presence = new Map<string, Map<string, { tool: string; at: number }>>();

function recordAgentActivity(agent: string, tool: string, session: string | null) {
  if (!session || !sessions.has(session)) return;
  const bySession = presence.get(session) ?? new Map();
  bySession.set(agent, { tool, at: Date.now() });
  presence.set(session, bySession);
  broadcast(session, agentsMessage(session));
}

function agentsMessage(session: string) {
  const agents = [...(presence.get(session) ?? new Map()).entries()].map(([name, a]) => ({ name, ...a }));
  return { type: "agents", agents };
}

// --- MCP (Streamable HTTP, one MCP session per agent connection) ----------------------

const mcpConnections = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  try {
    const existing = sid ? mcpConnections.get(sid) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (!sid && isInitializeRequest(req.body)) {
      const agent = allocateAgentName(req.query.agent, req.body.params.clientInfo?.name);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          mcpConnections.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId && mcpConnections.delete(transport.sessionId)) releaseAgentName(agent);
      };
      await createMcpServer(sessions, agent, recordAgentActivity).connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    // Unknown connection id (typically: the server restarted while the agent stayed connected).
    // Serve the request statelessly so the agent keeps working instead of failing until it reconnects.
    const agent = cleanName(req.query.agent) || `agent-${(sid ?? "anon").slice(0, 4)}`;
    const server = createMcpServer(sessions, agent, recordAgentActivity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const mcpSessionRequest = async (req: Request, res: Response) => {
  const transport = mcpConnections.get(req.header("mcp-session-id") ?? "");
  if (!transport) {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "No such MCP session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res);
};
app.get("/mcp", mcpSessionRequest);
app.delete("/mcp", mcpSessionRequest);

// --- Browser API (same stores, same operation semantics as MCP) ------------------------

function sendError(res: Response, err: unknown) {
  if (err instanceof CanvasError) {
    const status = err.code.endsWith("conflict") || err.code === "session_exists" ? 409 : err.code === "session_not_found" ? 404 : 400;
    res.status(status).json(err.toJSON());
  } else {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "internal error" });
  }
}

/** Runs a handler against the session named in the URL, mapping CanvasErrors to HTTP errors. */
const withSession =
  (fn: (store: CanvasStore, req: Request, res: Response) => unknown) =>
  (req: Request, res: Response) => {
    try {
      const result = fn(sessions.get(String(req.params.session)), req, res);
      if (result !== undefined) res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  };

// The agent skill as a file, e.g. curl http://127.0.0.1:4317/skill.md -o ~/.claude/skills/visual-canvas/SKILL.md
app.get("/skill.md", (_req, res) => {
  try {
    res.type("text/markdown; charset=utf-8").send(buildSkill(TOOL_SPECS, capabilities()).markdown);
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: sessions.list() });
});

// --- agent-facing change stream (Server-Sent Events) ----------------------------------
// Committed user changes to the diagram or marks, as compact pointers (never content). The Claude
// Code channel bridge (server/channel.ts) turns them into notifications for a running session.
// Loopback only, like everything here: the Host check covers DNS rebinding, the Origin check web pages.

const eventStreams = new Set<Response>();

app.get("/api/events", (req, res) => {
  if (!originAllowed(req.headers.origin)) return void res.status(403).json({ error: "forbidden" });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  eventStreams.add(res);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    eventStreams.delete(res);
  });
});

function streamChange(change: SemanticChange) {
  const chunk = `id: ${change.eventId}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;
  for (const res of eventStreams) res.write(chunk);
}

app.post("/api/sessions", (req, res) => {
  try {
    const store = sessions.create(
      String(req.body?.name ?? ""),
      typeof req.body?.title === "string" ? req.body.title : undefined,
      req.body?.type === "sequence" ? "sequence" : "flowchart",
    );
    res.json(store.summary());
  } catch (err) {
    sendError(res, err);
  }
});

// Session files travel as text: they can outgrow the 100 kB limit of the global JSON parser.
app.post("/api/sessions/import", express.text({ type: "*/*", limit: "20mb" }), (req, res) => {
  try {
    let data: unknown;
    try {
      data = JSON.parse(String(req.body ?? ""));
    } catch {
      throw new CanvasError("invalid_session_file", "the file is not valid JSON");
    }
    const name = typeof req.query.name === "string" && req.query.name ? req.query.name : undefined;
    res.json(sessions.import(data, name).summary());
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/s/:session/export", withSession((store, _req, res) => {
  res.attachment(`${store.name}.canvas.json`).type("application/json").send(JSON.stringify(store.toStored(), null, 1));
  return undefined;
}));

app.delete("/api/s/:session", (req, res) => {
  try {
    sessions.delete(String(req.params.session));
    presence.delete(String(req.params.session));
    res.json({ deleted: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/s/:session/state", withSession((store) => store.browserState()));

const BrowserPatchSchema = PatchSchema.extend({ undoGroup: z.string().max(64).optional() });

app.post(
  "/api/s/:session/patch",
  withSession((store, req, res) => {
    const parsed = BrowserPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_patch", message: parsed.error.message });
      return undefined;
    }
    const { expectedRevision, operations, undoGroup } = parsed.data;
    return store.applyPatch(expectedRevision, operations, "user", undoGroup);
  }),
);

const AnchorSchema = z.object({ side: z.enum(SIDES), t: z.number().min(0).max(1) });
const LayoutSchema = z.object({
  positions: z.record(z.string().max(64), z.object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() })).default({}),
  /** Edge attachment points by edge id; null puts that end back to automatic. */
  anchors: z.record(z.string().max(64), z.object({ from: AnchorSchema.nullable().optional(), to: AnchorSchema.nullable().optional() })).default({}),
  client: z.string().max(64).optional(),
});

app.post(
  "/api/s/:session/layout",
  withSession((store, req, res) => {
    const parsed = LayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_layout", message: parsed.error.message });
      return undefined;
    }
    store.setLayout(parsed.data.positions, parsed.data.client, parsed.data.anchors);
    return { ok: true };
  }),
);

app.post("/api/s/:session/reset", withSession((store) => store.reset("user")));
app.post("/api/s/:session/undo", withSession((store) => store.undo()));
app.post("/api/s/:session/redo", withSession((store) => store.redo()));

// Malformed or oversized bodies get a machine-readable error instead of Express's HTML page.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: err.type ?? "bad_request", message: status === 500 ? "internal error" : err.message });
});

// --- Static browser app (one page; the session comes from the /s/<name> path) ----------

const clientDist = path.join(ROOT, "client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("/s/:session", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.type("text").send("Client not built. Run `npm run build` first.");
  });
}

// --- WebSocket push, per session ------------------------------------------------------

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const socketInfo = new WeakMap<WebSocket, { session: string; client?: string }>();

httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const ok = url.pathname === "/ws" && ALLOWED_HOSTS.has(req.headers.host ?? "") && originAllowed(req.headers.origin);
  if (!ok) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    socketInfo.set(ws, {
      session: (url.searchParams.get("session") ?? DEFAULT_SESSION).toLowerCase(),
      client: url.searchParams.get("client") ?? undefined,
    });
    wss.emit("connection", ws, req);
  });
});

function broadcast(session: string | null, message: object, exceptClient?: string) {
  const msg = JSON.stringify(message);
  for (const ws of wss.clients) {
    const info = socketInfo.get(ws);
    if (ws.readyState !== ws.OPEN || !info) continue;
    if (session !== null && info.session !== session) continue;
    if (exceptClient && info.client === exceptClient) continue;
    ws.send(msg);
  }
}

wss.on("connection", (ws: WebSocket) => {
  const info = socketInfo.get(ws)!;
  ws.send(JSON.stringify({ type: "sessions", sessions: sessions.list() }));
  if (!sessions.has(info.session)) {
    ws.send(JSON.stringify({ type: "error", error: "session_not_found", session: info.session }));
    return;
  }
  ws.send(JSON.stringify({ type: "state", state: sessions.get(info.session).browserState() }));
  ws.send(JSON.stringify(agentsMessage(info.session)));
});

let listTimer: ReturnType<typeof setTimeout> | undefined;
sessions.setEvents({
  change: (store, event) => {
    broadcast(store.name, { type: "state", state: store.browserState(), event });
    const change = semanticChange(store.name, store.sessionId, event);
    if (change) streamChange(change);
  },
  layout: (store, positions, origin, anchors) => broadcast(store.name, { type: "layout", positions, anchors: anchors ?? {} }, origin),
  // The session list (for the switcher) changes on every edit; coalesce those broadcasts.
  listChanged: () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => broadcast(null, { type: "sessions", sessions: sessions.list() }), 300);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sessions.flush();
    process.exit(0);
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Visual Agent Canvas`);
  console.log(`  editor: http://${HOST}:${PORT}/`);
  console.log(`  MCP:    http://${HOST}:${PORT}/mcp   (Streamable HTTP; add ?agent=<name> to name the agent)`);
  console.log(
    DATA_DIR
      ? `  sessions saved in ${DATA_DIR} (${sessions.list().map((s) => s.name).join(", ")})`
      : `  sessions are in memory only (CANVAS_PERSIST=0)`,
  );
});
