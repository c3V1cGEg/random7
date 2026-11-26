// The MCP tool surface, defined once: createMcpServer registers these specs, and the
// generated agent skill documents exactly the same names, arguments and capabilities.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { OperationSchema } from "./ops.ts";
import { DEFAULT_SESSION, type SessionManager } from "./sessions.ts";
import { buildSkill } from "./skill.ts";
import { ANNOTATION_KINDS, DIAGRAM_TYPES, LIMITS, type DiagramType } from "./types.ts";

export interface ToolContext {
  sessions: SessionManager;
  agent: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  readOnly?: boolean;
  /** Not tied to one session (activity is not shown on a canvas). */
  global?: boolean;
  /** Returns JSON-serialisable data, or a complete CallToolResult when `raw` is set. */
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
  raw?: boolean;
}

export const SKILL_TOOL = "canvas_get_visualization_skill";

const session = z
  .string()
  .max(48)
  .optional()
  .describe(`Canvas session name; defaults to "${DEFAULT_SESSION}". Use the session the user refers to.`);

const store = (ctx: ToolContext, name: unknown) => ctx.sessions.get(typeof name === "string" ? name : DEFAULT_SESSION);

/** Supported syntax, operations and rules of this server version. */
export function capabilities(agent?: string) {
  return {
  ...(agent ? { you: { agentName: agent, note: "Your edits are attributed to this name in the change log and the user's editor." } } : {}),
  diagram: {
    types: "A session is a flowchart, a sequence diagram or a state diagram (see sequenceDiagram and stateDiagram below). The snapshot's `type` says which.",
    syntax: "Mermaid flowchart subset",
    header: ["flowchart TD", "flowchart LR"],
    nodes: {
      action: 'n1["Do something"]',
      decision: 'n2{"Condition?"}',
      terminal: 'n3(["Start / End"])',
      store: 'db[("Orders database")]',
    },
    edges: ["n1 e1@--> n2", 'n2 e2@-->|"Yes"| n3'],
    changeStatus: {
      values: ["new", "changed", "removed"],
      nodes: 'n4["Write audit row"]:::new',
      edges: "class e5,e6 new",
      note: "Unmarked = existing. classDef lines are emitted for Mermaid renderers and ignored on input. accept_changes applies the proposal.",
    },
    detailLines: 'n2["Save record<br>+ write audit log row per save<br>- send email"]:::changed',
    detailLinesRule: "Up to 8 lines; prefix + added, - dropped, ~ modified.",
    notes: [
      "One statement per line. Node and edge ids share one namespace and are stable across edits.",
      'A store is a persistent thing (database, queue table, file); "Save order" stays an action pointing to it.',
      "Edges without eN@ get generated ids (reported in the result).",
      'Use #quot; for a double quote inside labels. Not supported: subgraph, style/linkStyle, -.->, ==>, &, chained edges.',
    ],
  },
  sequenceDiagram: {
    syntax: "Mermaid sequenceDiagram subset, rendered as a left-to-right logical timeline (lanes = participants; step numbers are ordering, not time)",
    example: [
      "sequenceDiagram",
      "    participant Q as Queue table",
      "    participant W1 as Worker 1",
      "    participant DB as Database",
      "    %%@m1",
      "    W1->>+Q: Select eligible batch",
      "    %%@f1",
      "    alt All records succeed",
      "        %%@m2",
      "        W1->>DB: Commit",
      "    else Processing fails",
      "        %%@m3 new",
      "        W1-xDB: Rollback",
      "    end",
      "    %%@t1",
      "    Note over W1,DB: transaction boundary",
    ].join("\n"),
    statements: [
      "participant ID [as Label] | actor ID [as Label] (lanes, top to bottom in declaration order)",
      "A->>B: text — arrows: ->> request, -->> reply, -) async, --) async reply, -x / --x failed, -> / --> plain; A->>+B activates B, B-->>-A ends B's activation",
      "Note over A[,B]: text | Note left of A: text | Note right of A: text",
      "activate A / deactivate A (ongoing work, waiting, holding a lock)",
      "alt cond / else cond / end; opt; loop; par label / and label / end (concurrent branches); critical / option; break",
    ],
    ids: "Each message, note, activation and fragment has an id in a `%%@id [new|changed|removed]` comment line just above it (valid Mermaid). Keep these lines when redrawing; items without one get generated ids (m<k>, t<k>, a<k>, f<k>). Participant ids are their Mermaid ids.",
    notSupported: "title, box, rect, create/destroy, links, bidirectional arrows. They are rejected with a line-numbered error, never dropped silently.",
    text: "#59; for ;, #35; for #, <br> for a line break.",
  },
  stateDiagram: {
    syntax:
      "Mermaid stateDiagram-v2 subset: a business-level overview of how the status of one thing behaves. States are its possible values (usually an enum in the code), transitions the business events that change it. Same node/edge operations and marks as flowcharts.",
    example: [
      "stateDiagram-v2",
      "    direction LR",
      '    state "Draft" as Draft',
      '    state "Submitted" as Submitted',
      "    Submitted : awaiting payment",
      '    state "Paid" as Paid',
      '    state "Payment failed" as Failed',
      "    state paymentOk <<choice>>",
      "    %%@e1",
      "    [*] --> Draft",
      "    %%@e2",
      "    Draft --> Submitted : submit",
      "    %%@e3",
      "    Submitted --> paymentOk : payment result",
      "    %%@e4",
      "    paymentOk --> Paid : [approved]",
      "    %%@e5",
      "    paymentOk --> Failed : [declined]",
      "    %%@e6 new",
      "    Failed --> Submitted : retry",
      "    %%@e7",
      "    Paid --> [*]",
      "    class Failed new",
    ].join("\n"),
    statements: [
      "direction LR (default: lifecycles read left to right) | direction TB",
      'state "Label" as Id — a state (shape state); Id : text adds a detail line under its title',
      "state Id <<choice>> — a choice point (shape choice; labelled by its id, so give it a meaningful id); put guards on its outgoing transitions: [approved]",
      "A --> B : event [guard] / action — a transition (an edge); [*] --> A starts, A --> [*] ends",
      'any --> B : event — possible from every state (cancel, delete…), drawn once and dashed. `any` is written as state "Any state" as any; nothing leads into it',
      "%%@initial / %%@final on a line of its own — a start or end that has no transition yet",
      "class Id1,Id2 new|changed|removed — proposal status of states; transitions carry it on their %%@ line",
    ],
    ids: "Each transition has an id in a `%%@id [new|changed|removed]` comment line just above it; keep these when redrawing (missing ones get generated e<k>). [*] is the node `initial` (as a source) or `final` (as a target); there is one of each.",
    shapes: "state (default) | initial | final | choice | any. Flowchart shapes are not allowed in state diagrams.",
    values:
      "A state's id is its value, e.g. the enum constant (InProgress, PAYMENT_FAILED). Rename one with update_node {id, newId}; transitions, marks and instances follow.",
    instances:
      "Runtime objects (an order, a ticket) shown as chips on the state they are in: set_instance / remove_instance. They are data, not part of the Mermaid text; the snapshot lists them under `instances`. Use `via` with the transition id when moving one (or the list of ids through choice points, e.g. ['e3','e4']), so the user sees which transition fired.",
    notSupported: "composite states (state X { }), parallel regions (--), <<fork>>/<<join>>, history states, notes, :::class. Rejected with a line-numbered error.",
  },
  operations: {
    add_node: "{id?, label, shape?, status?} — label: title line, then detail lines each after the JSON escape \\n (never <br> in JSON)",
    update_node: "{id, label?, shape?, status?|null}",
    remove_node: "{id} — also removes incident edges",
    add_edge: "{id?, from, to, label?, status?}",
    update_edge: "{id, from?, to?, label?|null, status?|null}",
    remove_edge: "{id}",
    add_annotation: "{nodeIds?, edgeIds?, kind?, text?} — id assigned by server",
    update_annotation: "{id, nodeIds?, edgeIds?, kind?|null, text?|null} — text/kind only on your own marks",
    reply_annotation: "{id, text} — answer mark #id in its thread (how you respond to every mark)",
    remove_annotation: "{id}",
    set_direction: "{direction: TD|LR}",
    accept_changes: "{} — deletes elements with status removed and clears every status (only when the user asks)",
    set_diagram_type: "{type: flowchart|sequence|state} — only on an empty canvas",
    set_instance: "{id, label?, state?, fields?: {name: value}|null, via?: transitionId | [ids through choice points]} — state diagrams: creates (label and state required) or updates/moves a runtime instance",
    remove_instance: "{id}",
    sequence: {
      position: "{after:id} | {before:id} | {in:fragmentId, section?, index?} | {index} — default: end of the timeline",
      add_participant: "{id?, label?, kind?: participant|actor, before?, status?}",
      update_participant: "{id, label?, kind?, before?: id|null (move lane), status?|null}",
      remove_participant: "{id} — also removes its messages, notes and activations",
      add_message: "{id?, from, to, text, arrow?, activate?, deactivate?, status?, position?}",
      update_message: "{id, from?, to?, text?, arrow?, activate?, deactivate?, status?|null}",
      add_note: "{id?, participants: [A] | [A,B], placement?: over|left of|right of, text, status?, position?}",
      update_note: "{id, participants?, placement?, text?, status?|null}",
      add_activation: "{id?, participant, action: activate|deactivate, status?, position?}",
      add_fragment: "{id?, kind: alt|opt|loop|par|critical|break, label?, sections?: [labels of else/and/option], wrap?: [consecutive sibling ids], status?, position?}",
      update_fragment: "{id, kind?, labels?: [all section labels], status?|null}",
      remove_item: "{id, keepContents?} — keepContents unwraps a fragment",
      move_item: "{id, position} — reorders; the only way order changes (the editor never reorders by dragging)",
      annotations: "add_annotation / update_annotation take elementIds (participant and item ids) instead of nodeIds/edgeIds",
    },
  },
  annotations: {
    kinds: ANNOTATION_KINDS,
    idRule: "Numbers start at 1 per session, increase monotonically and are never reused.",
    deletionPolicy:
      "When a referenced node/edge is removed, its id is dropped from the annotation; if no targets remain the annotation keeps its id and text and gets orphaned: true.",
  },
  sessions: `Every tool takes an optional session name (default "${DEFAULT_SESSION}"). Sessions are independent canvases with their own revisions and mark numbering, and are saved across server restarts.`,
  revisions:
    "Every committed change increments revision. Writes require expectedRevision == current revision, otherwise error revision_conflict. Patches are atomic.",
  limits: LIMITS,
};
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "canvas_get_capabilities",
    description: "Describe the supported Mermaid subset, patch operations, annotation schema and revision rules.",
    inputSchema: {},
    readOnly: true,
    global: true,
    run: (_a, ctx) => capabilities(ctx.agent),
  },
  {
    name: SKILL_TOOL,
    description:
      "Get the current Claude Code skill (SKILL.md) for collaboratively visualizing business and technical behavior on this live canvas: three detail levels (low/medium/high), drawing conventions and the exact tools of this server version. Read-only; installing it is up to the user.",
    inputSchema: {},
    readOnly: true,
    global: true,
    raw: true,
    run: (): CallToolResult => {
      const skill = buildSkill(TOOL_SPECS, capabilities());
      // Some clients (Claude Code) show the model only structuredContent when it is present,
      // so the Markdown must be in there too, not just in the text content.
      return {
        content: [{ type: "text", text: skill.markdown }],
        structuredContent: { skill_markdown: skill.markdown, ...skill.meta, save_as: "Write skill_markdown unchanged to install_paths.user or install_paths.project." },
      };
    },
  },
  {
    name: "canvas_get_snapshot",
    description:
      "Read the full current semantic state of a session: revision, diagram type, Mermaid diagram and annotations (marks #N). Contains no layout or styling.",
    inputSchema: { session },
    readOnly: true,
    run: (a, ctx) => store(ctx, a.session).snapshot(),
  },
  {
    name: "canvas_get_changes",
    description: "Read semantic changes (by user or agent) after a revision, oldest first. If history is unavailable, returns snapshotRequired: true.",
    inputSchema: { session, sinceRevision: z.number().int().nonnegative() },
    readOnly: true,
    run: (a, ctx) => store(ctx, a.session).changesSince(a.sinceRevision as number),
  },
  {
    name: "canvas_apply_patch",
    description:
      "Atomically apply operations: flowchart/state node/edge ops, state-diagram instance ops (set_instance, remove_instance), sequence ops (participants, messages, notes, activations, fragments, move_item) or annotation ops. Requires expectedRevision. Returns the new revision and any created ids.",
    inputSchema: {
      session,
      expectedRevision: z.number().int().nonnegative(),
      operations: z.array(OperationSchema).min(1).max(LIMITS.opsPerPatch),
    },
    run: (a, ctx) =>
      store(ctx, a.session).applyPatch(a.expectedRevision as number, a.operations as z.infer<typeof OperationSchema>[], "agent", undefined, ctx.agent),
  },
  {
    name: "canvas_replace_diagram",
    description:
      "Initialize or deliberately redraw the whole logical diagram from Mermaid (supported subset of flowchart, sequenceDiagram or stateDiagram-v2; the header sets the session's diagram type). Use for the first drawing; prefer canvas_apply_patch for edits. Ids that persist (node ids, %%@ ids) keep their marks and editor positions.",
    inputSchema: {
      session,
      expectedRevision: z.number().int().nonnegative(),
      mermaid: z.string().min(1).max(LIMITS.mermaidLength),
      annotations: z.enum(["keep", "clear"]).describe("keep: retain marks (targets that no longer exist are dropped); clear: delete all marks"),
    },
    run: (a, ctx) => store(ctx, a.session).replaceDiagram(a.expectedRevision as number, a.mermaid as string, a.annotations as "keep" | "clear", "agent", ctx.agent),
  },
  {
    name: "canvas_list_sessions",
    description: "List the canvas sessions (name, title, diagram type, revision, element and mark counts, last update), most recent first.",
    inputSchema: {},
    readOnly: true,
    global: true,
    run: (_a, ctx) => ({ sessions: ctx.sessions.list() }),
  },
  {
    name: "canvas_create_session",
    description: "Create a new, empty named canvas session (only when the user asks for a separate canvas). The user can open it in the browser at /s/<name>.",
    inputSchema: {
      session: z.string().max(48).describe("New session name: lowercase letters, digits, - or _"),
      title: z.string().max(120).optional().describe("Optional human-readable title"),
      type: z.enum(DIAGRAM_TYPES).optional().describe('Diagram type: "flowchart" (default), "sequence" or "state"'),
    },
    run: (a, ctx) => {
      const created = ctx.sessions.create(String(a.session ?? ""), a.title as string | undefined, a.type as DiagramType | undefined);
      return { session: created.name, type: created.type, revision: created.revision, url: `/s/${created.name}` };
    },
  },
];
