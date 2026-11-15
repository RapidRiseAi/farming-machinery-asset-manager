"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  accessibleFarms,
  effectiveFarmRole,
  requireProfile,
  currentFarmId,
  type Profile,
} from "@/lib/auth";
import {
  activePaymentMethod,
  beginCheckout,
  billingContactEmail,
  acceptQuote,
  cancelQuote,
  changeRefusal,
  deactivatePaymentMethod,
  farmSubscription,
  openInvoiceForFarm,
  quoteChange,
  resumeSubscription,
  setCancellation,
} from "@/lib/billing/service";
import { runOnce } from "@/lib/request-claim";
import { PLANS, BILLING_PERIODS } from "@/lib/entitlements";
import { retryInvoiceCharge } from "@/lib/billing/worker";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The owner's own billing actions.
 *
 * == The rule every one of these obeys ========================================
 * The role is re-checked HERE, server-side, on the farm being changed, never inferred
 * from what the page chose to render, and never from `profile.role` alone, which
 * describes the person's PRIMARY farm and says nothing about the one they are currently
 * looking at. `app.is_farm_billing_admin` says the same thing in SQL: owner or Rapid Rise,
 * and nobody else. Managers, mechanics, operators and linked contractors are excluded on
 * purpose, a contractor with legitimate access to a farm's vehicles has no business
 * seeing, let alone changing, what that farm pays Rapid Rise.
 *
 * Every write goes through the SERVICE client, because `authenticated` holds SELECT and
 * nothing else on every `billing_*` table. That is not a workaround: it is the design, so
 * that no browser session can mint an invoice, settle an attempt or record a payment even
 * if every guard in this file were wrong.
 *
 * Every rejection is a translated error CODE, never a raw message and never a Postgres
 * string. `src/lib/errors.ts` turns it into a sentence in the reader's own language.
 *
 * This is a `"use server"` file, so it may export only async functions, constants and
 * types live in `src/lib/billing/*`.
 */

function bounce(code: string): never {
  redirect(`/billing?error=${encodeURIComponent(code)}`);
}

/**
 * Owner-or-Rapid-Rise on the farm currently selected, resolved once.
 *
 * Not exported: a `"use server"` file exports only actions, and exporting an authorization
 * helper across the server-action boundary would make it callable as an endpoint in its
 * own right.
 */
async function requireBillingAdmin(): Promise<{ profile: Profile; farmId: string }> {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) bounce("no-farm");
  if (profile.role !== "rr_admin") {
    const farms = await accessibleFarms(profile);
    if (!farms.some((f) => f.id === farmId)) bounce("forbidden");
  }
  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "rr_admin") bounce("forbidden");
  return { profile, farmId };
}

/**
 * Pay now / set the card up.
 *
 * The first payment is also how the card gets stored: Paystack's hosted page takes the
 * money and the reusable authorization comes back on the verify. There is no separate
 * "add a card" step, and adding one would mean a second path into
 * `billing_payment_methods`.
 *
 * `beginCheckout` mints and persists the reference BEFORE contacting Paystack, so a
 * response lost between here and there is recoverable by verifying it rather than by
 * trying again.
 */
/**
 * Change what the business pays for, mid-period (20261115110000). Three steps, each one an
 * explicit press, and the engine decides everything that matters in each:
 *
 *   1. `requestChange` PRICES the change and keeps the price as a quote (30 minutes, never
 *      past midnight in South Africa), then shows it: today's charge after any credit, the
 *      credit an upgrade gives back, the next renewal total, the date it takes effect and,
 *      for a lower plan, the features given up.
 *   2. `acceptChange` accepts that quote at the amounts shown. The engine prices it again
 *      under the subscription lock and refuses a moved basis or an expired price, so what is
 *      charged is what was shown. Fewer spaces and lower plans are scheduled for the renewal;
 *      more spaces and higher plans wait for their payment.
 *   3. `payChange` pays the change invoice, with the card on file or through checkout. Only
 *      the payment makes the change: the capacity rises when the invoice is paid, by a
 *      trigger, whichever way the money arrives.
 *
 * `cancelChange` closes a quote, a change waiting for its payment, or one scheduled for the
 * renewal. Every refusal is a translated code.
 */
function changeTarget(formData: FormData): {
  plan: string | null;
  billingPeriod: string | null;
  fullSpaces: number | null;
  equipmentExtra: number | null;
  currentList: boolean;
} {
  const kind = String(formData.get("change") ?? "");
  const int = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : Number.NaN;
  };
  if (kind === "plan") {
    const plan = String(formData.get("plan") ?? "");
    const period = String(formData.get("billing_period") ?? "");
    if (!(PLANS as readonly string[]).includes(plan)) bounce("billing-plan-invalid");
    if (!(BILLING_PERIODS as readonly string[]).includes(period)) bounce("billing-plan-invalid");
    return { plan, billingPeriod: period, fullSpaces: null, equipmentExtra: null, currentList: formData.get("current_list") === "1" };
  }
  if (kind === "capacity") {
    const full = int("full");
    const extra = int("equipment_extra");
    if (Number.isNaN(full) || Number.isNaN(extra) || (full != null && full < 1) || (extra != null && extra < 0)) {
      bounce("billing-quota-invalid");
    }
    return { plan: null, billingPeriod: null, fullSpaces: full, equipmentExtra: extra, currentList: false };
  }
  bounce("billing-change-failed");
}

export async function requestChange(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  const target = changeTarget(formData);

  const supabase = createServiceClient();
  const sub = await farmSubscription(supabase, farmId);
  if (!sub) bounce("billing-no-subscription");

  const { state, error } = await quoteChange(supabase, { subscriptionId: sub.id, by: profile.id, ...target });
  if (error) bounce(changeRefusal(error) ?? "billing-change-failed");
  if (!state) bounce("billing-change-failed");
  if (state.kind === "no_change") redirect("/billing?saved=no-change");
  // The engine's reason is a slug errors.ts translates; the change section stays open with
  // the figures they asked for, so trying another number is one edit.
  if (state.kind === "unavailable" || !state.quote_id) {
    redirect(`/billing?manage=1&error=${encodeURIComponent(state.reason ?? "billing-change-failed")}`);
  }
  redirect(`/billing?quote=${encodeURIComponent(state.quote_id)}`);
}

/** Say what a payment attempt on a change came to, in the words the page uses. */
function paidOutcome(outcome: Awaited<ReturnType<typeof retryInvoiceCharge>>): string {
  switch (outcome.result) {
    case "succeeded":
      return "/billing?saved=change-made";
    case "unknown":
      return "/billing?saved=checking";
    case "failed":
      return "/billing?error=billing-declined";
    case "skipped":
      return `/billing?error=${
        outcome.reason === "charging-disabled" || outcome.reason === "provider-unavailable"
          ? "billing-unavailable"
          : outcome.reason === "claimed-elsewhere"
            ? "billing-in-flight"
            : outcome.reason === "below-minimum"
              ? "billing-below-minimum"
              : outcome.reason === "amount-changed"
                ? "billing-amount-changed"
                : "billing-nothing-due"
      }`;
    default:
      return "/billing?error=billing-checkout-failed";
  }
}

/**
 * Pay a change invoice: the card on file when there is one, otherwise hosted checkout for
 * exactly that invoice. Returns where to send the person (a checkout page or /billing).
 */
async function payChangeInvoice(profile: Profile, farmId: string, invoiceId: string): Promise<string> {
  const supabase = createServiceClient();
  const card = await activePaymentMethod(supabase, farmId);
  if (card) {
    const outcome = await retryInvoiceCharge(supabase, { invoiceId, farmId, kind: "manual_retry" });
    return paidOutcome(outcome);
  }
  const email = await billingContactEmail(supabase, farmId, profile.email);
  const started = await beginCheckout(supabase, { farmId, email, userId: profile.id, invoiceId });
  if (!started.ok) return `/billing?error=${encodeURIComponent(started.code)}`;
  return started.url;
}

export async function acceptChange(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  const quoteId = String(formData.get("quote_id") ?? "").trim();
  if (!quoteId) bounce("missing-id");
  const cents = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : Number.NaN;
  };
  const charge = cents("charge_cents");
  const credit = cents("credit_cents");
  const next = cents("next_renewal_cents");
  if (charge == null || credit == null || Number.isNaN(charge) || Number.isNaN(credit) || Number.isNaN(next)) {
    bounce("quote-changed");
  }

  return runOnce(
    formData,
    "billing:accept-change",
    async () => {
      const supabase = createServiceClient();
      const { result, error } = await acceptQuote(supabase, {
        quoteId,
        by: profile.id,
        chargeCents: charge,
        creditCents: credit,
        nextRenewalCents: next,
      });
      if (error) return `/billing?error=${encodeURIComponent(changeRefusal(error) ?? "billing-change-failed")}`;
      if (!result) return "/billing?error=billing-change-failed";
      revalidatePath("/billing");
      if (result.applied === "scheduled") return "/billing?saved=change-scheduled";
      if (result.applied === "now") {
        return (result.credit_cents ?? 0) > 0 ? "/billing?saved=change-credited" : "/billing?saved=change-made";
      }
      // Waiting for its payment: paid now, the same press, so nothing is made until it is.
      if (!result.invoice_id) return "/billing?saved=change-awaiting";
      return payChangeInvoice(profile, farmId, result.invoice_id);
    },
    { whileRunning: "/billing?saved=checking" },
  );
}

/** Pay a change that is waiting for its payment (the card was declined, or checkout left). */
export async function payChange(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  const invoiceId = String(formData.get("invoice_id") ?? "").trim();
  if (!invoiceId) bounce("missing-id");
  return runOnce(
    formData,
    "billing:pay-change",
    async () => {
      const target = await payChangeInvoice(profile, farmId, invoiceId);
      revalidatePath("/billing");
      return target;
    },
    { whileRunning: "/billing?saved=checking" },
  );
}

export async function cancelChange(formData: FormData): Promise<void> {
  const { profile } = await requireBillingAdmin();
  const quoteId = String(formData.get("quote_id") ?? "").trim();
  if (!quoteId) bounce("missing-id");
  const supabase = createServiceClient();
  const { error } = await cancelQuote(supabase, { quoteId, by: profile.id });
  if (error) bounce(changeRefusal(error) ?? "billing-change-failed");
  revalidatePath("/billing");
  redirect("/billing?saved=change-cancelled");
}
export async function startCheckout(): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  const supabase = createServiceClient();
  const email = await billingContactEmail(supabase, farmId, profile.email);
  const started = await beginCheckout(supabase, { farmId, email, userId: profile.id });
  if (!started.ok) bounce(started.code);
  redirect(started.url);
}

/**
 * Put a different card on the account.
 *
 * Deliberately the same flow as `startCheckout` and deliberately NOT "remove the old card,
 * then add a new one": a successful new authorization supersedes the incumbent inside
 * `storeAuthorization` (which stands the old default down and claims `is_default` in the
 * same breath), whereas removing first would leave a farm that abandons the checkout with
 * no card at all and a renewal that fails for a reason they never chose.
 */
export async function replacePaymentMethod(): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  const supabase = createServiceClient();
  const email = await billingContactEmail(supabase, farmId, profile.email);
  const started = await beginCheckout(supabase, { farmId, email, userId: profile.id });
  if (!started.ok) bounce(started.code);
  redirect(started.url);
}

/**
 * Take a stored card off the account.
 *
 * The credential columns are not touched, the row and its evidence stay, and the status
 * change is what stops `app.due_billing_charges` choosing it. Removing the only card does
 * not cancel anything; it means the next renewal has nothing to charge, which the billing
 * page says plainly rather than discovering on the night.
 */
export async function removePaymentMethod(formData: FormData): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const paymentMethodId = String(formData.get("payment_method_id") ?? "").trim();
  if (!paymentMethodId) bounce("missing-id");

  const supabase = createServiceClient();
  const { error } = await deactivatePaymentMethod(supabase, { paymentMethodId, farmId });
  if (error) bounce("billing-save-failed");

  revalidatePath("/billing");
  redirect("/billing?saved=card-removed");
}

/**
 * Cancel.
 *
 * PERIOD END is the default and the one the button does. They have paid for the period,
 * so they keep everything until it runs out and `app.billing_close_cancellations()` closes
 * it on the night it expires. Nothing is deleted at any point, and the account can be
 * resumed until it closes.
 *
 * Immediate cancellation is Rapid Rise's alone (after an agreed refund), behind an explicit
 * `when=immediate` so it can never be what a mis-click does.
 */
export async function cancelSubscription(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireBillingAdmin();
  // Decision 26: a cancellation stops the next renewal and access runs to the paid-through
  // date. Ending it at once is Rapid Rise's, after a refund was agreed with a person
  // (BILLING.md section 11b); an owner asking for it is refused in words, never quietly
  // turned into something else.
  const immediate = String(formData.get("when") ?? "period_end").trim() === "immediate";
  if (immediate && profile.role !== "rr_admin") bounce("billing-cancel-immediate");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  const supabase = createServiceClient();
  const subscription = await farmSubscription(supabase, farmId);
  if (!subscription) bounce("billing-no-subscription");
  if (subscription.status === "cancelled") bounce("billing-already-cancelled");

  const { error, refused } = await setCancellation(supabase, {
    subscriptionId: subscription.id,
    farmId,
    immediate,
    reason,
  });
  if (error) bounce("billing-save-failed");
  // A paused farm cannot be cancelled until it has paid (review finding money-4). The
  // refusal is the update's own, so it holds for Rapid Rise as well as for an owner whose
  // page was opened before the suspension; said in words, not as a failed save.
  if (refused) bounce(refused);

  revalidatePath("/billing");
  redirect(`/billing?saved=${immediate ? "cancelled" : "cancelling"}`);
}

/** Change your mind, while there is still a period left to change it in. */
export async function resumeBilling(): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const supabase = createServiceClient();
  const subscription = await farmSubscription(supabase, farmId);
  if (!subscription) bounce("billing-no-subscription");
  if (subscription.status !== "non_renewing") bounce("billing-not-cancelling");

  const { error } = await resumeSubscription(supabase, {
    subscriptionId: subscription.id,
    farmId,
  });
  if (error) bounce("billing-save-failed");

  revalidatePath("/billing");
  redirect("/billing?saved=resumed");
}

/**
 * "Try that payment again."
 *
 * Goes through `retryInvoiceCharge`, which rebuilds the same shortlist row the automatic
 * worker would have used, so a manual retry is subject to every condition the nightly
 * pass is, INCLUDING the in-flight block. That is the point: a "try again" button is
 * otherwise the perfect way to bypass the one lock that stops a farm being charged twice,
 * and a farmer pressing it twice in ten seconds is not a hypothetical.
 *
 * An `unknown` attempt is therefore not retried here and never will be. It is answered by
 * verifying that exact reference, which is what the reconciler and Rapid Rise's admin
 * action do.
 */
export async function retryPayment(): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const supabase = createServiceClient();

  const invoice = await openInvoiceForFarm(supabase, farmId);
  if (!invoice) bounce("billing-nothing-due");

  const card = await activePaymentMethod(supabase, farmId);
  if (!card) bounce("billing-no-card");

  const outcome = await retryInvoiceCharge(supabase, {
    invoiceId: invoice.id,
    farmId,
    kind: "manual_retry",
  });

  revalidatePath("/billing");
  switch (outcome.result) {
    case "succeeded":
      redirect("/billing?saved=paid");
    case "failed":
      bounce("billing-declined");
    case "unknown":
      // Not an error to shout about and not a success: we are checking. The reconciler
      // resolves it, and telling somebody "it failed" here would be a lie half the time.
      redirect("/billing?saved=checking");
    case "abandoned":
      bounce("billing-checkout-failed");
    case "skipped":
      bounce(
        outcome.reason === "charging-disabled" || outcome.reason === "provider-unavailable"
          ? "billing-unavailable"
          : outcome.reason === "no-stored-card"
            ? "billing-no-card"
            : outcome.reason === "claimed-elsewhere"
              ? "billing-in-flight"
              : outcome.reason === "below-minimum"
                ? "billing-below-minimum"
                : outcome.reason === "amount-changed"
                  ? "billing-amount-changed"
                  : "billing-nothing-due",
      );
    default:
      bounce("billing-checkout-failed");
  }
}
