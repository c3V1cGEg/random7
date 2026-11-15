# Sequence Diagram / Logical Timeline Support — Requirements for Existing Visual Canvas

**Document type:** Feature requirements and codebase-analysis brief  
**Audience:** An engineering AI agent with access to the existing application repository  
**Status:** Proposed enhancement — investigate the repository before designing or implementing  
**Language:** English

## 1. Context

The existing application is an **interactive, shared visual canvas** used by a human and a coding agent to discuss software behavior. It already works well for business-process / flowchart-style diagrams. The human edits the canvas in a browser; the agent reads and changes its semantic contents through MCP. Visual presentation is deliberately separate from the information exposed to the agent.

The current conceptual architecture is:

1. **Diagram semantics:** Mermaid-based description of logical elements and relationships.
2. **Semantic annotation layer:** Stable references to elements, user selections/groups, numbered markers, and optional explanations or other meaning.
3. **Visual layer:** Layout, coordinates, shapes, positioning, and other presentation details maintained by the editor, not sent wholesale to the agent.
4. **MCP integration:** The agent reads/changes the shared live state; the user sees updates in the same running canvas and can edit it back.

The application may be presented in a local browser and hosted by a local service running alongside MCP in the same process. **Do not assume any particular framework, component structure, server transport, parser, or data model without examining the repository.**

This request is **not** to rebuild the editor or change the Claude Code skill. It is an extension to the existing, working canvas.

## 2. Goal

Add a **new diagram type** that can express **time-oriented and concurrent behavior** of a process: asynchronous/background processing, multiple workers, interleaved operations, interactions, waiting, locking, commits/rollbacks, retries, and relevant success/failure paths.

Use Mermaid's **`sequenceDiagram` syntax as the interchange/semantic description** where possible, and add a corresponding interactive visualization to the existing canvas.

The desired human visualization is a **horizontal logical timeline**:

- Time progresses conceptually **left to right**.
- Distinct actors/participants/workers/processes are displayed in separate lanes (typically stacked vertically).
- Events or intervals are placed along the timeline according to their logical ordering and concurrency constraints.
- An optional logical axis may show steps such as **0, 1, 2, 3, ...**. These are **abstract ordering positions**, **not seconds or milliseconds**.
- Parallel and overlapping operations should be visually apparent.

**Important:** Mermaid's own default rendering direction (e.g. a conventional sequence diagram read from top to bottom) is **not a blocker**. The current application's visual layer already renders Mermaid-based semantics according to its own rules and allows manual repositioning. Evaluate Mermaid as a **semantic interchange language**, not as the final renderer.

## 3. Scope and explicit non-goals

### In scope

- Introduce `sequenceDiagram` as an additional supported diagram type alongside the existing flowchart/business-process type.
- Parse and model useful sequence semantics, preserving participants, messages, control-flow fragments, and their relationships.
- Render those semantics as an interactive, readable **left-to-right logical timeline**.
- Support human editing and MCP-driven editing of the **same active diagram**.
- Preserve existing semantic annotations, selection/grouping, and stable reference behavior for the new diagram type, extending reference targets where necessary.
- Preserve existing flowchart support and its behavior.
- Specify any needed translation, serialization, validation, and synchronization rules.

### Out of scope for this enhancement

- Changing the existing Claude Code skill or introducing new skill levels.
- Replacing Mermaid or redesigning the whole MCP architecture.
- Generating an inventory of Java methods/classes or turning the view into a code-structure diagram.
- Requiring real timestamps, durations, telemetry, or a physically accurate time scale.
- Long-term persistence, project documentation/catalogues, or multi-user collaboration beyond capabilities that already exist.
- Building a full distributed-systems simulator or proving correctness of concurrency.
- Implementing every Mermaid sequence feature in the first version; unsupported constructs must, however, be handled explicitly rather than silently corrupted.

## 4. Core semantic requirements

### 4.1 Participants / lanes

Represent actors such as an API, scheduler, background worker, queue table, database, or external service as **participants**. Multiple workers can be modeled as independent participants when their concurrent behavior matters. The diagram may include a database-backed queue as a participant; this does **not** imply the application uses Kafka/RabbitMQ.

- Preserve each participant's stable identity, display label, and logical role.
- Support adding, renaming, and (where valid) removing participants through the editor and agent interface.
- Layout may change without changing participant identity or process semantics.

### 4.2 Events and interactions

Represent at least:

- Messages/interactions between participants, including request/reply or similar directional exchanges.
- Internal actions or significant states associated with one participant.
- Notes attached to participants, events, or event groups.
- Logical ordering: an event happens before another event **when the model establishes that dependency**.
- Alternative/conditional paths, repeat attempts, and meaningful processing phases.

**Do not infer a global total order for events that are only known to be concurrent.** A diagram may display such events at similar logical positions without asserting exact simultaneity.

### 4.3 Concurrent and asynchronous behavior

Represent concurrent branches without implying that one branch completes before another merely because it appears first in source text or on screen.

- Mermaid `par` / `and` should map to explicitly concurrent branches.
- Async initiation and completion can be shown independently where the source semantics permit this.
- Interleaved operations may appear on separate participant lanes.
- Show meaningful wait periods, resource contention, lock acquisition/release, and transaction boundaries where they are relevant to the scenario.
- A wait/lock is **not** automatically a deterministic duration. Use semantic annotations or intervals without claiming a real-time measurement.

### 4.4 Conditions and failures

Support useful Mermaid sequence constructs such as `alt` / `else`, `opt`, `loop`, `par` / `and`, and notes, subject to validation against the actual Mermaid version available in the repository. Consider `critical` and activation/deactivation semantics if practical.

At minimum, the visualization should be able to communicate:

- Success vs failure paths.
- Database operation succeeded vs failed.
- Transaction commit vs rollback.
- Lock obtained vs wait/retry/abort where specified.
- Background task started, retried, skipped, or completed.

Do not manufacture branches or technical behavior that the source does not specify. Where behavior is ambiguous, the agent should state the ambiguity rather than pretending to know the answer.

## 5. Logical timeline model

The horizontal axis is **logical/relative time**, not wall-clock time.

- Example ticks `0, 1, 2, 3` indicate display steps or ordering positions; **a difference of 1 has no defined physical duration**.
- The model may only require a **partial order** (dependencies), not a timestamp for each event.
- Events in different concurrent branches can overlap or be unordered; rendering must preserve that fact.
- A span/activation/processing interval can express **ongoing activity**, but its visual width is not a measured runtime unless explicitly modeled as such.
- Layout should be deterministic or at least stable for unchanged semantics; a small edit should not unnecessarily rearrange the entire drawing.
- Manual visual repositioning is allowed as a presentation action. It must **not silently rewrite causal or ordering semantics**. If the editor offers an explicit semantic rescheduling/reordering operation, that is a distinct action with validation.

The implementation agent should assess whether logical ticks are a computed layout aid only, or whether any explicit logical-time metadata needs to exist in the semantic model. Avoid introducing persistent timestamps merely to position shapes.

## 6. Mermaid interoperability

Use the **current supported Mermaid grammar** (verify installed version and parser capabilities) as the basis for incoming/outgoing sequence definitions.

Illustrative interchange example:

```mermaid
sequenceDiagram
    participant API as API
    participant Q as Queue table
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant DB as Database

    API->>Q: Enqueue work
    par Worker 1
        W1->>Q: Select eligible batch
        Q-->>W1: Batch A
        W1->>DB: Process batch A in transaction
        alt All records succeed
            DB-->>W1: Commit
        else Processing fails
            DB-->>W1: Rollback
        end
    and Worker 2
        W2->>Q: Select another eligible batch
        Q-->>W2: Batch B
        W2->>DB: Process batch B in transaction
    end
    Note over W1,W2: Concurrent execution; no fixed real-time offsets
```

This is **only a semantics example**, not a prescribed rendering and not a claim that the real application uses this exact processing policy. The existing visual layer should transform the representation into horizontal lanes/steps.

### Round-trip concerns

- Investigate what the current canvas considers its **source of truth**: Mermaid text, a parsed graph, an intermediate model, or another store.
- Ensure a sequence diagram can be loaded, viewed, modified, and exported/retrieved without losing supported semantics.
- If the editor supports manipulations not directly expressible in Mermaid, keep their display state in the **visual layer**, and retain user-intended meaning in the **semantic annotation layer**. Do not put raw pixel geometry into the agent's default view.
- Define explicit behavior for unsupported Mermaid constructs: reject with feedback, mark read-only, or preserve them losslessly when possible. **Never silently drop meaningful blocks.**
- Preserve stable participant/event/message identities across edits. Mermaid sequence syntax may not give every event a native stable ID; examine existing identity mechanics and propose an appropriate mapping rather than assuming flowchart-node IDs solve this automatically.

## 7. Semantic annotations and interactive editing

The existing annotation system should remain usable without requiring the agent to interpret visual shapes.

Examples:

- User circles two overlapping processing intervals: the semantic annotation targets **those interval/event IDs**.
- User marks a message from Worker 1 to DB as questionable: the annotation targets the **specific interaction ID**.
- User groups several steps and adds text: `#6: Potential race condition; review locking.`

Requirements:

- Annotation IDs are human-readable, monotonic within the current temporary canvas/session (deleting `#3` does not allow reusing `#3`).
- Annotation targets can include participants, individual messages/events, spans/intervals, or meaningful groups/regions.
- Annotations may have optional category/type and optional free-text meaning.
- Visual presentation (circle shape, line color, position, etc.) is the editor's responsibility.
- The MCP-facing representation exposes **meaning and references**, not the full drawing geometry.
- Users must be able to move, add, remove, and comment visually; the agent must see the resulting semantic state and be able to make its own corresponding edits through MCP.
- Edits from either side must appear on the same live canvas without requiring a save/export/import cycle.

## 8. MCP integration requirements

**Reuse the existing MCP interface and state synchronization patterns. Do not invent endpoint/tool names or change tool signatures before inspecting actual implementation.**

The codebase analysis should determine whether the current MCP operations need generalization for a `diagramType`, or whether a small number of additional operations are necessary. Functionally the agent must be able to:

1. Create/open an empty sequence diagram or replace the active semantic diagram with one.
2. Read the active diagram's type, current Mermaid/semantic content, and existing annotations.
3. Add/update/remove meaningful sequence elements and their relationships, or submit an updated validated Mermaid sequence definition.
4. Read user edits made in the browser, including annotations and semantic changes.
5. See version/conflict feedback if a command acts on stale state.
6. Use the **same real-time collaboration loop** already supported for existing diagrams.

Prefer **compact, structured MCP results** and, when feasible, incremental updates rather than echoing the entire canvas or visual coordinates after every change. The implementation must preserve all meaning necessary for the agent to reason correctly about time/order, branches, and annotations.

**Do not modify or regenerate the existing Claude Code skill as part of this task.** Skill adjustments can be discussed separately later if required.

## 9. UI and interaction expectations

- The new diagram type is accessible through the **existing application UI** rather than a separate app.
- Agent and user operate on the **same** live sequence view.
- Participants are readable lanes, with logical progression left to right.
- Parallel branches, message direction, dependencies, active spans, and waiting are visually distinguishable.
- Text remains legible; dense views can use grouping, focus, or similar mechanisms consistent with the existing editor.
- Preserve direct manipulation, selection, visual annotations, and other editor behaviors wherever they make sense for the new diagram type.
- Ensure edits do not cause unnecessary layout jumps or loss of note anchoring.
- Do not force the human to write Mermaid manually.
- Avoid representing every class, method, or line of source code. This is a **behavioral/timing/concurrency visualization**, not a call graph.

The exact shapes, layout algorithm, component library, and UI controls should be decided after examining the working codebase.

## 10. Proposed MVP test scenarios

Implement or at least validate against scenarios such as:

**A. Basic ordered exchange**  
An API calls a service and receives a result. The agent creates it through MCP; the browser shows lanes, events, and a sensible logical order. A user edit is readable back through MCP.

**B. Background processing with parallel workers**  
A database-backed queue holds eligible records. Two worker instances independently select and process batches. Their branches are represented as concurrent, **not implicitly serialized**. No actual timing values are required.

**C. Transaction failure and retry eligibility**  
A batch is treated as one DB transaction. On error, DB changes roll back; another selection cycle may choose a different eligible set of records. Avoid an invented requirement that exactly the same failed batch must always be retried. Show the business/technical behavior only as specified.

**D. Lock contention / wait**  
Two workers contend for a shared resource. Show lock request, wait/blocked state where relevant, release, and subsequent progress. The depiction must not claim precise duration or outcome that is not known.

**E. Conditional behavior**  
Show both successful and unsuccessful DB persistence, including an additional audit/log write where specified. Preserve distinct branches, transaction semantics, and relevant errors.

**F. Semantic annotation interaction**  
A human visually highlights two events and attaches annotation `#6: Check race condition`. The agent reads this as a reference to those event IDs and the associated meaning, without requiring pixel coordinates. The agent can respond by marking or updating relevant events.

**G. Backward compatibility and round trip**  
An existing flowchart still works unchanged. Sequence semantics survive load → render → user edit → MCP read → agent edit → render, with stable references and no silent drops.

## 11. Deliverables expected from the codebase-aware agent

**First: analyze, do not immediately rewrite the application.** The repository-aware agent should produce a focused implementation plan covering:

1. **Current architecture inventory:** Where Mermaid input is parsed, where the semantic graph/state lives, where annotation IDs/references are managed, how the editor renders and captures edits, and how MCP operations connect to that state.
2. **Feature-gap analysis:** Existing behavior that can be reused versus new support required for sequence constructs, logical-time ordering, parallel branch semantics, participant lanes, stable event IDs, and editing/serialization.
3. **Minimal extension design:** Proposed internal model, parser/adapter, horizontal layout strategy, view integration, semantic annotation mapping, and MCP changes (only if necessary).
4. **Compatibility and risks:** Existing flowchart regression risk; ambiguity in Mermaid sequence event identities; round-trip fidelity; concurrent-event ordering; layout stability; unsupported syntax; state/version conflicts.
5. **Implementation milestones:** A small, testable sequence of steps to reach the MVP with minimal disruption.
6. **Verification plan:** Automated tests plus a manual browser + MCP end-to-end walkthrough covering the scenarios above.
7. **Open questions:** Only questions that genuinely block an implementation decision; avoid speculative architectural overengineering.

When identifying existing components, cite actual repository paths/classes/functions. **Do not fabricate repository details.** Keep the plan concise and structured, with a clear distinction between confirmed codebase findings and proposed changes.

## 12. Acceptance criteria

The enhancement is acceptable when:

- [ ] The existing flowchart canvas remains fully functional.
- [ ] The application accepts a Mermaid `sequenceDiagram` through its agent/MCP workflow and identifies it as a distinct diagram type.
- [ ] It renders a **left-to-right, logical-time** visualization with participants in lanes.
- [ ] Ordered events, messages, conditional paths, and parallel branches retain their intended semantics.
- [ ] The visualization communicates meaningful active/waiting/transaction states **where represented**, without inventing measured durations.
- [ ] Agent and human can both edit the active diagram and see each other's changes.
- [ ] The agent can read the **semantic** current state (including annotation targets and text), without a full visual/geometric payload.
- [ ] User-created notes/highlights/groups still work, with monotonic annotation numbering and stable references to sequence elements.
- [ ] Manual layout changes do not silently alter event order or concurrency semantics.
- [ ] Supported Mermaid constructs round-trip correctly; unsupported constructs fail visibly or are preserved safely rather than silently discarded.
- [ ] An automated and/or manual end-to-end test validates MCP → browser → human edit → MCP → browser.
- [ ] No change to the existing Claude Code skill is required by this deliverable.

## 13. Key guiding principle

**Mermaid defines behavior; the semantic annotation layer adds user/agent meaning; the editor determines presentation.**

The new temporal view should preserve that separation. Do **not** force Mermaid's built-in rendering orientation onto the user, and do **not** confuse relative logical ordering with real time. Extend the existing shared canvas, don't replace it.
