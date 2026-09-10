/**
 * SaaS billing — the charging worker and the reconciler.
 *
 * ── The one sequence this file exists to hold ─────────────────────────────────
 *
 *     1. claim    app.claim_billing_charge(invoice, ref, kind, amount) → attempt id | NULL
 *     2. charge   POST to Paystack                                     ← NO transaction open
 *     3. settle   app.settle_billing_attempt(...)
 *
 * Three separate transactions with an HTTP call in the middle, and the ordering is the
 * whole safety property:
 *
 *  - The reference is minted and PERSISTED before Paystack is contacted. A response we
 *    never receive is therefore still recoverable, because the handle to it already
 *    exists in our database.
 *  - `billing_payment_attempts_inflight_uq` permits at most ONE `pending`/`unknown`
 *    attempt per invoice. Claiming IS inserting that row, so a second worker loses on a
 *    duplicate key. That — not a "check whether anything is in flight" read — is what
 *    prevents a double charge, because a check-then-act has a window and a unique index
 *    does not.
 *  - A NULL claim is therefore a NORMAL outcome, not an error: somebody else has it, or
 *    the invoice carries an `unknown` attempt that must be reconciled first. It is
 *    skipped silently and reported as `skipped`, never as a failure.
 *
 * ── Timeout is not failure ────────────────────────────────────────────────────
 * A charge whose HTTP response is lost settles `unknown`, never `failed`. The difference
 * matters twice over: `failed` runs the dunning machinery (a retry date, then grace, then
 * a downgrade) against a farm that may well have paid; and `unknown` deliberately BLOCKS
 * every further attempt on that invoice until a human or the reconciler has established
 * what actually happened. Recovery is `transaction/verify` on THAT EXACT REFERENCE.
 * Nothing in this file ever charges again to resolve an unknown.
 *
 * ── The kill switch ───────────────────────────────────────────────────────────
 * `chargingEnabled` gates new charges only. With charging off the worker still
 * RECONCILES — verifying a payment that has already been taken is not a new charge, and
 * turning the switch off must never strand money that was already in flight — and it says
 * so in its structured result rather than reporting a quiet zero.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { matchesExpectedCharge, type ExpectedCharge } from "./paystack";
import type { SaasBillingProvider, VerifiedTransaction, VerifyResult } from "./types";
import {
  chargeRequestFor,
  claimBillingCharge,
  dueBillingCharges,
  getAttemptById,
  invoiceChargeableNow,
  getInvoiceById,
  getSaasProvider,
  newAttemptReference,
  noteReconciliation,
  paymentMethodCredential,
  PAYSTACK_MIN_CHARGE_CENTS,
  redactMessage,
  settleBillingAttempt,
  storeAuthorization,
  unresolvedAttempts,
  type AttemptKind,
  type AttemptRow,
  type DueCharge,
} from "./service";

/** How long a `pending` attempt may live before it is treated as stuck. */
export const STALE_PENDING_MINUTES = 30;

/** Why a charge was not attempted. None of these is an error. */
export type SkipReason =
  | "charging-disabled"
  | "provider-unavailable"
  | "no-stored-card"
  | "claimed-elsewhere"
  | "nothing-due"
  /** Below Paystack's R1.00 floor for a ZAR transaction. */
  | "below-minimum";

export type ChargeOutcome =
  | { result: "succeeded"; invoiceId: string; attemptId: string }
  | { result: "failed"; invoiceId: string; attemptId: string; reason: string }
  | { result: "unknown"; invoiceId: string; attemptId: string; reason: string }
  | { result: "abandoned"; invoiceId: string; attemptId: string; reason: string }
  | { result: "skipped"; invoiceId: string; reason: SkipReason }
  | { result: "error"; invoiceId: string; reason: string };

export type ChargeSummary = {
  chargingEnabled: boolean;
  /** Set when nothing was attempted at all, and why. */
  skipped: SkipReason | null;
  considered: number;
  claimed: number;
  succeeded: number;
  failed: number;
  unknown: number;
  abandoned: number;
  /** Claims another worker already held, plus farms with no usable card. */
  passed: number;
  errors: string[];
  outcomes: ChargeOutcome[];
};

export type ReconcileOutcome =
  | { result: "succeeded"; attemptId: string }
  | { result: "failed"; attemptId: string }
  | { result: "abandoned"; attemptId: string; reason?: string }
  | { result: "still-open"; attemptId: string; reason: string }
  | { result: "refused"; attemptId: string; reason: string }
  | { result: "error"; attemptId: string; reason: string };

export type ReconcileSummary = {
  /** Reconciliation runs whether or not charging is on. Null means it ran. */
  skipped: "provider-unavailable" | null;
  checked: number;
  resolved: number;
  stillOpen: number;
  errors: string[];
  outcomes: ReconcileOutcome[];
};

export type BillingWorkerOptions = {
  /** Injected in tests. Never resolved from the environment inside a test. */
  provider?: SaasBillingProvider | null;
  limit?: number;
  now?: Date;
  stalePendingMinutes?: number;
};

/** The five fields every transaction has to line up with before it may mark an invoice paid. */
function expectedFor(attempt: AttemptRow): ExpectedCharge {
  return {
    reference: attempt.attempt_ref,
    amountCents: attempt.amount_incl_cents,
    farmId: attempt.farm_id,
    invoiceId: attempt.invoice_id ?? "",
  };
}

async function resolveProvider(
  opts: BillingWorkerOptions,
): Promise<SaasBillingProvider | null> {
  if (opts.provider !== undefined) return opts.provider;
  return getSaasProvider();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Charging
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Claim, charge and settle ONE invoice.
 *
 * Shared by the nightly worker, the owner's "try again" button and Rapid Rise's admin
 * retry, so all three go through exactly one sequence. A second implementation of this
 * would be a second place a double charge could be born.
 */
export async function chargeOneInvoice(
  supabase: SupabaseClient,
  provider: SaasBillingProvider,
  due: DueCharge,
  kind: AttemptKind = "charge_authorization",
): Promise<ChargeOutcome> {
  if (!provider.chargingEnabled) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "charging-disabled" };
  }
  if (!due.payment_method_id) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "no-stored-card" };
  }
  if (!(due.amount_incl_cents > 0)) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "nothing-due" };
  }
  // Paystack's floor for ZAR is R1.00. Refused here so the reason is ours; letting the
  // provider reject it would settle a `failed` attempt and start the dunning machinery
  // over an amount smaller than the fee to collect it.
  if (due.amount_incl_cents < PAYSTACK_MIN_CHARGE_CENTS) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "below-minimum" };
  }

  // The ONE read of the charging credential in this file. It goes straight into the
  // adapter call below and nowhere else — not into a log line, an error, a Sentry extra
  // or anything returned to a caller.
  //
  // The email that comes back with it is `billing_payment_methods.authorization_email`,
  // and it MUST be the one used to charge. Paystack: "only the email used to create an
  // authorization can be used to charge it." So this is deliberately not `users.email`,
  // not the farm's billing contact, and not a fresh lookup — a farmer who changes their
  // address must not thereby break a card that was captured successfully.
  const credential = await paymentMethodCredential(
    supabase,
    due.payment_method_id,
    due.farm_id,
  );
  if (!credential) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "no-stored-card" };
  }

  const reference = newAttemptReference();
  const { attemptId, error: claimError } = await claimBillingCharge(supabase, {
    invoiceId: due.invoice_id,
    reference,
    kind,
    amountCents: due.amount_incl_cents,
  });
  if (claimError) {
    return { result: "error", invoiceId: due.invoice_id, reason: claimError.message };
  }
  // Null is the unique index doing its job. Another worker holds this invoice, or an
  // `unknown` attempt is standing in the way. Neither is a failure and neither is retried
  // here — reconciliation is the only thing that clears an unknown.
  if (!attemptId) {
    return { result: "skipped", invoiceId: due.invoice_id, reason: "claimed-elsewhere" };
  }

  // ── No transaction is open across this call, by construction: `claim` above committed
  // and `settle` below is its own statement. ──
  const charged = await provider.chargeAuthorization(
    chargeRequestFor(
      {
        farm_id: due.farm_id,
        invoice_id: due.invoice_id,
        invoice_ref: due.invoice_ref,
        subscription_id: due.subscription_id,
      },
      reference,
      due.amount_incl_cents,
      credential,
    ),
  );

  return settleChargeResult(supabase, {
    attemptId,
    invoiceId: due.invoice_id,
    farmId: due.farm_id,
    reference,
    amountCents: due.amount_incl_cents,
    result: charged,
  });
}

/**
 * Turn what the provider said into a settlement.
 *
 * Four buckets, and which one a response lands in is the difference between a farmer
 * being chased for money they have paid and a farmer being charged twice:
 *
 *  - a verified success that matches what we expected           → `succeeded`
 *  - a definite refusal (a decline, a 4xx, `status:false`)       → `failed`  (terminal)
 *  - a lost or ambiguous response (timeout, 5xx, unreadable)     → `unknown` (blocks; reconcile)
 *  - nothing could have been sent (kill switch, bad arguments)   → `abandoned` (does not block)
 *
 * A success whose amount, currency, reference or metadata does not match is NOT paid. It
 * settles `unknown`, which blocks the invoice and forces somebody to look — the one
 * outcome that is safe in both directions when the provider is telling us about a
 * transaction we cannot recognise.
 */
async function settleChargeResult(
  supabase: SupabaseClient,
  input: {
    attemptId: string;
    invoiceId: string;
    farmId: string;
    reference: string;
    amountCents: number;
    result: VerifyResult;
  },
): Promise<ChargeOutcome> {
  const { attemptId, invoiceId } = input;

  if (!input.result.ok) {
    const reason = redactMessage(input.result.reason, 300);
    if (input.result.deferred) {
      // Nothing was sent: the kill switch moved, or the provider is unconfigured. The
      // attempt is abandoned rather than left unknown, because an unknown would block
      // every later attempt on this invoice on behalf of a request that never left here.
      await settleBillingAttempt(supabase, {
        attemptId,
        status: "abandoned",
        failureReason: reason,
      });
      return { result: "abandoned", invoiceId, attemptId, reason };
    }
    if (input.result.retryable) {
      // We do not know whether Paystack received it. `unknown` is the honest answer and
      // the reconciler resolves it by verifying this exact reference — never by charging.
      await settleBillingAttempt(supabase, {
        attemptId,
        status: "unknown",
        failureReason: reason,
      });
      return { result: "unknown", invoiceId, attemptId, reason };
    }
    await settleBillingAttempt(supabase, {
      attemptId,
      status: "failed",
      failureReason: reason,
    });
    return { result: "failed", invoiceId, attemptId, reason };
  }

  const txn = input.result.transaction;

  if (txn.status === "success") {
    const match = matchesExpectedCharge(txn, {
      reference: input.reference,
      amountCents: input.amountCents,
      farmId: input.farmId,
      invoiceId,
    });
    if (!match.ok) {
      // Field NAMES only. One of the values is an amount of money and another is somebody's
      // farm; neither belongs in a stored reason.
      const reason = `provider success did not match the expected charge: ${match.mismatches.join(", ")}`;
      await settleBillingAttempt(supabase, {
        attemptId,
        status: "unknown",
        failureReason: reason,
      });
      return { result: "unknown", invoiceId, attemptId, reason };
    }
    await settleBillingAttempt(supabase, {
      attemptId,
      status: "succeeded",
      transactionId: txn.transactionId || null,
      providerRef: txn.reference,
      gatewayResponse: txn.gatewayResponse,
      paidCents: txn.amountCents,
      channel: txn.channel,
    });
    return { result: "succeeded", invoiceId, attemptId };
  }

  if (txn.status === "pending") {
    const reason = "provider has not resolved this transaction yet";
    await settleBillingAttempt(supabase, { attemptId, status: "unknown", failureReason: reason });
    return { result: "unknown", invoiceId, attemptId, reason };
  }

  if (txn.status === "abandoned") {
    const reason = redactMessage(txn.gatewayResponse ?? "abandoned", 300);
    await settleBillingAttempt(supabase, {
      attemptId,
      status: "abandoned",
      transactionId: txn.transactionId || null,
      providerRef: txn.reference,
      gatewayResponse: txn.gatewayResponse,
      failureReason: reason,
    });
    return { result: "abandoned", invoiceId, attemptId, reason };
  }

  const reason = redactMessage(txn.gatewayResponse ?? "declined", 300);
  await settleBillingAttempt(supabase, {
    attemptId,
    status: "failed",
    transactionId: txn.transactionId || null,
    providerRef: txn.reference,
    gatewayResponse: txn.gatewayResponse,
    failureReason: reason,
  });
  return { result: "failed", invoiceId, attemptId, reason };
}

/**
 * Charge everything currently due.
 *
 * `app.due_billing_charges` already excludes an invoice with anything in flight, so the
 * claim below is a second lock rather than the only one — the read is a shortlist and the
 * unique index is the decision.
 */
export async function runBillingCharges(
  supabase: SupabaseClient,
  opts: BillingWorkerOptions = {},
): Promise<ChargeSummary> {
  const empty: ChargeSummary = {
    chargingEnabled: false,
    skipped: null,
    considered: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    abandoned: 0,
    passed: 0,
    errors: [],
    outcomes: [],
  };

  const provider = await resolveProvider(opts);
  if (!provider) return { ...empty, skipped: "provider-unavailable" };
  if (!provider.chargingEnabled) {
    // Deliberately explicit rather than a quiet zero: "we charged nobody" and "we are not
    // allowed to charge anybody" look identical in a count and are completely different
    // facts to be told at three in the morning.
    return { ...empty, skipped: "charging-disabled" };
  }

  const summary: ChargeSummary = { ...empty, chargingEnabled: true };

  const { rows, error } = await dueBillingCharges(supabase, opts.limit ?? 50);
  if (error) {
    summary.errors.push(error.message);
    return summary;
  }
  summary.considered = rows.length;

  for (const due of rows) {
    let outcome: ChargeOutcome;
    try {
      outcome = await chargeOneInvoice(supabase, provider, due);
    } catch (err) {
      // A throw here has already claimed, or has not. Either way the attempt row (if it
      // exists) is `pending` and the reconciler will verify it — which is exactly why the
      // reference is minted first.
      outcome = { result: "error", invoiceId: due.invoice_id, reason: redactMessage(err, 300) };
    }
    summary.outcomes.push(outcome);
    switch (outcome.result) {
      case "succeeded":
        summary.claimed += 1;
        summary.succeeded += 1;
        break;
      case "failed":
        summary.claimed += 1;
        summary.failed += 1;
        break;
      case "unknown":
        summary.claimed += 1;
        summary.unknown += 1;
        break;
      case "abandoned":
        summary.claimed += 1;
        summary.abandoned += 1;
        break;
      case "skipped":
        summary.passed += 1;
        break;
      case "error":
        summary.errors.push(outcome.reason);
        break;
    }
  }

  return summary;
}

/**
 * Charge one specific invoice now, because a person asked.
 *
 * Used by the owner's "Try again" and by Rapid Rise's admin retry, and it goes through
 * `app.invoice_chargeable_now` — NOT the nightly shortlist.
 *
 * It used to rebuild the automatic shortlist and look for the invoice in it. That
 * shortlist carries `coalesce(next_retry_on, current_date) <= current_date`, so after a
 * decline this answered "nothing is due" for the whole retry interval while the invoice
 * was plainly unpaid; and it carries `status in ('active','past_due')`, so from the
 * moment a farm entered grace the stored card was never presented again by anything —
 * not the cron, and not the customer pressing the button.
 *
 * The retry timer exists to stop the MACHINE hammering a card, which issuers penalise.
 * A person pressing a button is a different act and is bounded by their patience.
 *
 * What is NOT relaxed: the in-flight block. `claimBillingCharge` is still the only way to
 * take a charge and `billing_payment_attempts_inflight_uq` still permits exactly one
 * attempt per invoice — "just try it again" is the perfect way to charge somebody twice.
 * The farm is re-checked here too, because the function is keyed on the invoice alone.
 */
export async function retryInvoiceCharge(
  supabase: SupabaseClient,
  input: { invoiceId: string; farmId: string; kind?: AttemptKind },
  opts: BillingWorkerOptions = {},
): Promise<ChargeOutcome> {
  const provider = await resolveProvider(opts);
  if (!provider) {
    return { result: "skipped", invoiceId: input.invoiceId, reason: "provider-unavailable" };
  }
  if (!provider.chargingEnabled) {
    return { result: "skipped", invoiceId: input.invoiceId, reason: "charging-disabled" };
  }

  const { row, error } = await invoiceChargeableNow(supabase, input.invoiceId);
  if (error) return { result: "error", invoiceId: input.invoiceId, reason: error.message };

  // Keyed on the invoice, so the tenancy check is ours to make. A farm must never be
  // able to spend somebody else's invoice into a charge.
  const due = row && row.farm_id === input.farmId ? row : null;
  if (!due) {
    // Already paid, nothing outstanding, no usable card, an attempt in flight, or a farm
    // that has been deleted or cancelled. All of those are "not now", none is an error.
    return { result: "skipped", invoiceId: input.invoiceId, reason: "nothing-due" };
  }

  return chargeOneInvoice(supabase, provider, due, input.kind ?? "manual_retry");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reconciliation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ask the provider what happened to ONE attempt, by its own reference.
 *
 * The reference is the point. We are not asking "did this farm pay?" — we are asking
 * about the single transaction we minted a handle for before we made the call, which is
 * the only question whose answer cannot accidentally be about somebody else's money.
 *
 * A verified success is checked against the same five fields the webhook checks
 * (`matchesExpectedCharge`), because a reconciler that were fractionally more permissive
 * than the webhook would be the way around the webhook.
 */
export async function reconcileAttempt(
  supabase: SupabaseClient,
  provider: SaasBillingProvider,
  attempt: AttemptRow,
): Promise<ReconcileOutcome> {
  if (attempt.status === "succeeded" || attempt.status === "failed") {
    return { result: attempt.status === "succeeded" ? "succeeded" : "failed", attemptId: attempt.id };
  }

  const verified = await provider.verifyTransaction(attempt.attempt_ref);

  if (!verified.ok) {
    const reason = redactMessage(verified.reason, 240);
    if (verified.deferred) {
      return { result: "still-open", attemptId: attempt.id, reason };
    }
    // Two conditions, and BOTH are load-bearing.
    //
    //   retryable === false  — this is not a 5xx, a 429, a timeout or an unreadable body,
    //                          so it is not the "ask again in a minute" case.
    //
    //   answered === true    — and Paystack PROCESSED the query, returning its own
    //                          `status:false` envelope. For `transaction/verify` that is
    //                          "no such transaction": not ambiguity, a fact. No money
    //                          moved under this reference.
    //
    // `!retryable` alone would be wrong, and dangerously so: a missing API key, a
    // malformed 200 and a reference we never managed to send are all non-retryable, and
    // each of them would then close an attempt we know nothing about and hand its invoice
    // back to the charging queue — which is how the same farm gets charged twice.
    //
    // Without the terminal case an `unknown` could never be resolved by this path: a
    // charge whose request never reached Paystack jammed its invoice permanently. The
    // farm was never charged again, never went `past_due`, never got a reminder or a
    // failure email, and looked exactly like a customer who was paid up. Clearing it
    // needed hand-written SQL against production, because there is deliberately no admin
    // action that settles an attempt.
    if (verified.retryable === false && verified.answered) {
      await settleBillingAttempt(supabase, {
        attemptId: attempt.id,
        status: "abandoned",
        failureReason: reason,
      });
      await noteReconciliation(
        supabase,
        attempt.id,
        `provider does not know this reference — no money moved: ${reason}`,
        attempt.reconcile_note,
      );
      return { result: "abandoned", attemptId: attempt.id, reason };
    }

    if (attempt.status === "pending") {
      await settleBillingAttempt(supabase, {
        attemptId: attempt.id,
        status: "unknown",
        failureReason: reason,
      });
    }
    await noteReconciliation(
      supabase,
      attempt.id,
      `verify unavailable: ${reason}`,
      attempt.reconcile_note,
    );
    return { result: "still-open", attemptId: attempt.id, reason };
  }

  const txn = verified.transaction;

  if (txn.status === "success") {
    const match = matchesExpectedCharge(txn, expectedFor(attempt));
    if (!match.ok) {
      const reason = `verified transaction did not match: ${match.mismatches.join(", ")}`;
      await noteReconciliation(supabase, attempt.id, reason, attempt.reconcile_note);
      // Refused, and left blocking. Marking this paid is the one thing that must not
      // happen when the provider is describing a transaction we do not recognise.
      return { result: "refused", attemptId: attempt.id, reason };
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
    await captureCardIfOffered(supabase, attempt, txn);
    await noteReconciliation(
      supabase,
      attempt.id,
      "verified paid at the provider",
      attempt.reconcile_note,
    );
    return { result: "succeeded", attemptId: attempt.id };
  }

  if (txn.status === "pending") {
    await noteReconciliation(
      supabase,
      attempt.id,
      "provider still reports this transaction as pending",
      attempt.reconcile_note,
    );
    return { result: "still-open", attemptId: attempt.id, reason: "pending at the provider" };
  }

  const status = txn.status === "abandoned" ? "abandoned" : "failed";
  await settleBillingAttempt(supabase, {
    attemptId: attempt.id,
    status,
    transactionId: txn.transactionId || null,
    providerRef: txn.reference,
    gatewayResponse: txn.gatewayResponse,
    failureReason: redactMessage(txn.gatewayResponse ?? status, 240),
  });
  await noteReconciliation(
    supabase,
    attempt.id,
    `provider reports ${status}`,
    attempt.reconcile_note,
  );
  return { result: status, attemptId: attempt.id };
}

/**
 * Store the card a hosted checkout captured, when the provider offered a reusable one.
 *
 * Only ever reached from a VERIFIED, matched success. A non-reusable authorization is
 * refused (`storeAuthorization` says so and the table's own check constraint would
 * refuse it anyway) — a one-shot authorization stored as a subscription card produces a
 * farm that looks set up and then fails every renewal.
 */
async function captureCardIfOffered(
  supabase: SupabaseClient,
  attempt: AttemptRow,
  txn: VerifiedTransaction,
): Promise<void> {
  if (!txn.authorization || !txn.authorization.reusable) return;
  await storeAuthorization(supabase, attempt.farm_id, txn, {
    subscriptionId: attempt.subscription_id,
  });
}

/**
 * Work through every attempt that is stuck.
 *
 * Runs whether or not charging is enabled: reconciling a payment that has already been
 * taken is not a new charge, and switching the kill switch off must never leave money in
 * flight with nobody asking about it.
 */
export async function reconcileStuckAttempts(
  supabase: SupabaseClient,
  opts: BillingWorkerOptions = {},
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    skipped: null,
    checked: 0,
    resolved: 0,
    stillOpen: 0,
    errors: [],
    outcomes: [],
  };

  const provider = await resolveProvider(opts);
  if (!provider || !provider.enabled) {
    return { ...summary, skipped: "provider-unavailable" };
  }

  const { rows, error } = await unresolvedAttempts(supabase, {
    stalePendingMinutes: opts.stalePendingMinutes ?? STALE_PENDING_MINUTES,
    limit: opts.limit ?? 100,
    now: opts.now,
  });
  if (error) {
    summary.errors.push(error.message);
    return summary;
  }

  for (const attempt of rows) {
    summary.checked += 1;
    let outcome: ReconcileOutcome;
    try {
      outcome = await reconcileAttempt(supabase, provider, attempt);
    } catch (err) {
      outcome = { result: "error", attemptId: attempt.id, reason: redactMessage(err, 240) };
    }
    summary.outcomes.push(outcome);
    if (outcome.result === "succeeded" || outcome.result === "failed" || outcome.result === "abandoned") {
      summary.resolved += 1;
    } else if (outcome.result === "error") {
      summary.errors.push(outcome.reason);
    } else {
      summary.stillOpen += 1;
    }
  }

  return summary;
}

/** Reconcile one attempt by id — what Rapid Rise's "check this with Paystack" does. */
export async function reconcileAttemptById(
  supabase: SupabaseClient,
  attemptId: string,
  opts: BillingWorkerOptions = {},
): Promise<ReconcileOutcome> {
  const provider = await resolveProvider(opts);
  if (!provider || !provider.enabled) {
    return { result: "still-open", attemptId, reason: "provider-unavailable" };
  }
  const attempt = await getAttemptById(supabase, attemptId);
  if (!attempt) return { result: "error", attemptId, reason: "no such attempt" };
  return reconcileAttempt(supabase, provider, attempt);
}

/**
 * A whole billing pass: reconcile first, then charge.
 *
 * The order is not cosmetic. An `unknown` attempt blocks its invoice, so reconciling
 * first is what allows an invoice stranded by last night's timeout to be charged tonight
 * instead of staying stuck until somebody notices.
 */
export async function runBillingPass(
  supabase: SupabaseClient,
  opts: BillingWorkerOptions = {},
): Promise<{ reconciled: ReconcileSummary; charges: ChargeSummary }> {
  const reconciled = await reconcileStuckAttempts(supabase, opts);
  const charges = await runBillingCharges(supabase, opts);
  return { reconciled, charges };
}

/** The outstanding balance on one invoice, for a caller that has only its id. */
export async function invoiceOutstandingCents(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<number> {
  const invoice = await getInvoiceById(supabase, invoiceId);
  if (!invoice) return 0;
  return Math.max(0, invoice.total_incl_cents - invoice.amount_paid_cents);
}
