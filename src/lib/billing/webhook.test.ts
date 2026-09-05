/**
 * The Paystack webhook, exercised without a network and without a database.
 *
 * ── Two things about how this is set up ──────────────────────────────────────
 *
 * 1. The SIGNATURE CHECK IS THE REAL ONE. `PaystackBillingAdapter.verifyWebhookSignature`
 *    is used as written, against a synthetic secret key set in `process.env` for the
 *    duration of this file. That method makes no HTTP call — it is an HMAC and a
 *    comparison — so using the genuine implementation costs nothing and tests something,
 *    whereas a fake `() => true` would test the shape of the code and none of its
 *    security. The signatures below are computed the way Paystack computes them.
 *
 * 2. NO TEST HERE CAN MAKE A LIVE CHARGE. `globalThis.fetch` is replaced with a function
 *    that throws, so any path that reached the adapter's real `verifyTransaction` would
 *    fail loudly rather than contacting Paystack. Verification is always stubbed.
 *
 * The synthetic key is `sk_test_…` and is not a credential: it exists only so an HMAC has
 * something to key on.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SaasBillingProvider, VerifiedTransaction, VerifyResult } from "./types";
import { MAX_WEBHOOK_BODY_BYTES } from "./config";
import { PaystackBillingAdapter } from "./paystack";
import { dedupeKeyFor, handlePaystackWebhook } from "./webhook";

// ── Environment: a synthetic key, so the real HMAC has something to key on ───
const SECRET = "sk_test_fleetwise_unit_test_key_not_a_credential";
process.env.BILLING_PROVIDER = "paystack";
process.env.PAYSTACK_SECRET_KEY = SECRET;
// Charging stays OFF for the whole file. The webhook must work regardless — reconciling a
// payment that has already been taken is not a new charge — and leaving it off means no
// test in this file could create one even if something reached the real adapter.
delete process.env.BILLING_CHARGING_ENABLED;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("a unit test attempted a real network call");
}) as typeof fetch;
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});

/** Exactly how Paystack signs: HMAC-SHA512 of the RAW body, hex, keyed with the secret. */
function sign(rawBody: string, key = SECRET): string {
  return createHmac("sha512", key).update(rawBody, "utf8").digest("hex");
}

// ── Fakes ────────────────────────────────────────────────────────────────────

type Result = { data: unknown; error: { message: string; code?: string } | null };

type QueryCtx = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  filters: Record<string, unknown>;
  payload: unknown;
};

type RpcCall = { name: string; args: Record<string, unknown> };

type WebhookEventRow = {
  id: string;
  provider: string;
  dedupe_key: string;
  event_type: string;
  delivery_count: number;
  processed_at: string | null;
  processing_error: string | null;
};

/**
 * An in-memory stand-in with ONE real behaviour: `billing_webhook_events` enforces
 * uniqueness on `(provider, dedupe_key)` and answers a second insert with Postgres error
 * 23505, exactly as `billing_webhook_events_dedupe_uq` does. That is what makes the replay
 * test mean something — take the constraint out of the fake and the test proves nothing.
 */
function fakeSupabase(opts: {
  attempt?: Record<string, unknown> | null;
  rpc?: (name: string, args: Record<string, unknown>) => Result;
}) {
  const rpcCalls: RpcCall[] = [];
  const queries: QueryCtx[] = [];
  const events: WebhookEventRow[] = [];
  let nextId = 1;

  const answer = (ctx: QueryCtx): Result => {
    if (ctx.table === "billing_webhook_events") {
      if (ctx.kind === "insert") {
        const row = ctx.payload as Record<string, unknown>;
        const key = String(row.dedupe_key);
        const provider = String(row.provider);
        if (events.some((e) => e.provider === provider && e.dedupe_key === key)) {
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          };
        }
        const created: WebhookEventRow = {
          id: `evt-${nextId++}`,
          provider,
          dedupe_key: key,
          event_type: String(row.event_type),
          delivery_count: 1,
          processed_at: null,
          processing_error: null,
        };
        events.push(created);
        return { data: { id: created.id }, error: null };
      }
      if (ctx.kind === "select") {
        const found = events.find(
          (e) =>
            e.provider === ctx.filters.provider && e.dedupe_key === ctx.filters.dedupe_key,
        );
        return { data: found ?? null, error: null };
      }
      if (ctx.kind === "update") {
        const found = events.find((e) => e.id === ctx.filters.id);
        if (found) Object.assign(found, ctx.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
    }
    if (ctx.table === "billing_payment_attempts" && ctx.kind === "select") {
      return { data: opts.attempt ?? null, error: null };
    }
    return { data: null, error: null };
  };

  const builder = (table: string, kind: QueryCtx["kind"], payload: unknown) => {
    const ctx: QueryCtx = { table, kind, filters: {}, payload };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        ctx.filters[col] = val;
        return q;
      },
      is: (col: string, val: unknown) => {
        ctx.filters[col] = val;
        return q;
      },
      in: (col: string, val: unknown) => {
        ctx.filters[col] = val;
        return q;
      },
      lte: (col: string, val: unknown) => {
        ctx.filters[col] = val;
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: () => q,
      then: (
        onFulfilled: (value: Result) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        queries.push({ ...ctx, filters: { ...ctx.filters } });
        return Promise.resolve(answer(ctx)).then(onFulfilled, onRejected);
      },
    };
    return q;
  };

  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpc ? opts.rpc(name, args) : { data: null, error: null });
    },
    from(table: string) {
      return {
        select: () => builder(table, "select", null),
        insert: (payload: unknown) => builder(table, "insert", payload),
        update: (payload: unknown) => builder(table, "update", payload),
        delete: () => builder(table, "delete", null),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, rpcCalls, queries, events };
}

const FARM = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const REFERENCE = "FWB-TEST-REFERENCE";
/** Obviously synthetic. Real prices are deliberately unseeded — see the contract §1. */
const AMOUNT = 1234;

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    farm_id: FARM,
    invoice_id: INVOICE,
    subscription_id: null,
    payment_method_id: null,
    attempt_ref: REFERENCE,
    kind: "initial_checkout",
    status: "pending",
    amount_incl_cents: AMOUNT,
    currency: "ZAR",
    provider: "paystack",
    provider_transaction_id: null,
    requested_at: "2026-09-03T00:00:00.000Z",
    reconciled_at: null,
    reconcile_note: null,
    ...over,
  };
}

function txn(over: Partial<VerifiedTransaction> = {}): VerifiedTransaction {
  return {
    reference: REFERENCE,
    transactionId: 9001,
    status: "success",
    amountCents: AMOUNT,
    currency: "ZAR",
    channel: "card",
    gatewayResponse: "Successful",
    paidAt: "2026-09-03T00:00:00.000Z",
    customerCode: "CUS_test",
    customerEmail: "owner@example.test",
    // Deliberately null: storing a card is `storeAuthorization`'s job and is covered by
    // its own path. Leaving it null keeps these tests about the webhook's decisions.
    authorization: null,
    metadata: { farm_id: FARM, invoice_id: INVOICE },
    ...over,
  };
}

const realAdapter = new PaystackBillingAdapter();

/**
 * A provider whose SIGNATURE CHECK is the real implementation and whose verification is
 * stubbed. Nothing here can reach the network.
 */
function provider(verify: () => Promise<VerifyResult>, count?: { n: number }): SaasBillingProvider {
  return {
    provider: "paystack",
    enabled: true,
    chargingEnabled: false,
    async initializeCheckout() {
      throw new Error("initializeCheckout must not be reached from a webhook");
    },
    async chargeAuthorization() {
      throw new Error("a webhook must NEVER cause a charge");
    },
    async verifyTransaction() {
      if (count) count.n += 1;
      return verify();
    },
    verifyWebhookSignature: (body, signature) =>
      realAdapter.verifyWebhookSignature(body, signature),
  };
}

const verifiesSuccess = () => provider(async () => ({ ok: true, transaction: txn() }));

function body(event: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event,
    data: { id: 9001, reference: REFERENCE, amount: AMOUNT, currency: "ZAR", ...data },
  });
}

function settleCalls(rpcCalls: RpcCall[]): RpcCall[] {
  return rpcCalls.filter((c) => c.name === "billing_settle_attempt");
}

// ═════════════════════════════════════════════════════════════════════════════
// The signature, before anything else
// ═════════════════════════════════════════════════════════════════════════════

test("a missing signature is refused and nothing is recorded", async () => {
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: null,
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(result.status, 401);
  assert.equal(db.events.length, 0, "an unsigned delivery is not evidence of anything");
  assert.equal(db.rpcCalls.length, 0);
});

test("an invalid signature is refused", async () => {
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    // Correct LENGTH, wrong content: this is what a forged delivery looks like, and it is
    // the case `timingSafeEqual` actually compares rather than short-circuiting on.
    signature: sign(raw, "sk_test_a_different_key_entirely"),
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(result.status, 401);
  assert.equal(db.events.length, 0);
});

test("a wrong-LENGTH signature is refused without throwing", async () => {
  // `crypto.timingSafeEqual` THROWS on unequal buffers. A throw here would be a 500, which
  // Paystack reads as "retry", which turns a one-line probe into 72 hours of redeliveries.
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  for (const signature of ["", "abc", "0".repeat(127), "0".repeat(129), "not-hex-at-all"]) {
    const result = await handlePaystackWebhook({
      rawBody: raw,
      signature,
      supabase: db.client,
      provider: verifiesSuccess(),
    });
    assert.equal(result.status, 401, `signature ${JSON.stringify(signature)} must be refused`);
  }
  assert.equal(db.events.length, 0);
});

test("a valid signature is accepted in either case", async () => {
  // Hex is case-insensitive and a proxy may have upper-cased it. Rejecting a genuine
  // delivery over capitalisation would be a payment lost to cosmetics.
  const raw = body("unknown.event");
  const db = fakeSupabase({ attempt: null });
  const upper = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw).toUpperCase(),
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(upper.status, 200);
});

test("an oversized body is refused BEFORE the signature is even computed", async () => {
  let signatureChecks = 0;
  const counting: SaasBillingProvider = {
    ...verifiesSuccess(),
    verifyWebhookSignature: () => {
      signatureChecks += 1;
      return true;
    },
  };
  const raw = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
  const db = fakeSupabase({ attempt: attemptRow() });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: counting,
  });

  assert.equal(result.status, 413);
  assert.equal(
    signatureChecks,
    0,
    "we must not burn CPU on an HMAC for a caller we have not decided to trust",
  );
  assert.equal(db.events.length, 0);
});

test("an empty body is refused", async () => {
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: "",
    signature: sign(""),
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(result.status, 400);
  assert.equal(db.events.length, 0);
});

test("with no provider configured a delivery is refused rather than trusted", async () => {
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: null,
  });
  assert.equal(result.status, 401);
  assert.equal(db.events.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// A signed body we cannot read
// ═════════════════════════════════════════════════════════════════════════════

test("malformed JSON behind a VALID signature is recorded, refused, and answered 200", async () => {
  const raw = "{not json at all";
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: verifiesSuccess(),
  });

  assert.equal(result.status, 200, "a redelivery could not help: the dedupe key is already written");
  assert.equal(result.outcome, "refused");
  assert.equal(db.events.length, 1, "a signed body IS evidence about our own integration");
  assert.equal(db.events[0].event_type, "unparsed");
  assert.ok(db.events[0].processing_error);
  assert.equal(settleCalls(db.rpcCalls).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Idempotency
// ═════════════════════════════════════════════════════════════════════════════

test("the dedupe key is the event and the transaction id, falling back to a body hash", () => {
  assert.equal(
    dedupeKeyFor("{}", { event: "charge.success", data: { id: 9001 } }),
    "charge.success:9001",
  );
  // Same transaction, different event: two distinct facts, two distinct keys.
  assert.equal(
    dedupeKeyFor("{}", { event: "charge.failed", data: { id: 9001 } }),
    "charge.failed:9001",
  );
  const hashed = dedupeKeyFor("{\"event\":\"x\"}", { event: "x", data: {} });
  assert.ok(hashed.startsWith("sha256:"), "no transaction id means hash the raw body");
  assert.equal(hashed, dedupeKeyFor("{\"event\":\"x\"}", { event: "x", data: {} }));
});

test("a replayed delivery performs EXACTLY ONE side effect", async () => {
  const raw = body("charge.success");
  const signature = sign(raw);
  const count = { n: 0 };
  const db = fakeSupabase({ attempt: attemptRow() });
  const p = provider(async () => ({ ok: true, transaction: txn() }), count);

  const first = await handlePaystackWebhook({ rawBody: raw, signature, supabase: db.client, provider: p });
  const second = await handlePaystackWebhook({ rawBody: raw, signature, supabase: db.client, provider: p });
  const third = await handlePaystackWebhook({ rawBody: raw, signature, supabase: db.client, provider: p });

  assert.equal(first.outcome, "processed");
  assert.equal(second.outcome, "duplicate");
  assert.equal(third.outcome, "duplicate");
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);

  assert.equal(settleCalls(db.rpcCalls).length, 1, "the invoice is settled once, not three times");
  assert.equal(count.n, 1, "a duplicate does not even re-verify");
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].delivery_count, 3, "a redelivery storm is made visible, not silent");
});

test("out of order: a failure arriving after a recorded success changes nothing", async () => {
  const raw = body("charge.failed", { id: 9002 });
  const db = fakeSupabase({ attempt: attemptRow({ status: "succeeded" }) });
  const count = { n: 0 };
  const p = provider(async () => ({ ok: true, transaction: txn({ status: "failed" }) }), count);

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: p,
  });

  assert.equal(result.status, 200);
  assert.equal(result.outcome, "ignored");
  assert.equal(settleCalls(db.rpcCalls).length, 0, "a settled attempt is never re-settled");
  assert.equal(count.n, 0, "and it is not even worth asking the provider about");
  assert.equal(db.events[0].processed_at !== null, true);
});

test("an unrecognised event type is recorded and then ignored", async () => {
  const raw = body("customer.identification.failed");
  const count = { n: 0 };
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(async () => ({ ok: true, transaction: txn() }), count),
  });
  assert.equal(result.status, 200);
  assert.equal(result.outcome, "ignored");
  assert.equal(db.events.length, 1, "recorded, so a new Paystack event is never invisible");
  assert.equal(count.n, 0);
  assert.equal(settleCalls(db.rpcCalls).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// The success path, and everything it refuses
// ═════════════════════════════════════════════════════════════════════════════

test("a valid success is re-verified server-to-server and then settled", async () => {
  const raw = body("charge.success");
  const count = { n: 0 };
  const db = fakeSupabase({ attempt: attemptRow() });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(async () => ({ ok: true, transaction: txn() }), count),
  });

  assert.equal(result.status, 200);
  assert.equal(result.outcome, "processed");
  assert.equal(count.n, 1, "the payload is a hint; transaction/verify is the truth");

  const settled = settleCalls(db.rpcCalls);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].args.p_attempt, ATTEMPT);
  assert.equal(settled[0].args.p_status, "succeeded");
  assert.equal(settled[0].args.p_paid_cents, AMOUNT);
  assert.equal(settled[0].args.p_transaction_id, 9001);
  assert.equal(settled[0].args.p_channel, "card");
});

test("`transaction.success` is handled the same way as `charge.success`", async () => {
  const raw = body("transaction.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(result.outcome, "processed");
  assert.equal(settleCalls(db.rpcCalls).length, 1);
});

for (const bad of [
  { name: "amount", patch: { amountCents: AMOUNT + 1 } as Partial<VerifiedTransaction> },
  { name: "currency", patch: { currency: "NGN" } as Partial<VerifiedTransaction> },
  { name: "reference", patch: { reference: "SOMEBODY-ELSES-REF" } as Partial<VerifiedTransaction> },
  {
    name: "farm in the metadata",
    patch: { metadata: { farm_id: "another-farm", invoice_id: INVOICE } } as Partial<VerifiedTransaction>,
  },
  {
    name: "invoice in the metadata",
    patch: { metadata: { farm_id: FARM, invoice_id: "another-invoice" } } as Partial<VerifiedTransaction>,
  },
  { name: "status", patch: { status: "failed" as const, amountCents: AMOUNT } },
]) {
  test(`a verified transaction with the wrong ${bad.name} never marks the invoice paid`, async () => {
    const raw = body("charge.success");
    const db = fakeSupabase({ attempt: attemptRow() });

    const result = await handlePaystackWebhook({
      rawBody: raw,
      signature: sign(raw),
      supabase: db.client,
      provider: provider(async () => ({ ok: true, transaction: txn(bad.patch) })),
    });

    assert.equal(result.status, 200);
    const settled = settleCalls(db.rpcCalls);
    for (const call of settled) {
      assert.notEqual(
        call.args.p_status,
        "succeeded",
        `a ${bad.name} mismatch must never settle as paid`,
      );
    }
    // The refusal is written down where somebody will find it.
    if (result.outcome === "refused") {
      assert.ok(db.events[0].processing_error);
      assert.ok(!String(db.events[0].processing_error).includes(FARM));
    }
  });
}

test("an event naming a reference we never minted is refused", async () => {
  const raw = body("charge.success", { reference: "NOT-OURS" });
  const count = { n: 0 };
  // No attempt matches.
  const db = fakeSupabase({ attempt: null });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(async () => ({ ok: true, transaction: txn() }), count),
  });

  assert.equal(result.status, 200);
  assert.equal(result.outcome, "refused");
  assert.equal(count.n, 0, "a reference we do not know is not worth an API call");
  assert.equal(settleCalls(db.rpcCalls).length, 0);
  assert.ok(db.events[0].processing_error);
});

test("an event carrying no reference at all is refused", async () => {
  const raw = JSON.stringify({ event: "charge.success", data: { id: 9003, amount: AMOUNT } });
  const db = fakeSupabase({ attempt: attemptRow() });
  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: verifiesSuccess(),
  });
  assert.equal(result.outcome, "refused");
  assert.equal(settleCalls(db.rpcCalls).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// The failure path
// ═════════════════════════════════════════════════════════════════════════════

test("a failure event is verified too, and then settles failed", async () => {
  const raw = body("charge.failed");
  const count = { n: 0 };
  const db = fakeSupabase({ attempt: attemptRow() });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(
      async () => ({
        ok: true,
        transaction: txn({ status: "failed", gatewayResponse: "Insufficient funds" }),
      }),
      count,
    ),
  });

  assert.equal(result.outcome, "processed");
  assert.equal(count.n, 1, "even a failure is confirmed — a false failure starts dunning");
  const settled = settleCalls(db.rpcCalls);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].args.p_status, "failed");
});

test("a `charge.failed` for a transaction Paystack actually took money for settles PAID, not failed", async () => {
  // The whole reason a failure event is re-verified. Believing the payload here would
  // start the dunning machinery against a farm that has paid.
  const raw = body("charge.failed", { id: 9004 });
  const db = fakeSupabase({ attempt: attemptRow() });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(async () => ({ ok: true, transaction: txn({ status: "success" }) })),
  });

  assert.equal(result.outcome, "processed");
  assert.equal(settleCalls(db.rpcCalls)[0].args.p_status, "succeeded");
});

test("an unverifiable event is recorded, answered 200, and left to the reconciler", async () => {
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: db.client,
    provider: provider(async () => ({
      ok: false,
      deferred: false,
      reason: "payment provider timed out",
      retryable: true,
    })),
  });

  assert.equal(
    result.status,
    200,
    "a non-2xx would be redelivered, recognised as a duplicate, and achieve nothing",
  );
  assert.equal(result.outcome, "deferred");
  assert.equal(settleCalls(db.rpcCalls).length, 0, "nothing is settled on an unconfirmed event");
  assert.ok(db.events[0].processing_error);
});

test("a webhook never causes a charge", async () => {
  // `chargeAuthorization` on every provider in this file throws. Walking the main event
  // types proves no path reaches it.
  const db = fakeSupabase({ attempt: attemptRow() });
  for (const event of ["charge.success", "charge.failed", "transaction.success", "invoice.payment_failed"]) {
    const raw = body(event, { id: `unique-${event}` });
    const result = await handlePaystackWebhook({
      rawBody: raw,
      signature: sign(raw),
      supabase: db.client,
      provider: provider(async () => ({ ok: true, transaction: txn() })),
    });
    assert.equal(result.status, 200);
  }
});

test("a failure to RECORD the event stops every side effect and asks for a redelivery", async () => {
  const raw = body("charge.success");
  const db = fakeSupabase({ attempt: attemptRow() });
  // Make the insert fail with something that is NOT a duplicate key.
  const broken = {
    ...(db.client as unknown as Record<string, unknown>),
    from: (table: string) => {
      const real = (db.client as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      if (table !== "billing_webhook_events") return real;
      return {
        ...real,
        insert: () => ({
          select: () => ({
            maybeSingle: () => ({
              then: (ok: (v: Result) => unknown) =>
                Promise.resolve({
                  data: null,
                  error: { message: "connection lost", code: "08006" },
                }).then(ok),
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;

  const result = await handlePaystackWebhook({
    rawBody: raw,
    signature: sign(raw),
    supabase: broken,
    provider: verifiesSuccess(),
  });

  assert.equal(result.status, 500, "nothing was recorded, so a redelivery genuinely helps");
  assert.equal(settleCalls(db.rpcCalls).length, 0);
});
