import type { SupabaseClient } from "@supabase/supabase-js";
import { costPerMeter } from "@/lib/cost";

export type ReportFilters = { from: string | null; to: string | null; includeInactive: boolean; group: string | null };

export type CostRow = {
  machineId: string; name: string;
  parts: number; labour: number; other: number; total: number;
  tco: number; perHour: number | null; perKm: number | null; meterType: string;
};
export type ReportData = {
  costPerMachine: CostRow[];
  byType: { type: string; total: number }[];
  compliance: { ok: number; dueSoon: number; overdue: number; overdueList: { name: string; task: string }[] };
  problems: {
    topParts: { name: string; count: number }[];
    topFaults: { name: string; count: number }[];
    breaksMostOften: { name: string; count: number }[];
  };
  groups: string[];
};

type Machine = { id: string; name: string; status: string; current_reading: number | null; meter_type: string; location: string | null };
type JC = { id: string; machine_id: string; type: string; parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number; date_out: string | null };
type Cost = { machine_id: string | null; amount_cents: number | null };

/** Parse report filters from URL search params. */
export function parseFilters(sp: { from?: string; to?: string; inactive?: string; group?: string }): ReportFilters {
  const iso = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const group = (sp.group ?? "").trim();
  return { from: iso(sp.from), to: iso(sp.to), includeInactive: sp.inactive === "1", group: group === "" ? null : group };
}

const inRange = (d: string | null, f: ReportFilters) =>
  d != null && (f.from == null || d >= f.from) && (f.to == null || d <= f.to);

/** Fetch + aggregate all report families under RLS (farm-scoped). Retired/sold machines
 *  are excluded unless `includeInactive` (Scope §4.1 / C8). An optional per-site/group
 *  filter narrows to machines whose location matches (FR-11.3; graceful until multi-site
 *  ships in F7). TCO = every non-deleted cost_entry per asset (purchase + finance + fuel +
 *  parts + labour + invoices + other); cost-per-hour / cost-per-km use lifetime TCO ÷
 *  lifetime meter (fixes D-2), identical to the machine-detail page. */
export async function getReportData(supabase: SupabaseClient, f: ReportFilters): Promise<ReportData> {
  const [{ data: mData }, { data: jcData }, { data: partData }, { data: faultData }, { data: splData }, { data: costData }] = await Promise.all([
    supabase.from("machines").select("id, name, status, current_reading, meter_type, location").is("deleted_at", null),
    supabase.from("job_cards").select("id, machine_id, type, parts_total_cents, labour_total_cents, other_total_cents, total_cents, date_out").is("deleted_at", null),
    supabase.from("job_card_lines").select("description, job_card_id").eq("kind", "part").is("deleted_at", null),
    supabase.from("faults").select("category, machine_id, created_at").is("deleted_at", null),
    supabase.from("service_plan_lines").select("machine_id, task, status").is("deleted_at", null),
    supabase.from("cost_entries").select("machine_id, amount_cents").is("deleted_at", null),
  ]);

  const machines = (mData as Machine[] | null) ?? [];
  const activeFilter = (m: Machine) => f.includeInactive || (m.status !== "retired" && m.status !== "sold");
  const groupFilter = (m: Machine) => f.group == null || (m.location ?? "") === f.group;
  const allowed = new Set(machines.filter((m) => activeFilter(m) && groupFilter(m)).map((m) => m.id));
  const mById = Object.fromEntries(machines.map((m) => [m.id, m]));
  const groups = [...new Set(machines.map((m) => (m.location ?? "").trim()).filter((l) => l !== ""))].sort();
  const jcs = ((jcData as JC[] | null) ?? []).filter((j) => allowed.has(j.machine_id) && inRange(j.date_out, f));
  const jcById = Object.fromEntries(jcs.map((j) => [j.id, j]));

  // Lifetime TCO per machine (all cost types; not period-filtered — TCO is a lifetime metric).
  const tcoByMachine = new Map<string, number>();
  for (const c of (costData as Cost[] | null) ?? []) {
    if (c.machine_id == null || !allowed.has(c.machine_id)) continue;
    tcoByMachine.set(c.machine_id, (tcoByMachine.get(c.machine_id) ?? 0) + (c.amount_cents ?? 0));
  }

  // 1) Cost per machine — period maintenance spend columns + lifetime TCO + per-hour/km.
  const agg = new Map<string, { parts: number; labour: number; other: number; total: number }>();
  for (const j of jcs) {
    const a = agg.get(j.machine_id) ?? { parts: 0, labour: 0, other: 0, total: 0 };
    a.parts += j.parts_total_cents; a.labour += j.labour_total_cents; a.other += j.other_total_cents; a.total += j.total_cents;
    agg.set(j.machine_id, a);
  }
  const costPerMachine: CostRow[] = [...allowed]
    .map((id) => {
      const m = mById[id];
      const a = agg.get(id) ?? { parts: 0, labour: 0, other: 0, total: 0 };
      const tco = tcoByMachine.get(id) ?? 0;
      const reading = m?.current_reading ?? null;
      const perHour = m?.meter_type === "hours" ? costPerMeter(tco, reading) : null;
      const perKm = m?.meter_type === "km" ? costPerMeter(tco, reading) : null;
      return { machineId: id, name: m?.name ?? "—", ...a, tco, perHour, perKm, meterType: m?.meter_type ?? "none" };
    })
    .filter((r) => r.tco > 0 || r.total > 0)
    .sort((x, y) => y.tco - x.tco || y.total - x.total);

  // 2) Spend by job type (period).
  const typeMap = new Map<string, number>();
  for (const j of jcs) typeMap.set(j.type, (typeMap.get(j.type) ?? 0) + j.total_cents);
  const byType = [...typeMap.entries()].map(([type, total]) => ({ type, total })).sort((a, b) => b.total - a.total);

  // 3) Service compliance (status counts + overdue list, active machines).
  const compliance = { ok: 0, dueSoon: 0, overdue: 0, overdueList: [] as { name: string; task: string }[] };
  for (const l of (splData as { machine_id: string; task: string; status: string }[] | null) ?? []) {
    if (!allowed.has(l.machine_id)) continue;
    if (l.status === "overdue") { compliance.overdue++; compliance.overdueList.push({ name: mById[l.machine_id]?.name ?? "—", task: l.task }); }
    else if (l.status === "due_soon") compliance.dueSoon++;
    else compliance.ok++;
  }

  // 4) Recurring problems: top replaced parts + top fault categories + per-machine
  //    "breaks most often" (repeat repair job cards + faults per machine — FR-11.2).
  const partMap = new Map<string, number>();
  for (const p of (partData as { description: string | null; job_card_id: string }[] | null) ?? []) {
    if (!jcById[p.job_card_id]) continue;
    const key = (p.description ?? "—").trim() || "—";
    partMap.set(key, (partMap.get(key) ?? 0) + 1);
  }
  const breakMap = new Map<string, number>();
  for (const j of jcs) if (j.type === "repair") breakMap.set(j.machine_id, (breakMap.get(j.machine_id) ?? 0) + 1);
  const faultMap = new Map<string, number>();
  for (const ft of (faultData as { category: string | null; machine_id: string; created_at: string }[] | null) ?? []) {
    if (!allowed.has(ft.machine_id) || !inRange(ft.created_at.slice(0, 10), f)) continue;
    const key = (ft.category ?? "uncategorised").trim() || "uncategorised";
    faultMap.set(key, (faultMap.get(key) ?? 0) + 1);
    breakMap.set(ft.machine_id, (breakMap.get(ft.machine_id) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  const breaksMostOften = [...breakMap.entries()]
    .map(([id, count]) => ({ name: mById[id]?.name ?? "—", count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { costPerMachine, byType, compliance, problems: { topParts: top(partMap), topFaults: top(faultMap), breaksMostOften }, groups };
}

/** Serialise a grid to RFC-4180 CSV (quoted fields, CRLF). */
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const centsToR = (c: number) => (c / 100).toFixed(2);
