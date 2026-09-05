/**
 * Billing adapter resolver. Env-gated seam: `BILLING_PROVIDER` selects the adapter.
 *
 * Two adapters exist:
 *
 *   noop      — the default, and the resting state of a fresh clone, of CI, and of
 *               production until the founder switches billing on. Plans and entitlements
 *               are fully enforced; nothing charges anyone.
 *   paystack  — the real one (`./paystack`). Hosted checkout, server-to-server verify,
 *               charge-authorization for renewals, HMAC-SHA512 webhook verification.
 *
 * SCOPE: this is FARMS PAYING RAPID RISE for FleetWise. It is not, and must never become,
 * the money that moves between a farm and its contractors — that is `partner_documents` /
 * `partner_payments`, and its dormant PayFast seam lives in `src/lib/payments/*` and stays
 * inert. Nothing here may import from there.
 *
 * THE TWO-PART SAFETY SWITCH, and why it is two parts:
 *
 *   BILLING_PROVIDER=paystack       the adapter is live. Webhooks are verified and money
 *                                   already taken is RECONCILED — but nothing new is
 *                                   charged.
 *   BILLING_CHARGING_ENABLED=true   additionally permits NEW charges.
 *
 * Splitting them is what makes the rollback safe. Turning charging off stops any further
 * rand moving while leaving the ledger reconciling payments that are already in flight;
 * the alternative — pulling the provider entirely — would strand a customer who paid
 * thirty seconds before somebody hit the switch.
 *
 * Every value is read LAZILY, inside the call (see `./config`), so a missing key can
 * never throw at import time and can never break the rest of FleetWise.
 */

import type { BillingAdapter, SaasBillingProvider } from "./types";
import { NoopBillingAdapter } from "./noop";
import { PaystackBillingAdapter } from "./paystack";
import { billingProvider } from "./config";

export type {
  BillingAdapter,
  BillingResult,
  SubscriptionIntent,
  SubscriptionSnapshot,
  SaasBillingProvider,
  CheckoutInit,
  CheckoutSession,
  ChargeRequest,
  VerifiedTransaction,
  VerifyResult,
} from "./types";

let cached: BillingAdapter | null = null;

/**
 * Caching the instance is safe, and deliberately so: the adapter holds no configuration.
 * `enabled` and `chargingEnabled` are getters that re-read the environment on every call,
 * so the kill switch is answered from the environment as it is NOW, not as it was when
 * the first request of the process happened to arrive.
 */
export function getBillingAdapter(): BillingAdapter {
  if (cached) return cached;
  switch (billingProvider()) {
    case "paystack":
      cached = new PaystackBillingAdapter();
      break;
    case "noop":
    default:
      cached = new NoopBillingAdapter();
      break;
  }
  return cached;
}

/**
 * The richer SaaS-billing surface (hosted checkout, verify, charge-authorization,
 * webhook signature) — available only from a provider that implements it.
 *
 * Returns null for the no-op adapter rather than a stub that pretends. A caller holding
 * null must degrade visibly: say billing is not switched on. A stub that silently
 * answered "not charged" would be indistinguishable from a failed charge, and those two
 * need very different handling.
 */
export function getSaasBillingProvider(): SaasBillingProvider | null {
  const adapter = getBillingAdapter();
  return adapter instanceof PaystackBillingAdapter ? adapter : null;
}

/** True when a real payment provider is wired. Says NOTHING about whether it may charge. */
export function isBillingEnabled(): boolean {
  return getBillingAdapter().enabled;
}

/** True only when a provider is wired AND the charging kill switch is on. */
export function isChargingEnabled(): boolean {
  return getSaasBillingProvider()?.chargingEnabled ?? false;
}

/** Test seam. Never called in production code. */
export function __resetBillingAdapterCache(): void {
  cached = null;
}
