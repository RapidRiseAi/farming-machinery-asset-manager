import assert from "node:assert/strict";
import test from "node:test";
import { addItem, clampBox, collides, compact, newWidgetId, place, readingOrder, removeItem, shiftInOrder, type LayoutItem } from "./layout";

const L = { minW: 2, minH: 2, maxW: 12, maxH: 8 };
const box = (id: string, x: number, y: number, w = 3, h = 2): LayoutItem => ({ id, type: "open_problems", x, y, w, h, settings: {} });
const noOverlap = (items: LayoutItem[]) => {
  for (const a of items) for (const b of items) if (a !== b) assert.ok(!collides(a, b), `${a.id} overlaps ${b.id}`);
};

test("boxes stay inside the grid and their limits", () => {
  assert.deepEqual(clampBox({ x: 11, y: -3, w: 4, h: 1 }, L), { x: 8, y: 0, w: 4, h: 2 });
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 40, h: 40 }, L), { x: 0, y: 0, w: 12, h: 8 });
  assert.deepEqual(clampBox({ x: Number.NaN, y: 2.6, w: 3, h: 2 }, L), { x: 0, y: 3, w: 3, h: 2 });
});

test("gravity closes gaps and never overlaps", () => {
  const out = compact([box("a", 0, 5), box("b", 0, 9), box("c", 3, 4)]);
  assert.deepEqual(out.map((i) => [i.id, i.x, i.y]), [["a", 0, 0], ["c", 3, 0], ["b", 0, 2]]);
  noOverlap(out);
});

test("a dragged box keeps its place and the others make room", () => {
  const start = compact([box("a", 0, 0), box("b", 0, 2), box("c", 3, 0)]);
  const out = place(start, "b", { x: 0, y: 0 }, L);
  const b = out.find((i) => i.id === "b")!;
  assert.deepEqual([b.x, b.y], [0, 0]);
  assert.equal(out.find((i) => i.id === "a")!.y, 2, "a moved below b");
  noOverlap(out);
});

test("a resize that grows into a neighbour pushes it down", () => {
  const start = compact([box("a", 0, 0), box("b", 3, 0)]);
  const out = compact(place(start, "a", { w: 6 }, L));
  assert.deepEqual(out.map((i) => [i.id, i.x, i.y, i.w]), [["a", 0, 0, 6], ["b", 3, 2, 3]]);
  noOverlap(out);
});

test("added widgets go to the bottom and removed ones leave no hole", () => {
  const start = compact([box("a", 0, 0, 12, 2), box("b", 0, 2, 6, 3)]);
  const added = addItem(start, { id: "c", type: "open_problems", w: 6, h: 2, settings: {} }, L);
  assert.deepEqual(added.find((i) => i.id === "c"), { id: "c", type: "open_problems", x: 6, y: 2, w: 6, h: 2, settings: {} });
  const removed = removeItem(added, "a");
  assert.equal(Math.min(...removed.map((i) => i.y)), 0);
  noOverlap(removed);
});

test("moving one step in reading order swaps neighbours, for the phone and the keyboard", () => {
  const start = compact([box("a", 0, 0, 12, 2), box("b", 0, 2, 12, 2), box("c", 0, 4, 12, 2)]);
  const up = shiftInOrder(start, "c", -1, () => L);
  assert.deepEqual(readingOrder(up).map((i) => i.id), ["a", "c", "b"]);
  const down = shiftInOrder(start, "a", 1, () => L);
  assert.deepEqual(readingOrder(down).map((i) => i.id), ["b", "a", "c"]);
  assert.equal(shiftInOrder(start, "a", -1, () => L), start, "the first cannot go earlier");
});

test("new ids are unique and safe", () => {
  const items = [box("openproblems-1", 0, 0)];
  assert.equal(newWidgetId(items, "open_problems"), "openproblems-2");
  assert.match(newWidgetId([], "spend_trend"), /^[a-z0-9-]+$/);
});
