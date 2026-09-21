/**
 * How the asset register reads, as distinct from what it computes.
 *
 * The sum lives in SQL and stays there (`app.book_value_cents`), because its inputs are
 * withheld from the browser. What is testable on this side is the totalling and the one
 * line that describes a policy, and that line is built from i18n KEYS, which is the shape
 * that has already put raw dotted paths in front of users twice in this codebase.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import { policyLabel, registerTotals } from "./depreciation-view";
import type { BookValueRow } from "./depreciation";

function row(over: Partial<BookValueRow> = {}): BookValueRow {
  return {
    machine_id: "m1",
    name: "Tractor",
    reg_no: null,
    type: "tractor",
    status: "active",
    purchase_date: "2020-01-01",
    purchase_price_cents: 100000000,
    method: "straight_line",
    rate_bps: null,
    life_months: 120,
    residual_value_cents: 10000000,
    start_date: "2020-01-01",
    months_held: 60,
    book_value_cents: 55000000,
    depreciated_cents: 45000000,
    ...over,
  };
}

test("the totals add up to what the fleet cost", () => {
  const rows = [
    row(),
    row({ machine_id: "m2", purchase_price_cents: 50000000, book_value_cents: 32000000, depreciated_cents: 18000000 }),
  ];
  const totals = registerTotals(rows);
  assert.equal(totals.cost, 150000000);
  assert.equal(totals.book, 87000000);
  assert.equal(totals.depreciated, 63000000);
  // The register is an accounting document. Two columns that do not reconcile to the
  // third is the first thing an accountant checks and the last time they use it.
  assert.equal(totals.book + totals.depreciated, totals.cost);
});

test("a machine with a price and no policy is counted, because it inflates the total", () => {
  // Carried at cost, so the "worth today" figure is higher than it should be. The count
  // is what lets the page say so instead of leaving it to be noticed.
  const rows = [
    row({ machine_id: "undecided", method: "none", book_value_cents: 100000000, depreciated_cents: 0 }),
  ];
  assert.equal(registerTotals(rows).undecided, 1);

  // A machine with no purchase price at all is NOT on that list: there is nothing to
  // depreciate, so asking the farm to choose a policy for it would be noise.
  const noPrice = [
    row({ machine_id: "free", method: "none", purchase_price_cents: null, book_value_cents: null, depreciated_cents: null }),
  ];
  assert.equal(registerTotals(noPrice).undecided, 0);
  assert.equal(registerTotals(noPrice).cost, 0);
});

test("a policy reads the way a farm says it, in both languages", () => {
  // Years when it divides evenly, "10 years" is how a policy is written down, "120
  // months" is how a database stores it.
  assert.deepEqual(policyLabel({ method: "straight_line", rate_bps: null, life_months: 120 }), {
    key: "depreciation.policyStraightYears",
    vars: { n: "10" },
  });
  // And months when it does not, rather than "0,58 years".
  assert.deepEqual(policyLabel({ method: "straight_line", rate_bps: null, life_months: 7 }), {
    key: "depreciation.policyStraightMonths",
    vars: { n: "7" },
  });
  // Basis points in, percent out: the farm said 20%, the engine stored 2000.
  assert.deepEqual(policyLabel({ method: "reducing_balance", rate_bps: 2000, life_months: null }), {
    key: "depreciation.policyReducing",
    vars: { rate: "20" },
  });
  assert.equal(policyLabel({ method: "none", rate_bps: null, life_months: null }).key, "depreciation.policyNone");

  // Every key it can return exists in both languages, and every placeholder it promises is
  // actually in the string. `t()` returns the key on a miss, and a register printed for an
  // accountant with "depreciation.policyReducing" in a column is the failure this catches.
  for (const lang of ["en", "af"] as const) {
    for (const p of [
      policyLabel({ method: "straight_line", rate_bps: null, life_months: 120 }),
      policyLabel({ method: "straight_line", rate_bps: null, life_months: 7 }),
      policyLabel({ method: "reducing_balance", rate_bps: 2000, life_months: null }),
      policyLabel({ method: "none", rate_bps: null, life_months: null }),
    ]) {
      const s = t(p.key, lang);
      assert.notEqual(s, p.key, `${p.key} renders its own key in ${lang}`);
      for (const name of Object.keys(p.vars)) {
        assert.ok(s.includes(`{${name}}`), `${p.key} has no {${name}} to fill in ${lang}`);
      }
    }
  }
});
