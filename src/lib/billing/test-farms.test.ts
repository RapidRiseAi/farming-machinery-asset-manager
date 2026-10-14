/**
 * Test farms on the billing console (20261014110000): the click-through farm the automatic
 * checks sign in to is a real farm on production, and until it was marked it counted as a
 * customer. It stays listed, so it can be opened, but is in no headline and never shows up
 * as a farm that is not paying yet.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { adminTotals, farmsWithoutSubscription, type AdminBillingRow, type FarmBillingRow, type SubscriptionRow } from "./view";

const farm = (id: string, isTest: boolean): FarmBillingRow => ({
  id,
  name: id,
  plan: "complete",
  billing_period: "monthly",
  status: "active",
  asset_count: 3,
  billing_address: "1 Farm Road",
  is_test: isTest,
});

const row = (status: string, isTest: boolean): AdminBillingRow =>
  ({ sub: { status }, farm: farm(`farm-${status}-${isTest}`, isTest), effectivePlan: "complete", diverged: false }) as unknown as AdminBillingRow;

test("headline totals leave test farms out", () => {
  const totals = adminTotals([
    row("past_due", false),
    row("past_due", true),
    row("grace", true),
    row("trialing", false),
    row("trialing", true),
    row("downgraded", true),
    row("active", true),
  ]);
  assert.deepEqual(totals, { all: 2, failing: 1, downgraded: 0, trialing: 1 });
});

test("a test farm is never listed as a farm not paying yet", () => {
  const subs = [{ farm_id: "paying" }] as unknown as SubscriptionRow[];
  const unbilled = farmsWithoutSubscription(subs, [farm("paying", false), farm("customer", false), farm("click-through", true)]);
  assert.deepEqual(unbilled.map((f) => f.id), ["customer"]);
});
