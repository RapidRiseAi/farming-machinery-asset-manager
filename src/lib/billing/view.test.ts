/**
 * The card-expiry warning, which is arithmetic about a date and therefore wrong by a month
 * if nobody checks.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `/billing` has always shown "Expires 12/30" in grey — a fact, not a warning — while
 * `app.billing_cards_expiring` (20260909120000) has been emailing about the same card for
 * up to 45 days. The screen now says it too, and the ONLY way that is an improvement is if
 * the two agree. So every assertion here is really an assertion about the SQL:
 *
 *   - "12/28" is the END of December 2028, not the 1st (getting this wrong nags a farmer
 *     for a month about a card that still works);
 *   - the horizon is 45 days, the engine's own default;
 *   - and the five reasons to stay SILENT are the same five rows the engine omits.
 *
 * The date is passed in rather than read from the clock. Section (o) of the billing suite
 * was date-flaky for want of exactly that — it picked `current_date + 20` as its
 * "expiring soon" card, which is inside a 45-day window for the first third of a month and
 * outside it for the rest, so it passed until 11 September 2026 and then failed with
 * nothing about the engine having changed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  ATTEMPT_LOOK,
  CARD_EXPIRY_WINDOW_DAYS,
  INVOICE_LOOK,
  SUBSCRIPTION_LOOK,
  billedUnits,
  billsOnQuota,
  cardExpiryOn,
  cardExpiryState,
  cardSummary,
  chargeSummary,
  estimateNextCharge,
  fleetSummary,
  invoiceDocuments,
  nextChargeState,
  quoteReasonKey,
  retryOffer,
  savedNotice,
  type AttemptRow,
  type InvoiceRow,
  type PaymentMethodRow,
  type PriceRow,
  type SubscriptionRow,
} from "./view";

/** A card that is charged, readable and in force — the case that SHOULD speak. */
function card(over: Partial<PaymentMethodRow> = {}): PaymentMethodRow {
  return {
    id: "card-1",
    farm_id: "farm-1",
    provider: "paystack",
    card_brand: "visa",
    last4: "4081",
    exp_month: "12",
    exp_year: "2030",
    card_type: "debit",
    bank: null,
    country_code: "ZA",
    bin: "424242",
    reusable: true,
    is_default: true,
    status: "active",
    last_used_at: null,
    removed_at: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  } as PaymentMethodRow;
}

function sub(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    farm_id: "farm-1",
    plan: "professional",
    billing_period: "monthly",
    status: "active",
    asset_quota: null,
    pending_quota: null,
    pending_quota_on: null,
    price_version_label: "launch-2026",
    trial_ends_on: null,
    anchor_day: 6,
    current_period_start: "2026-09-06",
    current_period_end: "2026-10-05",
    next_billing_on: "2026-10-06",
    default_payment_method_id: "card-1",
    cancel_at_period_end: false,
    cancellation_reason: null,
    cancelled_at: null,
    ended_on: null,
    failed_attempt_count: 0,
    ...over,
  } as SubscriptionRow;
}

// ── The date on the card ─────────────────────────────────────────────────────

test("the printed month means its LAST day", () => {
  assert.equal(cardExpiryOn("12", "2028"), "2028-12-31");
  assert.equal(cardExpiryOn("1", "2027"), "2027-01-31");
  assert.equal(cardExpiryOn("04", "2027"), "2027-04-30");
  // February, and the leap year a hand-written month-length table gets wrong.
  assert.equal(cardExpiryOn("02", "2027"), "2027-02-28");
  assert.equal(cardExpiryOn("02", "2028"), "2028-02-29");
  assert.equal(cardExpiryOn("2", "2100"), "2100-02-28"); // divisible by 100, not a leap year
});

test("two digits are read as this century, the only sane reading for a card", () => {
  assert.equal(cardExpiryOn("12", "30"), "2030-12-31");
  assert.equal(cardExpiryOn("09", "27"), "2027-09-30");
});

test("a date the provider sent that we cannot read is null, never a throw", () => {
  const bad: [string | null, string | null][] = [
    [null, "2030"],
    ["12", null],
    ["", "2030"],
    ["13", "2030"],
    ["0", "2030"],
    ["ab", "2030"],
    ["12", "203"],
    ["12", "20300"],
    ["12", "twenty"],
  ];
  for (const [m, y] of bad) {
    assert.equal(cardExpiryOn(m, y), null, `expected null for ${m}/${y}`);
  }
});

// ── When the screen speaks ───────────────────────────────────────────────────

test("inside the window it warns; outside it says nothing", () => {
  // 45 days is the engine's horizon. These two dates straddle it by one day each way, so a
  // window that drifted in either direction fails here.
  const inside = cardExpiryState(card({ exp_month: "10", exp_year: "2026" }), sub(), "2026-09-16");
  assert.equal(inside.kind, "soon");
  assert.equal(inside.kind === "soon" ? inside.on : null, "2026-10-31");
  assert.equal(inside.kind === "soon" ? inside.daysLeft : null, 45);

  const outside = cardExpiryState(card({ exp_month: "10", exp_year: "2026" }), sub(), "2026-09-15");
  assert.equal(outside.kind, "fine");
  assert.equal(outside.kind === "fine" ? outside.daysLeft : null, 46);

  assert.equal(CARD_EXPIRY_WINDOW_DAYS, 45);
});

test("the last day of the printed month is still good; the next day is not", () => {
  const lastDay = cardExpiryState(card({ exp_month: "09", exp_year: "2026" }), sub(), "2026-09-30");
  assert.equal(lastDay.kind, "soon");
  assert.equal(lastDay.kind === "soon" ? lastDay.daysLeft : null, 0);

  const after = cardExpiryState(card({ exp_month: "09", exp_year: "2026" }), sub(), "2026-10-01");
  assert.equal(after.kind, "expired");
  assert.equal(after.kind === "expired" ? after.daysLeft : null, -1);
});

// ── The silences, each of which the SQL engine makes by omitting the row ─────

test("it warns only about the card that would ACTUALLY be charged", () => {
  // Every charging shortlist joins `pm.id = s.default_payment_method_id`. A farm may keep
  // an old card on file; that one stopping is not news. `is_default` on the method row is
  // a display flag and is not what the charge uses.
  const other = cardExpiryState(
    card({ id: "card-2", exp_month: "10", exp_year: "2026" }),
    sub({ default_payment_method_id: "card-1" }),
    "2026-09-20",
  );
  assert.equal(other.kind, "quiet");

  const none = cardExpiryState(
    card({ exp_month: "10", exp_year: "2026" }),
    sub({ default_payment_method_id: null }),
    "2026-09-20",
  );
  assert.equal(none.kind, "quiet");
});

test("a subscription that will never be charged again is not warned", () => {
  for (const status of ["trialing", "active", "past_due", "grace", "non_renewing"]) {
    const s = cardExpiryState(card({ exp_month: "10", exp_year: "2026" }), sub({ status }), "2026-09-20");
    assert.equal(s.kind, "soon", `${status} should still warn`);
  }
  for (const status of ["cancelled", "downgraded", "pending"]) {
    const s = cardExpiryState(card({ exp_month: "10", exp_year: "2026" }), sub({ status }), "2026-09-20");
    assert.equal(s.kind, "quiet", `${status} should stay quiet`);
  }
});

test("a card that cannot be charged is not warned about", () => {
  const when = "2026-09-20";
  const soon = { exp_month: "10", exp_year: "2026" };
  assert.equal(cardExpiryState(card({ ...soon, status: "inactive" }), sub(), when).kind, "quiet");
  assert.equal(cardExpiryState(card({ ...soon, removed_at: "2026-09-01" }), sub(), when).kind, "quiet");
  assert.equal(cardExpiryState(card({ ...soon, reusable: false }), sub(), when).kind, "quiet");
  // The positive control, so the three above cannot pass for the wrong reason.
  assert.equal(cardExpiryState(card(soon), sub(), when).kind, "soon");
});

test("no card and no subscription are silences, not crashes", () => {
  assert.equal(cardExpiryState(null, sub(), "2026-09-20").kind, "quiet");
  assert.equal(cardExpiryState(card(), null, "2026-09-20").kind, "quiet");
  assert.equal(
    cardExpiryState(card({ exp_month: null, exp_year: null }), sub(), "2026-09-20").kind,
    "quiet",
  );
});

// ── What the invoice will actually be for ────────────────────────────────────
//
// This is the arithmetic that put R0,00 on a production farm's billing screen against a
// real R750,00 invoice. `/billing` passed the COUNTED fleet into `estimateNextCharge`
// while `app.generate_billing_invoices` bills `coalesce(asset_quota, counted)`, so every
// farm holding slots it had not filled was quoted the wrong number — and a farm that had
// just paid and added nothing yet was quoted nothing at all.
//
// These assertions are really assertions about `app.billing_billable_units`. If that
// function's rule ever changes, this file is the thing that should go red.

test("a quota is what gets billed, however many vehicles are actually running", () => {
  // The exact production shape: three slots bought, no machines on the fleet yet.
  assert.equal(billedUnits(sub({ asset_quota: 3 }), 0), 3);
  // Slots bought, some of them in use.
  assert.equal(billedUnits(sub({ asset_quota: 10 }), 7), 10);
  // Every slot in use.
  assert.equal(billedUnits(sub({ asset_quota: 10 }), 10), 10);
});

test("no quota means bill what is counted — grandfathered farms must not read as zero", () => {
  // `null` is "this subscription predates the quota model", which is every farm onboarded
  // before it and every farm an administrator creates. Reading it as "no slots" would bill
  // all of them nothing.
  assert.equal(billedUnits(sub({ asset_quota: null }), 3), 3);
  assert.equal(billedUnits(null, 4), 4);
  assert.equal(billedUnits(undefined, 4), 4);
});

test("a quota of zero is impossible, and a fleet of zero under a quota still bills", () => {
  // `billing_subscriptions_quota_ck` refuses a quota below 1, so 0 can only arrive from a
  // bug. It must still be read as a quota rather than falling through to the count, or the
  // fallback silently becomes the bill.
  assert.equal(billedUnits(sub({ asset_quota: 0 }), 9), 0);
  assert.equal(billedUnits(sub({ asset_quota: 5 }), 0), 5);
});

test("the screen knows which of the two models it is showing", () => {
  assert.equal(billsOnQuota(sub({ asset_quota: 3 })), true);
  assert.equal(billsOnQuota(sub({ asset_quota: null })), false);
  assert.equal(billsOnQuota(null), false);
});

test("the estimate follows the quota, which is the whole bug", () => {
  const price = {
    id: "p1",
    version_label: "launch-2026",
    plan: "done_for_you",
    billing_period: "monthly",
    per_vehicle_monthly_incl_cents: 25000,
    months_charged: 1,
    vat_rate_bps: 0,
    status: "active",
    effective_from: null,
    effective_to: null,
  };
  const s = sub({ plan: "done_for_you", asset_quota: 3 });

  // What the page used to do: pass the counted fleet. Zero machines, so R0,00 — the one
  // wrong price a customer would never think to question.
  const wrong = estimateNextCharge({ price, assetCount: 0, vatRegistered: false });
  assert.equal(wrong.kind === "priced" && wrong.totalInclCents, 0);

  // What it does now, and what the invoice on production actually came to.
  const right = estimateNextCharge({
    price,
    assetCount: billedUnits(s, 0),
    vatRegistered: false,
  });
  assert.equal(right.kind === "priced" && right.totalInclCents, 75000);
  assert.equal(right.kind === "priced" && right.assetCount, 3);
});

// ── Saying which of several things just happened ─────────────────────────────

test("every outcome a billing action can report has its own sentence", () => {
  // The actions distinguish these carefully and the page rendered one generic string for
  // all of them, so a farmer who pressed "Update slots" could not tell whether they had
  // just been charged.
  const codes = [
    "slots-added",
    "slots-scheduled",
    "plan-changed",
    "plan-scheduled",
    "no-change",
    "paid",
    "checking",
    "cancelling",
    "cancelled",
    "resumed",
    "card-removed",
    "billing-details",
    "plan",
    "plan-unchanged",
    "charged",
    "subscription",
    "reconciled-paid",
    "reconciled-closed",
    "reconciled-open",
  ];
  const keys = new Set<string>();
  for (const code of codes) {
    const notice = savedNotice(code);
    assert.ok(notice, `${code} resolved to nothing`);
    assert.notEqual(notice.key, "ui.savedChanges", `${code} fell through to the generic line`);
    keys.add(notice.key);
  }
  // No two outcomes may share a sentence, or the distinction is lost again.
  assert.equal(keys.size, codes.length, "two outcomes render the same message");
});

test("money that has not landed is never reported as success", () => {
  // An attempt that settled `unknown` is being verified, not confirmed. Calling it a
  // success is how somebody pays twice.
  assert.equal(savedNotice("checking")?.tone, "info");
  assert.equal(savedNotice("reconciled-open")?.tone, "info");
  // Cancelling is not a celebration either.
  assert.equal(savedNotice("cancelling")?.tone, "info");
  assert.equal(savedNotice("cancelled")?.tone, "info");
  // These genuinely did move money, or did the thing asked.
  assert.equal(savedNotice("paid")?.tone, "success");
  assert.equal(savedNotice("slots-added")?.tone, "success");
});

test("nothing to say, and something unrecognised, are different answers", () => {
  assert.equal(savedNotice(undefined), null);
  assert.equal(savedNotice(null), null);
  assert.equal(savedNotice(""), null);
  assert.equal(savedNotice("   "), null);
  // An unknown code must never render itself at a customer.
  assert.equal(savedNotice("something-new")?.key, "ui.savedChanges");
});

test("a refusal from the engine is translated, never printed as SQL prose", () => {
  // These are the exact strings `app.billing_quota_quote` and `app.billing_plan_quote`
  // put in `reason`. Rendering one raw would show English prose from a migration to an
  // Afrikaans farmer — the mistake errors.ts exists to prevent everywhere else.
  assert.equal(quoteReasonKey("retire or sell a vehicle first"), "billing.quotaBelowFleetBody");
  assert.equal(quoteReasonKey("no confirmed price for that plan"), "billing.quoteNoPrice");
  assert.equal(quoteReasonKey("no confirmed price for this plan"), "billing.quoteNoPrice");
  assert.equal(quoteReasonKey("subscription has ended"), "billing.quoteEnded");
  assert.equal(quoteReasonKey("choose at least one vehicle"), "billing.quoteMinOne");
  assert.equal(
    quoteReasonKey("less than R1,00 — below what the provider will process"),
    "billing.quoteBelowMinimum",
  );
});

test("an unrecognised or absent reason degrades to a sentence, not to silence", () => {
  // The reasons are prose in a migration, not an enum. A reword must fall back rather
  // than start printing Postgres at customers.
  assert.equal(quoteReasonKey("some wording nobody has written yet"), "billing.quoteUnavailableBody");
  assert.equal(quoteReasonKey(null), "billing.quoteUnavailableBody");
  assert.equal(quoteReasonKey(undefined), "billing.quoteUnavailableBody");
  assert.equal(quoteReasonKey(""), "billing.quoteUnavailableBody");
});

// ── The three answers at the top of the page ─────────────────────────────────
//
// The summary tiles choose between figures the page already holds. Every assertion below
// is about the CHOICE: which number is the honest answer to "how much, and when", and when
// the honest answer is a word rather than a number.

const PRICE: PriceRow = {
  id: "p1",
  version_label: "launch-2026",
  plan: "professional",
  billing_period: "monthly",
  per_vehicle_monthly_incl_cents: 7300,
  months_charged: 1,
  vat_rate_bps: 0,
  status: "active",
  effective_from: null,
  effective_to: null,
};

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    farm_id: "farm-1",
    invoice_ref: "FW-2026-0007",
    status: "open",
    period_start: "2026-09-06",
    period_end: "2026-10-05",
    issued_on: "2026-09-06",
    due_on: "2026-09-06",
    plan: "professional",
    billing_period: "monthly",
    asset_count: 10,
    unit_price_incl_cents: 7300,
    months_charged: 1,
    price_version_label: "launch-2026",
    vat_rate_bps: 0,
    subtotal_ex_vat_cents: 73000,
    vat_cents: 0,
    total_incl_cents: 73000,
    amount_paid_cents: 0,
    currency: "ZAR",
    voided_reason: null,
    ...over,
  };
}

function attempt(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "att-1",
    farm_id: "farm-1",
    invoice_id: "inv-1",
    subscription_id: "sub-1",
    attempt_ref: "FWA-1",
    kind: "renewal",
    status: "unknown",
    attempt_number: 1,
    amount_incl_cents: 73000,
    currency: "ZAR",
    provider: "paystack",
    provider_reference: null,
    provider_transaction_id: null,
    gateway_response: null,
    failure_reason: null,
    requested_at: "2026-09-06T02:00:00Z",
    resolved_at: null,
    reconciled_at: null,
    reconcile_note: null,
    ...over,
  };
}

/** The page's own pipeline, end to end: price → estimate → next → the tile. */
function tile(
  s: SubscriptionRow | null,
  opts: { price?: PriceRow | null; invoices?: InvoiceRow[]; attempts?: AttemptRow[] } = {},
) {
  const estimate = estimateNextCharge({
    price: opts.price === undefined ? PRICE : opts.price,
    assetCount: billedUnits(s, 7),
    vatRegistered: false,
  });
  const owed = (opts.invoices ?? []).find((i) => i.total_incl_cents > i.amount_paid_cents) ?? null;
  return chargeSummary(s, nextChargeState(s, estimate), estimate, retryOffer(owed, opts.attempts));
}

test("the first tile quotes the renewal the invoice generator will raise", () => {
  // Ten slots bought, seven running: ten are billed, and the tile says so.
  const t = tile(sub({ asset_quota: 10 }));
  assert.equal(t.kind, "next");
  assert.equal(t.kind === "next" && t.cents, 73000);
  assert.equal(t.tone, "default");
});

test("no confirmed price is a word, never an amount of zero", () => {
  const t = tile(sub({ asset_quota: 10 }), { price: null });
  assert.equal(t.kind, "nothing");
  assert.ok(!("cents" in t), "an unpriced account must carry no figure to render");
});

test("a plan that will not renew is not quoted a renewal", () => {
  // The estimate is still priced — the plan is live until the period ends — but nothing
  // more is coming, and a figure on the tile would say otherwise.
  assert.equal(tile(sub({ status: "non_renewing" })).kind, "nothing");
  assert.equal(tile(sub({ cancel_at_period_end: true })).kind, "nothing");
  assert.equal(tile(sub({ status: "cancelled" })).kind, "nothing");
  assert.equal(tile(null).kind, "nothing");
});

test("an outstanding bill is the answer, not the renewal estimate", () => {
  // A pro-rata top-up that failed: R120 is what a retry takes, not the R730 renewal.
  const t = tile(sub({ status: "past_due", asset_quota: 10 }), {
    invoices: [invoice({ total_incl_cents: 12000, invoice_ref: "FW-2026-0009" })],
  });
  assert.equal(t.kind, "owed");
  assert.equal(t.kind === "owed" && t.cents, 12000);
  assert.equal(t.kind === "owed" && t.invoiceRef, "FW-2026-0009");
  // Part-paid bills show what is left, not what was raised.
  const part = tile(sub({ status: "past_due" }), {
    invoices: [invoice({ total_incl_cents: 73000, amount_paid_cents: 30000 })],
  });
  assert.equal(part.kind === "owed" && part.cents, 43000);
});

test("a payment still in flight is never shown as something to pay", () => {
  for (const status of ["unknown", "pending"]) {
    const t = tile(sub({ status: "past_due" }), {
      invoices: [invoice()],
      attempts: [attempt({ status })],
    });
    assert.equal(t.kind, "checking", `${status} attempt`);
    assert.ok(!("cents" in t), "an amount beside an in-flight attempt invites a second payment");
  }
});

test("the tile is as loud as the trouble, and money owed is never quiet", () => {
  assert.equal(tile(sub({ status: "active" })).tone, "default");
  assert.equal(tile(sub({ status: "past_due", next_retry_on: "2026-09-09" })).tone, "due");
  assert.equal(tile(sub({ status: "grace", grace_ends_on: "2026-09-20" })).tone, "due");
  assert.equal(tile(sub({ status: "downgraded" })).tone, "overdue");
  // A bill outstanding on an otherwise healthy account still asks to be looked at…
  assert.equal(tile(sub({ status: "active" }), { invoices: [invoice()] }).tone, "due");
  // …and a downgraded one does not get quieter for having a bill attached.
  assert.equal(tile(sub({ status: "downgraded" }), { invoices: [invoice()] }).tone, "overdue");
});

test("free slots agree with the wall a farmer hits when adding a vehicle", () => {
  // `app.vehicle_allowance.remaining` is greatest(quota − billable, 0).
  const assets = (billable: number, notCounted = 0) => ({
    total: billable + notCounted,
    billable,
    notCounted,
  });
  const room = fleetSummary(sub({ asset_quota: 10 }), 10, assets(7, 2));
  assert.deepEqual(room, { kind: "quota", used: 7, bought: 10, free: 3, tone: "default" });

  const full = fleetSummary(sub({ asset_quota: 10 }), 10, assets(10));
  assert.equal(full.kind === "quota" && full.free, 0);
  assert.equal(full.tone, "due");

  // Grandfathered above a later quota: full, not minus two.
  const over = fleetSummary(sub({ asset_quota: 10 }), 10, assets(12));
  assert.equal(over.kind === "quota" && over.free, 0);
  assert.equal(over.kind === "quota" && over.used, 12);
});

test("a metered farm is shown what it is billed on, and never a slot count", () => {
  const m = fleetSummary(sub({ asset_quota: null }), 9, { total: 11, billable: 9, notCounted: 2 });
  assert.deepEqual(m, { kind: "metered", billed: 9, notCounted: 2, tone: "default" });
  assert.equal(fleetSummary(null, 0, { total: 0, billable: 0, notCounted: 0 }).kind, "metered");
});

test("the card tile follows the expiry reading the email uses", () => {
  const next = tile(sub());
  const today = "2026-09-19";
  const s = sub();
  const at = (exp_month: string, exp_year: string) => {
    const c = card({ exp_month, exp_year });
    return cardSummary(c, cardExpiryState(c, s, today), next).tone;
  };
  assert.equal(at("12", "2030"), "ok");
  assert.equal(at("10", "2026"), "due"); // ends 31 Oct: inside 45 days
  assert.equal(at("08", "2026"), "overdue");
  // A card the engine would not charge is not warned about, here or by email.
  const spare = card({ id: "card-2" });
  assert.equal(cardSummary(spare, cardExpiryState(spare, s, today), next).tone, "default");
});

test("no card matters only while something is going to be charged to it", () => {
  const quiet = { kind: "quiet" } as const;
  assert.deepEqual(cardSummary(null, quiet, tile(sub())), { kind: "none", tone: "due" });
  assert.deepEqual(cardSummary(null, quiet, tile(sub(), { invoices: [invoice()] })), {
    kind: "none",
    tone: "due",
  });
  assert.deepEqual(cardSummary(null, quiet, tile(sub(), { price: null })), {
    kind: "none",
    tone: "default",
  });
  assert.deepEqual(cardSummary(null, quiet, tile(sub({ status: "cancelled" }))), {
    kind: "none",
    tone: "default",
  });
});

// ── Which documents a row offers ─────────────────────────────────────────────

test("a receipt is offered only for money that has arrived", () => {
  // The receipt reads "Paid in full". Offering it for an open or part-paid bill would be a
  // false record of payment — the PDF route refuses with `billing-not-paid` for the same
  // reason.
  assert.equal(invoiceDocuments("paid").receipt, true);
  for (const s of ["open", "draft", "void", "uncollectible"]) {
    assert.equal(invoiceDocuments(s).receipt, false, s);
  }
});

test("the bill is offered for anything issued, and never for a draft or a void", () => {
  for (const s of ["open", "paid", "uncollectible"]) {
    assert.equal(invoiceDocuments(s).invoice, true, s);
  }
  // `billing-not-issued` and `billing-voided` on the route.
  assert.deepEqual(invoiceDocuments("draft"), { receipt: false, invoice: false });
  assert.deepEqual(invoiceDocuments("void"), { receipt: false, invoice: false });
});

// ── Every status has a word, in both languages ───────────────────────────────
//
// `enumLabel` builds `billingInvoiceStatus.open` at RUNTIME from a group argument and falls
// back to the raw value on a miss. None of these four groups existed, and neither gate
// could see it: `i18n:keys` cannot read a key assembled from an argument, and the fallback
// prints something plausible. So both billing screens showed "open", "paid" and "past due"
// — the Postgres enum values — to every reader, including an Afrikaans farmer checking
// whether October went through. The lists are the enums in
// 20260903160000_saas_billing_core.sql, plus `pending` from 20260910220000.

test("every billing status and attempt kind has a label in both languages", () => {
  const groups: Record<string, string[]> = {
    billingSubStatus: [...Object.keys(SUBSCRIPTION_LOOK), "pending"],
    billingInvoiceStatus: Object.keys(INVOICE_LOOK),
    billingAttemptStatus: Object.keys(ATTEMPT_LOOK),
    billingAttemptKind: ["initial_checkout", "charge_authorization", "manual_retry"],
  };
  for (const [group, values] of Object.entries(groups)) {
    for (const value of values) {
      const key = `${group}.${value}`;
      assert.notEqual(t(key, "en"), key, `${key} has no English label`);
      assert.notEqual(t(key, "af"), key, `${key} has no Afrikaans label`);
      assert.notEqual(t(key, "af"), t(key, "en"), `${key} is English copied into af.json`);
    }
  }
});
