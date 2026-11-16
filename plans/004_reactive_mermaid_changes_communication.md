# Visual Agent Canvas — Reactive Mermaid & Annotation Changes via Claude Code Channels

**Status:** Implementation brief for an agent with access to the existing repository  
**Language:** English  
**Prepared:** 2026-11-16  
**Scope:** Extend the existing application; do not replace its working canvas, diagram types, MCP integration, or Claude Code skill.

## 1. Goal

Make the existing Visual Agent Canvas a reactive collaboration surface. When a user changes the **agent-visible meaning** of a diagram or its annotations in the browser, a **running Claude Code session** should be notified automatically and able to retrieve the updated state through the application's **existing MCP tools**. The user must not have to return to the terminal and say “look at the canvas again.”

This is **not** a general-purpose UI event feed, a rebuild of the canvas, or a request to change the existing skill.

## 2. Established Architecture and Boundaries

The application already has:

- An interactive browser canvas with editable diagram elements.
- Mermaid-backed diagram content, including flowcharts and sequence diagrams.
- Annotations, markers, and comments.
- MCP tools through which Claude Code reads and modifies the shared diagram context.
- Browser-owned layout, coordinates, visual arrangement, and viewport state.

**Only Mermaid content and annotations are exchanged with the agent through MCP.** The browser's graphical layout is intentionally separate and is **not** part of the agent-facing change stream.

The existing MCP transport, schemas, tool names, storage system, and frontend architecture are **unknown to this document**. Inspect the repository before choosing implementation details. Reuse current APIs and tools rather than inventing replacements.

## 3. What Must Trigger a Notification

Trigger on **successfully committed, user-originated, agent-visible semantic changes** to either data category:

### Mermaid content

- Adding or deleting nodes, participants, messages, or other diagram entities.
- Editing entity names, labels, text, or meaningful properties.
- Adding, removing, or changing relationships and their endpoints.
- Changing sequence-diagram messages, ordering, branches, or other behavior represented in Mermaid.
- Any other persisted, meaningful change reflected in the Mermaid representation the agent reads.

### Annotations

- Creating, updating, or deleting annotations or markers.
- Adding, editing, or deleting marker comments.
- Editing other annotation content visible to the agent via existing MCP tools.

**Do not notify** for movement or resizing that changes only layout, coordinate updates, zoom/pan, selection, hover, viewport state, or styling that has no agent-visible meaning. Merely saving a file or UI state is not itself a trigger.

**Detection rule:** compare or classify the **persisted agent-facing Mermaid and annotation state**, preferably at the existing persistence/synchronization boundary. Do not attach a separate notification to every mouse or UI event. If the implementation stores harmless formatting differences in Mermaid text, avoid treating whitespace-only or serialization-only changes as semantic edits when a safe comparison is possible.

If a change touches both Mermaid content and annotations, it can produce **one logical event**. Preserve distinct change categories in the event metadata.

## 4. Target Data Flow

```text
User edits Visual Canvas in browser
              |
              v
Existing application persists Mermaid and/or annotations
              |
              v
Check committed agent-visible semantic change
              |
     +--------+---------+
     |                  |
   No change          Changed
     |                  |
     v                  v
No notification   Create application event
                        |
                        v
                 Local channel adapter
                        |
          MCP stdio notification:
          notifications/claude/channel
                        |
                        v
                Running Claude Code
                        |
                        v
         Read current Mermaid + annotations
         using EXISTING MCP tools
                        |
                        v
                Agent responds/acts
```

Use an internal application event name such as `diagram.semantic.changed` **only as a suggested internal convention**; it is **not** an MCP protocol method. The external Claude Code Channel notification method is `notifications/claude/channel`.

The notification should contain a **compact pointer to the latest state**, not the full diagram.

Suggested event information (adapt to actual schema):

```json
{
  "type": "diagram.semantic.changed",
  "eventId": "<unique-event-id>",
  "diagramId": "<diagram-id>",
  "revision": "<persisted-revision>",
  "origin": "user",
  "categories": ["mermaid", "annotations"],
  "changedIds": ["<element-or-annotation-id>"]
}
```

The object above is a **design example**, not an assertion about existing database fields or a required MCP payload schema. When a revision is unavailable, determine the smallest reliable alternative (for example, a content version or monotonic change counter).

## 5. Claude Code Channels Integration

### 5.1 Architecture choice

Claude Code Channels can inject external events into an **already-running** Claude Code session. A custom Channel is an MCP server launched locally by Claude Code over **stdio**.

First inspect the current MCP integration. If it is already compatible with a local stdio Channel, consider a minimal extension. If it is HTTP-based or not suited to proactive notifications, **keep it intact** and add a small **local Channel bridge** subscribing to or receiving the application's committed semantic-change events.

A local HTTP callback to the bridge, a local event subscription, or another already-supported internal event mechanism is acceptable. Pick the simplest secure approach supported by the repository.

### 5.2 Protocol contract (verified against Claude Code documentation)

A custom Channel server must:

- Connect to Claude Code using the MCP **stdio transport**.
- Declare `capabilities.experimental['claude/channel'] = {}`.
- Send MCP notifications with method `notifications/claude/channel`.
- Provide clear MCP server `instructions` explaining how Claude should interpret incoming events and retrieve updated data.

The notification parameters are `content` (a string) and optional `meta` (a string-to-string map). `meta` keys must use only letters, digits, or underscores. A valid conceptual mapping is:

```js
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'Visual Canvas semantic change. Read current Mermaid and annotations for diagram <id>.',
    meta: { diagram_id: '<id>', event_id: '<event-id>', revision: '<revision>' },
  },
})
```

This is an **illustrative fragment**, not a complete channel-server implementation. Do not embed unchecked user-provided instructions in server-generated authority text; treat comment content as untrusted user input and retain the application's authentication boundaries.

The existing MCP tools remain the authoritative read/write interface. A dedicated Channel reply tool is **optional**, not an MVP prerequisite, if existing MCP tools already support the needed canvas updates. If the product needs explicit “processed” acknowledgment in the browser, design an acknowledgment path separately.

### 5.3 Claude Code setup to include in the implementation

A working solution **must include** Claude Code-side configuration, not just backend code:

1. Register the local Channel server in an appropriate Claude Code MCP configuration, such as project `.mcp.json`.
2. Supply the **real executable path**, args, runtime, and any required environment variables based on the implementation.
3. Document project trust and first-run MCP-server consent.
4. Document how to launch an interactive Claude Code session with the development Channel enabled.
5. Provide a quick end-to-end test demonstrating that the event arrives in the same active session.

Illustrative `.mcp.json` structure — **replace command and script with actual repository values**:

```json
{
  "mcpServers": {
    "visual-canvas-channel": {
      "command": "node",
      "args": ["./path/to/channel-server.js"]
    }
  }
}
```

During the current research preview, for a **trusted local custom server** registered under the above name:

```bash
claude --dangerously-load-development-channels server:visual-canvas-channel
```

This is **not** `--dangerously-skip-permissions`. The development-channel flag bypasses the **Channel allowlist for the explicitly named server** after an interactive confirmation; it does not override organization policy or normal tool-approval rules. The development flag is not a supported way to register the channel in non-interactive `-p` / Agent SDK mode.

Channels are in **research preview**. Claude Code requires supported Anthropic authentication; some managed organizations must explicitly enable Channels. A Channel is active only while the relevant Claude Code session remains open. If requirements or flags change, follow the current official Claude Code documentation rather than relying on old examples.

### 5.4 Delivery and lifecycle constraints

- Channel events enter the active Claude Code session; notifications may queue while Claude is busy.
- A successful `mcp.notification()` call means **transport write**, **not** “Claude processed it.” Claude Code does not automatically acknowledge a Channel event.
- When the session is absent, not channel-enabled, or organization policy blocks it, do not claim guaranteed delivery. Define a clear offline behavior and optional replay strategy if required.
- Route events only to appropriate, authorized local sessions; if several sessions exist, do not broadcast to unrelated projects by accident.
- Avoid exposing an unauthenticated public listener. Bind local listeners to loopback when possible, authenticate the event source, and validate project/diagram/session scope.

## 6. Change Filtering and Feedback-Loop Protection

Implement at least the following:

- **User-origin filtering:** user-authored semantic updates trigger events; changes written by the agent should not automatically cause the same agent to re-trigger itself.
- **Persistence-first:** send only after the state is committed successfully.
- **Deduplication:** stable event IDs and/or persisted revisions; do not process the same logical edit repeatedly.
- **Burst control:** coalesce frequent text edits or related changes into a single event after save/commit, without losing the final revision.
- **Ordering and freshness:** identify later revisions; when multiple events arrive, fetch the newest authoritative state rather than assuming every intermediate state must be processed separately.
- **Failure visibility:** surface channel connection/registration problems in logs or diagnostics; do not falsely mark changes as handled.
- **Security:** annotations and comments are content to analyze, not privileged system instructions. Follow ordinary Claude Code tool-approval boundaries.

Do not add complicated infrastructure unless the repository or tests show it is needed.

## 7. Instructions for the Repository-Aware Implementation Agent

**First analyze; then implement the smallest viable extension.**

1. Locate the authoritative Mermaid and annotation stores, update methods, persistence boundaries, and existing agent-origin attribution if any.
2. Identify the existing MCP server transport(s), registration, tool names, and agent-facing data retrieval methods.
3. Determine where semantic changes can be observed with minimal duplication and without layout-only notifications.
4. Choose between extending a compatible local stdio MCP server and adding a local Channel bridge. Explain the choice briefly.
5. Implement event filtering, compact payloads, correct MCP Channel declaration and notifications, plus Claude Code registration/startup configuration.
6. Provide an integration test or reproducible manual test showing both a positive trigger and a negative layout-only case.
7. Document any unresolved repository-specific constraints or Channel-preview limitations. Do **not** invent non-existent tools or fields.

**Do not modify the current Claude Code skill.** Preserve flowchart and sequence-diagram editing, annotations, existing MCP tools, and working workflows.

## 8. MVP Acceptance Tests

| Scenario | Expected behavior |
| --- | --- |
| User changes a Mermaid node label and saves | One Channel notification; Claude can read latest Mermaid |
| User adds/removes a relationship | Notification; updated relationships available through MCP |
| User changes sequence-diagram logic | Notification; latest Mermaid accessible |
| User adds/edits/deletes a marker comment | Notification; latest annotations accessible through MCP |
| User moves a node but does not change agent-facing data | **No notification** |
| User zooms, pans, or selects a node | **No notification** |
| User edits Mermaid and annotations in one committed operation | Prefer one coherent event covering both categories |
| Agent changes diagram via MCP | No self-triggered notification loop |
| Several text edits occur before save | No per-keystroke flood; notify committed result |
| Channel not enabled or no active Claude session | No false “processed” status; clear operational behavior |
| Channel enabled in a running Claude Code session | Agent receives an event without another terminal prompt and can load latest Mermaid + annotations |

## 9. Deliverables

- Minimal code changes needed to emit persisted Mermaid/annotation semantic-change events.
- A local Claude Code Channel server or bridge.
- Claude Code MCP configuration and startup instructions.
- Tests or a documented reproducible local verification procedure.
- A short explanation of architectural decisions and any known limitations.

**Success condition:** The user modifies Mermaid content or annotations in Visual Agent Canvas, saves the meaningful change, and the **already-running** Claude Code agent can react using its existing MCP tools without a new terminal message. Purely visual canvas changes remain silent.

## Official Documentation

- Claude Code Channels: https://code.claude.com/docs/en/channels
- Claude Code Channels reference (capability, notification schema, local server, preview flag, security): https://code.claude.com/docs/en/channels-reference

Documentation checked: 2026-11-16. Treat research-preview behavior as version-dependent.
