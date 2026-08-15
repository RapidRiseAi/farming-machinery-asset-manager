/**
 * Standing costs (G19, migration 0483).
 *
 * The shared model the list, the detail screen, the form and the actions all read — the
 * cost-side mirror of `recurring.ts`. Everything about WHEN a schedule fires is imported
 * from that file rather than restated here: one cadence arithmetic, used by both sides
 * and by `app.advance_by_cadence`, is the only way a screen showing "next on 28 February"
 * can be trusted not to disagree with the date the generator will actually use.
 */

import { CADENCES, advanceByCadence, isDue as invoiceIsDue, isLive as invoiceIsLive, type Cadence } from "./recurring";
import type { ExpenseCategory } from "./expenses";

export { CADENCES, advanceByCadence };
export type { Cadence };

export type ExpenseSchedule = {
  id: string;
  workshop_id: string;
  name: string;
  supplier_name: string;
  supplier_vat_number: string | null;
  reference: string | null;
  description: string | null;
  category: ExpenseCategory;
  amount_cents: number;
  vat_rate_bps: number;
  vat_cents: number;
  vat_claimable: boolean;
  cadence: Cadence;
  next_due_date: string;
  ends_on: string | null;
  last_period_start: string | null;
  last_expense_id: string | null;
  auto_paid: boolean;
  active: boolean;
};

/**
 * The two date questions, answered by `recurring.ts` rather than answered again.
 *
 * The only difference between a standing invoice and a standing cost here is the name of
 * the date column, so these adapt the field and hand the question straight on. A second
 * copy of "is it live, is it due" would be a second thing to keep in step with
 * `app.generate_recurring_expenses`, and the first time they drifted a partner would see
 * a schedule the cron does not agree is due.
 */
type Timing = Pick<ExpenseSchedule, "active" | "ends_on" | "next_due_date">;

const asInvoiceTiming = (s: Timing) => ({
  active: s.active,
  ends_on: s.ends_on,
  next_issue_date: s.next_due_date,
});

/** Is this schedule going to capture anything ever again? */
export function isLive(s: Timing): boolean {
  return invoiceIsLive(asInvoiceTiming(s));
}

/** Due now — tonight's run would capture it. */
export function isDue(s: Timing, today = new Date()): boolean {
  return invoiceIsDue(asInvoiceTiming(s), today);
}

/**
 * What actually leaves the bank each time: the ex-VAT amount plus the VAT on the
 * supplier's own invoice.
 *
 * Deliberately `amount + vat` rather than `amount × rate`, matching `expenseTotalCents`:
 * a standing bill has a printed VAT line, and 0430's whole reason for storing the VAT
 * figure separately is that the printed one — not a recomputed one — is what may be
 * claimed.
 */
export function scheduleTotalCents(s: Pick<ExpenseSchedule, "amount_cents" | "vat_cents">): number {
  return s.amount_cents + s.vat_cents;
}

/**
 * What a year of this schedule comes to, ex-VAT.
 *
 * Worth showing next to a monthly figure because R4 500 a month and R54 000 a year are
 * the same commitment read two different ways, and only one of them makes a partner stop
 * and check the amount is still right.
 */
export function annualisedExCents(s: Pick<ExpenseSchedule, "amount_cents" | "cadence">): number {
  const perYear = s.cadence === "weekly" ? 52 : s.cadence === "monthly" ? 12 : s.cadence === "quarterly" ? 4 : 1;
  return s.amount_cents * perYear;
}

/**
 * Turn the short codes the server actions redirect with into something a person can read.
 *
 * The actions redirect with `?error=need-supplier` and also, when Postgres refuses a
 * write, with the raw database message. Both arrive in the same query parameter, so this
 * translates the ones we put there and passes anything else through unchanged rather than
 * swallowing a real error into a generic apology.
 */
export const SCHEDULE_ERROR_KEYS: Record<string, string> = {
  "need-name": "recexp.errNeedName",
  "need-supplier": "recexp.errNeedSupplier",
  "need-amount": "recexp.errNeedAmount",
  "not-found": "recexp.errNotFound",
};
