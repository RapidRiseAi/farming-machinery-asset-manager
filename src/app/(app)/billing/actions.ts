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
  changeQuota,
  changeSubscriptionPlan,
  deactivatePaymentMethod,
  farmSubscription,
  openInvoiceForFarm,
  resumeSubscription,
  setCancellation,
} from "@/lib/billing/service";
import { PLANS, BILLING_PERIODS } from "@/lib/entitlements";
import { retryInvoiceCharge } from "@/lib/billing/worker";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The owner's own billing actions.
 *
 * ── The rule every one of these obeys ────────────────────────────────────────
 * The role is re-checked HERE, server-side, on the farm being changed — never inferred
 * from what the page chose to render, and never from `profile.role` alone, which
 * describes the person's PRIMARY farm and says nothing about the one they are currently
 * looking at. `app.is_farm_billing_admin` says the same thing in SQL: owner or Rapid Rise,
 * and nobody else. Managers, mechanics, operators and linked contractors are excluded on
 * purpose — a contractor with legitimate access to a farm's vehicles has no business
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
 * This is a `"use server"` file, so it may export only async functions — constants and
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
 * Buy more vehicle slots, or give some back.
 *
 * The SCREEN does not decide what happens — \`app.change_billing_quota\` does, and it
 * applies the founder's rules: more slots are charged pro-rata and available
 * immediately; fewer wait for the period already paid for; and fewer than the farm is
 * actually running is refused outright, because the only way to honour it would be to
 * delete real vehicles.
 *
 * The answer comes back as a WORD rather than a number, so the screen can say which of
 * those three happened — which is the part a farmer actually needs to read.
 */
export async function changeVehicleSlots(formData: FormData): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const quota = Number.parseInt(String(formData.get("quota") ?? ""), 10);
  if (!Number.isFinite(quota) || quota < 1) bounce("billing-quota-invalid");

  const supabase = createServiceClient();
  const sub = await farmSubscription(supabase, farmId);
  if (!sub) bounce("billing-no-subscription");

  const { result, error } = await changeQuota(supabase, sub.id, quota);
  if (error) {
    // The engine's refusals arrive as check_violation with a sentence attached. The one
    // worth separating is "retire or sell a vehicle first", because it is the only
    // refusal the farmer can do something about themselves.
    if (/retire or sell/i.test(error.message)) bounce("billing-quota-below-fleet");
    bounce("billing-quota-failed");
  }

  const applied = String(result?.applied ?? "");
  revalidatePath("/billing");
  redirect(
    applied === "scheduled"
      ? "/billing?saved=slots-scheduled"
      : applied === "no_change"
        ? "/billing?saved=no-change"
        : "/billing?saved=slots-added",
  );
}

/**
 * Move to a different plan, from the owner's own screen.
 *
 * \`app.change_billing_plan\` moves BOTH plans together — the commercial one on the
 * subscription and the effective one on the farm — which is the half that used to be
 * missing, and it keeps the non-payment exception: a farm downgraded for not paying is
 * not handed its features back by asking for a bigger plan.
 */
export async function changeOwnPlan(formData: FormData): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const plan = String(formData.get("plan") ?? "");
  const period = String(formData.get("billing_period") ?? "");
  if (!(PLANS as readonly string[]).includes(plan)) bounce("billing-plan-invalid");
  if (!(BILLING_PERIODS as readonly string[]).includes(period)) bounce("billing-plan-invalid");

  const supabase = createServiceClient();
  const sub = await farmSubscription(supabase, farmId);
  if (!sub) bounce("billing-no-subscription");

  const { result, error } = await changeSubscriptionPlan(supabase, {
    subscriptionId: sub.id,
    plan,
    billingPeriod: period,
  });
  if (error) bounce("billing-plan-failed");

  const applied = String(result?.applied ?? "");
  revalidatePath("/billing");
  redirect(
    applied === "scheduled"
      ? "/billing?saved=plan-scheduled"
      : applied === "no_change"
        ? "/billing?saved=no-change"
        : "/billing?saved=plan-changed",
  );
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
 * The credential columns are not touched — the row and its evidence stay, and the status
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
 * Immediate cancellation exists because somebody occasionally means it, and it is behind
 * an explicit `when=immediate` so it can never be what a mis-click does.
 */
export async function cancelSubscription(formData: FormData): Promise<void> {
  const { farmId } = await requireBillingAdmin();
  const immediate = String(formData.get("when") ?? "period_end").trim() === "immediate";
  const reason = String(formData.get("reason") ?? "").trim() || null;

  const supabase = createServiceClient();
  const subscription = await farmSubscription(supabase, farmId);
  if (!subscription) bounce("billing-no-subscription");
  if (subscription.status === "cancelled") bounce("billing-already-cancelled");

  const { error } = await setCancellation(supabase, {
    subscriptionId: subscription.id,
    farmId,
    immediate,
    reason,
  });
  if (error) bounce("billing-save-failed");

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
 * worker would have used — so a manual retry is subject to every condition the nightly
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
                : "billing-nothing-due",
      );
    default:
      bounce("billing-checkout-failed");
  }
}
