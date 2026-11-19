import { useEffect, useRef, useState, type RefObject } from "react";
import { SessionExistsError, createSession, exportUrl, importSession, sessionUrl, type SessionSummary } from "./api.ts";

const ago = (iso: string) => {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-");

/** Closes a popover on Escape, a click outside `ref`, or a click into a split-view pane (window blur). */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : e.type === "blur" || !ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onEvent);
    window.addEventListener("keydown", onEvent);
    window.addEventListener("blur", onEvent);
    return () => {
      window.removeEventListener("mousedown", onEvent);
      window.removeEventListener("keydown", onEvent);
      window.removeEventListener("blur", onEvent);
    };
  }, [open, ref, close]);
}

/** Popovers are fixed-positioned, so the scrolling tab strip cannot clip them. */
const below = (el: HTMLElement | null) => {
  const r = el?.getBoundingClientRect();
  return r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : {};
};

export interface TabActions {
  /** Show a session (in split view: in the side the user worked in last). */
  open: (name: string) => void;
  split: (name: string, side: "left" | "right") => void;
  /** Leave split view, showing only this session. */
  alone: (name: string) => void;
  clear: (name: string) => void;
  remove: (name: string) => void;
  /** Download the diagram of a session on screen as a PNG image, or as a Visio file (flowcharts, curved or straight lines) for Miro and co. */
  save: (name: string, format: "png" | "vsdx" | "vsdx-straight") => void;
  error: (msg: string) => void;
  /** A short message for the user, such as a confirmation. */
  notify: (msg: string) => void;
}

/**
 * One tab per canvas session, with a button that copies its name for the agent prompt.
 * Right-click a tab for split view, export / import, a PNG image or Visio file, clear and delete.
 * `shown` are the sessions on screen (two in split view: left, right).
 */
export function SessionTabs({
  sessions,
  shown,
  active,
  actions,
  newRequest,
}: {
  sessions: SessionSummary[];
  shown: string[];
  active: string;
  actions: TabActions;
  /** Bumped to open the new-session form from a keyboard shortcut pressed inside a split-view pane. */
  newRequest: number;
}) {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"flowchart" | "sequence">("flowchart");
  const menuRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useDismiss(!!menu, menuRef, () => setMenu(null));
  useDismiss(newOpen, newRef, () => setNewOpen(false));
  const split = shown.length > 1;

  // Stable order (the server lists by last update, which would make tabs jump around).
  const tabs = [...sessions].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of shown) if (!tabs.some((t) => t.name === s)) tabs.push({ name: s } as SessionSummary);

  // Ctrl/Cmd+N opens the new-session form where the browser lets the page have it (most keep it for
  // "new window"), so Alt/Option+N does the same everywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyN" || e.shiftKey) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]");
      if (!(mod && !e.altKey) && !(e.altKey && !mod && !typing)) return;
      e.preventDefault();
      setMenu(null);
      setNewOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!newRequest) return;
    setMenu(null);
    setNewOpen(true);
  }, [newRequest]);

  // Keep the current tab in view when there are more tabs than fit.
  useEffect(() => {
    strip.current?.querySelector(".session-tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sessions.length]);

  const create = async () => {
    const n = slug(name);
    if (!n) return;
    try {
      await createSession(n, type);
      setNewOpen(false);
      setName("");
      actions.open(n);
    } catch (err) {
      actions.error((err as Error).message);
    }
  };

  /** Imports a session file; if its name is taken, asks for another one until it fits or the user gives up. */
  const importFile = async (file: File) => {
    const text = await file.text();
    let name: string | undefined;
    for (;;) {
      try {
        const created = await importSession(text, name);
        actions.open(created.name);
        return;
      } catch (err) {
        if (!(err instanceof SessionExistsError)) return actions.error((err as Error).message);
        const next = prompt(`A session named "${err.name}" already exists. Import it as:`, `${err.name}-imported`);
        if (!next?.trim()) return;
        name = slug(next);
      }
    }
  };

  /** Runs a menu item and closes the menu. */
  const [copied, setCopied] = useState<string | null>(null);
  const copyName = (name: string) =>
    navigator.clipboard.writeText(name).then(
      () => {
        setCopied(name);
        setTimeout(() => setCopied((c) => (c === name ? null : c)), 1500);
        actions.notify(`Session name "${name}" copied — paste it into the agent prompt`);
      },
      () => actions.error("Clipboard not available in this browser"),
    );

  const pick = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  // Splitting needs a second session: the one on screen, or (in split view) the other side.
  const canSplit = (target: string) => split || target !== shown[0];

  return (
    <nav className="session-tabs">
      <div className="session-strip" ref={strip}>
        {tabs.map((s) => {
          const current = shown.includes(s.name);
          const side = split && current ? (s.name === shown[0] ? "left" : "right") : null;
          const info =
            s.updatedAt &&
            `${s.type === "sequence" ? "Sequence diagram" : "Flowchart"} · ${s.nodes} ${s.type === "sequence" ? "elements" : "nodes"} · ${s.marks} marks · updated ${ago(s.updatedAt)}`;
          return (
            <a
              key={s.name}
              href={sessionUrl(s.name)}
              className={`session-tab${current ? " current" : ""}${split && s.name === active ? " active" : ""}${menu?.name === s.name ? " menu-open" : ""}`}
              title={[s.title, info, "Right-click: split view, export, import, PNG / Visio, clear, delete"].filter(Boolean).join("\n")}
              onClick={(e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // new browser tab/window
                e.preventDefault();
                actions.open(s.name);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setNewOpen(false);
                setMenu({ name: s.name, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="session-type">{s.type === "sequence" ? "⇄" : "▭"}</span>
              <span className="session-name">{s.name}</span>
              {s.marks > 0 && <span className="session-marks">{s.marks}</span>}
              {side && <span className="session-side" title={`Shown on the ${side}`}>{side === "left" ? "◧" : "◨"}</span>}
              <span
                className={`session-copy${copied === s.name ? " copied" : ""}`}
                role="button"
                tabIndex={0}
                title="Copy the session name, to tell the agent which canvas you mean"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  copyName(s.name);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  copyName(s.name);
                }}
              >
                {copied === s.name ? "✓" : "⧉"}
              </span>
            </a>
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
            style={below(newRef.current)}
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
      {menu && (
        <div
          className="session-pop session-actions-menu"
          ref={menuRef}
          style={{ left: Math.min(menu.x, window.innerWidth - 260), top: Math.min(menu.y, window.innerHeight - 420) }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="menu-head">{menu.name}</div>
          <button
            className="menu-item"
            disabled={!canSplit(menu.name)}
            onClick={pick(() => actions.split(menu.name, "right"))}
            title={canSplit(menu.name) ? `Show "${menu.name}" on the right, next to the other session` : "Right-click another tab to show it next to this one"}
          >
            ◨ Split right
          </button>
          <button
            className="menu-item"
            disabled={!canSplit(menu.name)}
            onClick={pick(() => actions.split(menu.name, "left"))}
            title={canSplit(menu.name) ? `Show "${menu.name}" on the left, next to the other session` : "Right-click another tab to show it next to this one"}
          >
            ◧ Split left
          </button>
          {split && (
            <button className="menu-item" onClick={pick(() => actions.alone(menu.name))}>
              ▭ Show only this one
            </button>
          )}
          <hr />
          <a className="menu-item" href={exportUrl(menu.name)} download onClick={() => setMenu(null)} title="Download this canvas as a file you can import later">
            ⤓ Export
          </a>
          <button className="menu-item" onClick={pick(() => fileInput.current?.click())} title="Add a canvas from an exported file as a new session">
            ⤒ Import from file…
          </button>
          <button
            className="menu-item"
            disabled={!shown.includes(menu.name)}
            onClick={pick(() => actions.save(menu.name, "png"))}
            title={shown.includes(menu.name) ? "Download the whole diagram as a PNG image" : "Open this session first to save its diagram as an image"}
          >
            🖼 Save as PNG
          </button>
          {(
            [
              ["vsdx", "◇ Save as Visio, curved lines", "lines follow the curves drawn here, round the boxes"],
              ["vsdx-straight", "◇ Save as Visio, straight lines", "lines go straight between the boxes, easiest to rearrange"],
            ] as const
          ).map(([format, label, lines]) => (
            <button
              key={format}
              className="menu-item"
              disabled={!shown.includes(menu.name) || sessions.find((s) => s.name === menu.name)?.type === "sequence"}
              onClick={pick(() => actions.save(menu.name, format))}
              title={
                !shown.includes(menu.name)
                  ? "Open this session first to save its diagram"
                  : sessions.find((s) => s.name === menu.name)?.type === "sequence"
                    ? "Visio export is for flowcharts"
                    : `Download the flowchart as a Visio (.vsdx) file, laid out as here with its marks; ${lines}. Imports into Miro, Lucidchart and draw.io as editable shapes`
              }
            >
              {label}
            </button>
          ))}
          <hr />
          <button className="menu-item" onClick={pick(() => actions.clear(menu.name))}>
            ⌫ Clear canvas
          </button>
          {menu.name !== "default" && (
            <button className="menu-item danger" onClick={pick(() => actions.remove(menu.name))}>
              ✕ Delete session
            </button>
          )}
          <p className="muted">
            Agents pick a session by name: tell them e.g. <code>use canvas session “{menu.name}”</code>.
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
