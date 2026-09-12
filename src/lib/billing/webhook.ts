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
  BILLING_RPC,
  finishWebhookEvent,
  getAttemptByReference,
  notifyRapidRise,
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

/**
 * Events that mean money is going back, or is being taken back.
 *
 * These were `outcome: "ignored"` — recorded, like every signed delivery, and then nothing.
 *
 * A DISPUTE is the urgent one. South Africa gives roughly 48 BUSINESS HOURS to respond
 * before Paystack accepts the dispute on our behalf and takes the amount out of a payout.
 * A clock nobody can see is a clock that always runs out, so this alerts Rapid Rise
 * immediately and without quiet hours.
 *
 * A REFUND is not urgent but it is a ledger fact: the invoice still reads `paid` and the
 * farm still has its plan. What a refund SHOULD do to both is a founder decision and is
 * deliberately not made here — being told is the part with no downside.
 */
const DISPUTE_EVENTS = new Set([
  "charge.dispute.create",
  "charge.dispute.remind",
  "charge.dispute.resolve",
]);
const REFUND_EVENTS = new Set([
  "refund.pending",
  "refund.processing",
  "refund.processed",
  "refund.failed",
]);

/**
 * A dispute's own id, or a refund's own reference — the idempotency key for its case.
 *
 * Deliberately NOT the transaction reference: one transaction can be disputed and later
 * refunded, and keying both cases on the transaction would collapse two different
 * conversations into one ticket.
 */
export function disputeOrRefundRef(data: Record<string, unknown>): string | null {
  const direct = data.id ?? data.reference;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof direct === "number") return String(direct);
  return null;
}

/**
 * When the dispute must be answered by.
 *
 * Paystack sends `due_at` on the dispute payload. Where it is missing or unreadable we fall
 * back to 48 hours from now — the CALENDAR reading of "roughly 48 business hours", which is
 * always EARLIER than the real deadline. That direction is deliberate: chased too early
 * costs somebody a glance, chased too late costs the money, because Paystack accepts the
 * dispute on our behalf and takes it out of a payout.
 */
export function disputeDeadline(data: Record<string, unknown>): string {
  const raw = data.due_at ?? data.dueAt;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

/**
 * The reference a dispute or refund event is about.
 *
 * Paystack does not put it in the same place for every family: a charge event carries
 * `data.reference`, while dispute and refund payloads nest the transaction. All three
 * shapes are read rather than guessed at, and an event we cannot place is alerted anyway
 * with whatever it did carry — a dispute nobody can match is still a dispute.
 */
function relatedReference(data: Record<string, unknown>): string | null {
  const direct = asString(data.reference);
  if (direct) return direct;
  const nested = isObject(data.transaction) ? asString(data.transaction.reference) : null;
  if (nested) return nested;
  return asString(data.transaction_reference);
}

/**
 * The refund's own reference — NOT the transaction's.
 *
 * This is the idempotency key: `billing_payments_ref_uq` is what stops a redelivery
 * recording the same refund twice, and Paystack retries for 72 hours. Using the
 * TRANSACTION reference here would collide with the original payment's row and silently
 * refuse every refund as a duplicate.
 */
function refundReference(data: Record<string, unknown>): string | null {
  return (
    asString(data.refund_reference) ??
    asString(data.reference) ??
    (isObject(data.refund) ? asString(data.refund.reference) : null)
  );
}

/** Paystack sends money in the smallest unit, which for ZAR is cents. */
function refundAmountCents(data: Record<string, unknown>): number | null {
  const raw = data.amount;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

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

  // Money going the other way.
  //
  // A PROCESSED refund moves the ledger (20260911210000): it is recorded as a negative
  // payment, which makes the invoice unpaid again — and both charging shortlists exclude a
  // refunded invoice, so it cannot be re-charged the following night. Everything else in
  // this family only alerts: `pending` and `processing` mean the money has not left yet,
  // `failed` means it never will, and a DISPUTE is money at risk rather than money moved.
  //
  // The subscription is untouched in every case. A refund the customer asked for should end
  // their plan and one we issue for our own mistake should not, and a webhook cannot tell
  // those apart — docs/BILLING.md §11b. That is what the alert is for.
  if (DISPUTE_EVENTS.has(eventType) || REFUND_EVENTS.has(eventType)) {
    const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : {};
    const reference = relatedReference(data);
    const attempt = reference ? await getAttemptByReference(supabase, reference) : null;

    let ledger: string | null = null;
    if (eventType === "refund.processed" && reference) {
      const amount = refundAmountCents(data);
      const refundRef = refundReference(data);
      if (amount == null) {
        ledger = "refund carried no usable amount";
      } else if (!refundRef) {
        // Without its own reference there is no idempotency key, and Paystack's 72 hours of
        // retries would record the same refund again and again.
        ledger = "refund carried no reference of its own";
      } else {
        const { data: outcome, error } = await supabase.rpc(BILLING_RPC.recordRefund, {
          p_txn_reference: reference,
          p_refund_reference: refundRef,
          p_amount_cents: amount,
        });
        ledger = error ? `ledger error: ${error.message}` : String(outcome ?? "unknown");
      }
    }

    // ── The support case ──────────────────────────────────────────────────
    // Opened BEFORE the alert, so the alert is never the only record: an alert is a
    // notification and notifications get read, dismissed and forgotten, while a dispute
    // that arrived at 3am has to survive until somebody is awake.
    //
    // Idempotent on (kind, external_ref), so Paystack's redeliveries — up to 72 hours of
    // them — refresh one case rather than opening a queue of identical ones.
    const isDispute = DISPUTE_EVENTS.has(eventType);
    const externalRef = disputeOrRefundRef(data) ?? reference ?? null;
    let ticket: string | null = null;
    try {
      const { data: ticketId, error: ticketError } = await supabase.rpc("open_support_ticket", {
        p_kind: isDispute ? "dispute" : "refund_request",
        p_subject: isDispute
          ? `Card dispute on ${reference ?? "an unmatched transaction"}`
          : `Refund processed on ${reference ?? "an unmatched transaction"}`,
        p_farm: attempt?.farm_id ?? null,
        p_invoice: attempt?.invoice_id ?? null,
        p_payment: null,
        p_external_ref: externalRef,
        p_source_event: record.id,
        // Only a dispute has a clock. A refund is already done; the case is a record of it.
        p_due_at: isDispute ? disputeDeadline(data) : null,
      });
      ticket = ticketError ? `ticket error: ${ticketError.message}` : String(ticketId ?? "");
    } catch (err) {
      // A failure here must never lose the event. The alert below still fires and the
      // webhook still returns 200, because a non-200 makes Paystack retry for 72 hours and
      // the ledger work above has already happened.
      ticket = `ticket error: ${err instanceof Error ? err.message : "unknown"}`;
    }

    const alerted = attempt
      ? await notifyRapidRise(supabase, {
          farmId: attempt.farm_id,
          template: DISPUTE_EVENTS.has(eventType) ? "billing_dispute" : "billing_refund",
          payload: {
            event: eventType,
            reference: reference ?? null,
            invoice_id: attempt.invoice_id,
            amount_incl_cents: attempt.amount_incl_cents,
            // So the person reading the alert can open the case rather than hunt for it.
            ticket_id: ticket && !ticket.startsWith("ticket error") ? ticket : null,
          },
        })
      : 0;

    await finishWebhookEvent(supabase, record.id, {
      // Not an error in the sense of "we failed" — but an event we could not place against
      // a farm is one nobody can act on, and it must not read as handled.
      error: attempt ? null : "no payment attempt matches this reference",
      farmId: attempt?.farm_id,
      invoiceId: attempt?.invoice_id,
      attemptId: attempt?.id,
    });
    return {
      status: 200,
      outcome: attempt ? "processed" : "refused",
      reason: attempt
        ? `alerted ${alerted} administrator(s)${ledger ? `; ${ledger}` : ""}`
        : "could not match this event to a payment we made",
      eventType,
    };
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
