import Link from "next/link";
import { checkEntitlement, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { num, shortDate, todayLocal } from "@/lib/format";
import { getReportData, parseFilters } from "./data";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { readTab } from "@/components/ui/tabs-url";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { FilterBar, type FilterGroup } from "@/components/ui/filter-bar";
import { DownloadIcon, MailIcon, ChevronRightIcon } from "@/components/ui/icons";
import { FleetCompliancePackLink } from "@/components/reports/compliance-packs";
import { PrintMenuItem } from "@/components/reports/print-menu-item";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { budgetTone, budgetPeriodLabel, budgetCategoryLabel } from "@/lib/budgets";

/**
 * Reports (FR-11).
 *
 * The page used to be every report family in one column, 6 000px on a phone, opening
 * with five equal buttons and a raw site select with an Apply button. Now:
 *
 *   · one Export menu (Excel workbook, audit pack, print) beside a link to the emailed
 *     schedules;
 *   · the period, site and retired-machine filters in a FilterBar that applies on tap
 *     and is remembered on this device (`rememberKey`);
 *   · the families in URL-synced tabs, so each one is a screen or two, and a CSV link
 *     or a refresh lands back on the same tab.
 *
 * The period travels as `?period=` (thisMonth | last3 | all; This year is the default
 * and has no param, so "nothing chosen" and "the default" are the same URL). It resolves
 * to `from`/`to` here, which is still what `parseFilters`, the CSV routes and the
 * workbook read. A hand-made `?from=&to=` link still works as a custom range.
 *
 * Printing prints the tab on screen (the kit Tabs mount only the selected panel), with
 * the tab strip saying which one it is. The whole set, every family at once, is the Excel
 * workbook in the same menu.
 */

const PERIODS = ["thisMonth", "last3", "thisYear", "all"] as const;
type Period = (typeof PERIODS)[number];
/** The period with no URL param. */
const DEFAULT_PERIOD: Period = "thisYear";
const PERIOD_LABEL: Record<Period, string> = {
  thisMonth: "reports.thisMonth",
  last3: "reports.last3",
  thisYear: "reports.thisYear",
  all: "reports.allTime",
};

/** First day of a month as YYYY-MM-DD; `month0` is zero-based and may be negative. */
const monthStart = (year: number, month0: number) =>
  new Date(Date.UTC(year, month0, 1)).toISOString().slice(0, 10);

function periodRange(p: Period, today: string): { from: string | null; to: string | null } {
  const year = Number(today.slice(0, 4));
  const month0 = Number(today.slice(5, 7)) - 1;
  switch (p) {
    case "thisMonth":
      return { from: monthStart(year, month0), to: today };
    case "last3":
      return { from: monthStart(year, month0 - 2), to: today };
    case "thisYear":
      return { from: `${year}-01-01`, to: today };
    default:
      return { from: null, to: null };
  }
}

type SP = { period?: string; from?: string; to?: string; inactive?: string; group?: string; tab?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  // Advanced reports are a Professional+ feature (FR-19.2). Deny server-side for
  // under-plan farms, report data is never computed; an upgrade prompt shows instead.
  const gate = await checkEntitlement("advanced_reports");
  const profile = gate.profile;
  const locale = profile.lang;
  if (!gate.allowed) {
    // The selected farm's role, not the primary profile role: only that farm's owner
    // can change its plan, so only they are pointed at Billing.
    const deniedFarmId = await currentFarmId(profile);
    const deniedRole = deniedFarmId ? await effectiveFarmRole(deniedFarmId, profile) : null;
    return (
      <PageContainer size="wide">
        <PageHeader title={t("reports.title", locale)} infoKey="reports" locale={locale} />
        <UpgradeNotice
          feature="advanced_reports"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
          canUpgrade={deniedRole === "owner"}
        />
      </PageContainer>
    );
  }
  const sp = await searchParams;

  // Resolve the period: a named one wins; a bare from/to is a custom range; otherwise
  // the default. "thisYear" in the URL is accepted too and means the same as none.
  const today = todayLocal();
  const named = PERIODS.find((p) => p === sp.period);
  const custom = !named && Boolean(sp.from || sp.to);
  const period: Period | null = named ?? (custom ? null : DEFAULT_PERIOD);
  const range = period ? periodRange(period, today) : null;
  const filters = parseFilters({
    from: range ? (range.from ?? undefined) : sp.from,
    to: range ? (range.to ?? undefined) : sp.to,
    inactive: sp.inactive,
    group: sp.group,
  });

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;
  // Resolve disclosure against the selected farm. `users.role` only describes the
  // primary farm, and a failed database check must hide money rather than expose it.
  const costsVisible = await canViewFarmCosts(supabase, farmId);
  const canSchedule = role != null && ["owner", "manager", "rr_admin"].includes(role);
  const data = await getReportData(supabase, filters, farmId);

  // Every export and CSV carries the resolved dates, so a download always matches the
  // screen it was taken from, whatever "this month" means on the day it is opened.
  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    if (filters.includeInactive) p.set("inactive", "1");
    if (filters.group) p.set("group", filters.group);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  };
  const csvLink = (path: string) => (
    <a href={`${path}?${qs()}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>
      {t("reports.csv", locale)} ↓
    </a>
  );

  // == Filters ==========================================================================
  const dateRange = (from: string | null, to: string | null) =>
    from && to
      ? t("reports.periodRange", locale).replace("{from}", shortDate(from, locale)).replace("{to}", shortDate(to, locale))
      : from
        ? `${t("reports.from", locale)} ${shortDate(from, locale)}`
        : to
          ? `${t("reports.to", locale)} ${shortDate(to, locale)}`
          : t("reports.allTime", locale);
  const customLabel = dateRange(filters.from, filters.to);

  const groups: FilterGroup[] = [
    {
      paramName: "period",
      label: t("reports.period", locale),
      current: custom ? "custom" : period === DEFAULT_PERIOD ? "" : (period ?? ""),
      options: [
        ...(custom ? [{ value: "custom", label: customLabel }] : []),
        ...PERIODS.map((p) => ({ value: p === DEFAULT_PERIOD ? "" : p, label: t(PERIOD_LABEL[p], locale) })),
      ],
    },
  ];
  if (data.groups.length > 0) {
    groups.push({
      paramName: "group",
      label: t("reports.site", locale),
      current: filters.group ?? "",
      options: [
        { value: "", label: t("reports.allGroups", locale) },
        ...data.groups.map((g) => ({ value: g, label: g })),
      ],
    });
  }
  groups.push({
    paramName: "inactive",
    label: t("reports.machinesFilter", locale),
    current: filters.includeInactive ? "1" : "",
    options: [
      { value: "", label: t("reports.activeOnly", locale) },
      { value: "1", label: t("reports.includeInactive", locale) },
    ],
  });
  // The bar's links are built from this: a hand-made from/to is dropped by any chip, and
  // the tab is kept so changing the period does not throw the reader back to Costs.
  const barSearch = new URLSearchParams(
    Object.entries({ period: named ?? "", group: sp.group ?? "", inactive: sp.inactive ?? "", tab: sp.tab ?? "" }).filter(
      ([, v]) => v !== "",
    ),
  ).toString();

  // What the figures cover, stated under the title rather than inferred from a chip.
  const meta = [
    period ? `${t(PERIOD_LABEL[period], locale)}${period === "all" ? "" : `: ${dateRange(filters.from, filters.to)}`}` : customLabel,
    filters.group,
    filters.includeInactive ? t("reports.includeInactive", locale) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // == Header actions ===================================================================
  const exportMenu = (
    <ActionMenu
      title={t("reports.exportTitle", locale)}
      label={t("reports.export", locale)}
      closeLabel={t("ui.close", locale)}
      trigger={
        <>
          <DownloadIcon className="text-base" />
          {t("reports.export", locale)}
        </>
      }
    >
      {/* Single multi-sheet Excel workbook covering every report family (FR-11.4). */}
      {costsVisible ? (
        <a href={`/reports/workbook.xlsx?${qs()}`} className={menuItemClass()}>
          <DownloadIcon className="shrink-0 text-base text-sand-500" />
          {t("reports.downloadExcel", locale)}
        </a>
      ) : null}
      {/* GLOBALG.A.P. / SIZA audit pack (FR-13.4), fleet compliance summary PDF. */}
      <FleetCompliancePackLink locale={locale} look="menuItem" />
      <PrintMenuItem label={t("reports.print", locale)} />
    </ActionMenu>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {canSchedule ? (
        <Link href="/reports/schedules" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <MailIcon />
          {t("reportSchedules.title", locale)}
        </Link>
      ) : null}
      {exportMenu}
    </div>
  );

  const subLabel = "mb-1 text-xs font-semibold uppercase tracking-wide text-sand-500";

  // == Costs ============================================================================
  const costsTab = (
    <div className="flex flex-col gap-5">
      <Card flush>
        <CardHeader className="px-4 pt-4" action={csvLink("/reports/cost.csv")}>
          <CardTitle>{t("reports.costPerMachine", locale)}</CardTitle>
        </CardHeader>
        {data.costPerMachine.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-500">{t("reports.noCosts", locale)}</p>
        ) : (
          <div className="px-3 pb-3 lg:px-0 lg:pb-0">
            <Table stacked>
              <Thead>
                <Tr>
                  <Th>{t("reports.machine", locale)}</Th>
                  <Th className="text-right">{t("reports.parts", locale)}</Th>
                  <Th className="text-right">{t("reports.labour", locale)}</Th>
                  <Th className="text-right">{t("reports.other", locale)}</Th>
                  <Th className="text-right">{t("reports.spend", locale)}</Th>
                  <Th className="text-right">{t("reports.tco", locale)}</Th>
                  <Th className="text-right">{t("reports.perHour", locale)}</Th>
                  <Th className="text-right">{t("reports.perKm", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.costPerMachine.map((r) => (
                  <Tr key={r.machineId}>
                    <Td label={t("reports.machine", locale)} className="font-medium">
                      <Link href={`/machines/${r.machineId}`} className="focus-ring rounded text-brand-ink hover:underline">{r.name}</Link>
                    </Td>
                    <Td label={t("reports.parts", locale)} className="text-right tabular-nums">{rands(r.parts)}</Td>
                    <Td label={t("reports.labour", locale)} className="text-right tabular-nums">{rands(r.labour)}</Td>
                    <Td label={t("reports.other", locale)} className="text-right tabular-nums">{rands(r.other)}</Td>
                    <Td label={t("reports.spend", locale)} className="text-right tabular-nums">{rands(r.total)}</Td>
                    <Td label={t("reports.tco", locale)} className="text-right font-medium tabular-nums">{rands(r.tco)}</Td>
                    <Td label={t("reports.perHour", locale)} className="text-right tabular-nums">{r.perHour != null ? rands(r.perHour) : "-"}</Td>
                    <Td label={t("reports.perKm", locale)} className="text-right tabular-nums">{r.perKm != null ? rands(r.perKm) : "-"}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader action={csvLink("/reports/by-type.csv")}>
          <CardTitle>{t("reports.spendByType", locale)}</CardTitle>
        </CardHeader>
        <ul className="flex flex-col divide-y divide-sand-100 text-sm">
          {data.byType.map((r) => (
            <li key={r.type} className="flex justify-between gap-3 py-2">
              <span>{t(`jobType.${r.type}`, locale)}</span>
              <span className="font-medium tabular-nums">{rands(r.total)}</span>
            </li>
          ))}
          {data.byType.length === 0 ? <li className="py-2 text-sand-500">{t("reports.noCosts", locale)}</li> : null}
        </ul>
      </Card>

      {/* Budget vs actual (G1 · FR-10.4) */}
      <Card flush>
        <CardHeader className="px-4 pt-4" action={csvLink("/reports/budgets.csv")}>
          <CardTitle>{t("budget.reportTitle", locale)}</CardTitle>
        </CardHeader>
        {data.budgets.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-500">{t("budget.reportNone", locale)}</p>
        ) : (
          <div className="px-3 pb-3 lg:px-0 lg:pb-0">
            <Table stacked>
              <Thead>
                <Tr>
                  <Th>{t("budget.scope", locale)}</Th>
                  <Th>{t("budget.category", locale)}</Th>
                  <Th>{t("budget.periodCol", locale)}</Th>
                  <Th className="text-right">{t("budget.budget", locale)}</Th>
                  <Th className="text-right">{t("budget.actual", locale)}</Th>
                  <Th className="text-right">{t("budget.variance", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.budgets.map((b) => (
                  <Tr key={b.id}>
                    <Td label={t("budget.scope", locale)} className="font-medium">
                      {b.machineId ? (
                        <Link href={`/machines/${b.machineId}`} className="focus-ring rounded text-brand-ink hover:underline">{b.scope}</Link>
                      ) : (
                        t("budget.wholeFarm", locale)
                      )}
                    </Td>
                    <Td label={t("budget.category", locale)}>{budgetCategoryLabel(b.category, locale)}</Td>
                    <Td label={t("budget.periodCol", locale)} className="text-xs text-sand-500">
                      {budgetPeriodLabel(b.periodType, locale)} · {dateRange(b.periodStart, b.periodEnd)}
                    </Td>
                    <Td label={t("budget.budget", locale)} className="text-right tabular-nums">{rands(b.amount)}</Td>
                    <Td label={t("budget.actual", locale)} className="text-right tabular-nums">{rands(b.actual)}</Td>
                    <Td label={t("budget.variance", locale)} className="text-right">
                      <Badge tone={budgetTone(b.status)}>
                        {b.variance > 0 ? `+${rands(b.variance)}` : rands(-b.variance)}{b.pct != null ? ` · ${num(b.pct, 0)}%` : ""}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* The once-a-year question, gated on the same cost visibility as the workbook: a
          register built from purchase prices belongs behind the same door they do. */}
      <Link
        href="/reports/assets"
        className="focus-ring flex min-h-[48px] items-center justify-between gap-3 rounded-xl border border-sand-200 bg-surface px-4 py-3 hover:bg-sand-50 print:hidden"
      >
        <span className="min-w-0">
          <span className="block font-medium text-sand-900">{t("depreciation.reportsLink", locale)}</span>
          <span className="block text-sm text-sand-500">{t("reports.assetsLinkHint", locale)}</span>
        </span>
        <ChevronRightIcon className="shrink-0 text-lg text-sand-400" />
      </Link>
    </div>
  );

  // == Service ==========================================================================
  const serviceTab = (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader action={csvLink("/reports/compliance.csv")}>
          <CardTitle>{t("reports.serviceCompliance", locale)}</CardTitle>
        </CardHeader>
        <StatGrid columns={3}>
          <Stat size="md" label={t("reports.ok", locale)} value={data.compliance.ok} tone="ok" />
          <Stat size="md" label={t("reports.dueSoon", locale)} value={data.compliance.dueSoon} tone="due" />
          <Stat size="md" label={t("reports.overdue", locale)} value={data.compliance.overdue} tone="overdue" />
        </StatGrid>
        {data.compliance.overdueList.length > 0 ? (
          <div className="mt-4">
            <p className={subLabel}>{t("reports.overdueList", locale)}</p>
            <ul className="flex flex-col divide-y divide-sand-100 text-sm">
              {data.compliance.overdueList.slice(0, 8).map((o, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-x-3 py-2">
                  <span className="min-w-0 font-medium">{o.name}</span>
                  <span className="min-w-0 text-sand-500">{o.task}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader action={csvLink("/reports/problems.csv")}>
          <CardTitle>{t("reports.recurringProblems", locale)}</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {(
            [
              ["breaksMostOften", data.problems.breaksMostOften, false],
              ["topParts", data.problems.topParts, false],
              ["topFaults", data.problems.topFaults, true],
            ] as const
          ).map(([key, list, capitalise]) => (
            <div key={key} className="min-w-0">
              <p className={subLabel}>{t(`reports.${key}`, locale)}</p>
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {list.map((p, i) => (
                  <li key={i} className="flex justify-between gap-3 py-1.5">
                    <span className={`min-w-0 truncate${capitalise ? " capitalize" : ""}`}>{p.name}</span>
                    <span className="tabular-nums text-sand-500">{p.count}</span>
                  </li>
                ))}
                {list.length === 0 ? <li className="py-1.5 text-sand-500">{t("reports.nothingYet", locale)}</li> : null}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  // == Fuel =============================================================================
  const fuelTab = (
    <div className="flex flex-col gap-5">
      <Card flush>
        <CardHeader className="px-4 pt-4" action={costsVisible ? csvLink("/reports/fuel.csv") : null}>
          <CardTitle>{t("reports.fuel", locale)}</CardTitle>
        </CardHeader>
        <StatGrid columns={4} className="px-4">
          {costsVisible ? <Stat size="md" label={t("reports.fuelPurchased", locale)} value={rands(data.fuel.purchasedSpend)} /> : null}
          <Stat size="md" label={`${t("reports.fuelPurchased", locale)} (${t("fuel.litresShort", locale)})`} value={num(data.fuel.purchasedLitres, 0)} />
          {costsVisible ? <Stat size="md" label={t("reports.fuelUsed", locale)} value={rands(data.fuel.totalSpend)} /> : null}
          <Stat size="md" label={`${t("reports.fuelUsed", locale)} (${t("fuel.litresShort", locale)})`} value={num(data.fuel.totalLitres, 0)} />
        </StatGrid>
        {data.fuel.perMachine.length === 0 ? (
          <p className="px-4 pb-4 pt-3 text-sm text-sand-500">{t("fuel.noDraws", locale)}</p>
        ) : (
          <div className="mt-3 px-3 pb-3 lg:px-0 lg:pb-0">
            <Table stacked>
              <Thead>
                <Tr>
                  <Th>{t("reports.machine", locale)}</Th>
                  <Th className="text-right">{t("reports.fuelLitres", locale)}</Th>
                  {costsVisible ? <Th className="text-right">{t("reports.fuelSpend", locale)}</Th> : null}
                  <Th className="text-right">{t("reports.fuelConsumption", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.fuel.perMachine.map((r) => (
                  <Tr key={r.machineId}>
                    <Td label={t("reports.machine", locale)} className="font-medium">
                      <Link href={`/machines/${r.machineId}`} className="focus-ring rounded text-brand-ink hover:underline">{r.name}</Link>
                    </Td>
                    <Td label={t("reports.fuelLitres", locale)} className="text-right tabular-nums">{num(r.litres, 0)}</Td>
                    {costsVisible ? <Td label={t("reports.fuelSpend", locale)} className="text-right tabular-nums">{rands(r.spend)}</Td> : null}
                    <Td label={t("reports.fuelConsumption", locale)} className="text-right tabular-nums">
                      {r.consumption != null
                        ? `${num(r.consumption, 2)} ${r.meterType === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)}`
                        : "-"}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* SARS diesel logbooks (Scope §9). The module's whole argument is that a rebate
          claim stands or falls on the logbooks, so these are the two records an audit
          asks for, and the notice says plainly that they are a draft until an accountant
          has read them. We produce the records; the claim is the farmer's. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("reports.sarsTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm leading-relaxed text-sand-700">{t("reports.sarsBody", locale)}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row print:hidden">
          <a href={`/reports/sars-logbook.csv?${qs({ book: "storage" })}`} className={buttonVariants({ variant: "secondary" })}>
            {t("reports.sarsStorage", locale)} ↓
          </a>
          <a href={`/reports/sars-logbook.csv?${qs({ book: "usage" })}`} className={buttonVariants({ variant: "secondary" })}>
            {t("reports.sarsUsage", locale)} ↓
          </a>
        </div>
      </Card>
    </div>
  );

  // == Use and downtime (G1 · §23) ======================================================
  const usageTab = (
    <Card flush>
      <CardHeader className="px-4 pt-4" action={csvLink("/reports/utilisation.csv")}>
        <CardTitle>{t("util.reportTitle", locale)}</CardTitle>
      </CardHeader>
      <p className="px-4 text-xs text-sand-500">
        {t("util.windowRange", locale)
          .replace("{from}", shortDate(data.utilisation.window.from, locale))
          .replace("{to}", shortDate(data.utilisation.window.to, locale))}
      </p>
      {data.utilisation.perMachine.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-sand-500">{t("util.none", locale)}</p>
      ) : (
        <div className="mt-2 px-3 pb-3 lg:px-0 lg:pb-0">
          <Table stacked>
            <Thead>
              <Tr>
                <Th>{t("reports.machine", locale)}</Th>
                <Th className="text-right">{t("util.used", locale)}</Th>
                <Th className="text-right">{t("util.utilisation", locale)}</Th>
                <Th className="text-right">{t("util.idle", locale)}</Th>
                <Th className="text-right">{t("util.downtime", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.utilisation.perMachine.map((r) => {
                const unit = r.meterType === "km" ? t("machine.kmShort", locale) : t("machine.hrs", locale);
                const fmt = (v: number) => num(v, r.meterType === "km" ? 0 : 1);
                return (
                  <Tr key={r.machineId}>
                    <Td label={t("reports.machine", locale)} className="font-medium">
                      <Link href={`/machines/${r.machineId}`} className="focus-ring rounded text-brand-ink hover:underline">{r.name}</Link>
                    </Td>
                    <Td label={t("util.used", locale)} className="text-right tabular-nums">{r.used != null ? `${fmt(r.used)} ${unit}` : "-"}</Td>
                    <Td label={t("util.utilisation", locale)} className="text-right tabular-nums">{r.pct != null ? `${num(r.pct, 0)}%` : "-"}</Td>
                    <Td label={t("util.idle", locale)} className="text-right tabular-nums">{r.idle != null ? `${fmt(r.idle)} ${unit}` : "-"}</Td>
                    <Td label={t("util.downtime", locale)} className="text-right tabular-nums">{num(r.downtimeDays, 1)} {t("machine.daysShort", locale)}</Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </div>
      )}
    </Card>
  );

  // == Contractors (F13): outstanding value, throughput, responsiveness, spend ==========
  const contractorsTab = (
    <Card flush>
      <CardHeader className="px-4 pt-4" action={costsVisible ? csvLink("/reports/contractors.csv") : null}>
        <CardTitle>{t("reports.contractors", locale)}</CardTitle>
      </CardHeader>
      <StatGrid columns={4} className="px-4">
        <Stat
          size="md"
          label={t("reports.outstandingQuotes", locale)}
          value={data.contractors.outstandingQuotes.count}
          tone={data.contractors.outstandingQuotes.count > 0 ? "due" : "default"}
          delta={costsVisible ? rands(data.contractors.outstandingQuotes.value) : undefined}
        />
        <Stat
          size="md"
          label={t("reports.outstandingInvoices", locale)}
          value={data.contractors.outstandingInvoices.count}
          tone={data.contractors.outstandingInvoices.count > 0 ? "overdue" : "default"}
          delta={costsVisible ? rands(data.contractors.outstandingInvoices.value) : undefined}
        />
        {costsVisible ? <Stat size="md" label={t("reports.spendViaContractors", locale)} value={rands(data.contractors.spendViaContractors)} /> : null}
        <Stat
          size="md"
          label={t("reports.responsiveness", locale)}
          value={data.contractors.responsiveness.requestedToViewedHrs != null ? `${num(data.contractors.responsiveness.requestedToViewedHrs)} ${t("reports.hoursShort", locale)}` : "-"}
          delta={t("reports.toViewed", locale)}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-6 px-4 pb-4 pt-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className={subLabel}>{t("reports.throughput", locale)}</p>
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {data.contractors.byStatus.length === 0 ? (
              <li className="py-1.5 text-sand-500">{t("reports.nothingYet", locale)}</li>
            ) : (
              data.contractors.byStatus.map((s) => (
                <li key={s.status} className="flex justify-between gap-3 py-1.5">
                  <span>{t(`workStatus.${s.status}`, locale)}</span>
                  <span className="font-medium tabular-nums">{s.count}</span>
                </li>
              ))
            )}
          </ul>
          <p className="mt-3 text-xs text-sand-500">
            {t("reports.avgViewedToQuoted", locale)}:{" "}
            <span className="font-medium text-sand-700">
              {data.contractors.responsiveness.viewedToQuotedHrs != null
                ? `${num(data.contractors.responsiveness.viewedToQuotedHrs)} ${t("reports.hoursShort", locale)}`
                : "-"}
            </span>
            {data.contractors.responsiveness.sample > 0 ? (
              <span> · {t("reports.sampleN", locale).replace("{n}", String(data.contractors.responsiveness.sample))}</span>
            ) : null}
          </p>
        </div>

        <div className="min-w-0">
          <p className={subLabel}>{t("reports.perContractor", locale)}</p>
          {data.contractors.perContractor.length === 0 ? (
            <p className="py-1.5 text-sm text-sand-500">{t("reports.nothingYet", locale)}</p>
          ) : (
            <Table stacked>
              <Thead>
                <Tr>
                  <Th>{t("reports.contractor", locale)}</Th>
                  <Th className="text-right">{t("reports.requestsShort", locale)}</Th>
                  <Th className="text-right">{t("reports.invoicedShort", locale)}</Th>
                  {costsVisible ? <Th className="text-right">{t("reports.spend", locale)}</Th> : null}
                </Tr>
              </Thead>
              <Tbody>
                {data.contractors.perContractor.map((c) => (
                  <Tr key={c.workshopId}>
                    <Td label={t("reports.contractor", locale)} className="font-medium">{c.name}</Td>
                    <Td label={t("reports.requestsShort", locale)} className="text-right tabular-nums">{c.requests}</Td>
                    <Td label={t("reports.invoicedShort", locale)} className="text-right tabular-nums">{c.invoiced}</Td>
                    {costsVisible ? <Td label={t("reports.spend", locale)} className="text-right tabular-nums">{rands(c.spend)}</Td> : null}
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      </div>
    </Card>
  );

  const tabs = [
    ...(costsVisible ? [{ key: "costs", label: t("reports.tabCosts", locale), content: costsTab }] : []),
    { key: "service", label: t("reports.tabService", locale), content: serviceTab },
    { key: "fuel", label: t("reports.fuel", locale), content: fuelTab },
    { key: "usage", label: t("reports.tabUsage", locale), content: usageTab },
    { key: "contractors", label: t("reports.contractors", locale), content: contractorsTab },
  ];
  const tabKeys = tabs.map((x) => x.key);

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("reports.title", locale)}
        meta={meta}
        infoKey="reports"
        locale={locale}
        actions={actions}
      />

      <div className="print:hidden">
        <FilterBar
          path="/reports"
          search={barSearch}
          groups={groups}
          filtersLabel={t("filters.filters", locale)}
          clearLabel={t("filters.clearAll", locale)}
          rememberKey="reports"
        />
      </div>

      {!costsVisible ? (
        <p className="rounded-xl border border-sand-200 bg-sand-100 px-4 py-3 text-sm text-sand-700" role="status">
          {t("reports.costsHidden", locale)}
        </p>
      ) : null}

      <Tabs param="tab" defaultTab={readTab(sp.tab, tabKeys)} tabs={tabs} />
    </PageContainer>
  );
}
