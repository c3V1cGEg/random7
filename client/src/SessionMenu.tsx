import { useEffect, useRef, useState } from "react";
import { SESSION, createSession, deleteSession, sessionUrl, type SessionSummary } from "./api.ts";

const ago = (iso: string) => {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

/** Session switcher: lists the server's canvases, creates, clears and deletes them. */
export function SessionMenu({
  sessions,
  title,
  onClear,
  onError,
}: {
  sessions: SessionSummary[];
  title?: string;
  onClear: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"flowchart" | "sequence">("flowchart");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const create = async () => {
    const n = name.trim().toLowerCase().replace(/\s+/g, "-");
    if (!n) return;
    try {
      await createSession(n, type);
      location.href = sessionUrl(n);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete session "${SESSION}" with its diagram and marks? This cannot be undone.`)) return;
    try {
      await deleteSession(SESSION);
      location.href = sessionUrl("default");
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="session-menu" ref={ref}>
      <button className="session-button" onClick={() => setOpen((o) => !o)} title="Switch, create or manage canvas sessions">
        <span className="session-label">session</span> <b>{SESSION}</b>
        {title && <span className="session-title">{title}</span>} ▾
      </button>
      {open && (
        <div className="session-panel">
          <ul>
            {sessions.map((s) => (
              <li key={s.name}>
                <a href={sessionUrl(s.name)} className={s.name === SESSION ? "current" : ""}>
                  <b>{s.name}</b>
                  {s.title && <span className="session-title">{s.title}</span>}
                  <span className="muted">
                    {s.type === "sequence" ? "sequence" : "flowchart"} · {s.nodes} {s.type === "sequence" ? "elements" : "nodes"} · {s.marks} marks · {ago(s.updatedAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <form
            className="session-new"
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
          <div className="session-actions">
            <button
              onClick={() => {
                setOpen(false);
                onClear();
              }}
            >
              Clear this canvas
            </button>
            {SESSION !== "default" && (
              <button className="danger" onClick={remove}>
                Delete session
              </button>
            )}
          </div>
          <p className="muted">
            Agents pick a session by name: tell them e.g. <code>use canvas session “{SESSION}”</code>.
          </p>
        </div>
      )}
    </div>
  );
}
