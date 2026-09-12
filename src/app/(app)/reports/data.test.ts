import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReportData, type ReportFilters } from "./data";

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
