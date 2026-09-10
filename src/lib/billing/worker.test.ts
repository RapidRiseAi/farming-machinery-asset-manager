/**
 * The charging worker, exercised without a network and without a database.
 *
 * ── The rule this file is built to obey ──────────────────────────────────────
 * NO TEST HERE MAY BE CAPABLE OF A LIVE CHARGE. Every provider is a hand-written object
 * with no HTTP in it, every Supabase call goes to an in-memory fake, and `globalThis.fetch`
 * is replaced with something that throws — so a future edit that accidentally reached the
 * real adapter would fail loudly rather than quietly contacting Paystack. The worker's
 * provider is always passed in explicitly, so `getSaasProvider()` (which dynamically
 * imports the adapter module) is never even reached.
 *
 * What is actually being pinned down, in order of how much money each one is worth:
 *
 *  - two workers racing a single invoice: the second claim returns NULL, and the second
 *    worker must NOT charge;
 *  - a timeout AFTER the provider has already succeeded: settles `unknown`, never
 *    `failed`, and is then resolved by VERIFYING that exact reference — never by charging
 *    again;
 *  - a success that does not match what we expected is never marked paid;
 *  - the kill switch stops new charges while reconciliation carries on;
 *  - and re-running the whole pass takes no more money than running it once.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SaasBillingProvider, VerifiedTransaction, VerifyResult } from "./types";
import type { DueCharge } from "./service";
import {
  chargeOneInvoice,
  reconcileStuckAttempts,
  retryInvoiceCharge,
  runBillingCharges,
} from "./worker";

// ── A fetch that must never be called ────────────────────────────────────────
// Installed once, for the whole file. If any code path under test reaches real HTTP the
// test fails on the spot instead of talking to a payment provider.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("a unit test attempted a real network call");
}) as typeof fetch;
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});

// ── Fakes ────────────────────────────────────────────────────────────────────

type Result = { data: unknown; error: { message: string; code?: string } | null };

type QueryCtx = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  filters: Record<string, unknown>;
  payload: unknown;
  single: boolean;
};

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeSupabase(opts: {
  rpc?: (name: string, args: Record<string, unknown>) => Result;
  table?: (ctx: QueryCtx) => Result;
}) {
  const rpcCalls: RpcCall[] = [];
  const tableCalls: QueryCtx[] = [];

  const builder = (table: string, kind: QueryCtx["kind"], payload: unknown) => {
    const ctx: QueryCtx = { table, kind, filters: {}, payload, single: false };
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
      maybeSingle: () => {
        ctx.single = true;
        return q;
      },
      then: (
        onFulfilled: (value: Result) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        tableCalls.push({ ...ctx, filters: { ...ctx.filters } });
        const out = opts.table ? opts.table(ctx) : { data: null, error: null };
        return Promise.resolve(out).then(onFulfilled, onRejected);
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

  return { client: client as unknown as SupabaseClient, rpcCalls, tableCalls };
}

function fakeProvider(over: Partial<SaasBillingProvider> = {}): SaasBillingProvider {
  return {
    provider: "fake",
    enabled: true,
    chargingEnabled: true,
    async initializeCheckout() {
      throw new Error("initializeCheckout is not stubbed in this test");
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
    ...over,
  };
}

const FARM = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const CARD = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
/** Obviously synthetic. Real prices are deliberately unseeded — see the contract §1. */
const AMOUNT = 1234;

function due(over: Partial<DueCharge> = {}): DueCharge {
  return {
    invoice_id: INVOICE,
    farm_id: FARM,
    subscription_id: "55555555-5555-4555-8555-555555555555",
    payment_method_id: CARD,
    amount_incl_cents: AMOUNT,
    invoice_ref: "FW-TEST-0001",
    attempt_number: 1,
    ...over,
  };
}

function txn(over: Partial<VerifiedTransaction> = {}): VerifiedTransaction {
  return {
    reference: "REF-1",
    transactionId: 9001,
    status: "success",
    amountCents: AMOUNT,
    currency: "ZAR",
    channel: "card",
    gatewayResponse: "Approved",
    paidAt: "2026-09-03T00:00:00.000Z",
    customerCode: "CUS_test",
    customerEmail: "owner@example.test",
    authorization: null,
    metadata: { farm_id: FARM, invoice_id: INVOICE },
    ...over,
  };
}

/** The credential row `paymentMethodCredential` expects, with a synthetic code. */
const CREDENTIAL_ROW = {
  authorization_code: "AUTH_synthetic",
  authorization_email: "authorized@example.test",
  reusable: true,
  status: "active",
  deleted_at: null,
};

/** A table handler that answers the credential read and nothing else. */
function credentialTable(ctx: QueryCtx): Result {
  if (ctx.table === "billing_payment_methods" && ctx.kind === "select") {
    return { data: CREDENTIAL_ROW, error: null };
  }
  return { data: null, error: null };
}

function settleCalls(rpcCalls: RpcCall[]): RpcCall[] {
  return rpcCalls.filter((c) => c.name === "billing_settle_attempt");
}

// ═════════════════════════════════════════════════════════════════════════════
// The kill switch
// ═════════════════════════════════════════════════════════════════════════════

test("with charging off the worker makes no charge and says why", async () => {
  let charged = 0;
  const provider = fakeProvider({
    enabled: true,
    chargingEnabled: false,
    async chargeAuthorization() {
      charged += 1;
      throw new Error("must not be reached");
    },
  });
  const { client, rpcCalls } = fakeSupabase({});

  const summary = await runBillingCharges(client, { provider });

  assert.equal(summary.skipped, "charging-disabled");
  assert.equal(summary.chargingEnabled, false);
  assert.equal(summary.considered, 0);
  assert.equal(charged, 0);
  // Not even the shortlist was read: nothing may be claimed when nothing may be charged.
  assert.equal(rpcCalls.length, 0);
});

test("with charging off the worker still reconciles", async () => {
  let verified = 0;
  let charged = 0;
  const provider = fakeProvider({
    enabled: true,
    chargingEnabled: false,
    async verifyTransaction() {
      verified += 1;
      return { ok: true, transaction: txn({ reference: "REF-STUCK", status: "failed" }) };
    },
    async chargeAuthorization() {
      charged += 1;
      throw new Error("reconciliation must never charge");
    },
  });

  const { client, rpcCalls } = fakeSupabase({
    table: (ctx) => {
      if (ctx.table === "billing_payment_attempts" && ctx.kind === "select") {
        return {
          data: [
            {
              id: ATTEMPT,
              farm_id: FARM,
              invoice_id: INVOICE,
              subscription_id: null,
              payment_method_id: CARD,
              attempt_ref: "REF-STUCK",
              kind: "charge_authorization",
              status: "unknown",
              amount_incl_cents: AMOUNT,
              currency: "ZAR",
              provider: "paystack",
              provider_transaction_id: null,
              requested_at: "2026-09-01T00:00:00.000Z",
              reconciled_at: null,
              reconcile_note: null,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    rpc: () => ({ data: null, error: null }),
  });

  const summary = await reconcileStuckAttempts(client, { provider });

  assert.equal(summary.skipped, null, "reconciliation must run with charging switched off");
  assert.equal(summary.checked, 1);
  assert.equal(verified, 1);
  assert.equal(charged, 0);
  assert.equal(summary.resolved, 1);
  assert.equal(rpcCalls.filter((c) => c.name === "billing_claim_charge").length, 0);
});

test("with no provider at all nothing is attempted", async () => {
  const { client, rpcCalls } = fakeSupabase({});
  const charges = await runBillingCharges(client, { provider: null });
  const reconciled = await reconcileStuckAttempts(client, { provider: null });
  assert.equal(charges.skipped, "provider-unavailable");
  assert.equal(reconciled.skipped, "provider-unavailable");
  assert.equal(rpcCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Two workers, one invoice
// ═════════════════════════════════════════════════════════════════════════════

test("two simultaneous workers: the second claim returns NULL and it does not charge", async () => {
  let charged = 0;
  const provider = fakeProvider({
    // Echo the reference we were given. That is what Paystack does, and
    // `matchesExpectedCharge` refuses a transaction whose reference is not ours — so a
    // fixture that invented its own would be testing nothing.
    async chargeAuthorization(req) {
      charged += 1;
      return { ok: true, transaction: txn({ reference: req.reference }) };
    },
  });

  // The claim succeeds once and then loses on the in-flight unique index, which is exactly
  // what `app.claim_billing_charge` returns NULL for.
  let claims = 0;
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => {
      if (name === "billing_claim_charge") {
        claims += 1;
        return { data: claims === 1 ? ATTEMPT : null, error: null };
      }
      return { data: null, error: null };
    },
  });

  const first = await chargeOneInvoice(client, provider, due());
  const second = await chargeOneInvoice(client, provider, due());

  assert.equal(first.result, "succeeded");
  assert.equal(second.result, "skipped");
  assert.equal(second.result === "skipped" ? second.reason : "", "claimed-elsewhere");
  assert.equal(charged, 1, "the loser of the claim must not contact the provider");
  assert.equal(claims, 2, "both workers must have tried to claim — the index decides");
  assert.equal(settleCalls(rpcCalls).length, 1);
});

test("a NULL claim is not reported as an error", async () => {
  const provider = fakeProvider({
    async chargeAuthorization() {
      throw new Error("must not be reached");
    },
  });
  const { client } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => (name === "billing_claim_charge" ? { data: null, error: null } : { data: null, error: null }),
  });

  const summary = await runBillingChargesWithRows(client, provider, [due()]);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.passed, 1);
  assert.equal(summary.claimed, 0);
});

/** `runBillingCharges` with a stubbed shortlist, so the due-list read is one line. */
async function runBillingChargesWithRows(
  client: SupabaseClient,
  provider: SaasBillingProvider,
  rows: DueCharge[],
) {
  const original = (client as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<Result> }).rpc;
  (client as unknown as { rpc: unknown }).rpc = (name: string, args: Record<string, unknown> = {}) => {
    if (name === "billing_due_charges") return Promise.resolve({ data: rows, error: null });
    return original.call(client, name, args);
  };
  return runBillingCharges(client, { provider });
}

// ═════════════════════════════════════════════════════════════════════════════
// Timeout is not failure
// ═════════════════════════════════════════════════════════════════════════════

test("a timeout AFTER a provider-side success settles unknown, and reconciliation — not a re-charge — resolves it", async () => {
  let charged = 0;
  let verifiedReference: string | null = null;

  // The charge reached Paystack and succeeded; the RESPONSE was lost. This is the case
  // that decides whether a farm can be charged twice.
  const chargingProvider = fakeProvider({
    async chargeAuthorization() {
      charged += 1;
      return {
        ok: false,
        deferred: false,
        reason: "payment provider timed out",
        retryable: true,
        // Nobody answered — that is the whole point of this case.
        answered: false,
      };
    },
  });

  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => (name === "billing_claim_charge" ? { data: ATTEMPT, error: null } : { data: null, error: null }),
  });

  const outcome = await chargeOneInvoice(client, chargingProvider, due());
  assert.equal(outcome.result, "unknown");
  assert.equal(charged, 1);

  const settled = settleCalls(rpcCalls);
  assert.equal(settled.length, 1);
  assert.equal(
    settled[0].args.p_status,
    "unknown",
    "a lost response must never settle `failed` — that starts dunning against a farm that may have paid",
  );

  // ── Now reconcile. It must VERIFY THAT EXACT REFERENCE and must not charge. ──
  const reconciler = fakeProvider({
    async verifyTransaction(reference: string) {
      verifiedReference = reference;
      return { ok: true, transaction: txn({ reference: "REF-TIMEOUT" }) };
    },
    async chargeAuthorization() {
      throw new Error("reconciliation must never charge");
    },
  });

  const stuck = fakeSupabase({
    table: (ctx) => {
      if (ctx.table === "billing_payment_attempts" && ctx.kind === "select") {
        return {
          data: [
            {
              id: ATTEMPT,
              farm_id: FARM,
              invoice_id: INVOICE,
              subscription_id: null,
              payment_method_id: CARD,
              attempt_ref: "REF-TIMEOUT",
              kind: "charge_authorization",
              status: "unknown",
              amount_incl_cents: AMOUNT,
              currency: "ZAR",
              provider: "paystack",
              provider_transaction_id: null,
              requested_at: "2026-09-01T00:00:00.000Z",
              reconciled_at: null,
              reconcile_note: null,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    rpc: () => ({ data: null, error: null }),
  });

  const summary = await reconcileStuckAttempts(stuck.client, { provider: reconciler });

  assert.equal(verifiedReference, "REF-TIMEOUT", "reconciliation asks about OUR reference");
  assert.equal(summary.resolved, 1);
  assert.equal(
    stuck.rpcCalls.filter((c) => c.name === "billing_claim_charge").length,
    0,
    "reconciliation must never claim a new charge",
  );
  const reconciledSettle = settleCalls(stuck.rpcCalls);
  assert.equal(reconciledSettle.length, 1);
  assert.equal(reconciledSettle[0].args.p_status, "succeeded");
  assert.equal(reconciledSettle[0].args.p_paid_cents, AMOUNT);
});

test("a terminal decline settles failed, not unknown", async () => {
  const provider = fakeProvider({
    async chargeAuthorization() {
      return {
        ok: false,
        deferred: false,
        reason: "Insufficient funds",
        retryable: false,
        // Paystack processed the charge and refused it. A decline IS an answer.
        answered: true,
      };
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => (name === "billing_claim_charge" ? { data: ATTEMPT, error: null } : { data: null, error: null }),
  });

  const outcome = await chargeOneInvoice(client, provider, due());
  assert.equal(outcome.result, "failed");
  assert.equal(settleCalls(rpcCalls)[0].args.p_status, "failed");
});

test("the kill switch moving mid-pass abandons rather than blocking the invoice", async () => {
  // `deferred` means nothing was sent. An `unknown` here would block every later attempt
  // on this invoice on behalf of a request that never left the building.
  const provider = fakeProvider({
    async chargeAuthorization() {
      return { ok: false, deferred: true, reason: "charging is switched off" };
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => (name === "billing_claim_charge" ? { data: ATTEMPT, error: null } : { data: null, error: null }),
  });

  const outcome = await chargeOneInvoice(client, provider, due());
  assert.equal(outcome.result, "abandoned");
  assert.equal(settleCalls(rpcCalls)[0].args.p_status, "abandoned");
});

// ═════════════════════════════════════════════════════════════════════════════
// A success we cannot recognise is not a payment
// ═════════════════════════════════════════════════════════════════════════════

for (const bad of [
  { name: "amount", patch: { amountCents: AMOUNT + 1 } },
  { name: "currency", patch: { currency: "NGN" } },
  { name: "farm metadata", patch: { metadata: { farm_id: "not-our-farm", invoice_id: INVOICE } } },
  { name: "invoice metadata", patch: { metadata: { farm_id: FARM, invoice_id: "not-our-invoice" } } },
]) {
  test(`a provider success with the wrong ${bad.name} is never marked paid`, async () => {
    const provider = fakeProvider({
      async chargeAuthorization() {
        return { ok: true, transaction: txn({ reference: "REF-MISMATCH", ...bad.patch }) };
      },
    });
    const { client, rpcCalls } = fakeSupabase({
      table: credentialTable,
      rpc: (name) => (name === "billing_claim_charge" ? { data: ATTEMPT, error: null } : { data: null, error: null }),
    });

    const outcome = await chargeOneInvoice(client, provider, due());
    assert.equal(outcome.result, "unknown");
    const settled = settleCalls(rpcCalls);
    assert.equal(settled.length, 1);
    assert.notEqual(settled[0].args.p_status, "succeeded");
    assert.equal(settled[0].args.p_paid_cents, null);
  });
}

test("a mismatch reason names fields and never values", async () => {
  const provider = fakeProvider({
    async chargeAuthorization() {
      return { ok: true, transaction: txn({ reference: "REF-X", amountCents: 999_999 }) };
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => (name === "billing_claim_charge" ? { data: ATTEMPT, error: null } : { data: null, error: null }),
  });

  await chargeOneInvoice(client, provider, due());
  const reason = String(settleCalls(rpcCalls)[0].args.p_failure_reason ?? "");
  assert.ok(reason.includes("amount"), "the field name is useful");
  assert.ok(!reason.includes("999999") && !reason.includes("999 999"), "the value is not");
  assert.ok(!reason.includes(FARM));
});

// ═════════════════════════════════════════════════════════════════════════════
// Nothing to charge with
// ═════════════════════════════════════════════════════════════════════════════

test("a farm with no usable card is skipped without claiming", async () => {
  const provider = fakeProvider({
    async chargeAuthorization() {
      throw new Error("must not be reached");
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    // A card that exists but is not reusable: `paymentMethodCredential` refuses it, and so
    // would `billing_payment_methods_reusable_ck`.
    table: (ctx) =>
      ctx.table === "billing_payment_methods"
        ? { data: { ...CREDENTIAL_ROW, reusable: false }, error: null }
        : { data: null, error: null },
    rpc: () => ({ data: null, error: null }),
  });

  const outcome = await chargeOneInvoice(client, provider, due());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.result === "skipped" ? outcome.reason : "", "no-stored-card");
  assert.equal(rpcCalls.filter((c) => c.name === "billing_claim_charge").length, 0);
});

test("an amount below Paystack's R1.00 floor is refused by us, not by them", async () => {
  const provider = fakeProvider({
    async chargeAuthorization() {
      throw new Error("must not be reached");
    },
  });
  const { client, rpcCalls } = fakeSupabase({ table: credentialTable });

  const outcome = await chargeOneInvoice(client, provider, due({ amount_incl_cents: 99 }));
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.result === "skipped" ? outcome.reason : "", "below-minimum");
  assert.equal(rpcCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Running the pass twice
// ═════════════════════════════════════════════════════════════════════════════

test("repeated cron execution charges once", async () => {
  let charged = 0;
  const provider = fakeProvider({
    async chargeAuthorization(req) {
      charged += 1;
      return { ok: true, transaction: txn({ reference: req.reference }) };
    },
  });

  // First pass: one invoice due. Second pass: it is paid, so the shortlist is empty —
  // which is what `app.due_billing_charges` genuinely returns once the rollup has moved
  // the invoice to `paid`.
  let pass = 0;
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => {
      if (name === "billing_due_charges") {
        pass += 1;
        return { data: pass === 1 ? [due()] : [], error: null };
      }
      if (name === "billing_claim_charge") return { data: ATTEMPT, error: null };
      return { data: null, error: null };
    },
  });

  const first = await runBillingCharges(client, { provider });
  const second = await runBillingCharges(client, { provider });

  assert.equal(first.succeeded, 1);
  assert.equal(second.considered, 0);
  assert.equal(second.succeeded, 0);
  assert.equal(charged, 1, "a second pass must not take a second payment");
  assert.equal(settleCalls(rpcCalls).length, 1);
});

test("a re-run while the first is still in flight charges nothing", async () => {
  // The invoice is still on the shortlist (the read is a snapshot), but the claim loses.
  // This is the shape of a cron that fires twice within seconds.
  let charged = 0;
  const provider = fakeProvider({
    async chargeAuthorization(req) {
      charged += 1;
      return { ok: true, transaction: txn({ reference: req.reference }) };
    },
  });
  const { client } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => {
      if (name === "billing_due_charges") return { data: [due()], error: null };
      if (name === "billing_claim_charge") return { data: null, error: null };
      return { data: null, error: null };
    },
  });

  const a = await runBillingCharges(client, { provider });
  const b = await runBillingCharges(client, { provider });

  assert.equal(charged, 0);
  assert.equal(a.passed, 1);
  assert.equal(b.passed, 1);
  assert.equal(a.errors.length + b.errors.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation refuses what it cannot recognise
// ═════════════════════════════════════════════════════════════════════════════

test("reconciliation refuses a verified success that does not match, and leaves it blocking", async () => {
  const provider = fakeProvider({
    async verifyTransaction() {
      return { ok: true, transaction: txn({ reference: "REF-BAD", amountCents: AMOUNT * 2 }) };
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: (ctx) =>
      ctx.table === "billing_payment_attempts" && ctx.kind === "select"
        ? {
            data: [
              {
                id: ATTEMPT,
                farm_id: FARM,
                invoice_id: INVOICE,
                subscription_id: null,
                payment_method_id: CARD,
                attempt_ref: "REF-BAD",
                kind: "charge_authorization",
                status: "unknown",
                amount_incl_cents: AMOUNT,
                currency: "ZAR",
                provider: "paystack",
                provider_transaction_id: null,
                requested_at: "2026-09-01T00:00:00.000Z",
                reconciled_at: null,
                reconcile_note: null,
              },
            ],
            error: null,
          }
        : { data: null, error: null },
    rpc: () => ({ data: null, error: null }),
  });

  const summary = await reconcileStuckAttempts(client, { provider });

  assert.equal(summary.resolved, 0);
  assert.equal(summary.stillOpen, 1);
  assert.equal(summary.outcomes[0].result, "refused");
  assert.equal(settleCalls(rpcCalls).length, 0, "a mismatch settles nothing at all");
});

// ═════════════════════════════════════════════════════════════════════════════
// An `unknown` that nothing could ever resolve
//
// (g) in the SQL suite proves an `unknown` attempt BLOCKS its invoice. Nothing proved
// anything ever unblocks it. Before this branch existed, a charge whose request never
// reached Paystack — a DNS failure, a proxy refusing it, a reference we mangled — settled
// `unknown` and stayed there for ever: `verifyTransaction` answered "no such transaction"
// on every pass, the reconciler fell through to `still-open`, and the invoice was never
// offered to a worker again. The farm was never charged, never went `past_due`, never got
// a reminder or a failure email, and on every screen looked exactly like a customer who
// was paid up. Revenue stopped for that farm with no operational symptom whatsoever.
//
// The pair below is the whole point. Both are non-retryable; only one is an ANSWER.
// ═════════════════════════════════════════════════════════════════════════════

/** One attempt sitting in `unknown`, as `unresolvedAttempts` would hand it over. */
function unknownAttemptTable(ref = "REF-GHOST") {
  return (ctx: QueryCtx): Result =>
    ctx.table === "billing_payment_attempts" && ctx.kind === "select"
      ? {
          data: [
            {
              id: ATTEMPT,
              farm_id: FARM,
              invoice_id: INVOICE,
              subscription_id: null,
              payment_method_id: CARD,
              attempt_ref: ref,
              kind: "charge_authorization",
              status: "unknown",
              amount_incl_cents: AMOUNT,
              currency: "ZAR",
              provider: "paystack",
              provider_transaction_id: null,
              requested_at: "2026-09-01T00:00:00.000Z",
              reconciled_at: null,
              reconcile_note: null,
            },
          ],
          error: null,
        }
      : { data: null, error: null };
}

test("a reference the provider has never heard of is closed, and the invoice is freed", async () => {
  let charged = 0;
  const provider = fakeProvider({
    async verifyTransaction() {
      // Paystack's own answer for a reference it does not hold: a 404 carrying
      // `status:false`. It processed the question. No money moved under this reference.
      return {
        ok: false,
        deferred: false,
        reason: "Transaction reference not found",
        retryable: false,
        answered: true,
      };
    },
    async chargeAuthorization() {
      charged += 1;
      throw new Error("reconciliation must never charge");
    },
  });

  const { client, rpcCalls } = fakeSupabase({
    table: unknownAttemptTable(),
    rpc: () => ({ data: null, error: null }),
  });

  const summary = await reconcileStuckAttempts(client, { provider });

  assert.equal(summary.checked, 1);
  assert.equal(summary.outcomes[0].result, "abandoned");
  assert.equal(summary.stillOpen, 0, "an attempt nobody can ever resolve must not stay open");
  assert.equal(charged, 0, "resolving an unknown is never done by charging again");

  const settled = settleCalls(rpcCalls);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].args.p_attempt, ATTEMPT);
  // `abandoned`, NOT `failed`. `failed` would run `billing_register_failure` and start a
  // farm down the dunning ladder for a request that never reached the provider — their
  // card is fine and they have done nothing wrong.
  assert.equal(settled[0].args.p_status, "abandoned");
  assert.match(String(settled[0].args.p_failure_reason), /reference not found/i);
});

test("an unknown is NOT closed when the failure is ours rather than the provider's", async () => {
  // Every one of these is `retryable: false`, and not one is an answer about the
  // customer's money. Closing an attempt on any of them would hand a possibly-charged
  // invoice back to the charging queue — the double charge this whole design prevents.
  const ourFaults = [
    { reason: "billing provider is not configured", answered: false },
    { reason: "reference is required", answered: false },
    { reason: "payment provider returned no data", answered: false },
  ];

  for (const fault of ourFaults) {
    const provider = fakeProvider({
      async verifyTransaction() {
        return {
          ok: false,
          deferred: false,
          reason: fault.reason,
          retryable: false,
          answered: fault.answered,
        };
      },
    });
    const { client, rpcCalls } = fakeSupabase({
      table: unknownAttemptTable(),
      rpc: () => ({ data: null, error: null }),
    });

    const summary = await reconcileStuckAttempts(client, { provider });

    assert.equal(summary.outcomes[0].result, "still-open", `"${fault.reason}" must not close an attempt`);
    assert.equal(summary.stillOpen, 1, `"${fault.reason}" must leave the invoice blocked`);
    assert.equal(
      settleCalls(rpcCalls).length,
      0,
      `"${fault.reason}" is not an answer about the money and must settle nothing`,
    );
  }
});

test("a provider outage still leaves the unknown blocking", async () => {
  // The control for the pair above: retryable AND unanswered is the ordinary outage, and
  // it must behave exactly as it always has. If this ever changed to `abandoned`, the
  // two assertions above would still pass while every timeout freed an invoice.
  const provider = fakeProvider({
    async verifyTransaction() {
      return {
        ok: false,
        deferred: false,
        reason: "payment provider timed out",
        retryable: true,
        answered: false,
      };
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: unknownAttemptTable(),
    rpc: () => ({ data: null, error: null }),
  });

  const summary = await reconcileStuckAttempts(client, { provider });

  assert.equal(summary.outcomes[0].result, "still-open");
  assert.equal(summary.stillOpen, 1);
  assert.equal(settleCalls(rpcCalls).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// "Try again" — the manual path
//
// It used to rebuild the AUTOMATIC shortlist (`billing_due_charges`) and look for the
// invoice in it. That shortlist carries the retry timer, so after a decline the owner's
// button answered "nothing is due" for three days while the invoice was unpaid; and it
// carries `status in ('active','past_due')`, so from the moment a farm entered grace the
// stored card was never presented again by anything at all.
//
// Which RPC is called is therefore the whole assertion. Both functions return the same
// row shape, so a test that only checked the OUTCOME would pass against either.
// ═════════════════════════════════════════════════════════════════════════════

test("a manual retry asks the manual function, not the nightly shortlist", async () => {
  let charged = 0;
  const provider = fakeProvider({
    async chargeAuthorization(req) {
      charged += 1;
      // Echo the reference we minted. matchesExpectedCharge checks it, and a provider
      // describing some OTHER transaction must never be treated as this one succeeding.
      return { ok: true, transaction: txn({ reference: req.reference }) };
    },
  });

  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) => {
      if (name === "billing_invoice_chargeable_now") return { data: [due()], error: null };
      // The nightly shortlist is deliberately EMPTY here: this invoice is inside its
      // retry window, which is exactly the state the old code could not charge in.
      if (name === "billing_due_charges") return { data: [], error: null };
      if (name === "billing_claim_charge") return { data: ATTEMPT, error: null };
      return { data: null, error: null };
    },
  });

  const outcome = await retryInvoiceCharge(client, { invoiceId: INVOICE, farmId: FARM }, { provider });

  assert.equal(outcome.result, "succeeded");
  assert.equal(charged, 1, "a customer who wants to pay must be able to");
  assert.equal(
    rpcCalls.filter((c) => c.name === "billing_due_charges").length,
    0,
    "the manual path must not consult the shortlist that carries the retry timer",
  );
  const asked = rpcCalls.filter((c) => c.name === "billing_invoice_chargeable_now");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].args.p_invoice, INVOICE, "keyed on the invoice, by name");
  assert.equal(settleCalls(rpcCalls)[0].args.p_status, "succeeded");
});

test("a manual retry cannot spend another farm's invoice", async () => {
  // `app.invoice_chargeable_now` is keyed on the invoice alone, so unlike the shortlist
  // it cannot do the tenancy check for us. This is that check.
  const provider = fakeProvider({
    async chargeAuthorization() {
      throw new Error("a cross-farm retry must never reach the provider");
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) =>
      name === "billing_invoice_chargeable_now"
        ? { data: [due({ farm_id: "99999999-9999-4999-8999-999999999999" })], error: null }
        : { data: null, error: null },
  });

  const outcome = await retryInvoiceCharge(client, { invoiceId: INVOICE, farmId: FARM }, { provider });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "nothing-due");
  assert.equal(rpcCalls.filter((c) => c.name === "billing_claim_charge").length, 0);
});

test("a manual retry on a blocked invoice claims nothing", async () => {
  // No row means: paid, nothing outstanding, no usable card, an attempt already in
  // flight, or a farm that has been deleted or cancelled. Every one of those is "not
  // now" and none of them is an error the owner should see as a failure.
  const provider = fakeProvider({
    async chargeAuthorization() {
      throw new Error("nothing was chargeable; nothing may be charged");
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    table: credentialTable,
    rpc: (name) =>
      name === "billing_invoice_chargeable_now" ? { data: [], error: null } : { data: null, error: null },
  });

  const outcome = await retryInvoiceCharge(client, { invoiceId: INVOICE, farmId: FARM }, { provider });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "nothing-due");
  assert.equal(rpcCalls.filter((c) => c.name === "billing_claim_charge").length, 0);
});

test("a manual retry is still refused with charging switched off", async () => {
  const provider = fakeProvider({
    chargingEnabled: false,
    async chargeAuthorization() {
      throw new Error("the kill switch must hold on every path, buttons included");
    },
  });
  const { client, rpcCalls } = fakeSupabase({
    rpc: () => ({ data: null, error: null }),
  });

  const outcome = await retryInvoiceCharge(client, { invoiceId: INVOICE, farmId: FARM }, { provider });

  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "charging-disabled");
  assert.equal(rpcCalls.length, 0, "the switch is checked before any database call");
});
