import type { SupabaseClient } from "@supabase/supabase-js";

export type ReportFilters = { from: string | null; to: string | null; includeInactive: boolean };

export type CostRow = { machineId: string; name: string; parts: number; labour: number; other: number; total: number; perHour: number | null };
export type ReportData = {
  costPerMachine: CostRow[];
  byType: { type: string; total: number }[];
  compliance: { ok: number; dueSoon: number; overdue: number; overdueList: { name: string; task: string }[] };
  problems: { topParts: { name: string; count: number }[]; topFaults: { name: string; count: number }[] };
};

type Machine = { id: string; name: string; status: string; current_reading: number | null; meter_type: string };
type JC = { id: string; machine_id: string; type: string; parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number; date_out: string | null };

/** Parse report filters from URL search params. */
export function parseFilters(sp: { from?: string; to?: string; inactive?: string }): ReportFilters {
  const iso = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { from: iso(sp.from), to: iso(sp.to), includeInactive: sp.inactive === "1" };
}

const inRange = (d: string | null, f: ReportFilters) =>
  d != null && (f.from == null || d >= f.from) && (f.to == null || d <= f.to);

/** Fetch + aggregate all four report families under RLS (farm-scoped). Retired/sold
 *  machines are excluded unless `includeInactive` (Scope §4.1 / C8). */
export async function getReportData(supabase: SupabaseClient, f: ReportFilters): Promise<ReportData> {
  const [{ data: mData }, { data: jcData }, { data: partData }, { data: faultData }, { data: splData }] = await Promise.all([
    supabase.from("machines").select("id, name, status, current_reading, meter_type").is("deleted_at", null),
    supabase.from("job_cards").select("id, machine_id, type, parts_total_cents, labour_total_cents, other_total_cents, total_cents, date_out").is("deleted_at", null),
    supabase.from("job_card_lines").select("description, job_card_id").eq("kind", "part").is("deleted_at", null),
    supabase.from("faults").select("category, machine_id, created_at").is("deleted_at", null),
    supabase.from("service_plan_lines").select("machine_id, task, status").is("deleted_at", null),
  ]);

  const machines = (mData as Machine[] | null) ?? [];
  const allowed = new Set(machines.filter((m) => f.includeInactive || (m.status !== "retired" && m.status !== "sold")).map((m) => m.id));
  const mById = Object.fromEntries(machines.map((m) => [m.id, m]));
  const jcs = ((jcData as JC[] | null) ?? []).filter((j) => allowed.has(j.machine_id) && inRange(j.date_out, f));
  const jcById = Object.fromEntries(jcs.map((j) => [j.id, j]));

  // 1) Cost per machine
  const agg = new Map<string, { parts: number; labour: number; other: number; total: number }>();
  for (const j of jcs) {
    const a = agg.get(j.machine_id) ?? { parts: 0, labour: 0, other: 0, total: 0 };
    a.parts += j.parts_total_cents; a.labour += j.labour_total_cents; a.other += j.other_total_cents; a.total += j.total_cents;
    agg.set(j.machine_id, a);
  }
  const costPerMachine: CostRow[] = [...agg.entries()]
    .map(([id, a]) => {
      const m = mById[id];
      const perHour = m && m.meter_type === "hours" && m.current_reading ? Math.round(a.total / m.current_reading) : null;
      return { machineId: id, name: m?.name ?? "—", ...a, perHour };
    })
    .sort((x, y) => y.total - x.total);

  // 2) Spend by job type
  const typeMap = new Map<string, number>();
  for (const j of jcs) typeMap.set(j.type, (typeMap.get(j.type) ?? 0) + j.total_cents);
  const byType = [...typeMap.entries()].map(([type, total]) => ({ type, total })).sort((a, b) => b.total - a.total);

  // 3) Service compliance (status counts + overdue list, active machines)
  const compliance = { ok: 0, dueSoon: 0, overdue: 0, overdueList: [] as { name: string; task: string }[] };
  for (const l of (splData as { machine_id: string; task: string; status: string }[] | null) ?? []) {
    if (!allowed.has(l.machine_id)) continue;
    if (l.status === "overdue") { compliance.overdue++; compliance.overdueList.push({ name: mById[l.machine_id]?.name ?? "—", task: l.task }); }
    else if (l.status === "due_soon") compliance.dueSoon++;
    else compliance.ok++;
  }

  // 4) Recurring problems (top replaced parts + top fault categories, in range)
  const partMap = new Map<string, number>();
  for (const p of (partData as { description: string | null; job_card_id: string }[] | null) ?? []) {
    if (!jcById[p.job_card_id]) continue;
    const key = (p.description ?? "—").trim() || "—";
    partMap.set(key, (partMap.get(key) ?? 0) + 1);
  }
  const faultMap = new Map<string, number>();
  for (const ft of (faultData as { category: string | null; machine_id: string; created_at: string }[] | null) ?? []) {
    if (!allowed.has(ft.machine_id) || !inRange(ft.created_at.slice(0, 10), f)) continue;
    const key = (ft.category ?? "uncategorised").trim() || "uncategorised";
    faultMap.set(key, (faultMap.get(key) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  return { costPerMachine, byType, compliance, problems: { topParts: top(partMap), topFaults: top(faultMap) } };
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
