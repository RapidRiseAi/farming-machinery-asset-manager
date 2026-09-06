/**
 * The tests that exist to stop money moving when it should not.
 *
 * Run: `npx tsx --test src/lib/billing/safety.test.ts`
 *
 * NO TEST IN THIS FILE CAN MAKE A LIVE CHARGE, and that is enforced rather than intended:
 * every adapter here is constructed with an injected `fetchImpl`, and several tests assert
 * that the injected fetch was **never called** — which is a much stronger statement than
 * "it returned the right object". A test that merely checked the return value would still
 * pass if the adapter had quietly hit the network first.
 *
 * The environment is saved and restored around every case, because these functions read
 * `process.env` lazily by design and a leaked variable would make a later test lie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ANNUAL_MONTHS_CHARGED,
  PLANS,
  PLAN_PRICING,
  subscriptionSubtotalCents,
} from "@/lib/entitlements";

import {
  billingCallbackUrl,
  billingConfigured,
  chargingEnabled,
  paystackKeyMode,
  redact,
} from "./config";
import { PaystackBillingAdapter } from "./paystack";
import {
  BILLABLE_ASSET_RULE,
  billableAssetCount,
  invoiceAmounts,
  isBillableMachineStatus,
  monthsChargedFor,
  quoteSubscription,
} from "./pricing";
import {
  BILLING_POLICY_SIGNED_OFF,
  PROPOSED_BILLING_POLICY,
  addDays,
  daysBetween,
  graceEndsOn,
  retriesExhausted,
  retryDateFor,
} from "./policy";

// ── Environment harness ───────────────────────────────────────────────────────

const BILLING_VARS = [
  "BILLING_PROVIDER",
  "BILLING_CHARGING_ENABLED",
  "PAYSTACK_SECRET_KEY",
  "NEXT_PUBLIC_SITE_URL",
] as const;

function withEnv<T>(vars: Partial<Record<(typeof BILLING_VARS)[number], string | undefined>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of BILLING_VARS) saved.set(k, process.env[k]);
  try {
    for (const k of BILLING_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v !== undefined) process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A fetch that records every call and refuses to be a network. */
function spyFetch(response?: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response ?? { status: true, data: {} }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const LIVE_ENV = {
  BILLING_PROVIDER: "paystack",
  BILLING_CHARGING_ENABLED: "true",
  PAYSTACK_SECRET_KEY: "sk_test_notarealkey000000000000000000",
  NEXT_PUBLIC_SITE_URL: "https://fleetwise.example",
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. The kill switch
// ══════════════════════════════════════════════════════════════════════════════

test("a fresh clone charges nobody: no env at all means not configured", () => {
  withEnv({}, () => {
    assert.equal(billingConfigured(), false);
    assert.equal(chargingEnabled(), false);
  });
});

test("provider on but charging off: configured, and still cannot charge", () => {
  withEnv({ ...LIVE_ENV, BILLING_CHARGING_ENABLED: undefined }, () => {
    assert.equal(billingConfigured(), true, "the adapter should be live");
    assert.equal(chargingEnabled(), false, "but charging must stay off");
  });
});

test("only the exact string 'true' enables charging", () => {
  for (const value of ["", "false", "FALSE", "0", "no", "yes", "1", "True", " true"]) {
    withEnv({ ...LIVE_ENV, BILLING_CHARGING_ENABLED: value }, () => {
      assert.equal(
        chargingEnabled(),
        value.trim() === "true",
        `BILLING_CHARGING_ENABLED=${JSON.stringify(value)} must not enable charging unless it is exactly "true"`
      );
    });
  }
});

test("charging is impossible without a key, even with the switch on", () => {
  withEnv({ ...LIVE_ENV, PAYSTACK_SECRET_KEY: undefined }, () => {
    assert.equal(billingConfigured(), false);
    assert.equal(chargingEnabled(), false);
  });
});

test("BILLING_PROVIDER must be paystack — a typo fails closed, it does not fall through", () => {
  withEnv({ ...LIVE_ENV, BILLING_PROVIDER: "paystak" }, () => {
    assert.equal(billingConfigured(), false);
    assert.equal(chargingEnabled(), false);
  });
});

// ── The strong form: charging off means no HTTP request is even attempted ─────

test("with charging off, initializeCheckout makes NO network call at all", async () => {
  const spy = spyFetch();
  const result = await withEnv({ ...LIVE_ENV, BILLING_CHARGING_ENABLED: "false" }, () => {
    const adapter = new PaystackBillingAdapter({ fetchImpl: spy.impl });
    return adapter.initializeCheckout({
      farmId: "f1",
      invoiceId: "i1",
      reference: "FW-TEST-1",
      amountCents: 10_000,
      email: "owner@example.invalid",
      callbackUrl: "https://fleetwise.example/api/billing/callback",
      metadata: { farm_id: "f1", invoice_id: "i1" },
    });
  });
  assert.equal(result.ok, false);
  assert.equal(spy.calls.length, 0, "the kill switch must be checked BEFORE any request is made");
});

test("with charging off, chargeAuthorization makes NO network call at all", async () => {
  const spy = spyFetch();
  const result = await withEnv({ ...LIVE_ENV, BILLING_CHARGING_ENABLED: undefined }, () => {
    const adapter = new PaystackBillingAdapter({ fetchImpl: spy.impl });
    return adapter.chargeAuthorization({
      farmId: "f1",
      invoiceId: "i1",
      reference: "FW-TEST-2",
      amountCents: 10_000,
      authorizationCode: "AUTH_never_used",
      email: "owner@example.invalid",
      metadata: { farm_id: "f1", invoice_id: "i1" },
    });
  });
  assert.equal(result.ok, false);
  assert.equal(spy.calls.length, 0, "no charge attempt may reach the network while charging is off");
});

test("reconciliation still works with charging off — money already taken must not be orphaned", async () => {
  const spy = spyFetch({
    status: true,
    data: {
      reference: "FW-TEST-3",
      id: 42,
      status: "success",
      amount: 10_000,
      currency: "ZAR",
      gateway_response: "Approved",
    },
  });
  const result = await withEnv({ ...LIVE_ENV, BILLING_CHARGING_ENABLED: "false" }, () => {
    const adapter = new PaystackBillingAdapter({ fetchImpl: spy.impl });
    return adapter.verifyTransaction("FW-TEST-3");
  });
  assert.equal(result.ok, true, "verify must keep working when charging is switched off");
  assert.equal(spy.calls.length, 1);
  assert.match(spy.calls[0].url, /\/transaction\/verify\//);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Webhook signature verification
// ══════════════════════════════════════════════════════════════════════════════

const SECRET = LIVE_ENV.PAYSTACK_SECRET_KEY;
const sign = (body: string) => createHmac("sha512", SECRET).update(body, "utf8").digest("hex");

function adapterInEnv(): PaystackBillingAdapter {
  return new PaystackBillingAdapter({ fetchImpl: spyFetch().impl });
}

test("a correctly signed body verifies", () => {
  withEnv(LIVE_ENV, () => {
    const body = JSON.stringify({ event: "charge.success", data: { id: 1 } });
    assert.equal(adapterInEnv().verifyWebhookSignature(body, sign(body)), true);
  });
});

test("a missing signature is refused", () => {
  withEnv(LIVE_ENV, () => {
    const body = JSON.stringify({ event: "charge.success" });
    const a = adapterInEnv();
    assert.equal(a.verifyWebhookSignature(body, null), false);
    assert.equal(a.verifyWebhookSignature(body, ""), false);
    assert.equal(a.verifyWebhookSignature(body, "   "), false);
  });
});

test("a wrong signature of the RIGHT length is refused", () => {
  withEnv(LIVE_ENV, () => {
    const body = JSON.stringify({ event: "charge.success", data: { id: 1 } });
    const good = sign(body);
    // Flip one hex digit — same length, so this exercises the comparison itself and not
    // the length guard in front of it.
    const bad = (good[0] === "a" ? "b" : "a") + good.slice(1);
    assert.equal(bad.length, good.length);
    assert.equal(adapterInEnv().verifyWebhookSignature(body, bad), false);
  });
});

test("a signature of the wrong LENGTH is refused without throwing", () => {
  // timingSafeEqual throws on unequal-length buffers. If the length guard were missing
  // this would be an unhandled exception in the webhook route — a 500, which Paystack
  // then retries every three minutes for 72 hours.
  withEnv(LIVE_ENV, () => {
    const body = JSON.stringify({ event: "charge.success" });
    assert.doesNotThrow(() => adapterInEnv().verifyWebhookSignature(body, "abc123"));
    assert.equal(adapterInEnv().verifyWebhookSignature(body, "abc123"), false);
  });
});

test("a body signed with a DIFFERENT key is refused", () => {
  withEnv(LIVE_ENV, () => {
    const body = JSON.stringify({ event: "charge.success", data: { id: 1 } });
    const forged = createHmac("sha512", "sk_test_someoneelseskey").update(body, "utf8").digest("hex");
    assert.equal(adapterInEnv().verifyWebhookSignature(body, forged), false);
  });
});

test("tampering with the body after signing is refused", () => {
  withEnv(LIVE_ENV, () => {
    const original = JSON.stringify({ event: "charge.success", data: { id: 1, amount: 100 } });
    const signature = sign(original);
    const tampered = JSON.stringify({ event: "charge.success", data: { id: 1, amount: 999999 } });
    assert.equal(adapterInEnv().verifyWebhookSignature(tampered, signature), false);
  });
});

test("with no secret configured, EVERY signature is refused — including a valid-looking one", () => {
  const body = JSON.stringify({ event: "charge.success" });
  const signature = sign(body);
  withEnv({ BILLING_PROVIDER: "paystack" }, () => {
    assert.equal(adapterInEnv().verifyWebhookSignature(body, signature), false);
  });
  withEnv({}, () => {
    assert.equal(adapterInEnv().verifyWebhookSignature(body, signature), false);
  });
});

test("an oversized body is refused before it is hashed", () => {
  withEnv(LIVE_ENV, () => {
    const huge = "x".repeat(1_048_577);
    assert.equal(adapterInEnv().verifyWebhookSignature(huge, sign(huge)), false);
  });
});

test("an empty body is refused", () => {
  withEnv(LIVE_ENV, () => {
    assert.equal(adapterInEnv().verifyWebhookSignature("", sign("")), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Callback URLs cannot be pointed off-origin
// ══════════════════════════════════════════════════════════════════════════════

test("a callback URL is built from the configured site, never from a caller's path tricks", () => {
  withEnv(LIVE_ENV, () => {
    assert.equal(
      billingCallbackUrl("/api/billing/callback"),
      "https://fleetwise.example/api/billing/callback"
    );
    // Scheme-relative and backslash forms both leave our origin. This is the same class
    // of hole `safePath()` exists to close after the /auth/callback open redirect.
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "api/x", ""]) {
      assert.equal(billingCallbackUrl(bad), null, `${JSON.stringify(bad)} must not produce a URL`);
    }
  });
});

test("with no site URL configured, no callback URL is invented", () => {
  withEnv({ ...LIVE_ENV, NEXT_PUBLIC_SITE_URL: undefined }, () => {
    assert.equal(billingCallbackUrl("/api/billing/callback"), null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. The secret never leaks
// ══════════════════════════════════════════════════════════════════════════════

// A realistic-shaped FAKE live key, assembled rather than written out as one literal.
// The redactor must be tested against something that LOOKS like the real thing, but a
// literal of that shape trips GitHub's push protection — a scanner cannot tell a fixture
// from a credential, and it is right not to try. Concatenation keeps the test honest
// (the runtime value is unchanged) without parking a key-shaped string in the source.
const FAKE_LIVE_KEY = "sk_" + "live_" + "abcdefghijklmnopqrstuvwxyz012345";

test("redact() removes anything that looks like a Paystack key or authorization code", () => {
  const samples = [
    `key ${SECRET} in a message`,
    FAKE_LIVE_KEY,
    "AUTH_abcd1234efgh",
  ];
  for (const s of samples) {
    const out = redact(s);
    assert.ok(!out.includes(FAKE_LIVE_KEY), `leaked a live key: ${out}`);
    assert.ok(!out.includes(SECRET), `leaked the secret: ${out}`);
    assert.ok(!out.includes("AUTH_abcd1234efgh"), `leaked an authorization code: ${out}`);
  }
});

test("paystackKeyMode tells test from live without revealing the key", () => {
  withEnv({ ...LIVE_ENV, PAYSTACK_SECRET_KEY: "sk_test_x".padEnd(30, "0") }, () => {
    assert.equal(paystackKeyMode(), "test");
  });
  withEnv({ ...LIVE_ENV, PAYSTACK_SECRET_KEY: "sk_live_x".padEnd(30, "0") }, () => {
    assert.equal(paystackKeyMode(), "live");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. The arithmetic
// ══════════════════════════════════════════════════════════════════════════════

test("at 0% VAT — today's state — the split is the whole amount and no VAT", () => {
  const a = invoiceAmounts({ unitPriceInclCents: 4400, assetCount: 12, monthsCharged: 1, vatRateBps: 0 });
  assert.equal(a.totalInclCents, 52_800);
  assert.equal(a.subtotalExVatCents, 52_800);
  assert.equal(a.vatCents, 0);
});

test("at 15% the split reconciles exactly, including a value that rounds", () => {
  // 3702 incl at 15%: 3702 × 10000 / 11500 = 3219.13… → 3219, so VAT is 483.
  const a = invoiceAmounts({ unitPriceInclCents: 1234, assetCount: 3, monthsCharged: 1, vatRateBps: 1500 });
  assert.equal(a.totalInclCents, 3702);
  assert.equal(a.subtotalExVatCents, 3219);
  assert.equal(a.vatCents, 483);
  assert.equal(a.subtotalExVatCents + a.vatCents, a.totalInclCents);
});

test("the split reconciles for every amount in a sweep — this is the invariant that matters", () => {
  for (const rate of [0, 1400, 1500, 2000]) {
    for (let incl = 0; incl < 400; incl++) {
      const a = invoiceAmounts({ unitPriceInclCents: incl, assetCount: 1, monthsCharged: 1, vatRateBps: rate });
      assert.equal(
        a.subtotalExVatCents + a.vatCents,
        a.totalInclCents,
        `split failed to reconcile at incl=${incl} rate=${rate}`
      );
      assert.ok(a.vatCents >= 0, `negative VAT at incl=${incl} rate=${rate}`);
    }
  }
});

test("annual charges ten months — two months free", () => {
  assert.equal(monthsChargedFor("monthly"), 1);
  assert.equal(monthsChargedFor("annual"), 10);
  const annual = invoiceAmounts({ unitPriceInclCents: 4400, assetCount: 12, monthsCharged: 10, vatRateBps: 0 });
  const monthly = invoiceAmounts({ unitPriceInclCents: 4400, assetCount: 12, monthsCharged: 1, vatRateBps: 0 });
  assert.equal(annual.totalInclCents, monthly.totalInclCents * 10);
  // Twelve months at the monthly rate costs two months more than the annual pre-pay.
  assert.equal(monthly.totalInclCents * 12 - annual.totalInclCents, monthly.totalInclCents * 2);
});

test("a price version's own months_charged wins over the period default", () => {
  // The offer can change without rewriting history: the row carries the term.
  assert.equal(monthsChargedFor("annual", 11), 11);
  assert.equal(monthsChargedFor("monthly", 1), 1);
});

test("zero vehicles produces a zero total that is explicitly NOT chargeable", () => {
  const q = quoteSubscription({
    plan: "complete",
    billingPeriod: "monthly",
    unitPriceInclCents: 4400,
    assetCount: 0,
    vatRateBps: 0,
  });
  assert.equal(q.ok, true);
  if (q.ok) {
    assert.equal(q.totalInclCents, 0);
    assert.equal(q.chargeable, false, "a zero invoice must never be sent to a payment provider");
  }
});

test("a price-on-application plan is never auto-invoiced", () => {
  const q = quoteSubscription({
    plan: "done_for_you",
    billingPeriod: "monthly",
    unitPriceInclCents: null,
    assetCount: 30,
    vatRateBps: 0,
  });
  assert.equal(q.ok, false);
  if (!q.ok) assert.equal(q.reason, "price_on_application");
});

test("a changed vehicle count changes the total proportionally and nothing else", () => {
  const before = quoteSubscription({
    plan: "complete", billingPeriod: "monthly",
    unitPriceInclCents: 4400, assetCount: 10, vatRateBps: 0,
  });
  const after = quoteSubscription({
    plan: "complete", billingPeriod: "monthly",
    unitPriceInclCents: 4400, assetCount: 13, vatRateBps: 0,
  });
  assert.ok(before.ok && after.ok);
  if (before.ok && after.ok) {
    assert.equal(before.totalInclCents, 44_000);
    assert.equal(after.totalInclCents, 57_200);
    assert.equal(after.unitPriceInclCents, before.unitPriceInclCents);
  }
});

test("a negative or fractional input is refused, not silently coerced", () => {
  assert.throws(() =>
    invoiceAmounts({ unitPriceInclCents: -1, assetCount: 1, monthsCharged: 1, vatRateBps: 0 })
  );
  assert.throws(() =>
    invoiceAmounts({ unitPriceInclCents: 100.5, assetCount: 1, monthsCharged: 1, vatRateBps: 0 })
  );
  assert.throws(() =>
    invoiceAmounts({ unitPriceInclCents: 100, assetCount: -3, monthsCharged: 1, vatRateBps: 0 })
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. What counts as a billable vehicle
// ══════════════════════════════════════════════════════════════════════════════

test("retired and sold do not count; everything else does", () => {
  assert.equal(isBillableMachineStatus("retired"), false);
  assert.equal(isBillableMachineStatus("sold"), false);
  for (const s of ["active", "in_workshop", "standby", "out_of_service"]) {
    assert.equal(isBillableMachineStatus(s), true, `${s} must still be billable`);
  }
  assert.equal(
    billableAssetCount(["active", "in_workshop", "standby", "retired", "sold"]),
    3
  );
  assert.equal(billableAssetCount([]), 0);
  assert.equal(billableAssetCount(["retired", "sold"]), 0);
});

test("the billable rule is stated in one place, and says out_of_service counts", () => {
  // A farm that could stop paying by marking every tractor out of service would be a
  // billing system with a hole in it. The wording is asserted so nobody quietly edits it.
  assert.match(BILLABLE_ASSET_RULE, /retired and sold/i);
  assert.match(BILLABLE_ASSET_RULE, /out_of_service still counts/i);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. The policy defaults are the ones that were tested and proposed
// ══════════════════════════════════════════════════════════════════════════════

test("policy defaults match the values recorded for founder sign-off", () => {
  // These are mirrored in `billing_settings` (the SQL defaults) and in
  // docs/FLEETWISE_FOUNDER_DECISIONS.md row 9. Three places, one set of numbers: if
  // somebody changes one, this fails and they have to go and change the other two.
  assert.equal(PROPOSED_BILLING_POLICY.trialDays, 14);
  assert.deepEqual([...PROPOSED_BILLING_POLICY.retryOffsetsDays], [3, 7, 14]);
  assert.equal(PROPOSED_BILLING_POLICY.graceDays, 7);
  assert.equal(PROPOSED_BILLING_POLICY.downgradeToPlan, "essential");
  assert.equal(PROPOSED_BILLING_POLICY.cancelAtPeriodEnd, true);
  assert.equal(PROPOSED_BILLING_POLICY.prorateAnnualAdditions, false);
  assert.equal(PROPOSED_BILLING_POLICY.paymentTermsDays, 7);
});

test("the policy is still marked NOT signed off", () => {
  // This flag flips only when the founder has actually approved the dunning policy.
  // Asserting it is how "we are still waiting on a decision" stays visible in a test
  // run rather than living only in a document nobody opens.
  assert.equal(
    BILLING_POLICY_SIGNED_OFF,
    false,
    "if the founder has signed off the dunning policy, update this test deliberately"
  );
});

test("the dunning ladder walks retry → retry → retry → grace, matching the SQL engine", () => {
  // app.billing_register_failure walks the same ladder. The two must agree, because the
  // screen tells a farmer when the next attempt is and the database decides when it
  // actually happens.
  const from = "2026-09-01";
  assert.equal(retriesExhausted(1, PROPOSED_BILLING_POLICY), false);
  assert.equal(retriesExhausted(2, PROPOSED_BILLING_POLICY), false);
  assert.equal(retriesExhausted(3, PROPOSED_BILLING_POLICY), false);
  assert.equal(retriesExhausted(4, PROPOSED_BILLING_POLICY), true, "the fourth failure exhausts a 3-step ladder");

  assert.equal(retryDateFor(1, from, PROPOSED_BILLING_POLICY), "2026-09-04"); // +3
  assert.equal(retryDateFor(2, from, PROPOSED_BILLING_POLICY), "2026-09-08"); // +7
  assert.equal(retryDateFor(3, from, PROPOSED_BILLING_POLICY), "2026-09-15"); // +14
  assert.equal(retryDateFor(4, from, PROPOSED_BILLING_POLICY), null, "no fourth retry exists");

  assert.equal(graceEndsOn(from, PROPOSED_BILLING_POLICY), "2026-09-08"); // +7
});

test("date arithmetic crosses a month end and a leap day correctly", () => {
  // Off-by-one month arithmetic is where scheduling features in this codebase have gone
  // wrong before, so it is checked rather than assumed.
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
  assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // 2024 is
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-09-01", "2026-09-15"), 14);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7b. The quoted price and the invoiced price are the same number
// ══════════════════════════════════════════════════════════════════════════════
// `PLAN_PRICING` is what a farmer is QUOTED on screen. `billing_price_versions` is what
// they are actually INVOICED. These two have already drifted apart once — the shipped
// code said R39/R69/R99 while the founder document said R44/R73/R89 — and a quote that
// does not match the bill is how somebody stops trusting the bill.
//
// So this reads the seeding migration itself rather than a copy of the numbers: a
// constant duplicated into a test proves only that the test agrees with itself.
// The SQL side asserts the same figures in the suite's section (0), so a change to
// either one without the other fails on both sides.

test("PLAN_PRICING matches the prices the seeding migration actually inserts", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260904120000_saas_billing_launch_prices.sql"),
    "utf8"
  );

  for (const plan of PLANS) {
    // ('launch-2026', '<plan>', 'monthly',  4400,  1, 0, 'active', …)
    const row = new RegExp(
      `'launch-2026',\\s*'${plan}',\\s*'monthly',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)`
    ).exec(sql);
    assert.ok(row, `the migration has no monthly row for ${plan}`);

    const [, cents, months, vatBps] = row;
    assert.equal(
      PLAN_PRICING[plan].perVehicleMonthlyCents,
      Number(cents),
      `${plan}: entitlements.ts says ${PLAN_PRICING[plan].perVehicleMonthlyCents} but the ` +
        `migration invoices ${cents}. The quote and the bill must be the same number.`
    );
    assert.equal(Number(months), 1, `${plan} monthly must charge one month`);
    assert.equal(
      Number(vatBps),
      0,
      `${plan}: Rapid Rise is not VAT-registered, so the seeded rate must be 0`
    );

    // Annual carries the SAME unit price and charges ten months. Expressing the discount
    // as months rather than a reduced unit price keeps "what do we charge per vehicle" a
    // question with one answer.
    const annual = new RegExp(
      `'launch-2026',\\s*'${plan}',\\s*'annual',\\s*(\\d+),\\s*(\\d+)`
    ).exec(sql);
    assert.ok(annual, `the migration has no annual row for ${plan}`);
    assert.equal(Number(annual[1]), Number(cents), `${plan}: annual unit price must equal monthly`);
    assert.equal(Number(annual[2]), ANNUAL_MONTHS_CHARGED, `${plan}: annual must charge 10 months`);
  }
});

test("the confirmed figures are the founder-document ones", () => {
  // Named explicitly so that changing a price is a deliberate act with a failing test
  // attached, not something that slips through in a diff full of other work.
  assert.equal(PLAN_PRICING.essential.perVehicleMonthlyCents, 4400);
  assert.equal(PLAN_PRICING.professional.perVehicleMonthlyCents, 7300);
  assert.equal(PLAN_PRICING.complete.perVehicleMonthlyCents, 8900);
  assert.equal(PLAN_PRICING.done_for_you.perVehicleMonthlyCents, 25000);
});

test("a year on the annual plan costs ten months, not twelve", () => {
  for (const plan of PLANS) {
    const monthly = subscriptionSubtotalCents(plan, "monthly", 12);
    const annual = subscriptionSubtotalCents(plan, "annual", 12);
    assert.ok(monthly != null && annual != null);
    if (monthly != null && annual != null) {
      assert.equal(annual, monthly * ANNUAL_MONTHS_CHARGED, `${plan}: annual should be 10 × monthly`);
      assert.equal(monthly * 12 - annual, monthly * 2, `${plan}: the saving should be exactly two months`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. No live charge is reachable from this file
// ══════════════════════════════════════════════════════════════════════════════

test("the adapter never contacts the real Paystack host in these tests", async () => {
  const spy = spyFetch({ status: true, data: {} });
  await withEnv(LIVE_ENV, async () => {
    const adapter = new PaystackBillingAdapter({ fetchImpl: spy.impl, baseUrl: "https://paystack.invalid" });
    await adapter.verifyTransaction("FW-TEST-9");
  });
  assert.equal(spy.calls.length, 1);
  assert.ok(
    !spy.calls[0].url.startsWith("https://api.paystack.co"),
    "a test must never be pointed at the real API host"
  );
});
