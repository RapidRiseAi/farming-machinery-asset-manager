/**
 * What the stopped-farm pages (/activate, /suspended) offer next to their Pay button,
 * pinned without a database: the Supabase client is an in-memory fake, as in
 * `worker.test.ts`.
 *
 *  - The "already paid?" read counts attempts on THE invoice being paid only (finding
 *    app-1): a reopened farm that once paid by card was told "payment received" over its
 *    new bill and never shown a Pay button again. With no invoice nothing is read.
 *  - What is still overdue after this one payment (finding app-4): /suspended printed the
 *    total of every open invoice over a button that charges one, and promised everything
 *    comes back.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accessGraceDays,
  overdueAfterPaying,
  settlingFrom,
  settlingOnInvoice,
  type OpenInvoice,
} from "./stopped-farm";
import { STALE_PENDING_MINUTES } from "./worker";

type Result = { data: unknown; error: { message: string; code?: string } | null };
type QueryCtx = { table: string; filters: Record<string, unknown> };

function fakeSupabase(answer: (ctx: QueryCtx) => Result) {
  const calls: QueryCtx[] = [];
  const client = {
    from(table: string) {
      const ctx: QueryCtx = { table, filters: {} };
      const filter = (col: string, val: unknown) => {
        ctx.filters[col] = val;
        return q;
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: filter,
        in: filter,
        is: filter,
        order: () => q,
        limit: () => q,
        maybeSingle: () => q,
        then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) => {
          calls.push({ table, filters: { ...ctx.filters } });
          return Promise.resolve(answer(ctx)).then(onFulfilled, onRejected);
        },
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const FARM = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

// ═════════════════════════════════════════════════════════════════════════════
// Settling
// ═════════════════════════════════════════════════════════════════════════════

test("a succeeded attempt is 'received', a fresh pending one 'inflight', a stale one nothing", () => {
  assert.equal(settlingFrom(null, NOW), null);
  assert.equal(settlingFrom({ status: "succeeded", requested_at: minutesAgo(600) }, NOW), "received");
  assert.equal(settlingFrom({ status: "pending", requested_at: minutesAgo(2) }, NOW), "inflight");
  // Past the reconciler's window it is an abandoned checkout, and the person must be able
  // to try again.
  assert.equal(
    settlingFrom({ status: "pending", requested_at: minutesAgo(STALE_PENDING_MINUTES + 1) }, NOW),
    null,
  );
  assert.equal(settlingFrom({ status: "pending", requested_at: "not a date" }, NOW), null);
});

test("the settling read is scoped to the invoice being paid, and the farm", async () => {
  const { client, calls } = fakeSupabase(() => ({
    data: { status: "pending", requested_at: minutesAgo(1) },
    error: null,
  }));

  const settling = await settlingOnInvoice(client, FARM, INVOICE, "test:attempt", NOW);

  assert.equal(settling, "inflight");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "billing_payment_attempts");
  assert.equal(calls[0].filters.invoice_id, INVOICE, "an old period's attempt must not count");
  assert.equal(calls[0].filters.farm_id, FARM);
  assert.deepEqual(calls[0].filters.status, ["pending", "succeeded"]);
});

test("a reopened farm whose only succeeded attempt is on an old invoice is offered Pay", async () => {
  // The ledger as the review found it: last period's success, nothing on the new invoice.
  const attempts = [{ invoice_id: "33333333-3333-4333-8333-333333333333", status: "succeeded", requested_at: minutesAgo(40 * 1440) }];
  // Answers as the database would: a read with no invoice filter (the old one) finds the
  // farm's latest attempt, whichever invoice it was on.
  const { client } = fakeSupabase((ctx) => ({
    data: attempts.find((a) => !("invoice_id" in ctx.filters) || a.invoice_id === ctx.filters.invoice_id) ?? null,
    error: null,
  }));

  assert.equal(await settlingOnInvoice(client, FARM, INVOICE, "test:attempt", NOW), null);
});

test("with no invoice to pay, nothing is read and nothing is settling", async () => {
  const { client, calls } = fakeSupabase(() => {
    throw new Error("no read was expected");
  });

  assert.equal(await settlingOnInvoice(client, FARM, null, "test:attempt", NOW), null);
  assert.equal(calls.length, 0);
});

test("a failed settling read throws rather than offering Pay to somebody whose money may be moving", async () => {
  const { client } = fakeSupabase(() => ({ data: null, error: { message: "boom", code: "08006" } }));

  await assert.rejects(settlingOnInvoice(client, FARM, INVOICE, "test:attempt", NOW));
});

// ═════════════════════════════════════════════════════════════════════════════
// What is still overdue after this payment
// ═════════════════════════════════════════════════════════════════════════════

function open(id: string, due: string | null, totalCents = 1111, paidCents = 0, issued: string | null = null): OpenInvoice {
  return { id, total_incl_cents: totalCents, amount_paid_cents: paidCents, due_on: due, issued_on: issued };
}

const TODAY = "2026-10-29";

test("the review's case: two invoices past the grace, paying the oldest leaves the other", () => {
  // Period R11.11 due 10 days ago and proration R11.11 due 9 days ago, grace 7.
  const rows = [open("a", "2026-10-19"), open("b", "2026-10-20")];
  assert.equal(overdueAfterPaying(rows, new Set(), "a", 7, TODAY), 1111);
});

test("an invoice still inside the grace does not keep the farm paused", () => {
  // Due 7 days ago: the gate keeps it working until due + 7 is before today.
  const rows = [open("a", "2026-10-19"), open("b", "2026-10-22"), open("c", "2026-10-28")];
  assert.equal(overdueAfterPaying(rows, new Set(), "a", 7, TODAY), 0);
  // One day further on, b is past the grace too.
  assert.equal(overdueAfterPaying(rows, new Set(), "a", 7, "2026-10-30"), 1111);
});

test("a refunded, a paid-up and the paying invoice itself are never counted", () => {
  const rows = [
    open("a", "2026-10-01"),
    open("refunded", "2026-10-01"),
    open("paid", "2026-10-01", 1111, 1111),
    open("partial", "2026-10-01", 1111, 1000),
  ];
  assert.equal(overdueAfterPaying(rows, new Set(["refunded"]), "a", 7, TODAY), 111);
});

test("a missing due date falls back to the issue date, as app.farm_overdue_since does", () => {
  const rows = [open("a", "2026-10-01"), open("b", null, 2000, 0, "2026-10-02"), open("c", null, 3000, 0, null)];
  assert.equal(overdueAfterPaying(rows, new Set(), "a", 7, TODAY), 2000);
});

test("with nothing chosen to pay, everything past the grace is still overdue", () => {
  const rows = [open("a", "2026-10-01"), open("b", "2026-10-02")];
  assert.equal(overdueAfterPaying(rows, new Set(), null, 7, TODAY), 2222);
});

test("the grace is read from billing_settings, and 7 when it cannot be", async () => {
  const set = fakeSupabase(() => ({ data: { access_grace_days: 3 }, error: null }));
  assert.equal(await accessGraceDays(set.client), 3);
  assert.equal(set.calls[0].table, "billing_settings");

  const missing = fakeSupabase(() => ({ data: null, error: null }));
  assert.equal(await accessGraceDays(missing.client), 7);

  const failed = fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
  assert.equal(await accessGraceDays(failed.client), 7);
});
