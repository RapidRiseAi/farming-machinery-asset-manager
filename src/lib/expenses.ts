/**
 * The purchase side (G6, migration 0430) and the VAT return built on it (0431).
 *
 * The shared model both the capture screen and the VAT screen read, so a figure typed in
 * one place cannot be interpreted differently in the other. Money is integer cents,
 * ex-VAT, exactly as everywhere else — the one departure is that an expense carries the
 * supplier's OWN VAT amount rather than a derived one, because a supplier invoice is a
 * source document and its VAT line is what may legally be claimed.
 */

export const EXPENSE_CATEGORIES = [
  "parts", "subcontract", "fuel", "vehicle", "tools", "rent",
  "salaries", "insurance", "admin", "marketing", "bank_fees", "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type Expense = {
  id: string;
  workshop_id: string;
  supplier_name: string;
  supplier_vat_number: string | null;
  reference: string | null;
  category: ExpenseCategory;
  description: string | null;
  expense_date: string;
  paid_on: string | null;
  amount_cents: number;
  vat_rate_bps: number;
  vat_cents: number;
  vat_claimable: boolean;
  receipt_path: string | null;
};

/** What the partner actually handed over: ex-VAT plus the VAT on the supplier's invoice. */
export function expenseTotalCents(e: Pick<Expense, "amount_cents" | "vat_cents">): number {
  return e.amount_cents + e.vat_cents;
}

/**
 * Split a VAT-INCLUSIVE amount the way the receipt does.
 *
 * A partner reads "R1 150,00" off a till slip; the books need R1 000 and R150. Integer
 * arithmetic throughout — `exVatCents` rounds to the nearest cent and the VAT is the
 * remainder, so the two always add back to exactly what was typed.
 */
export function splitInclusive(inclCents: number, rateBps: number): { exCents: number; vatCents: number } {
  if (rateBps <= 0) return { exCents: inclCents, vatCents: 0 };
  const exCents = Math.round((inclCents * 10000) / (10000 + rateBps));
  return { exCents, vatCents: inclCents - exCents };
}

// ── The VAT return ─────────────────────────────────────────────────

export type VatReturn = {
  standard_ex_cents: number;
  standard_vat_cents: number;
  zero_rated_cents: number;
  credits_ex_cents: number;
  output_vat_cents: number;
  input_ex_cents: number;
  input_vat_cents: number;
  blocked_vat_cents: number;
  net_vat_cents: number;
  written_off_ex_cents: number;
  written_off_vat_cents: number;
};

export const EMPTY_VAT_RETURN: VatReturn = {
  standard_ex_cents: 0, standard_vat_cents: 0, zero_rated_cents: 0, credits_ex_cents: 0,
  output_vat_cents: 0, input_ex_cents: 0, input_vat_cents: 0, blocked_vat_cents: 0,
  net_vat_cents: 0, written_off_ex_cents: 0, written_off_vat_cents: 0,
};

/**
 * SARS runs most vendors on a TWO-MONTH cycle, and which two months depends on the
 * category the vendor was registered under: category A ends on odd months (Jan, Mar, …),
 * category B on even ones (Feb, Apr, …). Getting the window right matters more than it
 * looks — a return built over the wrong two months is not slightly wrong, it double-counts
 * one month and omits another.
 *
 * So the screen offers the real periods rather than a free date range, and defaults to
 * the one that has just closed (the one about to be filed). A custom range stays
 * available for anyone on category C (monthly) or F (six-monthly).
 */
export type VatCategory = "A" | "B" | "monthly";

export type VatPeriod = { from: string; to: string; label: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthEnd = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0));

/** The `count` most recent closed periods for this category, newest first. */
export function vatPeriods(category: VatCategory, today = new Date(), count = 8): VatPeriod[] {
  const out: VatPeriod[] = [];
  if (category === "monthly") {
    for (let i = 1; i <= count; i++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      out.push({
        from: iso(d),
        to: iso(monthEnd(d.getUTCFullYear(), d.getUTCMonth())),
        label: d.toISOString().slice(0, 7),
      });
    }
    return out;
  }

  // Category A closes on ODD months (Jan=0 → month index 0, 2, 4 …); B on even ones.
  const wantsOddMonth = category === "A";
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  while (out.length < count) {
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    const isOdd = cursor.getUTCMonth() % 2 === 0; // Jan is index 0 and is an odd month
    if (isOdd !== wantsOddMonth) continue;
    const start = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    const end = monthEnd(cursor.getUTCFullYear(), cursor.getUTCMonth());
    out.push({ from: iso(start), to: iso(end), label: `${iso(start).slice(0, 7)} – ${iso(end).slice(0, 7)}` });
  }
  return out;
}

/** Positive means money owed to SARS; negative means a refund is due. */
export function vatIsPayable(r: Pick<VatReturn, "net_vat_cents">): boolean {
  return r.net_vat_cents >= 0;
}
