import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_VERSION } from "./skill.ts";
import { DEFAULT_SESSION, type SessionManager } from "./sessions.ts";
import { SKILL_TOOL, TOOL_SPECS } from "./tools.ts";
import { CanvasError } from "./types.ts";

const INSTRUCTIONS = `Visual Agent Canvas: shared, live flowcharts the user is looking at in a browser.
- The server holds several named canvas sessions. Pass the session the user names (e.g. session: "batch-review") to every tool; it defaults to "default". Use canvas_list_sessions to see them; create one with canvas_create_session only when the user asks for a new canvas.
- A session holds one diagram type: a flowchart (business process) or a sequence diagram (time / concurrency: participants exchanging messages, parallel workers, waiting, locks, transactions, retries). canvas_get_snapshot returns its type. Choose the type that answers the user's question; canvas_replace_diagram with a "sequenceDiagram" header turns the session into a sequence diagram.
- Sequence diagrams: the user sees a left-to-right logical timeline with one lane per participant; step numbers are ordering positions, not durations. Use par/and for work that is concurrent (do not serialize it), alt/else for success vs failure (commit vs rollback), loop for retries, critical/option for locked or transactional sections, activations (+/-) for ongoing work or waiting, notes for state. Only draw behavior the source or the user establishes; state ambiguity in a note or an "uncertain" mark instead of inventing it. Every message/note/fragment has a stable id shown as a %%@id line above it; keep those lines when you redraw, and use the ids in patches and marks (elementIds).
- Draw BUSINESS behavior (activities, decisions, data changes, failure outcomes), not classes, ports, adapters, pods or SQL, unless the user asks.
- Proposing a change to an existing flow: keep the existing blocks unmarked and give the rest a change status, which the editor colours and explains in a legend: new (green), changed (amber), removed (red, struck through; do not delete it yourself, the user accepts the proposal). In Mermaid: n4["Write audit row"]:::new, or class e3,e4 new for edges; in patches: status on add/update ops.
- Small additions inside an existing step belong in that step, not in a new box: add detail lines below its title (a line break: \n in patches, <br> in Mermaid) prefixed "+ " (added), "- " (dropped) or "~ " (modified), and mark the step changed. Example: n2["Save record<br>+ write audit log row per save"]:::changed. Use a separate new node only when the new logic is a step of its own (a decision, a failure path, another actor).
- Keep diagrams focused (roughly 5-20 nodes). Label uncertain interpretations as such (e.g. annotation kind "uncertain" or "(?)" in the label).
- Start with canvas_get_snapshot. Use canvas_replace_diagram only for the first drawing or an explicit redraw; prefer small canvas_apply_patch edits afterwards.
- "Mark #N" / "#N" refers to annotation id N in the snapshot. Resolve it to its nodeIds/edgeIds, text and replies.
- Answer marks only in their thread: for each mark you handle (awaitingReply: true), make the diagram edits and, in the same patch, add one {"op":"reply_annotation","id":N,"text":"<what you changed, with ids, or the answer>"}. Never rewrite a user's mark text or kind, never answer with a new mark.
- The user edits the canvas too. Always pass expectedRevision; on revision_conflict, call canvas_get_changes or canvas_get_snapshot and re-plan. Never undo or resurrect the user's edits or deleted marks unless asked.
- Changing the diagram must not trigger code changes. Wait for the user's instruction.
- Detail levels (low = business view, medium = technical overview, high = detailed technical behavior) and the full drawing conventions are in the skill returned by ${SKILL_TOOL}; read it before your first drawing in a conversation.`;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  const body =
    err instanceof CanvasError
      ? err.toJSON()
      : { error: "internal_error", message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

/** Reports which agent used which tool on which session (null for session-independent tools). */
export type AgentActivityListener = (agent: string, tool: string, session: string | null) => void;

/** One MCP server per agent connection; `agent` is that connection's display name. */
export function createMcpServer(sessions: SessionManager, agent: string, onActivity: AgentActivityListener = () => {}): McpServer {
  const server = new McpServer({ name: "visual-agent-canvas", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.inputSchema, ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}) },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const name = typeof args?.session === "string" ? args.session.trim().toLowerCase() : undefined;
        try {
          const result = spec.run(args ?? {}, { sessions, agent });
          onActivity(agent, spec.name, spec.global ? null : (name ?? DEFAULT_SESSION));
          return spec.raw ? (result as CallToolResult) : ok(result);
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
  return server;
}
