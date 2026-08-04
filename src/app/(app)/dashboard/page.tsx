import Link from "next/link";
import { redirect } from "next/navigation";
import { checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
// Import from specific modules (not the barrel) so this Server Component stays
// free of the kit's client chunk — see src/components/ui/README.md.
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { AllClear, GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { FaultsIcon, ChevronRightIcon, MachinesIcon, WarningIcon, PlusIcon } from "@/components/ui/icons";
import { num, relativeDate } from "@/lib/format";
import { SpendTrend } from "./charts";
import { warrantyStatus, dateExpiryStatus, expiryTone, expiryLabel, licenceTypeLabel } from "@/lib/compliance";
import { ExpiryStatus, FineStatus, UrgencyStatus, ServiceStatus, MachineStatus } from "@/components/ui/status";

type Machine = {
  id: string;
  name: string;
  status: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  warranty_expiry_date: string | null;
  warranty_expiry_hours: number | null;
};
type Licence = { id: string; machine_id: string; type: string; number: string | null; expiry_date: string; reminder_lead_days: number };
type DashFine = { id: string; machine_id: string; offence: string | null; notice_number: string | null; nomination_deadline: string | null; status: string };
type SPL = { machine_id: string; status: string; task: string };
type Fault = { id: string; machine_id: string; description: string | null; urgency: string | null; created_at: string };
type JC = { machine_id: string; type: string; total_cents: number; date_out: string | null };
type OpenJC = { machine_id: string; date_in: string | null };

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function DashboardPage() {
  // Dashboard is a Professional+ feature (FR-19.2). Deny server-side for under-plan
  // farms — the KPI data below is never fetched or rendered; an upgrade prompt shows.
  const gate = await checkEntitlement("dashboard");
  const profile = gate.profile;
  const locale = profile.lang;
  // A contractor (workshop role) has no single "farm" — their home is the aggregated
  // contractor dashboard (F12c), not this farm-centric one.
  if (profile.role === "workshop") redirect("/contractor");
  if (!gate.allowed) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("nav.dashboard", locale)}</h1>
          <PageInfoButton infoKey="dashboard" locale={locale} />
        </div>
        <UpgradeNotice
          feature="dashboard"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }
  const supabase = await createClient();
  // Multi-site (F7): scope every KPI query to the farm the user is currently acting in.
  // Single-farm users are unaffected (RLS already scopes to their one farm); a multi-site
  // user sees the farm chosen in the switcher. rr_admin (farmId null) keeps its all-farms view.
  const farmId = await currentFarmId(profile);
  const byFarm = <Q,>(q: Q): Q =>
    farmId ? (q as { eq(c: string, v: string): Q }).eq("farm_id", farmId) : q;

  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const staleDate = ymd(new Date(now.getTime() - 30 * 86400000));

  const flagCut = ymd(new Date(now.getTime() - 45 * 86400000));
  const [machinesRes, splRes, faultsRes, jcRes, openJcRes, fuelMonthRes, fuelFlagRes, licenceRes] = await Promise.all([
    byFarm(supabase.from("machines").select("id, name, status, meter_type, current_reading, current_reading_date, warranty_expiry_date, warranty_expiry_hours").is("deleted_at", null)),
    byFarm(supabase.from("service_plan_lines").select("machine_id, status, task").is("deleted_at", null)),
    byFarm(supabase.from("faults").select("id, machine_id, description, urgency, created_at").neq("status", "resolved").is("deleted_at", null).order("created_at", { ascending: false })),
    byFarm(supabase.from("job_cards").select("machine_id, type, total_cents, date_out").is("deleted_at", null).gte("date_out", ymd(sixMonthsAgo))),
    byFarm(supabase.from("job_cards").select("machine_id, date_in").is("deleted_at", null).in("status", ["open", "in_progress", "waiting_parts"])),
    byFarm(supabase.from("fuel_issues").select("machine_id, litres, cost_cents").is("deleted_at", null).gte("date", ymd(firstThis))),
    byFarm(supabase.from("fuel_issues").select("machine_id").is("deleted_at", null).not("anomaly_notified_at", "is", null).gte("date", flagCut)),
    byFarm(supabase.from("licences").select("id, machine_id, type, number, expiry_date, reminder_lead_days").is("deleted_at", null)),
  ]);

  // The farm's own name — a multi-farm user needs to know WHICH farm this is.
  const { data: farmRow } = farmId
    ? await supabase.from("farms").select("name").eq("id", farmId).maybeSingle()
    : { data: null };
  const farmName = (farmRow as { name: string } | null)?.name ?? null;

  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const spl = (splRes.data as SPL[] | null) ?? [];
  const allFaults = (faultsRes.data as Fault[] | null) ?? [];
  const jcs = (jcRes.data as JC[] | null) ?? [];
  const openJcs = (openJcRes.data as OpenJC[] | null) ?? [];
  const fuelMonth = (fuelMonthRes.data as { machine_id: string | null; litres: number | null; cost_cents: number | null }[] | null) ?? [];
  const fuelFlags = (fuelFlagRes.data as { machine_id: string | null }[] | null) ?? [];

  // Active machines only — retired/sold drop out of every count, list and total (Scope §4.1).
  const active = machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  const activeIds = new Set(active.map((m) => m.id));
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  // Service board counts (active machines).
  const svc = { overdue: 0, due_soon: 0, ok: 0 } as Record<string, number>;
  for (const l of spl) if (activeIds.has(l.machine_id) && l.status in svc) svc[l.status]++;

  // Open faults on active machines, with age.
  const faults = allFaults.filter((f) => activeIds.has(f.machine_id));

  // In-workshop machines + days-in (earliest open job card's date_in as proxy).
  const earliestOpenByMachine = new Map<string, string>();
  for (const j of openJcs) {
    if (!j.date_in) continue;
    const cur = earliestOpenByMachine.get(j.machine_id);
    if (!cur || j.date_in < cur) earliestOpenByMachine.set(j.machine_id, j.date_in);
  }
  const inWorkshop = active
    .filter((m) => m.status === "in_workshop")
    .map((m) => {
      const since = earliestOpenByMachine.get(m.id);
      const days = since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86400000)) : null;
      return { id: m.id, name: m.name, days };
    });
  const maxDaysIn = inWorkshop.reduce((a, m) => (m.days != null && m.days > a ? m.days : a), 0);

  // Stale readings (metered active machines with no recent reading).
  const stale = active.filter(
    (m) => m.meter_type !== "none" && (!m.current_reading_date || m.current_reading_date < staleDate)
  );

  // Spend: this vs last month; 6-month trend; by type; per machine (active machines only).
  const inMonth = (dateStr: string | null, start: Date) => {
    if (!dateStr) return false;
    const nextStart = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return dateStr >= ymd(start) && dateStr < ymd(nextStart);
  };
  const activeJcs = jcs.filter((j) => activeIds.has(j.machine_id));
  const spendThis = activeJcs.filter((j) => inMonth(j.date_out, firstThis)).reduce((a, j) => a + (j.total_cents || 0), 0);
  const spendLast = activeJcs.filter((j) => inMonth(j.date_out, firstLast)).reduce((a, j) => a + (j.total_cents || 0), 0);

  const trend = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const value = activeJcs.filter((j) => inMonth(j.date_out, d)).reduce((a, j) => a + (j.total_cents || 0), 0);
    return { key: ymd(d), label: MONTH_LABELS[d.getMonth()], value };
  });

  const byTypeMap = new Map<string, number>();
  for (const j of activeJcs) byTypeMap.set(j.type, (byTypeMap.get(j.type) ?? 0) + (j.total_cents || 0));
  const byType = [...byTypeMap.entries()]
    .map(([k, v]) => ({ key: k, label: t(`jobType.${k}`, locale), value: v }))
    .sort((a, b) => b.value - a.value);

  const byMachineMap = new Map<string, number>();
  for (const j of activeJcs) byMachineMap.set(j.machine_id, (byMachineMap.get(j.machine_id) ?? 0) + (j.total_cents || 0));
  const byMachine = [...byMachineMap.entries()]
    .map(([id, v]) => ({ key: id, label: nameById[id] ?? "—", value: v, href: `/machines/${id}` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  // Fuel this month + open anomaly count (active machines / farm-level draws).
  const fuelSpendMonth = fuelMonth.reduce((a, f) => a + (f.cost_cents ?? 0), 0);
  const fuelLitresMonth = fuelMonth.reduce((a, f) => a + (f.litres ?? 0), 0);
  const fuelAnomalyCount = fuelFlags.filter((f) => f.machine_id != null && activeIds.has(f.machine_id)).length;
  const fuelHasData = fuelMonth.length > 0 || fuelAnomalyCount > 0;

  // Expiries upcoming (F6): warranty (machine) + licences, expiring or expired, on active
  // machines only (retired/sold excluded like every other count). Most severe / soonest first.
  const licences = (licenceRes.data as Licence[] | null) ?? [];
  type Expiry = { key: string; machineId: string; machineName: string; label: string; date: string; status: "expiring" | "expired" };
  const expiries: Expiry[] = [];
  for (const m of active) {
    const s = warrantyStatus(m);
    if (s === "expiring" || s === "expired") {
      expiries.push({
        key: `w-${m.id}`, machineId: m.id, machineName: m.name,
        label: t("compliance.warranty", locale), date: m.warranty_expiry_date ?? "", status: s,
      });
    }
  }
  for (const l of licences) {
    if (!activeIds.has(l.machine_id)) continue;
    const s = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
    if (s === "expiring" || s === "expired") {
      expiries.push({
        key: `l-${l.id}`, machineId: l.machine_id, machineName: nameById[l.machine_id] ?? "—",
        label: licenceTypeLabel(l.type, locale), date: l.expiry_date, status: s,
      });
    }
  }
  const sevRank: Record<string, number> = { expired: 0, expiring: 1 };
  expiries.sort((a, b) => sevRank[a.status] - sevRank[b.status] || a.date.localeCompare(b.date));

  // AARTO nominations pending & deadlines (§23) — Complete+ only. Fines still owing a driver
  // nomination (received | driver_identified) on active machines, soonest deadline first.
  const aartoAllowed = (await checkEntitlement("aarto", profile)).allowed;
  type PendingFine = { id: string; machineId: string; machineName: string; label: string; deadline: string | null; status: string };
  let pendingNominations: PendingFine[] = [];
  if (aartoAllowed) {
    let finesQ = supabase
      .from("fines")
      .select("id, machine_id, offence, notice_number, nomination_deadline, status")
      .in("status", ["received", "driver_identified"])
      .is("deleted_at", null);
    if (farmId) finesQ = finesQ.eq("farm_id", farmId);
    const { data: fineData } = await finesQ;
    pendingNominations = ((fineData as DashFine[] | null) ?? [])
      .filter((f) => activeIds.has(f.machine_id))
      .map((f) => ({
        id: f.id, machineId: f.machine_id, machineName: nameById[f.machine_id] ?? "—",
        label: f.offence || f.notice_number || t("fines.noOffence", locale),
        deadline: f.nomination_deadline, status: f.status,
      }))
      .sort((a, b) => (a.deadline ?? "9999-99-99").localeCompare(b.deadline ?? "9999-99-99"));
  }

  // Spend delta, said in words rather than a percentage sign.
  const spendPct = spendLast > 0 ? Math.round(((spendThis - spendLast) / spendLast) * 100) : null;
  const spendTone = spendThis > spendLast ? "overdue" : spendThis < spendLast ? "ok" : "default";
  const lastMonthName = MONTH_LABELS[firstLast.getMonth()];
  const spendDelta =
    spendLast === 0
      ? undefined
      : (spendThis < spendLast ? t("dashboard.lessThan", locale) : t("dashboard.moreThan", locale))
          .replace("{amount}", rands(Math.abs(spendThis - spendLast)))
          .replace("{month}", lastMonthName);

  // ── "Needs your attention" ────────────────────────────────────────────────
  // The old page opened with seven counters and left the owner to work out what to do,
  // and every tile linked to /reports rather than to the thing it named. This is one
  // ranked list, worst first, where each row deep-links to the machine it is about and
  // carries the action as a button.
  type Attend = {
    key: string;
    rank: number;
    machineId: string;
    machineName: string;
    detail: string;
    status: { kind: "urgency" | "service" | "expiry" | "fine"; value: string };
    ctaLabel: string;
    ctaHref: string;
  };
  const attention: Attend[] = [];

  const urgencyRank: Record<string, number> = { stopped: 0, limping: 3, can_work: 5 };
  for (const f of faults) {
    attention.push({
      key: `f-${f.id}`,
      rank: urgencyRank[f.urgency ?? ""] ?? 4,
      machineId: f.machine_id,
      machineName: nameById[f.machine_id] ?? "—",
      detail: `${f.description ?? ""} ${t("dashboard.reportedOn", locale).replace("{when}", relativeDate(f.created_at, locale, now))}`.trim(),
      status: { kind: "urgency", value: f.urgency ?? "can_work" },
      ctaLabel: t("dashboard.ctaMakeJobCard", locale),
      ctaHref: `/machines/${f.machine_id}`,
    });
  }

  for (const l of spl) {
    if (!activeIds.has(l.machine_id)) continue;
    if (l.status !== "overdue" && l.status !== "due_soon") continue;
    attention.push({
      key: `s-${l.machine_id}-${l.task}`,
      rank: l.status === "overdue" ? 1 : 4,
      machineId: l.machine_id,
      machineName: nameById[l.machine_id] ?? "—",
      detail: t(l.status === "overdue" ? "dashboard.serviceOverdueDetail" : "dashboard.serviceDueDetail", locale).replace("{task}", l.task),
      status: { kind: "service", value: l.status },
      ctaLabel: t("dashboard.ctaBookService", locale),
      ctaHref: `/machines/${l.machine_id}`,
    });
  }

  for (const e of expiries) {
    attention.push({
      key: `e-${e.key}`,
      rank: e.status === "expired" ? 2 : 4,
      machineId: e.machineId,
      machineName: e.machineName,
      detail: `${e.label} · ${t(e.status === "expired" ? "dashboard.expiredOn" : "dashboard.expiresOn", locale).replace("{when}", relativeDate(e.date, locale, now))}`,
      status: { kind: "expiry", value: e.status },
      ctaLabel: t("dashboard.ctaSeeMachine", locale),
      ctaHref: `/machines/${e.machineId}`,
    });
  }

  for (const f of pendingNominations) {
    attention.push({
      key: `n-${f.id}`,
      rank: 6,
      machineId: f.machineId,
      machineName: f.machineName,
      detail: f.deadline
        ? `${f.label} · ${t("dashboard.nominationDue", locale).replace("{when}", relativeDate(f.deadline, locale, now))}`
        : f.label,
      status: { kind: "fine", value: f.status },
      ctaLabel: t("dashboard.ctaNominateDriver", locale),
      ctaHref: "/fines",
    });
  }
  attention.sort((a, b) => a.rank - b.rank || a.machineName.localeCompare(b.machineName));

  // Greeting. South Africa is UTC+2 all year, so the hour is derived rather than
  // guessed from a server timezone that is almost certainly UTC.
  const sastHour = new Date(now.getTime() + 2 * 3_600_000).getUTCHours();
  const greetKey =
    sastHour < 12 ? "dashboard.goodMorning" : sastHour < 18 ? "dashboard.goodAfternoon" : "dashboard.goodEvening";
  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;
  const todayLine = now.toLocaleDateString(locale === "af" ? "af-ZA" : "en-ZA", {
    weekday: "long", day: "numeric", month: "long",
  });

  const working = active.filter((m) => m.status === "active").length;
  const standby = active.filter((m) => m.status === "standby").length;

  const statusBadge = (s: Attend["status"]) =>
    s.kind === "urgency" ? <UrgencyStatus value={s.value} locale={locale} />
    : s.kind === "service" ? <ServiceStatus value={s.value} locale={locale} />
    : s.kind === "expiry" ? <ExpiryStatus value={s.value} locale={locale} />
    : <FineStatus value={s.value} locale={locale} />;

  return (
    <div className="flex flex-col gap-5">
      {/* Greeting — replaces the "Dashboard" heading, which told a multi-farm user
          nothing about which farm they were looking at. */}
      <header>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight text-sand-950 sm:text-[1.75rem]">
            {t(greetKey, locale).replace("{name}", firstName)}
          </h1>
          <PageInfoButton infoKey="dashboard" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-500">
          <span className="capitalize">{todayLine}</span>
          {farmName ? <> · {farmName}</> : null}
          {" · "}
          <span className={attention.length > 0 ? "font-medium text-sand-700" : ""}>
            {attention.length === 0
              ? t("dashboard.nothingNeedsYouSub", locale)
              : attention.length === 1
                ? t("dashboard.oneThingNeedsYou", locale)
                : t("dashboard.thingsNeedYou", locale).replace("{n}", String(attention.length))}
          </span>
        </p>
      </header>

      {/* The two things a farm boss does from this screen, always reachable. */}
      <div className="flex flex-wrap gap-2">
        <Link href="/machines" className={buttonVariants({ variant: "secondary" })}>
          <MachinesIcon className="text-[1.1rem]" />
          {t("dashboard.quickCaptureHours", locale)}
        </Link>
        <Link href="/faults" className={buttonVariants({ variant: "primary" })}>
          <FaultsIcon className="text-[1.1rem]" />
          {t("dashboard.quickReportProblem", locale)}
        </Link>
      </div>

      {/* ── Needs your attention ─────────────────────────────────────────── */}
      {attention.length === 0 ? (
        <AllClear
          title={t("dashboard.allClearTitle", locale)}
          hint={t("dashboard.allClearHint", locale)}
          action={
            <Link href="/onboarding" className={buttonVariants({ variant: "secondary" })}>
              {t("dashboard.setupOpen", locale)}
            </Link>
          }
        />
      ) : (
        <Card flush>
          <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
            <h2 className="text-[1.05rem] font-bold text-sand-900">
              {t("dashboard.needsAttention", locale)}
            </h2>
            <span className="text-xs font-medium uppercase tracking-wide text-sand-400">
              {t("dashboard.worstFirst", locale)}
            </span>
          </div>
          <ul className="mt-2 flex flex-col divide-y divide-sand-100">
            {attention.slice(0, 8).map((a) => (
              <li key={a.key} className="px-4 py-3.5">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/machines/${a.machineId}`}
                        className="focus-ring truncate rounded font-semibold text-sand-900 hover:underline"
                      >
                        {a.machineName}
                      </Link>
                      {statusBadge(a.status)}
                    </div>
                    <p className="mt-0.5 text-sm leading-relaxed text-sand-600">{a.detail}</p>
                  </div>
                  <Link
                    href={a.ctaHref}
                    className={buttonVariants({ variant: "secondary", className: "shrink-0" })}
                  >
                    {a.ctaLabel}
                    <ChevronRightIcon className="text-[1rem]" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {attention.length > 8 ? (
            <div className="border-t border-sand-100 px-4 py-3">
              <Link href="/faults" className="focus-ring rounded text-sm font-medium text-brand-700">
                {t("ui.viewAll", locale)} →
              </Link>
            </div>
          ) : null}
        </Card>
      )}

      {/* ── What the fleet cost you ──────────────────────────────────────── */}
      <Card>
        <CardHeader
          action={
            <Link href="/reports" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700">
              {t("dashboard.fullCostReport", locale)}
              <ChevronRightIcon className="text-[1rem]" />
            </Link>
          }
        >
          <CardTitle>{t("dashboard.fleetCost", locale)}</CardTitle>
        </CardHeader>
        <p className="-mt-2 mb-3 text-sm text-sand-500">{t("dashboard.fleetCostHint", locale)}</p>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tabular-nums tracking-tight text-sand-950">{rands(spendThis)}</span>
          <span className="text-sm text-sand-500">{t("dashboard.thisMonth", locale)}</span>
          {spendDelta ? (
            <span className={`text-sm font-medium ${spendTone === "overdue" ? "text-status-overdue" : spendTone === "ok" ? "text-status-ok" : "text-sand-500"}`}>
              {spendDelta}
            </span>
          ) : null}
        </div>

        {trend.some((d) => d.value > 0) ? (
          <div className="mt-4">
            <SpendTrend data={trend} title={t("dashboard.spendTrend", locale)} />
          </div>
        ) : null}

        {byType.length > 0 ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-sand-100 pt-3 sm:grid-cols-4">
            {byType.slice(0, 4).map((b) => (
              <div key={b.key}>
                <dt className="truncate text-xs text-sand-500">{b.label}</dt>
                <dd className="text-base font-semibold tabular-nums text-sand-900">{rands(b.value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      {/* ── Servicing + the fleet right now ──────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.servicing", locale)}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100">
            {([
              { k: "overdue", n: svc.overdue, label: t("dashboard.servicingOverdue", locale) },
              { k: "due_soon", n: svc.due_soon, label: t("dashboard.servicingDueSoon", locale) },
              { k: "ok", n: svc.ok, label: t("dashboard.servicingOk", locale) },
            ] as const).map((row) => (
              <li key={row.k} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex items-center gap-2.5">
                  <ServiceStatus value={row.k} locale={locale} size="md" />
                </span>
                <span className="text-xl font-bold tabular-nums text-sand-900">{row.n}</span>
              </li>
            ))}
          </ul>
          {svc.overdue === 0 && svc.due_soon === 0 ? (
            <p className="mt-2 text-sm text-sand-500">{t("dashboard.servicingNothingToDo", locale)}</p>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.fleetNow", locale)}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100">
            <li className="flex items-center justify-between gap-3 py-2.5">
              <MachineStatus value="active" locale={locale} size="md" />
              <span className="text-xl font-bold tabular-nums text-sand-900">{working}</span>
            </li>
            <li className="flex items-start justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <MachineStatus value="in_workshop" locale={locale} size="md" />
                {inWorkshop.length > 0 ? (
                  <span className="mt-1 block truncate text-sm text-sand-500">
                    {inWorkshop.map((m) => (m.days != null ? `${m.name} · ${m.days}${t("dashboard.dayShort", locale)}` : m.name)).join(", ")}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xl font-bold tabular-nums text-sand-900">{inWorkshop.length}</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <MachineStatus value="standby" locale={locale} size="md" />
              <span className="text-xl font-bold tabular-nums text-sand-900">{standby}</span>
            </li>
          </ul>
        </Card>
      </div>

      {/* Fuel — kept, but only when the farm actually uses it. */}
      {fuelHasData ? (
        <Card>
          <CardHeader
            action={
              <Link href="/fuel" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700">
                {t("nav.fuel", locale)}
                <ChevronRightIcon className="text-[1rem]" />
              </Link>
            }
          >
            <CardTitle>{t("nav.fuel", locale)}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t("dashboard.fuelSpend", locale)} value={rands(fuelSpendMonth)} href="/fuel" valueClassName="text-xl sm:text-3xl" />
            <Stat label={t("dashboard.fuelLitres", locale)} value={num(fuelLitresMonth, 0)} href="/fuel" valueClassName="text-xl sm:text-3xl" />
            <Stat label={t("dashboard.fuelAnomalies", locale)} value={fuelAnomalyCount} tone={fuelAnomalyCount > 0 ? "overdue" : "default"} href="/fuel" valueClassName="text-xl sm:text-3xl" />
          </div>
        </Card>
      ) : null}

      {/* Stale meters — a nudge with the machines named, not a bare count. */}
      {stale.length > 0 ? (
        <Card>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-[1.15rem] text-status-due" aria-hidden>
              <WarningIcon />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-sand-900">
                {stale.length === 1
                  ? t("dashboard.staleMetersOneTitle", locale)
                  : t("dashboard.staleMetersTitle", locale).replace("{n}", String(stale.length))}
              </p>
              <p className="mt-0.5 text-sm text-sand-600">
                {stale.slice(0, 4).map((m) => m.name).join(", ")}
                {stale.length > 4 ? "…" : ""} — {t("dashboard.staleMetersHint", locale)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {stale.slice(0, 3).map((m) => (
                  <Link key={m.id} href={`/machines/${m.id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    {m.name}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {active.length === 0 ? (
        <GetStarted
          icon={<MachinesIcon />}
          title={t("dashboard.noMachinesTitle", locale)}
          hint={t("dashboard.noMachinesHint", locale)}
          action={
            <Link href="/machines/new" className={buttonVariants({ variant: "primary" })}>
              <PlusIcon className="text-[1.1rem]" />
              {t("dashboard.noMachinesAdd", locale)}
            </Link>
          }
          secondaryAction={
            <Link href="/onboarding" className={buttonVariants({ variant: "secondary" })}>
              {t("dashboard.setupOpen", locale)}
            </Link>
          }
        />
      ) : null}
    </div>
  );
}
