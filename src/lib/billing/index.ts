/**
 * Billing adapter resolver. Env-gated seam: `BILLING_PROVIDER` selects the adapter.
 *
 * Two adapters exist:
 *
 *   noop     , the default, and the resting state of a fresh clone, of CI, and of
 *               production until the founder switches billing on. Plans and entitlements
 *               are fully enforced; nothing charges anyone.
 *   paystack , the real one (`./paystack`). Hosted checkout, server-to-server verify,
 *               charge-authorization for renewals, HMAC-SHA512 webhook verification.
 *
 * SCOPE: this is FARMS PAYING RAPID RISE for FLEETWISE. It is not, and must never become,
 * the money that moves between a farm and its contractors, that is `partner_documents` /
 * `partner_payments`, and its dormant PayFast seam lives in `src/lib/payments/*` and stays
 * inert. Nothing here may import from there.
 *
 * THE TWO-PART SAFETY SWITCH, and why it is two parts:
 *
 *   BILLING_PROVIDER=paystack       the adapter is live. Webhooks are verified and money
 *                                   already taken is RECONCILED, but nothing new is
 *                                   charged.
 *   BILLING_CHARGING_ENABLED=true   additionally permits NEW charges.
 *
 * Splitting them is what makes the rollback safe. Turning charging off stops any further
 * rand moving while leaving the ledger reconciling payments that are already in flight;
 * the alternative, pulling the provider entirely, would strand a customer who paid
 * thirty seconds before somebody hit the switch.
 *
 * Every value is read LAZILY, inside the call (see `./config`), so a missing key can
 * never throw at import time and can never break the rest of FLEETWISE.
 */

import type { BillingAdapter } from "./types";
import { NoopBillingAdapter } from "./noop";
import { PaystackBillingAdapter } from "./paystack";
import { billingProvider } from "./config";

// The other types live in ./types and are imported from there.
export type { BillingAdapter } from "./types";

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
