/**
 * Supplier statements and remittance advice (G25, migration 0502).
 *
 * The purchase-side mirror of `src/lib/statement.ts`. The arithmetic lives in SQL —
 * `app.supplier_statement`, `app.supplier_ageing`, `app.supplier_remittance` — so the
 * screen, the PDF, the CSV and anything emailed later cannot disagree with each other or
 * with the database. This file is the shape of what comes back, the two derivations a
 * renderer needs (the running balance and the closing figure), and the WORDING.
 *
 * ── Why the wording is here and not in Postgres ──────────────────────────────
 *
 * `statement.ts` sets the rule and gives the reason: a statement read by an Afrikaans
 * partner must not have half its lines written in English by a Postgres function. So SQL
 * returns what a row IS (`kind`) plus the row's OWN detail (`description` — the supplier's
 * note, or null) and never a sentence; `supplierStatementLabel` composes the sentence in
 * the reader's language.
 *
 * ── Why it does not simply reuse statement.ts ────────────────────────────────
 *
 * The vocabularies genuinely differ, and collapsing them would hide the difference that
 * matters. A customer statement has invoices, credit notes, debit notes, part-payments,
 * refunds and write-offs; a supplier statement has bills and settlements, and a settlement
 * is ALL-OR-NOTHING because `partner_expenses.paid_on` (0430) is a single date with no
 * amount beside it. Sharing a `kind` union would let a renderer ask for a refund row that
 * can never exist, and would quietly imply the purchase side can record a part-payment.
 * The six lines of running-balance arithmetic are duplicated on purpose.
 *
 * ── Money is GROSS ──────────────────────────────────────────────────────────
 *
 * `amount_cents` is ex-VAT and `vat_cents` is the supplier's own VAT line. Every debit,
 * credit and bucket below is the sum, because that is what leaves the bank and what
 * `app.partner_creditors` already ages on /money. The two halves are split out again on
 * the REMITTANCE, where the supplier is reconciling against their own tax invoice.
 */

import { t, type Lang } from "@/lib/i18n";

/** An opening balance, a bill from the supplier, or a bill of theirs we settled. */
export type SupplierStatementKind = "opening" | "bill" | "payment";

export type SupplierStatementRow = {
  entry_date: string;
  kind: SupplierStatementKind;
  /** The SUPPLIER's own invoice number — the only thing identifying what a payment settled. */
  reference: string | null;
  /** The row's own detail and nothing else; null where there is none. */
  description: string | null;
  category: string | null;
  expense_id: string | null;
  debit_cents: number;
  credit_cents: number;
  /**
   * DERIVED, not recorded: `expense_date` plus this supplier's filed terms, falling back to
   * 30 days — the same rule 0491 gave the cash-flow forecast, so the two screens cannot name
   * different dates for the same bill. A supplier invoice carries no due date, and the
   * screen says as much rather than implying the supplier told us.
   */
  due_date: string | null;
};

export type SupplierStatementLine = SupplierStatementRow & { balance_cents: number };

export type SupplierAgeing = {
  current_cents: number;
  d30_cents: number;
  d60_cents: number;
  d90_cents: number;
  total_cents: number;
};

export const EMPTY_SUPPLIER_AGEING: SupplierAgeing = {
  current_cents: 0, d30_cents: 0, d60_cents: 0, d90_cents: 0, total_cents: 0,
};

/** One bill covered by a payment, for the remittance advice. */
export type RemittanceRow = {
  expense_id: string;
  expense_date: string;
  reference: string | null;
  description: string | null;
  category: string | null;
  amount_cents: number;
  vat_cents: number;
  total_cents: number;
};

/**
 * Run the balance down the page. Rows arrive in date order from SQL with the opening
 * balance first (0502 orders by an explicit rank, not by the kind's spelling), and each
 * line moves the balance by what it is — nothing is re-derived from the bills, which is the
 * whole point of reading the ledger rather than reconstructing it.
 */
export function withSupplierRunningBalance(rows: readonly SupplierStatementRow[]): SupplierStatementLine[] {
  let balance = 0;
  return rows.map((r) => {
    balance += (r.debit_cents || 0) - (r.credit_cents || 0);
    return { ...r, balance_cents: balance };
  });
}

/** The closing balance: what is still owed to this supplier at the end of the period. */
export function supplierClosingBalanceCents(rows: readonly SupplierStatementRow[]): number {
  return rows.reduce((b, r) => b + (r.debit_cents || 0) - (r.credit_cents || 0), 0);
}

export function supplierStatementTotals(rows: readonly SupplierStatementRow[]) {
  const opening = rows.find((r) => r.kind === "opening");
  return {
    openingCents: (opening?.debit_cents ?? 0) - (opening?.credit_cents ?? 0),
    billedCents: rows.filter((r) => r.kind === "bill").reduce((s, r) => s + r.debit_cents, 0),
    paidCents: rows.filter((r) => r.kind === "payment").reduce((s, r) => s + r.credit_cents, 0),
    closingCents: supplierClosingBalanceCents(rows),
  };
}

/**
 * The sentence a statement line reads as, in the reader's language.
 *
 * SQL returns what the row IS and its own detail; the wording is assembled here so the
 * screen, the PDF, the CSV and any emailed copy all say the same thing and all say it in
 * Afrikaans when the partner reads Afrikaans.
 */
export function supplierStatementLabel(
  row: Pick<SupplierStatementRow, "kind" | "description">,
  locale: Lang,
): string {
  const detail = row.description?.trim() || "";
  switch (row.kind) {
    case "opening":
      return t("supplierStatement.rowOpening", locale);
    case "payment":
      return t("supplierStatement.rowPayment", locale);
    default:
      return detail || t("supplierStatement.rowBill", locale);
  }
}

export const SUPPLIER_AGEING_BUCKETS = [
  { key: "current", field: "current_cents" },
  { key: "d30", field: "d30_cents" },
  { key: "d60", field: "d60_cents" },
  { key: "d90", field: "d90_cents" },
] as const satisfies readonly { key: string; field: keyof SupplierAgeing }[];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export type SupplierPeriod = { key: string; from: string; to: string };

/**
 * The windows on offer.
 *
 * `days90` is the default, for the same reason the customer statement defaults to it: a
 * supplier invoice on 30- or 60-day terms is exactly what the screen is opened to settle,
 * and a month-to-date window opens on an empty table for the first days of every month.
 * `thisYear` is here because "what did I buy from this business this year" is the question
 * a supplier asks when they ring — and the opening balance carries everything older
 * whichever window is chosen, so no window can lie about what is owed.
 */
export function supplierStatementPeriods(today = new Date()): SupplierPeriod[] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  const days90 = new Date(today);
  days90.setUTCDate(days90.getUTCDate() - 90);

  const monthStart = new Date(Date.UTC(y, m, 1));
  const lastMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(y, m, 0));

  return [
    { key: "days90", from: iso(days90), to: iso(today) },
    { key: "thisMonth", from: iso(monthStart), to: iso(today) },
    { key: "lastMonth", from: iso(lastMonthStart), to: iso(lastMonthEnd) },
    { key: "thisYear", from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(today) },
  ];
}

/** The default window: the last 90 days. */
export function defaultSupplierPeriod(today = new Date()): { from: string; to: string } {
  const [first] = supplierStatementPeriods(today);
  return { from: first.from, to: first.to };
}

/** A date the caller supplied, or null. Guards every date that reaches SQL or a URL. */
export function isoDateOrNull(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Is this even a uuid?
 *
 * Not a security check — RLS is that, and a well-formed id belonging to another workshop is
 * refused by it. This is so a mistyped URL comes back as "no such supplier" instead of a
 * Postgres cast error surfacing as an empty download.
 */
export function isUuid(value: string | null | undefined): boolean {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The dates on which this supplier's bills were actually settled, newest first.
 *
 * A remittance is keyed on the day the money left, so these are the only dates for which
 * one can exist — offering a free date picker alone would let a partner ask for an advice
 * covering nothing and read the empty result as a failure. Derived from the statement's own
 * payment lines so the choices cannot include a date the statement does not show.
 */
export function supplierPaymentDates(rows: readonly SupplierStatementRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.kind === "payment") seen.add(r.entry_date);
  return [...seen].sort((a, b) => b.localeCompare(a));
}

/**
 * What a remittance advice adds up to.
 *
 * Ex-VAT and VAT stay separate here, unlike the statement: the supplier is tying each line
 * back to their own tax invoice, which shows both, and handing them one gross figure makes
 * them do the arithmetic backwards.
 */
export function remittanceTotals(rows: readonly RemittanceRow[]) {
  return {
    bills: rows.length,
    exCents: rows.reduce((s, r) => s + r.amount_cents, 0),
    vatCents: rows.reduce((s, r) => s + r.vat_cents, 0),
    totalCents: rows.reduce((s, r) => s + r.total_cents, 0),
  };
}
