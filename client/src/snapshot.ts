import { toPng } from "html-to-image";
import type { Rect, XYPosition } from "@xyflow/react";

/** Room around the diagram, so mark rings, badges and edge labels at the edges stay in the picture. */
const PADDING = 48;
/** Browsers refuse canvases much beyond this many pixels a side; large diagrams get a lower pixel ratio. */
const MAX_SIDE = 16000;

/** Editing chrome that is not part of the diagram. */
const CHROME = ["react-flow__handle", "react-flow__resize-control", "edge-knob"];

/** What the picture shows: nodes, edges (whose curves can bow far past the nodes), edge labels, mark rings. */
// Instance chips and a choice's name sit outside their node's box, so they are measured on their own.
const DRAWN = [".react-flow__node", ".react-flow__node .instances", ".react-flow__node .choice-id", ".react-flow__edge-path", ".react-flow__edgelabel-renderer > *", ".react-flow__viewport-portal > *"];

/** The flow-space box around everything drawn in `viewport`, measured on screen and mapped back with `toFlow`. */
export function drawnBounds(viewport: HTMLElement, toFlow: (p: XYPosition) => XYPosition): Rect | null {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const el of viewport.querySelectorAll(DRAWN.join(","))) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const a = toFlow({ x: r.left, y: r.top });
    const b = toFlow({ x: r.right, y: r.bottom });
    box = box
      ? { x0: Math.min(box.x0, a.x), y0: Math.min(box.y0, a.y), x1: Math.max(box.x1, b.x), y1: Math.max(box.y1, b.y) }
      : { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  return box && { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

/**
 * Renders the whole diagram (everything inside `bounds`, not just what is on screen) as a PNG data URL,
 * at twice the size for sharp text where the diagram is small enough.
 */
export function diagramPng(viewport: HTMLElement, bounds: Rect): Promise<string> {
  const width = Math.ceil(bounds.width + 2 * PADDING);
  const height = Math.ceil(bounds.height + 2 * PADDING);
  return toPng(viewport, {
    backgroundColor: "#ffffff",
    width,
    height,
    pixelRatio: Math.min(2, MAX_SIDE / Math.max(width, height)),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px) scale(1)`,
    },
    filter: (el) => !(el instanceof Element && CHROME.some((c) => el.classList.contains(c))),
  });
}

export function download(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
