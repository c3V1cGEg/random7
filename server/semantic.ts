// Agent-facing change notifications: committed, user-made changes to what agents read (the diagram
// as Mermaid, and the marks). Layout never commits a change event, so moves, resizes and anchors
// never show up here; agent edits are left out so an agent is not told about its own work.

import type { ChangeEvent, ChangeOp } from "./types.ts";

export type SemanticCategory = "mermaid" | "annotations";

/** One committed user change, as streamed on GET /api/events (a pointer, not the content). */
export interface SemanticChange {
  type: "diagram.semantic.changed";
  /** Stable per change: the session's id (new after a reset) plus the revision. */
  eventId: string;
  session: string;
  sessionId: string;
  revision: number;
  origin: "user";
  categories: SemanticCategory[];
  /** Element ids and mark references (`#3`) the change touched. */
  changedIds: string[];
  /** Operation names only; never labels or note text. */
  ops: string[];
}

const ANNOTATION_OPS = new Set(["add_annotation", "update_annotation", "remove_annotation", "reply_annotation"]);
/** Bookkeeping entries recorded alongside the effective ops of an undo/redo. */
const MARKER_OPS = new Set(["undo", "redo"]);

function refs(op: ChangeOp): string[] {
  const out: string[] = [];
  if (typeof op.id === "number") out.push(`#${op.id}`);
  else if (typeof op.id === "string") out.push(op.id);
  return out;
}

/** Null when the event is not a user change to agent-visible content. */
export function semanticChange(session: string, sessionId: string, event: ChangeEvent): SemanticChange | null {
  if (event.source !== "user") return null;
  const ops = event.ops.filter((o) => !MARKER_OPS.has(o.op));
  if (!ops.length) return null;
  const categories = new Set<SemanticCategory>();
  for (const o of ops) {
    if (o.op === "reset_session") {
      categories.add("mermaid").add("annotations");
    } else {
      categories.add(ANNOTATION_OPS.has(o.op) ? "annotations" : "mermaid");
    }
  }
  return {
    type: "diagram.semantic.changed",
    eventId: `${sessionId}:${event.revision}`,
    session,
    sessionId,
    revision: event.revision,
    origin: "user",
    categories: (["mermaid", "annotations"] as const).filter((c) => categories.has(c)),
    changedIds: [...new Set(ops.flatMap(refs))],
    ops: ops.map((o) => o.op),
  };
}
