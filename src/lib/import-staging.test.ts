import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IMPORT_ISSUES, issueField, normaliseDate, readingsSheet, readingsTemplate, sheetColumns, sortIssues } from "./import-staging";
import { READINGS_IMPORT_MAX_ROWS } from "./limits";

test("headers are found in English and Afrikaans, whatever their case and spacing", () => {
  assert.deepEqual(sheetColumns(["Machine", "Reading Date", "Hours"]), { asset: 0, date: 1, reading: 2, unit: -1 });
  assert.deepEqual(sheetColumns(["datum", "Bate", "Lesing", "Eenheid"]), { asset: 1, date: 0, reading: 2, unit: 3 });
});

test("a sheet becomes rows numbered as the spreadsheet numbers them, cells as typed", () => {
  const r = readingsSheet("asset,date,reading,unit\nTractor 1,2026-11-10,120,hours\n\n Bakkie ,10/11/2026,\"85 400\",km\n");
  assert.ok(r.ok);
  assert.deepEqual(r.rows.map((x) => [x.row_no, x.asset, x.date, x.reading, x.unit]), [
    [2, "Tractor 1", "2026-11-10", "120", "hours"],
    [4, "Bakkie", "10/11/2026", "85 400", "km"],
  ]);
  assert.match(r.rows[1].source_text, /Bakkie/);
});

test("nothing is corrected or filled in: a bad value goes through for the database to name", () => {
  const r = readingsSheet("asset,date,reading\n,30/02/2026,12O\n");
  assert.ok(r.ok);
  assert.deepEqual([r.rows[0].asset, r.rows[0].date, r.rows[0].reading, r.rows[0].unit], ["", "30/02/2026", "12O", undefined]);
});

test("dates: separators only, never the order of day and month", () => {
  assert.equal(normaliseDate("2026/11/10"), "2026-11-10");
  assert.equal(normaliseDate("2026.11.10"), "2026-11-10");
  assert.equal(normaliseDate("10-11-2026"), "10/11/2026");
  assert.equal(normaliseDate("10.11.2026"), "10/11/2026");
  assert.equal(normaliseDate("11/10/26"), "11/10/26", "a short year is left for the database to refuse");
  assert.equal(normaliseDate("Nov 10"), "Nov 10");
});

test("an empty sheet, a sheet without the needed headers, and one too long are refused", () => {
  assert.deepEqual(readingsSheet(""), { ok: false, error: "import-empty" });
  assert.deepEqual(readingsSheet("asset,date,reading\n\n"), { ok: false, error: "import-empty" });
  assert.deepEqual(readingsSheet("name,when,value\nx,y,z\n"), { ok: false, error: "import-header" });
  const many = "asset,date,reading\n" + "T,2026-11-10,1\n".repeat(READINGS_IMPORT_MAX_ROWS + 1);
  assert.deepEqual(readingsSheet(many), { ok: false, error: "import-too-many" });
  const padded = "asset,date,reading\n" + "\n".repeat(10000) + "T,2026-11-10,1\n";
  assert.deepEqual(readingsSheet(padded), { ok: false, error: "import-too-many" });
});

test("the template reads back as two rows", () => {
  const r = readingsSheet(readingsTemplate());
  assert.ok(r.ok);
  assert.equal(r.rows.length, 2);
});

test("issue codes match the database's, and each doubt names the field that clears it", () => {
  const sql = readFileSync("supabase/migrations/20261121110000_import_staging.sql", "utf8");
  const named = new Set([...sql.matchAll(/v_issues \|\| '([a-z_]+)'::text/g)].map((m) => m[1]));
  assert.deepEqual([...named].sort(), [...IMPORT_ISSUES].sort());
  assert.equal(issueField("date_conflict"), "date");
  assert.equal(issueField("uncertain_asset"), "machine");
  assert.equal(issueField("unit_mismatch"), "reading");
  assert.equal(issueField("duplicate_existing"), null);
  // The same grouping as import_row_decide's per-field rule.
  for (const issue of IMPORT_ISSUES) {
    const field = issueField(issue);
    if (!field) continue;
    const param = { machine: "p_machine", date: "p_date", reading: "p_reading" }[field];
    const rule = new RegExp(String.raw`\(${param} is null and ir\.issues && array\[[^\]]*'${issue}'`);
    assert.match(sql, rule, `${issue} is cleared only by ${param}`);
  }
});

test("issues sort into reading order and unknown codes stay at the end", () => {
  assert.deepEqual(sortIssues(["uncertain_reading", "something_new", "asset_unknown"]), ["asset_unknown", "uncertain_reading", "something_new"]);
});
