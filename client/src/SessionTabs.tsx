import { useEffect, useRef, useState, type RefObject } from "react";
import {
  SESSION,
  SessionExistsError,
  createSession,
  deleteSession,
  exportUrl,
  importSession,
  sessionUrl,
  type SessionSummary,
} from "./api.ts";

const ago = (iso: string) => {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-");

/** Closes a popover on Escape or a click outside `ref`. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onEvent);
    window.addEventListener("keydown", onEvent);
    return () => {
      window.removeEventListener("mousedown", onEvent);
      window.removeEventListener("keydown", onEvent);
    };
  }, [open, ref, close]);
}

/** Popovers are fixed-positioned under their button, so the scrolling tab strip cannot clip them. */
const below = (el: HTMLElement | null, align: "left" | "right") => {
  const r = el?.getBoundingClientRect();
  if (!r) return {};
  return align === "left" ? { top: r.bottom + 4, left: r.left } : { top: r.bottom + 4, right: window.innerWidth - r.right };
};

/** One tab per canvas session; the current one has a ⋯ menu (export, import, clear, delete). */
export function SessionTabs({
  sessions,
  onClear,
  onError,
}: {
  sessions: SessionSummary[];
  onClear: () => void;
  onError: (msg: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"flowchart" | "sequence">("flowchart");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  useDismiss(newOpen, newRef, () => setNewOpen(false));

  // Stable order (the server lists by last update, which would make tabs jump around).
  const tabs = [...sessions].sort((a, b) => a.name.localeCompare(b.name));
  if (!tabs.some((s) => s.name === SESSION)) tabs.push({ name: SESSION } as SessionSummary);

  // Ctrl/Cmd+N opens the new-session form where the browser lets the page have it (most keep it for
  // "new window"), so Alt/Option+N does the same everywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyN" || e.shiftKey) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]");
      if (!(mod && !e.altKey) && !(e.altKey && !mod && !typing)) return;
      e.preventDefault();
      setMenuOpen(false);
      setNewOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the current tab in view when there are more tabs than fit.
  useEffect(() => {
    strip.current?.querySelector(".session-tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sessions.length]);

  const create = async () => {
    const n = slug(name);
    if (!n) return;
    try {
      await createSession(n, type);
      location.href = sessionUrl(n);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  /** Imports a session file; if its name is taken, asks for another one until it fits or the user gives up. */
  const importFile = async (file: File) => {
    const text = await file.text();
    let name: string | undefined;
    for (;;) {
      try {
        const created = await importSession(text, name);
        location.href = sessionUrl(created.name);
        return;
      } catch (err) {
        if (!(err instanceof SessionExistsError)) return onError((err as Error).message);
        const next = prompt(`A session named "${err.name}" already exists. Import it as:`, `${err.name}-imported`);
        if (!next?.trim()) return;
        name = slug(next);
      }
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (!confirm(`Delete session "${SESSION}" with its diagram and marks? This cannot be undone.`)) return;
    try {
      await deleteSession(SESSION);
      location.href = sessionUrl("default");
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <nav className="session-tabs">
      <div className="session-strip" ref={strip}>
        {tabs.map((s) => {
          const current = s.name === SESSION;
          const info =
            s.updatedAt &&
            `${s.type === "sequence" ? "Sequence diagram" : "Flowchart"} · ${s.nodes} ${s.type === "sequence" ? "elements" : "nodes"} · ${s.marks} marks · updated ${ago(s.updatedAt)}`;
          return (
            <div key={s.name} className={`session-tab${current ? " current" : ""}`} title={[s.title, info].filter(Boolean).join("\n")}>
              <a href={sessionUrl(s.name)} onClick={(e) => current && e.preventDefault()}>
                <span className="session-type">{s.type === "sequence" ? "⇄" : "▭"}</span>
                {s.name}
                {s.marks > 0 && <span className="session-marks">{s.marks}</span>}
              </a>
              {current && (
                <button
                  ref={menuButton}
                  className="session-more"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setMenuOpen((o) => !o)}
                  title="Export, import, clear or delete"
                  aria-label="Session actions"
                >
                  ⋯
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="session-new-wrap" ref={newRef}>
        <button className="session-add" onClick={() => setNewOpen((o) => !o)} title="Create a new canvas session (Alt+N; Ctrl/Cmd+N where the browser allows it)">
          + New session
        </button>
        {newOpen && (
          <form
            className="session-pop session-new"
            style={below(newRef.current, "right")}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-session-name" maxLength={48} autoFocus />
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} title="Diagram type">
              <option value="flowchart">Flowchart</option>
              <option value="sequence">Sequence</option>
            </select>
            <button className="primary" type="submit" disabled={!name.trim()}>
              Create
            </button>
          </form>
        )}
      </div>
      {menuOpen && (
        <div className="session-pop session-actions-menu" ref={menuRef} style={below(menuButton.current, "left")}>
          <a className="menu-item" href={exportUrl(SESSION)} download onClick={() => setMenuOpen(false)} title="Download this canvas as a file you can import later">
            ⤓ Export this canvas
          </a>
          <button
            className="menu-item"
            onClick={() => {
              setMenuOpen(false);
              fileInput.current?.click();
            }}
            title="Add a canvas from an exported file as a new session"
          >
            ⤒ Import from file…
          </button>
          <hr />
          <button
            className="menu-item"
            onClick={() => {
              setMenuOpen(false);
              onClear();
            }}
          >
            ⌫ Clear this canvas
          </button>
          {SESSION !== "default" && (
            <button className="menu-item danger" onClick={remove}>
              ✕ Delete session
            </button>
          )}
          <p className="muted">
            Agents pick a session by name: tell them e.g. <code>use canvas session “{SESSION}”</code>.
          </p>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </nav>
  );
}
