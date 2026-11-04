/**
 * Two service-layer refusals from the fourth billing review, exercised without a network
 * and without a database, in the same style as `worker.test.ts`: every Supabase call goes
 * to an in-memory fake, the provider is a hand-written object passed in explicitly, and
 * `globalThis.fetch` throws, so nothing here can reach Paystack.
 *
 *  - `beginCheckout` and a stale amount (finding app-11). `app.claim_billing_charge`
 *    refuses an amount above what is owed under its row lock (errcode 22023, 'BILLING: the
 *    amount owed has changed'), because an EFT recorded between the checkout's read and its
 *    claim sent the customer to pay more than they owed. The checkout reads once more and
 *    claims what is owed now; a second refusal is `billing-amount-changed`.
 *  - `setCancellation` and a suspended subscription (finding money-4). Cancelling one left
 *    the farm suspended for good, so the update carries the status condition and a row it
 *    did not change comes back as `billing-cancel-suspended`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CheckoutInit, CheckoutSession, SaasBillingProvider, VerifiedTransaction, VerifyResult } from "./types";
import { beginCheckout, setCancellation } from "./service";
import { STALE_PENDING_MINUTES } from "./worker";
import { ERROR_CODE_KEYS } from "@/lib/errors";
import en from "@/lib/i18n/en.json";
import af from "@/lib/i18n/af.json";

// == A fetch that must never be called ========================================
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("a unit test attempted a real network call");
}) as typeof fetch;
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});

// The callback URL is built from this; the checkout refuses to start without it.
process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.test";

// == Fakes ====================================================================

type Result = { data: unknown; error: { message: string; code?: string } | null };

type QueryCtx = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  columns: string | null;
  filters: Record<string, unknown>;
  neq: Record<string, unknown>;
  /** `.not(col, op, value)`: the condition a write must NOT match. */
  not: Record<string, { op: string; value: unknown }>;
  payload: unknown;
  /** `.select(...)` after a write: the caller asked for the changed rows back. */
  returning: string | null;
};

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeSupabase(opts: {
  rpc?: (name: string, args: Record<string, unknown>, nth: number) => Result;
  table?: (ctx: QueryCtx, nth: number) => Result;
}) {
  const rpcCalls: RpcCall[] = [];
  const tableCalls: QueryCtx[] = [];

  const builder = (table: string, kind: QueryCtx["kind"], payload: unknown, columns: string | null) => {
    const ctx: QueryCtx = { table, kind, columns, filters: {}, neq: {}, not: {}, payload, returning: null };
    const filter = (col: string, val: unknown) => {
      ctx.filters[col] = val;
      return q;
    };
    const q: Record<string, unknown> = {
      select: (cols: string) => {
        if (kind === "select") ctx.columns = cols;
        else ctx.returning = cols;
        return q;
      },
      eq: filter,
      is: filter,
      in: filter,
      lt: filter,
      lte: filter,
      neq: (col: string, val: unknown) => {
        ctx.neq[col] = val;
        return q;
      },
      not: (col: string, op: string, value: unknown) => {
        ctx.not[col] = { op, value };
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: () => q,
      then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) => {
        const snapshot = { ...ctx, filters: { ...ctx.filters }, neq: { ...ctx.neq }, not: { ...ctx.not } };
        tableCalls.push(snapshot);
        const nth = tableCalls.filter((c) => c.table === table && c.kind === kind).length;
        const out = opts.table ? opts.table(snapshot, nth) : { data: null, error: null };
        return Promise.resolve(out).then(onFulfilled, onRejected);
      },
    };
    return q;
  };

  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const nth = rpcCalls.filter((c) => c.name === name).length;
      return Promise.resolve(opts.rpc ? opts.rpc(name, args, nth) : { data: null, error: null });
    },
    from(table: string) {
      return {
        select: (cols: string) => builder(table, "select", null, cols),
        insert: (payload: unknown) => builder(table, "insert", payload, null),
        update: (payload: unknown) => builder(table, "update", payload, null),
        delete: () => builder(table, "delete", null, null),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, rpcCalls, tableCalls };
}

function fakeProvider(inits: CheckoutInit[]): SaasBillingProvider {
  return {
    provider: "fake",
    enabled: true,
    chargingEnabled: true,
    async initializeCheckout(init: CheckoutInit): Promise<CheckoutSession> {
      inits.push(init);
      return {
        ok: true,
        authorizationUrl: "https://checkout.paystack.com/synthetic",
        accessCode: "synthetic",
        reference: init.reference,
      };
    },
    async verifyTransaction(): Promise<VerifyResult> {
      throw new Error("verifyTransaction is not stubbed in this test");
    },
    async chargeAuthorization(): Promise<VerifyResult> {
      throw new Error("chargeAuthorization is not stubbed in this test");
    },
    verifyWebhookSignature() {
      return true;
    },
  };
}

const FARM = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const OTHER_INVOICE = "66666666-6666-4666-8666-666666666666";
const SUB = "55555555-5555-4555-8555-555555555555";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";

const SUBSCRIPTION_ROW = {
  id: SUB,
  farm_id: FARM,
  plan: "complete",
  billing_period: "monthly",
  status: "pending",
  cancel_at_period_end: false,
  current_period_end: null,
  default_payment_method_id: null,
  plan_before_downgrade: null,
};

function invoice(id: string, paidCents: number) {
  return {
    id,
    farm_id: FARM,
    subscription_id: SUB,
    invoice_ref: `FW-TEST-${id.slice(0, 4)}`,
    status: "open",
    total_incl_cents: 100000,
    amount_paid_cents: paidCents,
    currency: "ZAR",
  };
}

const STALE = { message: "BILLING: the amount owed has changed", code: "22023" };

/**
 * The checkout's reads. `invoices(n)` answers the n-th `openInvoiceForFarm` read, so a test
 * can change what is owed between the first read and the re-read.
 */
function checkoutTables(invoices: (nth: number) => unknown[]) {
  return (ctx: QueryCtx, nth: number): Result => {
    if (ctx.table === "billing_subscriptions" && ctx.kind === "select") return { data: SUBSCRIPTION_ROW, error: null };
    if (ctx.table === "billing_invoices" && ctx.kind === "select") return { data: invoices(nth), error: null };
    // No refunds anywhere in these tests.
    if (ctx.table === "billing_payments" && ctx.kind === "select") return { data: [], error: null };
    return { data: null, error: null };
  };
}

function claims(rpcCalls: RpcCall[]): RpcCall[] {
  return rpcCalls.filter((c) => c.name === "billing_claim_charge");
}

function invoiceReads(tableCalls: QueryCtx[]): QueryCtx[] {
  return tableCalls.filter((c) => c.table === "billing_invoices" && c.kind === "select");
}

// ═════════════════════════════════════════════════════════════════════════════
// beginCheckout: the amount moved between the read and the claim (app-11)
// ═════════════════════════════════════════════════════════════════════════════

test("a stale claim is read again and claimed at what is owed now, not at the old amount", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls, tableCalls } = fakeSupabase({
    // R1 000 owed at the first read; Rapid Rise records a R500 EFT before the claim.
    table: checkoutTables((nth) => [invoice(INVOICE, nth === 1 ? 0 : 50000)]),
    rpc: (name, _args, nth) =>
      name === "billing_claim_charge"
        ? nth === 1
          ? { data: null, error: STALE }
          : { data: ATTEMPT, error: null }
        : { data: null, error: null },
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: fakeProvider(inits),
  });

  assert.equal(started.ok, true);
  const made = claims(rpcCalls);
  assert.equal(made.length, 2, "one refused claim, one retry");
  assert.equal(made[0].args.p_amount, 100000);
  assert.equal(made[1].args.p_amount, 50000, "the retry claims what is owed after the EFT");
  assert.equal(made[1].args.p_invoice, INVOICE);
  assert.notEqual(made[1].args.p_ref, made[0].args.p_ref, "the retry mints its own reference");
  assert.equal(invoiceReads(tableCalls).length, 2, "the outstanding is read exactly once more");
  assert.equal(inits.length, 1);
  assert.equal(inits[0].amountCents, 50000, "Paystack is asked for what is owed, never the stale amount");
  assert.equal(inits[0].reference, made[1].args.p_ref, "the session carries the claimed reference");
});

test("a claim refused twice is billing-amount-changed, and nobody is sent to pay", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: checkoutTables((nth) => [invoice(INVOICE, nth === 1 ? 0 : 50000)]),
    rpc: (name) => (name === "billing_claim_charge" ? { data: null, error: STALE } : { data: null, error: null }),
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: fakeProvider(inits),
  });

  assert.deepEqual(started, { ok: false, code: "billing-amount-changed" });
  assert.equal(claims(rpcCalls).length, 2, "once more, not in a loop");
  assert.equal(inits.length, 0);
});

test("when the EFT paid that invoice and another is now the oldest owed, the person looks again", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: checkoutTables((nth) => [nth === 1 ? invoice(INVOICE, 0) : invoice(OTHER_INVOICE, 0)]),
    rpc: (name) => (name === "billing_claim_charge" ? { data: null, error: STALE } : { data: null, error: null }),
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: fakeProvider(inits),
  });

  assert.deepEqual(started, { ok: false, code: "billing-amount-changed" });
  assert.equal(claims(rpcCalls).length, 1, "a bill the person did not press Pay for is not claimed");
  assert.equal(inits.length, 0);
});

test("when the EFT paid everything, the re-read says there is nothing to pay", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: checkoutTables((nth) => (nth === 1 ? [invoice(INVOICE, 0)] : [])),
    rpc: (name) => (name === "billing_claim_charge" ? { data: null, error: STALE } : { data: null, error: null }),
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: fakeProvider(inits),
  });

  assert.deepEqual(started, { ok: false, code: "billing-nothing-due" });
  assert.equal(claims(rpcCalls).length, 1);
  assert.equal(inits.length, 0);
});

test("any other claim error is not retried: billing-claim-failed after one claim and one read", async () => {
  for (const error of [
    { message: "connection reset", code: "08006" },
    // The same errcode with other words is a different refusal and must not be retried.
    { message: "BILLING: something else entirely", code: "22023" },
  ]) {
    const inits: CheckoutInit[] = [];
    const { client, rpcCalls, tableCalls } = fakeSupabase({
      table: checkoutTables(() => [invoice(INVOICE, 0)]),
      rpc: (name) => (name === "billing_claim_charge" ? { data: null, error } : { data: null, error: null }),
    });

    const started = await beginCheckout(client, {
      farmId: FARM,
      email: "owner@example.test",
      provider: fakeProvider(inits),
    });

    assert.deepEqual(started, { ok: false, code: "billing-claim-failed" }, error.message);
    assert.equal(claims(rpcCalls).length, 1, error.message);
    assert.equal(invoiceReads(tableCalls).length, 1, error.message);
    assert.equal(inits.length, 0);
  }
});

test("a retry that loses to an attempt already in flight is billing-in-flight, as the first claim would be", async () => {
  const inits: CheckoutInit[] = [];
  const { client } = fakeSupabase({
    table: checkoutTables((nth) => [invoice(INVOICE, nth === 1 ? 0 : 50000)]),
    rpc: (name, _args, nth) =>
      name === "billing_claim_charge"
        ? nth === 1
          ? { data: null, error: STALE }
          : { data: null, error: null }
        : { data: null, error: null },
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: fakeProvider(inits),
  });

  assert.deepEqual(started, { ok: false, code: "billing-in-flight" });
  assert.equal(inits.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// setCancellation: a suspended subscription is refused (money-4)
// ═════════════════════════════════════════════════════════════════════════════

test("the cancellation update itself excludes suspended, pending and cancelled subscriptions", async () => {
  for (const immediate of [false, true]) {
    const { client, tableCalls } = fakeSupabase({
      table: (ctx) =>
        ctx.kind === "update" ? { data: [{ id: SUB }], error: null } : { data: null, error: null },
    });

    const out = await setCancellation(client, { subscriptionId: SUB, farmId: FARM, immediate });

    assert.deepEqual(out, { error: null, refused: null });
    const update = tableCalls.find((c) => c.table === "billing_subscriptions" && c.kind === "update");
    assert.ok(update, "the subscription is updated");
    assert.equal(update.filters.id, SUB);
    assert.equal(update.filters.farm_id, FARM);
    assert.deepEqual(
      update.not.status,
      { op: "in", value: "(suspended,pending,cancelled)" },
      "the condition is on the write, not a read before it",
    );
    assert.ok(update.returning, "the changed rows are asked back, so 'nothing changed' is visible");
    assert.equal(
      (update.payload as { status: string }).status,
      immediate ? "cancelled" : "non_renewing",
    );
    assert.equal(tableCalls.length, 1, "a cancellation that applied reads nothing more");
  }
});

test("a suspended subscription is refused with billing-cancel-suspended, owner and Rapid Rise alike", async () => {
  for (const immediate of [false, true]) {
    const { client } = fakeSupabase({
      table: (ctx) =>
        ctx.kind === "update"
          ? { data: [], error: null }
          : { data: { status: "suspended" }, error: null },
    });

    const out = await setCancellation(client, { subscriptionId: SUB, farmId: FARM, immediate });

    assert.deepEqual(out, { error: null, refused: "billing-cancel-suspended" });
  }
});

test("an unpaid sign-up and a cancelled subscription are refused too, each with its own code (round 5, money-8)", async () => {
  for (const [status, code] of [
    ["pending", "billing-cancel-pending"],
    ["cancelled", "billing-already-cancelled"],
  ] as const) {
    const { client } = fakeSupabase({
      table: (ctx) => (ctx.kind === "update" ? { data: [], error: null } : { data: { status }, error: null }),
    });

    const out = await setCancellation(client, { subscriptionId: SUB, farmId: FARM, immediate: false });

    assert.deepEqual(out, { error: null, refused: code }, status);
  }
});

test("a row that changed for no stated reason is a failed save, never a silent success", async () => {
  const { client } = fakeSupabase({
    table: (ctx) => (ctx.kind === "update" ? { data: [], error: null } : { data: null, error: null }),
  });

  const out = await setCancellation(client, { subscriptionId: SUB, farmId: FARM, immediate: false });

  assert.equal(out.refused, null);
  assert.ok(out.error, "the action turns this into billing-save-failed");
});

test("a failed update is an error, not a refusal", async () => {
  const { client } = fakeSupabase({
    table: (ctx) =>
      ctx.kind === "update" ? { data: null, error: { message: "boom", code: "08006" } } : { data: null, error: null },
  });

  const out = await setCancellation(client, { subscriptionId: SUB, farmId: FARM, immediate: true });

  assert.equal(out.refused, null);
  assert.equal(out.error?.code, "08006");
});

// ═════════════════════════════════════════════════════════════════════════════
// The two new codes reach a person as a sentence, in both languages
// ═════════════════════════════════════════════════════════════════════════════

test("the new billing codes are translated, not shown as codes", () => {
  const look = (dict: unknown, key: string) =>
    key.split(".").reduce<unknown>((o, s) => (o && typeof o === "object" ? (o as Record<string, unknown>)[s] : undefined), dict);
  for (const code of ["billing-amount-changed", "billing-cancel-suspended", "billing-cancel-pending", "billing-change-paused"]) {
    const key = ERROR_CODE_KEYS[code];
    assert.ok(key, `${code} is mapped`);
    assert.equal(typeof look(en, key), "string", `${key} in en`);
    assert.equal(typeof look(af, key), "string", `${key} in af`);
    assert.notEqual(look(en, key), look(af, key), `${key} is translated`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// beginCheckout: a checkout left at Paystack (round 5, finding app-2)
// ═════════════════════════════════════════════════════════════════════════════

const STALE_REF = "fw_stale_checkout_ref";

function pendingCheckout(minutesAgo: number, kind = "initial_checkout") {
  return {
    id: ATTEMPT,
    farm_id: FARM,
    invoice_id: INVOICE,
    subscription_id: SUB,
    payment_method_id: null,
    attempt_ref: STALE_REF,
    kind,
    status: "pending",
    amount_incl_cents: 100000,
    currency: "ZAR",
    provider: "paystack",
    provider_transaction_id: null,
    requested_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    reconciled_at: null,
    reconcile_note: null,
  };
}

/** The checkout's reads, plus the attempt that beat its first claim. */
function staleTables(attempt: unknown) {
  const base = checkoutTables(() => [invoice(INVOICE, 0)]);
  return (ctx: QueryCtx, nth: number): Result =>
    ctx.table === "billing_payment_attempts" && ctx.kind === "select" ? { data: attempt, error: null } : base(ctx, nth);
}

/** The first claim loses to the attempt in flight; any later one wins. */
function claimLosesOnce(name: string, _args: Record<string, unknown>, nth: number): Result {
  if (name === "billing_claim_charge") return nth === 1 ? { data: null, error: null } : { data: ATTEMPT, error: null };
  return { data: null, error: null };
}

function providerVerifying(inits: CheckoutInit[], verify: () => Promise<VerifyResult>): SaasBillingProvider {
  return { ...fakeProvider(inits), verifyTransaction: verify };
}

function paystackTxn(over: Partial<VerifiedTransaction>): VerifiedTransaction {
  return {
    reference: STALE_REF,
    transactionId: 7001,
    status: "abandoned",
    amountCents: 100000,
    currency: "ZAR",
    channel: "card",
    gatewayResponse: "Abandoned",
    paidAt: null,
    customerCode: "CUS_test",
    customerEmail: "owner@example.test",
    authorization: null,
    metadata: { farm_id: FARM, invoice_id: INVOICE },
    ...over,
  } as VerifiedTransaction;
}

function settles(rpcCalls: RpcCall[]): RpcCall[] {
  return rpcCalls.filter((c) => c.name === "billing_settle_attempt");
}

test("an abandoned checkout older than the stale window is closed at Paystack and a new one starts", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: staleTables(pendingCheckout(STALE_PENDING_MINUTES + 1)),
    rpc: claimLosesOnce,
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: providerVerifying(inits, async () => ({ ok: true, transaction: paystackTxn({ status: "abandoned" }) })),
  });

  assert.equal(started.ok, true, "the customer is sent to pay");
  const made = claims(rpcCalls);
  assert.equal(made.length, 2, "one claim lost to the old attempt, one after it was closed");
  assert.notEqual(made[1].args.p_ref, STALE_REF, "the new checkout has its own reference");
  const settled = settles(rpcCalls);
  assert.equal(settled.length, 1, "the old attempt is settled once");
  assert.equal(settled[0].args.p_status, "abandoned");
  assert.equal(inits.length, 1);
  assert.equal(inits[0].reference, made[1].args.p_ref);
});

test("a stale checkout that Paystack says was PAID is never charged again: nothing is due", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: staleTables(pendingCheckout(STALE_PENDING_MINUTES + 5)),
    rpc: claimLosesOnce,
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: providerVerifying(inits, async () => ({
      ok: true,
      transaction: paystackTxn({ status: "success", gatewayResponse: "Approved", paidAt: new Date().toISOString() }),
    })),
  });

  assert.deepEqual(started, { ok: false, code: "billing-nothing-due" });
  assert.equal(claims(rpcCalls).length, 1, "no second claim");
  assert.equal(settles(rpcCalls)[0]?.args.p_status, "succeeded", "the payment is recorded");
  assert.equal(inits.length, 0, "nobody is sent to Paystack again");
});

test("a checkout younger than the stale window is somebody at Paystack now: in progress, Paystack not asked", async () => {
  const inits: CheckoutInit[] = [];
  let asked = 0;
  const { client, rpcCalls } = fakeSupabase({
    table: staleTables(pendingCheckout(STALE_PENDING_MINUTES - 5)),
    rpc: claimLosesOnce,
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: providerVerifying(inits, async () => {
      asked += 1;
      throw new Error("must not be asked");
    }),
  });

  assert.deepEqual(started, { ok: false, code: "billing-in-flight" });
  assert.equal(asked, 0);
  assert.equal(claims(rpcCalls).length, 1);
  assert.equal(inits.length, 0);
});

test("when Paystack cannot be reached the old checkout stays blocking: in progress, never a second charge", async () => {
  const inits: CheckoutInit[] = [];
  const { client, rpcCalls } = fakeSupabase({
    table: staleTables(pendingCheckout(STALE_PENDING_MINUTES + 1)),
    rpc: claimLosesOnce,
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: providerVerifying(
      inits,
      async () => ({ ok: false, deferred: false, reason: "timeout", retryable: true, answered: false }) as VerifyResult,
    ),
  });

  assert.deepEqual(started, { ok: false, code: "billing-in-flight" });
  assert.equal(claims(rpcCalls).length, 1, "no second claim");
  assert.notEqual(settles(rpcCalls)[0]?.args.p_status, "abandoned", "an unanswered question never frees the invoice");
  assert.equal(inits.length, 0);
});

test("a stored-card charge in flight is left to the reconciler: in progress, Paystack not asked", async () => {
  const inits: CheckoutInit[] = [];
  let asked = 0;
  const { client, rpcCalls } = fakeSupabase({
    table: staleTables(pendingCheckout(STALE_PENDING_MINUTES + 60, "renewal")),
    rpc: claimLosesOnce,
  });

  const started = await beginCheckout(client, {
    farmId: FARM,
    email: "owner@example.test",
    provider: providerVerifying(inits, async () => {
      asked += 1;
      throw new Error("must not be asked");
    }),
  });

  assert.deepEqual(started, { ok: false, code: "billing-in-flight" });
  assert.equal(asked, 0);
  assert.equal(claims(rpcCalls).length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// The slot and plan screens and the engine agree on the paused refusal (round 5, gate-3)
// ═════════════════════════════════════════════════════════════════════════════

test("the billing actions recognise the engine's paused refusal by its exact words", () => {
  const actions = readFileSync(join(process.cwd(), "src/app/(app)/billing/actions.ts"), "utf8");
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261029160000_billing_review_fixes_5.sql"), "utf8");
  const pattern = actions.match(/const PAUSED_CHANGE = \/(.+)\/i;/);
  const raised = [...sql.matchAll(/raise exception '(BILLING: a paused subscription[^']*)'/g)].map((m) => m[1]);
  assert.ok(pattern, "PAUSED_CHANGE is declared in billing/actions.ts");
  assert.equal(raised.length, 2, "both change_billing_quota and change_billing_plan raise it");
  for (const message of raised) assert.match(message, new RegExp(pattern[1], "i"));
});
