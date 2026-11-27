import { test } from "node:test";
import assert from "node:assert/strict";
import { autoSides, resolveAnchors } from "../client/src/anchors.ts";

const box = (x: number, y: number) => ({ x, y, width: 180, height: 56 });

test("automatic arrow sides follow where the boxes are", () => {
  // Top-down: one below the other goes bottom → top, as the flow runs.
  assert.deepEqual(autoSides("TD", box(0, 0), box(0, 200)), { from: "bottom", to: "top" });
  assert.deepEqual(autoSides("TD", box(0, 0), box(150, 120)), { from: "bottom", to: "top" }, "diagonal below stays with the flow");
  // Side by side in a row: facing sides, either way round.
  assert.deepEqual(autoSides("TD", box(0, 0), box(260, 10)), { from: "right", to: "left" });
  assert.deepEqual(autoSides("TD", box(260, 0), box(0, -20)), { from: "left", to: "right" });
  // Left-right: a column joins top and bottom.
  assert.deepEqual(autoSides("LR", box(0, 0), box(300, 0)), { from: "right", to: "left" });
  assert.deepEqual(autoSides("LR", box(0, 0), box(20, 150)), { from: "bottom", to: "top" });
  assert.deepEqual(autoSides("LR", box(0, 150), box(20, 0)), { from: "top", to: "bottom" });
  // Overlapping (one dragged onto the other): the flow sides.
  assert.deepEqual(autoSides("TD", box(0, 0), box(40, 10)), { from: "bottom", to: "top" });
});

test("arrows sharing a side spread along it in the order of their other ends; hand-placed ends stay", () => {
  const rects: Record<string, ReturnType<typeof box>> = { a: box(300, 0), l: box(0, 0), r: box(600, 0), d1: box(200, 200), d2: box(400, 200) };
  const edges = [
    { id: "e1", from: "a", to: "d2" },
    { id: "e2", from: "a", to: "d1" },
    { id: "e3", from: "a", to: "r" },
    { id: "e4", from: "l", to: "a" },
  ];
  const ends = resolveAnchors(edges, "TD", { e3: { from: { side: "top", t: 0.9 } } }, (id) => rects[id]);
  assert.equal(ends.e2.from.side, "bottom");
  assert.ok(ends.e2.from.t < ends.e1.from.t, "d1 is left of d2");
  assert.deepEqual(ends.e3.from, { side: "top", t: 0.9, manual: true });
  assert.equal(ends.e3.to.side, "left");
  assert.deepEqual([ends.e4.from.side, ends.e4.to.side], ["right", "left"]);
});

test("a dropped end goes to the nearest side of the box, measured to the side itself", async () => {
  const { nearestAnchor } = await import("../client/src/anchors.ts");
  const pill = { x: 0, y: 0, width: 140, height: 38 };
  assert.equal(nearestAnchor(pill, { x: 165, y: 19 }).side, "right", "just right of a flat box");
  assert.equal(nearestAnchor(pill, { x: 70, y: 50 }).side, "bottom");
  assert.equal(nearestAnchor(pill, { x: 10, y: 15 }).side, "left", "inside, near the left edge");
  assert.deepEqual(nearestAnchor(pill, { x: 35, y: -30 }), { side: "top", t: 0.25 });
});

test("connect mode attaches the arrow where the boxes first touched", async () => {
  const { contactEnds } = await import("../client/src/anchors.ts");
  const target = box(300, 0);
  // From the left, level: right side to left side, middles.
  assert.deepEqual(contactEnds(box(110, 0), box(130, 0), target), { from: { side: "right", t: 0.5 }, to: { side: "left", t: 0.5 } });
  // From above, a little to the right: bottom to top, at the middle of the touching stretch.
  const e = contactEnds(box(400, -70), box(400, -50), target);
  assert.equal(e.from.side, "bottom");
  assert.equal(e.to.side, "top");
  assert.ok(e.from.t < 0.5 && e.to.t > 0.5);
  // From below-right, the corner, the vertical gap closing last: bottom side of the target.
  assert.deepEqual([contactEnds(box(470, 100), box(470, 70), target).from.side, contactEnds(box(470, 100), box(470, 70), target).to.side], ["top", "bottom"]);
  // From the right: left side to right side.
  assert.deepEqual([contactEnds(box(500, 10), box(470, 10), target).from.side, contactEnds(box(500, 10), box(470, 10), target).to.side], ["left", "right"]);
});

test("automatic sides turn to all four sides as a box goes round the other", () => {
  const center = box(300, 300);
  const around = (x: number, y: number) => autoSides("TD", center, box(x, y));
  assert.deepEqual(around(300, 500), { from: "bottom", to: "top" }, "below");
  assert.deepEqual(around(600, 300), { from: "right", to: "left" }, "right");
  assert.deepEqual(around(300, 100), { from: "top", to: "bottom" }, "above");
  assert.deepEqual(around(0, 300), { from: "left", to: "right" }, "left");
  // The moved box is the arrow's start: it leaves from its bottom when it is above.
  assert.deepEqual(autoSides("TD", box(300, 100), center), { from: "bottom", to: "top" });
  assert.deepEqual(autoSides("TD", box(300, 500), center), { from: "top", to: "bottom" });
  // Left-right diagrams too.
  const lr = (x: number, y: number) => autoSides("LR", center, box(x, y));
  assert.deepEqual(lr(0, 320), { from: "left", to: "right" });
  assert.deepEqual(lr(600, 280), { from: "right", to: "left" });
  assert.deepEqual(lr(310, 0), { from: "top", to: "bottom" });
  assert.deepEqual(lr(310, 600), { from: "bottom", to: "top" });
});
