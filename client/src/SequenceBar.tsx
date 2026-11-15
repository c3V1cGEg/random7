import type { AnnotationKind, ChangeStatus } from "../../server/types.ts";
import { FRAGMENT_KINDS, SECTION_KEYWORD, SEQ_ARROWS, findItem, type SeqArrow, type SeqItem, type Sequence } from "../../server/sequence.ts";
import type { CanvasNode } from "./elements.tsx";
import { FloatingBar, MarkChips, StatusChips } from "./SelectionBar.tsx";
import { ARROW_LABELS, FRAGMENT_DEFAULTS, neighbourPosition } from "./useSequence.ts";
import type { Operation } from "./api.ts";

/** Contextual toolbar for sequence-diagram selections. */
export function SequenceBar({
  sequence,
  allNodes,
  nodes,
  send,
  onMark,
  onEdit,
  onNext,
  onMessageFrom,
  onMove,
  onMoveLane,
  onWrap,
  onAddSection,
  onDelete,
}: {
  sequence: Sequence;
  allNodes: CanvasNode[];
  nodes: CanvasNode[];
  send(ops: Operation[]): void;
  onMark(kind?: AnnotationKind): void;
  onEdit(): void;
  onNext(id: string): void;
  onMessageFrom(id: string): void;
  onMove(id: string, dir: "earlier" | "later"): void;
  onMoveLane(id: string, dir: "up" | "down"): void;
  onWrap(kind: (typeof FRAGMENT_KINDS)[number]): void;
  onAddSection(id: string): void;
  onDelete(): void;
}) {
  if (!nodes.length) return null;
  const ids = nodes.map((n) => n.id);
  const lane = (id: string) => sequence.participants.find((p) => p.id === id);
  const items = ids.map((id) => findItem(sequence, id)).filter((l) => !!l);
  const statuses = ids.map((id) => (lane(id) ?? findItem(sequence, id)?.item)?.status);
  const onStatus = (status: ChangeStatus | null) =>
    send(
      ids.flatMap((id): Operation[] => {
        if (lane(id)) return [{ op: "update_participant", id, status }];
        const it = findItem(sequence, id)?.item;
        if (it?.type === "message") return [{ op: "update_message", id, status }];
        if (it?.type === "note") return [{ op: "update_note", id, status }];
        if (it?.type === "fragment") return [{ op: "update_fragment", id, status }];
        return [];
      }),
    );
  const single = ids.length === 1 ? ids[0] : undefined;
  const participant = single ? lane(single) : undefined;
  const item: SeqItem | undefined = single ? findItem(sequence, single)?.item : undefined;
  const siblings = items.length > 0 && items.length === ids.length && items.every((l) => l.list === items[0].list);
  const earlier = item && neighbourPosition(sequence, item.id, "earlier");
  const later = item && neighbourPosition(sequence, item.id, "later");
  const laneIndex = participant ? sequence.participants.indexOf(participant) : -1;

  return (
    <FloatingBar allNodes={allNodes} nodes={nodes} edges={[]}>
      <MarkChips onMark={onMark} />
      <StatusChips statuses={statuses} onStatus={onStatus} />
      {participant && (
        <span className="group">
          <button className="tool" title="Move lane up (↑)" disabled={laneIndex <= 0} onClick={() => onMoveLane(participant.id, "up")}>
            ▲
          </button>
          <button className="tool" title="Move lane down (↓)" disabled={laneIndex >= sequence.participants.length - 1} onClick={() => onMoveLane(participant.id, "down")}>
            ▼
          </button>
          <button
            className={`tool${participant.kind === "actor" ? " on" : ""}`}
            title="Show as a person (actor)"
            onClick={() => send([{ op: "update_participant", id: participant.id, kind: participant.kind === "actor" ? "participant" : "actor" }])}
          >
            👤
          </button>
          <button className="tool" title="Rename (Enter)" onClick={onEdit}>
            ✎
          </button>
          <button className="tool wide" title="Add a message from this lane at the end (or drag from the lane's handle)" onClick={() => onMessageFrom(participant.id)}>
            + Message
          </button>
        </span>
      )}
      {item?.type === "message" && (
        <span className="group">
          <select title="From" value={item.from} onChange={(e) => send([{ op: "update_message", id: item.id, from: e.target.value }])}>
            {sequence.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            className="tool"
            title="Swap direction"
            onClick={() => send([{ op: "update_message", id: item.id, from: item.to, to: item.from }])}
          >
            ⇅
          </button>
          <select title="To" value={item.to} onChange={(e) => send([{ op: "update_message", id: item.id, to: e.target.value }])}>
            {sequence.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select title="Kind of message" value={item.arrow} onChange={(e) => send([{ op: "update_message", id: item.id, arrow: e.target.value as SeqArrow }])}>
            {SEQ_ARROWS.map((a) => (
              <option key={a} value={a}>
                {ARROW_LABELS[a]}
              </option>
            ))}
          </select>
          <select
            title="Activation: the target starts working (or the sender stops)"
            value={item.activate ? "start" : item.deactivate ? "end" : ""}
            onChange={(e) =>
              send([{ op: "update_message", id: item.id, activate: e.target.value === "start", deactivate: e.target.value === "end" }])
            }
          >
            <option value="">no activation</option>
            <option value="start">▶ target starts work</option>
            <option value="end">■ sender ends work</option>
          </select>
          <button className="tool wide" title="Next message (Tab)" onClick={() => onNext(item.id)}>
            + Next
          </button>
        </span>
      )}
      {item?.type === "fragment" && (
        <span className="group">
          <select
            title="Kind of block"
            value={item.kind}
            onChange={(e) => send([{ op: "update_fragment", id: item.id, kind: e.target.value as (typeof FRAGMENT_KINDS)[number] }])}
          >
            {FRAGMENT_KINDS.filter((k) => SECTION_KEYWORD[k] || item.sections.length === 1).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {SECTION_KEYWORD[item.kind] && (
            <button className="tool wide" title={`Add an "${SECTION_KEYWORD[item.kind]}" section`} onClick={() => onAddSection(item.id)}>
              + {SECTION_KEYWORD[item.kind]}
            </button>
          )}
          <button className="tool wide" title="Remove the block but keep what is inside" onClick={() => send([{ op: "remove_item", id: item.id, keepContents: true }])}>
            Unwrap
          </button>
        </span>
      )}
      {item && (
        <span className="group">
          <button className="tool" title="Earlier (←)" disabled={!earlier} onClick={() => onMove(item.id, "earlier")}>
            ◀
          </button>
          <button className="tool" title="Later (→)" disabled={!later} onClick={() => onMove(item.id, "later")}>
            ▶
          </button>
          {(item.type === "message" || item.type === "note") && (
            <button className="tool" title="Edit text (Enter)" onClick={onEdit}>
              ✎
            </button>
          )}
        </span>
      )}
      {siblings && (
        <span className="group" aria-label="Group the selection">
          {FRAGMENT_KINDS.map((k) => (
            <button key={k} className="tool wide" title={FRAGMENT_DEFAULTS[k].hint} onClick={() => onWrap(k)}>
              {k}
            </button>
          ))}
        </span>
      )}
      <span className="group">
        <button className="tool danger" title="Delete (Del)" onClick={onDelete}>
          🗑
        </button>
      </span>
    </FloatingBar>
  );
}
