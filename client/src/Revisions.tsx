import { useEffect, useRef, useState } from "react";
import { describeOp, describeStep, fetchRevisions, type HistoryItem, type OpTarget, type RevisionInfo } from "./api.ts";
import type { Change, ElementChange, RevisionDiff, TextLine } from "./diff.ts";
import { KIND_META } from "./kinds.ts";

const time = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * Undo button with a list of the last steps (newest first): picking one undoes it and every
 * step after it, as one change.
 */
export function UndoButton({ items, onUndo }: { items: HistoryItem[]; onUndo: (steps: number) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);
  const newest = [...items].reverse();
  return (
    <div className="undo-group" ref={ref}>
      <button onClick={() => onUndo(1)} disabled={!items.length} title={items.length ? `Undo: ${describeStep(items.at(-1)!)} (Ctrl+Z)` : "Nothing to undo"}>
        ↶ Undo
      </button>
      <button
        className={`undo-more${open ? " on" : ""}`}
        onClick={() => setOpen(!open)}
        disabled={!items.length}
        aria-expanded={open}
        title="Your last changes: undo several at once"
      >
        ▾
      </button>
      {open && (
        <div className="undo-list" role="menu" onMouseLeave={() => setHover(-1)}>
          <div className="undo-list-head">Undo back to…</div>
          {newest.map((h, i) => (
            <button
              key={i}
              role="menuitem"
              className={i <= hover ? "hit" : ""}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={() => {
                setOpen(false);
                onUndo(i + 1);
              }}
            >
              <span className="undo-text">{describeStep(h)}</span>
              <span className="undo-time">{time(h.at)}</span>
            </button>
          ))}
          <div className="undo-list-foot">{hover >= 0 ? `Undo ${hover + 1} step${hover ? "s" : ""}` : `Last ${items.length} step${items.length === 1 ? "" : "s"} of this revision`}</div>
        </div>
      )}
    </div>
  );
}

const ROW = 40;
const LANE = 12;
const LANE_COLORS = ["#7c3aed", "#0891b2", "#d97706", "#db2777", "#16a34a"];

/** What a revision changed, in a line: the first changes and how many more. */
function revisionText(r: RevisionInfo): string {
  if (!r.ops.length) return r.revision === 0 ? "session created" : "saved before revision history";
  const shown = r.ops.slice(0, 2).map(describeOp);
  const more = r.count - shown.length;
  return shown.join(" · ") + (more > 0 ? ` (+${more} more)` : "");
}

/**
 * Where to draw each revision's link to its parent. Revisions are one list, newest first: a
 * revision made from the one just below it continues the main line; one made from an earlier
 * revision gets an arc in a side lane, and the main line breaks above the revision it skipped.
 */
function graph(rows: RevisionInfo[]) {
  const index = new Map(rows.map((r, i) => [r.revision, i]));
  const lanes: Array<Array<[number, number]>> = [];
  const arcs: Array<{ from: number; to: number; lane: number }> = [];
  const straight: number[] = [];
  rows.forEach((r, i) => {
    if (r.parent === null) return;
    const j = index.get(r.parent) ?? rows.length; // parent older than the rows shown: run off the bottom
    if (j === i + 1) return void straight.push(i);
    let lane = lanes.findIndex((busy) => busy.every(([a, b]) => j <= a || i >= b));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane].push([i, j]);
    arcs.push({ from: i, to: j, lane: lane + 1 });
  });
  return { straight, arcs, width: 10 + (lanes.length + 1) * LANE };
}

const PAGE = 200;

/** The session's revisions, newest first, with a line to the revision each one was made from. */
export function RevisionsPanel({
  head,
  viewing,
  compared,
  onOpen,
  onCompare,
}: {
  head: number;
  viewing: number | null;
  /** The two revisions being compared (older first). */
  compared: [number, number] | null;
  onOpen: (revision: number) => void;
  onCompare: (a: number, b: number) => void;
}) {
  const [list, setList] = useState<RevisionInfo[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  /** Revisions picked with Ctrl+click to compare (at most two; a third replaces the first). */
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      fetchRevisions()
        .then((r) => setList(r.revisions))
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [head]);
  if (!list) return <p className="muted panel">Loading revisions…</p>;
  const rows = list.slice(0, limit);
  const { straight, arcs, width } = graph(rows);
  const current = viewing ?? head;
  const y = (i: number) => i * ROW + ROW / 2;
  return (
    <section className="panel revisions">
      <p className="muted">
        Every change is a revision. Open one to look at it; edit it and your edit becomes the latest revision, made from that one.
        Ctrl+click two revisions to compare them.
      </p>
      {picked.length > 0 && (
        <div className="compare-bar">
          {picked.length === 1 ? (
            <span>r{picked[0]} picked: Ctrl+click another one</span>
          ) : (
            <button
              className="compare-go"
              onClick={() => {
                const [a, b] = [...picked].sort((x, y) => x - y);
                setPicked([]);
                onCompare(a, b);
              }}
            >
              Compare r{Math.min(...picked)} → r{Math.max(...picked)}
            </button>
          )}
          <button className="icon" onClick={() => setPicked([])} title="Clear the picked revisions">
            ✕
          </button>
        </div>
      )}
      <div className="rev-list" style={{ ["--graph" as string]: `${width}px` }}>
        <svg className="rev-graph" width={width} height={rows.length * ROW} aria-hidden>
          {straight.map((i) => (
            <line key={`s${i}`} x1={10} x2={10} y1={y(i)} y2={y(i + 1)} stroke={LANE_COLORS[0]} strokeWidth={2} />
          ))}
          {arcs.map(({ from, to, lane }) => {
            const x = 10 + lane * LANE;
            const end = to >= rows.length ? rows.length * ROW : y(to);
            const r = Math.min(8, (end - y(from)) / 2);
            const d = `M 10 ${y(from)} Q ${x} ${y(from)} ${x} ${y(from) + r} L ${x} ${end - r} Q ${x} ${end} ${to >= rows.length ? x : 10} ${end}`;
            return <path key={`a${from}`} d={d} fill="none" stroke={LANE_COLORS[lane % LANE_COLORS.length]} strokeWidth={2} />;
          })}
          {rows.map((r, i) => (
            <circle
              key={r.revision}
              cx={10}
              cy={y(i)}
              r={r.revision === current ? 5.5 : 4}
              className={r.source === "agent" ? "dot agent" : "dot"}
              strokeWidth={r.revision === current ? 3 : 0}
            />
          ))}
        </svg>
        {rows.map((r) => (
          <button
            key={r.revision}
            className={`rev-row${r.revision === current ? " current" : ""}${picked.includes(r.revision) ? " picked" : ""}`}
            onClick={(e) => {
              if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return onOpen(r.revision);
              setPicked((p) => (p.includes(r.revision) ? p.filter((x) => x !== r.revision) : [...p, r.revision].slice(-2)));
            }}
            title={`${r.revision === head ? "The latest revision" : `Open revision ${r.revision}`} · Ctrl+click to pick it for comparing`}
          >
            <span className="rev-top">
              <b>r{r.revision}</b>
              <span className={`who ${r.source}`}>{r.source === "agent" ? (r.actor ?? "Agent") : "You"}</span>
              {r.revision === head && <span className="rev-tag latest">latest</span>}
              {compared?.includes(r.revision) ? (
                <span className="rev-tag viewing">{r.revision === compared[0] ? "compared from" : "compared to"}</span>
              ) : (
                r.revision === viewing && <span className="rev-tag viewing">viewing</span>
              )}
              {r.parent !== null && r.parent !== r.revision - 1 && <span className="rev-tag from">from r{r.parent}</span>}
              <span className="rev-time">{time(r.at)}</span>
            </span>
            <span className="rev-text">{revisionText(r)}</span>
          </button>
        ))}
      </div>
      {list.length > limit && (
        <button className="ghost small" onClick={() => setLimit(limit + PAGE)}>
          Show older ({list.length - limit} more)
        </button>
      )}
    </section>
  );
}

const CHANGE_LABEL: Record<Change, string> = { added: "Added", changed: "Changed", removed: "Removed" };
const FIELD_LABEL: Record<string, string> = {
  text: "text",
  details: "detail lines",
  shape: "shape",
  status: "proposal colour",
  ends: "connects",
  arrow: "arrow",
  kind: "kind",
  sections: "sections",
  position: "order",
  targets: "targets",
  replies: "replies",
  orphaned: "targets deleted",
};
const TYPE_ICON: Record<ElementChange["type"], string> = {
  node: "▭",
  edge: "→",
  participant: "☺",
  message: "↦",
  note: "✎",
  activation: "▮",
  fragment: "⧉",
};

/** Long runs of unchanged lines fold to "… N unchanged lines", keeping two lines of context. */
function foldText(lines: TextLine[]): Array<TextLine | number> {
  const out: Array<TextLine | number> = [];
  const near = (i: number) => lines.slice(Math.max(0, i - 2), i + 3).some((l) => l.op !== " ");
  let folded = 0;
  lines.forEach((l, i) => {
    if (l.op === " " && !near(i)) return void folded++;
    if (folded) out.push(folded);
    folded = 0;
    out.push(l);
  });
  if (folded) out.push(folded);
  return out;
}

/** What changed between two revisions: elements, marks, layout and the Mermaid text. Clicking a row shows it. */
export function ComparePanel({
  diff,
  showMoves,
  onShowMoves,
  onReveal,
  onClose,
}: {
  diff: RevisionDiff;
  showMoves: boolean;
  onShowMoves: (on: boolean) => void;
  onReveal: (target: OpTarget) => void;
  onClose: () => void;
}) {
  const groups = (["added", "changed", "removed"] as const).map((c) => [c, diff.elements.filter((e) => e.change === c)] as const);
  const layoutCount = diff.moved.length + diff.reanchored.length;
  const nothing = !diff.elements.length && !diff.marks.length;
  const text = foldText(diff.text);
  return (
    <section className="panel compare">
      <div className="panel-head">
        <h3>
          r{diff.from} → r{diff.to}
        </h3>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {nothing && <p className="muted">{diff.text.some((l) => l.op !== " ") ? "Only the Mermaid text differs." : "No changes to the diagram or marks."}</p>}
      {groups.map(([change, items]) =>
        items.length ? (
          <div key={change} className="compare-group">
            <div className={`compare-title ${change}`}>
              {CHANGE_LABEL[change]} <span className="count">{items.length}</span>
            </div>
            {items.map((c) => (
              <button key={c.id} className={`compare-row ${change}`} onClick={() => onReveal({ element: c.id })} title={`Show ${c.id}`}>
                <span className="compare-icon">{TYPE_ICON[c.type]}</span>
                <span className="compare-name">
                  {c.name}
                  {c.fields.length > 0 && <span className="compare-fields"> · {c.fields.map((f) => FIELD_LABEL[f] ?? f).join(", ")}</span>}
                  {c.before !== undefined && <span className="compare-before">was “{c.before || "(empty)"}”</span>}
                </span>
                <code>{c.id}</code>
              </button>
            ))}
          </div>
        ) : null,
      )}
      {diff.marks.length > 0 && (
        <div className="compare-group">
          <div className="compare-title">
            Marks <span className="count">{diff.marks.length}</span>
          </div>
          {diff.marks.map((m) => (
            <button key={m.id} className={`compare-row ${m.change}`} onClick={() => m.change !== "removed" && onReveal({ mark: m.id })}>
              <span className="compare-icon">{KIND_META[m.kind ?? "none"].icon}</span>
              <span className="compare-name">
                #{m.id} {m.text ? `“${m.text.length > 50 ? m.text.slice(0, 49) + "…" : m.text}”` : KIND_META[m.kind ?? "none"].label}
                <span className="compare-fields">
                  {" · "}
                  {m.change === "changed"
                    ? m.fields.map((f) => (f === "replies" ? `${m.newReplies} new repl${m.newReplies === 1 ? "y" : "ies"}` : FIELD_LABEL[f] ?? f)).join(", ")
                    : m.change}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {diff.type === "flowchart" && (
        <label className="compare-moves" title="Moves and resizes don't change the diagram's meaning; they are left out unless shown here">
          <input type="checkbox" checked={showMoves} onChange={(e) => onShowMoves(e.target.checked)} disabled={!layoutCount} />
          Show layout changes
          <span className="muted">
            {layoutCount ? ` (${diff.moved.length} box${diff.moved.length === 1 ? "" : "es"} moved, ${diff.reanchored.length} edge end${diff.reanchored.length === 1 ? "" : "s"})` : " (none)"}
          </span>
        </label>
      )}
      {showMoves &&
        [...diff.moved, ...diff.reanchored].map((id) => (
          <button key={id} className="compare-row moved" onClick={() => onReveal({ element: id })}>
            <span className="compare-icon">{diff.moved.includes(id) ? "✥" : "↝"}</span>
            <span className="compare-name">{diff.moved.includes(id) ? "moved or resized" : "edge end moved"}</span>
            <code>{id}</code>
          </button>
        ))}
      <details className="compare-text">
        <summary>Mermaid text</summary>
        <pre>
          {text.map((l, i) =>
            typeof l === "number" ? (
              <span key={i} className="fold">
                … {l} unchanged line{l === 1 ? "" : "s"}
                {"\n"}
              </span>
            ) : (
              <span key={i} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
                {l.op} {l.line}
                {"\n"}
              </span>
            ),
          )}
        </pre>
      </details>
    </section>
  );
}
