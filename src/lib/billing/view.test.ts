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

import {
  CARD_EXPIRY_WINDOW_DAYS,
  billedUnits,
  billsOnQuota,
  cardExpiryOn,
  cardExpiryState,
  estimateNextCharge,
  savedNotice,
  type PaymentMethodRow,
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
