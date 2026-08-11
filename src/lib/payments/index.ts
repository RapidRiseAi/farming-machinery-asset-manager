import "server-only";
import { payfastConfig, payfastHost, checkoutFields, type PayFastCheckout } from "./payfast";

/**
 * Letting a customer pay an invoice online (G10).
 *
 * Env-gated, like email: with no provider configured the button is not offered and the
 * screen says plainly that online payment is not switched on, rather than showing a
 * control that fails when pressed. Recording a payment by hand works exactly as before —
 * this only adds a second way for money to arrive.
 *
 * One implementation today (PayFast, because the customers are South African farms), but
 * behind a resolver so a second is a new file rather than a rewrite.
 */

export type PaymentProvider = "payfast" | null;

export function activeProvider(): PaymentProvider {
  const name = (process.env.PAYMENTS_PROVIDER ?? "").toLowerCase();
  if (name === "payfast" && payfastConfig()) return "payfast";
  return null;
}

export function paymentsEnabled(): boolean {
  return activeProvider() !== null;
}

export type CheckoutForm = { action: string; fields: [string, string][] };

/**
 * The form a customer's browser posts to start a payment.
 *
 * A POSTed form rather than a redirect URL: PayFast's signature covers the fields, and a
 * signature in a query string is a signature in browser history, in access logs and in
 * the `Referer` header — the same reasoning that moved the contractor login link out of a
 * query string in the security pass.
 */
export function buildCheckout(c: PayFastCheckout): CheckoutForm | null {
  if (activeProvider() !== "payfast") return null;
  const cfg = payfastConfig();
  if (!cfg) return null;
  return {
    action: `${payfastHost(cfg)}/eng/process`,
    fields: checkoutFields(cfg, c),
  };
}
