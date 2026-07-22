import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { getReportData, parseFilters } from "./data";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Stat } from "@/components/ui/stat";
import { buttonVariants } from "@/components/ui/button";
import { PrintButton } from "@/components/print-button";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; inactive?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.language;
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const supabase = await createClient();
  const data = await getReportData(supabase, filters);

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
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  };
  const presetHref = (p: (typeof presets)[number]) => {
    const params = new URLSearchParams();
    if (p.from) params.set("from", p.from);
    if (p.to) params.set("to", p.to);
    if (filters.includeInactive) params.set("inactive", "1");
    return `/reports?${params.toString()}`;
  };
  const toggleInactiveHref = () => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (!filters.includeInactive) params.set("inactive", "1");
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
                <Th className="text-right">{t("reports.total", locale)}</Th>
                <Th className="text-right">{t("reports.perHour", locale)}</Th>
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
                  <Td className="text-right font-medium">{rands(r.total)}</Td>
                  <Td className="text-right">{r.perHour != null ? rands(r.perHour) : "—"}</Td>
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
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
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
    </div>
  );
}
