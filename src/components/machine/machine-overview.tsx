import Link from "next/link";
import type { ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import { num } from "@/lib/format";
import { rands } from "@/lib/money";
import type { SeriesPoint } from "@/lib/dashboard/compute";
import { HUES } from "@/lib/dashboard/palettes";
import type { TimelineEvent } from "@/lib/machine-timeline";
import { SeriesChart, Sparkline } from "@/components/dashboard/charts";
import { TONES, StatusPill, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { CalendarIcon, CashIcon, ChevronRightIcon, FaultsIcon, FuelIcon, TrendingIcon } from "@/components/ui/icons";
import { MachineTimeline } from "@/components/machine-timeline";
import { CostBreakdown, type CostPeriod } from "./cost-breakdown";

/**
 * The top of a machine's page, after the AutoVault vehicle page the founder pointed to: a
 * banner that says what the machine is and what state it is in, with the things people
 * come to do, then the machine's own dashboard (meter, next service, what it costs, fuel),
 * the figures behind them by month, and the latest of its history. Every number here is
 * one the tabs below explain in full, and each tile links to where.
 */
export function MachineHero({
  title, subtitle, photo, status, chips, note, actions,
}: { title: string; subtitle: string; photo: ReactNode; status: ReactNode; chips: (string | null)[]; note?: string | null; actions: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 p-4 text-white shadow-soft sm:p-6">
      <div className="flex min-w-0 flex-wrap items-center gap-4 sm:gap-6">
        <div className="shrink-0 overflow-hidden rounded-2xl bg-white/10 ring-2 ring-white/20">{photo}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* The page's title lives here, as on the AutoVault vehicle page: the banner says what
              the machine is, then how it is, then what to do. */}
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
            {subtitle ? <p className="mt-0.5 text-sm font-medium text-white/85 sm:text-base">{subtitle}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status}
            {chips.filter(Boolean).map((c) => (
              <span key={c} className="rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white ring-1 ring-white/25">{c}</span>
            ))}
          </div>
          {note ? <p className="max-w-prose text-sm text-white/90">{note}</p> : null}
          <div className="flex flex-wrap gap-2">{actions}</div>
        </div>
      </div>
    </section>
  );
}

function TileHead({ icon, tone, label }: { icon: ReactNode; tone: BadgeTone; label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl text-lg", TONES[tone])}>{icon}</span>
      <span className="text-sm font-semibold text-sand-700">{label}</span>
    </div>
  );
}

function Tile({ href, children }: { href?: string; children: ReactNode }) {
  const cls = "flex h-full flex-col rounded-2xl border border-sand-200 bg-surface p-4 shadow-card";
  return href ? (
    <Link href={href} className={cn(cls, "focus-ring group transition hover:border-brand-600/50 hover:shadow-soft")}>{children}</Link>
  ) : (
    <div className={cls}>{children}</div>
  );
}

const Big = ({ children, tone }: { children: ReactNode; tone?: string }) => (
  <p className={cn("text-3xl font-bold tabular-nums tracking-tight", tone ?? "text-sand-950")}>{children}</p>
);

export type MachineDashboardProps = {
  locale: Lang;
  meter: { label: string; value: string; note: string; stale: boolean; trend: number[]; href: string } | null;
  service:
    | { status: "ok" | "due_soon" | "overdue"; pill: string; task: string; due: string | null; progress: number; href: string }
    | { setupHref: string }
    | null;
  cost: { thisMonth: number; lifetime: number; perMeter: string | null; periods: CostPeriod[]; monthly: SeriesPoint[]; fullHref: string } | null;
  fuel: { thisMonth: number; consumption: string | null; monthly: SeriesPoint[]; href: string } | null;
  usageMonthly: SeriesPoint[];
  usageUnit: "hours" | "km" | null;
  quick: { label: string; value: string; tone?: "bad" | "warn" | "ok"; href?: string }[];
  recent: TimelineEvent[];
  machineId: string;
  historyHref: string;
};

const BAR: Record<string, string> = { ok: "bg-status-ok", due_soon: "bg-status-due", overdue: "bg-status-overdue" };
const QUICK_TONE: Record<string, string> = { bad: "text-status-overdue", warn: "text-status-due", ok: "text-status-ok" };

export function MachineDashboard(p: MachineDashboardProps) {
  const { locale } = p;
  const L = (k: string) => t(k, locale);
  return (
    <div className="grid grid-cols-1 gap-4">
      {/* The four things asked first: how far it has gone, when it is due, what it costs, what it burns. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {p.meter ? (
          <Tile href={p.meter.href}>
            <TileHead icon={<TrendingIcon />} tone="brand" label={p.meter.label} />
            <Big>{p.meter.value}</Big>
            <p className={cn("mt-1 text-sm", p.meter.stale ? "font-semibold text-status-due" : "text-sand-600")}>{p.meter.note}</p>
            {p.meter.trend.length > 1 ? <Sparkline values={p.meter.trend} sw={HUES.green} className="mt-auto h-10 pt-2" /> : null}
          </Tile>
        ) : null}
        {p.service && "status" in p.service ? (
          <Tile href={p.service.href}>
            <TileHead icon={<CalendarIcon />} tone="warning" label={L("machines.nextService")} />
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={p.service.status} label={p.service.pill} />
              <span className="min-w-0 font-semibold text-sand-900">{p.service.task}</span>
            </div>
            {p.service.due ? <p className="mt-1.5 text-sm text-sand-700">{p.service.due}</p> : null}
            <div className="mt-auto pt-3">
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`${Math.round(p.service.progress * 100)}%`}>
                <div className={cn("h-full rounded-full", BAR[p.service.status])} style={{ width: `${Math.max(4, Math.round(p.service.progress * 100))}%` }} />
              </div>
            </div>
          </Tile>
        ) : p.service ? (
          <Tile href={p.service.setupHref}>
            <TileHead icon={<CalendarIcon />} tone="warning" label={L("machines.nextService")} />
            <p className="font-semibold text-sand-900">{L("machines.setUpPlan")}</p>
            <p className="mt-1 text-sm text-sand-600">{L("machine.dash.planHint")}</p>
          </Tile>
        ) : null}
        {p.cost ? (
          <CostBreakdown periods={p.cost.periods} fullHref={p.cost.fullHref} title={L("machine.dash.costTitle")} locale={locale}>
            <TileHead icon={<CashIcon />} tone="ok" label={L("machine.dash.spentThisMonth")} />
            <Big>{rands(p.cost.thisMonth)}</Big>
            <p className="mt-1 text-sm text-sand-600">
              {L("machine.dash.lifetime").replace("{amount}", rands(p.cost.lifetime))}
              {p.cost.perMeter ? ` · ${p.cost.perMeter}` : ""}
            </p>
          </CostBreakdown>
        ) : null}
        {p.fuel ? (
          <Tile href={p.fuel.href}>
            <TileHead icon={<FuelIcon />} tone="info" label={L("machine.dash.fuelThisMonth")} />
            <Big>{`${num(p.fuel.thisMonth, 0)} ${L("dash.unit.litres")}`}</Big>
            <p className="mt-1 text-sm text-sand-600">{p.fuel.consumption ?? L("machine.dash.noConsumption")}</p>
            {p.fuel.monthly.some((m) => m.value > 0) ? (
              <Sparkline values={p.fuel.monthly.map((m) => m.value)} sw={HUES.gold} className="mt-auto h-10 pt-2" />
            ) : null}
          </Tile>
        ) : null}
      </div>

      {/* Quick figures, each a way into the detail. */}
      {p.quick.length > 0 ? (
        <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border border-sand-200 bg-surface shadow-card sm:grid-cols-4">
          {p.quick.map((q, i) => {
            const body = (
              <>
                <dt className="text-sm font-semibold text-sand-700">{q.label}</dt>
                <dd className={cn("mt-0.5 text-2xl font-bold tabular-nums", q.tone ? QUICK_TONE[q.tone] : "text-sand-950")}>{q.value}</dd>
              </>
            );
            const cls = cn("px-4 py-3", i > 0 && "sm:border-l sm:border-sand-100", i % 2 === 1 && "border-l border-sand-100", i > 1 && "border-t border-sand-100 sm:border-t-0");
            return q.href ? (
              <Link key={q.label} href={q.href} className={cn(cls, "focus-ring block transition hover:bg-surface-hover")}>{body}</Link>
            ) : (
              <div key={q.label} className={cls}>{body}</div>
            );
          })}
        </dl>
      ) : null}

      {/* The months behind the tiles. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
        {p.cost && p.cost.monthly.some((m) => m.value > 0) ? (
          <ChartCard icon={<CashIcon />} tone="ok" title={L("machine.dash.costByMonth")} href={p.cost.fullHref} more={L("machine.dash.fullCosts")}>
            <SeriesChart data={{ kind: "series", format: "rands", points: p.cost.monthly }} chart="bar" colour="green" title={L("machine.dash.costByMonth")} locale={locale} />
          </ChartCard>
        ) : null}
        {p.fuel && p.fuel.monthly.some((m) => m.value > 0) ? (
          <ChartCard icon={<FuelIcon />} tone="info" title={L("machine.dash.fuelByMonth")} href={p.fuel.href} more={L("machine.dash.fuelDetail")}>
            <SeriesChart data={{ kind: "series", format: "litres", points: p.fuel.monthly }} chart="bar" colour="gold" title={L("machine.dash.fuelByMonth")} locale={locale} />
          </ChartCard>
        ) : null}
        {p.usageUnit && p.usageMonthly.some((m) => m.value > 0) ? (
          <ChartCard icon={<TrendingIcon />} tone="brand" title={L(p.usageUnit === "km" ? "machine.dash.kmByMonth" : "machine.dash.hoursByMonth")} href={p.meter?.href ?? p.historyHref} more={L("machine.dash.meterDetail")}>
            <SeriesChart data={{ kind: "series", format: "count", points: p.usageMonthly }} chart="area" colour="blue" title={L("machine.dash.hoursByMonth")} locale={locale} />
          </ChartCard>
        ) : null}
        <ChartCard icon={<FaultsIcon />} tone="neutral" title={L("machine.dash.recent")} href={p.historyHref} more={L("machine.dash.fullHistory")} tall>
          <MachineTimeline events={p.recent} filter="all" machineId={p.machineId} locale={locale} compact={6} />
        </ChartCard>
      </div>
    </div>
  );
}

function ChartCard({
  icon, tone, title, href, more, children, tall,
}: { icon: ReactNode; tone: BadgeTone; title: string; href: string; more: string; children: ReactNode; tall?: boolean }) {
  return (
    <section className="flex flex-col rounded-2xl border border-sand-200 bg-surface p-4 shadow-card">
      <header className="mb-3 flex items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl text-lg", TONES[tone])}>{icon}</span>
        <h2 className="min-w-0 flex-1 text-base font-bold text-sand-900">{title}</h2>
        <Link href={href} className="focus-ring inline-flex shrink-0 items-center gap-0.5 rounded-md text-sm font-semibold text-brand-ink hover:underline">
          {more}
          <ChevronRightIcon className="text-base" />
        </Link>
      </header>
      <div className={tall ? "min-h-0" : "h-56"}>{children}</div>
    </section>
  );
}

