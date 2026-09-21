/**
 * The asset register as the screen reads it: pure, and therefore tested.
 *
 * Separate from `depreciation.ts` only because that module is `server-only` — it holds the
 * RPC call — and a `node:test` process cannot import one. The SUM itself is deliberately
 * not here: its inputs (purchase price, rate, residual) are withheld from the browser at
 * the column level, so there is nothing on this side to mirror and `farm_book_values`
 * stays the single authority.
 */

import type { BookValueRow } from "./depreciation";

/** What the whole register is worth, and what has been written off, in cents. */
export function registerTotals(rows: readonly BookValueRow[]): {
  cost: number;
  book: number;
  depreciated: number;
  /** Machines with a purchase price but no policy — the register's own to-do list. */
  undecided: number;
} {
  let cost = 0;
  let book = 0;
  let depreciated = 0;
  let undecided = 0;
  for (const r of rows) {
    cost += r.purchase_price_cents ?? 0;
    book += r.book_value_cents ?? 0;
    depreciated += r.depreciated_cents ?? 0;
    if (r.method === "none" && (r.purchase_price_cents ?? 0) > 0) undecided += 1;
  }
  return { cost, book, depreciated, undecided };
}

/**
 * How a policy reads in one line: "20% reducing balance", "10 years straight line".
 *
 * Returns the i18n key and its substitutions rather than a sentence, so the page keeps
 * every string in the dictionaries and Afrikaans is a translation rather than a rewrite.
 */
export function policyLabel(row: Pick<BookValueRow, "method" | "rate_bps" | "life_months">): {
  key: string;
  vars: Record<string, string>;
} {
  if (row.method === "reducing_balance") {
    return {
      key: "depreciation.policyReducing",
      vars: { rate: String((row.rate_bps ?? 0) / 100) },
    };
  }
  if (row.method === "straight_line") {
    const months = row.life_months ?? 0;
    // Years when it divides evenly, because "10 years" is how a farm says it and
    // "120 months" is how a database does.
    return months % 12 === 0
      ? { key: "depreciation.policyStraightYears", vars: { n: String(months / 12) } }
      : { key: "depreciation.policyStraightMonths", vars: { n: String(months) } };
  }
  return { key: "depreciation.policyNone", vars: {} };
}
