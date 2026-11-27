import { test } from "node:test";
import assert from "node:assert/strict";
import { freeSpot } from "../client/src/layout.ts";

const size = { width: 180, height: 56 };
const rect = (c: { x: number; y: number }) => ({ x: c.x - 90, y: c.y - 28, ...size });
const touches = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
  a.x < b.x + b.width + 20 && a.x + a.width + 20 > b.x && a.y < b.y + b.height + 20 && a.y + a.height + 20 > b.y;

test("a new box goes where asked when that is free, else to the nearest free place", () => {
  assert.deepEqual(freeSpot({ x: 0, y: 0 }, size, []), { x: 0, y: 0 });
  const others = [rect({ x: 0, y: 0 }), rect({ x: 0, y: 120 }), rect({ x: 260, y: 0 })];
  const c = freeSpot({ x: 10, y: 5 }, size, others);
  for (const o of others) assert.ok(!touches(rect(c), o), `clear of ${JSON.stringify(o)}`);
  assert.ok(Math.hypot(c.x - 10, c.y - 5) < 300, "stays close");
});
