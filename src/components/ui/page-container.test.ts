import assert from "node:assert/strict";
import test from "node:test";
import { pairRuns } from "./page-header";

// true = spans the row, false = a card that may share a row.
test("cards pair off; a card with nothing beside it spans the row", () => {
  assert.deepEqual(pairRuns([true, false, false, true]), [true, false, false, true], "a pair stays a pair");
  assert.deepEqual(pairRuns([true, false, true]), [true, true, true], "a lone card spans (/accounting)");
  assert.deepEqual(pairRuns([false, false, false]), [false, false, true], "of three, the last spans");
  assert.deepEqual(pairRuns([false, true, false, false]), [true, true, false, false], "runs are counted separately");
  assert.deepEqual(pairRuns([]), []);
});
