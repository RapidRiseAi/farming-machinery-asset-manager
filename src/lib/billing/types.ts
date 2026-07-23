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
