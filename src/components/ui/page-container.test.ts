import assert from "node:assert/strict";
import test from "node:test";
import { groupCards } from "./page-header";

// true = a card (may share the column flow), false = reads across the page.
test("runs of cards share the column flow; a lone card and everything else stand alone", () => {
  assert.deepEqual(groupCards([false, true, true, false]), [0, [1, 2], 3]);
  assert.deepEqual(groupCards([false, true, false]), [0, 1, 2], "a lone card is not wrapped");
  assert.deepEqual(groupCards([true, true, true]), [[0, 1, 2]], "three cards balance in two columns");
  assert.deepEqual(groupCards([true, false, true, true]), [0, 1, [2, 3]]);
  assert.deepEqual(groupCards([]), []);
});
