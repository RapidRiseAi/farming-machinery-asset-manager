/**
 * Mid-period changes priced the way app.billing_change_state prices them (BRIEF section 23,
 * scenarios 6, 7 and 8). supabase/tests/billing_change_quotes.sql checks the SQL on the same
 * figures; this file also reads the migration so the rule here cannot drift from it unseen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  additionCents,
  lostFeatures,
  periodDays,
  prorateCents,
  renewal,
  roundCents,
  upgradeDifference,
} from "./calculator";

const SQL = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261115110000_billing_change_quotes.sql"),
  "utf8",
);

test("scenario 6: half a monthly period, equipment R7.50 and a Complete full space R49.50", () => {
  const { remaining, total } = periodDays("2026-11-01", "2026-11-30", "2026-11-16");
  assert.deepEqual({ remaining, total }, { remaining: 15, total: 30 });
  assert.equal(additionCents({ plan: "complete", period: "monthly", addFull: 0, addEquipment: 1, remaining, total }), 750);
  assert.equal(additionCents({ plan: "complete", period: "monthly", addFull: 1, addEquipment: 0, remaining, total }), 4950);
  // Priced once per space, then multiplied: three spaces are three times one.
  assert.equal(
    additionCents({ plan: "essential", period: "monthly", addFull: 3, addEquipment: 2, remaining: 7, total: 31 }),
    3 * prorateCents(4900, 7, 31) + 2 * prorateCents(1500, 7, 31),
  );
});

test("scenario 6: half an annual period, from the stated annual price", () => {
  // 183 of 365 days of R490 a year, rounded once.
  assert.equal(
    additionCents({ plan: "essential", period: "annual", addFull: 1, addEquipment: 0, remaining: 183, total: 365 }),
    24567,
  );
  // An extra equipment space for a whole year is R150, not R15 x 12.
  assert.equal(
    additionCents({ plan: "professional", period: "annual", addFull: 0, addEquipment: 1, remaining: 365, total: 365 }),
    15000,
  );
});

test("days left include today and never run past the period", () => {
  assert.deepEqual(periodDays("2026-11-01", "2026-11-30", "2026-11-30"), { remaining: 1, total: 30 });
  assert.deepEqual(periodDays("2026-11-01", "2026-11-30", "2026-12-01"), { remaining: 0, total: 30 });
  assert.deepEqual(periodDays("2026-11-01", "2026-11-30", "2026-10-20"), { remaining: 30, total: 30 });
  assert.equal(prorateCents(9900, 0, 30), 0);
});

test("scenario 7: Professional to Complete with five full and fifteen equipment is a credit", () => {
  const d = upgradeDifference({
    from: "professional",
    to: "complete",
    period: "monthly",
    fullSpaces: 5,
    equipmentCapacity: 15,
    remaining: 15,
    total: 30,
  });
  assert.ok(d);
  assert.equal(d.fromCents, 54500);
  assert.equal(d.toCents, 49500);
  assert.equal(d.chargeCents, 0);
  assert.equal(d.creditCents, 2500);
});

test("scenario 8: Complete to Professional for that mix costs more at the renewal", () => {
  const complete = renewal("complete", "monthly", { fullSpaces: 5, equipment: 15 });
  const professional = renewal("professional", "monthly", { fullSpaces: 5, equipment: 15 });
  assert.equal(complete?.totalCents, 49500);
  assert.equal(professional?.totalCents, 54500);
  // And what Professional no longer has, listed for the preview.
  const lost = lostFeatures("complete", "professional");
  assert.ok(lost.includes("aarto") && lost.includes("voice_ai") && lost.includes("maps"));
  assert.ok(!lost.includes("dashboard") && !lost.includes("trips"));
  assert.deepEqual(lostFeatures("essential", "complete"), []);
});

test("a charge for an upgrade that costs more is the difference for the days left", () => {
  const d = upgradeDifference({
    from: "essential",
    to: "professional",
    period: "monthly",
    fullSpaces: 5,
    equipmentCapacity: 0,
    remaining: 15,
    total: 30,
  });
  assert.deepEqual(d && { charge: d.chargeCents, credit: d.creditCents }, { charge: 7500, credit: 0 });
});

test("cents round half away from zero, as Postgres numeric does", () => {
  assert.equal(roundCents(2.5), 3);
  assert.equal(roundCents(-2.5), -3);
  assert.equal(roundCents(-2.4), -2);
});

test("the rule is the migration's: days inclusive of today, the package valued by the renewal sum", () => {
  assert.match(SQL, /v_rem\s+:= greatest\(least\(\(s\.current_period_end - v_today\) \+ 1, v_total\), 0\)/);
  assert.match(SQL, /v_old_val := app\.billing_renewal_cents\(v_old, v_full_now, v_cap_now\)/);
  assert.match(SQL, /v_to_extra := greatest\(v_cap_now - v_inc_new, 0\)/);
  assert.match(SQL, /round\(p_period_cents::numeric \* least\(p_remaining, p_total\) \/ p_total\)/);
});
