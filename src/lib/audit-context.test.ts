/**
 * Which audit rows count as a person's change, now that the log never holds a column the
 * grant withholds (20261028091000). A vehicle's price and finance terms are left out of
 * `old`/`new`; an update that changed one names it under `withheld`. Without reading that,
 * an owner correcting a purchase price would leave no trace on the machine page, because
 * nothing visible changed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { changedColumns, isHumanChange, type AuditRow } from "@/lib/audit-context";

const row = (diff: AuditRow["diff"], action = "update"): AuditRow => ({
  id: 1,
  user_id: null,
  action,
  at: "2026-10-28T08:00:00Z",
  diff,
});

test("visible changes are listed as before", () => {
  const r = row({ old: { name: "A", status: "active" }, new: { name: "B", status: "active" } });
  assert.deepEqual(changedColumns(r), ["name"]);
  assert.equal(isHumanChange(r), true);
});

test("a finance-only edit is named by withheld and counts as a person's change", () => {
  const r = row({
    old: { name: "A", current_reading: 10 },
    new: { name: "A", current_reading: 10 },
    withheld: ["purchase_price_cents"],
  });
  assert.deepEqual(changedColumns(r), ["purchase_price_cents"]);
  assert.equal(isHumanChange(r), true);
});

test("the engine's own reading advance stays automatic", () => {
  const r = row({ old: { current_reading: 10 }, new: { current_reading: 11 } });
  assert.deepEqual(changedColumns(r), ["current_reading"]);
  assert.equal(isHumanChange(r), false);
});

test("a malformed withheld value is ignored, never trusted", () => {
  const r = row({ old: { name: "A" }, new: { name: "A" }, withheld: "purchase_price_cents" });
  assert.deepEqual(changedColumns(r), []);
  assert.equal(isHumanChange(r), false);
  const mixed = row({ old: { name: "A" }, new: { name: "A" }, withheld: [3, "supplier", null] });
  assert.deepEqual(changedColumns(mixed), ["supplier"]);
});

test("a name is not listed twice", () => {
  const r = row({ old: { name: "A" }, new: { name: "B" }, withheld: ["name"] });
  assert.deepEqual(changedColumns(r), ["name"]);
});

test("inserts and deletes always count; a redaction failure row is not an edit", () => {
  assert.equal(isHumanChange(row({ new: { name: "A" } }, "insert")), true);
  assert.equal(isHumanChange(row({ old: { name: "A" } }, "delete")), true);
  assert.equal(isHumanChange(row({ redaction_failed: true } as unknown as AuditRow["diff"])), false);
});
