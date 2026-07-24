import type { SupabaseClient } from "@supabase/supabase-js";
import { costPerMeter } from "@/lib/cost";
import { computeConsumption, type FuelIssueRow } from "@/lib/fuel";

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
  fuel: {
    perMachine: { machineId: string; name: string; meterType: string; litres: number; spend: number; consumption: number | null }[];
    totalLitres: number;
    totalSpend: number;
    purchasedLitres: number;
    purchasedSpend: number;
  };
  contractors: {
    outstandingQuotes: { count: number; value: number };
    outstandingInvoices: { count: number; value: number };
    byStatus: { status: string; count: number }[];
    responsiveness: { requestedToViewedHrs: number | null; viewedToQuotedHrs: number | null; sample: number };
    spendViaContractors: number;
    perContractor: { workshopId: string; name: string; requests: number; quoted: number; invoiced: number; spend: number }[];
  };
  groups: string[];
};

type Machine = { id: string; name: string; status: string; current_reading: number | null; meter_type: string; location: string | null };
type JC = { id: string; machine_id: string; type: string; parts_total_cents: number; labour_total_cents: number; other_total_cents: number; total_cents: number; date_out: string | null };
type Cost = { machine_id: string | null; amount_cents: number | null; type: string; occurred_on: string | null };
type WR = { id: string; machine_id: string; workshop_id: string | null; status: string; quote_amount_cents: number | null; invoice_amount_cents: number | null; created_at: string };
type WRE = { work_request_id: string; to_status: string; created_at: string };

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
  const [{ data: mData }, { data: jcData }, { data: partData }, { data: faultData }, { data: splData }, { data: costData }, { data: fuelData }, { data: delData }, { data: wrData }, { data: wreData }, { data: wsData }] = await Promise.all([
    supabase.from("machines").select("id, name, status, current_reading, meter_type, location").is("deleted_at", null),
    supabase.from("job_cards").select("id, machine_id, type, parts_total_cents, labour_total_cents, other_total_cents, total_cents, date_out").is("deleted_at", null),
    supabase.from("job_card_lines").select("description, job_card_id").eq("kind", "part").is("deleted_at", null),
    supabase.from("faults").select("category, machine_id, created_at").is("deleted_at", null),
    supabase.from("service_plan_lines").select("machine_id, task, status").is("deleted_at", null),
    supabase.from("cost_entries").select("machine_id, amount_cents, type, occurred_on").is("deleted_at", null),
    supabase.from("fuel_issues").select("id, machine_id, date, litres, meter_reading, cost_cents").is("deleted_at", null),
    supabase.from("fuel_deliveries").select("date, litres, price_per_l_cents").is("deleted_at", null),
    supabase.from("work_requests").select("id, machine_id, workshop_id, status, quote_amount_cents, invoice_amount_cents, created_at").is("deleted_at", null),
    supabase.from("work_request_events").select("work_request_id, to_status, created_at").is("deleted_at", null),
    supabase.from("workshops").select("id, name"),
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

  // 5) Fuel — period litres/spend per machine (draws) + lifetime consumption; plus the
  //    farm-level purchased totals (deliveries). Farm-level draws (machine_id null) are
  //    counted in totals but not in the per-machine table.
  type FI = { id: string; machine_id: string | null; date: string; litres: number | null; meter_reading: number | null; cost_cents: number | null };
  const fuelIssues = ((fuelData as FI[] | null) ?? []).filter((i) => i.machine_id == null || allowed.has(i.machine_id));
  const allIssuesByMachine = new Map<string, FuelIssueRow[]>();
  const periodByMachine = new Map<string, { litres: number; spend: number }>();
  let totalLitres = 0;
  let totalSpend = 0;
  for (const i of fuelIssues) {
    const inP = inRange(i.date, f);
    if (inP) { totalLitres += i.litres ?? 0; totalSpend += i.cost_cents ?? 0; }
    if (i.machine_id == null) continue;
    const all = allIssuesByMachine.get(i.machine_id) ?? [];
    all.push({ id: i.id, date: i.date, litres: i.litres, meter_reading: i.meter_reading, cost_cents: i.cost_cents });
    allIssuesByMachine.set(i.machine_id, all);
    if (inP) {
      const p = periodByMachine.get(i.machine_id) ?? { litres: 0, spend: 0 };
      p.litres += i.litres ?? 0; p.spend += i.cost_cents ?? 0;
      periodByMachine.set(i.machine_id, p);
    }
  }
  const fuelPerMachine = [...allIssuesByMachine.entries()]
    .map(([id, rows]) => {
      const m = mById[id];
      const p = periodByMachine.get(id) ?? { litres: 0, spend: 0 };
      const c = computeConsumption(rows, m?.meter_type ?? "none");
      return { machineId: id, name: m?.name ?? "—", meterType: m?.meter_type ?? "none", litres: p.litres, spend: p.spend, consumption: c.display };
    })
    .filter((r) => r.litres > 0 || r.spend > 0)
    .sort((a, b) => b.spend - a.spend || b.litres - a.litres);

  let purchasedLitres = 0;
  let purchasedSpend = 0;
  for (const d of (delData as { date: string; litres: number | null; price_per_l_cents: number | null }[] | null) ?? []) {
    if (!inRange(d.date, f)) continue;
    purchasedLitres += d.litres ?? 0;
    purchasedSpend += Math.round((d.litres ?? 0) * (d.price_per_l_cents ?? 0));
  }

  // 6) Contractor analytics (F13) — outstanding quote/invoice value, work-request
  //    throughput, contractor responsiveness (requested→viewed→quoted from the event
  //    log), and spend via contractors (cost_entries type=invoice, period-filtered).
  //    Farm-scoped by RLS; retired/sold machines excluded via `allowed`.
  const wrs = ((wrData as WR[] | null) ?? []).filter((w) => allowed.has(w.machine_id));
  const wrAllowedIds = new Set(wrs.map((w) => w.id));
  const wsName = Object.fromEntries(((wsData as { id: string; name: string }[] | null) ?? []).map((w) => [w.id, w.name]));

  const outstandingQuotes = { count: 0, value: 0 };
  const outstandingInvoices = { count: 0, value: 0 };
  const statusMap = new Map<string, number>();
  const perContractorMap = new Map<string, { requests: number; quoted: number; invoiced: number; spend: number }>();
  const ensureWs = (id: string) => {
    const cur = perContractorMap.get(id) ?? { requests: 0, quoted: 0, invoiced: 0, spend: 0 };
    perContractorMap.set(id, cur);
    return cur;
  };
  for (const w of wrs) {
    statusMap.set(w.status, (statusMap.get(w.status) ?? 0) + 1);
    if (w.status === "quoted") { outstandingQuotes.count++; outstandingQuotes.value += w.quote_amount_cents ?? 0; }
    if (w.status === "invoiced") { outstandingInvoices.count++; outstandingInvoices.value += w.invoice_amount_cents ?? 0; }
    if (w.workshop_id) {
      const c = ensureWs(w.workshop_id);
      c.requests++;
      if (w.quote_amount_cents != null) c.quoted++;
      if (w.invoice_amount_cents != null) c.invoiced++;
    }
  }
  const byStatus = [...statusMap.entries()].map(([status, count]) => ({ status, count }));

  // Responsiveness: per request, requested (created_at) → first 'viewed' → first 'quoted'.
  const firstEvent = new Map<string, { viewed?: string; quoted?: string }>();
  for (const e of (wreData as WRE[] | null) ?? []) {
    if (!wrAllowedIds.has(e.work_request_id)) continue;
    if (e.to_status !== "viewed" && e.to_status !== "quoted") continue;
    const cur = firstEvent.get(e.work_request_id) ?? {};
    const slot = e.to_status as "viewed" | "quoted";
    if (!cur[slot] || e.created_at < cur[slot]!) cur[slot] = e.created_at;
    firstEvent.set(e.work_request_id, cur);
  }
  const HOUR = 3600 * 1000;
  let rtvSum = 0, rtvN = 0, vtqSum = 0, vtqN = 0, sample = 0;
  const createdById = new Map(wrs.map((w) => [w.id, w.created_at]));
  for (const [id, ev] of firstEvent.entries()) {
    const created = createdById.get(id);
    if (created && ev.viewed) { rtvSum += (new Date(ev.viewed).getTime() - new Date(created).getTime()) / HOUR; rtvN++; }
    if (ev.viewed && ev.quoted) { vtqSum += (new Date(ev.quoted).getTime() - new Date(ev.viewed).getTime()) / HOUR; vtqN++; }
    if (ev.viewed || ev.quoted) sample++;
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;

  // Spend via contractors — the invoice cost entries (the F1 invoice→cost path), in range.
  let spendViaContractors = 0;
  for (const c of (costData as Cost[] | null) ?? []) {
    if (c.type !== "invoice" || c.machine_id == null || !allowed.has(c.machine_id)) continue;
    if (!inRange(c.occurred_on, f)) continue;
    spendViaContractors += c.amount_cents ?? 0;
  }
  // Attribute invoice spend to contractors via their invoiced requests (best-effort split
  // when a machine has one contractor; otherwise counted in the total above).
  for (const w of wrs) {
    if (w.workshop_id && w.invoice_amount_cents != null && (w.status === "invoiced" || w.status === "closed")) {
      ensureWs(w.workshop_id).spend += w.invoice_amount_cents;
    }
  }
  const perContractor = [...perContractorMap.entries()]
    .map(([workshopId, v]) => ({ workshopId, name: wsName[workshopId] ?? "—", ...v }))
    .sort((a, b) => b.spend - a.spend || b.requests - a.requests);

  return {
    costPerMachine, byType, compliance,
    problems: { topParts: top(partMap), topFaults: top(faultMap), breaksMostOften },
    fuel: { perMachine: fuelPerMachine, totalLitres, totalSpend, purchasedLitres, purchasedSpend },
    contractors: {
      outstandingQuotes, outstandingInvoices, byStatus,
      responsiveness: {
        requestedToViewedHrs: rtvN ? round1(rtvSum / rtvN) : null,
        viewedToQuotedHrs: vtqN ? round1(vtqSum / vtqN) : null,
        sample,
      },
      spendViaContractors, perContractor,
    },
    groups,
  };
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
