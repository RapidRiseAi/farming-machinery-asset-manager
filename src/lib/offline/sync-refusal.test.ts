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
