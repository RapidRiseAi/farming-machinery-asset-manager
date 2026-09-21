/**
 * What the tyre screen decides, once SQL has done the cost arithmetic.
 *
 * Two of these matter more than the rest. A rate must never be printed for a tyre that has
 * run on both an hours machine and a km machine, because a sum of hours and kilometres
 * looks exactly like an answer. And "nobody has checked this tyre" must not read as "this
 * tyre is fine", because the unchecked one is precisely the one to go and look at.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { t } from "@/lib/i18n";
import {
  LEGAL_MIN_TREAD_MM,
  TYRE_AXLES,
  TYRE_STATUSES,
  WATCH_TREAD_MM,
  groupByMachine,
  ratePhrase,
  statusLook,
  treadLook,
  treadUsedPct,
  treadVerdict,
  tyreTotals,
  whereKey,
  type TyreLifeRow,
} from "./tyres";

function tyre(over: Partial<TyreLifeRow> = {}): TyreLifeRow {
  return {
    tyre_id: "t1",
    brand: "Michelin",
    pattern: "XM108",
    size: "520/85R42",
    serial_no: "SN-1",
    status: "fitted",
    purchase_cost_cents: 600000,
    new_tread_mm: 20,
    latest_tread_mm: 9,
    latest_checked_on: "2026-01-01",
    machine_id: "m1",
    machine_name: "Rooi Massey",
    position_label: "LR",
    axle: "drive",
    fitted_on: "2025-02-01",
    units_run: 4000,
    meter_type: "hours",
    cost_per_unit_cents: 150,
    ...over,
  };
}

test("a tyre nobody has checked is not a tyre that is fine", () => {
  const unchecked = treadVerdict(tyre({ latest_tread_mm: null }));
  assert.equal(unchecked, "unknown");
  assert.notEqual(unchecked, "ok");
  // Amber, because it is the one to go and look at.
  assert.equal(treadLook("unknown").tone, "neutral");
  assert.notEqual(treadLook("unknown").tone, treadLook("ok").tone);
});

test("the legal minimum is the line between watch and replace", () => {
  // 1mm across the tread is the South African legal minimum on a public road.
  assert.equal(treadVerdict(tyre({ latest_tread_mm: LEGAL_MIN_TREAD_MM })), "replace");
  assert.equal(treadVerdict(tyre({ latest_tread_mm: 0.5 })), "replace");
  assert.equal(treadVerdict(tyre({ latest_tread_mm: LEGAL_MIN_TREAD_MM + 0.5 })), "watch");
  assert.equal(treadVerdict(tyre({ latest_tread_mm: WATCH_TREAD_MM })), "watch");
  assert.equal(treadVerdict(tyre({ latest_tread_mm: WATCH_TREAD_MM + 0.1 })), "ok");
});

test("tread used needs the baseline, because a reading alone says nothing", () => {
  // 20mm new, 9mm now: 55% gone.
  assert.equal(treadUsedPct(tyre()), 55);
  // Without the baseline there is no percentage to state, and inventing one would be
  // inventing the only figure on the row a farmer would act on.
  assert.equal(treadUsedPct(tyre({ new_tread_mm: null })), null);
  assert.equal(treadUsedPct(tyre({ latest_tread_mm: null })), null);
  // Clamped: a reading taken on the wrong tyre must not render a bar off its track.
  assert.equal(treadUsedPct(tyre({ latest_tread_mm: 25 })), 0);
  assert.equal(treadUsedPct(tyre({ latest_tread_mm: 0 })), 100);
});

test("a rate is never printed for a tyre that ran on hours AND kilometres", () => {
  // SQL returns a null unit for that case. If this defaulted to one, the screen would
  // print a confident number derived from adding hours to kilometres.
  assert.equal(ratePhrase(tyre({ meter_type: null, cost_per_unit_cents: 99 })), null);
  // And the other two reasons there may be no rate.
  assert.equal(ratePhrase(tyre({ cost_per_unit_cents: null })), null);
  assert.equal(ratePhrase(tyre({ meter_type: "none", cost_per_unit_cents: 12 })), null);

  assert.deepEqual(ratePhrase(tyre()), { key: "tyres.ratePerHour", cents: 150 });
  assert.deepEqual(
    ratePhrase(tyre({ meter_type: "km", cost_per_unit_cents: 4 })),
    { key: "tyres.ratePerKm", cents: 4 },
  );
});

test("where a tyre is reads as a place, not as two null columns", () => {
  assert.deepEqual(whereKey(tyre()), {
    key: "tyres.whereMachinePosition",
    vars: { machine: "Rooi Massey", position: "LR" },
  });
  assert.deepEqual(whereKey(tyre({ position_label: null })), {
    key: "tyres.whereMachine",
    vars: { machine: "Rooi Massey" },
  });
  assert.deepEqual(whereKey(tyre({ machine_name: null, position_label: null })), {
    key: "tyres.whereStore",
    vars: {},
  });
});

test("the list groups by machine and keeps the shelf separate", () => {
  const rows = [
    tyre({ tyre_id: "a", machine_id: "m2", machine_name: "Bakkie", position_label: "RF" }),
    tyre({ tyre_id: "b", machine_id: "m1", machine_name: "Rooi Massey", position_label: "RR" }),
    tyre({ tyre_id: "c", machine_id: "m1", machine_name: "Rooi Massey", position_label: "LR" }),
    tyre({ tyre_id: "d", status: "in_stock", machine_id: null, machine_name: null, position_label: null }),
    tyre({ tyre_id: "e", status: "scrapped", machine_id: null, machine_name: null, position_label: null }),
  ];
  const { machines, unfitted } = groupByMachine(rows);
  assert.deepEqual(machines.map((m) => m.name), ["Bakkie", "Rooi Massey"]);
  // Within a machine, by position, so a person reading it can walk round the vehicle.
  assert.deepEqual(machines[1]?.tyres.map((x) => x.position_label), ["LR", "RR"]);
  assert.deepEqual(unfitted.map((x) => x.tyre_id), ["d", "e"]);
});

test("the tiles count jobs, not rows", () => {
  const rows = [
    tyre({ tyre_id: "bald", latest_tread_mm: 0.8 }),
    tyre({ tyre_id: "fine", latest_tread_mm: 12 }),
    // Unchecked and ON something: a job.
    tyre({ tyre_id: "unchecked", latest_tread_mm: null }),
    // Unchecked and in the store: not a job, and counting it makes the number one nobody
    // acts on.
    tyre({
      tyre_id: "shelf", status: "in_stock", latest_tread_mm: null,
      machine_id: null, machine_name: null, purchase_cost_cents: 100000,
    }),
  ];
  const totals = tyreTotals(rows);
  assert.equal(totals.fitted, 3);
  assert.equal(totals.replace, 1);
  assert.equal(totals.unchecked, 1);
  // Spend is every tyre bought, shelf included: it was still money out.
  assert.equal(totals.spendCents, 600000 * 3 + 100000);
});

test("every status, axle and verdict has words in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const s of TYRE_STATUSES) {
      const key = statusLook(s).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const v of ["replace", "watch", "ok", "unknown"] as const) {
      const key = treadLook(v).labelKey;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const a of TYRE_AXLES) {
      const key = `tyreAxle.${a}`;
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
    for (const key of [
      "tyres.whereStore", "tyres.whereMachine", "tyres.whereMachinePosition",
      "tyres.ratePerHour", "tyres.ratePerKm",
    ]) {
      assert.notEqual(t(key, lang), key, `${key} renders its own key in ${lang}`);
    }
  }
});
