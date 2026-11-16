import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import App from "./App.tsx";
import { EMBEDDED } from "./api.ts";
import { Shell, type PaneMessage } from "./Shell.tsx";

/** One side of a split view: a full canvas that reports to the page holding the tabs. */
function embedded() {
  const tell = (m: PaneMessage) => parent.postMessage(m, location.origin);
  window.addEventListener("pointerdown", () => tell({ type: "focus" }), true);
  window.addEventListener("focusin", () => tell({ type: "focus" }));
  // The new-session shortcut belongs to the tab strip outside this frame.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "KeyN" || e.shiftKey) return;
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]");
    if ((mod && !e.altKey) || (e.altKey && !mod && !typing)) {
      e.preventDefault();
      tell({ type: "new-session" });
    }
  });
  document.documentElement.classList.add("embedded");
  return <App onSessions={(sessions) => tell({ type: "sessions", sessions })} onClosePane={() => tell({ type: "close-pane" })} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{EMBEDDED ? embedded() : <Shell />}</StrictMode>);
