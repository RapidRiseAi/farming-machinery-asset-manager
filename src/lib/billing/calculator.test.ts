/**
 * The customer's mix priced the way the invoice run prices it (BRIEF section 23, scenarios
 * 1 and 2). The SQL twin, app.billing_renewal_cents, is tested on the same fixtures in
 * supabase/tests/asset_capacity.sql; this file also reads the migration so a constant here
 * cannot quietly differ from the rows the invoices come from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXTRA_EQUIPMENT_CENTS,
  MIN_FULL_SPACES,
  MONTHLY_FIXTURES,
  SELF_SERVICE_MAX_FULL_SPACES,
  SELF_SERVICE_PLANS,
  capacityView,
  chargedEquipment,
  comparePlans,
  renewal,
  signupRoute,
} from "./calculator";
import { MIN_BILLED_SLOTS } from "@/lib/entitlements";

const SQL = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261114090300_equipment_pricing_capacity.sql"),
  "utf8",
);

test("scenario 1: the four monthly fixtures, exactly as the founder stated them", () => {
  for (const fx of MONTHLY_FIXTURES) {
    for (const plan of SELF_SERVICE_PLANS) {
      const r = renewal(plan, "monthly", { fullSpaces: fx.fullSpaces, equipment: fx.equipment });
      assert.ok(r);
      assert.equal(r.totalCents, fx[plan], `${plan} ${fx.fullSpaces}+${fx.equipment}: ${r.totalCents}`);
    }
  }
  // The fixtures are the brief's own numbers, not derived here.
  assert.deepEqual(MONTHLY_FIXTURES.map((f) => [f.essential, f.professional, f.complete]), [
    [24500, 39500, 49500], [29000, 39500, 49500], [44000, 54500, 49500], [51500, 62000, 57000],
  ]);
});

test("scenario 1: the annual equivalents come from the stated annual prices", () => {
  const annual = [
    [245000, 395000, 495000],
    [290000, 395000, 495000],
    [440000, 545000, 495000],
    [515000, 620000, 570000],
  ];
  MONTHLY_FIXTURES.forEach((fx, i) => {
    SELF_SERVICE_PLANS.forEach((plan, j) => {
      const r = renewal(plan, "annual", { fullSpaces: fx.fullSpaces, equipment: fx.equipment });
      assert.equal(r?.totalCents, annual[i][j], `${plan} annual ${fx.fullSpaces}+${fx.equipment}`);
    });
  });
  // R490 a full space a year: twelve months of access, not a rounded monthly figure x 12.
  assert.equal(renewal("essential", "annual", { fullSpaces: 6, equipment: 0 })?.totalCents, 6 * 49000);
});

test("scenario 2: five full spaces at least; equipment is counted beside them, never a label", () => {
  const r = renewal("complete", "monthly", { fullSpaces: 3, equipment: 0 });
  assert.equal(r?.fullSpaces, 5);
  assert.equal(r?.totalCents, 49500);
  assert.equal(MIN_FULL_SPACES, MIN_BILLED_SLOTS);
  // Twenty pieces on Essential: 18 charged, whichever 18 they are.
  assert.equal(chargedEquipment("essential", 20), 18);
  assert.equal(chargedEquipment("complete", 10), 0);
  assert.equal(chargedEquipment("professional", -3), 0);
  // Done-For-You is quoted: there is no list total to show.
  assert.equal(renewal("done_for_you", "monthly", { fullSpaces: 10, equipment: 0 }), null);
});

test("scenario 2: 200 full spaces online, 201 to a quote, equipment not part of that line", () => {
  assert.deepEqual(signupRoute(3), { kind: "self_service", fullSpaces: 5 });
  assert.deepEqual(signupRoute(200), { kind: "self_service", fullSpaces: 200 });
  assert.deepEqual(signupRoute(201), { kind: "quote", fullSpaces: 201 });
  // 200 full spaces with 400 equipment is still self-service and fully priced.
  const big = renewal("professional", "monthly", { fullSpaces: 200, equipment: 400 });
  assert.equal(big?.totalCents, 200 * 7900 + 395 * 1500);
  assert.match(SQL, /app\.self_service_max_full_spaces\(\) returns integer\s+language sql immutable set search_path = public, pg_temp as \$\$ select 200 \$\$/);
  assert.equal(SELF_SERVICE_MAX_FULL_SPACES, 200);
});

test("the extra equipment prices are the migration's", () => {
  const monthly = [...SQL.matchAll(/'monthly'::billing_period,\s*\d+,\s*\d+,\s*\d+::bigint,\s*\d+,\s*(\d+)::bigint/g)].map((m) => Number(m[1]));
  const annual = [...SQL.matchAll(/'annual'::billing_period,\s*\d+,\s*\d+,\s*\d+::bigint,\s*\d+,\s*(\d+)::bigint/g)].map((m) => Number(m[1]));
  assert.deepEqual(monthly, [1500, 1500, 1500]);
  assert.deepEqual(annual, [15000, 15000, 15000]);
  assert.deepEqual(EXTRA_EQUIPMENT_CENTS, { monthly: monthly[0], annual: annual[0] });
});

test("all three plans for the actual mix, the lowest that has what is needed marked", () => {
  // Five full, fifteen equipment: Complete (R495) is cheaper than Professional (R545).
  const rows = comparePlans("monthly", { fullSpaces: 5, equipment: 15 }, [], "professional");
  assert.deepEqual(rows.map((r) => [r.plan, r.totalCents]), [["essential", 44000], ["professional", 54500], ["complete", 49500]]);
  assert.equal(rows.find((r) => r.lowest)?.plan, "essential");
  // Needing fuel and trips leaves Professional and Complete: Complete is lower.
  const pro = comparePlans("monthly", { fullSpaces: 5, equipment: 15 }, ["fuel", "trips"], "professional");
  assert.equal(pro.find((r) => r.lowest)?.plan, "complete");
  assert.equal(pro.find((r) => r.plan === "essential")?.suppliesNeeds, false);
  // The current plan is shown, never switched.
  assert.equal(pro.find((r) => r.current)?.plan, "professional");
  // Eight full spaces, fifteen equipment: Professional is now the cheaper of the two.
  const eight = comparePlans("monthly", { fullSpaces: 8, equipment: 15 }, ["fuel"]);
  assert.equal(eight.find((r) => r.lowest)?.plan, "professional");
  // Maps are Complete only.
  assert.equal(comparePlans("annual", { fullSpaces: 5, equipment: 0 }, ["maps"]).find((r) => r.lowest)?.plan, "complete");
});

test("capacity shows in use, free now and next renewal apart", () => {
  const v = capacityView({ plan: "essential", purchasedFull: 5, activeFull: 4, activeEquipment: 3, extraEquipmentPaid: 1 });
  assert.deepEqual(v, { activeFull: 4, activeEquipment: 3, freeFull: 1, freeEquipment: 0, nextRenewalFull: 5, nextRenewalChargedEquipment: 1 });
  // A metered subscription has no ceiling to show.
  const m = capacityView({ plan: "complete", purchasedFull: null, activeFull: 7, activeEquipment: 20, extraEquipmentPaid: 0 });
  assert.equal(m.freeFull, null);
  assert.equal(m.freeEquipment, null);
  assert.equal(m.nextRenewalFull, 7);
  // A reduction scheduled for renewal is what the renewal bills, never below five.
  assert.equal(capacityView({ plan: "complete", purchasedFull: 9, pendingFull: 3, activeFull: 3, activeEquipment: 0, extraEquipmentPaid: 0 }).nextRenewalFull, 5);
});
