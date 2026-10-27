/**
 * What a page accepts from its address before it reaches Postgres (isUuid, isIsoDate).
 * Since reads fail loudly, a value Postgres refuses was the error screen; these checks
 * turn it back into "not found" or an unfiltered list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsoDate, isUuid } from "./ids";

test("a uuid in either case is accepted, anything else is not", () => {
  assert.equal(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e"), true);
  assert.equal(isUuid("0F8FAD5B-D9CB-469F-A165-70867728950E"), true);
  for (const bad of ["not-a-uuid", "", "0f8fad5b-d9cb-469f-a165-70867728950", "0f8fad5bd9cb469fa16570867728950e", undefined, null, 7]) {
    assert.equal(isUuid(bad), false, String(bad));
  }
});

test("a real calendar date is accepted", () => {
  for (const ok of ["2026-10-27", "2028-02-29", "2026-12-31", "2026-01-01"]) assert.equal(isIsoDate(ok), true, ok);
});

test("a date of the right shape that is not on the calendar is refused, as Postgres refuses it", () => {
  for (const bad of ["2026-02-29", "2026-02-30", "2026-13-45", "2026-00-10", "2026-04-31", "2026-10-00"]) {
    assert.equal(isIsoDate(bad), false, bad);
  }
});

test("anything not shaped YYYY-MM-DD is refused", () => {
  for (const bad of ["not-a-value", "-1", "2026-1-5", "2026-10-27T00:00:00Z", " 2026-10-27", "", undefined, null]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});
