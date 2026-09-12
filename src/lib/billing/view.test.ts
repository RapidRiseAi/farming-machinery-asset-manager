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
  cardExpiryOn,
  cardExpiryState,
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
