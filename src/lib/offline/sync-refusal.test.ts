import assert from "node:assert/strict";
import test from "node:test";

import { syncRefusal } from "./sync-refusal";

test("a refusal that retrying cannot change is kept with its reason, never retried as an outage", () => {
  assert.deepEqual(syncRefusal({ code: "P0001", message: "plan-feature-fuel" }), { status: 409, code: "plan-feature-fuel" });
  assert.deepEqual(syncRefusal({ code: "P0001", message: "equipment-refused-fuel" }), { status: 409, code: "equipment-refused-fuel" });
  assert.deepEqual(syncRefusal({ code: "42501", message: "forbidden" }), { status: 403, code: "capture_forbidden" });
  assert.deepEqual(syncRefusal({ code: "P0002", message: "not_found" }), { status: 404, code: "capture_not_found" });
  assert.deepEqual(syncRefusal({ code: "22023", message: "bad_reading" }), { status: 400, code: "capture_rejected" });
  // Any other raised refusal is still a refusal (4xx: kept for review), not "try later".
  assert.equal(syncRefusal({ code: "P0001", message: "something-else" }).status, 400);
});

test("only our own failures are transient", () => {
  assert.deepEqual(syncRefusal({ code: "XX000", message: "boom" }), { status: 503, code: "sync_unavailable" });
  assert.deepEqual(syncRefusal({}), { status: 503, code: "sync_unavailable" });
});

test("every kept draft says why in words; an unknown reason falls back to the general review sentence", async () => {
  const { syncReasonKey } = await import("./sync-refusal");
  const { t } = await import("@/lib/i18n");
  for (const code of ["plan-feature-fuel", "equipment-refused-fuel", "capture_forbidden", "capture_not_found", "capture_rejected", "capture_account_mismatch", "capture_needs_review", "conflict"]) {
    const key = syncReasonKey(code);
    assert.notEqual(key, "offline.needsReview", `${code} has its own sentence`);
    for (const lang of ["en", "af"] as const) assert.notEqual(t(key, lang), key, `${key} exists in ${lang}`);
  }
  assert.equal(syncReasonKey("something-new"), "offline.needsReview");
  assert.equal(syncReasonKey(undefined), "offline.needsReview");
});
