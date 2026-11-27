import type { BrowserState, HistoryItem, RevisionInfo, SessionSummary } from "../../server/store.ts";
import type { Operation } from "../../server/ops.ts";
import type { ChangeEvent, EdgeEnds, EdgeEndsPatch, XY } from "../../server/types.ts";

export type { BrowserState, HistoryItem, Operation, ChangeEvent, RevisionInfo, SessionSummary };

/** The canvas session comes from the page URL: /s/<name>, or "default" at /. */
export const SESSION = decodeURIComponent(location.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? "default").toLowerCase();
/** Identifies this tab, so the server does not echo its own layout changes back to it. */
export const CLIENT_ID = crypto.randomUUID();

const base = `/api/s/${encodeURIComponent(SESSION)}`;

export interface PatchResponse {
  revision: number;
  createdNodeIds?: string[];
  createdEdgeIds?: string[];
  createdAnnotationIds?: number[];
  createdElementIds?: string[];
  undoable?: boolean;
}

export class ConflictError extends Error {}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (res.status === 409 && json.error === "revision_conflict") throw new ConflictError(json.message);
  if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
  return json;
}

/**
 * Set while this tab previews an earlier revision: every edit sent then carries it, and the server
 * continues from that revision (once per id, so edits sent together fork once).
 */
let fork: { base: number; id: string } | null = null;
export const setFork = (f: typeof fork) => void (fork = f);
const forked = <T extends object>(body: T) => (fork ? { ...body, fork } : body);

export const postPatch = (expectedRevision: number, operations: Operation[], undoGroup?: string) =>
  post<PatchResponse>(`${base}/patch`, forked({ expectedRevision, operations, ...(undoGroup ? { undoGroup } : {}) }));

/** Undo/redo the user's last `steps` steps on the server. Throws with a readable reason on conflict. */
export const postHistory = (direction: "undo" | "redo", steps = 1) =>
  post<{ revision: number; ops: Array<{ op: string } & Record<string, unknown>>; steps: HistoryItem[] }>(`${base}/${direction}`, forked({ steps }));

/** Every revision of this session, newest first. */
export const fetchRevisions = async (): Promise<{ head: number; revisions: RevisionInfo[] }> => (await fetch(`${base}/revisions`)).json();

/** An earlier revision, to preview it (its `viewing` is set). */
export async function fetchRevision(revision: number): Promise<BrowserState> {
  const res = await fetch(`${base}/revisions/${revision}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
  return json;
}

/** Clears a session's diagram and marks (any session, so the tab menu can clear tabs that are not open). */
export const resetSession = (name: string) => post(`/api/s/${encodeURIComponent(name)}/reset`);

/**
 * Shares node positions with other browsers and saves them with the session (never sent to agents).
 * `record` makes it an undo step listed under that name (the user's own moves and resizes).
 */
export const postLayout = (positions: Record<string, XY>, anchors: Record<string, EdgeEndsPatch> = {}, record?: string, join?: boolean) =>
  post(`${base}/layout`, forked({ positions, anchors, client: CLIENT_ID, ...(record ? { record } : {}), ...(join ? { join } : {}) }));

export const createSession = (name: string, type: "flowchart" | "sequence" | "state" = "flowchart") => post<SessionSummary>("/api/sessions", { name, type });

/** Download URL of a session's export file (the same JSON the server keeps on disk). */
export const exportUrl = (name: string) => `/api/s/${encodeURIComponent(name)}/export`;

export class SessionExistsError extends Error {
  constructor(readonly name: string) {
    super(`session "${name}" already exists`);
  }
}

/** Imports an exported session file as a new session, under `name` or the name stored in the file. */
export async function importSession(fileText: string, name?: string): Promise<SessionSummary> {
  const res = await fetch(`/api/sessions/import${name ? `?name=${encodeURIComponent(name)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: fileText,
  });
  const json = await res.json();
  if (json.error === "session_exists") throw new SessionExistsError(json.name);
  if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
  return json;
}

export async function deleteSession(name: string): Promise<void> {
  const res = await fetch(`/api/s/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).message);
}

/** How to refer to this canvas in a prompt, so the agent passes the right session. */
export const canvasRef = () => (SESSION === "default" ? "the visual canvas" : `the visual canvas (session "${SESSION}")`);

export const sessionUrl = (name: string) => (name === "default" ? "/" : `/s/${encodeURIComponent(name)}`);

const params = new URLSearchParams(location.search);
/** This page is one half of a split view (an iframe of the page that holds the tabs). */
export const EMBEDDED = params.has("embed");
/** Split view: the session shown on the right, next to SESSION on the left (`?right=<name>`). */
export const SPLIT_RIGHT = EMBEDDED ? null : (params.get("right")?.toLowerCase() || null);
export const splitUrl = (left: string, right: string) => `${sessionUrl(left)}?right=${encodeURIComponent(right)}`;
export const embedUrl = (name: string) => `${sessionUrl(name)}?embed=1`;

export interface AgentInfo {
  name: string;
  tool: string;
  at: number;
}

export type SocketMessage =
  | { type: "state"; state: BrowserState; event?: ChangeEvent }
  | { type: "layout"; positions: Record<string, XY>; anchors?: Record<string, EdgeEnds> }
  | { type: "history"; history: BrowserState["history"] }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "error"; error: string; session: string };

/** Connects to this session's push channel and reconnects forever; each (re)connect delivers a fresh full state. */
export function connectSocket(onMessage: (m: SocketMessage) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    const q = `session=${encodeURIComponent(SESSION)}&client=${CLIENT_ID}`;
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${q}`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus(false);
      if (!closed) timer = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}

/** What an activity entry points at, so clicking it can reveal the element or mark. */
export type OpTarget = { element: string } | { mark: number } | undefined;

export function opTarget(op: { op: string } & Record<string, unknown>): OpTarget {
  if (op.op.endsWith("_annotation")) return op.op === "remove_annotation" ? undefined : { mark: op.id as number };
  if (/^(add|update)_(node|edge|participant|message|note|activation|fragment)$/.test(op.op) || op.op === "move_item") {
    return { element: op.id as string };
  }
  if ((op.op === "set_instance" || op.op === "add_instance" || op.op === "update_instance") && typeof op.state === "string") return { element: op.state };
  return undefined;
}

const AGENT_TOOL_TEXT: Record<string, string> = {
  canvas_get_capabilities: "connected",
  canvas_get_visualization_skill: "read the drawing guide",
  canvas_get_snapshot: "read the canvas",
  canvas_get_changes: "checked your changes",
  canvas_apply_patch: "edited the canvas",
  canvas_replace_diagram: "drew the diagram",
};

export const describeAgentTool = (tool: string) => AGENT_TOOL_TEXT[tool] ?? tool;

export function describeOp(op: { op: string } & Record<string, unknown>): string {
  const q = (s: unknown) => (typeof s === "string" ? `"${s.length > 40 ? s.slice(0, 40) + "…" : s}"`.replace(/\n/g, " · ") : "");
  const st = (s: unknown) => (s === undefined ? "" : s === null ? " [existing]" : ` [${s}]`);
  switch (op.op) {
    case "add_node":
      return `added ${op.id} ${q(op.label)}${st(op.status)}`;
    case "update_node":
      return `changed ${op.id}${op.label !== undefined ? ` → ${q(op.label)}` : ""}${op.newId ? `, value now ${op.newId}` : ""}${op.shape ? ` (${op.shape})` : ""}${st(op.status)}`;
    case "remove_node":
      return `removed ${op.id}`;
    case "add_edge":
      return `connected ${op.from} ${op.both ? "↔" : "→"} ${op.to}${op.label ? ` ${q(op.label)}` : ""} (${op.id})${st(op.status)}`;
    case "update_edge":
      return `changed edge ${op.id}${op.from || op.to ? " endpoints" : ""}${op.both !== undefined ? (op.both ? " to two-way" : " to one-way") : ""}${op.label !== undefined ? ` label ${op.label === null ? "cleared" : q(op.label)}` : ""}${st(op.status)}`;
    case "remove_edge":
      return `removed edge ${op.id}`;
    case "add_annotation":
      return `created mark #${op.id}`;
    case "update_annotation":
      return op.reason ? `mark #${op.id} lost deleted targets${op.orphaned ? " (orphaned)" : ""}` : `edited mark #${op.id}`;
    case "remove_annotation":
      return `deleted mark #${op.id}`;
    case "reply_annotation":
      return `replied to mark #${op.id}: ${q(op.text)}`;
    case "replace_diagram":
      return op.type === "sequence"
        ? `drew sequence diagram (${op.participants} participants, ${op.items} items)`
        : op.type === "state"
          ? `drew state diagram (${op.nodes} states, ${op.edges} transitions)`
          : `drew diagram (${op.nodes} nodes, ${op.edges} edges)`;
    case "set_diagram_type":
      return `switched to a ${op.type === "sequence" ? "sequence diagram" : op.type === "state" ? "state diagram" : "flowchart"}`;
    case "set_instance":
    case "add_instance":
    case "update_instance":
      if (op.reason) return `${op.id} ${op.orphaned ? "lost its state" : "is back in its state"}`;
      if (op.from && op.state) return `moved ${op.id} ${op.from} → ${op.state}${op.via ? ` (${[op.via].flat().join(" → ")})` : ""}`;
      if (op.op !== "update_instance" && op.label) return `placed ${q(op.label)} in ${op.state}`;
      return `changed ${op.id}${op.state ? ` (in ${op.state})` : ""}${op.fields !== undefined ? " fields" : ""}`;
    case "remove_instance":
      return `removed ${op.id}`;
    case "add_participant":
      return `added lane ${op.id} ${q(op.label)}${st(op.status)}`;
    case "update_participant":
      return `changed lane ${op.id}${op.label !== undefined ? ` → ${q(op.label)}` : ""}${op.before !== undefined ? " (moved)" : ""}${st(op.status)}`;
    case "remove_participant":
      return `removed lane ${op.id}`;
    case "add_message":
      return `added message ${op.from} → ${op.to} ${q(op.text)}${st(op.status)}`;
    case "update_message":
      return `changed message ${op.id}${op.text !== undefined ? ` → ${q(op.text)}` : ""}${op.from || op.to ? " (lanes)" : ""}${op.arrow ? ` (${op.arrow})` : ""}${st(op.status)}`;
    case "add_note":
      return `added note ${q(op.text)}`;
    case "update_note":
      return `changed note ${op.id}${op.text !== undefined ? ` → ${q(op.text)}` : ""}${st(op.status)}`;
    case "add_activation":
      return `added ${op.type} ${op.participant}`;
    case "add_fragment":
      return `added ${op.kind} block ${op.id}`;
    case "update_fragment":
      return `changed block ${op.id}${op.kind ? ` (${op.kind})` : ""}${st(op.status)}`;
    case "remove_item":
      return `removed ${op.id}${op.keepContents ? " (kept its contents)" : ""}`;
    case "move_item":
      return `moved ${op.id}`;
    case "restore_sequence":
      return "restored the sequence diagram";
    case "reset_session":
      return "started a new empty session";
    case "undo":
    case "redo":
      return `${op.op === "undo" ? "undid" : "redid"} ${op.steps ? `${op.steps} steps` : "a step"}`;
    case "restore_revision":
      return `went back to rev ${op.revision}`;
    case "set_direction":
      return `set direction ${op.direction}`;
    default:
      return op.op;
  }
}

/** One undo step as the undo list shows it. */
export const describeStep = (h: HistoryItem) =>
  h.label ?? `${h.ops[0] ? describeOp(h.ops[0]) : "change"}${h.count > 1 ? ` (+${h.count - 1} more)` : ""}`;
