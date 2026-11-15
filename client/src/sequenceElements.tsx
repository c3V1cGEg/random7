// React Flow node views for the sequence timeline. Geometry comes from sequenceLayout.ts;
// these components only draw it and route edits through ActionsContext.

import { memo, useContext } from "react";
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import type { SeqActivation, SeqFragment, SeqMessage, SeqNote, SeqParticipant } from "../../server/sequence.ts";
import { ActionsContext, LabelEditor, MarkBadges } from "./elements.tsx";
import { STATUS_META } from "./kinds.ts";
import { SEQ } from "./sequenceLayout.ts";

/** Colours of concurrent branches (par/and), shared by the frame header and the message labels. */
export const BRANCH_COLORS = ["#2563eb", "#9333ea", "#0d9488", "#c2410c", "#be185d"];
export const branchColor = (i: number) => BRANCH_COLORS[i % BRANCH_COLORS.length];

interface Common extends Record<string, unknown> {
  marks: number[];
}
export interface SeqParticipantData extends Common {
  participant: SeqParticipant;
}
export interface SeqMessageData extends Common {
  message: SeqMessage;
  /** Lane centres relative to the node's top edge. */
  fromY: number;
  toY: number;
  number?: number;
  branch?: number;
}
export interface SeqNoteData extends Common {
  note: SeqNote;
}
export interface SeqActivationData extends Common {
  activation: SeqActivation;
}
export interface SeqFragmentData extends Common {
  fragment: SeqFragment;
  /** Section start x relative to the frame (sequential kinds only). */
  sections: Array<{ x: number; label: string }>;
}
export interface SeqBackdropData extends Record<string, unknown> {
  lanes: Array<{ id: string; y: number }>;
  bars: Array<{ y: number; x0: number; x1: number }>;
  ticks: Array<{ x: number; step: number }>;
  axisY: number;
  width: number;
}

const statusClass = (s?: string) => (s ? ` status-${s}` : "");

function StatusTag({ status }: { status?: keyof typeof STATUS_META }) {
  return status ? <span className={`status-tag status-${status}`}>{STATUS_META[status].label}</span> : null;
}

/** Inline text with an editor when this element (or section) is being edited. */
function EditableText({ editKey, id, text, section, multiline = true, className }: { editKey: string; id: string; text: string; section?: number; multiline?: boolean; className?: string }) {
  const { editingId, setEditingId, editSequence, nextMessage, takeTypeAhead } = useContext(ActionsContext);
  if (editingId !== editKey) {
    return (
      <div className={`seq-text ${className ?? ""}`} onDoubleClick={(e) => (e.stopPropagation(), setEditingId(editKey))}>
        {text || <span className="placeholder">…</span>}
      </div>
    );
  }
  return (
    <LabelEditor
      value={text}
      className={`seq-edit ${multiline ? "" : "single"}`}
      takeTypeAhead={takeTypeAhead}
      onCommit={(v) => {
        setEditingId(null);
        if (v !== null) editSequence(id, v.trim(), section);
      }}
      onTab={
        className === "message-text"
          ? (v) => {
              if (v !== null) editSequence(id, v.trim(), section);
              nextMessage(id);
            }
          : undefined
      }
    />
  );
}

export const SeqParticipantView = memo(function SeqParticipantView({ id, data, selected }: NodeProps<Node<SeqParticipantData>>) {
  const { touched } = useContext(ActionsContext);
  const p = data.participant;
  return (
    <div className={`seq-participant${statusClass(p.status)}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}`}>
      <span className="node-id">{id}</span>
      <MarkBadges marks={data.marks} />
      <span className="seq-kind" data-tip={p.kind === "actor" ? "Actor (a person)" : "Participant"}>
        {p.kind === "actor" ? "👤" : "▭"}
      </span>
      <EditableText editKey={id} id={id} text={p.label} multiline={false} className="participant-label clip" />
      <StatusTag status={p.status} />
      <Handle type="source" position={Position.Right} id="msg" data-tip="Drag onto another lane to add a message there" />
    </div>
  );
});

/** Arrow heads per Mermaid arrow type: filled (>>), open (")"), cross (x) or none. */
function ArrowHead({ arrow, x, y, down }: { arrow: string; x: number; y: number; down: boolean }) {
  const d = down ? -1 : 1; // direction back along the line
  if (arrow.endsWith(">>")) return <polygon className="seq-head" points={`${x},${y} ${x - 6},${y + 11 * d} ${x + 6},${y + 11 * d}`} />;
  if (arrow.endsWith(")")) return <polyline className="seq-head open" points={`${x - 6},${y + 10 * d} ${x},${y} ${x + 6},${y + 10 * d}`} />;
  if (arrow.endsWith("x")) {
    return <path className="seq-head cross" d={`M ${x - 6} ${y - 6 + 4 * d} L ${x + 6} ${y + 6 + 4 * d} M ${x + 6} ${y - 6 + 4 * d} L ${x - 6} ${y + 6 + 4 * d}`} />;
  }
  return null;
}

export const SeqMessageView = memo(function SeqMessageView({ id, data, selected, width, height }: NodeProps<Node<SeqMessageData>>) {
  const { touched } = useContext(ActionsContext);
  const m = data.message;
  const self = m.from === m.to;
  const cls = `seq-message${statusClass(m.status)}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}${self ? " self" : ""}${m.arrow.startsWith("--") ? " dashed" : ""}`;
  const branch = data.branch !== undefined ? { borderLeftColor: branchColor(data.branch), borderLeftWidth: 4 } : undefined;
  const text = (
    <div className="seq-label hit clip" style={branch}>
      {data.number !== undefined && <span className="seq-number">{data.number}</span>}
      <EditableText editKey={id} id={id} text={m.text} className="message-text" />
      {(m.activate || m.deactivate) && <span className="seq-flag">{m.activate ? "▶ starts work" : "■ ends work"}</span>}
    </div>
  );
  if (self) {
    // An internal action on one lane: a box on the lane instead of an arrow to itself.
    return (
      <div className={cls}>
        <span className="node-id">{id}</span>
        <MarkBadges marks={data.marks} />
        {text}
        <StatusTag status={m.status} />
      </div>
    );
  }
  const w = width ?? 150;
  const h = height ?? 100;
  const cx = w / 2;
  const down = data.toY > data.fromY;
  const tip = down ? data.toY - 7 : data.toY + 7;
  return (
    <div className={cls}>
      <svg className="seq-arrow" width={w} height={h} aria-hidden>
        <line className="hit-line" x1={cx} y1={data.fromY} x2={cx} y2={tip} />
        <line className="seq-line" x1={cx} y1={data.fromY} x2={cx} y2={tip} />
        <circle className="seq-origin" cx={cx} cy={data.fromY} r={3.5} />
        <ArrowHead arrow={m.arrow} x={cx} y={tip} down={down} />
      </svg>
      <span className="node-id">{id}</span>
      <MarkBadges marks={data.marks} />
      {text}
      <StatusTag status={m.status} />
    </div>
  );
});

export const SeqNoteView = memo(function SeqNoteView({ id, data, selected }: NodeProps<Node<SeqNoteData>>) {
  const { touched } = useContext(ActionsContext);
  const n = data.note;
  return (
    <div className={`seq-note hit clip${statusClass(n.status)}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}`}>
      <span className="node-id">{id}</span>
      <MarkBadges marks={data.marks} />
      <EditableText editKey={id} id={id} text={n.text} />
      <StatusTag status={n.status} />
    </div>
  );
});

export const SeqActivationView = memo(function SeqActivationView({ id, data, selected }: NodeProps<Node<SeqActivationData>>) {
  const { touched } = useContext(ActionsContext);
  const a = data.activation;
  return (
    <div
      className={`seq-activation hit${statusClass(a.status)}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}`}
      data-tip={`${a.type} ${a.participant}`}
    >
      <MarkBadges marks={data.marks} />
      {a.type === "activate" ? "▶ start" : "■ end"}
    </div>
  );
});

const SECTION_WORD: Record<string, string> = { alt: "else", par: "and", critical: "option" };

export const SeqFragmentView = memo(function SeqFragmentView({ id, data, selected }: NodeProps<Node<SeqFragmentData>>) {
  const { touched } = useContext(ActionsContext);
  const f = data.fragment;
  const par = f.kind === "par";
  return (
    <div className={`seq-fragment kind-${f.kind}${statusClass(f.status)}${selected ? " selected" : ""}${touched.has(id) ? " touched" : ""}`}>
      <div className="seq-frame-tab hit">
        <b>{f.kind}</b>
        {par ? (
          f.sections.map((s, i) => (
            <span key={i} className="seq-branch" style={{ color: branchColor(i) }}>
              ●<EditableText editKey={`${id}::${i}`} id={id} section={i} text={s.label || `branch ${i + 1}`} multiline={false} className="clip" />
            </span>
          ))
        ) : (
          <EditableText editKey={`${id}::0`} id={id} section={0} text={f.sections[0]?.label ?? ""} multiline={false} className="clip" />
        )}
        <span className="node-id inline">{id}</span>
        <MarkBadges marks={data.marks} />
      </div>
      {!par &&
        data.sections.slice(1).map((s, i) => (
          <div key={i} className="seq-section" style={{ left: s.x }}>
            <div className="seq-section-tab hit">
              <b>{SECTION_WORD[f.kind] ?? "else"}</b>
              <EditableText editKey={`${id}::${i + 1}`} id={id} section={i + 1} text={s.label} multiline={false} className="clip" />
            </div>
          </div>
        ))}
      <StatusTag status={f.status} />
    </div>
  );
});

/** Lane lines, activation bars and the logical step axis. Not interactive. */
export const SeqBackdropView = memo(function SeqBackdropView({ data, width, height }: NodeProps<Node<SeqBackdropData>>) {
  return (
    <svg className="seq-backdrop" width={width} height={height} aria-hidden>
      <line className="seq-axis" x1={0} x2={data.width} y1={data.axisY} y2={data.axisY} />
      <text className="seq-axis-title" x={0} y={data.axisY - 10}>
        logical step →
      </text>
      {data.ticks.map((t, i) => (
        <g key={i}>
          <line className="seq-tick" x1={t.x} x2={t.x} y1={data.axisY - 4} y2={data.axisY + 4} />
          <text className="seq-tick-label" x={t.x} y={data.axisY - 9}>
            {t.step}
          </text>
        </g>
      ))}
      {data.lanes.map((l) => (
        <line key={l.id} className="seq-lane" x1={0} x2={data.width} y1={l.y} y2={l.y} />
      ))}
      {data.bars.map((b, i) => (
        <rect key={i} className="seq-bar" x={b.x0 - 6} y={b.y - 7} width={Math.max(12, b.x1 - b.x0 + 12)} height={14} rx={4} />
      ))}
    </svg>
  );
});

export const sequenceNodeTypes = {
  seqParticipant: SeqParticipantView,
  seqMessage: SeqMessageView,
  seqNote: SeqNoteView,
  seqActivation: SeqActivationView,
  seqFragment: SeqFragmentView,
  seqBackdrop: SeqBackdropView,
};

/**
 * Lane names pinned to the left edge while the real lane headers are scrolled out of view,
 * so long timelines stay readable. Each chip follows its lane's vertical position and zoom.
 */
export function FrozenLanes({ participants, laneY, onSelect }: { participants: SeqParticipant[]; laneY: Record<string, number>; onSelect(id: string): void }) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  if (tx + SEQ.headerWidth * zoom > 40) return null;
  return (
    <div className="frozen-lanes" aria-label="Lane names">
      {participants.map((p) => (
        <button
          key={p.id}
          className={`frozen-lane clip${p.status ? ` status-${p.status}` : ""}`}
          style={{ top: ty + (laneY[p.id] ?? 0) * zoom }}
          onClick={() => onSelect(p.id)}
        >
          {p.kind === "actor" ? "👤 " : ""}
          {p.label}
        </button>
      ))}
    </div>
  );
}
