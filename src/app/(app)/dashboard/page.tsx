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
import { FaultsIcon, ReportsIcon, ChevronRightIcon } from "@/components/ui/icons";

export default async function DashboardPage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const staleDate = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  const [overdue, dueSoon, okc, faultsRes, workshopRes, spendThis, spendLast, staleRes] = await Promise.all([
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "overdue"),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "due_soon"),
    supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("status", "ok"),
    supabase.from("faults").select("id, machine_id, description, urgency").neq("status", "resolved").order("created_at", { ascending: false }).limit(10),
    supabase.from("machines").select("id, name").eq("status", "in_workshop"),
    supabase.from("job_cards").select("total_cents").gte("date_out", firstThis),
    supabase.from("job_cards").select("total_cents").gte("date_out", firstLast).lt("date_out", firstThis),
    supabase.from("machines").select("id, name").neq("meter_type", "none").or(`current_reading_date.is.null,current_reading_date.lt.${staleDate}`),
  ]);

  const sum = (rows: { total_cents: number }[] | null | undefined) =>
    (rows ?? []).reduce((a, b) => a + (b.total_cents || 0), 0);
  const faults = (faultsRes.data as { id: string; machine_id: string; description: string | null; urgency: string | null }[] | null) ?? [];
  const inWorkshop = (workshopRes.data as { id: string; name: string }[] | null) ?? [];
  const stale = (staleRes.data as { id: string; name: string }[] | null) ?? [];

  const fIds = [...new Set(faults.map((f) => f.machine_id))];
  const { data: fm } = fIds.length ? await supabase.from("machines").select("id, name").in("id", fIds) : { data: [] };
  const nameById = Object.fromEntries(((fm as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  // ---- presentation (restyled onto the UI kit; queries above are unchanged) ----
  const locale = profile.language;
  const spendThisTotal = sum(spendThis.data);
  const spendLastTotal = sum(spendLast.data);
  const spendDelta = t("ui.vsLastMonth", locale).replace("{v}", rands(spendLastTotal));

  const urgencyTone = (u: string | null): BadgeTone => {
    const s = (u ?? "").toLowerCase();
    if (s.includes("stop")) return "danger";
    if (s.includes("limp")) return "warning";
    return "neutral";
  };

  const board = [
    { count: overdue.count ?? 0, status: "overdue", tone: "text-status-overdue", label: t("ui.statusOverdue", locale) },
    { count: dueSoon.count ?? 0, status: "due_soon", tone: "text-status-due", label: t("ui.statusDueSoon", locale) },
    { count: okc.count ?? 0, status: "ok", tone: "text-status-ok", label: t("ui.statusOk", locale) },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("nav.dashboard", locale)}</h1>
        <Link href="/reports" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <ReportsIcon className="text-[1.1rem]" />
          {t("nav.reports", locale)}
        </Link>
      </div>

      {/* Traffic-light service board */}
      <Card>
        <CardHeader
          action={
            <Link
              href="/reports"
              className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700"
            >
              {t("ui.viewAll", locale)}
              <ChevronRightIcon className="text-[1rem]" />
            </Link>
          }
        >
          <CardTitle>{t("ui.serviceBoard", locale)}</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-3 gap-3">
          {board.map((s) => (
            <div key={s.status} className="rounded-lg bg-sand-50 py-3 text-center">
              <div className={`text-3xl font-bold leading-none ${s.tone}`}>{s.count}</div>
              <div className="mt-2 flex justify-center">
                <StatusPill status={s.status} label={s.label} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Spend KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label={t("ui.spendThisMonth", locale)} value={rands(spendThisTotal)} tone="brand" delta={spendDelta} />
        <Stat label={t("ui.spendLastMonth", locale)} value={rands(spendLastTotal)} />
      </div>

      {/* Open faults */}
      <Card>
        <CardHeader
          action={
            <Link
              href="/faults"
              className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700"
            >
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
            {faults.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-sand-900">
                    {nameById[f.machine_id] ?? "—"}
                  </span>
                  <span className="block truncate text-sm text-sand-500">{f.description}</span>
                </span>
                {f.urgency ? (
                  <Badge tone={urgencyTone(f.urgency)} className="shrink-0 capitalize">
                    {f.urgency}
                  </Badge>
                ) : null}
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
                <li key={m.id} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />
                  {m.name}
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
                <li key={m.id} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-status-due" aria-hidden />
                  {m.name}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="text-xs text-sand-400">
        {profile.name} · <span className="capitalize">{profile.role}</span>
      </p>
    </div>
  );
}
