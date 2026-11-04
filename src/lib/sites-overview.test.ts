import assert from "node:assert/strict";
import test from "node:test";
import { planAllows } from "@/lib/entitlements";
import { monthStart, siteTotals, type SiteRow } from "./sites-overview";

const figures = (machines: number, cost: number | null) => ({
  machines, outOfService: 1, openFaults: 2, overdueServices: 3, openJobs: 4, runningCostCents: cost,
});

test("the combined view is Complete and above; ordinary switching is not gated here", () => {
  assert.equal(planAllows("essential", "multi_site"), false);
  assert.equal(planAllows("professional", "multi_site"), false);
  assert.equal(planAllows("complete", "multi_site"), true);
  assert.equal(planAllows("done_for_you", "multi_site"), true);
});

test("totals add the included farms only, and money only where it can be seen", () => {
  const rows: SiteRow[] = [
    { id: "a", name: "A", role: "owner", plan: "complete", figures: figures(10, 150000) },
    { id: "b", name: "B", role: "manager", plan: "complete", figures: figures(5, null) },
    { id: "c", name: "C", role: "owner", plan: "professional", figures: null },
  ];
  const totals = siteTotals(rows);
  assert.equal(totals.machines, 15);
  assert.equal(totals.openFaults, 4);
  assert.equal(totals.runningCostCents, 150000);
  assert.equal(totals.costFarms, 1);
  assert.equal(siteTotals([rows[1]]).runningCostCents, null, "no farm shows costs: no money figure at all");
});

test("the month starts on the farm's own calendar, not UTC's", () => {
  // 23:30 UTC on 31 October is already 1 November in South Africa.
  assert.equal(monthStart(new Date("2026-10-31T23:30:00Z")), "2026-11-01");
  assert.equal(monthStart(new Date("2026-11-15T10:00:00Z")), "2026-11-01");
});
