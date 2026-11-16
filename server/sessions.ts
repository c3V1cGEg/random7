// Named canvas sessions in one process. Each session is an independent CanvasStore
// (diagram, marks, revisions, undo, layout); sessions are saved to disk when a data
// directory is configured, so they survive server restarts.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CanvasStore, type SessionSummary, type StoredSession } from "./store.ts";
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
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
          const store = CanvasStore.fromStored(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as StoredSession);
          this.register(store);
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
    if (this.dir) rmSync(this.file(store.name), { force: true });
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

  private file(name: string) {
    return path.join(this.dir!, `${name}.json`);
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

  private save(store: CanvasStore) {
    if (!this.dir) return;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const target = this.file(store.name);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.toStored(), null, 1));
      renameSync(tmp, target); // atomic replace: a crash never leaves a half-written session
    } catch (err) {
      console.error(`Failed to save session ${store.name}:`, err);
    }
  }
}
