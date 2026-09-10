"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/auth";
import { PLANS, BILLING_PERIODS } from "@/lib/entitlements";
import {
  BILLING_RPC,
  changeSubscriptionPlan,
  getAttemptById,
  getInvoiceById,
  providerState,
  type ProviderState,
} from "@/lib/billing/service";
import { reconcileAttemptById, retryInvoiceCharge } from "@/lib/billing/worker";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Rapid Rise's own billing controls.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * There is no "mark this invoice paid", no "write a payment", no "clear this attempt".
 * Every one of those would be a second path to a `billing_payments` row, and the whole
 * ledger's integrity rests on there being exactly one: `app.settle_billing_attempt`,
 * reached only from a VERIFIED provider answer. An admin who could type a payment in
 * could also type one in by accident, and no evidence would say which had happened.
 *
 * What Rapid Rise can do instead is ASK: reconcile an attempt against Paystack, retry a
 * charge through the same locked sequence the worker uses, change what a farm has bought,
 * and read the kill switch. Every one of those either produces evidence or is evidence.
 *
 * ── The role check ───────────────────────────────────────────────────────────
 * `rr_admin`, re-checked server-side in every action. Not "the admin area rendered, so
 * they must be an admin" — a server action is an endpoint, reachable by anyone who knows
 * its id, and it is authorized on its own or it is not authorized at all.
 */

function bounce(code: string): never {
  redirect(`/admin/billing?error=${encodeURIComponent(code)}`);
}

/** Rapid Rise only. Not exported — a `"use server"` file exports only actions. */
async function requireRrAdmin(): Promise<void> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") bounce("forbidden");
}

/**
 * Ask Paystack what happened to one attempt.
 *
 * The ONLY safe resolution for an `unknown` — the status a lost HTTP response leaves
 * behind, which blocks its invoice precisely so that nobody charges again to find out.
 * This verifies THAT EXACT REFERENCE and settles from the answer, so the outcome is
 * whatever actually happened rather than whatever we assumed.
 *
 * A verified success is checked against the same five fields the webhook checks: our
 * reference, the expected amount, ZAR, `status: success`, and the farm and invoice in the
 * metadata. A reconciler that were even slightly more trusting than the webhook would be
 * the way around the webhook.
 */
export async function adminReconcileAttempt(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const attemptId = String(formData.get("attempt_id") ?? "").trim();
  if (!attemptId) bounce("missing-id");

  const supabase = createServiceClient();
  const attempt = await getAttemptById(supabase, attemptId);
  if (!attempt) bounce("not-found");

  const outcome = await reconcileAttemptById(supabase, attemptId);
  revalidatePath("/admin/billing");

  switch (outcome.result) {
    case "succeeded":
      redirect("/admin/billing?saved=reconciled-paid");
    case "failed":
    case "abandoned":
      redirect("/admin/billing?saved=reconciled-closed");
    case "refused":
      // The provider described a transaction that is not the charge we raised. Recorded
      // on the attempt, not settled, and surfaced as its own outcome rather than folded
      // into a generic failure — this is the case somebody has to look at.
      bounce("billing-mismatch");
    case "still-open":
      redirect("/admin/billing?saved=reconciled-open");
    default:
      bounce("billing-reconcile-failed");
  }
}

/**
 * Retry a charge on a farm's behalf.
 *
 * Goes through exactly the same claim → charge → settle sequence as the nightly worker,
 * so it inherits the in-flight lock rather than sitting beside it. An invoice with an
 * `unknown` attempt cannot be retried from here either — it has to be reconciled first,
 * which is the correct order and the one a support ticket most wants to skip.
 */
export async function adminRetryCharge(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const invoiceId = String(formData.get("invoice_id") ?? "").trim();
  if (!invoiceId) bounce("missing-id");

  const supabase = createServiceClient();
  const invoice = await getInvoiceById(supabase, invoiceId);
  if (!invoice) bounce("not-found");

  const outcome = await retryInvoiceCharge(supabase, {
    invoiceId: invoice.id,
    farmId: invoice.farm_id,
    kind: "manual_retry",
  });
  revalidatePath("/admin/billing");

  switch (outcome.result) {
    case "succeeded":
      redirect("/admin/billing?saved=charged");
    case "failed":
      bounce("billing-declined");
    case "unknown":
      redirect("/admin/billing?saved=checking");
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

/**
 * Change a farm's plan — the bill and the features together.
 *
 * This used to write `billing_subscriptions.plan` alone, so an upgrade charged more and
 * granted nothing while a downgrade charged less and took nothing away. The rules now live
 * in `app.change_billing_plan`: a rank increase on the same term applies immediately and
 * raises a pro-rata invoice; everything else is scheduled for period end; and a farm
 * downgraded for NON-PAYMENT has the upgrade recorded as what it will be restored to
 * rather than handed back, which is the protection the old half-write was reaching for.
 *
 * Those rules are in SQL because two screens call them, and a rule in one screen is a rule
 * the other one does not have.
 *
 * The plan and the period are validated against the shipped vocabulary rather than passed
 * through: they arrive in a form body, and the column is an enum whose rejection would
 * otherwise reach a user as a Postgres error.
 */
export async function adminSetPlan(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const subscriptionId = String(formData.get("subscription_id") ?? "").trim();
  const plan = String(formData.get("plan") ?? "").trim();
  const billingPeriod = String(formData.get("billing_period") ?? "").trim();
  if (!subscriptionId) bounce("missing-id");
  if (!(PLANS as readonly string[]).includes(plan)) bounce("billing-bad-plan");
  if (!(BILLING_PERIODS as readonly string[]).includes(billingPeriod)) bounce("billing-bad-period");

  const supabase = createServiceClient();
  const { result, error } = await changeSubscriptionPlan(supabase, {
    subscriptionId,
    plan,
    billingPeriod,
  });
  if (error) bounce("billing-save-failed");

  revalidatePath("/admin/billing");
  // Say which of the three things happened. "Saved" is not enough when one branch has
  // just charged somebody money and another has queued a change for three weeks' time.
  redirect(
    `/admin/billing?saved=${
      result?.applied === "scheduled"
        ? "plan-scheduled"
        : result?.applied === "no_change"
          ? "plan-unchanged"
          : "plan"
    }`,
  );
}

/**
 * Put a farm on a subscription.
 *
 * Nothing in the product did this. `beginCheckout` refuses with
 * `billing-no-subscription`, so a farm could never start paying and the whole feature was
 * reachable only by hand-writing a row into `billing_subscriptions` — which is not a way
 * to onboard a paying customer.
 *
 * The rules live in `app.start_billing_subscription`, not here: the trial length comes
 * from `billing_settings` so policy is set in one place, the "one live subscription per
 * farm" refusal is the unique index turned into a sentence, and `current_period_start` is
 * left null so the first BILLED period starts when billing starts rather than on the day
 * somebody pressed this button.
 *
 * `p_trial_days` is offered because the two cases that need it are real: a farm onboarded
 * mid-cycle who negotiated their own trial, and a test that needs an invoice today rather
 * than in a fortnight. Left blank, the farm gets the standard trial.
 *
 * This does NOT charge anything. It creates the subscription; the first invoice is raised
 * by the nightly pass (or immediately, when the trial is zero), and payment still needs
 * the farm to add a card.
 */
export async function adminStartSubscription(formData: FormData): Promise<void> {
  await requireRrAdmin();

  const farmId = String(formData.get("farm_id") ?? "").trim();
  const plan = String(formData.get("plan") ?? "").trim();
  const billingPeriod = String(formData.get("billing_period") ?? "").trim();
  const trialRaw = String(formData.get("trial_days") ?? "").trim();

  if (!/^[0-9a-f-]{36}$/i.test(farmId)) bounce("missing-id");
  if (!(PLANS as readonly string[]).includes(plan)) bounce("billing-bad-plan");
  if (!(BILLING_PERIODS as readonly string[]).includes(billingPeriod)) bounce("billing-bad-period");

  // Blank means "use the policy". A number means this farm, deliberately, gets that many
  // days — including zero, which is how a test gets an invoice it can actually pay.
  let trialDays: number | null = null;
  if (trialRaw !== "") {
    const n = Number(trialRaw);
    if (!Number.isInteger(n) || n < 0 || n > 365) bounce("billing-bad-trial");
    trialDays = n;
  }

  const supabase = createServiceClient();
  const { error } = await supabase.rpc(BILLING_RPC.startSubscription, {
    p_farm: farmId,
    p_plan: plan,
    p_period: billingPeriod,
    p_trial_days: trialDays,
  });
  if (error) {
    // The one refusal worth its own message: they already have one, and the admin should
    // be told that rather than "save failed".
    bounce(error.code === "23505" ? "billing-already-subscribed" : "billing-save-failed");
  }

  revalidatePath("/admin/billing");
  redirect("/admin/billing?saved=subscription");
}

/**
 * What the kill switch currently says.
 *
 * Returns the provider name and the two booleans and NOTHING else — never the key, never
 * a fragment of it, never a "configured as sk_live_…" hint. `BILLING_PROVIDER` decides
 * whether an adapter exists at all; `BILLING_CHARGING_ENABLED` decides separately whether
 * it may take money, and both are read live rather than from a cached bundle, because the
 * question "may we charge right now" has to be answerable now.
 */
export async function adminBillingState(): Promise<ProviderState> {
  await requireRrAdmin();
  return providerState();
}
