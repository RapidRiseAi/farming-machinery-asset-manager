import { test } from "node:test";
import assert from "node:assert/strict";

import { checkFills, findColumns, parseWhen, plainReg, readFills, type Fill } from "./fuel-cards";

test("columns are found under the names banks use, in either language", () => {
  const { columns, missing } = findColumns(["Transaction Date", "Vehicle Reg", "Liters", "Bedrag", "Odometer"]);
  assert.deepEqual(missing, []);
  assert.equal(columns.vehicle, 1);
  assert.equal(columns.amount, 3);
});

test("a file without the essentials says what it is missing", () => {
  assert.deepEqual(findColumns(["Date", "Reg"]).missing, ["litres", "amount"]);
});

test("registrations match whatever the spacing", () => {
  assert.equal(plainReg("abc 123 gp"), "ABC123GP");
  assert.equal(plainReg("ABC-123-GP"), "ABC123GP");
});

test("dates read as South African time, in the usual layouts", () => {
  assert.equal(parseWhen("05/10/2026", "08:30"), "2026-10-05T06:30:00.000Z");
  assert.equal(parseWhen("2026-10-05"), "2026-10-05T10:00:00.000Z");
  assert.equal(parseWhen("13/13/2026"), null);
  assert.equal(parseWhen("soon"), null);
});

test("a row that cannot be read is counted, not guessed at", () => {
  const { fills, skipped } = readFills([
    ["Date", "Reg", "Litres", "Amount"],
    ["05/10/2026", "ABC 123 GP", "300,5", "R 6 600,00"],
    ["not a date", "ABC 123 GP", "10", "20"],
    ["", "", "", ""],
  ]);
  assert.equal(fills.length, 1);
  assert.equal(skipped, 1);
  assert.equal(fills[0].litres, 300.5);
  assert.equal(fills[0].amountCents, 660000);
});

const fill = (over: Partial<Fill>): Fill => ({
  occurredAt: "2026-10-05T06:00:00.000Z",
  cardRef: "1234",
  vehicleRef: "ABC123GP",
  driverRef: null,
  merchant: null,
  litres: 100,
  amountCents: 220000,
  odometer: null,
  ...over,
});
const truck = { id: "t1", regKey: "ABC123GP", tankLitres: 400 };

test("a clean fill passes", () => {
  const [r] = checkFills([fill({})], [truck]);
  assert.equal(r.machineId, "t1");
  assert.deepEqual(r.flags, []);
});

test("a vehicle nobody knows is flagged and books to nothing", () => {
  const [r] = checkFills([fill({ vehicleRef: "ZZZ999GP" })], [truck]);
  assert.equal(r.machineId, null);
  assert.deepEqual(r.flags, ["unknown_vehicle"]);
});

test("more than the tank holds is flagged", () => {
  assert.deepEqual(checkFills([fill({ litres: 450 })], [truck])[0].flags, ["over_tank"]);
});

test("two fills too close together are flagged, however the file is ordered", () => {
  const out = checkFills(
    [fill({ occurredAt: "2026-10-05T07:00:00.000Z" }), fill({ occurredAt: "2026-10-05T06:00:00.000Z" })],
    [truck],
  );
  assert.deepEqual(out[0].flags, []);
  assert.deepEqual(out[1].flags, ["too_soon"]);
});

test("the last statement counts as history", () => {
  const [r] = checkFills(
    [fill({ odometer: 1000 })],
    [truck],
    [{ machineId: "t1", occurredAt: "2026-10-04T06:00:00.000Z", odometer: 1500 }],
  );
  assert.deepEqual(r.flags, ["odometer_back"]);
});
