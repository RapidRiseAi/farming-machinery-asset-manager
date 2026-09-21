/**
 * The SARS logbooks are the records a rebate claim is audited against, so the two things
 * that matter here are that the balance actually follows the movements, and that nothing
 * is quietly left out. A logbook whose totals disagree with the tank, or with our own
 * other logbook, is worse than no logbook.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  storageLogbookRows,
  usageLogbookRows,
  type LogbookDelivery,
  type LogbookIssue,
  type LogbookMachine,
} from "./fuel-logbook";

const EN = "en" as const;

const machines = new Map<string, LogbookMachine>([
  ["m1", { id: "m1", name: "Groen John Deere", reg_no: "CA 123-456", meter_type: "hours" }],
  ["m2", { id: "m2", name: "Rooi Massey", reg_no: null, meter_type: "none" }],
]);

const deliveries: LogbookDelivery[] = [
  { tank_id: "t1", date: "2026-09-02", litres: 1000, supplier: "Agri Diesel", invoice_no: "INV-1" },
  { tank_id: "t1", date: "2026-09-10", litres: 500, supplier: "Agri Diesel", invoice_no: "INV-2" },
];

const issues: LogbookIssue[] = [
  { tank_id: "t1", machine_id: "m1", date: "2026-09-05", litres: 120, meter_reading: 1250, activity: "ploughing", driver: "Thabo" },
  { tank_id: "t1", machine_id: null, date: "2026-09-07", litres: 80, meter_reading: null, activity: null, driver: null },
  { tank_id: "t1", machine_id: "m2", date: "2026-09-12", litres: 60, meter_reading: null, activity: "irrigation", driver: "Sipho" },
];

test("the storage balance follows every movement in date order", () => {
  const rows = storageLogbookRows("Main tank", deliveries, issues, machines, EN);
  // Two notice lines, a header, then one row per movement.
  const body = rows.slice(3);
  assert.equal(body.length, deliveries.length + issues.length);

  const dates = body.map((r) => r[0]);
  assert.deepEqual(dates, ["2026-09-02", "2026-09-05", "2026-09-07", "2026-09-10", "2026-09-12"]);

  // 1000 in, 120 out, 80 out, 500 in, 60 out → 1240 left in the tank.
  const closing = body.map((r) => Number(r[4]));
  assert.deepEqual(closing, [1000, 880, 800, 1300, 1240]);

  // Each row's opening is the previous row's closing: the trail can be followed by hand,
  // which is exactly how it will be read in an audit.
  for (let i = 1; i < body.length; i++) {
    assert.equal(Number(body[i][1]), Number(body[i - 1][4]), `row ${i} does not carry forward`);
  }
});

test("every export says it is a draft, before anything else", () => {
  const storage = storageLogbookRows("Main tank", deliveries, issues, machines, EN);
  const usage = usageLogbookRows(issues, machines, new Map([["t1", "Main tank"]]), EN);
  for (const rows of [storage, usage]) {
    assert.match(String(rows[0][0]), /DRAFT/);
    assert.match(String(rows[0][0]), /accountant/i);
  }
});

test("a draw with no activity is still listed, with the gap visible", () => {
  const rows = usageLogbookRows(issues, machines, new Map([["t1", "Main tank"]]), EN);
  const body = rows.slice(3);
  // Dropping it would make this logbook's litres disagree with the storage logbook's, and
  // two of our own trails disagreeing is what an audit looks for.
  assert.equal(body.length, issues.length);
  const farmUse = body.find((r) => String(r[0]) === "2026-09-07")!;
  assert.match(String(farmUse[1]), /no machine named/i);
  assert.equal(farmUse[3], "", "the missing activity must read as a gap, not be invented");
});

test("the usage logbook carries what an audit asks a machine for", () => {
  const rows = usageLogbookRows(issues, machines, new Map([["t1", "Main tank"]]), EN);
  const ploughing = rows.slice(3).find((r) => String(r[0]) === "2026-09-05")!;
  assert.equal(ploughing[1], "Groen John Deere");
  assert.equal(ploughing[2], "CA 123-456");
  assert.equal(ploughing[4], "120.0");
  assert.equal(ploughing[5], "1250.0");
  assert.equal(ploughing[7], "Thabo");
  assert.equal(ploughing[8], "Main tank");

  // A machine that keeps no meter leaves the meter columns empty rather than showing a zero
  // that would read as "it did not move".
  const irrigation = rows.slice(3).find((r) => String(r[0]) === "2026-09-12")!;
  assert.equal(irrigation[5], "");
  assert.equal(irrigation[6], "");
});

test("the two logbooks agree about how much diesel left the tank", () => {
  const storage = storageLogbookRows("Main tank", deliveries, issues, machines, EN).slice(3);
  const usage = usageLogbookRows(issues, machines, new Map([["t1", "Main tank"]]), EN).slice(3);
  const issuedOnStorage = storage.reduce((sum, r) => sum + (r[3] === "" ? 0 : Number(r[3])), 0);
  const issuedOnUsage = usage.reduce((sum, r) => sum + Number(r[4]), 0);
  assert.equal(issuedOnStorage, issuedOnUsage);
});
