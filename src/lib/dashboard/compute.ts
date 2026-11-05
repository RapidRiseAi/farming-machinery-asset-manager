/**
 * Rows in, what a widget shows out. Pure, so each number can be tested against the rule
 * it claims (`compute.test.ts`); text is translated here, money stays in cents until it
 * is drawn.
 *
 * The same rules as the screens the widgets link to: retired and sold machines drop out
 * of every count, a problem is open until it is resolved, a service line's state is the
 * one the database keeps.
 */
import { t, type Lang } from "@/lib/i18n";
import { meterReading, relativeDate, shortDate, daysAgo } from "@/lib/format";
import { shortMonth } from "@/lib/month-names";
import { dateExpiryStatus, licenceTypeLabel, warrantyStatus } from "@/lib/compliance";
import type { BadgeTone } from "@/components/ui/badge";
import type { DashData, DashMachine } from "./data";
import type { WidgetSettings } from "./layout";
import type { StatusKey } from "./palettes";
import { WIDGET_BY_TYPE, setting } from "./widgets";

export type Tone = "ok" | "warn" | "bad" | "neutral";
export type ValueFormat = "count" | "rands" | "litres";

/** A change against last month, said in words by the renderer ("R1 200 more than Oct"). */
export type KpiDelta = { amount: number; more: boolean; month: string; tone: Tone };
/** `trend`: the same measure over earlier periods, oldest first, for a sparkline. */
export type KpiData = { kind: "kpi"; value: number; format: ValueFormat; tone: Tone; sub?: string; delta?: KpiDelta; trend?: number[] };
export type SeriesPoint = { key: string; label: string; value: number };
export type SeriesData = { kind: "series"; points: SeriesPoint[]; format: ValueFormat };
export type BreakdownItem = { key: string; label: string; value: number; status?: StatusKey; href?: string };
export type BreakdownData = { kind: "breakdown"; items: BreakdownItem[]; format: ValueFormat; statusColoured: boolean };
export type ListRow = { key: string; title: string; sub: string; href: string; badge?: { label: string; tone: BadgeTone } };
export type ListData = { kind: "list"; rows: ListRow[]; more: number; empty: string };
export type WidgetData = KpiData | SeriesData | BreakdownData | ListData;

export type ComputeContext = { locale: Lang; staleDays: number };

const OPEN_JOB = new Set(["reported", "open", "in_progress", "waiting_parts"]);
const URGENCY_ORDER = ["stopped", "limping", "can_work"] as const;
const URGENCY_STATUS: Record<string, StatusKey> = { stopped: "bad", limping: "warn", can_work: "ok" };
const URGENCY_TONE: Record<string, BadgeTone> = { stopped: "danger", limping: "warning", can_work: "neutral" };

/** The farm's calendar day for a timestamp: South Africa is UTC+2 all year. */
export const saDay = (ts: string) => new Date(Date.parse(ts) + 2 * 3_600_000).toISOString().slice(0, 10);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The start of a window of `days` farm days ending today (1 = today alone): the day, and
 * the instant it began on the farm. /faults?since= filters with the same function, so the
 * widget and the list it links to can never disagree about where "the last 7 days" starts.
 */
export function windowStart(now: Date, days: number): { day: string; iso: string } {
  const day = saDay(new Date(now.getTime() - (days - 1) * 86_400_000).toISOString());
  return { day, iso: new Date(`${day}T00:00:00+02:00`).toISOString() };
}

/** The last `n` months, oldest first, ending with this one, as YYYY-MM keys with labels. */
export function lastMonths(now: Date, n: number, locale: Lang): { key: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 15));
    return { key: d.toISOString().slice(0, 7), label: shortMonth(d, locale) };
  });
}

function activeMachines(d: DashData): { active: DashMachine[]; ids: Set<string>; name: Map<string, string> } {
  const active = d.machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  return { active, ids: new Set(active.map((m) => m.id)), name: new Map(d.machines.map((m) => [m.id, m.name])) };
}

const count = (n: number, one: string, many: string, locale: Lang) =>
  (n === 1 ? t(one, locale) : t(many, locale)).replace("{n}", String(n));

/** This month against last, or nothing when there is nothing to compare with. */
function monthDelta(thisMonth: number, lastMonth: number, now: Date, locale: Lang, moreIsBad: boolean): KpiDelta | undefined {
  if (lastMonth === 0 || thisMonth === lastMonth) return undefined;
  const more = thisMonth > lastMonth;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return { amount: Math.abs(thisMonth - lastMonth), more, month: shortMonth(prev, locale), tone: more === moreIsBad ? "bad" : "ok" };
}

/** Sum (day, amount) pairs into the given months, oldest first. */
function perMonth(months: { key: string }[], rows: [string, number][]): number[] {
  const sums = new Map<string, number>();
  for (const [day, v] of rows) sums.set(day.slice(0, 7), (sums.get(day.slice(0, 7)) ?? 0) + v);
  return months.map((m) => sums.get(m.key) ?? 0);
}

/** Machines and their worst service state: overdue, then due soon, then fine; none = no plan. */
function worstService(d: DashData, ids: Set<string>): Map<string, "overdue" | "due_soon" | "ok"> {
  const rank = { overdue: 2, due_soon: 1, ok: 0 } as const;
  const worst = new Map<string, "overdue" | "due_soon" | "ok">();
  for (const l of d.service) {
    if (!ids.has(l.machine_id) || !(l.status in rank)) continue;
    const s = l.status as keyof typeof rank;
    const cur = worst.get(l.machine_id);
    if (!cur || rank[s] > rank[cur]) worst.set(l.machine_id, s);
  }
  return worst;
}

export function computeWidget(type: string, s: WidgetSettings, d: DashData, ctx: ComputeContext): WidgetData | null {
  const def = WIDGET_BY_TYPE.get(type);
  if (!def) return null;
  const { locale } = ctx;
  const opt = (key: string) => setting(def, s, key);
  const { active, ids, name } = activeMachines(d);
  const now = d.now;
  const today = saDay(now.toISOString());
  const thisMonth = today.slice(0, 7);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
  const openFaults = d.faults.filter((f) => f.status !== "resolved" && ids.has(f.machine_id));
  const rows = Number(opt("rows")) || 5;
  const months = Number(opt("months")) || 6;

  switch (type) {
    // == Problems ==============================================================
    case "open_problems": {
      const stopped = openFaults.filter((f) => f.urgency === "stopped").length;
      return {
        kind: "kpi", value: openFaults.length, format: "count",
        tone: stopped > 0 ? "bad" : openFaults.length > 0 ? "warn" : "ok",
        sub: stopped > 0 ? count(stopped, "dash.sub.stoppedOne", "dash.sub.stoppedMany", locale) : t("dash.sub.noneStopped", locale),
        trend: perMonth(lastMonths(now, 6, locale), d.faults.filter((f) => ids.has(f.machine_id)).map((f) => [saDay(f.created_at), 1])),
      };
    }
    case "new_problems": {
      const days = Number(opt("days"));
      const from = windowStart(now, days).day;
      const n = d.faults.filter((f) => ids.has(f.machine_id) && saDay(f.created_at) >= from).length;
      const trend = Array.from({ length: 8 }, (_, i) => {
        const end = new Date(now.getTime() - (7 - i) * days * 86_400_000);
        const start = windowStart(end, days).day;
        const stop = saDay(end.toISOString());
        return d.faults.filter((f) => ids.has(f.machine_id) && saDay(f.created_at) >= start && saDay(f.created_at) <= stop).length;
      });
      return { kind: "kpi", value: n, format: "count", tone: n > 0 ? "warn" : "ok", sub: t(`dash.sub.days${days}`, locale), trend };
    }
    case "machines_with_problems": {
      const n = new Set(openFaults.map((f) => f.machine_id)).size;
      return { kind: "kpi", value: n, format: "count", tone: n > 0 ? "warn" : "ok", sub: t("dash.sub.ofMachines", locale).replace("{n}", String(active.length)) };
    }
    case "machines_stopped": {
      const n = new Set(openFaults.filter((f) => f.urgency === "stopped").map((f) => f.machine_id)).size;
      return { kind: "kpi", value: n, format: "count", tone: n > 0 ? "bad" : "ok", sub: t(n > 0 ? "dash.sub.standingStill" : "dash.sub.allWorking", locale) };
    }
    case "problems_trend": {
      const buckets = lastMonths(now, months, locale);
      const per = new Map<string, number>();
      for (const f of d.faults) if (ids.has(f.machine_id)) per.set(saDay(f.created_at).slice(0, 7), (per.get(saDay(f.created_at).slice(0, 7)) ?? 0) + 1);
      return { kind: "series", format: "count", points: buckets.map((b) => ({ ...b, value: per.get(b.key) ?? 0 })) };
    }
    case "problems_by_urgency": {
      return {
        kind: "breakdown", format: "count", statusColoured: true,
        items: URGENCY_ORDER.map((u) => ({
          key: u, label: t(`urgency.${u}`, locale), value: openFaults.filter((f) => (f.urgency ?? "can_work") === u).length,
          status: URGENCY_STATUS[u], href: `/faults?urgency=${u}`,
        })),
      };
    }
    case "latest_problems": {
      const list = openFaults.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
      return {
        kind: "list", more: Math.max(0, list.length - rows), empty: t("dash.empty.problems", locale),
        rows: list.slice(0, rows).map((f) => ({
          key: f.id, title: name.get(f.machine_id) ?? "-",
          sub: `${(f.description ?? "").trim() || t(`urgency.${f.urgency ?? "can_work"}`, locale)} · ${relativeDate(f.created_at, locale, now)}`,
          href: `/faults#fault-${f.id}`,
          badge: { label: t(`urgency.${f.urgency ?? "can_work"}`, locale), tone: URGENCY_TONE[f.urgency ?? "can_work"] ?? "neutral" },
        })),
      };
    }

    // == Servicing =============================================================
    case "service_overdue":
    case "service_due": {
      const worst = worstService(d, ids);
      const hit = (w: string) => (type === "service_overdue" ? w === "overdue" : w === "overdue" || w === "due_soon");
      const machines = [...worst.values()].filter(hit).length;
      const tasks = d.service.filter((l) => ids.has(l.machine_id) && hit(l.status)).length;
      return {
        kind: "kpi", value: machines, format: "count",
        tone: machines === 0 ? "ok" : type === "service_overdue" ? "bad" : "warn",
        sub: count(tasks, "dash.sub.taskOne", "dash.sub.taskMany", locale),
      };
    }
    case "service_status": {
      const worst = worstService(d, ids);
      const n = (s: string) => active.filter((m) => (worst.get(m.id) ?? "none") === s).length;
      return {
        kind: "breakdown", format: "count", statusColoured: true,
        items: [
          { key: "overdue", label: t("ui.statusOverdue", locale), value: n("overdue"), status: "bad", href: "/machines?service=overdue" },
          { key: "due_soon", label: t("ui.statusDueSoon", locale), value: n("due_soon"), status: "warn", href: "/machines?service=due" },
          { key: "ok", label: t("ui.statusOk", locale), value: n("ok"), status: "ok", href: "/machines?sort=attention" },
          { key: "none", label: t("dash.noPlan", locale), value: n("none"), status: "neutral", href: "/machines?service=none" },
        ],
      };
    }
    case "upcoming_services": {
      const lines = d.service
        .filter((l) => ids.has(l.machine_id) && l.next_due_date && (l.status === "overdue" || l.status === "due_soon" || l.status === "ok"))
        .sort((a, b) => (a.next_due_date ?? "").localeCompare(b.next_due_date ?? ""));
      return {
        kind: "list", more: Math.max(0, lines.length - rows), empty: t("dash.empty.services", locale),
        rows: lines.slice(0, rows).map((l, i) => ({
          key: `${l.machine_id}-${i}`, title: name.get(l.machine_id) ?? "-",
          sub: `${l.task} · ${shortDate(l.next_due_date, locale)}`,
          href: `/machines/${l.machine_id}?tab=servicing`,
          badge: {
            label: t(l.status === "overdue" ? "ui.statusOverdue" : l.status === "due_soon" ? "ui.statusDueSoon" : "ui.statusOk", locale),
            tone: l.status === "overdue" ? "danger" : l.status === "due_soon" ? "warning" : "ok",
          },
        })),
      };
    }
    case "stale_meters": {
      const cut = ymd(new Date(now.getTime() - ctx.staleDays * 86_400_000));
      const stale = active
        .filter((m) => m.meter_type !== "none" && (!m.current_reading_date || m.current_reading_date < cut))
        .sort((a, b) => (a.current_reading_date ?? "").localeCompare(b.current_reading_date ?? "") || a.name.localeCompare(b.name));
      return {
        kind: "list", more: Math.max(0, stale.length - rows), empty: t("dash.empty.stale", locale),
        rows: stale.slice(0, rows).map((m) => ({
          key: m.id, title: m.name, href: `/machines/${m.id}`,
          sub: m.current_reading != null && m.current_reading_date
            ? `${meterReading(m.current_reading, m.meter_type, locale)} · ${shortDate(m.current_reading_date, locale)}`
            : t("dashboard.noReadingYet", locale),
        })),
      };
    }

    // == Fleet =================================================================
    case "fleet_size": {
      const working = active.filter((m) => m.status === "active").length;
      return { kind: "kpi", value: active.length, format: "count", tone: "neutral", sub: t("dash.sub.working", locale).replace("{n}", String(working)) };
    }
    case "fleet_status": {
      const st: [string, StatusKey][] = [["active", "ok"], ["standby", "neutral"], ["in_workshop", "warn"], ["out_of_service", "bad"]];
      return {
        kind: "breakdown", format: "count", statusColoured: true,
        items: st.map(([k, status]) => ({
          key: k, label: t(`machineStatus.${k}`, locale), value: active.filter((m) => m.status === k).length, status, href: `/machines?status=${k}`,
        })),
      };
    }
    case "in_workshop": {
      const earliest = new Map<string, string>();
      for (const j of d.jobCards) {
        if (!OPEN_JOB.has(j.status) || !j.date_in) continue;
        const cur = earliest.get(j.machine_id);
        if (!cur || j.date_in < cur) earliest.set(j.machine_id, j.date_in);
      }
      const list = active.filter((m) => m.status === "in_workshop");
      return {
        kind: "list", more: Math.max(0, list.length - rows), empty: t("dash.empty.workshop", locale),
        rows: list.slice(0, rows).map((m) => {
          const since = earliest.get(m.id);
          const days = since ? Math.max(0, daysAgo(since, now) ?? 0) : null;
          return {
            key: m.id, title: m.name, href: `/machines/${m.id}`,
            sub: days == null ? t("machineStatus.in_workshop", locale) : t("dash.sub.inForDays", locale).replace("{n}", String(days)),
          };
        }),
      };
    }
    case "open_job_cards": {
      const open = d.jobCards.filter((j) => OPEN_JOB.has(j.status) && ids.has(j.machine_id));
      const parts = open.filter((j) => j.status === "waiting_parts").length;
      return {
        kind: "kpi", value: open.length, format: "count", tone: open.length > 0 ? "neutral" : "ok",
        sub: parts > 0 ? t("dash.sub.waitingParts", locale).replace("{n}", String(parts)) : t("dash.sub.noneWaiting", locale),
      };
    }
    case "job_cards_by_status": {
      const open = d.jobCards.filter((j) => OPEN_JOB.has(j.status) && ids.has(j.machine_id));
      return {
        kind: "breakdown", format: "count", statusColoured: false,
        items: [...OPEN_JOB].map((st) => ({
          key: st, label: t(`jobStatus.${st}`, locale), value: open.filter((j) => j.status === st).length, href: `/jobcards?status=${st}`,
        })),
      };
    }

    // == Costs =================================================================
    case "spend_month": {
      const sum = (m: string) => d.jobCards.filter((j) => ids.has(j.machine_id) && j.date_out?.startsWith(m)).reduce((a, j) => a + (j.total_cents ?? 0), 0);
      const a = sum(thisMonth);
      const b = sum(lastMonth);
      return {
        kind: "kpi", value: a, format: "rands", tone: "neutral", sub: t("dashboard.thisMonth", locale),
        delta: opt("compare") === "on" ? monthDelta(a, b, now, locale, true) : undefined,
        trend: perMonth(lastMonths(now, 6, locale), d.jobCards.filter((j) => ids.has(j.machine_id) && j.date_out).map((j) => [j.date_out!, j.total_cents ?? 0])),
      };
    }
    case "spend_trend": {
      const buckets = lastMonths(now, months, locale);
      const per = new Map<string, number>();
      for (const j of d.jobCards) if (ids.has(j.machine_id) && j.date_out) per.set(j.date_out.slice(0, 7), (per.get(j.date_out.slice(0, 7)) ?? 0) + (j.total_cents ?? 0));
      return { kind: "series", format: "rands", points: buckets.map((b) => ({ ...b, value: per.get(b.key) ?? 0 })) };
    }
    case "spend_by_type":
    case "top_cost_machines": {
      const from = lastMonths(now, months, locale)[0].key;
      const per = new Map<string, number>();
      for (const j of d.jobCards) {
        if (!ids.has(j.machine_id) || !j.date_out || j.date_out.slice(0, 7) < from) continue;
        const key = type === "spend_by_type" ? j.type : j.machine_id;
        per.set(key, (per.get(key) ?? 0) + (j.total_cents ?? 0));
      }
      let items: BreakdownItem[] = [...per.entries()]
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({
          key: k, value: v,
          label: type === "spend_by_type" ? t(`jobType.${k}`, locale) : (name.get(k) ?? "-"),
          href: type === "spend_by_type" ? "/reports?tab=costs&period=thisYear" : `/machines/${k}?tab=costs`,
        }))
        .sort((a, b) => b.value - a.value);
      const cap = type === "top_cost_machines" ? rows : 5;
      if (items.length > cap) {
        const rest = items.slice(cap).reduce((a, i) => a + i.value, 0);
        items = [...items.slice(0, cap), { key: "other", label: t("dash.other", locale), value: rest }];
      }
      return { kind: "breakdown", format: "rands", statusColoured: false, items };
    }

    // == Fuel ==================================================================
    case "fuel_litres_month":
    case "fuel_spend_month": {
      const money = type === "fuel_spend_month";
      const pick = (f: DashData["fuel"][number]) => (money ? (f.cost_cents ?? 0) : (f.litres ?? 0));
      const inFleet = (f: DashData["fuel"][number]) => f.machine_id == null || ids.has(f.machine_id);
      const a = d.fuel.filter((f) => inFleet(f) && f.date.startsWith(thisMonth)).reduce((x, f) => x + pick(f), 0);
      const b = d.fuel.filter((f) => inFleet(f) && f.date.startsWith(lastMonth)).reduce((x, f) => x + pick(f), 0);
      return {
        kind: "kpi", value: a, format: money ? "rands" : "litres", tone: "neutral", sub: t("dashboard.thisMonth", locale),
        delta: opt("compare") === "on" ? monthDelta(a, b, now, locale, true) : undefined,
        trend: perMonth(lastMonths(now, 6, locale), d.fuel.filter(inFleet).map((f) => [f.date, pick(f)])),
      };
    }
    case "fuel_trend": {
      const buckets = lastMonths(now, months, locale);
      const per = new Map<string, number>();
      for (const f of d.fuel) if (f.machine_id == null || ids.has(f.machine_id)) per.set(f.date.slice(0, 7), (per.get(f.date.slice(0, 7)) ?? 0) + (f.litres ?? 0));
      return { kind: "series", format: "litres", points: buckets.map((b) => ({ ...b, value: Math.round(per.get(b.key) ?? 0) })) };
    }
    case "fuel_flags": {
      const cut = ymd(new Date(now.getTime() - 45 * 86_400_000));
      const n = d.fuel.filter((f) => f.anomaly_notified_at && f.date >= cut && f.machine_id != null && ids.has(f.machine_id)).length;
      return { kind: "kpi", value: n, format: "count", tone: n > 0 ? "bad" : "ok", sub: t("dash.sub.last45", locale) };
    }

    // == Papers ================================================================
    case "expiring_papers": {
      type Row = ListRow & { date: string };
      const out: Row[] = [];
      for (const m of active) {
        const st = warrantyStatus(m);
        if (st === "expiring" || st === "expired") {
          out.push({
            key: `w-${m.id}`, date: m.warranty_expiry_date ?? "9999-12-31", title: m.name, href: `/machines/${m.id}?tab=papers`,
            sub: `${t("compliance.warranty", locale)} · ${shortDate(m.warranty_expiry_date, locale)}`,
            badge: { label: t(st === "expired" ? "dash.expired" : "dash.expiring", locale), tone: st === "expired" ? "danger" : "warning" },
          });
        }
      }
      for (const l of d.licences) {
        if (!ids.has(l.machine_id)) continue;
        const st = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
        if (st !== "expiring" && st !== "expired") continue;
        out.push({
          key: `l-${l.id}`, date: l.expiry_date, title: name.get(l.machine_id) ?? "-", href: `/machines/${l.machine_id}?tab=papers`,
          sub: `${licenceTypeLabel(l.type, locale)} · ${shortDate(l.expiry_date, locale)}`,
          badge: { label: t(st === "expired" ? "dash.expired" : "dash.expiring", locale), tone: st === "expired" ? "danger" : "warning" },
        });
      }
      out.sort((a, b) => a.date.localeCompare(b.date));
      return { kind: "list", more: Math.max(0, out.length - rows), empty: t("dash.empty.papers", locale), rows: out.slice(0, rows).map(({ date: _date, ...r }) => r) };
    }
    case "fines_to_nominate": {
      const pending = d.fines.filter((f) => ids.has(f.machine_id));
      const next = pending.map((f) => f.nomination_deadline).filter((x): x is string => !!x).sort()[0];
      return {
        kind: "kpi", value: pending.length, format: "count", tone: pending.length > 0 ? "warn" : "ok",
        sub: next ? t("dash.sub.nextDeadline", locale).replace("{when}", relativeDate(next, locale, now)) : t("dash.sub.noDeadlines", locale),
      };
    }
  }
  return null;
}
