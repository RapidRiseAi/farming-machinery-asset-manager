import "server-only";
import { createHash } from "node:crypto";

/**
 * PayFast — letting a customer pay an invoice with a card or an instant EFT (G10).
 *
 * PayFast rather than Stripe because the customers are South African farms: PayFast
 * carries Ozow/instant EFT and the local card acquirers, which is how most of this money
 * actually moves. The rest of the product treats it as one implementation of a small
 * interface, so a partner on a different provider is a new file, not a rewrite.
 *
 * ── The signature ────────────────────────────────────────────────────────────
 *
 * PayFast signs by concatenating the fields IN THE ORDER THEY APPEAR, urlencoded, and
 * taking an MD5. Three details in that sentence are where implementations go wrong, and
 * all three are handled below:
 *
 *   1. "In the order they appear" means the order of the FORM, not alphabetical. Sorting
 *      the keys produces a signature that is wrong every time.
 *   2. PayFast's encoding is PHP's `urlencode`: spaces become `+` (not `%20`) and the hex
 *      digits are UPPERCASE. `encodeURIComponent` gives neither.
 *   3. Empty fields are omitted entirely. Sending `cell_number=` breaks the signature.
 *
 * ── Why the callback is verified three ways ──────────────────────────────────
 *
 * The ITN is an unauthenticated POST from the internet to a public URL. Anyone can send
 * one claiming an invoice was paid. So it is only believed when all of the following
 * hold: the signature recomputes, the amount matches what we asked for, and PayFast
 * itself confirms it when we hand the payload back to them. The last one is the important
 * one — it is the only step an attacker cannot forge, because it is a request WE make to
 * a host WE choose.
 */

const LIVE = "https://www.payfast.co.za";
const SANDBOX = "https://sandbox.payfast.co.za";

export type PayFastConfig = {
  merchantId: string;
  merchantKey: string;
  passphrase: string | null;
  sandbox: boolean;
};

export function payfastConfig(): PayFastConfig | null {
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  if (!merchantId || !merchantKey) return null;
  return {
    merchantId,
    merchantKey,
    passphrase: process.env.PAYFAST_PASSPHRASE || null,
    sandbox: process.env.PAYFAST_SANDBOX === "1",
  };
}

export function payfastHost(cfg: PayFastConfig): string {
  return cfg.sandbox ? SANDBOX : LIVE;
}

/** PHP's `urlencode`: `%20` becomes `+`, and hex digits are upper case. */
function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
}

/**
 * The signature over an ordered field list.
 *
 * `fields` must already be in PayFast's expected order — an array of pairs rather than an
 * object, precisely so that nothing downstream can reorder them by accident.
 */
export function signFields(fields: [string, string][], passphrase: string | null): string {
  const parts = fields
    .filter(([k, v]) => k !== "signature" && v !== "" && v != null)
    .map(([k, v]) => `${k}=${phpUrlEncode(String(v).trim())}`);
  if (passphrase) parts.push(`passphrase=${phpUrlEncode(passphrase.trim())}`);
  return createHash("md5").update(parts.join("&")).digest("hex");
}

export type PayFastCheckout = {
  /** Our own reference — the document id, so the ITN can find its way back. */
  paymentId: string;
  amountCents: number;
  itemName: string;
  itemDescription?: string;
  buyerEmail?: string | null;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
};

/**
 * The fields for a checkout, in PayFast's order, with the signature appended.
 *
 * The amount is sent in RANDS with two decimals — PayFast's API is not in cents, which is
 * the one place in this codebase money leaves integer arithmetic. It happens exactly here,
 * at the boundary, and comes back to cents in `parseAmount` below.
 */
export function checkoutFields(cfg: PayFastConfig, c: PayFastCheckout): [string, string][] {
  const fields: [string, string][] = [
    ["merchant_id", cfg.merchantId],
    ["merchant_key", cfg.merchantKey],
    ["return_url", c.returnUrl],
    ["cancel_url", c.cancelUrl],
    ["notify_url", c.notifyUrl],
  ];
  if (c.buyerEmail) fields.push(["email_address", c.buyerEmail]);
  fields.push(["m_payment_id", c.paymentId]);
  fields.push(["amount", (c.amountCents / 100).toFixed(2)]);
  fields.push(["item_name", c.itemName.slice(0, 100)]);
  if (c.itemDescription) fields.push(["item_description", c.itemDescription.slice(0, 255)]);

  fields.push(["signature", signFields(fields, cfg.passphrase)]);
  return fields;
}

/** Rands as PayFast sends them ("1150.00") back to integer cents, without float drift. */
export function parseAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number.parseInt(m[1], 10) * 100 + Number.parseInt((m[2] ?? "00").padEnd(2, "0"), 10);
}

export type ItnResult =
  | { ok: true; paymentId: string; amountCents: number; providerRef: string }
  | { ok: false; reason: string };

/**
 * Decide whether an ITN is real.
 *
 * `expectedAmountCents` is looked up from OUR record of what was owed, and compared here
 * rather than trusted from the callback — otherwise a forged ITN could mark a R40 000
 * invoice paid with a R1 payment.
 */
export async function verifyItn(
  cfg: PayFastConfig,
  body: URLSearchParams,
  expectedAmountCents: (paymentId: string) => Promise<number | null>,
): Promise<ItnResult> {
  const paymentId = body.get("m_payment_id") ?? "";
  const providerRef = body.get("pf_payment_id") ?? "";
  const status = body.get("payment_status") ?? "";
  if (!paymentId || !providerRef) return { ok: false, reason: "missing-ids" };

  // Only a completed payment is money. PayFast also sends CANCELLED and FAILED.
  if (status !== "COMPLETE") return { ok: false, reason: `status-${status.toLowerCase() || "unknown"}` };

  // 1. The signature, over the fields in the order they arrived.
  const received = body.get("signature") ?? "";
  const pairs: [string, string][] = [];
  body.forEach((v, k) => {
    if (k !== "signature") pairs.push([k, v]);
  });
  if (signFields(pairs, cfg.passphrase) !== received) return { ok: false, reason: "bad-signature" };

  // 2. The amount, against what we actually asked for.
  const paid = parseAmount(body.get("amount_gross"));
  const expected = await expectedAmountCents(paymentId);
  if (paid == null || expected == null) return { ok: false, reason: "unknown-amount" };
  if (paid !== expected) return { ok: false, reason: `amount-mismatch-${paid}-vs-${expected}` };

  // 3. PayFast's own confirmation. The step an attacker cannot forge, because it is a
  //    request we make to a host we choose rather than one made to us.
  const res = await fetch(`${payfastHost(cfg)}/eng/query/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }).catch(() => null);
  const text = res ? (await res.text().catch(() => "")).trim() : "";
  if (text !== "VALID") return { ok: false, reason: `not-confirmed-${text.slice(0, 40) || "no-response"}` };

  return { ok: true, paymentId, amountCents: paid, providerRef };
}
