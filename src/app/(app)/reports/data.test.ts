import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { csvCell, getReportData, toCsv, type ReportFilters } from "./data";

const filters: ReportFilters = { from: "2026-09-01", to: "2026-09-30", includeInactive: false, group: null };
const protectedTables = ["job_cards", "fuel_issues", "fuel_deliveries", "work_requests"];

function fixture() {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] };
      reads.push(read);
      const query = {
        select() { return query; },
        is() { return query; },
        eq(key: string, value: unknown) { read.filters.push([key, value]); return query; },
        gte() { return query; },
        lte() { return query; },
        order() { return query; },
        range() { return query; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve: (value: unknown) => unknown) {
          // Without a user subject the view owner returns no fuel rows; the raw
          // service read still contains the farm's real consumption and purchase.
          const data = table === "fuel_issues" ? [{ id: "issue-1", machine_id: null, date: "2026-09-10", litres: 10, cost_cents: 1500 }] :
            table === "fuel_deliveries" ? [{ date: "2026-09-10", litres: 100, price_per_l_cents: 150 }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    rpc() { return Promise.resolve({ data: [], error: null }); },
  } as unknown as SupabaseClient;
  return { client, reads };
}

test("interactive reports keep masked operational projections", async () => {
  const f = fixture();
  await getReportData(f.client, filters, "farm-1");
  for (const table of protectedTables) {
    assert.ok(f.reads.some((read) => read.table === `${table}_visible`));
    assert.ok(!f.reads.some((read) => read.table === table));
  }
});

test("service reports retain operational figures with a farm filter on every raw projection", async () => {
  const f = fixture();
  const report = await getReportData(f.client, filters, "farm-1", { serviceRole: true });
  for (const table of protectedTables) {
    const read = f.reads.find((entry) => entry.table === table);
    assert.ok(read, `${table} must use its service-readable base table`);
    assert.ok(read.filters.some(([key, value]) => key === "farm_id" && value === "farm-1"));
    assert.ok(!f.reads.some((entry) => entry.table === `${table}_visible`));
  }
  assert.equal(report.fuel.purchasedLitres, 100);
  assert.equal(report.fuel.purchasedSpend, 15000);
});

test("service report reads reject a missing farm before querying", async () => {
  const f = fixture();
  await assert.rejects(getReportData(f.client, filters, null, { serviceRole: true }), /require a farm/);
  assert.deepEqual(f.reads, []);
});

test("only the scheduled service worker opts into raw report reads", () => {
  const worker = readFileSync("src/lib/scheduled-reports.ts", "utf8");
  const interactive = readFileSync("src/app/(app)/reports/schedules/actions.ts", "utf8");
  assert.match(worker, /deliverReportRun\(supabase, run, \{ serviceRole: true \}\)/);
  assert.match(interactive, /deliverReportRun\(supabase, run\)/);
  assert.doesNotMatch(interactive, /serviceRole:\s*true/);
});

test("a CSV cell that would run as a spreadsheet formula is written as text", () => {
  for (const evil of ["=HYPERLINK(\"https://x.test\",\"x\")", "+SUM(A1)", "-2+3", "@cmd", "\t=1", "\r=1"]) {
    assert.ok(csvCell(evil).startsWith("\"'"), evil);
  }
  // Numbers and signed amounts stay numbers; ordinary text is untouched.
  assert.equal(csvCell(-120), '"-120"');
  assert.equal(csvCell("-120,50"), '"-120,50"');
  assert.equal(csvCell("+27 82 000 0000".replace(/\s/g, "")), '"+27820000000"');
  assert.equal(csvCell("JD 6120"), '"JD 6120"');
  assert.equal(csvCell('Say "hi"'), '"Say ""hi"""');
  assert.equal(toCsv([["a", 1], ["=1", "b"]]), '"a","1"\r\n"\'=1","b"');
});

function profileFixture() {
  const rows: Record<string, unknown[]> = {
    machines: [
      { id: "truck", name: "Truck", status: "active", current_reading: 1000, meter_type: "km", location: null, profile: "full" },
      { id: "pump", name: "Pump", status: "active", current_reading: 500, meter_type: "hours", location: null, profile: "equipment" },
    ],
    job_cards_visible: [
      { id: "j1", machine_id: "truck", type: "repair", parts_total_cents: 1000, labour_total_cents: 500, other_total_cents: 0, total_cents: 1500, date_out: "2026-09-05" },
      { id: "j2", machine_id: "pump", type: "repair", parts_total_cents: 120000, labour_total_cents: 0, other_total_cents: 0, total_cents: 120000, date_out: "2026-09-06" },
    ],
    cost_entries: [
      { machine_id: "truck", amount_cents: 50000, type: "parts", occurred_on: "2026-09-05" },
      { machine_id: "pump", amount_cents: 120000, type: "parts", occurred_on: "2026-09-06" },
    ],
    fuel_issues_visible: [
      // A draw recorded before the pump was converted: it stays in the totals, never in fuel-use analysis.
      { id: "f1", machine_id: "pump", date: "2026-09-07", litres: 20, meter_reading: 490, cost_cents: 4000 },
      { id: "f2", machine_id: "truck", date: "2026-09-07", litres: 60, meter_reading: 990, cost_cents: 12000 },
    ],
  };
  return {
    from(table: string) {
      const query = {
        select() { return query; }, is() { return query; }, eq() { return query; }, gte() { return query; },
        lte() { return query; }, order() { return query; }, range() { return query; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
        },
      };
      return query;
    },
    rpc() { return Promise.resolve({ data: [], error: null }); },
  } as unknown as SupabaseClient;
}

test("support equipment's repairs count in the company total, never in ownership or fuel analytics", async () => {
  const report = await getReportData(profileFixture(), filters, "farm-1");
  const pump = report.costPerMachine.find((r) => r.machineId === "pump");
  const truck = report.costPerMachine.find((r) => r.machineId === "truck");
  assert.ok(pump && truck);
  // The repair spend is there, labelled as equipment...
  assert.equal(pump.total, 120000);
  assert.equal(pump.equipment, true);
  // ...but no total cost of ownership or cost per hour is worked out for it.
  assert.equal(pump.tco, 0);
  assert.equal(pump.perHour, null);
  assert.equal(truck.tco, 50000);
  assert.equal(truck.equipment, false);
  assert.deepEqual(report.maintenanceByProfile, {
    full: { assets: 1, total: 1500 },
    equipment: { assets: 1, total: 120000 },
  });
  // Fuel: the pump's old draw is in the period total, not in the per-asset analysis.
  assert.equal(report.fuel.totalLitres, 80);
  assert.deepEqual(report.fuel.perMachine.map((r) => r.machineId), ["truck"]);
});