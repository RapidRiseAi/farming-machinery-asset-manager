/**
 * Payment-provider seam (FR-19.1 payments / FR-19.3) — DEFERRED.
 *
 * Payment/charging integration is intentionally NOT built: it awaits provider research
 * (`docs/FLEETWISE_PROVIDER_RESEARCH_PROMPT.md`). This file defines the ONE interface a
 * future adapter (Stripe / Paystack / Peach / Ozow / …) implements. Everything upstream
 * of it (plans, entitlements, asset count, pricing display) is already built and does
 * not move money. When a provider is chosen, add `src/lib/billing/<provider>.ts`
 * implementing `BillingAdapter` and wire it in `index.ts` behind the `BILLING_PROVIDER`
 * env var. No caller changes.
 */

import type { Plan, BillingPeriod } from "@/lib/entitlements";

/** A farm's current subscription snapshot, as the app knows it (source: `farms`). */
export type SubscriptionSnapshot = {
  farmId: string;
  plan: Plan;
  billingPeriod: BillingPeriod;
  /** Billable vehicle count (denormalised `farms.asset_count`). */
  assetCount: number;
  /** trial | active | suspended | cancelled (farm_status). */
  status: string;
};

/** What the app asks a provider to reconcile to. */
export type SubscriptionIntent = {
  farmId: string;
  plan: Plan;
  billingPeriod: BillingPeriod;
  assetCount: number;
};

export type BillingResult =
  | { ok: true; providerRef?: string; note?: string }
  | { ok: false; deferred: true; reason: string };

/**
 * The contract a real payment provider fulfils. Deliberately minimal and provider-
 * agnostic. All methods are async and MUST NOT throw for the "not configured" case —
 * they return `{ ok: false, deferred: true }` so callers degrade gracefully.
 */
export interface BillingAdapter {
  /** Stable identifier of the adapter in use (e.g. "noop", "stripe"). */
  readonly provider: string;
  /** True only when a real provider is configured and ready to charge. */
  readonly enabled: boolean;

  /** Create/ensure a billing customer for a farm. */
  ensureCustomer(snapshot: SubscriptionSnapshot): Promise<BillingResult>;

  /** Create or update the recurring subscription to match the intent (plan/period/qty). */
  syncSubscription(intent: SubscriptionIntent): Promise<BillingResult>;

  /** Push a new billable asset count (metered/seat quantity) to the provider. */
  syncAssetCount(farmId: string, assetCount: number): Promise<BillingResult>;

  /** Cancel the farm's subscription (export-on-cancel handled elsewhere). */
  cancel(farmId: string): Promise<BillingResult>;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SaaS subscription billing (Paystack) — farms paying Rapid Rise for FleetWise
// ═══════════════════════════════════════════════════════════════════════════════
//
// SCOPE BOUNDARY. Everything below is ONE direction: our customer paying us for
// software. It is not, and must never become, the money that moves between a farm and
// its contractors — that is `partner_documents` / `partner_payments` (F14/G1–G10), and
// FleetWise deliberately does not sit in the middle of it. Nothing here may reference
// `src/lib/payments/*`, `PAYFAST_*`, or `workshops.plan`.
//
// WHERE SUBSCRIPTION STATE LIVES. Here, in our database — not at the provider. Paystack
// moves money and nothing else: it holds no plan, no price, no period, no entitlement.
// The amount changes with the farm's billable vehicle count, so a fixed provider-side
// "Plan" object would be wrong the moment a farmer sells a tractor. `BillingAdapter`
// above is therefore mostly a no-op for this provider (see `paystack.ts`), and the four
// methods on `SaasBillingProvider` are the ones that actually do work.
//
// THE TWO-PART SAFETY SWITCH.
//   BILLING_PROVIDER=paystack        → adapter active; webhooks reconcile; READS ONLY.
//   BILLING_CHARGING_ENABLED=true    → additionally permits new charges.
// `chargingEnabled` is `enabled && BILLING_CHARGING_ENABLED === "true"`. Default is off,
// and anything that would create a charge returns `{ ok:false, deferred:true }` while it
// is. Configuration is read LAZILY inside each call — a missing key never throws at
// import time and never breaks the rest of FleetWise.

/**
 * The only channel a subscription may be taken on. A recurring bill needs a REUSABLE
 * authorization, and only a card produces one — EFT/USSD/QR authorizations are one-shot,
 * so a farm set up on one would appear configured and then fail every renewal.
 */
export type PaystackChannel = "card";

export type CheckoutInit = {
  farmId: string;
  invoiceId: string;
  /** OUR reference, already persisted on `billing_payment_attempts` before this call. */
  reference: string;
  /** VAT-inclusive integer cents (ZAR subunits). */
  amountCents: number;
  email: string;
  /** Absolute, built from `NEXT_PUBLIC_SITE_URL` — never from the `Host` header. */
  callbackUrl: string;
  metadata: Record<string, string>;
};

export type CheckoutSession =
  | { ok: true; authorizationUrl: string; accessCode: string; reference: string }
  | { ok: false; deferred: true; reason: string }
  | { ok: false; deferred: false; reason: string; retryable: boolean };

/**
 * A stored card, as Paystack describes it. NEVER leaves the server: `authorizationCode`
 * is a charging credential (see the column comment in migration ...160100) and belongs
 * in the same mental category as a password.
 */
export type StoredAuthorization = {
  authorizationCode: string;
  reusable: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;
  cardType: string | null;
  bank: string | null;
  countryCode: string | null;
  bin: string | null;
  signature: string | null;
};

export type VerifiedTransaction = {
  reference: string;
  /** Paystack's own transaction id. 0 when the response did not carry one. */
  transactionId: number;
  status: "success" | "failed" | "abandoned" | "pending";
  amountCents: number;
  currency: string;
  channel: string | null;
  gatewayResponse: string | null;
  paidAt: string | null;
  customerCode: string | null;
  customerEmail: string | null;
  /** Present ONLY for a reusable card. NEVER leaves the server. */
  authorization: StoredAuthorization | null;
  /**
   * Why `authorization` is null despite Paystack having sent one. Set to
   * `"not_reusable"` when the transaction carried an authorization that may not be
   * charged again — so the caller can tell the farmer their card cannot be stored,
   * rather than the refusal being silently invisible.
   */
  authorizationRefused?: "not_reusable" | null;
  /**
   * True when the provider's own word was `reversed`.
   *
   * `status` folds that into `failed`, because an invoice whose money came back is not
   * paid. But a reversal is OUR refund or a chargeback — the customer's card worked — and
   * `failed` is also what starts the dunning ladder. Keeping the distinction here is what
   * lets the settle suppress the dunning without changing the invoice treatment.
   */
  reversed?: boolean;
  metadata: Record<string, unknown>;
};

export type VerifyResult =
  | { ok: true; transaction: VerifiedTransaction }
  | { ok: false; deferred: true; reason: string }
  | {
      ok: false;
      deferred: false;
      reason: string;
      /**
       * True when we could not REACH the provider — a timeout, a 5xx, a 429, an
       * unreadable body. Whether money moved is genuinely unknown.
       */
      retryable: boolean;
      /**
       * True ONLY when the provider processed the query and answered about THIS
       * reference: a `status:false` envelope, which for `transaction/verify` means "no
       * such transaction". It is deliberately NOT the inverse of `retryable`. A missing
       * API key, an unparseable 200 and a reference we never managed to send are all
       * non-retryable, and not one of them is an answer about the customer's money.
       *
       * The reconciler settles an attempt `abandoned` — which UNBLOCKS its invoice for
       * charging — only on `retryable === false && answered`. Widening that to plain
       * `!retryable` would unblock an in-flight `unknown` because OUR configuration
       * broke, and charging again on an attempt we never resolved is the exact failure
       * the whole claim/settle design exists to prevent.
       */
      answered: boolean;
    };

export type ChargeRequest = {
  farmId: string;
  invoiceId: string;
  /** OUR reference, already persisted before this call. */
  reference: string;
  amountCents: number;
  /** SERVER-ONLY charging credential. Never log it, never return it, never redirect with it. */
  authorizationCode: string;
  /** MUST be the email the authorization was created against, or Paystack refuses. */
  email: string;
  metadata: Record<string, string>;
};

/**
 * The provider contract for SaaS subscription billing.
 *
 * `verifyTransaction` and `verifyWebhookSignature` MUST keep working with charging
 * switched off: reconciliation of a payment already taken is not a new charge, and
 * switching the kill switch on must never orphan money that is already in flight.
 */
export interface SaasBillingProvider {
  readonly provider: string;
  /** A real provider is configured (`BILLING_PROVIDER` + a secret key). */
  readonly enabled: boolean;
  /** Configured AND the charging kill switch is on. */
  readonly chargingEnabled: boolean;

  /** Hosted checkout — the first payment, which is also how the card gets stored. */
  initializeCheckout(init: CheckoutInit): Promise<CheckoutSession>;
  /** Ask what happened to one reference. The ONLY safe recovery from a lost response. */
  verifyTransaction(reference: string): Promise<VerifyResult>;
  /** A scheduled recurring charge against a stored authorization. */
  chargeAuthorization(req: ChargeRequest): Promise<VerifyResult>;
  /** HMAC-SHA512 of the RAW body against the secret key, compared timing-safely. */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean;
}
