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
import { isIsoDate, isUuid } from "@/lib/ids";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";

/**
 * Rapid Rise's own billing controls.
 *
 * == Two ways money comes in, each with its evidence ==========================
 * A card payment is written only by `app.settle_billing_attempt`, reached only from a
 * VERIFIED provider answer. Since 20261029100000 a payment made outside the app (EFT,
 * cash) can be recorded by hand (`adminRecordPayment`), because the founder decided such
 * payments are allowed, and a farm that paid by EFT could otherwise never be activated.
 * It carries its own evidence instead: the proof of payment is stored, the admin who
 * recorded it is named, the bank reference cannot be recorded twice, it cannot exceed what
 * is owed or overlap a card payment in flight, and a reversal names who and why. There is
 * still no "clear this attempt": a card attempt is only ever settled by asking Paystack.
 *
 * What Rapid Rise can do instead is ASK: reconcile an attempt against Paystack, retry a
 * charge through the same locked sequence the worker uses, change what a farm has bought,
 * and read the kill switch. Every one of those either produces evidence or is evidence.
 *
 * == The role check ===========================================================
 * `rr_admin`, re-checked server-side in every action. Not "the admin area rendered, so
 * they must be an admin", a server action is an endpoint, reachable by anyone who knows
 * its id, and it is authorized on its own or it is not authorized at all.
 */

function bounce(code: string): never {
  redirect(`/admin/billing?error=${encodeURIComponent(code)}`);
}

/** Rapid Rise only. Not exported, a `"use server"` file exports only actions. */
async function requireRrAdmin(): Promise<void> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") bounce("forbidden");
}

/**
 * Ask Paystack what happened to one attempt.
 *
 * The ONLY safe resolution for an `unknown`, the status a lost HTTP response leaves
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
      // into a generic failure, this is the case somebody has to look at.
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
 * `unknown` attempt cannot be retried from here either, it has to be reconciled first,
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
 * Change a farm's plan, the bill and the features together.
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
 * reachable only by hand-writing a row into `billing_subscriptions`, which is not a way
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
  // days, including zero, which is how a test gets an invoice it can actually pay.
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
 * Give a farm a price nobody else has.
 *
 * `SCOPE.md` §12 sells a Founding Farmer rate "locked for life" to the first twenty farms
 * and there was no way to give one. Price PINNING, the only mechanism the engine had -
 * grandfathers a farm onto the version it signed up at, which stops a price rising; it
 * does not make one lower. So every founding promise made so far was one the billing
 * engine could not keep.
 *
 * == Why it does not write the columns directly ===============================
 * The rules live in `public.billing_set_subscription_discount`: percentage OR amount and
 * never both, a percentage inside 0,01-100%, an amount above zero. An `update` from here
 * would be a second place those rules have to be right, and the one that gets forgotten.
 *
 * == Blank clears it ==========================================================
 * Both fields empty removes the deal, which is the same call with two nulls. Ending a
 * discount by setting `until` to yesterday would leave a row that reads as a live deal to
 * anybody looking at the farm later.
 *
 * == What it does NOT touch ===================================================
 * Any invoice already raised. The discount is frozen onto an invoice while it is a draft,
 * so changing this today cannot restate a document the customer has already been sent or
 * paid. It applies from the next invoice, and the farm's own `/billing` screen quotes the
 * new figure immediately because it mirrors the same rule.
 */
export async function adminSetDiscount(formData: FormData): Promise<void> {
  await requireRrAdmin();

  const subscriptionId = String(formData.get("subscription_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) bounce("missing-id");

  const percentRaw = String(formData.get("percent") ?? "").trim();
  const randsRaw = String(formData.get("rands") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const untilRaw = String(formData.get("until") ?? "").trim();

  if (percentRaw !== "" && randsRaw !== "") bounce("billing-discount-both");

  // Entered as a percentage and as RANDS, because that is what the conversation was in.
  // Stored as basis points and cents, because that is what money is in this codebase.
  let percentBps: number | null = null;
  if (percentRaw !== "") {
    const n = Number(percentRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) bounce("billing-discount-bad");
    percentBps = Math.round(n * 100);
    if (percentBps < 1) bounce("billing-discount-bad");
  }

  let fixedCents: number | null = null;
  if (randsRaw !== "") {
    const n = Number(randsRaw.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) bounce("billing-discount-bad");
    fixedCents = Math.round(n * 100);
    if (fixedCents < 1) bounce("billing-discount-bad");
  }

  // Null is not "no end date I forgot to set", it is the Founding Farmer default, and it
  // is what "locked for life" means.
  let until: string | null = null;
  if (untilRaw !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) bounce("billing-discount-bad");
    until = untilRaw;
  }

  const supabase = createServiceClient();
  const { error } = await supabase.rpc(BILLING_RPC.setSubscriptionDiscount, {
    p_subscription: subscriptionId,
    p_percent_bps: percentBps,
    p_fixed_cents: fixedCents,
    p_label: label || null,
    p_until: until,
  });
  if (error) bounce("billing-save-failed");

  revalidatePath("/admin/billing");
  revalidatePath("/billing");
  redirect(`/admin/billing?saved=${percentBps == null && fixedCents == null ? "discount-cleared" : "discount"}`);
}

/** Proof files: a bank confirmation or a slip, small enough for one request (4.5 MB). */
const PROOF_MAX_BYTES = 4 * 1024 * 1024;
const PROOF_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Record a payment made outside the app: an EFT, cash, or other (20261029100000).
 *
 * The proof is stored first (service-only bucket billing-proofs) and the payment recorded
 * second; if recording is refused, the stored proof is removed again, so no orphan file
 * outlives a payment that never was. The database refuses everything a person could get
 * wrong (more than is owed, the same bank reference twice, a card payment in flight, a
 * date in the future) and, once the invoice is paid in full, activates a sign-up or
 * resumes a suspended farm exactly as a card payment does.
 */
export async function adminRecordPayment(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") bounce("forbidden");

  const farmId = String(formData.get("farm_id") ?? "").trim();
  const invoiceId = String(formData.get("invoice_id") ?? "").trim();
  const method = String(formData.get("method") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const received = String(formData.get("received_on") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const randsRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const proof = formData.get("proof");
  if (!isUuid(farmId) || !isUuid(invoiceId)) bounce("missing-id");
  if (!isIsoDate(received)) bounce("billing-manual-bad");
  const amount = Number(randsRaw);
  if (!Number.isFinite(amount) || amount <= 0) bounce("billing-manual-bad");
  const amountCents = Math.round(amount * 100);
  if (!(proof instanceof File) || proof.size === 0) bounce("billing-manual-proof");
  if (proof.size > PROOF_MAX_BYTES) bounce("billing-manual-proof-big");
  const ext = PROOF_TYPES[proof.type];
  if (!ext) bounce("billing-manual-proof-type");

  const supabase = createServiceClient();
  const path = `${farmId}/${invoiceId}/${crypto.randomUUID()}.${ext}`;
  const stored = await supabase.storage.from("billing-proofs").upload(path, proof, { contentType: proof.type });
  if (stored.error) bounce(errorCode(stored.error, "admin-billing:manual-proof"));

  const { error } = await supabase.rpc(BILLING_RPC.recordManualPayment, {
    p_invoice: invoiceId,
    p_amount_cents: amountCents,
    p_method: method,
    p_bank_reference: reference,
    p_received_on: received,
    p_note: note || null,
    p_proof_path: path,
    p_by: profile.id,
  });
  if (error) {
    const removed = await supabase.storage.from("billing-proofs").remove([path]);
    if (removed.error) captureError(removed.error, { where: "admin-billing:manual-proof-cleanup", farmId });
    bounce(errorCode(error, "admin-billing:manual-payment", "billing-save-failed"));
  }

  revalidatePath("/admin/billing");
  redirect(`/admin/billing?farm=${farmId}&saved=payment-recorded`);
}

/** Take back a payment recorded by hand (a bounced EFT, a typing mistake), with a reason. */
export async function adminReversePayment(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") bounce("forbidden");
  const farmId = String(formData.get("farm_id") ?? "").trim();
  const paymentId = String(formData.get("payment_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(farmId) || !isUuid(paymentId)) bounce("missing-id");
  if (!reason) bounce("billing-manual-reason");

  const supabase = createServiceClient();
  const { error } = await supabase.rpc(BILLING_RPC.reverseManualPayment, {
    p_payment: paymentId,
    p_reason: reason,
    p_by: profile.id,
  });
  if (error) bounce(errorCode(error, "admin-billing:manual-reverse", "billing-save-failed"));

  revalidatePath("/admin/billing");
  redirect(`/admin/billing?farm=${farmId}&saved=payment-reversed`);
}

/**
 * Keep a farm open past the seven days' grace, until a date and for a reason (an EFT the
 * bank has confirmed, a farmer in hospital). Lifts a suspension at once; the farm is
 * suspended again by the nightly run if it is still unpaid after the date. Up to 60 days.
 * Service role, with the acting admin passed in (20261029090100), like the discount setter.
 */
export async function adminExtendAccess(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") bounce("forbidden");

  const farmId = String(formData.get("farm_id") ?? "").trim();
  const until = String(formData.get("until") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(farmId)) bounce("missing-id");
  if (!isIsoDate(until)) bounce("billing-extend-bad");
  if (!reason) bounce("billing-extend-reason");

  const supabase = createServiceClient();
  const { error } = await supabase.rpc(BILLING_RPC.extendAccess, {
    p_farm: farmId,
    p_until: until,
    p_reason: reason,
    p_by: profile.id,
  });
  if (error) bounce(error.code === "22023" ? "billing-extend-bad" : errorCode(error, "admin-billing:extend-access"));

  revalidatePath("/admin/billing");
  redirect("/admin/billing?saved=access-extended");
}

/**
 * What the kill switch currently says.
 *
 * Returns the provider name and the two booleans and NOTHING else, never the key, never
 * a fragment of it, never a "configured as sk_live_…" hint. `BILLING_PROVIDER` decides
 * whether an adapter exists at all; `BILLING_CHARGING_ENABLED` decides separately whether
 * it may take money, and both are read live rather than from a cached bundle, because the
 * question "may we charge right now" has to be answerable now.
 */
export async function adminBillingState(): Promise<ProviderState> {
  await requireRrAdmin();
  return providerState();
}
