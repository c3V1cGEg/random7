import { useCallback, useEffect, useRef, useState } from "react";
import { findItem } from "../../server/sequence.ts";
import { ANNOTATION_KINDS, awaitingAgent, type Annotation, type AnnotationKind } from "../../server/types.ts";
import { canvasRef, type BrowserState, type ChangeEvent, type Operation, type OpTarget } from "./api.ts";
import { KIND_META } from "./kinds.ts";
import { textStats } from "./tokens.ts";

export interface ActivityItem {
  key: string;
  source: ChangeEvent["source"];
  /** Agent name for agent changes. */
  actor?: string;
  text: string;
  target: OpTarget;
}

const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Points the agent at the marks waiting for it, in as few words as possible. */
export function agentPrompt(marks: Annotation[]): string {
  const open = marks.filter(awaitingAgent);
  if (!open.length) return `Review my changes on ${canvasRef()}.`;
  const refs = open.map((a) => `#${a.id}`).join(", ");
  return `Review mark${open.length > 1 ? "s" : ""} ${refs} needing your reply on ${canvasRef()}.`;
}

export function MarksPanel({
  state,
  activeMark,
  noteFocus,
  selectionSize,
  touched,
  send,
  onActivate,
  onHover,
  onRetarget,
  onCopy,
}: {
  state: BrowserState;
  activeMark: number | null;
  /** Agent-touched elements; marks appear as "#N". */
  touched: ReadonlySet<string>;
  /** Mark whose note should receive focus (just created). */
  noteFocus: number | null;
  selectionSize: number;
  send: (ops: Operation[]) => Promise<unknown>;
  onActivate: (a: Annotation) => void;
  onHover: (id: number | null) => void;
  onRetarget: (a: Annotation) => void;
  onCopy: (text: string, what: string) => void;
}) {
  const marks = state.annotations;
  return (
    <section className="panel marks">
      <header className="panel-head">
        <h3>
          Marks <span className="count">{marks.length}</span>
        </h3>
        <button className="ghost" title="Copy a prompt that points the agent at your marks" onClick={() => onCopy(agentPrompt(marks), "Prompt")}>
          ⧉ Copy prompt for agent
        </button>
      </header>
      {!marks.length && (
        <p className="muted">
          Select elements and press <kbd>M</kbd> (or a chip on the floating bar). The agent sees each mark as <b>#N</b>.
        </p>
      )}
      {marks.map((a) => (
        <MarkCard
          key={a.id}
          a={a}
          state={state}
          active={activeMark === a.id}
          touched={touched.has(`#${a.id}`)}
          autoFocusNote={noteFocus === a.id}
          canRetarget={selectionSize > 0}
          send={send}
          onActivate={() => onActivate(a)}
          onHover={onHover}
          onRetarget={() => onRetarget(a)}
          onCopy={onCopy}
        />
      ))}
    </section>
  );
}

function MarkCard({
  a,
  state,
  active,
  touched,
  autoFocusNote,
  canRetarget,
  send,
  onActivate,
  onHover,
  onRetarget,
  onCopy,
}: {
  a: Annotation;
  state: BrowserState;
  active: boolean;
  touched: boolean;
  autoFocusNote: boolean;
  canRetarget: boolean;
  send: (ops: Operation[]) => Promise<unknown>;
  onActivate: () => void;
  onHover: (id: number | null) => void;
  onRetarget: () => void;
  onCopy: (text: string, what: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(a.text ?? "");
  // While the user types, incoming changes must not clobber the draft; the save compares
  // against the text at focus time so an untouched note never overwrites a newer one.
  const typing = useRef(false);
  const base = useRef(a.text ?? "");
  const [changedRemotely, setChangedRemotely] = useState(false);
  useEffect(() => {
    if (typing.current) setChangedRemotely(true);
    else setText(a.text ?? "");
  }, [a.text]);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  useEffect(() => {
    if (autoFocusNote) noteRef.current?.focus();
  }, [autoFocusNote]);
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const saveText = () => {
    typing.current = false;
    setChangedRemotely(false);
    if (text.trim() !== base.current.trim()) void send([{ op: "update_annotation", id: a.id, text: text.trim() || null }]);
    else setText(a.text ?? "");
  };
  const kind = a.kind ?? "none";
  const nodeLabel = (id: string) => state.nodes.find((n) => n.id === id)?.label ?? id;
  const elementText = (id: string) => {
    const p = state.sequence.participants.find((x) => x.id === id);
    if (p) return `lane ${p.label}`;
    const it = findItem(state.sequence, id)?.item;
    if (!it) return id;
    if (it.type === "message") return `${it.from}→${it.to} ${it.text}`;
    if (it.type === "note") return `note ${it.text}`;
    if (it.type === "fragment") return `${it.kind} ${it.sections[0]?.label ?? ""}`;
    return `${it.type} ${it.participant}`;
  };
  const edgeText = (id: string) => {
    const e = state.edges.find((x) => x.id === id);
    return e ? `${e.from}→${e.to}${e.label ? ` ${e.label}` : ""}` : id;
  };

  return (
    <div
      ref={ref}
      className={`mark-card kind-${kind}${active ? " active" : ""}${touched ? " touched" : ""}`}
      onClick={onActivate}
      onMouseEnter={() => onHover(a.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="mark-head">
        <span className="mark-id">#{a.id}</span>
        <select
          className="kind-select"
          value={a.kind ?? ""}
          title="Kind"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => send([{ op: "update_annotation", id: a.id, kind: (e.target.value || null) as AnnotationKind | null }])}
        >
          <option value="">{KIND_META.none.icon} Note</option>
          {ANNOTATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_META[k].icon} {KIND_META[k].label}
            </option>
          ))}
        </select>
        <ThreadStatus a={a} />
        <span className="spacer" />
        <button
          className="icon"
          title="Copy reference for the agent chat"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(`mark #${a.id}`, `“mark #${a.id}”`);
          }}
        >
          ⧉
        </button>
        <button
          className="icon danger"
          title="Delete mark (nodes stay)"
          onClick={(e) => {
            e.stopPropagation();
            void send([{ op: "remove_annotation", id: a.id }]);
          }}
        >
          ✕
        </button>
      </div>
      {a.orphaned && <p className="warn">Everything this mark pointed at was deleted.</p>}
      {changedRemotely && <p className="warn">The agent edited this note while you were typing. Leave it unchanged (Esc) to keep the agent's version.</p>}
      <div className="targets">
        {a.nodeIds.map((id) => (
          <span key={id} className="target" data-tip={`${id} ${nodeLabel(id)}`}>
            <code>{id}</code> {short(nodeLabel(id))}
          </span>
        ))}
        {(a.elementIds ?? []).map((id) => (
          <span key={id} className="target" data-tip={`${id} ${elementText(id)}`}>
            <code>{id}</code> {short(elementText(id))}
          </span>
        ))}
        {a.edgeIds.map((id) => (
          <span key={id} className="target edge" data-tip={`${id} ${edgeText(id)}`}>
            <code>{id}</code> {short(edgeText(id))}
          </span>
        ))}
      </div>
      {a.by === "agent" && <p className="mark-author">{a.agent ?? "Agent"} asks:</p>}
      <textarea
        ref={noteRef}
        value={text}
        rows={1}
        readOnly={a.by === "agent"}
        placeholder="Add a note for the agent…"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          typing.current = true;
          base.current = text;
        }}
        onBlur={saveText}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(base.current);
            requestAnimationFrame(() => noteRef.current?.blur());
          }
        }}
      />
      {!!a.replies?.length && (
        <ol className="replies">
          {a.replies.map((r, i) => (
            <li key={i} className={`reply ${r.by}`}>
              <span className={`who ${r.by}`}>{r.by === "agent" ? (r.agent ?? "Agent") : "You"}</span> <span className="reply-text">{r.text}</span>
            </li>
          ))}
        </ol>
      )}
      {(active || !!a.replies?.length || a.by === "agent") && <ReplyBox id={a.id} send={send} />}
      {active && (
        <button
          className="link"
          disabled={!canRetarget}
          onClick={(e) => {
            e.stopPropagation();
            onRetarget();
          }}
          title="Replace this mark's targets with the current canvas selection"
        >
          ↺ Point this mark at the current selection
        </button>
      )}
    </div>
  );
}

/** Who the mark is waiting for: the agent (open), or the user (the agent answered or asked). */
function ThreadStatus({ a }: { a: Annotation }) {
  if (awaitingAgent(a)) return a.replies?.length ? <span className="thread-status open">follow-up</span> : null;
  return a.replies?.length ? (
    <span className="thread-status answered">↩ answered</span>
  ) : (
    <span className="thread-status asks">asks you</span>
  );
}

function ReplyBox({ id, send }: { id: number; send: (ops: Operation[]) => Promise<unknown> }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send([{ op: "reply_annotation", id, text }]);
  };
  return (
    <textarea
      ref={ref}
      className="reply-box"
      value={draft}
      rows={1}
      placeholder="Reply… (Enter to send)"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          setDraft("");
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function ActivityPanel({ items, onReveal }: { items: ActivityItem[]; onReveal: (t: OpTarget) => void }) {
  return (
    <details className="panel" open>
      <summary>Activity</summary>
      {!items.length && <p className="muted">Changes by you and the agent show up here.</p>}
      <ul className="activity">
        {items.map((i) => (
          <li key={i.key} className={i.target ? "clickable" : ""} onClick={() => i.target && onReveal(i.target)}>
            <span className={`who ${i.source}`}>{i.source === "agent" ? (i.actor ?? "Agent") : "You"}</span> {i.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Share of a model's context window, for scale: 200k tokens. */
const CONTEXT = 200_000;

/** A small window with the Mermaid's size and a rough token count (estimated, no tokenizer). */
function SizeInfo({ text, onClose }: { text: string; onClose: () => void }) {
  const s = textStats(text);
  const share = (s.tokens / CONTEXT) * 100;
  const n = (v: number) => v.toLocaleString();
  useEffect(() => {
    const close = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.(".size-info, .size-btn")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="size-info" role="dialog" aria-label="Mermaid size">
      <button className="close" onClick={onClose} title="Close (Esc)">
        ×
      </button>
      <div className="big">
        ≈ {n(s.tokens)} <span>tokens</span>
      </div>
      <dl>
        <dt>Characters</dt>
        <dd>{n(s.chars)}</dd>
        <dt>Size</dt>
        <dd>{s.bytes < 1024 ? `${n(s.bytes)} bytes` : `${(s.bytes / 1024).toFixed(1)} KB`}</dd>
        <dt>Lines</dt>
        <dd>{n(s.lines)}</dd>
        <dt>Of a 200k context</dt>
        <dd>{share < 0.01 ? "< 0.01" : share < 1 ? share.toFixed(2) : share.toFixed(1)}%</dd>
      </dl>
      <p className="muted">
        An estimate (±25%) without the model's tokenizer. The agent also gets marks and ids alongside the Mermaid, so a snapshot is a
        little bigger.
      </p>
    </div>
  );
}

export function MermaidPanel({ diagram, onCopy }: { diagram: string; onCopy: (text: string, what: string) => void }) {
  const [info, setInfo] = useState(false);
  const close = useCallback(() => setInfo(false), []);
  return (
    <details className="panel mermaid-panel">
      <summary>What the agent sees (Mermaid)</summary>
      <span className="mermaid-tools">
        <button className="ghost small" onClick={() => onCopy(diagram, "Mermaid")}>
          ⧉ Copy
        </button>
        <button className={`ghost small size-btn${info ? " on" : ""}`} onClick={() => setInfo((v) => !v)} title="Size and token estimate">
          ⓘ Size
        </button>
        {info && <SizeInfo text={diagram} onClose={close} />}
      </span>
      <pre className="mermaid-src">{diagram}</pre>
    </details>
  );
}
