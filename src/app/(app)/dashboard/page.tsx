import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
// Import from specific modules (not the barrel) so this Server Component stays
// free of the kit's client chunk — see src/components/ui/README.md.
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { StatusPill, Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { FaultsIcon, ReportsIcon, ChevronRightIcon, MachinesIcon } from "@/components/ui/icons";
import { SpendTrend, HBars } from "./charts";

type Machine = {
  id: string;
  name: string;
  status: string;
  meter_type: string;
  current_reading_date: string | null;
};
type SPL = { machine_id: string; status: string };
type Fault = { id: string; machine_id: string; description: string | null; urgency: string | null; created_at: string };
type JC = { machine_id: string; type: string; total_cents: number; date_out: string | null };
type OpenJC = { machine_id: string; date_in: string | null };

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function DashboardPage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const locale = profile.language;

  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const staleDate = ymd(new Date(now.getTime() - 30 * 86400000));

  const [machinesRes, splRes, faultsRes, jcRes, openJcRes] = await Promise.all([
    supabase.from("machines").select("id, name, status, meter_type, current_reading_date").is("deleted_at", null),
    supabase.from("service_plan_lines").select("machine_id, status").is("deleted_at", null),
    supabase.from("faults").select("id, machine_id, description, urgency, created_at").neq("status", "resolved").is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("job_cards").select("machine_id, type, total_cents, date_out").is("deleted_at", null).gte("date_out", ymd(sixMonthsAgo)),
    supabase.from("job_cards").select("machine_id, date_in").is("deleted_at", null).in("status", ["open", "in_progress", "waiting_parts"]),
  ]);

  const machines = (machinesRes.data as Machine[] | null) ?? [];
  const spl = (splRes.data as SPL[] | null) ?? [];
  const allFaults = (faultsRes.data as Fault[] | null) ?? [];
  const jcs = (jcRes.data as JC[] | null) ?? [];
  const openJcs = (openJcRes.data as OpenJC[] | null) ?? [];

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

  // Spend delta.
  const spendPct = spendLast > 0 ? Math.round(((spendThis - spendLast) / spendLast) * 100) : null;
  const spendTone = spendThis > spendLast ? "overdue" : spendThis < spendLast ? "ok" : "default";
  const spendDelta =
    spendPct == null
      ? t("ui.vsLastMonth", locale).replace("{v}", rands(spendLast))
      : `${spendPct > 0 ? "↑" : spendPct < 0 ? "↓" : ""}${Math.abs(spendPct)}% ${t("dashboard.vsLast", locale)}`;

  const urgencyTone = (u: string | null): BadgeTone => {
    const s = (u ?? "").toLowerCase();
    if (s.includes("stop")) return "danger";
    if (s.includes("limp")) return "warning";
    return "neutral";
  };
  const age = (iso: string) => {
    const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return t("dashboard.today", locale);
    if (days < 14) return `${days}${t("dashboard.dayShort", locale)}`;
    return `${Math.floor(days / 7)}${t("dashboard.weekShort", locale)}`;
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("nav.dashboard", locale)}</h1>
        <Link href="/reports" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <ReportsIcon className="text-[1.1rem]" />
          {t("nav.reports", locale)}
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("dashboard.kpiOverdue", locale)} value={svc.overdue} tone={svc.overdue > 0 ? "overdue" : "default"} href="/reports" />
        <Stat label={t("dashboard.kpiDueSoon", locale)} value={svc.due_soon} tone={svc.due_soon > 0 ? "due" : "default"} href="/reports" />
        <Stat label={t("dashboard.kpiOpenFaults", locale)} value={faults.length} tone={faults.length > 0 ? "overdue" : "default"} href="/faults" />
        <Stat
          label={t("dashboard.kpiInWorkshop", locale)}
          value={inWorkshop.length}
          delta={maxDaysIn > 0 ? `${t("dashboard.upTo", locale)} ${maxDaysIn}${t("dashboard.dayShort", locale)}` : undefined}
          href="/machines?status=in_workshop"
        />
      </div>

      {/* Spend + service OK */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label={t("ui.spendThisMonth", locale)} value={rands(spendThis)} tone={spendTone} delta={spendDelta} />
        <Stat label={t("ui.spendLastMonth", locale)} value={rands(spendLast)} />
        <Stat label={t("dashboard.kpiServicesOk", locale)} value={svc.ok} tone={svc.ok > 0 ? "ok" : "default"} />
      </div>

      {/* Spend trend */}
      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard.spendTrend", locale)}</CardTitle>
        </CardHeader>
        {trend.some((d) => d.value > 0) ? (
          <SpendTrend data={trend} title={t("dashboard.spendTrend", locale)} />
        ) : (
          <EmptyState title={t("dashboard.noSpendYet", locale)} />
        )}
      </Card>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.spendByType", locale)}</CardTitle>
          </CardHeader>
          <HBars data={byType} title={t("dashboard.spendByType", locale)} emptyLabel={t("dashboard.noSpendYet", locale)} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.costPerMachine", locale)}</CardTitle>
          </CardHeader>
          <HBars data={byMachine} title={t("dashboard.costPerMachine", locale)} emptyLabel={t("dashboard.noSpendYet", locale)} />
        </Card>
      </div>

      {/* Open faults (actionable) */}
      <Card>
        <CardHeader
          action={
            <Link href="/faults" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700">
              {t("ui.all", locale)}
              <ChevronRightIcon className="text-[1rem]" />
            </Link>
          }
        >
          <CardTitle>{t("ui.openFaults", locale)}</CardTitle>
        </CardHeader>
        {faults.length === 0 ? (
          <EmptyState icon={<FaultsIcon />} title={t("ui.noOpenFaults", locale)} />
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {faults.slice(0, 8).map((f) => (
              <li key={f.id}>
                <Link href="/faults" className="focus-ring flex items-center justify-between gap-3 rounded-md py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-sand-900">{nameById[f.machine_id] ?? "—"}</span>
                    <span className="block truncate text-sm text-sand-500">{f.description}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-sand-400">{age(f.created_at)}</span>
                    {f.urgency ? (
                      <Badge tone={urgencyTone(f.urgency)} className="capitalize">
                        {t(`urgency.${f.urgency}`, locale)}
                      </Badge>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Workshop + stale readings */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("ui.inWorkshop", locale)}</CardTitle>
          </CardHeader>
          {inWorkshop.length === 0 ? (
            <p className="text-sm text-sand-500">{t("ui.none", locale)}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm text-sand-800">
              {inWorkshop.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <Link href={`/machines/${m.id}`} className="focus-ring flex min-w-0 items-center gap-2 rounded-md">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                    <span className="truncate">{m.name}</span>
                  </Link>
                  {m.days != null ? (
                    <span className="shrink-0 text-xs tabular-nums text-sand-400">
                      {m.days}
                      {t("dashboard.dayShort", locale)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("ui.staleReadings", locale)}</CardTitle>
          </CardHeader>
          {stale.length === 0 ? (
            <p className="text-sm text-sand-500">{t("ui.noStaleReadings", locale)}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm text-sand-800">
              {stale.map((m) => (
                <li key={m.id}>
                  <Link href={`/machines/${m.id}`} className="focus-ring flex items-center gap-2 rounded-md">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-due" aria-hidden />
                    <span className="truncate">{m.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {active.length === 0 ? (
        <EmptyState
          icon={<MachinesIcon />}
          title={t("dashboard.noMachinesTitle", locale)}
          hint={t("dashboard.noMachinesHint", locale)}
          action={
            <Link href="/onboarding" className={buttonVariants({ variant: "primary", size: "sm" })}>
              {t("dashboard.noMachinesAdd", locale)}
            </Link>
          }
        />
      ) : null}

      <p className="text-xs text-sand-400">
        {profile.name} · <span className="capitalize">{profile.role}</span>
      </p>
    </div>
  );
}
