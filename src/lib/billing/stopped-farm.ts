/**
 * The Pay button on the stopped-farm pages, `/activate` and `/suspended`, decided in one
 * place so the two say the same thing about the same money.
 *
 * Both pages start the same hosted checkout (`beginCheckout`), and it charges ONE invoice:
 * `openInvoiceForFarm`'s oldest owed one, for its total less what is already paid. So a
 * page must show that amount next to the button, and must not offer the button at all
 * while money is already moving on that invoice.
 *
 * Everything here reads with the SERVICE client, after the page has established that the
 * person may pay (owner or manager on that farm). RLS on the billing tables is
 * `app.is_farm_billing_admin`, which is owner and Rapid Rise only (20260903160000), so a
 * manager, whom both checkout actions admit, read nothing through their own session and
 * was offered a bare Pay button with no amount (review finding app-9).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { must, soft } from "@/lib/supabase/must";
import { addDays } from "./policy";
import { STALE_PENDING_MINUTES } from "./worker";

/** Money already moving on the invoice the Pay button would charge. */
export type Settling = "received" | "inflight";

export type SettlingAttempt = { status: string; requested_at: string };

/**
 * What the latest pending-or-succeeded attempt on the invoice means for the page.
 *
 * A `pending` attempt older than the reconciler's own staleness window is not somebody at
 * a payment page; it is a checkout that was abandoned and will be swept. Showing "waiting
 * for your bank" for ever would strand them with no way to try again, so the same 30
 * minutes the worker uses decides it here. One definition, not two.
 */
export function settlingFrom(attempt: SettlingAttempt | null, nowMs: number): Settling | null {
  if (!attempt) return null;
  if (attempt.status === "succeeded") return "received";
  const ageMinutes = (nowMs - new Date(attempt.requested_at).getTime()) / 60000;
  return attempt.status === "pending" && ageMinutes < STALE_PENDING_MINUTES ? "inflight" : null;
}

/**
 * Has this person ALREADY paid this invoice, seconds ago?
 *
 * The Paystack callback sends them to `/billing?checkout=paid`, inside `(app)`, whose
 * layout runs the gate, and the gate keeps answering `pending` or `suspended` until the
 * webhook settles the attempt. So they bounce back to the stopped page, and somebody who
 * had just handed over a card was shown the Pay button again; pressing it was refused by
 * the in-flight index with "a payment on this bill is already in progress", an alarming
 * sentence at the worst moment. The state is read from the LEDGER rather than a query
 * parameter, so it holds however they arrived.
 *
 * Only attempts on THE invoice being paid count (review finding app-1). The read used to
 * take the farm's latest attempt of any invoice, so a farm that once paid by card, then
 * cancelled and reopened, found last period's `succeeded` attempt, was told "payment
 * received, refresh and you will be straight in" over its new invoice, and was never shown
 * a Pay button again. With no invoice there is nothing that can be settling, so nothing is
 * read.
 *
 * `must`: a failed read here would show the Pay button to somebody whose money was moving.
 */
export async function settlingOnInvoice(
  svc: SupabaseClient,
  farmId: string,
  invoiceId: string | null,
  where: string,
  nowMs: number = Date.now(),
): Promise<Settling | null> {
  if (!invoiceId) return null;
  const data = must(
    await svc
      .from("billing_payment_attempts")
      .select("status, requested_at")
      .eq("farm_id", farmId)
      .eq("invoice_id", invoiceId)
      .in("status", ["pending", "succeeded"])
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    where,
  );
  return settlingFrom(data as SettlingAttempt | null, nowMs);
}

/**
 * Days after its due date that an unpaid invoice keeps the farm working
 * (`billing_settings.access_grace_days`, 20261029090100). 7 when it cannot be read, the
 * same default `app.farm_billing_gate` falls back to. Soft: it only decides whether the
 * page adds that more is still overdue, and the decided value is 7.
 */
export async function accessGraceDays(svc: SupabaseClient): Promise<number> {
  const data = soft(
    await svc.from("billing_settings").select("access_grace_days").eq("singleton", true).maybeSingle(),
    "billing:access-grace-days",
  );
  const days = (data as { access_grace_days?: unknown } | null)?.access_grace_days;
  return typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : 7;
}

/** An open, non-service invoice as `/suspended` reads it. */
export type OpenInvoice = {
  id: string;
  total_incl_cents: number;
  amount_paid_cents: number;
  due_on: string | null;
  issued_on: string | null;
};

/**
 * What is still overdue past the grace once `payingId` is paid, in cents: the money that
 * keeps the farm paused after this one checkout (review finding app-4).
 *
 * `/suspended` added up every open invoice, printed that total and "everything comes back
 * the moment it is", above a Pay now that charges one invoice. A farm with two overdue
 * invoices paid what the button asked and was still locked out. The checkout stays one
 * invoice per payment; the page now says what this payment covers and, from this, that
 * more remains.
 *
 * The rule is `app.farm_overdue_since` plus the gate's grace: an invoice counts when it is
 * still owed, not refunded (a refund reopens an invoice that is deliberately not owed), and
 * its due date (or issue date) plus the grace is before today. `today` is the UTC date, as
 * the gate's `current_date` is. The one difference is an invoice with a payment in flight,
 * which the gate leaves out and this counts: the page may then say more remains when that
 * payment is about to clear it, which is the safe way round to be wrong.
 */
export function overdueAfterPaying(
  rows: readonly OpenInvoice[],
  refunded: ReadonlySet<string>,
  payingId: string | null,
  graceDays: number,
  today: string,
): number {
  const before = addDays(today, -graceDays);
  return rows
    .filter((r) => r.id !== payingId && !refunded.has(r.id))
    .filter((r) => r.total_incl_cents > r.amount_paid_cents)
    .filter((r) => {
      const since = r.due_on ?? r.issued_on;
      return since !== null && since < before;
    })
    .reduce((sum, r) => sum + (r.total_incl_cents - r.amount_paid_cents), 0);
}
