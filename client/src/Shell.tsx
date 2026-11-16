import { useCallback, useEffect, useRef, useState } from "react";
import App from "./App.tsx";
import { SESSION, SPLIT_RIGHT, deleteSession, embedUrl, resetSession, sessionUrl, splitUrl, type SessionSummary } from "./api.ts";
import { SessionTabs, type TabActions } from "./SessionTabs.tsx";

/** Messages a split-view pane (an embedded App in an iframe) sends to this page. */
export type PaneMessage =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "focus" }
  | { type: "close-pane" }
  | { type: "new-session" };

const RATIO_KEY = "canvas.splitRatio";
const readRatio = () => {
  try {
    const r = Number(localStorage.getItem(RATIO_KEY));
    return r >= 0.2 && r <= 0.8 ? r : 0.5;
  } catch {
    return 0.5;
  }
};

/**
 * The page: session tabs on top, then one canvas, or two side by side (split view). Each side of a
 * split is a full canvas in its own iframe, so its keyboard shortcuts, undo and live updates stay
 * separate; the tabs and their menu stay out here.
 */
export function Shell() {
  const shown = SPLIT_RIGHT ? [SESSION, SPLIT_RIGHT] : [SESSION];
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState(0);
  const [newRequest, setNewRequest] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [ratio, setRatio] = useState(readRatio);
  const [resizing, setResizing] = useState(false);
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  const panes = useRef<HTMLDivElement>(null);

  const error = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  }, []);

  /** Shows only `name` when it is the only one left; otherwise keeps the split with the other side. */
  const closePane = useCallback((index: number) => {
    location.href = sessionUrl(shown[1 - index]);
  }, [shown]);

  useEffect(() => {
    if (!SPLIT_RIGHT) return;
    const onMessage = (e: MessageEvent<PaneMessage>) => {
      if (e.origin !== location.origin) return;
      const index = frames.findIndex((f) => f.current?.contentWindow === e.source);
      if (index < 0) return;
      if (e.data.type === "sessions") setSessions(e.data.sessions);
      else if (e.data.type === "focus") setActive(index);
      else if (e.data.type === "close-pane") closePane(index);
      else if (e.data.type === "new-session") setNewRequest((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  const actions: TabActions = {
    open: (name) => {
      if (!SPLIT_RIGHT) {
        if (name !== SESSION) location.href = sessionUrl(name);
        return;
      }
      const at = shown.indexOf(name);
      if (at >= 0) return setActive(at);
      location.href = active === 0 ? splitUrl(name, SPLIT_RIGHT) : splitUrl(SESSION, name);
    },
    split: (name, side) => {
      // The other side keeps what is on screen: the current session, or the side `name` does not replace.
      const other = !SPLIT_RIGHT ? SESSION : side === "right" ? (SESSION !== name ? SESSION : SPLIT_RIGHT) : SPLIT_RIGHT !== name ? SPLIT_RIGHT : SESSION;
      if (other === name) return;
      location.href = side === "right" ? splitUrl(other, name) : splitUrl(name, other);
    },
    alone: (name) => {
      location.href = sessionUrl(name);
    },
    clear: (name) => {
      if (!confirm(`Clear session "${name}"? Its diagram and all marks are discarded and mark numbering restarts at #1.`)) return;
      resetSession(name).catch((err) => error((err as Error).message));
    },
    remove: (name) => {
      if (!confirm(`Delete session "${name}" with its diagram and marks? This cannot be undone.`)) return;
      deleteSession(name)
        .then(() => {
          const rest = shown.filter((s) => s !== name);
          if (rest.length < shown.length) location.href = sessionUrl(rest[0] ?? "default");
          else setSessions((list) => list.filter((s) => s.name !== name));
        })
        .catch((err) => error((err as Error).message));
    },
    error,
  };

  const onResize = (e: React.PointerEvent) => {
    const r = panes.current?.getBoundingClientRect();
    if (!r) return;
    setRatio(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="shell">
      <SessionTabs sessions={sessions} shown={shown} active={shown[active]} actions={actions} newRequest={newRequest} />
      {SPLIT_RIGHT ? (
        <div className="panes" ref={panes} style={{ gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr` }}>
          {shown.map((name, i) => [
            i === 1 && (
              <div
                key="divider"
                className="pane-divider"
                title="Drag to resize · double-click: equal halves"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setResizing(true);
                }}
                onPointerMove={(e) => resizing && onResize(e)}
                onPointerUp={() => {
                  setResizing(false);
                  try {
                    localStorage.setItem(RATIO_KEY, String(ratio));
                  } catch {
                    // remembering the width is only a convenience
                  }
                }}
                onDoubleClick={() => setRatio(0.5)}
              />
            ),
            <iframe
              key={`pane-${i}`}
              ref={frames[i]}
              className={`pane${active === i ? " active" : ""}`}
              src={embedUrl(name)}
              title={`Canvas session ${name}`}
            />,
          ])}
          {/* While resizing, the iframes would swallow the pointer. */}
          {resizing && <div className="pane-resize-cover" />}
        </div>
      ) : (
        <App onSessions={setSessions} />
      )}
      {toast && (
        <div className="toast shell-toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
