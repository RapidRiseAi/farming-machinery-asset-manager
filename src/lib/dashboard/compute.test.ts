import assert from "node:assert/strict";
import test from "node:test";
import { computeWidget, lastMonths, saDay, type BreakdownData, type KpiData, type ListData, type SeriesData } from "./compute";
import type { DashData, DashMachine } from "./data";

const NOW = new Date("2026-11-05T08:00:00Z");
const m = (id: string, status = "active", extra: Partial<DashMachine> = {}): DashMachine => ({
  id, name: id.toUpperCase(), status, meter_type: "hours", current_reading: 100, current_reading_date: "2026-11-01",
  warranty_expiry_date: null, warranty_expiry_hours: null, ...extra,
});
const base = (): DashData => ({
  now: NOW,
  machines: [m("a"), m("b"), m("c", "in_workshop"), m("old", "retired")],
  service: [], faults: [], jobCards: [], fuel: [], licences: [], fines: [],
});
const ctx = { locale: "en" as const, staleDays: 30 };
const run = <T,>(type: string, d: DashData, s = {}) => computeWidget(type, s, d, ctx) as T;
const fault = (id: string, machine: string, urgency: string, status: string, created: string) =>
  ({ id, machine_id: machine, description: `fault ${id}`, urgency, status, created_at: created });

test("the farm's day, not the server's: 23:30 UTC on 31 Oct is 1 Nov on the farm", () => {
  assert.equal(saDay("2026-10-31T23:30:00Z"), "2026-11-01");
  assert.deepEqual(lastMonths(NOW, 3, "en").map((x) => x.key), ["2026-09", "2026-10", "2026-11"]);
});

test("open problems: resolved ones and retired machines do not count; stopped ones are named", () => {
  const d = base();
  d.faults = [
    fault("1", "a", "stopped", "open", "2026-11-04T10:00:00Z"),
    fault("2", "a", "limping", "in_progress", "2026-10-01T10:00:00Z"),
    fault("3", "b", "can_work", "resolved", "2026-11-03T10:00:00Z"),
    fault("4", "old", "stopped", "open", "2026-11-03T10:00:00Z"),
  ];
  const k = run<KpiData>("open_problems", d);
  assert.equal(k.value, 2);
  assert.equal(k.tone, "bad");
  assert.equal(k.sub, "1 standing still");
  assert.equal(run<KpiData>("machines_with_problems", d).value, 1, "two problems on one machine is one machine");
  assert.equal(run<KpiData>("machines_stopped", d).value, 1);
  // New problems count every report in the window, resolved or not, on machines in use.
  assert.equal(run<KpiData>("new_problems", d, { days: "7" }).value, 2);
  assert.equal(run<KpiData>("new_problems", d, { days: "1" }).value, 0);
  const urgency = run<BreakdownData>("problems_by_urgency", d);
  assert.deepEqual(urgency.items.map((i) => [i.key, i.value, i.href]), [
    ["stopped", 1, "/faults?urgency=stopped"], ["limping", 1, "/faults?urgency=limping"], ["can_work", 0, "/faults?urgency=can_work"],
  ]);
  const latest = run<ListData>("latest_problems", d, { rows: "5" });
  assert.deepEqual(latest.rows.map((r) => r.key), ["1", "2"]);
});

test("a machine counts once, under its worst service", () => {
  const d = base();
  d.service = [
    { machine_id: "a", status: "ok", task: "oil", next_due_date: "2027-01-01" },
    { machine_id: "a", status: "overdue", task: "filters", next_due_date: "2026-10-01" },
    { machine_id: "b", status: "due_soon", task: "oil", next_due_date: "2026-11-20" },
    { machine_id: "old", status: "overdue", task: "oil", next_due_date: "2026-01-01" },
  ];
  assert.equal(run<KpiData>("service_overdue", d).value, 1);
  assert.equal(run<KpiData>("service_due", d).value, 2);
  const s = run<BreakdownData>("service_status", d);
  assert.deepEqual(s.items.map((i) => [i.key, i.value]), [["overdue", 1], ["due_soon", 1], ["ok", 0], ["none", 1]]);
});

test("spend this month against last, and the trend, from finished job cards on machines in use", () => {
  const d = base();
  const jc = (machine: string, date_out: string, cents: number) => ({ machine_id: machine, type: "repair", status: "completed", total_cents: cents, date_in: null, date_out });
  d.jobCards = [jc("a", "2026-11-02", 30_000), jc("b", "2026-10-15", 50_000), jc("old", "2026-11-03", 99_000)];
  const k = run<KpiData>("spend_month", d);
  assert.equal(k.value, 30_000);
  assert.deepEqual(k.delta && [k.delta.amount, k.delta.more, k.delta.tone], [20_000, false, "ok"]);
  assert.equal(run<KpiData>("spend_month", d, { compare: "off" }).delta, undefined);
  const s = run<SeriesData>("spend_trend", d, { months: "3" });
  assert.deepEqual(s.points.map((p) => p.value), [0, 50_000, 30_000]);
});

test("the costliest machines fold the rest into Other", () => {
  const d = base();
  d.machines = Array.from({ length: 8 }, (_, i) => m(`m${i}`));
  d.jobCards = d.machines.map((x, i) => ({ machine_id: x.id, type: "repair", status: "completed", total_cents: (i + 1) * 1000, date_in: null, date_out: "2026-10-10" }));
  const b = run<BreakdownData>("top_cost_machines", d, { rows: "5" });
  assert.deepEqual(b.items.map((i) => i.key), ["m7", "m6", "m5", "m4", "m3", "other"]);
  assert.equal(b.items.at(-1)!.value, 1000 + 2000 + 3000);
});

test("fuel counts draws without a machine (a farm tank) but not retired machines", () => {
  const d = base();
  const f = (machine: string | null, date: string, litres: number, flagged = false) =>
    ({ machine_id: machine, date, litres, cost_cents: litres * 2500, anomaly_notified_at: flagged ? "2026-11-01T00:00:00Z" : null });
  d.fuel = [f("a", "2026-11-01", 100), f(null, "2026-11-02", 50), f("old", "2026-11-02", 999), f("b", "2026-10-02", 400, true)];
  assert.equal(run<KpiData>("fuel_litres_month", d).value, 150);
  assert.equal(run<KpiData>("fuel_spend_month", d).value, 150 * 2500);
  assert.equal(run<KpiData>("fuel_flags", d).value, 1);
});

test("stale meters use the farm's own window, stalest first, and skip unmetered machines", () => {
  const d = base();
  d.machines = [
    m("fresh"), m("never", "active", { current_reading: null, current_reading_date: null }),
    m("stale", "active", { current_reading_date: "2026-08-01" }), m("trailer", "active", { meter_type: "none", current_reading_date: null }),
  ];
  assert.deepEqual(run<ListData>("stale_meters", d).rows.map((r) => r.key), ["never", "stale"]);
});

test("papers: expired before expiring, soonest first", () => {
  const d = base();
  d.licences = [
    { id: "l1", machine_id: "a", type: "licence_disc", expiry_date: "2026-11-20", reminder_lead_days: 30 },
    { id: "l2", machine_id: "b", type: "licence_disc", expiry_date: "2026-10-01", reminder_lead_days: 30 },
    { id: "l3", machine_id: "b", type: "licence_disc", expiry_date: "2027-06-01", reminder_lead_days: 30 },
  ];
  const l = run<ListData>("expiring_papers", d);
  assert.deepEqual(l.rows.map((r) => [r.key, r.badge?.tone]), [["l-l2", "danger"], ["l-l1", "warning"]]);
});
