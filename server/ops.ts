// Patch operation vocabulary shared by the MCP tools and the browser HTTP API,
// so both sides go through exactly the same validation and semantics.

import { z } from "zod";
import { FRAGMENT_KINDS, NOTE_PLACEMENTS, SEQ_ARROWS } from "./sequence.ts";
import { ANNOTATION_KINDS, CHANGE_STATUSES, DIAGRAM_TYPES, LIMITS, NODE_SHAPES } from "./types.ts";

const id = z.string().min(1).max(64);
/** Mermaid-style `<br>` sent inside JSON would show up literally; it means a line break, so store `\n`. */
const lineBreaks = (s: string) => s.replace(/<br\s*\/?>/gi, "\n");
const label = z.string().max(LIMITS.labelLength).overwrite(lineBreaks);
const shape = z.enum(NODE_SHAPES as [string, ...string[]]);
const kind = z.enum(ANNOTATION_KINDS);
const text = z.string().max(LIMITS.textLength);
const ids = z.array(id).max(LIMITS.nodes + LIMITS.edges);
const status = z.enum(CHANGE_STATUSES).describe("Proposal status: new | changed | removed (omit for existing, unchanged)");
const statusUpdate = z.enum(CHANGE_STATUSES).nullable().optional().describe("new | changed | removed; null clears it (existing)");

const seqText = z.string().max(LIMITS.labelLength).overwrite(lineBreaks).describe("Text; \\n for a line break");
const position = z
  .object({
    after: id.optional(),
    before: id.optional(),
    in: id.optional().describe("Fragment id: insert into one of its sections"),
    section: z.number().int().nonnegative().optional().describe("Section index inside `in` (0 = first; default last)"),
    index: z.number().int().nonnegative().optional().describe("Index within the section (or top level without `in`); default: append"),
  })
  .describe("Where on the timeline: {after:id} | {before:id} | {in:fragmentId, section?, index?} | {index}. Default: at the end");

/** Sequence-diagram operations (only valid in sessions of type "sequence"). */
function sequenceOperations() {
  const participantKind = z.enum(["participant", "actor"]);
  return [
    z.object({ op: z.literal("set_diagram_type"), type: z.enum(DIAGRAM_TYPES) }).describe("Only on an empty canvas"),
    z.object({
      op: z.literal("add_participant"),
      id: id.optional().describe("Mermaid participant id (e.g. W1); generated p<k> if omitted"),
      label: label.optional(),
      kind: participantKind.optional(),
      before: id.optional().describe("Insert the lane before this participant (default: last)"),
      status: status.optional(),
    }),
    z.object({
      op: z.literal("update_participant"),
      id,
      label: label.optional(),
      kind: participantKind.optional(),
      before: id.nullable().optional().describe("Move the lane before this participant; null = last"),
      status: statusUpdate,
    }),
    z.object({ op: z.literal("remove_participant"), id }).describe("Also removes its messages, notes and activations"),
    z.object({
      op: z.literal("add_message"),
      id: id.optional(),
      from: id,
      to: id,
      text: seqText,
      arrow: z.enum(SEQ_ARROWS).optional().describe("->> request (default), -->> reply, -) async, --) async reply, -x / --x failed, -> / --> plain"),
      activate: z.boolean().optional().describe("Starts an activation on the target (A->>+B)"),
      deactivate: z.boolean().optional().describe("Ends the sender's activation (B-->>-A)"),
      status: status.optional(),
      position: position.optional(),
    }),
    z.object({
      op: z.literal("update_message"),
      id,
      from: id.optional(),
      to: id.optional(),
      text: seqText.optional(),
      arrow: z.enum(SEQ_ARROWS).optional(),
      activate: z.boolean().optional(),
      deactivate: z.boolean().optional(),
      status: statusUpdate,
    }),
    z.object({
      op: z.literal("add_note"),
      id: id.optional(),
      participants: z.array(id).min(1).max(2),
      placement: z.enum(NOTE_PLACEMENTS).optional().describe("over (default) | left of | right of"),
      text: seqText,
      status: status.optional(),
      position: position.optional(),
    }),
    z.object({
      op: z.literal("update_note"),
      id,
      participants: z.array(id).min(1).max(2).optional(),
      placement: z.enum(NOTE_PLACEMENTS).optional(),
      text: seqText.optional(),
      status: statusUpdate,
    }),
    z.object({
      op: z.literal("add_activation"),
      id: id.optional(),
      participant: id,
      action: z.enum(["activate", "deactivate"]),
      status: status.optional(),
      position: position.optional(),
    }),
    z.object({
      op: z.literal("add_fragment"),
      id: id.optional(),
      kind: z.enum(FRAGMENT_KINDS),
      label: label.optional().describe("Condition / description of the first section"),
      sections: z.array(label).max(10).optional().describe("Labels of further sections (else / and / option)"),
      wrap: z.array(id).max(LIMITS.opsPerPatch).optional().describe("Consecutive sibling items to move into the first section"),
      status: status.optional(),
      position: position.optional().describe("Default: where the wrapped items were, else at the end"),
    }),
    z.object({
      op: z.literal("update_fragment"),
      id,
      kind: z.enum(FRAGMENT_KINDS).optional(),
      labels: z.array(label).min(1).max(10).optional().describe("All section labels; extra entries add empty sections, missing ones remove (empty) sections"),
      status: statusUpdate,
    }),
    z.object({
      op: z.literal("remove_item"),
      id,
      keepContents: z.boolean().optional().describe("Fragments: keep the items inside (unwrap) instead of deleting them"),
    }),
    z.object({ op: z.literal("move_item"), id, position }),
  ] as const;
}

export const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    id: id.optional().describe("Optional explicit id; generated (n<k>) if omitted"),
    label: label.describe("Title line; optional detail lines after \\n (prefix '+ ' added, '- ' dropped, '~ ' modified)"),
    shape: shape.optional().describe("action (default) | decision | terminal | store (a persistent data store, not a save step)"),
    status: status.optional(),
  }),
  z.object({ op: z.literal("update_node"), id, label: label.optional(), shape: shape.optional(), status: statusUpdate }),
  z.object({ op: z.literal("remove_node"), id }),
  z.object({
    op: z.literal("add_edge"),
    id: id.optional().describe("Optional explicit id; generated (e<k>) if omitted"),
    from: id,
    to: id,
    label: label.optional(),
    status: status.optional(),
  }),
  z.object({
    op: z.literal("update_edge"),
    id,
    from: id.optional(),
    to: id.optional(),
    label: label.nullable().optional().describe("null or empty string clears the label"),
    status: statusUpdate,
  }),
  z.object({ op: z.literal("remove_edge"), id }),
  z.object({
    op: z.literal("add_annotation"),
    nodeIds: ids.optional(),
    edgeIds: ids.optional(),
    elementIds: ids.optional().describe("Sequence diagrams: participant/message/note/fragment ids"),
    kind: kind.optional(),
    text: text.optional(),
  }),
  z.object({
    op: z.literal("update_annotation"),
    id: z.number().int().positive(),
    nodeIds: ids.optional().describe("Replaces the node target list when given"),
    edgeIds: ids.optional().describe("Replaces the edge target list when given"),
    elementIds: ids.optional().describe("Sequence diagrams: replaces the element target list when given"),
    kind: kind.nullable().optional(),
    text: text.nullable().optional(),
  }),
  z.object({ op: z.literal("reply_annotation"), id: z.number().int().positive(), text: text.min(1) })
    .describe("Answer mark #id in its own thread (the way to respond to a user's mark; the mark's text stays as written)"),
  z.object({ op: z.literal("remove_annotation"), id: z.number().int().positive() }),
  z.object({ op: z.literal("set_direction"), direction: z.enum(["TD", "LR"]) }),
  ...sequenceOperations(),
  z.object({
    op: z.literal("accept_changes"),
  }).describe("Applies the proposal: deletes everything marked removed and clears all new/changed statuses"),
]);

export type Operation = z.infer<typeof OperationSchema>;
export type Position = z.infer<typeof position>;

export const PatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(OperationSchema).min(1).max(LIMITS.opsPerPatch),
});
