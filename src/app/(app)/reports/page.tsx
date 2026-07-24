import Link from "next/link";
import { checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { getReportData, parseFilters } from "./data";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Stat } from "@/components/ui/stat";
import { buttonVariants } from "@/components/ui/button";
import { PrintButton } from "@/components/print-button";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; inactive?: string; group?: string }>;
}) {
  // Advanced reports are a Professional+ feature (FR-19.2). Deny server-side for
  // under-plan farms — report data is never computed; an upgrade prompt shows instead.
  const gate = await checkEntitlement("advanced_reports");
  const profile = gate.profile;
  const locale = profile.language;
  if (!gate.allowed) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("reports.title", locale)}</h1>
        <UpgradeNotice
          feature="advanced_reports"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  const data = await getReportData(supabase, filters, farmId);

  const now = new Date();
  const today = ymd(now);
  const presets = [
    { key: "thisMonth", from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today },
    { key: "last3", from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: today },
    { key: "thisYear", from: ymd(new Date(now.getFullYear(), 0, 1)), to: today },
    { key: "allTime", from: null as string | null, to: null as string | null },
  ];
  const activePreset = presets.find((p) => (p.from ?? null) === filters.from && (p.to ?? null) === filters.to)?.key ?? null;

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    if (filters.includeInactive) p.set("inactive", "1");
    if (filters.group) p.set("group", filters.group);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  };
  const presetHref = (p: (typeof presets)[number]) => {
    const params = new URLSearchParams();
    if (p.from) params.set("from", p.from);
    if (p.to) params.set("to", p.to);
    if (filters.includeInactive) params.set("inactive", "1");
    if (filters.group) params.set("group", filters.group);
    return `/reports?${params.toString()}`;
  };
  const toggleInactiveHref = () => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (!filters.includeInactive) params.set("inactive", "1");
    if (filters.group) params.set("group", filters.group);
    return `/reports?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("reports.title", locale)}</h1>
        <PrintButton label={t("reports.print", locale)} />
      </div>

      {/* Period + toggles */}
      <Card className="print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-sand-600">{t("reports.period", locale)}:</span>
          {presets.map((p) => (
            <Link
              key={p.key}
              href={presetHref(p)}
              className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium ${activePreset === p.key ? "bg-brand-600 text-white" : "bg-sand-100 text-sand-700 hover:bg-sand-200"}`}
            >
              {t(`reports.${p.key}`, locale)}
            </Link>
          ))}
          <Link
            href={toggleInactiveHref()}
            className={`focus-ring ml-auto rounded-full px-3 py-1.5 text-sm font-medium ${filters.includeInactive ? "bg-brand-600 text-white" : "bg-sand-100 text-sand-700 hover:bg-sand-200"}`}
          >
            {t("reports.includeInactive", locale)}
          </Link>
        </div>
        {data.groups.length > 0 ? (
          <form method="get" action="/reports" className="mt-3 flex flex-wrap items-center gap-2 border-t border-sand-100 pt-3">
            {filters.from ? <input type="hidden" name="from" value={filters.from} /> : null}
            {filters.to ? <input type="hidden" name="to" value={filters.to} /> : null}
            {filters.includeInactive ? <input type="hidden" name="inactive" value="1" /> : null}
            <span className="text-sm font-medium text-sand-600">{t("reports.site", locale)}:</span>
            <select
              name="group"
              defaultValue={filters.group ?? ""}
              className="focus-ring rounded-lg border border-sand-300 px-3 py-1.5 text-sm"
            >
              <option value="">{t("reports.allGroups", locale)}</option>
              {data.groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>{t("reports.apply", locale)}</button>
          </form>
        ) : null}
      </Card>

      {/* Cost per machine */}
      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            <a href={`/reports/cost.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>
              {t("reports.csv", locale)} ↓
            </a>
          }
        >
          <CardTitle>{t("reports.costPerMachine", locale)}</CardTitle>
        </CardHeader>
        {data.costPerMachine.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-500">{t("reports.noCosts", locale)}</p>
        ) : (
          <Table>
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
                  <Td className="font-medium">
                    <Link href={`/machines/${r.machineId}`} className="focus-ring rounded text-brand-700 hover:underline">{r.name}</Link>
                  </Td>
                  <Td className="text-right">{rands(r.parts)}</Td>
                  <Td className="text-right">{rands(r.labour)}</Td>
                  <Td className="text-right">{rands(r.other)}</Td>
                  <Td className="text-right">{rands(r.total)}</Td>
                  <Td className="text-right font-medium">{rands(r.tco)}</Td>
                  <Td className="text-right">{r.perHour != null ? rands(r.perHour) : "—"}</Td>
                  <Td className="text-right">{r.perKm != null ? rands(r.perKm) : "—"}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Spend by type */}
        <Card>
          <CardHeader
            action={<a href={`/reports/by-type.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>{t("reports.csv", locale)} ↓</a>}
          >
            <CardTitle>{t("reports.spendByType", locale)}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {data.byType.map((r) => (
              <li key={r.type} className="flex justify-between py-1.5"><span className="capitalize">{t(`jobType.${r.type}`, locale)}</span><span className="font-medium">{rands(r.total)}</span></li>
            ))}
            {data.byType.length === 0 ? <li className="py-1.5 text-sand-400">{t("reports.none", locale)}</li> : null}
          </ul>
        </Card>

        {/* Service compliance */}
        <Card>
          <CardHeader
            action={<a href={`/reports/compliance.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>{t("reports.csv", locale)} ↓</a>}
          >
            <CardTitle>{t("reports.serviceCompliance", locale)}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-3 gap-2">
            <Stat label={t("reports.ok", locale)} value={data.compliance.ok} tone="ok" />
            <Stat label={t("reports.dueSoon", locale)} value={data.compliance.dueSoon} tone="due" />
            <Stat label={t("reports.overdue", locale)} value={data.compliance.overdue} tone="overdue" />
          </div>
          {data.compliance.overdueList.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.overdueList", locale)}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {data.compliance.overdueList.slice(0, 8).map((o, i) => (
                  <li key={i} className="flex justify-between"><span>{o.name}</span><span className="text-sand-500">{o.task}</span></li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {/* Recurring problems */}
        <Card className="lg:col-span-2">
          <CardHeader
            action={<a href={`/reports/problems.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>{t("reports.csv", locale)} ↓</a>}
          >
            <CardTitle>{t("reports.recurringProblems", locale)}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.breaksMostOften", locale)}</p>
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {data.problems.breaksMostOften.map((p, i) => (
                  <li key={i} className="flex justify-between py-1"><span className="truncate">{p.name}</span><span className="text-sand-500">{p.count}</span></li>
                ))}
                {data.problems.breaksMostOften.length === 0 ? <li className="py-1 text-sand-400">{t("reports.none", locale)}</li> : null}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.topParts", locale)}</p>
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {data.problems.topParts.map((p, i) => (
                  <li key={i} className="flex justify-between py-1"><span className="truncate">{p.name}</span><span className="text-sand-500">{p.count}</span></li>
                ))}
                {data.problems.topParts.length === 0 ? <li className="py-1 text-sand-400">{t("reports.none", locale)}</li> : null}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.topFaults", locale)}</p>
              <ul className="flex flex-col divide-y divide-sand-100 text-sm">
                {data.problems.topFaults.map((p, i) => (
                  <li key={i} className="flex justify-between py-1"><span className="truncate capitalize">{p.name}</span><span className="text-sand-500">{p.count}</span></li>
                ))}
                {data.problems.topFaults.length === 0 ? <li className="py-1 text-sand-400">{t("reports.none", locale)}</li> : null}
              </ul>
            </div>
          </div>
        </Card>
      </div>

      {/* Fuel */}
      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            <a href={`/reports/fuel.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>
              {t("reports.csv", locale)} ↓
            </a>
          }
        >
          <CardTitle>{t("reports.fuel", locale)}</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-4">
          <Stat label={t("reports.fuelPurchased", locale)} value={rands(data.fuel.purchasedSpend)} />
          <Stat label={`${t("reports.fuelPurchased", locale)} (${t("fuel.litresShort", locale)})`} value={data.fuel.purchasedLitres.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} />
          <Stat label={t("reports.fuelUsed", locale)} value={rands(data.fuel.totalSpend)} />
          <Stat label={`${t("reports.fuelUsed", locale)} (${t("fuel.litresShort", locale)})`} value={data.fuel.totalLitres.toLocaleString("en-ZA", { maximumFractionDigits: 0 })} />
        </div>
        {data.fuel.perMachine.length === 0 ? (
          <p className="px-4 pb-4 pt-3 text-sm text-sand-500">{t("fuel.noDraws", locale)}</p>
        ) : (
          <div className="mt-3">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("reports.machine", locale)}</Th>
                  <Th className="text-right">{t("reports.fuelLitres", locale)}</Th>
                  <Th className="text-right">{t("reports.fuelSpend", locale)}</Th>
                  <Th className="text-right">{t("reports.fuelConsumption", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.fuel.perMachine.map((r) => (
                  <Tr key={r.machineId}>
                    <Td className="font-medium">
                      <Link href={`/machines/${r.machineId}`} className="focus-ring rounded text-brand-700 hover:underline">{r.name}</Link>
                    </Td>
                    <Td className="text-right tabular-nums">{r.litres.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}</Td>
                    <Td className="text-right tabular-nums">{rands(r.spend)}</Td>
                    <Td className="text-right tabular-nums">
                      {r.consumption != null
                        ? `${r.consumption.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} ${r.meterType === "km" ? t("fuel.perKm", locale) : t("fuel.perHr", locale)}`
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* Contractors (F13) — outstanding value, throughput, responsiveness, spend */}
      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            <a href={`/reports/contractors.csv?${qs({})}`} className={`${buttonVariants({ variant: "ghost", size: "sm" })} print:hidden`}>
              {t("reports.csv", locale)} ↓
            </a>
          }
        >
          <CardTitle>{t("reports.contractors", locale)}</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-4">
          <Stat label={t("reports.outstandingQuotes", locale)} value={data.contractors.outstandingQuotes.count} tone={data.contractors.outstandingQuotes.count > 0 ? "due" : "default"} delta={rands(data.contractors.outstandingQuotes.value)} />
          <Stat label={t("reports.outstandingInvoices", locale)} value={data.contractors.outstandingInvoices.count} tone={data.contractors.outstandingInvoices.count > 0 ? "overdue" : "default"} delta={rands(data.contractors.outstandingInvoices.value)} />
          <Stat label={t("reports.spendViaContractors", locale)} value={rands(data.contractors.spendViaContractors)} />
          <Stat
            label={t("reports.responsiveness", locale)}
            value={data.contractors.responsiveness.requestedToViewedHrs != null ? `${data.contractors.responsiveness.requestedToViewedHrs} ${t("reports.hoursShort", locale)}` : "—"}
            delta={t("reports.toViewed", locale)}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 px-4 pb-4 pt-4 lg:grid-cols-2">
          {/* Throughput by status */}
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.throughput", locale)}</p>
            <ul className="flex flex-col divide-y divide-sand-100 text-sm">
              {data.contractors.byStatus.length === 0 ? (
                <li className="py-1.5 text-sand-400">{t("reports.none", locale)}</li>
              ) : (
                data.contractors.byStatus.map((s) => (
                  <li key={s.status} className="flex justify-between py-1.5">
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
                  ? `${data.contractors.responsiveness.viewedToQuotedHrs} ${t("reports.hoursShort", locale)}`
                  : "—"}
              </span>
              {data.contractors.responsiveness.sample > 0 ? (
                <span className="text-sand-400"> · {t("reports.sampleN", locale).replace("{n}", String(data.contractors.responsiveness.sample))}</span>
              ) : null}
            </p>
          </div>

          {/* Per contractor */}
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-400">{t("reports.perContractor", locale)}</p>
            {data.contractors.perContractor.length === 0 ? (
              <p className="py-1.5 text-sm text-sand-400">{t("reports.none", locale)}</p>
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>{t("reports.contractor", locale)}</Th>
                    <Th className="text-right">{t("reports.requestsShort", locale)}</Th>
                    <Th className="text-right">{t("reports.invoicedShort", locale)}</Th>
                    <Th className="text-right">{t("reports.spend", locale)}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {data.contractors.perContractor.map((c) => (
                    <Tr key={c.workshopId}>
                      <Td className="font-medium">{c.name}</Td>
                      <Td className="text-right tabular-nums">{c.requests}</Td>
                      <Td className="text-right tabular-nums">{c.invoiced}</Td>
                      <Td className="text-right tabular-nums">{rands(c.spend)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
