/**
 * No-op billing adapter — the default while payments are DEFERRED.
 *
 * It implements the full `BillingAdapter` contract but never contacts any provider and
 * never moves money. Every method returns `{ ok: false, deferred: true }` so callers can
 * safely "reconcile billing" as a no-op today and swap in a real adapter later with zero
 * call-site changes.
 */

import type {
  BillingAdapter,
  BillingResult,
  SubscriptionIntent,
  SubscriptionSnapshot,
} from "./types";

const deferred = (reason: string): BillingResult => ({ ok: false, deferred: true, reason });

export class NoopBillingAdapter implements BillingAdapter {
  readonly provider = "noop";
  readonly enabled = false;

  async ensureCustomer(_snapshot: SubscriptionSnapshot): Promise<BillingResult> {
    return deferred("payments deferred: no billing provider configured");
  }

  async syncSubscription(_intent: SubscriptionIntent): Promise<BillingResult> {
    return deferred("payments deferred: no billing provider configured");
  }

  async syncAssetCount(_farmId: string, _assetCount: number): Promise<BillingResult> {
    return deferred("payments deferred: no billing provider configured");
  }

  async cancel(_farmId: string): Promise<BillingResult> {
    return deferred("payments deferred: no billing provider configured");
  }
}
