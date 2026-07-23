/**
 * Billing adapter resolver. Env-gated seam: `BILLING_PROVIDER` selects the adapter.
 * Today only "noop" exists (payments DEFERRED). When a provider is chosen after
 * research, add its module and one `case` below — nothing else changes.
 */

import type { BillingAdapter } from "./types";
import { NoopBillingAdapter } from "./noop";

export type { BillingAdapter, BillingResult, SubscriptionIntent, SubscriptionSnapshot } from "./types";

let cached: BillingAdapter | null = null;

export function getBillingAdapter(): BillingAdapter {
  if (cached) return cached;
  const provider = (process.env.BILLING_PROVIDER ?? "noop").toLowerCase();
  switch (provider) {
    // case "stripe":   cached = new StripeBillingAdapter();   break;  // ← future
    // case "paystack": cached = new PaystackBillingAdapter(); break;  // ← future
    case "noop":
    default:
      cached = new NoopBillingAdapter();
      break;
  }
  return cached;
}

/** True when a real payment provider is wired and able to charge. */
export function isBillingEnabled(): boolean {
  return getBillingAdapter().enabled;
}
