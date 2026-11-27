// Named canvas sessions in one process. Each session is an independent CanvasStore
// (diagram, marks, revisions, undo, layout); sessions are saved to disk when a data
// directory is configured, so they survive server restarts.
//
// On disk each session is a folder: `<name>/session.json` (the session and its revision list)
// and `<name>/revisions/<n>.json`, one file per revision. Sessions saved before revision
// history were a single `<name>.json`; those still load, and move into a folder (keeping the
// old file there as legacy-v1.json) the first time they are saved.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CanvasStore, type SessionSummary, type StoredRevision, type StoredSession, type StoredSessionIndex } from "./store.ts";
import { CanvasError, type ChangeEvent, type DiagramType, type EdgeEnds, type XY } from "./types.ts";

export const DEFAULT_SESSION = "default";
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SAVE_DELAY_MS = 250;

export interface SessionEvents {
  change(store: CanvasStore, event: ChangeEvent): void;
  layout(store: CanvasStore, positions: Record<string, XY>, origin?: string, anchors?: Record<string, EdgeEnds>): void;
  listChanged(): void;
}

export function normalizeSessionName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(n)) {
    throw new CanvasError("invalid_session_name", `session name "${name}" must be 1-48 chars of a-z, 0-9, - or _ (starting with a letter or digit)`);
  }
  return n;
}

export class SessionManager {
  private stores = new Map<string, CanvasStore>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private events?: SessionEvents;

  /** `dir` null keeps sessions in memory only. */
  constructor(private readonly dir: string | null) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const entries = readdirSync(dir);
      for (const entry of entries.filter((e) => existsSync(path.join(dir, e, "session.json")))) {
        try {
          const index = JSON.parse(readFileSync(path.join(dir, entry, "session.json"), "utf8")) as StoredSessionIndex;
          this.register(CanvasStore.fromIndex(index, this.loader(index.name)));
        } catch (err) {
          console.warn(`Skipping unreadable session folder ${entry}: ${(err as Error).message}`);
        }
      }
      for (const file of entries.filter((f) => f.endsWith(".json") && statSync(path.join(dir, f)).isFile())) {
        try {
          const store = CanvasStore.fromStored(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as StoredSession);
          if (this.stores.has(store.name)) continue; // already moved into its folder
          this.register(store);
          this.scheduleSave(store);
        } catch (err) {
          console.warn(`Skipping unreadable session file ${file}: ${(err as Error).message}`);
        }
      }
    }
    if (!this.stores.has(DEFAULT_SESSION)) this.register(new CanvasStore(DEFAULT_SESSION));
  }

  setEvents(events: SessionEvents) {
    this.events = events;
  }

  get(name: string = DEFAULT_SESSION): CanvasStore {
    const store = this.stores.get(name.trim().toLowerCase());
    if (!store) {
      throw new CanvasError("session_not_found", `no canvas session "${name}"; existing: ${[...this.stores.keys()].join(", ")}`, {
        sessions: [...this.stores.keys()],
      });
    }
    return store;
  }

  has(name: string): boolean {
    return this.stores.has(name.trim().toLowerCase());
  }

  list(): SessionSummary[] {
    return [...this.stores.values()].map((s) => s.summary()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(name: string, title?: string, type: DiagramType = "flowchart"): CanvasStore {
    const n = normalizeSessionName(name);
    if (this.stores.has(n)) throw new CanvasError("session_exists", `session "${n}" already exists`);
    const store = new CanvasStore(n, title?.trim().slice(0, 120) || undefined, type);
    this.register(store);
    this.scheduleSave(store);
    this.events?.listChanged();
    return store;
  }

  /**
   * Adds a session from an exported session file, under `name` or the name stored in the file.
   * It gets a fresh session id, so agents that knew an earlier session of that name re-read it.
   */
  import(data: unknown, name?: string): CanvasStore {
    const stored = data as StoredSession;
    if (typeof stored?.name !== "string") throw new CanvasError("invalid_session_file", "not a canvas session file");
    const n = normalizeSessionName(name ?? stored.name);
    if (this.stores.has(n)) throw new CanvasError("session_exists", `session "${n}" already exists`, { name: n });
    let store: CanvasStore;
    try {
      store = CanvasStore.fromStored({ ...stored, name: n, sessionId: randomUUID() });
    } catch (err) {
      throw new CanvasError("invalid_session_file", `cannot import session file: ${(err as Error).message}`);
    }
    this.register(store);
    this.scheduleSave(store);
    this.events?.listChanged();
    return store;
  }

  delete(name: string): void {
    const store = this.get(name);
    if (store.name === DEFAULT_SESSION) throw new CanvasError("cannot_delete_default", "the default session can be cleared but not deleted");
    this.stores.delete(store.name);
    clearTimeout(this.saveTimers.get(store.name));
    this.saveTimers.delete(store.name);
    if (this.dir) {
      rmSync(this.folder(store.name), { recursive: true, force: true });
      rmSync(this.legacyFile(store.name), { force: true });
    }
    this.events?.listChanged();
  }

  /** Writes pending saves immediately (call on shutdown). */
  flush(): void {
    for (const [name, timer] of this.saveTimers) {
      clearTimeout(timer);
      const store = this.stores.get(name);
      if (store) this.save(store);
    }
    this.saveTimers.clear();
  }

  private register(store: CanvasStore) {
    this.stores.set(store.name, store);
    if (this.dir) store.setLoader(this.loader(store.name));
    store.subscribe((event) => {
      this.scheduleSave(store);
      this.events?.change(store, event);
      this.events?.listChanged();
    });
    store.onLayout((positions, origin, anchors) => {
      this.scheduleSave(store);
      this.events?.layout(store, positions, origin, anchors);
    });
  }

  private folder(name: string) {
    return path.join(this.dir!, name);
  }

  private revisionFile(name: string, revision: number) {
    return path.join(this.folder(name), "revisions", `${revision}.json`);
  }

  private legacyFile(name: string) {
    return path.join(this.dir!, `${name}.json`);
  }

  private loader(name: string) {
    return (revision: number): StoredRevision | undefined => {
      try {
        return JSON.parse(readFileSync(this.revisionFile(name, revision), "utf8")) as StoredRevision;
      } catch {
        return undefined;
      }
    };
  }

  private scheduleSave(store: CanvasStore) {
    if (!this.dir || this.saveTimers.has(store.name)) return;
    this.saveTimers.set(
      store.name,
      setTimeout(() => {
        this.saveTimers.delete(store.name);
        if (this.stores.get(store.name) === store) this.save(store);
      }, SAVE_DELAY_MS),
    );
  }

  /** Writes the revisions changed since the last save, then the session index that lists them. */
  private save(store: CanvasStore) {
    if (!this.dir) return;
    const dirty = store.takeDirty();
    const reset = store.takeReset();
    try {
      // Cleared: the old history's revision files go, so none is mistaken for a new revision later.
      if (reset) rmSync(path.join(this.folder(store.name), "revisions"), { recursive: true, force: true });
      mkdirSync(path.join(this.folder(store.name), "revisions"), { recursive: true });
      for (const revision of dirty) writeAtomic(this.revisionFile(store.name, revision), store.storedRevision(revision));
      writeAtomic(path.join(this.folder(store.name), "session.json"), store.storedIndex());
      const legacy = this.legacyFile(store.name);
      if (existsSync(legacy)) renameSync(legacy, path.join(this.folder(store.name), "legacy-v1.json"));
      store.evictSaved();
    } catch (err) {
      store.markDirty(dirty);
      if (reset) store.markReset();
      console.error(`Failed to save session ${store.name}:`, err);
    }
  }
}

/** Atomic replace: a crash never leaves a half-written file. */
function writeAtomic(target: string, data: unknown) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, target);
}
