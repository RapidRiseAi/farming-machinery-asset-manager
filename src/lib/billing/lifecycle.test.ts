/**
 * The subscription lifecycle as the screens use it (20261115120000): the South African date
 * the rules are decided on, and who may download the records of a stopped business.
 * supabase/tests/billing_lifecycle.sql proves the database side (scenarios 11 and 40).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { billingToday } from "./policy";
import { mayExport } from "@/components/billing/retrieval-notice";
import type { FarmLifecycle } from "./service";

test("today turns at midnight in South Africa, 22:00 UTC", () => {
  assert.equal(billingToday(new Date("2026-11-15T21:59:59Z")), "2026-11-15");
  assert.equal(billingToday(new Date("2026-11-15T22:00:00Z")), "2026-11-16");
  // A month and a year boundary the same way.
  assert.equal(billingToday(new Date("2026-12-31T22:30:00Z")), "2027-01-01");
});

const life = (over: Partial<FarmLifecycle>): FarmLifecycle => ({
  state: "active",
  gate: "ok",
  reason: null,
  today: "2026-11-15",
  overdue_since: null,
  grace_ends_on: null,
  paid_through: null,
  ended_on: null,
  retrieval_ends_on: null,
  ...over,
});

test("a stopped business is exported by its owner only, while the 90 days are open", () => {
  // Running, or in the grace: whoever the route already lets export.
  assert.equal(mayExport(life({ state: "active" }), false), true);
  assert.equal(mayExport(life({ state: "grace" }), false), true);
  // Never paid: nobody.
  assert.equal(mayExport(life({ state: "pending", gate: "pending" }), true), false);
  // Retrieval: the owner, not the team.
  const retrieval = life({ state: "retrieval", gate: "suspended", reason: "unpaid", retrieval_ends_on: "2027-02-12" });
  assert.equal(mayExport(retrieval, true), true);
  assert.equal(mayExport(retrieval, false), false);
  // After the window: nobody, until it is paid or started again.
  const over = life({ state: "closed", gate: "closed", reason: "cancelled", retrieval_ends_on: "2026-11-01" });
  assert.equal(mayExport(over, true), false);
  // A Rapid Rise hold has no window: the owner keeps the download.
  assert.equal(mayExport(life({ state: "closed", gate: "closed", reason: "rapid_rise" }), true), true);
  assert.equal(mayExport(life({ state: "closed", gate: "closed", reason: "rapid_rise" }), false), false);
});
