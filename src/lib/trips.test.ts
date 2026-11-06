import { test } from "node:test";
import assert from "node:assert/strict";

import { driverHours } from "./driver-hours";
import { langOf } from "./i18n";
import { marginPerKmCents, randsToCents, tripDistance, tripFields } from "./trips";

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
