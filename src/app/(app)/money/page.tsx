import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  moneyPeriods, ageingTotal, seriouslyOverdue, ratePercent, EMPTY_PL, EMPTY_CONVERSION,
  type Pl, type Debtor, type Creditor, type Cash, type QuoteConversion,
} from "@/lib/money-report";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { AllClear } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { PeriodChips } from "@/components/books/period-chips";
import { RememberView } from "@/components/books/remember-view";

export const dynamic = "force-dynamic";

/**
 * Did this month make money, who owes me, and who do I owe (0460).
 *
 * The commercial layer could raise an invoice, correct it, chase it on a statement and
 * file the VAT on it, and never answer the three questions a business is actually run
 * on. Everything here is an aggregation over data that already existed; the work was
 * deciding what the numbers MEAN, and those decisions live in SQL (see 0460) so that this
 * screen, a CSV and a PDF cannot drift apart.
 *
 * Ordered by what gets acted on. Profit first because it is the reason to look; cash
 * second because a profitable month can still be one you cannot pay wages in; then the
 * two lists that turn into phone calls.
 */
export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/dashboard");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Running the books here is the `books` product (0492). Denied BEFORE any query runs,
  // so a partner without it never causes the data to be read, let alone rendered.
  const gate = await checkWorkshopEntitlement("financials", profile);
  if (!gate.allowed) {
    return (
      <PageContainer size="narrow">
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </PageContainer>
    );
  }

  const periods = moneyPeriods();
  const chosen = periods.find((p) => p.from === sp.from && p.to === sp.to);
  const from = chosen?.from ?? sp.from ?? periods[0].from;
  const to = chosen?.to ?? sp.to ?? periods[0].to;

  const supabase = await createClient();
  const [
    { data: plData }, { data: breakdownData }, { data: debtorData },
    { data: creditorData }, { data: cashData }, { data: convData },
  ] = await Promise.all([
    supabase.rpc("partner_pl", { p_workshop: workshop.id, p_from: from, p_to: to }),
    supabase.rpc("partner_expense_breakdown", { p_workshop: workshop.id, p_from: from, p_to: to }),
    supabase.rpc("partner_debtors", { p_workshop: workshop.id }),
    supabase.rpc("partner_creditors", { p_workshop: workshop.id }),
    supabase.rpc("partner_cash", { p_workshop: workshop.id, p_from: from, p_to: to }),
    supabase.rpc("partner_quote_conversion", { p_workshop: workshop.id, p_from: from, p_to: to }),
  ]);

  const pl = (((plData ?? []) as Pl[])[0] ?? EMPTY_PL);
  const breakdown = (breakdownData ?? []) as { category: string; cost_cents: number }[];
  const debtors = (debtorData ?? []) as Debtor[];
  const creditors = (creditorData ?? []) as Creditor[];
  const cash = (((cashData ?? []) as Cash[])[0] ?? { in_cents: 0, out_cents: 0, net_cents: 0 });
  const conv = (((convData ?? []) as QuoteConversion[])[0] ?? EMPTY_CONVERSION);

  const owed = ageingTotal(debtors, "total_cents");
  const late = seriouslyOverdue(debtors);
  const owing = ageingTotal(creditors, "total_cents");
  const profitable = pl.profit_cents >= 0;

  // The period is remembered per device: the chips are links carrying from/to, and a
  // visit with neither reopens the last period chosen here. A from/to that is not one of
  // the chips (a link from elsewhere) is shown but neither remembered nor forgotten.
  const urlChose = Boolean(sp.from || sp.to);
  const periodHrefs: Record<string, string> = Object.fromEntries(
    periods.map((p) => [p.key, `/money?from=${p.from}&to=${p.to}`]),
  );
  const range = t("books.range", locale)
    .replace("{from}", shortDate(from, locale))
    .replace("{to}", shortDate(to, locale));

  return (
    <PageContainer>
      <PageHeader
        title={t("money.title", locale)}
        lead={t("money.lead", locale)}
        meta={range}
        infoKey="money"
        locale={locale}
      />
      {chosen || !urlChose ? (
        <RememberView storageKey="money-period" value={chosen ? chosen.key : null} restore={periodHrefs} />
      ) : null}

      <div className="flex flex-col gap-2">
        <PeriodChips
          label={t("money.periodTitle", locale)}
          items={periods.map((p) => ({
            key: p.key,
            href: periodHrefs[p.key],
            label: t(`money.period.${p.key}`, locale),
            active: p.from === from && p.to === to,
          }))}
        />
        <p className="text-sm text-sand-600">{t("money.basis", locale)}</p>
      </div>

      {/* Did it make money. The one number the screen exists for, so it comes first and
          largest; how it was made up sits right under it. */}
      <Card>
        <CardHeader>
          <CardTitle>{profitable ? t("money.profitTitle", locale) : t("money.lossTitle", locale)}</CardTitle>
        </CardHeader>
        <p className={`text-3xl font-bold tabular-nums ${profitable ? "text-sand-900" : "text-status-overdue"}`}>
          {rands(Math.abs(pl.profit_cents))}
        </p>
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm sm:max-w-md">
          <dt className="text-sand-600">{t("money.revenue", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-900">{rands(pl.revenue_ex_cents)}</dd>

          {pl.bad_debt_ex_cents > 0 ? (
            <>
              <dt className="text-sand-600">{t("money.badDebt", locale)}</dt>
              <dd className="text-right tabular-nums text-status-warn">−{rands(pl.bad_debt_ex_cents)}</dd>
            </>
          ) : null}

          <dt className="text-sand-600">{t("money.costs", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-900">−{rands(pl.cost_cents)}</dd>

          {pl.blocked_vat_cents > 0 ? (
            <>
              <dt className="pl-4 text-xs text-sand-500">{t("money.blockedVat", locale)}</dt>
              <dd className="text-right text-xs tabular-nums text-sand-500">{rands(pl.blocked_vat_cents)}</dd>
            </>
          ) : null}

          <dt className="mt-1 border-t border-sand-200 pt-1 font-medium text-sand-900">
            {profitable ? t("money.profit", locale) : t("money.loss", locale)}
          </dt>
          <dd className="mt-1 border-t border-sand-200 pt-1 text-right font-semibold tabular-nums text-sand-900">
            {rands(pl.profit_cents)}
          </dd>
        </dl>

        {breakdown.length > 0 ? (
          <div className="mt-4 sm:max-w-md">
            <p className="mb-2 text-sm font-medium text-sand-700">{t("money.whereItWent", locale)}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {breakdown.map((b) => (
                <li key={b.category} className="flex items-baseline gap-2">
                  <span className="min-w-0 text-sand-700">{t(`expenseCategory.${b.category}`, locale)}</span>
                  <span className="ml-auto whitespace-nowrap tabular-nums text-sand-900">{rands(b.cost_cents)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {/* Cash is not profit */}
      <StatGrid columns={3}>
        <Stat size="md" label={t("money.cashIn", locale)} value={rands(cash.in_cents)} />
        <Stat size="md" label={t("money.cashOut", locale)} value={rands(cash.out_cents)} />
        <Stat
          size="md"
          label={t("money.cashNet", locale)}
          value={rands(cash.net_cents)}
          tone={cash.net_cents < 0 ? "due" : "default"}
          delta={t("money.cashHint", locale)}
        />
      </StatGrid>

      {/* Who owes me, then who I owe: the two lists that turn into phone calls. */}
      <Card>
        <CardHeader><CardTitle>{t("money.owedTitle", locale)}</CardTitle></CardHeader>
        {debtors.length === 0 ? (
          <AllClear title={t("money.owedNoneTitle", locale)} hint={t("money.owedNoneBody", locale)} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums text-sand-900">{rands(owed)}</span>
              {late > 0 ? (
                <Badge tone="danger" wrap>{t("money.lateBadge", locale).replace("{amount}", rands(late))}</Badge>
              ) : null}
            </div>
            <AgeingTable
              rows={debtors.map((d) => ({ label: d.party_label, ...d }))}
              locale={locale}
              nameHeader={t("money.colCustomer", locale)}
            />
          </>
        )}
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("money.owingTitle", locale)}</CardTitle></CardHeader>
        {creditors.length === 0 ? (
          <AllClear title={t("money.owingNoneTitle", locale)} hint={t("money.owingNoneBody", locale)} />
        ) : (
          <>
            <p className="mb-3 text-2xl font-bold tabular-nums text-sand-900">{rands(owing)}</p>
            <AgeingTable
              rows={creditors.map((c) => ({ label: c.supplier, ...c }))}
              locale={locale}
              nameHeader={t("money.colSupplier", locale)}
            />
            <p className="mt-2 text-xs text-sand-500">{t("money.owingAgeNote", locale)}</p>
          </>
        )}
      </Card>

      {/* How much of what I quoted turned into work. Worth knowing, not what the screen
          is opened for, so it follows the money owed rather than interrupting it. */}
      {conv.sent_count > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("money.quotesTitle", locale)}</CardTitle></CardHeader>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums text-sand-900">{ratePercent(conv.rate_bps)}</span>
            <span className="min-w-0 text-sm text-sand-600">
              {t("money.quotesRateHint", locale)
                .replace("{converted}", String(conv.converted_count))
                .replace("{sent}", String(conv.sent_count))}
            </span>
          </div>
          {/* Two rates, because neither is honest alone: the first understates a period
              whose quotes are still out, the second flatters a partner sitting on quotes
              nobody ever answered. */}
          <p className="mt-1 text-sm text-sand-600">
            {t("money.quotesDecidedHint", locale).replace("{rate}", ratePercent(conv.decided_rate_bps))}
          </p>
          <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm sm:max-w-md">
            <dt className="text-sand-600">{t("money.quotesConverted", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-900">
              {conv.converted_count} · {rands(conv.converted_cents)}
            </dd>
            <dt className="text-sand-600">{t("money.quotesOpen", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-900">
              {conv.open_count} · {rands(conv.open_cents)}
            </dd>
            <dt className="text-sand-600">{t("money.quotesDeclined", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-700">
              {conv.declined_count} · {rands(conv.declined_cents)}
            </dd>
            <dt className="text-sand-600">{t("money.quotesExpired", locale)}</dt>
            <dd className="text-right tabular-nums text-status-warn">
              {conv.expired_count} · {rands(conv.expired_cents)}
            </dd>
          </dl>
          {conv.expired_count > 0 ? (
            <p className="mt-2 text-xs text-sand-500">{t("money.quotesExpiredNote", locale)}</p>
          ) : null}
        </Card>
      ) : null}
    </PageContainer>
  );
}

/** Both ageing tables are the same shape, so they are the same component. */
function AgeingTable({
  rows,
  locale,
  nameHeader,
}: {
  rows: { label: string; current_cents: number; d30_cents: number; d60_cents: number; d90_cents: number; total_cents: number }[];
  locale: Parameters<typeof t>[1];
  nameHeader: string;
}) {
  return (
      <Table stacked className="lg:min-w-[34rem]">
        <Thead>
          <Tr className="text-left text-sand-500">
            <Th className="font-medium">{nameHeader}</Th>
            <Th className="text-right font-medium">{t("money.bucketCurrent", locale)}</Th>
            <Th className="text-right font-medium">{t("money.bucket30", locale)}</Th>
            <Th className="text-right font-medium">{t("money.bucket60", locale)}</Th>
            <Th className="text-right font-medium">{t("money.bucket90", locale)}</Th>
            <Th className="text-right font-medium">{t("money.bucketTotal", locale)}</Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((r) => (
            <Tr key={r.label}>
              <Td label={nameHeader} className="text-sand-900">{r.label}</Td>
              <Td label={t("money.bucketCurrent", locale)} className="text-right tabular-nums text-sand-700">{rands(r.current_cents)}</Td>
              <Td label={t("money.bucket30", locale)} className="text-right tabular-nums text-sand-700">{rands(r.d30_cents)}</Td>
              <Td label={t("money.bucket60", locale)} className="text-right tabular-nums text-status-warn">{rands(r.d60_cents)}</Td>
              <Td label={t("money.bucket90", locale)} className="text-right tabular-nums text-status-overdue">{rands(r.d90_cents)}</Td>
              <Td label={t("money.bucketTotal", locale)} className="text-right font-medium tabular-nums text-sand-900">{rands(r.total_cents)}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
  );
}
