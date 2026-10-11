import assert from "node:assert/strict";
import test from "node:test";
import { calculateAll, evaluate } from "./calc";

test("arithmetic is exact and follows the usual order", () => {
  assert.equal(evaluate("49691 / 2242"), 22.163693);
  assert.equal(evaluate("2 + 3 * 4"), 14);
  assert.equal(evaluate("(2 + 3) * 4"), 20);
  assert.equal(evaluate("2 ^ 3 ^ 2"), 512);
  assert.equal(evaluate("-4 + -(-2)"), -2);
  assert.equal(evaluate("0.1 + 0.2"), 0.3);
  assert.equal(evaluate("1.5e3 / 3"), 500);
});

test("the farm's functions: totals, averages, shares and changes", () => {
  assert.equal(evaluate("sum(308, 312, 351)"), 971);
  assert.equal(evaluate("avg(50615.40, 49691, 7862.40)"), 36056.266667);
  assert.equal(evaluate("round(avg(50615.40, 49691), 2)"), 50153.2);
  assert.equal(evaluate("min(4, 2, 9) + max(4, 2, 9)"), 11);
  assert.equal(evaluate("pct(31754.60, 34804.60)"), 91.236791);
  assert.equal(evaluate("round(change(308, 312), 1)"), 1.3);
  assert.equal(evaluate("sqrt(81) + abs(-1)"), 10);
});

test("anything outside the grammar is refused with a reason, never run", () => {
  assert.throws(() => evaluate("process.exit(1)"), /not allowed|not a function|not a number/);
  assert.throws(() => evaluate("10 / 0"), /division by zero/);
  assert.throws(() => evaluate("pct(5, 0)"), /zero/);
  assert.throws(() => evaluate("sum(1, 2"), /not closed/);
  assert.throws(() => evaluate("2 +"), /ends too early/);
  assert.throws(() => evaluate("1.2.3"), /not a number/);
  assert.throws(() => evaluate("R 500 + 2"), /not a function|out of place/);
  assert.throws(() => evaluate(""), /empty/);
});

test("several labelled calculations come back together, a bad one not spoiling the rest", () => {
  const results = calculateAll([
    { label: "rand per litre", expression: "49691 / 2242" },
    { label: "broken", expression: "5 / 0" },
  ]);
  assert.equal(results[0].result, 22.163693);
  assert.equal(results[1].result, undefined);
  assert.match(String(results[1].error), /division by zero/);
});
