import Link from "next/link";
import {
  requireProfile, currentWorkshop, currentFarmId,
  checkEntitlement, checkWorkshopEntitlement,
} from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { moneyPeriods } from "@/lib/money-report";
import {
  journalTotals, accountSummary, accountName, chartFor,
  isJournalLayout, type JournalLine, type JournalScope, type JournalLayout,
} from "@/lib/accounting";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { DownloadIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * Hand the books to an accountant (FR-17.2).
 *
 * One route, two audiences — the same shape as /documents. A partner gets the journal
 * over what they invoiced, were paid and bought; a farm gets the journal over its cost
 * ledger. Which one you are is decided by your role, not by a query parameter.
 *
 * The screen leads with what is IN the file rather than a download button, because the
 * person pressing it is about to email it to somebody who will bill them for the
 * confusion. So: the totals, the per-account movement, and the whole chart of accounts
 * laid out before anything is downloaded.
 *
 * It also says, in words, that the file is a GENERIC journal and not a Sage or Xero
 * one — see the finding recorded at the top of src/lib/accounting.ts. Nobody should
 * discover that at their accountant's desk.
 */
export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;

  const scope: JournalScope = profile.role === "workshop" ? "partner" : "farm";
  const layout: JournalLayout = isJournalLayout(sp.layout) ? sp.layout : "dc";

  // Gated BEFORE any query runs, so a denied user never causes the books to be read.
  // The partner side is the `books` product (0492); the farm side is Professional+
  // (0251), the same rung the rest of the reporting sits on.
  if (scope === "partner") {
    const gate = await checkWorkshopEntitlement("financials", profile);
    if (!gate.allowed) {
      return (
        <div className="mx-auto w-full max-w-3xl">
          <UpgradeNotice feature="financials" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
        </div>
      );
    }
  } else {
    const gate = await checkEntitlement("advanced_reports", profile);
    if (!gate.allowed) {
      return (
        <div className="mx-auto w-full max-w-3xl">
          <UpgradeNotice feature="advanced_reports" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
        </div>
      );
    }
  }

  // Calendar periods, like /money: "give my accountant last month" is a calendar
  // question. The VAT screen's SARS cycles belong on the VAT screen.
  const periods = moneyPeriods();
  const chosen = periods.find((p) => p.from === sp.from && p.to === sp.to);
  const from = chosen?.from ?? periods[1].from;
  const to = chosen?.to ?? periods[1].to;

  const supabase = await createClient();
  let lines: JournalLine[] = [];
  let subjectName: string | null = null;

  if (scope === "partner") {
    const { workshop } = await currentWorkshop(profile);
    if (workshop) {
      subjectName = workshop.trading_name ?? workshop.name ?? null;
      const { data } = await supabase.rpc("partner_journal", {
        p_workshop: workshop.id, p_from: from, p_to: to,
      });
      lines = (data ?? []) as JournalLine[];
    }
  } else {
    const farmId = await currentFarmId(profile);
    if (farmId) {
      const [{ data }, { data: farm }] = await Promise.all([
        supabase.rpc("farm_journal", { p_farm: farmId, p_from: from, p_to: to }),
        supabase.from("farms").select("name").eq("id", farmId).maybeSingle(),
      ]);
      lines = (data ?? []) as JournalLine[];
      subjectName = (farm as { name: string } | null)?.name ?? null;
    }
  }

  const totals = journalTotals(lines);
  const summary = accountSummary(lines);
  const q = `scope=${scope}&from=${from}&to=${to}`;
  const chart = chartFor(scope);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("accounting.title", locale)}</h1>
          <p className="text-sm text-sand-600">
            {subjectName
              ? t("accounting.leadFor", locale).replace("{name}", subjectName)
              : t("accounting.lead", locale)}
          </p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="accounting" locale={locale} />
        </span>
      </div>

      {/* The finding, said before anything is downloaded rather than after. */}
      <Card>
        <CardHeader><CardTitle>{t("accounting.genericTitle", locale)}</CardTitle></CardHeader>
        <p className="text-sm text-sand-600">{t("accounting.genericBody", locale)}</p>
        <p className="mt-2 text-sm text-sand-600">{t("accounting.genericHow", locale)}</p>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("accounting.periodTitle", locale)}</CardTitle></CardHeader>
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.key}
                href={`/accounting?from=${p.from}&to=${p.to}&layout=${layout}`}
                aria-current={active ? "true" : undefined}
                className={buttonVariants({ variant: active ? "primary" : "secondary", size: "sm" })}
              >
                {t(`money.period.${p.key}`, locale)}
              </Link>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-sand-600">
          {shortDate(from, locale)} – {shortDate(to, locale)}
        </p>
      </Card>

      {lines.length === 0 ? (
        <AllClear title={t("accounting.emptyTitle", locale)} hint={t("accounting.emptyHint", locale)} />
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>{t("accounting.totalsTitle", locale)}</CardTitle></CardHeader>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t("accounting.totalDebit", locale)} value={rands(totals.debit)} />
              <Stat label={t("accounting.totalCredit", locale)} value={rands(totals.credit)} />
              <Stat label={t("accounting.entries", locale)} value={String(totals.entries)} />
              <Stat label={t("accounting.lines", locale)} value={String(totals.lines)} />
            </div>
            {/* Should never fire. It is here because the moment it does, the person
                about to email this to an accountant is the person who needs to know. */}
            {totals.unbalanced.length > 0 ? (
              <p className="mt-3 rounded-lg border border-status-overdue/40 bg-status-overdue/10 px-3 py-2 text-sm text-sand-800">
                {t("accounting.unbalanced", locale).replace("{count}", String(totals.unbalanced.length))}
              </p>
            ) : (
              <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-600">
                {t("accounting.balanced", locale)}
              </p>
            )}
            <p className="mt-2 text-sm text-sand-600">{t("accounting.basisNote", locale)}</p>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("accounting.byAccountTitle", locale)}</CardTitle></CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <Thead>
                  <Tr>
                    <Th>{t("accounting.colAccountCode", locale)}</Th>
                    <Th>{t("accounting.colAccount", locale)}</Th>
                    <Th className="text-right">{t("accounting.colDebit", locale)}</Th>
                    <Th className="text-right">{t("accounting.colCredit", locale)}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {summary.map((a) => (
                    <Tr key={a.key}>
                      <Td className="tabular-nums text-sand-500">{a.code}</Td>
                      <Td>{accountName(a.key, locale)}</Td>
                      <Td className="text-right tabular-nums">{a.debit ? rands(a.debit) : "—"}</Td>
                      <Td className="text-right tabular-nums">{a.credit ? rands(a.credit) : "—"}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </Card>
        </>
      )}

      <Card>
        <CardHeader><CardTitle>{t("accounting.downloadTitle", locale)}</CardTitle></CardHeader>
        <p className="text-sm text-sand-600">{t("accounting.layoutBody", locale)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`/api/accounting/journal.csv?${q}&layout=dc`}
            className={buttonVariants({ variant: "primary", size: "sm" })}
          >
            <DownloadIcon /> {t("accounting.downloadDc", locale)}
          </a>
          <a
            href={`/api/accounting/journal.csv?${q}&layout=signed`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <DownloadIcon /> {t("accounting.downloadSigned", locale)}
          </a>
          <a
            href={`/api/accounting/chart.csv?scope=${scope}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <DownloadIcon /> {t("accounting.downloadChart", locale)}
          </a>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("accounting.chartTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("accounting.chartBody", locale)}</p>
        <div className="overflow-x-auto">
          <Table>
            <Thead>
              <Tr>
                <Th>{t("accounting.colAccountCode", locale)}</Th>
                <Th>{t("accounting.colAccount", locale)}</Th>
                <Th>{t("accounting.colAccountType", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {chart.map((a) => (
                <Tr key={a.key}>
                  <Td className="tabular-nums text-sand-500">{a.code}</Td>
                  <Td>{accountName(a.key, locale)}</Td>
                  <Td>
                    <Badge tone="neutral">{t(`accounting.kind.${a.kind}`, locale)}</Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
