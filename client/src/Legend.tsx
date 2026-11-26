import { useState } from "react";
import { stateIdProblem } from "../../server/stateDiagram.ts";
import { ANY_ID, CHANGE_STATUSES, FINAL_ID, INITIAL_ID, type ChangeStatus, type GraphEdge, type GraphNode, type Instance } from "../../server/types.ts";
import { STATUS_META } from "./kinds.ts";

type Element = { id: string; status?: ChangeStatus; label?: string };

/**
 * Explains the change colours while a proposal is on the canvas. Clicking a row selects
 * those elements; "Accept" applies the proposal (drops removed, clears the colours).
 */
export function ChangeLegend({
  nodes,
  edges,
  onReveal,
  onAccept,
}: {
  /** Things counted as "existing" when unmarked (flowchart nodes, or every sequence element). */
  nodes: Element[];
  edges: Element[];
  onReveal(ids: string[]): void;
  onAccept(): void;
}) {
  const ids: Record<ChangeStatus, string[]> = { new: [], changed: [], removed: [] };
  for (const x of [...nodes, ...edges]) if (x.status) ids[x.status].push(x.id);
  const total = ids.new.length + ids.changed.length + ids.removed.length;
  if (!total) return null;
  const unchanged = nodes.filter((n) => !n.status).length;
  const hasDetails = nodes.some((n) => /\n[+\-~] /.test(n.label ?? ""));
  return (
    <div className="legend nodrag nopan">
      <div className="legend-title">Proposed changes</div>
      {CHANGE_STATUSES.map((st) => (
        <button key={st} className="legend-row" disabled={!ids[st].length} title={`${STATUS_META[st].hint}. Click to select.`} onClick={() => onReveal(ids[st])}>
          <span className={`swatch status-${st}`} />
          {STATUS_META[st].label}
          <span className="count">{ids[st].length}</span>
        </button>
      ))}
      <div className="legend-row static" title="Unmarked steps exist today and stay as they are">
        <span className="swatch" />
        Existing
        <span className="count">{unchanged}</span>
      </div>
      {hasDetails && (
        <div className="legend-details" title="Detail lines inside a step">
          <span className="detail-added">added</span> <span className="detail-dropped">dropped</span> <span className="detail-modified">modified</span>
        </div>
      )}
      <button className="legend-accept" onClick={onAccept} title="Delete removed elements and clear all change colours (undoable)">
        ✓ Accept changes
      </button>
    </div>
  );
}

/**
 * A state's value (its id) from the name typed for it, as an enum constant would read: "In progress" → InProgress.
 * Null when nothing usable is left (e.g. only punctuation or a leading digit).
 */
export function stateValue(label: string): string | null {
  const words = label.split("\n")[0].normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[A-Za-z0-9]+/g) ?? [];
  const id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("").slice(0, 48);
  if (!/^[A-Za-z]/.test(id)) return null;
  // A reserved word ("End", "Class") gets a suffix rather than being refused (which would lose the typed name too).
  return !stateIdProblem(id) ? id : !stateIdProblem(`${id}State`) ? `${id}State` : null;
}

/**
 * The states (enum values) a state diagram's object can be in, in lifecycle order: from the start
 * along the transitions (through choice points), then any state the start cannot reach. Each row
 * shows how many instances are in that state; clicking it selects the state.
 */
export function stateOrder(
  nodes: GraphNode[],
  edges: GraphEdge[],
): {
  ordered: GraphNode[];
  unreachable: Set<string>;
  deadEnds: Set<string>;
  stuckChoices: string[];
  starts: Set<string>;
  ends: Set<string>;
} {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([INITIAL_ID]);
  const queue = [INITIAL_ID];
  const ordered: GraphNode[] = [];
  for (;;) {
    // Once the start's paths are walked, what "any state" leads to is reachable too (from every state reached).
    if (!queue.length && !seen.has(ANY_ID) && byId.has(ANY_ID) && ordered.length) {
      seen.add(ANY_ID);
      queue.push(ANY_ID);
    }
    if (!queue.length) break;
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.from !== id || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
      const n = byId.get(e.to);
      if (n?.shape === "state") ordered.push(n);
    }
  }
  const rest = nodes.filter((n) => n.shape === "state" && !seen.has(n.id));
  // Without a start, nothing is "unreachable": the order is just the drawing's.
  const hasStart = byId.has(INITIAL_ID);
  // A state with no way out that is not the end: things that get there stay forever (unless "any state" leads on).
  const anyWayOut = edges.some((e) => e.from === ANY_ID);
  const deadEnds = new Set(anyWayOut ? [] : nodes.filter((n) => n.shape === "state" && !edges.some((e) => e.from === n.id)).map((n) => n.id));
  // A choice decides where to go next: without a transition out, whatever reaches it goes nowhere.
  const stuckChoices = nodes.filter((n) => n.shape === "choice" && !edges.some((e) => e.from === n.id)).map((n) => n.id);
  // Start and end tags look through choice points: [*] --> check --> Draft still makes Draft a start.
  const isChoice = (id: string) => byId.get(id)?.shape === "choice";
  const through = (from: string, dir: "out" | "in"): Set<string> => {
    const found = new Set<string>();
    const visited = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of edges) {
        const [a, b] = dir === "out" ? [e.from, e.to] : [e.to, e.from];
        if (a !== id || visited.has(b)) continue;
        visited.add(b);
        if (isChoice(b)) stack.push(b);
        else if (byId.get(b)?.shape === "state") found.add(b);
      }
    }
    return found;
  };
  return {
    ordered: [...ordered, ...rest],
    unreachable: new Set(hasStart ? rest.map((n) => n.id) : []),
    deadEnds,
    stuckChoices,
    starts: through(INITIAL_ID, "out"),
    ends: through(FINAL_ID, "in"),
  };
}

export function StateLegend({
  nodes,
  edges,
  instances,
  onReveal,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  instances: Instance[];
  onReveal(ids: string[]): void;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("vc.stateLegend") !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("vc.stateLegend", open ? "0" : "1");
    } catch {
      // private mode: not remembered
    }
  };
  const { ordered, unreachable, deadEnds, stuckChoices, starts, ends } = stateOrder(nodes, edges);
  const title = (id: string) => (id === FINAL_ID ? "End" : (nodes.find((n) => n.id === id)?.label.split("\n")[0] ?? id));
  const fromAny = edges.filter((e) => e.from === ANY_ID);
  if (!ordered.length) return null;
  const count = (id: string) => instances.filter((i) => i.state === id && !i.orphaned).length;
  const placed = instances.filter((i) => !i.orphaned).length;
  return (
    <div className="legend state-legend nodrag nopan">
      <button className="legend-title legend-toggle" onClick={toggle} title={open ? "Collapse" : "Show all states"} aria-expanded={open}>
        <span>{open ? "▾" : "▸"} States</span>
        <span className="count">{ordered.length}</span>
      </button>
      {open && (
        <>
          {ordered.map((n) => {
            const [title] = n.label.split("\n");
            const k = count(n.id);
            return (
              <button
                key={n.id}
                className={`legend-row state-row${unreachable.has(n.id) ? " unreachable" : ""}`}
                onClick={() => onReveal([n.id])}
                title={[
                  n.label.replace(/\n/g, " · "),
                  `value: ${n.id}`,
                  unreachable.has(n.id) ? "No path from the start leads here" : "",
                  deadEnds.has(n.id) ? "No way out of this state, and it is not the end" : "",
                  n.status ? STATUS_META[n.status].label : "",
                  "Click to select",
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <span className={`state-swatch${n.status ? ` status-${n.status}` : ""}${k ? " occupied" : ""}`} />
                <span className="state-name">
                  {title}
                  {title !== n.id && <code>{n.id}</code>}
                </span>
                {starts.has(n.id) && <span className="state-tag" title="Entered from the start (directly or through a choice)">start</span>}
                {ends.has(n.id) && <span className="state-tag" title="Leads to the end">end</span>}
                {unreachable.has(n.id) && <span className="state-tag warn">unreachable</span>}
                {deadEnds.has(n.id) && <span className="state-tag dead">dead end</span>}
                <span className={`count${k ? " has" : ""}`} title={`${k} instance${k === 1 ? "" : "s"} in this state`}>
                  {k || ""}
                </span>
              </button>
            );
          })}
          {stuckChoices.map((id) => (
            <button key={id} className="legend-row legend-warn" onClick={() => onReveal([id])} title="Click to select the choice">
              ⚠ Choice <code>{id}</code> has no way out
            </button>
          ))}
          {fromAny.length > 0 && (
            <div className="legend-any" title="Transitions drawn from “Any state” are possible from every state">
              <b>From any state</b>
              {fromAny.map((e) => (
                <div key={e.id}>
                  {e.label ? `${e.label} → ` : "→ "}
                  {title(e.to)}
                </div>
              ))}
            </div>
          )}
          {instances.length > 0 && (
            <div className="legend-foot">
              {placed} instance{placed === 1 ? "" : "s"}
              {placed < instances.length ? ` · ${instances.length - placed} not in any state` : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}
