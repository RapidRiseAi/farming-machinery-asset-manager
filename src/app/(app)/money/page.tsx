import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  moneyPeriods, ageingTotal, seriouslyOverdue, EMPTY_PL,
  type Pl, type Debtor, type Creditor, type Cash,
} from "@/lib/money-report";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/**
 * Did this month make money, who owes me, and who do I owe (0460).
 *
 * The commercial layer could raise an invoice, correct it, chase it on a statement and
 * file the VAT on it — and never answer the three questions a business is actually run
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

  const periods = moneyPeriods();
  const chosen = periods.find((p) => p.from === sp.from && p.to === sp.to);
  const from = chosen?.from ?? sp.from ?? periods[0].from;
  const to = chosen?.to ?? sp.to ?? periods[0].to;

  const supabase = await createClient();
  const [{ data: plData }, { data: breakdownData }, { data: debtorData }, { data: creditorData }, { data: cashData }] =
    await Promise.all([
      supabase.rpc("partner_pl", { p_workshop: workshop.id, p_from: from, p_to: to }),
      supabase.rpc("partner_expense_breakdown", { p_workshop: workshop.id, p_from: from, p_to: to }),
      supabase.rpc("partner_debtors", { p_workshop: workshop.id }),
      supabase.rpc("partner_creditors", { p_workshop: workshop.id }),
      supabase.rpc("partner_cash", { p_workshop: workshop.id, p_from: from, p_to: to }),
    ]);

  const pl = (((plData ?? []) as Pl[])[0] ?? EMPTY_PL);
  const breakdown = (breakdownData ?? []) as { category: string; cost_cents: number }[];
  const debtors = (debtorData ?? []) as Debtor[];
  const creditors = (creditorData ?? []) as Creditor[];
  const cash = (((cashData ?? []) as Cash[])[0] ?? { in_cents: 0, out_cents: 0, net_cents: 0 });

  const owed = ageingTotal(debtors, "total_cents");
  const late = seriouslyOverdue(debtors);
  const owing = ageingTotal(creditors, "total_cents");
  const profitable = pl.profit_cents >= 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("money.title", locale)}</h1>
          <p className="text-sm text-sand-600">{t("money.lead", locale)}</p>
        </div>
        <span className="ml-auto"><PageInfoButton infoKey="money" locale={locale} /></span>
      </div>

      <Card>
        <CardHeader><CardTitle>{t("money.periodTitle", locale)}</CardTitle></CardHeader>
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.key}
                href={`/money?from=${p.from}&to=${p.to}`}
                aria-current={active ? "true" : undefined}
                className={buttonVariants({ variant: active ? "primary" : "secondary", size: "sm" })}
              >
                {t(`money.period.${p.key}`, locale)}
              </Link>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-sand-600">
          {shortDate(from, locale)} – {shortDate(to, locale)} · {t("money.basis", locale)}
        </p>
      </Card>

      {/* Did it make money */}
      <Card>
        <CardHeader>
          <CardTitle>{profitable ? t("money.profitTitle", locale) : t("money.lossTitle", locale)}</CardTitle>
        </CardHeader>
        <p className={`text-3xl font-bold tabular-nums ${profitable ? "text-sand-900" : "text-status-overdue"}`}>
          {rands(Math.abs(pl.profit_cents))}
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
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
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-sand-700">{t("money.whereItWent", locale)}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {breakdown.map((b) => (
                <li key={b.category} className="flex items-baseline gap-2">
                  <span className="text-sand-700">{t(`expenseCategory.${b.category}`, locale)}</span>
                  <span className="ml-auto tabular-nums text-sand-900">{rands(b.cost_cents)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {/* Cash is not profit */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("money.cashIn", locale)} value={rands(cash.in_cents)} />
        <Stat label={t("money.cashOut", locale)} value={rands(cash.out_cents)} />
        <Stat
          label={t("money.cashNet", locale)}
          value={rands(cash.net_cents)}
          tone={cash.net_cents < 0 ? "due" : "default"}
          delta={t("money.cashHint", locale)}
        />
      </div>

      {/* Who owes me */}
      <Card>
        <CardHeader><CardTitle>{t("money.owedTitle", locale)}</CardTitle></CardHeader>
        {debtors.length === 0 ? (
          <AllClear title={t("money.owedNoneTitle", locale)} hint={t("money.owedNoneBody", locale)} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums text-sand-900">{rands(owed)}</span>
              {late > 0 ? (
                <Badge tone="danger">{t("money.lateBadge", locale).replace("{amount}", rands(late))}</Badge>
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

      {/* Who I owe */}
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
    </div>
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
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-sand-200 text-left text-sand-500">
            <th className="py-2 pr-3 font-medium">{nameHeader}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("money.bucketCurrent", locale)}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("money.bucket30", locale)}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("money.bucket60", locale)}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("money.bucket90", locale)}</th>
            <th className="py-2 text-right font-medium">{t("money.bucketTotal", locale)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-sand-100 last:border-0">
              <td className="py-2.5 pr-3 text-sand-900">{r.label}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-sand-700">{rands(r.current_cents)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-sand-700">{rands(r.d30_cents)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-status-warn">{rands(r.d60_cents)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-status-overdue">{rands(r.d90_cents)}</td>
              <td className="py-2.5 text-right font-medium tabular-nums text-sand-900">{rands(r.total_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
