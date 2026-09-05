/**
 * SaaS billing — the Paystack webhook, as logic rather than as a route.
 *
 * The route handler holds the raw bytes and nothing else; every decision is here, so the
 * rules can be exercised by a unit test with a fake Supabase and a fake provider and no
 * network anywhere near them.
 *
 * ── The order, and why each step is where it is ───────────────────────────────
 *
 *  1. SIZE. Refuse a body over 1 MB BEFORE hashing it. Paystack's events are a few
 *     kilobytes; a megabyte is either a bug or somebody making us burn CPU on an HMAC for
 *     a caller we have not decided to trust yet.
 *  2. SIGNATURE, before anything is parsed and before any field is believed. HMAC-SHA512
 *     of the RAW body keyed with the secret key, compared timing-safely, with a length
 *     check first because `timingSafeEqual` THROWS on unequal buffers — and a throw on
 *     this path is a 500, which Paystack reads as "retry", which turns a malformed probe
 *     into a redelivery storm.
 *  3. PERSIST, idempotently on `(provider, dedupe_key)`, BEFORE any side effect. A side
 *     effect we cannot prove we wrote down is a payment with no evidence.
 *  4. A DUPLICATE does nothing at all beyond raising `delivery_count`, and answers 200.
 *  5. RE-VERIFY server-to-server. The payload is a hint; `transaction/verify` is the
 *     truth. Nothing in a webhook body marks an invoice paid on its own authority.
 *  6. MATCH exactly — our stored reference, the expected amount, ZAR, `status: success`,
 *     and the farm and invoice in the metadata. Any mismatch is recorded and REFUSED.
 *
 * ── Why we answer 200 even when we could not finish ───────────────────────────
 * Paystack expects `200 OK`, and retries anything else every 3 minutes for the first four
 * attempts and then hourly for 72 hours. A non-2xx therefore asks for three days of
 * redeliveries. But we have already persisted the dedupe key, so
 * the redelivery would arrive, be recognised as a duplicate, and do nothing — the worst
 * of both worlds: a retry storm that cannot possibly help. Our recovery for an event we
 * could not process is the RECONCILER, which verifies that exact reference on the next
 * pass and is strictly stronger than a redelivery, because it works even if Paystack
 * never sends the event again. So: anything we managed to RECORD returns 200, and the
 * only non-2xx answers are the ones where we recorded nothing (too large, unsigned, or
 * we failed to write the row at all).
 *
 * ── What must never be logged ─────────────────────────────────────────────────
 * The raw payload, the signature header, the secret, a customer email, an authorization
 * code. Nothing in this file writes to a log at all; the strings it stores in
 * `processing_error` go through `redactMessage` first, and mismatches are reported as
 * FIELD NAMES only — one of the values is an amount of money and another is somebody's
 * farm.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { MAX_WEBHOOK_BODY_BYTES } from "./config";
import { matchesExpectedCharge } from "./paystack";
import type { SaasBillingProvider, VerifiedTransaction } from "./types";
import {
  finishWebhookEvent,
  getAttemptByReference,
  recordWebhookEvent,
  redactMessage,
  settleBillingAttempt,
  storeAuthorization,
  type AttemptRow,
} from "./service";

export const WEBHOOK_PROVIDER = "paystack";

/**
 * Events that move money in our ledger.
 *
 * `charge.success` / `charge.failed` are the two Paystack actually sends for this flow.
 * `transaction.success` and `invoice.payment_failed` are accepted defensively — they cost
 * nothing to handle and both end up at the same `transaction/verify` call, which is the
 * only thing that decides anything. Every other event type is RECORDED and ignored, so a
 * new Paystack event never becomes an unhandled exception on a payment path.
 */
const SUCCESS_EVENTS = new Set(["charge.success", "transaction.success"]);
const FAILURE_EVENTS = new Set(["charge.failed", "invoice.payment_failed"]);

export type WebhookResult =
  /** Nothing was recorded and nothing happened. */
  | { status: 400 | 401 | 413 | 500; outcome: "rejected"; reason: string }
  /** Recorded. `outcome` says what, if anything, followed. */
  | {
      status: 200;
      outcome: "duplicate" | "ignored" | "processed" | "refused" | "deferred";
      reason?: string;
      eventType?: string;
    };

export type WebhookInput = {
  rawBody: string;
  signature: string | null;
  supabase: SupabaseClient;
  provider: SaasBillingProvider | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The idempotency key, computed from what is actually stable.
 *
 * Paystack sends no top-level event id, so `"<event>:<data.id>"` is the closest thing to
 * one: the transaction id is Paystack's own primary key and the event name distinguishes
 * a success from a failure on the same transaction. When either is missing we fall back
 * to a hash of the RAW body — which is exact, at the cost of treating a byte-different
 * re-serialisation of the same event as new. That direction is the safe one: a duplicate
 * we fail to recognise is caught by the transaction-id unique index on
 * `billing_payments`, whereas a false MATCH would silently drop a real event.
 */
export function dedupeKeyFor(rawBody: string, parsed: unknown): string {
  if (isObject(parsed)) {
    const event = asString(parsed.event);
    const data = isObject(parsed.data) ? parsed.data : null;
    const id = data ? data.id : null;
    if (event && (typeof id === "number" || typeof id === "string") && String(id).trim() !== "") {
      return `${event}:${String(id).trim()}`;
    }
  }
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

/** The whole webhook, from raw bytes to an HTTP status. */
export async function handlePaystackWebhook(input: WebhookInput): Promise<WebhookResult> {
  const { rawBody, signature, supabase, provider } = input;

  // 1 ── Size, before any hashing.
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    return { status: 400, outcome: "rejected", reason: "empty body" };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, outcome: "rejected", reason: "body too large" };
  }

  // 2 ── Signature, before parsing and before trusting one single field.
  if (!provider) {
    // No provider configured means no key to check against, so we cannot say yes. 401
    // rather than 500: this is a refusal, not a fault, and Paystack should not be told to
    // keep trying an endpoint that will never be able to answer.
    return { status: 401, outcome: "rejected", reason: "no provider configured" };
  }
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    return { status: 401, outcome: "rejected", reason: "signature" };
  }

  // Only now is it safe to look inside.
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parseFailed = true;
  }

  const eventType = (isObject(parsed) ? asString(parsed.event) : null) ?? "unparsed";
  const dedupeKey = dedupeKeyFor(rawBody, parsed);

  // 3 ── Persist before any side effect.
  const record = await recordWebhookEvent(supabase, {
    provider: WEBHOOK_PROVIDER,
    dedupeKey,
    eventType,
    signatureVerified: true,
    // A body we could not parse is stored as null rather than as a string: the column is
    // jsonb, and a half-JSON string in it would be evidence nobody can query.
    payload: parseFailed ? null : parsed,
  });
  if (record.error) {
    // We could not write it down, so we must not act on it. This IS a case where a
    // redelivery helps — nothing was recorded, so the retry will be treated as new.
    return { status: 500, outcome: "rejected", reason: record.error.message };
  }

  // 4 ── A duplicate does nothing.
  if (record.duplicate) {
    return { status: 200, outcome: "duplicate", eventType };
  }

  if (parseFailed) {
    // A validly SIGNED body that is not JSON. Recorded (the signature makes it evidence
    // about our own integration, not noise) and refused.
    await finishWebhookEvent(supabase, record.id, { error: "payload was not valid JSON" });
    return { status: 200, outcome: "refused", reason: "malformed payload", eventType };
  }

  const actionable = SUCCESS_EVENTS.has(eventType) || FAILURE_EVENTS.has(eventType);
  if (!actionable) {
    await finishWebhookEvent(supabase, record.id, { error: null });
    return { status: 200, outcome: "ignored", eventType };
  }

  const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : {};
  const reference = asString(data.reference);
  if (!reference) {
    await finishWebhookEvent(supabase, record.id, { error: "event carried no reference" });
    return { status: 200, outcome: "refused", reason: "no reference", eventType };
  }

  // The reference must be one WE minted. An event about a transaction we have no record
  // of is not ours to act on, whoever signed it.
  const attempt = await getAttemptByReference(supabase, reference);
  if (!attempt) {
    await finishWebhookEvent(supabase, record.id, {
      error: "no payment attempt matches this reference",
    });
    return { status: 200, outcome: "refused", reason: "unknown reference", eventType };
  }

  // Out of order: a `charge.failed` arriving after the success has already been recorded
  // must not undo it, and a second success must not re-settle a settled attempt.
  if (attempt.status === "succeeded") {
    await finishWebhookEvent(supabase, record.id, {
      error: null,
      farmId: attempt.farm_id,
      invoiceId: attempt.invoice_id,
      attemptId: attempt.id,
    });
    return { status: 200, outcome: "ignored", reason: "already settled", eventType };
  }

  return processVerified({
    supabase,
    provider,
    attempt,
    eventId: record.id,
    eventType,
  });
}

/**
 * Ask Paystack what actually happened, and act only on that.
 *
 * Both success and failure events go through here. Verifying a FAILURE too costs one API
 * call and buys the guarantee that an event claiming a charge failed can never mark
 * `failed` a transaction Paystack in fact took money for — which would start the dunning
 * machinery against a farm that has paid.
 */
async function processVerified(args: {
  supabase: SupabaseClient;
  provider: SaasBillingProvider;
  attempt: AttemptRow;
  eventId: string | null;
  eventType: string;
}): Promise<WebhookResult> {
  const { supabase, provider, attempt, eventId, eventType } = args;

  const verified = await provider.verifyTransaction(attempt.attempt_ref);

  if (!verified.ok) {
    // Could not confirm. Recorded with the reason, answered 200, and left to the
    // reconciler — see the header: a redelivery would be recognised as a duplicate and
    // achieve nothing, whereas the reconciler verifies this exact reference again.
    const reason = redactMessage(verified.reason, 300);
    await finishWebhookEvent(supabase, eventId, {
      error: `could not verify with the provider: ${reason}`,
      farmId: attempt.farm_id,
      invoiceId: attempt.invoice_id,
      attemptId: attempt.id,
    });
    return { status: 200, outcome: "deferred", reason, eventType };
  }

  const txn = verified.transaction;

  if (txn.status === "success") {
    const match = matchesExpectedCharge(txn, {
      reference: attempt.attempt_ref,
      amountCents: attempt.amount_incl_cents,
      farmId: attempt.farm_id,
      invoiceId: attempt.invoice_id ?? "",
    });
    if (!match.ok) {
      // FIELD NAMES only, and no settlement of any kind. This is the case the whole
      // re-verification exists for: something is being described to us that is not the
      // charge we raised, and the correct response is to write it down and refuse.
      await finishWebhookEvent(supabase, eventId, {
        error: `verified transaction did not match the expected charge: ${match.mismatches.join(", ")}`,
        farmId: attempt.farm_id,
        invoiceId: attempt.invoice_id,
        attemptId: attempt.id,
      });
      return { status: 200, outcome: "refused", reason: "mismatch", eventType };
    }

    await settleBillingAttempt(supabase, {
      attemptId: attempt.id,
      status: "succeeded",
      transactionId: txn.transactionId || null,
      providerRef: txn.reference,
      gatewayResponse: txn.gatewayResponse,
      paidCents: txn.amountCents,
      channel: txn.channel,
    });
    await captureCard(supabase, attempt, txn);
    await finishWebhookEvent(supabase, eventId, {
      error: null,
      farmId: attempt.farm_id,
      invoiceId: attempt.invoice_id,
      attemptId: attempt.id,
    });
    return { status: 200, outcome: "processed", eventType };
  }

  if (txn.status === "pending") {
    await finishWebhookEvent(supabase, eventId, {
      error: "provider still reports this transaction as pending",
      farmId: attempt.farm_id,
      invoiceId: attempt.invoice_id,
      attemptId: attempt.id,
    });
    return { status: 200, outcome: "deferred", reason: "pending", eventType };
  }

  const status = txn.status === "abandoned" ? "abandoned" : "failed";
  await settleBillingAttempt(supabase, {
    attemptId: attempt.id,
    status,
    transactionId: txn.transactionId || null,
    providerRef: txn.reference,
    gatewayResponse: txn.gatewayResponse,
    failureReason: redactMessage(txn.gatewayResponse ?? status, 300),
  });
  await finishWebhookEvent(supabase, eventId, {
    error: null,
    farmId: attempt.farm_id,
    invoiceId: attempt.invoice_id,
    attemptId: attempt.id,
  });
  return { status: 200, outcome: "processed", eventType };
}

/**
 * Store the card, when a verified and matched success offered a reusable one.
 *
 * This is how a card gets saved at all: the hosted checkout takes the first payment and
 * the authorization comes back on the verify. A non-reusable authorization is refused —
 * storing a one-shot as if it were a subscription card makes a farm that appears set up
 * and then fails every renewal.
 */
async function captureCard(
  supabase: SupabaseClient,
  attempt: AttemptRow,
  txn: VerifiedTransaction,
): Promise<void> {
  if (!txn.authorization || !txn.authorization.reusable) return;
  await storeAuthorization(supabase, attempt.farm_id, txn, {
    subscriptionId: attempt.subscription_id,
  });
}
