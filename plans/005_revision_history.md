# Visual Agent Canvas — Revision History, Per-Revision Undo and Continuing From Earlier Revisions

**Status:** Implemented
**Prepared:** 2026-11-19

## 1. Request

- Keep a history of revisions, not just the latest one. Every committed change already has a revision number; each is now kept.
- Undo/redo belong to each revision separately, limited to the last 15 steps, with a dropdown that lists the last steps.
- The side panel gets tabs: **Current** (the existing marks, activity and Mermaid panels) and **Revisions** (newest first).
- The user can open any revision and edit it. The edit becomes the latest revision, *made from* the opened one. The list stays sequential (no tree), but each revision records its parent, and a git-like graph links each revision to its parent.
  Example: at rev 15, open rev 9 and edit it → rev 16 (parent 9). Open rev 15 and edit it → rev 17 (parent 15).
- Existing sessions must keep working.

Decisions made with the user:

| Question | Decision |
|---|---|
| Granularity | Every change is one revision (today's revision numbers). |
| Marks | Part of the revision: marks and threads come back with it. |
| Opening an old revision | Preview, only in this browser tab, with a banner and "Back to latest". The agent keeps working on the latest. The first edit forks. |
| Undo scope | Only the user's own steps. The agent's changes are never undone. |
| Storage | One folder per session, one JSON file per revision. Old single-file sessions still load. |

## 2. Model (server/store.ts)

- `Revision { revision, parent, at, source, actor?, ops (first 3), count, data? }`. `data` holds the model (shared, never mutated after commit), layout, edge anchors and the undo/redo stacks at that revision.
- Undo entries are immutable: semantic (`delta`) or layout (`LayoutStep`), each with an optional `label`. `HISTORY_LIMIT = 15`. Layout steps are recorded when `/layout` is sent with `record`, i.e. the user's own moves, resizes, tidy and edge-end moves. They undo without creating a revision.
- `undo(steps, fork?)` / `redo(...)` apply several steps as one revision. A step that conflicts with the agent's later change is dropped, as before.
- **Fork:** browser requests may carry `fork { base, id }`. The first request with a new id restores the base revision's content, layout, anchors and undo stacks, then applies the request. The commit gets `parent = base` and starts with `{op: "restore_revision", revision: base}`. Id counters are merged, so ids are never reused. Later requests with the same id apply normally. A failed fork rolls back.
- Agents: `canvas_get_changes` across a `restore_revision` returns `snapshotRequired` ("the user went back to revision N…").

## 3. Storage (server/sessions.ts)

```
<data dir>/<name>/session.json          index: format 2, head, revisions (RevisionInfo, oldest first)
<data dir>/<name>/revisions/<n>.json    model, layout, anchors, undo/redo of revision n
<data dir>/<name>/legacy-v1.json        the old <name>.json, moved here after the first save
```

- Only changed revisions are written. Only the last 10 are kept in memory; older ones are read lazily.
- Old `<name>.json` files load as a session with one revision (their current one) and are migrated on the next save.
- Export/import keeps the single-file v1 format.

## 4. API

- `GET /api/s/:session/revisions` → `{ head, revisions }`, newest first.
- `GET /api/s/:session/revisions/:n` → the browser state of revision n, with `viewing: n`.
- `POST …/patch`, `…/layout` (+ `record`), `…/undo`, `…/redo` (+ `steps`) accept `fork`.
- Browser state has `history: { undo, redo }` (labels, ops, time). The socket sends `{type: "history"}` after layout steps.

## 5. Client

- Undo/redo always go through the server. The **▾** next to Undo lists the steps newest first; picking one undoes it and every step after it.
- Side panel tabs **Current / Revisions**. Revision rows show the number, who made it, what changed, the time, and tags for *latest*, *viewing* and *from rN*. The SVG graph draws the main line where a revision continues from the one below it, and an arc in a side lane to the parent otherwise.
- Clicking a revision previews it with a banner. Agent changes keep arriving in the background. The first edit (including undo) is sent with the fork, and the tab returns to live editing once the new revision arrives.

## 6. Tests

`test/revisions.test.ts`: revision list and parents, forking and going back, failed fork, per-revision undo with a fork, multi-step undo and the limit, layout undo without a revision, folder persistence and legacy migration.
