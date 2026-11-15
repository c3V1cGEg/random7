import { Panel } from "@xyflow/react";
import { CHANGE_STATUSES, type ChangeStatus } from "../../server/types.ts";

type Element = { id: string; status?: ChangeStatus; label?: string };
import { STATUS_META } from "./kinds.ts";

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
    <Panel position="top-left" className="legend nodrag nopan">
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
    </Panel>
  );
}
