/**
 * The periods a business actually thinks in, and the shapes the money screen reads.
 *
 * Deliberately NOT the VAT periods. Those are SARS's two-month cycle and belong on the
 * VAT screen; "did last month make money?" is a calendar question, and offering a partner
 * "01 Jun – 31 Jul" when they asked about June would be answering something else.
 * `/money` and `/vat` therefore use different period sets on purpose — the revenue figure
 * agrees between them over any identical window, which is asserted in G14.
 */

export type MoneyPeriod = { key: string; from: string; to: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));

/**
 * Newest first: this month, last month, this quarter, this year, last year.
 *
 * "This month" is deliberately included even though it is incomplete — watching the month
 * build is most of what this screen is for, and the alternative (only closed months) is
 * the dead end the VAT screen had before `currentVatPeriod`.
 */
export function moneyPeriods(today = new Date()): MoneyPeriod[] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const q = Math.floor(m / 3) * 3;

  return [
    { key: "thisMonth", from: iso(monthStart(y, m)), to: iso(monthEnd(y, m)) },
    { key: "lastMonth", from: iso(monthStart(y, m - 1)), to: iso(monthEnd(y, m - 1)) },
    { key: "thisQuarter", from: iso(monthStart(y, q)), to: iso(monthEnd(y, q + 2)) },
    { key: "thisYear", from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))) },
    { key: "lastYear", from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y - 1, 11, 31))) },
  ];
}

export type Pl = {
  revenue_ex_cents: number;
  bad_debt_ex_cents: number;
  expenses_ex_cents: number;
  blocked_vat_cents: number;
  cost_cents: number;
  profit_cents: number;
};

export const EMPTY_PL: Pl = {
  revenue_ex_cents: 0, bad_debt_ex_cents: 0, expenses_ex_cents: 0,
  blocked_vat_cents: 0, cost_cents: 0, profit_cents: 0,
};

export type Debtor = {
  party_label: string; farm_id: string | null; client_id: string | null;
  current_cents: number; d30_cents: number; d60_cents: number; d90_cents: number; total_cents: number;
};

export type Creditor = {
  supplier: string;
  current_cents: number; d30_cents: number; d60_cents: number; d90_cents: number; total_cents: number;
};

export type Cash = { in_cents: number; out_cents: number; net_cents: number };

/** Sum a column across an ageing table, so the screen and its total cannot disagree. */
export function ageingTotal<T extends Record<string, unknown>>(rows: readonly T[], key: keyof T): number {
  return rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
}

/**
 * How much of what I am owed is genuinely late.
 *
 * "Total owed" on its own is a number a business can live with for months. The 60-plus
 * bucket is the one that decides whether to phone somebody, so it is worth naming
 * separately rather than leaving to be read off a table.
 */
export function seriouslyOverdue(rows: readonly Debtor[]): number {
  return rows.reduce((s, r) => s + Number(r.d60_cents ?? 0) + Number(r.d90_cents ?? 0), 0);
}
