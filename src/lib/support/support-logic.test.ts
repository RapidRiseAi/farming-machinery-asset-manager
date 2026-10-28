import { test } from "node:test";
import assert from "node:assert/strict";

import { supportRefusal, SUPPORT_REFUSALS } from "./refusals";
import { clientState, countClientStates, isQuiet, latestSubscriptions } from "./client-state";
import { ERROR_CODE_KEYS } from "@/lib/errors";

test("the support SQL's own refusals keep their words; anything else does not", () => {
  assert.equal(supportRefusal({ code: "42501", message: "support-farm-not-yours" }), "support-farm-not-yours");
  assert.equal(supportRefusal({ code: "22023", message: "support-need-resolution" }), "support-need-resolution");
  assert.equal(supportRefusal({ code: "53000", message: "You already have five questions open" }), "help-too-many");
  assert.equal(supportRefusal({ code: "53400", message: "anything" }), "support-slow-down");
  // A plain permission failure, or a database fault, is the caller's to report.
  assert.equal(supportRefusal({ code: "42501", message: "Rapid Rise support only." }), null);
  assert.equal(supportRefusal({ code: "XX000", message: "boom" }), null);
  assert.equal(supportRefusal(null), null);
});

test("every support refusal reads as a sentence in lib/errors.ts", () => {
  for (const code of [...SUPPORT_REFUSALS, "help-too-many"]) {
    assert.ok(ERROR_CODE_KEYS[code], `${code} is not mapped in CODE_KEYS`);
  }
});

test("a client's standing comes from the subscription, not the plan on the farm", () => {
  const farm = { status: "active", deleted_at: null };
  assert.equal(clientState(farm, null), "no_subscription");
  assert.equal(clientState(farm, { status: "active" }), "paying");
  assert.equal(clientState(farm, { status: "non_renewing" }), "paying");
  assert.equal(clientState(farm, { status: "past_due" }), "grace");
  assert.equal(clientState(farm, { status: "grace" }), "grace");
  assert.equal(clientState(farm, { status: "pending" }), "awaiting_payment");
  // No trial at launch (decision 9): a trialing subscription has not paid.
  assert.equal(clientState(farm, { status: "trialing" }), "awaiting_payment");
  assert.equal(clientState(farm, { status: "downgraded" }), "suspended");
  assert.equal(clientState(farm, { status: "cancelled" }), "suspended");
  // Rapid Rise suspending the farm wins over a healthy-looking subscription.
  assert.equal(clientState({ status: "suspended" }, { status: "active" }), "suspended");
});

test("the counts use each farm's latest subscription and leave test farms out", () => {
  const farms = [
    { id: "a", status: "active", is_test: false },
    { id: "b", status: "active", is_test: false },
    { id: "t", status: "active", is_test: true },
    { id: "gone", status: "active", is_test: false, deleted_at: "2026-10-01T00:00:00Z" },
  ];
  const subs = [
    { farm_id: "a", status: "pending", created_at: "2026-09-01T00:00:00Z" },
    { farm_id: "a", status: "active", created_at: "2026-10-01T00:00:00Z" },
    { farm_id: "t", status: "active", created_at: "2026-10-01T00:00:00Z" },
  ];
  assert.equal(latestSubscriptions(subs).get("a")?.status, "active");
  assert.deepEqual(countClientStates(farms, subs), {
    paying: 1,
    grace: 0,
    suspended: 0,
    awaiting_payment: 0,
    no_subscription: 1,
  });
  assert.equal(countClientStates(farms, subs, true).paying, 2);
});

test("a farm is quiet after fourteen days without activity", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  assert.equal(isQuiet("2026-10-20T10:00:00Z", now), false);
  assert.equal(isQuiet("2026-10-14T10:00:00Z", now), true);
  assert.equal(isQuiet(null, now, "2026-09-01T00:00:00Z"), true);
  assert.equal(isQuiet(null, now, null), false);
});
