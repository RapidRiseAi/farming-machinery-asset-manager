/**
 * The shapes the cash-flow screen reads, and the two small pieces of arithmetic that are
 * genuinely the screen's own.
 *
 * Everything that counts money lives in SQL (0486) for the reason recorded there: a
 * screen, a CSV, a PDF and an emailed copy must not be able to disagree, and a figure
 * computed in a React component exists in one place only until somebody adds an export.
 * What is left here is the reader's own opening balance — a number they type, which the
 * database has no business knowing — and the derived question that makes the forecast
 * worth opening: which bucket is the one where the account goes under.
 */

import type { Lang } from "@/lib/i18n";
import { parseRandsToCents } from "@/lib/money";

/** One row per bucket, in the order money arrives at them. Mirrors `app.partner_cashflow`. */
export type CashflowBucket = {
  bucket: string;
  ordinal: number;
  /** null for `overdue` — it has no start. */
  from_date: string | null;
  /** null for `later` — it has no end. */
  to_date: string | null;
  in_cents: number;
  out_cents: number;
  net_cents: number;
  /** Cumulative movement from zero. NOT a bank balance — see `balanceAfter`. */
  running_cents: number;
  item_count: number;
};

/** One expected movement. Mirrors `app.partner_cashflow_items`. */
export type CashflowMovement = {
  bucket: string;
  ordinal: number;
  direction: "in" | "out";
  source: "invoice" | "recurring" | "expense" | "purchase_order";
  ref: string;
  party: string;
  expected_date: string;
  days_late: number;
  /** GROSS, always: what actually moves through the bank. */
  amount_cents: number;
  source_id: string;
};

/** The five buckets, in order. Named here so the screen never has to sort by ordinal. */
export const CASH_BUCKETS = ["overdue", "this_week", "next_week", "this_month", "later"] as const;
export type CashBucketKey = (typeof CASH_BUCKETS)[number];

/**
 * Five empty buckets, so a farm with nothing forecast still gets a readable table rather
 * than an absence. The SQL returns all five too; this is the fallback for the case where
 * the call itself came back with nothing.
 */
export const EMPTY_BUCKETS: CashflowBucket[] = CASH_BUCKETS.map((bucket, i) => ({
  bucket,
  ordinal: i + 1,
  from_date: null,
  to_date: null,
  in_cents: 0,
  out_cents: 0,
  net_cents: 0,
  running_cents: 0,
  item_count: 0,
}));

/**
 * How far ahead to look.
 *
 * Six weeks is the default rather than a month, because the question this screen exists
 * for — can I pay wages at the end of the month — is answered wrongly by a window that
 * stops on the 30th: the salary run and the supplier account that lands the day after are
 * the same problem, and a month-long horizon shows only one of them.
 */
export const CASH_HORIZONS = [14, 42, 90, 180] as const;
export const DEFAULT_HORIZON = 42;

export function horizonDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return (CASH_HORIZONS as readonly number[]).includes(n) ? n : DEFAULT_HORIZON;
}

/**
 * The supplier term assumed by the forecast, restated from 0486 so the screen can say the
 * number out loud instead of describing it vaguely.
 *
 * `partner_expenses` carries no due date — only the supplier's own invoice date — so the
 * forecast has to assume one, and an assumption a reader cannot see is one they cannot
 * correct for. If this ever moves it moves in the migration first; this constant exists to
 * be shown, never to compute with.
 */
export const SUPPLIER_TERMS_DAYS = 30;

/**
 * Today's bank balance, as the reader typed it.
 *
 * Deliberately not stored and deliberately not guessed: `bank_statement_lines` (0470) is
 * an import queue, not an authoritative balance, and a forecast that invented one would be
 * believed. Blank is a perfectly good answer — the forecast is still readable as a change,
 * it just cannot name the week the money runs out.
 */
export function parseOpening(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  return parseRandsToCents(raw);
}

/**
 * The balance at the END of each bucket: the opening balance plus the movement so far.
 *
 * This is the whole point of the running total. `running_cents` alone answers "how much
 * better or worse off am I by then", which nobody asks; adding what is in the account
 * answers "is there anything left", which is the question.
 */
export function balanceAfter(rows: readonly CashflowBucket[], openingCents: number): number[] {
  return rows.map((r) => openingCents + r.running_cents);
}

/**
 * The first bucket whose closing balance is below zero — the week the money runs out.
 *
 * Returns null when the reader has not said what is in the account (there is nothing to go
 * below) or when the account never goes under, which is the answer they were hoping for.
 */
export function runsOutAt(
  rows: readonly CashflowBucket[],
  openingCents: number | null
): CashflowBucket | null {
  if (openingCents == null) return null;
  return rows.find((r) => openingCents + r.running_cents < 0) ?? null;
}

/** Totals across the whole window, so the header and the table cannot disagree. */
export function cashflowTotals(rows: readonly CashflowBucket[]): {
  in_cents: number;
  out_cents: number;
  net_cents: number;
  item_count: number;
} {
  return rows.reduce(
    (acc, r) => ({
      in_cents: acc.in_cents + Number(r.in_cents ?? 0),
      out_cents: acc.out_cents + Number(r.out_cents ?? 0),
      net_cents: acc.net_cents + Number(r.net_cents ?? 0),
      item_count: acc.item_count + Number(r.item_count ?? 0),
    }),
    { in_cents: 0, out_cents: 0, net_cents: 0, item_count: 0 }
  );
}

/** Group the movements by bucket once, so each bucket's card does not re-scan the list. */
export function movementsByBucket(
  items: readonly CashflowMovement[]
): Map<string, CashflowMovement[]> {
  const map = new Map<string, CashflowMovement[]>();
  for (const key of CASH_BUCKETS) map.set(key, []);
  for (const m of items) {
    const list = map.get(m.bucket);
    if (list) list.push(m);
    else map.set(m.bucket, [m]);
  }
  return map;
}

/**
 * "40 days late" in words, or nothing at all when it is not late.
 *
 * Kept next to the type rather than in the component because the same sentence belongs on
 * a CSV row and in a reminder email the day either is built.
 */
export function latenessLabel(
  days: number,
  locale: Lang,
  t: (key: string, lang: Lang) => string
): string | null {
  if (!days || days <= 0) return null;
  return t("cash.daysLate", locale).replace("{days}", String(days));
}
