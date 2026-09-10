/**
 * The Paystack adapter — the only place in FleetWise that talks to a card processor
 * about a SaaS subscription.
 *
 * SCOPE, stated once more because it is the thing most likely to be got wrong later:
 * this is FARMS PAYING RAPID RISE for FleetWise software. One direction. It is not the
 * money between a farm and its contractors (that is `partner_documents` /
 * `partner_payments`), and it must never grow a transfer, a split, a subaccount or a
 * payout. If a later reader finds themselves importing `src/lib/payments/*` from here,
 * the design has gone wrong.
 *
 * WHAT THIS ADAPTER IS AND IS NOT RESPONSIBLE FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * It is responsible for: speaking HTTP to Paystack, normalising the answer, refusing to
 * act when it must not, and telling the caller whether a failure is worth retrying.
 *
 * It is NOT responsible for: minting references (the database does, BEFORE we are
 * called), deciding whether an invoice may be charged (`app.claim_billing_charge` does,
 * behind a unique index), or recording the outcome (`app.settle_billing_attempt` does).
 * The three-step sequence is claim → charge → settle with NO transaction held across
 * the HTTP call, and this file is only the middle step.
 *
 * RETRYABLE vs TERMINAL — the distinction the whole recovery story rests on
 * ─────────────────────────────────────────────────────────────────────────────
 * A `{ ok:false, deferred:false }` result carries `retryable`, and it is not a hint:
 *
 *   retryable: true   → we do not know what happened. A timeout, a 5xx, a dropped
 *                       connection, an unreadable body. The attempt must be settled
 *                       `unknown`, which BLOCKS every further attempt on that invoice
 *                       until somebody verifies that exact reference. Charging again
 *                       is how a farmer gets billed twice.
 *   retryable: false  → Paystack answered and said no. A declined card, a bad request,
 *                       an authorization that may not be reused. Settle `failed`, run
 *                       the dunning policy, move on.
 *
 * Getting this backwards in either direction is expensive: treat a timeout as terminal
 * and we lose a payment that succeeded; treat a decline as unknown and the invoice
 * jams for ever.
 *
 * WHAT NEVER LEAVES THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * The secret key, an `authorization_code`, and a customer's email address. Not in an
 * Error, not in a returned `reason`, not in a log line, not in a Sentry extra. Provider
 * messages are passed through `redact()` before they are returned, because "Customer
 * with email … not found" is exactly the sort of message a payment API sends.
 *
 * THE TWO-PART SAFETY SWITCH
 * ─────────────────────────────────────────────────────────────────────────────
 * `enabled` = a provider and a key are configured. `chargingEnabled` = that AND the kill
 * switch is on. Both are read LAZILY, per call. Everything that would move money checks
 * `chargingEnabled` FIRST and returns `{ ok:false, deferred:true }` without making an
 * HTTP request — while `verifyTransaction` and `verifyWebhookSignature` deliberately
 * keep working with charging off, because reconciling money already taken is not a new
 * charge, and flipping the switch must never orphan a payment in flight.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  BILLING_CURRENCY,
  MAX_WEBHOOK_BODY_BYTES,
  PAYSTACK_BASE_URL,
  chargingEnabled as isChargingEnabled,
  paystackConfig,
  redact,
} from "./config";
import type {
  BillingAdapter,
  BillingResult,
  ChargeRequest,
  CheckoutInit,
  CheckoutSession,
  PaystackChannel,
  SaasBillingProvider,
  StoredAuthorization,
  SubscriptionIntent,
  SubscriptionSnapshot,
  VerifiedTransaction,
  VerifyResult,
} from "./types";

/**
 * Metadata keys the webhook re-verification matches on. Exported so the route that
 * checks them and the adapter that writes them cannot drift into using different names
 * — a mismatch there would silently refuse every legitimate payment.
 */
export const METADATA_FARM_KEY = "farm_id";
export const METADATA_INVOICE_KEY = "invoice_id";

/** Card only. See `PaystackChannel` — nothing else yields a reusable authorization. */
const CHECKOUT_CHANNELS: PaystackChannel[] = ["card"];

/** A payment API that hangs must not hang the request that asked for it. */
const DEFAULT_TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PaystackAdapterOptions = {
  /** Injected in tests. No test in this repo may be capable of a live charge. */
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
};

type PaystackEnvelope = {
  status?: unknown;
  message?: unknown;
  data?: unknown;
};

type ApiResult =
  | { ok: true; data: Record<string, unknown>; message: string }
  // `answered` = Paystack processed this request and refused it, as opposed to us being
  // unable to ask. See the note on `VerifyResult.answered` — the reconciler's decision to
  // close an attempt turns on this distinction and not on `retryable`.
  | { ok: false; reason: string; retryable: boolean; answered: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Paystack sometimes returns `metadata` as a JSON STRING rather than an object — it
 * echoes back whatever shape it managed to store. Both are handled; anything else
 * becomes an empty object rather than a crash on a payment path.
 */
function readMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isObject(raw) ? raw : {};
}

/**
 * Paystack's transaction statuses are a longer list than the four we model.
 *   success                              → success
 *   failed, reversed                     → failed
 *   abandoned                            → abandoned
 *   pending, ongoing, processing, queued → pending
 *
 * `reversed` maps to `failed` on purpose. A reversal means the money came back, and the
 * safe direction is "do not treat this invoice as paid"; the provider's own words are
 * preserved in `gatewayResponse` so a human reconciling it can see what actually
 * happened. An unrecognised status maps to `pending` — the state that asks a question
 * rather than answering one.
 */
function mapStatus(raw: unknown): VerifiedTransaction["status"] {
  const value = (str(raw) ?? "").toLowerCase();
  if (value === "success") return "success";
  if (value === "failed" || value === "reversed") return "failed";
  if (value === "abandoned") return "abandoned";
  return "pending";
}

/**
 * An authorization is accepted ONLY when Paystack says it may be charged again.
 *
 * A one-off authorization (some 3DS flows, some cards) comes back `reusable: false`.
 * Storing one as a subscription card produces a farm that looks set up and then fails
 * every renewal, which is the worst possible way to find out. The refusal is recorded
 * on the transaction (`authorizationRefused`) rather than dropped, so the caller can
 * tell the farmer their card cannot be stored instead of the card silently vanishing.
 */
function readAuthorization(raw: unknown): {
  authorization: StoredAuthorization | null;
  refused: "not_reusable" | null;
} {
  if (!isObject(raw)) return { authorization: null, refused: null };
  const code = str(raw.authorization_code);
  if (!code) return { authorization: null, refused: null };
  if (raw.reusable !== true) return { authorization: null, refused: "not_reusable" };
  return {
    authorization: {
      authorizationCode: code,
      reusable: true,
      brand: str(raw.brand),
      last4: str(raw.last4),
      expMonth: str(raw.exp_month),
      expYear: str(raw.exp_year),
      cardType: str(raw.card_type),
      bank: str(raw.bank),
      countryCode: str(raw.country_code),
      bin: str(raw.bin),
      signature: str(raw.signature),
    },
    refused: null,
  };
}

/** Normalise a `data` object from initialize / verify / charge_authorization. */
export function toVerifiedTransaction(data: Record<string, unknown>): VerifiedTransaction {
  const customer = isObject(data.customer) ? data.customer : {};
  const { authorization, refused } = readAuthorization(data.authorization);
  const idRaw = Number(data.id);
  const amountRaw = Number(data.amount);

  return {
    reference: str(data.reference) ?? "",
    transactionId: Number.isSafeInteger(idRaw) && idRaw > 0 ? idRaw : 0,
    status: mapStatus(data.status),
    amountCents: Number.isSafeInteger(amountRaw) ? amountRaw : 0,
    currency: (str(data.currency) ?? "").toUpperCase(),
    channel: str(data.channel),
    gatewayResponse: str(data.gateway_response),
    paidAt: str(data.paid_at) ?? str(data.paidAt),
    customerCode: str(customer.customer_code),
    customerEmail: str(customer.email),
    authorization,
    authorizationRefused: refused,
    metadata: readMetadata(data.metadata),
  };
}

// ── Matching a transaction against what we expected ───────────────────────────

export type ExpectedCharge = {
  /** The reference WE minted and persisted before contacting Paystack. */
  reference: string;
  /** VAT-inclusive integer cents, from `billing_invoices.total_incl_cents`. */
  amountCents: number;
  farmId: string;
  invoiceId: string;
  currency?: string;
};

export type ChargeMatch = { ok: true } | { ok: false; mismatches: string[] };

/**
 * Everything that must line up before a transaction is allowed to mark an invoice paid
 * (contract §6.7). One helper rather than a check written twice, because the webhook and
 * the reconciliation worker both have to apply exactly the same rule and a webhook that
 * is fractionally more permissive is the whole attack.
 *
 * Only FIELD NAMES come back on a mismatch. Never the values: one of them is an amount
 * of money and another is somebody's farm.
 */
export function matchesExpectedCharge(
  txn: VerifiedTransaction,
  expected: ExpectedCharge,
): ChargeMatch {
  const mismatches: string[] = [];
  if (txn.reference !== expected.reference) mismatches.push("reference");
  if (txn.amountCents !== expected.amountCents) mismatches.push("amount");
  if (txn.currency !== (expected.currency ?? BILLING_CURRENCY)) mismatches.push("currency");
  if (txn.status !== "success") mismatches.push("status");
  if (str(txn.metadata[METADATA_FARM_KEY]) !== expected.farmId) mismatches.push(METADATA_FARM_KEY);
  if (str(txn.metadata[METADATA_INVOICE_KEY]) !== expected.invoiceId) {
    mismatches.push(METADATA_INVOICE_KEY);
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

// ── The adapter ───────────────────────────────────────────────────────────────

export class PaystackBillingAdapter implements BillingAdapter, SaasBillingProvider {
  readonly provider = "paystack";

  private readonly fetchImpl: FetchLike | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: PaystackAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = (options.baseUrl ?? PAYSTACK_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Lazily read, every time. Never cached — the switch has to be answerable now. */
  get enabled(): boolean {
    return paystackConfig().ok;
  }

  get chargingEnabled(): boolean {
    return isChargingEnabled();
  }

  // ── BillingAdapter: deliberately inert for this provider ────────────────────
  //
  // Paystack holds no plan, no price, no period and no entitlement — all of that lives
  // in `billing_subscriptions`, because the amount changes with the farm's vehicle count
  // and a fixed provider-side subscription object would be wrong the moment a tractor is
  // sold. These four methods therefore have nothing to sync. They report that plainly
  // rather than pretending to have done something, and they do not return `deferred`
  // when we ARE configured — "deferred" means "no provider", and a caller that logged it
  // would be told the wrong thing.

  private notApplicable(what: string): BillingResult {
    if (!this.enabled) {
      return { ok: false, deferred: true, reason: "billing provider is not configured" };
    }
    return {
      ok: true,
      note: `${what}: subscription state is held in FleetWise; Paystack holds no plan, price or period`,
    };
  }

  async ensureCustomer(_snapshot: SubscriptionSnapshot): Promise<BillingResult> {
    // A Paystack customer is created implicitly by the first transaction, and its code
    // comes back on verify. Nothing to do up front.
    return this.notApplicable("ensureCustomer");
  }

  async syncSubscription(_intent: SubscriptionIntent): Promise<BillingResult> {
    return this.notApplicable("syncSubscription");
  }

  async syncAssetCount(_farmId: string, _assetCount: number): Promise<BillingResult> {
    // The count is read live by `app.billable_asset_count` when the invoice is raised.
    return this.notApplicable("syncAssetCount");
  }

  async cancel(_farmId: string): Promise<BillingResult> {
    // There is no provider-side subscription to cancel. Cancellation is a write to
    // `billing_subscriptions`; the stored card simply stops being charged.
    return this.notApplicable("cancel");
  }

  // ── SaasBillingProvider ─────────────────────────────────────────────────────

  async initializeCheckout(init: CheckoutInit): Promise<CheckoutSession> {
    if (!this.chargingEnabled) {
      return { ok: false, deferred: true, reason: this.offReason() };
    }

    const invalid =
      this.amountProblem(init.amountCents) ??
      (nonEmpty(init.reference) ? null : "reference is required") ??
      (nonEmpty(init.email) ? null : "customer email is required") ??
      (this.callbackProblem(init.callbackUrl));
    if (invalid) return { ok: false, deferred: false, reason: invalid, retryable: false };

    const res = await this.request("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: init.email,
        amount: init.amountCents,
        currency: BILLING_CURRENCY,
        reference: init.reference,
        callback_url: init.callbackUrl,
        channels: CHECKOUT_CHANNELS,
        metadata: this.metadataFor(init.metadata, init.farmId, init.invoiceId),
      }),
    });
    if (!res.ok) return { ok: false, deferred: false, reason: res.reason, retryable: res.retryable };

    const authorizationUrl = str(res.data.authorization_url);
    const accessCode = str(res.data.access_code);
    const reference = str(res.data.reference) ?? init.reference;
    if (!authorizationUrl || !accessCode) {
      // A 200 that is missing the URL we are meant to send the customer to. Not worth
      // retrying blindly — but the attempt still holds our reference, so it is
      // recoverable by verifying it, which is the correct next move either way.
      return {
        ok: false,
        deferred: false,
        reason: "provider did not return a checkout link",
        retryable: false,
      };
    }
    return { ok: true, authorizationUrl, accessCode, reference };
  }

  /**
   * Ask what happened to one reference.
   *
   * MUST keep working with charging switched off: this is the only safe recovery from a
   * lost HTTP response, and an attempt stuck in `unknown` blocks its invoice until it is
   * answered. Gating this on the kill switch would mean turning charging off strands
   * every payment that was already in flight.
   */
  async verifyTransaction(reference: string): Promise<VerifyResult> {
    if (!this.enabled) {
      return { ok: false, deferred: true, reason: "billing provider is not configured" };
    }
    if (!nonEmpty(reference)) {
      // We never asked about anything, so there is nothing to have been answered.
      return {
        ok: false,
        deferred: false,
        reason: "reference is required",
        retryable: false,
        answered: false,
      };
    }

    const res = await this.request(`/transaction/verify/${encodeURIComponent(reference.trim())}`, {
      method: "GET",
    });
    if (!res.ok) {
      return {
        ok: false,
        deferred: false,
        reason: res.reason,
        retryable: res.retryable,
        answered: res.answered,
      };
    }
    return { ok: true, transaction: toVerifiedTransaction(res.data) };
  }

  async chargeAuthorization(req: ChargeRequest): Promise<VerifyResult> {
    if (!this.chargingEnabled) {
      return { ok: false, deferred: true, reason: this.offReason() };
    }

    const invalid =
      this.amountProblem(req.amountCents) ??
      (nonEmpty(req.reference) ? null : "reference is required") ??
      (nonEmpty(req.authorizationCode) ? null : "no stored card for this farm") ??
      (nonEmpty(req.email) ? null : "authorization email is required");
    if (invalid) {
      return { ok: false, deferred: false, reason: invalid, retryable: false, answered: false };
    }

    const res = await this.request("/transaction/charge_authorization", {
      method: "POST",
      body: JSON.stringify({
        // Paystack refuses an authorization presented with a different address, so this
        // MUST be `billing_payment_methods.authorization_email` — part of the credential
        // — and not whatever the user has since changed `users.email` to.
        authorization_code: req.authorizationCode,
        email: req.email,
        amount: req.amountCents,
        currency: BILLING_CURRENCY,
        reference: req.reference,
        metadata: this.metadataFor(req.metadata, req.farmId, req.invoiceId),
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        deferred: false,
        reason: res.reason,
        retryable: res.retryable,
        answered: res.answered,
      };
    }
    return { ok: true, transaction: toVerifiedTransaction(res.data) };
  }

  /**
   * HMAC-SHA512 of the RAW body, keyed with the secret key, compared timing-safely.
   * There is no separate webhook secret at Paystack — the signing key IS the API key.
   *
   * Four refusals before any comparison happens, each for its own reason:
   *   - no signature header at all → an unsigned delivery is never legitimate;
   *   - nothing configured → we have no key to check against, so we cannot say yes;
   *   - an empty body → there is no Paystack event with an empty payload, and hashing
   *     nothing invites somebody to reason about what a valid empty event would be;
   *   - an oversized body → refuse before burning CPU on an HMAC for a caller we have
   *     not decided to trust.
   *
   * The length check before `timingSafeEqual` is not a nicety: that function THROWS on
   * buffers of unequal length, and an exception on the webhook path is a 500, which
   * Paystack reads as "retry", which turns a malformed probe into a redelivery storm.
   */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (typeof signature !== "string" || signature.trim() === "") return false;
    if (typeof rawBody !== "string" || rawBody.length === 0) return false;
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) return false;

    const cfg = paystackConfig();
    if (!cfg.ok) return false;

    const expected = createHmac("sha512", cfg.secretKey).update(rawBody, "utf8").digest("hex");
    // Hex is case-insensitive and a proxy may have changed the case; normalising it
    // leaks nothing, whereas rejecting a valid signature over capitalisation would.
    const provided = signature.trim().toLowerCase();

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private offReason(): string {
    return this.enabled
      ? "charging is switched off (BILLING_CHARGING_ENABLED)"
      : "billing provider is not configured";
  }

  /** Amounts are integer ZAR subunits. Zero is not a charge; a fraction is a bug. */
  private amountProblem(amountCents: number): string | null {
    if (!Number.isSafeInteger(amountCents)) return "amount must be a whole number of cents";
    if (amountCents <= 0) return "amount must be greater than zero";
    return null;
  }

  /**
   * The callback must be an absolute http(s) URL. It is built from
   * `NEXT_PUBLIC_SITE_URL` upstream; refusing anything else here means a `Host`-header
   * value can never become the place a paying customer is returned to.
   */
  private callbackProblem(callbackUrl: string): string | null {
    if (!nonEmpty(callbackUrl)) return "callback URL is required";
    try {
      const url = new URL(callbackUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "callback URL is not valid";
      return null;
    } catch {
      return "callback URL is not valid";
    }
  }

  /**
   * The farm and invoice ids are written by the ADAPTER, last, so they always exist and
   * a caller cannot accidentally (or otherwise) put a different farm's id on a
   * transaction that the webhook will then match against.
   */
  private metadataFor(
    caller: Record<string, string>,
    farmId: string,
    invoiceId: string,
  ): Record<string, string> {
    return { ...caller, [METADATA_FARM_KEY]: farmId, [METADATA_INVOICE_KEY]: invoiceId };
  }

  private async request(path: string, init: RequestInit): Promise<ApiResult> {
    const cfg = paystackConfig();
    // Not retryable in the "try again in a minute" sense, but emphatically NOT an answer:
    // our key is missing, so nobody has asked Paystack anything.
    if (!cfg.ok) {
      return {
        ok: false,
        reason: "billing provider is not configured",
        retryable: false,
        answered: false,
      };
    }

    const doFetch: FetchLike =
      this.fetchImpl ??
      ((input, options) => (globalThis.fetch as unknown as FetchLike)(input, options));

    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.secretKey}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // We do not know whether the request reached Paystack, so this is RETRYABLE in the
      // specific sense that matters here: settle the attempt `unknown` and reconcile the
      // reference. It must never mean "send the charge again".
      const name = err instanceof Error ? err.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return {
        ok: false,
        reason: timedOut ? "payment provider timed out" : "payment provider unreachable",
        retryable: true,
        answered: false,
      };
    }

    const text = await res.text().catch(() => "");

    let body: PaystackEnvelope | null = null;
    try {
      const parsed: unknown = text ? JSON.parse(text) : null;
      body = isObject(parsed) ? (parsed as PaystackEnvelope) : null;
    } catch {
      body = null;
    }

    const message = redact(str(body?.message) ?? "");

    if (!res.ok) {
      // 5xx / 429 / 408: their side, or ours being asked to slow down — the outcome is
      // genuinely unknown. Every other 4xx is Paystack telling us no, which is an answer.
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      return {
        ok: false,
        reason: message || `payment provider returned ${res.status}`,
        retryable,
        // A 404 for a verify carries `status:false` — Paystack telling us, in its own
        // envelope, that it has never heard of this reference. A 502 from a proxy in
        // front of the API carries no envelope at all and answers nothing.
        answered: body ? body.status !== true : false,
      };
    }

    if (!body || body.status !== true) {
      // A 200 with `status:false` is a refusal, not an outage: a declined charge, a bad
      // reference, an authorization that may not be reused. Terminal.
      if (body) {
        return {
          ok: false,
          reason: message || "payment provider refused the request",
          retryable: false,
          answered: true,
        };
      }
      // A 200 that is not JSON at all is almost always a proxy or an error page in
      // front of the API, which is transient and therefore unknown, not refused.
      return {
        ok: false,
        reason: "payment provider returned an unreadable response",
        retryable: true,
        answered: false,
      };
    }

    if (!isObject(body.data)) {
      // A 200 with `status:true` and no data object is malformed, not a refusal. We have
      // no answer about the reference, so this must never close an attempt.
      return {
        ok: false,
        reason: "payment provider returned no data",
        retryable: false,
        answered: false,
      };
    }

    return { ok: true, data: body.data, message };
  }
}
