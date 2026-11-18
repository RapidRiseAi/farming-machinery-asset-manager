import { test } from "node:test";
import assert from "node:assert/strict";

import { driverHours } from "./driver-hours";
import { langOf } from "./i18n";
import { marginPerKmCents, randsToCents, tripDistance, tripFields, tripReport, tripResultCents } from "./trips";

test("each kind of company is asked about what it carries", () => {
  assert.deepEqual(tripFields(langOf("en", "friendly", "game_drive")), { goods: false, passengers: true });
  assert.deepEqual(tripFields(langOf("en", "friendly", "goods_transport")), { goods: true, passengers: false });
  assert.deepEqual(tripFields(langOf("en", "friendly", "other")), { goods: true, passengers: true });
  assert.deepEqual(tripFields("en"), { goods: true, passengers: true });
});

test("a trip's distance comes from both readings", () => {
  assert.equal(tripDistance({ opening_reading: 1000, closing_reading: 1600 }), 600);
  assert.equal(tripDistance({ opening_reading: 1000, closing_reading: null }), null);
});

test("margin per kilometre is after trip costs", () => {
  assert.equal(marginPerKmCents({ incomeCents: 1500000, expenseCents: 45000, km: 600 }), 2425);
  assert.equal(marginPerKmCents({ incomeCents: 1500000, expenseCents: 0, km: 0 }), null);
});

test("money typed by a person", () => {
  assert.equal(randsToCents("1 250,50"), 125050);
  assert.equal(randsToCents("R1250.50"), 125050);
  assert.equal(randsToCents(""), null);
  assert.equal(randsToCents("-5"), null);
  assert.equal(randsToCents("lots"), null);
});

const policy = { maxDay: 12, maxWeek: 60, minRest: 8 };
const now = new Date("2026-11-07T18:00:00Z");

test("hours in the last day and week", () => {
  const [d] = driverHours([{ driverId: "a", start: "2026-11-07T08:00:00Z", end: "2026-11-07T14:00:00Z" }], policy, now);
  assert.equal(d.day, 6);
  assert.equal(d.week, 6);
  assert.equal(d.overDay, false);
});

test("a trip and a driving session over the same time count once", () => {
  const [d] = driverHours([
    { driverId: "a", start: "2026-11-07T08:00:00Z", end: "2026-11-07T14:00:00Z" },
    { driverId: "a", start: "2026-11-07T09:00:00Z", end: "2026-11-07T15:00:00Z" },
  ], policy, now);
  assert.equal(d.day, 7);
});

test("work still going on counts up to now", () => {
  const [d] = driverHours([{ driverId: "a", start: "2026-11-07T04:00:00Z", end: null }], policy, now);
  assert.equal(d.day, 14);
  assert.equal(d.overDay, true);
  assert.equal(d.active, true);
});

test("too short a break between shifts is flagged", () => {
  const [d] = driverHours([
    { driverId: "a", start: "2026-11-06T06:00:00Z", end: "2026-11-06T16:00:00Z" },
    { driverId: "a", start: "2026-11-06T20:00:00Z", end: "2026-11-07T02:00:00Z" },
  ], policy, now);
  assert.equal(d.shortestRest, 4);
  assert.equal(d.shortRest, true);
});

test("a week over the limit is flagged, and each driver is separate", () => {
  const days = Array.from({ length: 6 }, (_, i) => ({
    driverId: "a",
    start: `2026-11-0${i + 2}T06:00:00Z`,
    end: `2026-11-0${i + 2}T17:00:00Z`,
  }));
  const hours = driverHours([...days, { driverId: "b", start: "2026-11-07T08:00:00Z", end: "2026-11-07T09:00:00Z" }], policy, now);
  assert.equal(hours.find((h) => h.driverId === "a")?.overWeek, true);
  assert.equal(hours.find((h) => h.driverId === "b")?.overWeek, false);
});

// == The trip report (B3, R-061): honest about what it cannot know ====================
const done = (id: string, machine: string, open: number | null, close: number | null) =>
  ({ id, machine_id: machine, status: "completed", opening_reading: open, closing_reading: close });

test("cancelled and unfinished trips are reported, never summed", () => {
  const report = tripReport(
    [done("t1", "m1", 100, 200), { ...done("t2", "m1", 0, 50), status: "cancelled" }, { ...done("t3", "m1", 200, null), status: "underway" }],
    new Map([["t1", 10000], ["t2", 99999], ["t3", 88888]]),
    new Map([["t2", 500]]),
  );
  assert.equal(report.finished, 1);
  assert.equal(report.cancelled, 1);
  assert.equal(report.unfinished, 1);
  assert.equal(report.vehicles[0].incomeCents, 10000);
  assert.equal(report.vehicles[0].expenseCents, 0);
});

test("a trip without readings adds money but no distance, and stays out of the per-km figure", () => {
  const report = tripReport(
    [done("a", "m1", 0, 100), done("b", "m1", null, null)],
    new Map([["a", 20000], ["b", 1000000]]),
    new Map([["a", 0]]),
  );
  const [v] = report.vehicles;
  assert.equal(v.trips, 2);
  assert.equal(v.tripsWithKm, 1);
  assert.equal(v.km, 100);
  assert.equal(v.incomeCents, 1020000);
  // From trip a only: R200 over 100 km. Counting b's income over a's distance would say R102/km.
  assert.equal(v.perKmCents, 200);
  assert.equal(report.withoutReadings, 1);
});

test("no distance means no per-km figure, never a division by zero", () => {
  const report = tripReport([done("z", "m1", 500, 500)], new Map([["z", 5000]]), new Map());
  assert.equal(report.zeroKm, 1);
  assert.equal(report.vehicles[0].perKmCents, null);
  assert.equal(tripReport([], new Map(), new Map()).vehicles.length, 0);
});

test("a trip with no income entered is counted as unknown income, not as R0 earned", () => {
  const report = tripReport([done("n", "m1", 0, 10)], new Map(), new Map([["n", 3000]]));
  assert.equal(report.vehicles[0].tripsWithoutIncome, 1);
  assert.equal(report.vehicles[0].expenseCents, 3000);
  assert.equal(tripResultCents(null, 3000), null);
  assert.equal(tripResultCents(10000, 3000), 7000);
  assert.equal(tripResultCents(0, 0), 0);
});

test("only each trip's own expenses are counted: one trip's costs never reach another's", () => {
  const report = tripReport(
    [done("x", "m1", 0, 10), done("y", "m2", 0, 10)],
    new Map([["x", 1000], ["y", 1000]]),
    new Map([["x", 400], ["other-trip", 99999]]),
  );
  const m1 = report.vehicles.find((v) => v.machineId === "m1");
  const m2 = report.vehicles.find((v) => v.machineId === "m2");
  assert.equal(m1?.expenseCents, 400);
  assert.equal(m2?.expenseCents, 0);
});
