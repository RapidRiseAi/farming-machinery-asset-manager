import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSyncEnvelope } from "./envelope";

function form(fields: unknown = { reading: "10" }) {
  const fd = new FormData();
  fd.set("client_id", "8b400000-0000-4000-8000-000000000001");
  fd.set("client_ts", "2026-09-01T10:00:00Z");
  fd.set("scope", "app"); fd.set("type", "log_reading");
  fd.set("payload", JSON.stringify(fields));
  return fd;
}
test("offline envelope accepts capture timestamp and string fields", () => {
  assert.equal(parseSyncEnvelope(form())?.fields.reading, "10");
});
test("offline envelope rejects nested, null and oversized values", () => {
  for (const fields of [null, [], { reading: 10 }, { reading: {} }, { description: "x".repeat(2001) }]) {
    assert.equal(parseSyncEnvelope(form(fields)), null);
  }
});
test("offline envelope rejects future clocks, unknown scope and public crew mutations", () => {
  const fd = form(); fd.set("client_ts", "2099-01-01"); assert.equal(parseSyncEnvelope(fd), null);
  fd.set("client_ts", "2026-09-01"); fd.set("scope", "other"); assert.equal(parseSyncEnvelope(fd), null);
  fd.set("scope", "public"); fd.set("type", "complete_job"); assert.equal(parseSyncEnvelope(fd), null);
});
test("offline money ignores forged normalized cents and rejects invalid or negative amounts", () => {
  const fd = form({ kind: "part", unit_cost: "1,250.50", unit_cost_cents: "1" }); fd.set("type", "add_job_line");
  assert.equal(parseSyncEnvelope(fd)?.fields.unit_cost_cents, "125050");
  for (const unit_cost of ["nope", "-1", "99999999999999999"]) {
    fd.set("payload", JSON.stringify({ unit_cost })); assert.equal(parseSyncEnvelope(fd), null);
  }
});
