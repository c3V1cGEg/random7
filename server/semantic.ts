// Agent-facing change notifications: committed, user-made changes to what agents read (the diagram
// as Mermaid, and the marks). Layout never commits a change event, so moves, resizes and anchors
// never show up here; agent edits are left out so an agent is not told about its own work.

import type { Annotation, ChangeEvent, ChangeOp } from "./types.ts";

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

/** What the filter needs from a session (a CanvasStore). */
export interface SessionView {
  name: string;
  sessionId: string;
  annotation(id: number): Annotation | undefined;
  writtenMarks(): number[];
}

const ANNOTATION_OPS = new Set(["add_annotation", "update_annotation", "remove_annotation", "reply_annotation"]);
/** Bookkeeping entries recorded alongside the effective ops of an undo/redo. */
const MARKER_OPS = new Set(["undo", "redo"]);

const written = (a: Annotation | undefined) => !!a && (!!a.text || !!a.replies?.length);

/**
 * Decides which user changes are worth telling an agent about. Besides layout and agent edits it
 * leaves out:
 * - marks still being written: pressing M creates an empty mark and the note follows when the user
 *   leaves the text box, so a mark counts from its first text (or reply); picking its kind or
 *   targets before that, or deleting it unwritten, stays quiet;
 * - clearing a canvas (nothing is left to respond to).
 */
export class SemanticFilter {
  /** Per session: marks that have had text, so deleting one of them is news. */
  private known = new Map<string, Set<number>>();

  /** Remembers which marks a session not seen before already has written (loaded from disk, imported). */
  track(session: SessionView) {
    if (!this.known.has(session.sessionId)) this.known.set(session.sessionId, new Set(session.writtenMarks()));
  }

  change(session: SessionView, event: ChangeEvent): SemanticChange | null {
    this.track(session);
    const known = this.known.get(session.sessionId)!;
    if (event.source !== "user") {
      // Still track agent-written marks, so the user deleting one is reported.
      for (const id of session.writtenMarks()) known.add(id);
      return null;
    }
    const ops = event.ops.filter((o) => {
      if (MARKER_OPS.has(o.op) || o.op === "reset_session") return false;
      if (!ANNOTATION_OPS.has(o.op) || typeof o.id !== "number") return true;
      if (o.op === "remove_annotation") return known.delete(o.id);
      if (!written(session.annotation(o.id))) return false;
      known.add(o.id);
      return true;
    });
    if (!ops.length) return null;
    const categories = new Set(ops.map((o): SemanticCategory => (ANNOTATION_OPS.has(o.op) ? "annotations" : "mermaid")));
    return {
      type: "diagram.semantic.changed",
      eventId: `${session.sessionId}:${event.revision}`,
      session: session.name,
      sessionId: session.sessionId,
      revision: event.revision,
      origin: "user",
      categories: (["mermaid", "annotations"] as const).filter((c) => categories.has(c)),
      changedIds: [...new Set(ops.flatMap(refs))],
      ops: ops.map((o) => o.op),
    };
  }
}

function refs(op: ChangeOp): string[] {
  if (typeof op.id === "number") return [`#${op.id}`];
  if (typeof op.id === "string") return [op.id];
  return [];
}
