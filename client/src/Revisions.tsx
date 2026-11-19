import { useEffect, useRef, useState } from "react";
import { describeOp, describeStep, fetchRevisions, type HistoryItem, type RevisionInfo } from "./api.ts";

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
  onOpen,
}: {
  head: number;
  viewing: number | null;
  onOpen: (revision: number) => void;
}) {
  const [list, setList] = useState<RevisionInfo[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
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
      </p>
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
            className={`rev-row${r.revision === current ? " current" : ""}`}
            onClick={() => onOpen(r.revision)}
            title={r.revision === head ? "The latest revision" : `Open revision ${r.revision}`}
          >
            <span className="rev-top">
              <b>r{r.revision}</b>
              <span className={`who ${r.source}`}>{r.source === "agent" ? (r.actor ?? "Agent") : "You"}</span>
              {r.revision === head && <span className="rev-tag latest">latest</span>}
              {r.revision === viewing && <span className="rev-tag viewing">viewing</span>}
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
