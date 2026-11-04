import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORT_COLUMNS, applyMapping, defaultMeterFor, guessMapping, idKey, parseReadingDate, templateCsv, validateCsv,
} from "./csv";

const TODAY = "2026-11-05";
const header = IMPORT_COLUMNS.join(",");
/** One sheet row in canonical column order, by name. */
const row = (cells: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>) =>
  IMPORT_COLUMNS.map((c) => cells[c] ?? "").join(",");
const sheet = (...rows: string[]) => [header, ...rows].join("\n");
const none = { names: [], serials: [], regs: [] };

test("the template the user downloads imports cleanly, reading dates included", () => {
  const result = validateCsv(templateCsv(), none, TODAY);
  assert.equal(result.invalidCount, 0, JSON.stringify(result.rows.map((r) => r.errors)));
  assert.equal(result.rows[0].machine?.current_reading_date, "2026-10-01");
  assert.equal(result.rows[1].machine?.current_reading_date, "2026-09-15", "29/07-style day-first dates");
});

test("a reading date is the sheet's, never invented; a missing one is dated today, visibly", () => {
  const r = validateCsv(sheet(
    row({ name: "A", type: "tractor", meter_type: "hours", current_reading: "4200", reading_date: "2026-07-29" }),
    row({ name: "B", type: "tractor", meter_type: "hours", current_reading: "100" }),
    row({ name: "C", type: "tractor", meter_type: "hours", current_reading: "100", reading_date: "2026-12-01" }),
    row({ name: "D", type: "tractor", meter_type: "hours", current_reading: "100", reading_date: "07/31/2026" }),
    row({ name: "E", type: "tractor", meter_type: "hours", reading_date: "2026-07-29" }),
  ), none, TODAY).rows;
  assert.equal(r[0].machine?.current_reading_date, "2026-07-29");
  assert.equal(r[1].machine?.current_reading_date, null);
  assert.ok(r[1].warnings.includes("reading_date_today"));
  assert.ok(r[2].errors.includes("reading_date_future"));
  assert.ok(r[3].errors.includes("reading_date_invalid"), "month-first is refused, not guessed");
  assert.ok(r[4].warnings.includes("reading_date_unused"));
  assert.equal(r[4].machine?.current_reading_date, null);
});

test("dates: ISO and South African day-first, real days only", () => {
  assert.equal(parseReadingDate("2026-07-29"), "2026-07-29");
  assert.equal(parseReadingDate("2026/7/9"), "2026-07-09");
  assert.equal(parseReadingDate("29/07/2026"), "2026-07-29");
  assert.equal(parseReadingDate("9-7-2026"), "2026-07-09");
  assert.equal(parseReadingDate("31/02/2026"), null);
  assert.equal(parseReadingDate("2026-13-01"), null);
  assert.equal(parseReadingDate("yesterday"), null);
});

test("a year is four digits or it is refused", () => {
  const r = validateCsv(sheet(
    row({ name: "A", type: "tractor", year: "2019" }),
    row({ name: "B", type: "tractor", year: "2019abc" }),
    row({ name: "C", type: "tractor", year: "20.5" }),
    row({ name: "D", type: "tractor", year: "1899" }),
  ), none, TODAY).rows;
  assert.equal(r[0].machine?.year, 2019);
  for (const i of [1, 2, 3]) assert.ok(r[i].errors.includes("year_invalid"), r[i].cells.year);
});

test("blank meter and status default by type, and the row says so", () => {
  const r = validateCsv(sheet(
    row({ name: "Bakkie", type: "bakkie" }),
    row({ name: "Tractor", type: "tractor" }),
    row({ name: "Pump", type: "pump_generator", meter_type: "none", status: "standby" }),
  ), none, TODAY).rows;
  assert.equal(r[0].machine?.meter_type, "km");
  assert.ok(r[0].warnings.includes("meter_defaulted_km"));
  assert.equal(r[1].machine?.meter_type, "hours");
  assert.ok(r[1].warnings.includes("meter_defaulted_hours") && r[1].warnings.includes("status_defaulted"));
  assert.deepEqual(r[2].warnings, []);
  assert.equal(defaultMeterFor("truck"), "km");
});

test("a reading on a machine with no meter is refused; an unknown reading stays null", () => {
  const r = validateCsv(sheet(
    row({ name: "Pump", type: "pump_generator", meter_type: "none", current_reading: "12" }),
    row({ name: "Tractor", type: "tractor", meter_type: "hours" }),
  ), none, TODAY).rows;
  assert.ok(r[0].errors.includes("reading_without_meter"));
  assert.equal(r[1].machine?.current_reading, null);
});

test("a machine already on the farm, or twice in the file, is refused by serial or registration", () => {
  const existing = { names: ["Groen John Deere"], serials: ["1lv6155m-abc123"], regs: ["CA 123 456"] };
  const r = validateCsv(sheet(
    row({ name: "New name", type: "tractor", serial_no: "1LV6155MABC123" }),
    row({ name: "Other", type: "bakkie", reg_no: "ca123456" }),
    row({ name: "Groen John Deere", type: "tractor" }),
    row({ name: "X", type: "truck", serial_no: "S-1" }),
    row({ name: "Y", type: "truck", serial_no: "s1" }),
  ), existing, TODAY).rows;
  assert.ok(r[0].errors.includes("serial_on_farm"));
  assert.ok(r[1].errors.includes("reg_on_farm"));
  assert.ok(r[2].valid && r[2].warnings.includes("name_on_farm"), "a name alone is a warning, not a refusal");
  assert.ok(r[3].valid);
  assert.ok(r[4].errors.includes("serial_twice"));
  assert.equal(idKey(" ca-123 456 "), "CA123456");
});

test("an Afrikaans sheet's reading date column is found by its heading", () => {
  const headers = ["Naam", "Tipe", "Uurmeter", "Lesingdatum"];
  const mapping = guessMapping(headers);
  assert.deepEqual(mapping, ["name", "type", "current_reading", "reading_date"]);
  const canonical = applyMapping("Naam,Tipe,Uurmeter,Lesingdatum\nRooi,tractor,7800,15/09/2026\n", mapping);
  const result = validateCsv(canonical, none, TODAY);
  assert.equal(result.rows[0].machine?.current_reading_date, "2026-09-15");
});
