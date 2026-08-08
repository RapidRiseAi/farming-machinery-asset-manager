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

export type StatementKind = "opening" | "invoice" | "credit_note" | "debit_note" | "payment";

export type StatementRow = {
  entry_date: string;
  kind: StatementKind;
  reference: string | null;
  description: string;
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
    paidCents: rows.filter((r) => r.kind === "payment").reduce((s, r) => s + r.credit_cents, 0),
    closingCents: closingBalanceCents(rows),
  };
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
