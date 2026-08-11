/**
 * Statements of account (0413).
 *
 * The arithmetic lives in SQL — `app.partner_statement` and `app.partner_ageing` — so the
 * screen, the PDF and the CSV cannot disagree with each other or with the database. This
 * file is the shape of what comes back plus the two derivations a renderer needs: the
 * running balance down the page, and the closing figure.
 *
 * AutoVault assembles the same document in a 544-line API route and gets it wrong in six
 * places (no opening balance; credits found by regex over free text; payments shown only
 * once an invoice is fully paid, and INVENTED at full value when it is paid with no
 * recorded amount; the invoice debit inflated by its own credit notes and the credit note
 * then listed again; quotes on a statement of account). Every one of those is a
 * consequence of computing a statement in a route from whatever rows happen to be there.
 * Keeping the definition in one SQL function is the fix, not a stylistic preference.
 */

import { t, type Lang } from "@/lib/i18n";

export type StatementKind =
  | "opening" | "invoice" | "credit_note" | "debit_note" | "payment" | "refund" | "write_off";

export type StatementRow = {
  entry_date: string;
  kind: StatementKind;
  reference: string | null;
  /**
   * The row's own detail and nothing else: a document's subject, a payment's method, null
   * where there is none. The SENTENCE is composed here, not in SQL — a statement sent to
   * an Afrikaans farm cannot have half its lines written in English by a Postgres
   * function, and `kind` already says what each row is.
   */
  description: string | null;
  document_id: string | null;
  debit_cents: number;
  credit_cents: number;
  due_date: string | null;
};

export type StatementLine = StatementRow & { balance_cents: number };

export type Ageing = {
  current_cents: number;
  d30_cents: number;
  d60_cents: number;
  d90_cents: number;
  total_cents: number;
};

export const EMPTY_AGEING: Ageing = {
  current_cents: 0, d30_cents: 0, d60_cents: 0, d90_cents: 0, total_cents: 0,
};

/**
 * Run the balance down the page. The rows arrive in date order from SQL, opening balance
 * first, and each line moves the balance by what it is — nothing is re-derived from the
 * documents, which is the whole point.
 */
export function withRunningBalance(rows: readonly StatementRow[]): StatementLine[] {
  let balance = 0;
  return rows.map((r) => {
    balance += (r.debit_cents || 0) - (r.credit_cents || 0);
    return { ...r, balance_cents: balance };
  });
}

/** The closing balance: what the customer owes at the end of the period. */
export function closingBalanceCents(rows: readonly StatementRow[]): number {
  return rows.reduce((b, r) => b + (r.debit_cents || 0) - (r.credit_cents || 0), 0);
}

export function statementTotals(rows: readonly StatementRow[]) {
  const opening = rows.find((r) => r.kind === "opening");
  return {
    openingCents: (opening?.debit_cents ?? 0) - (opening?.credit_cents ?? 0),
    invoicedCents: rows
      .filter((r) => r.kind === "invoice" || r.kind === "debit_note")
      .reduce((s, r) => s + r.debit_cents, 0),
    creditedCents: rows.filter((r) => r.kind === "credit_note").reduce((s, r) => s + r.credit_cents, 0),
    // Refunds are negative payments (0422), so netting them in here keeps "received"
    // meaning money the partner actually kept — and keeps the four subtotals adding up to
    // the closing balance, which is the only way a customer can check the page.
    paidCents: rows
      .filter((r) => r.kind === "payment" || r.kind === "refund")
      .reduce((s, r) => s + r.credit_cents, 0),
    writtenOffCents: rows.filter((r) => r.kind === "write_off").reduce((s, r) => s + r.credit_cents, 0),
    closingCents: closingBalanceCents(rows),
  };
}

/**
 * The sentence a statement line reads as, in the reader's language.
 *
 * SQL returns what the row IS (`kind`) and its own detail (`description`); the wording is
 * assembled here so the screen, the PDF, the CSV and the emailed copy all say the same
 * thing and all say it in Afrikaans when the customer reads Afrikaans.
 */
export function statementLabel(row: Pick<StatementRow, "kind" | "description">, locale: Lang): string {
  const detail = row.description?.trim() || "";
  switch (row.kind) {
    case "opening":
      return t("statement.rowOpening", locale);
    case "payment":
      return detail ? `${t("statement.rowPayment", locale)} (${detail})` : t("statement.rowPayment", locale);
    case "refund":
      return detail ? `${t("statement.rowRefund", locale)} (${detail})` : t("statement.rowRefund", locale);
    case "write_off":
      return t("statement.rowWriteOff", locale);
    case "credit_note":
      return detail || t("statement.rowCreditNote", locale);
    case "debit_note":
      return detail || t("statement.rowDebitNote", locale);
    default:
      return detail || t("statement.rowInvoice", locale);
  }
}

/**
 * The default window: the last 90 days.
 *
 * Not the calendar month, which is the obvious choice and the wrong one — an invoice on
 * 30-day terms issued last month is exactly what the screen exists to chase, and a
 * month-to-date window opens on an empty table for the first days of every month. Ninety
 * days covers the terms a farm workshop actually gives, and the opening balance carries
 * everything older.
 */
export function defaultStatementPeriod(today = new Date()): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 90);
  return { from: iso(from), to: iso(today) };
}

/** i18n key for an ageing bucket. */
export const AGEING_BUCKETS = [
  { key: "current", field: "current_cents" },
  { key: "d30", field: "d30_cents" },
  { key: "d60", field: "d60_cents" },
  { key: "d90", field: "d90_cents" },
] as const satisfies readonly { key: string; field: keyof Ageing }[];
