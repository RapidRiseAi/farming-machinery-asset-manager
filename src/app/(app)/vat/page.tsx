import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  vatPeriods, currentVatPeriod, vatIsPayable, EMPTY_VAT_RETURN,
  type VatReturn, type VatCategory,
} from "@/lib/expenses";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { DownloadIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * The VAT return (G6).
 *
 * This is the screen whose absence most directly sent a partner back to a spreadsheet.
 * Every invoice they raise here carries VAT, and until now there was no way to total it
 * for a period — so twice a year they exported everything and rebuilt the numbers
 * somewhere else, and once the numbers live somewhere else, so do the books.
 *
 * Two things it insists on, because both are how small businesses get this wrong:
 *
 *   1. The window is a REAL VAT period, not a free date range. SARS runs most vendors on
 *      two-month cycles and which two months depends on the category they registered
 *      under. A return built over the wrong pair double-counts one month and omits
 *      another, and nothing about the resulting number looks wrong.
 *   2. It is on the INVOICE basis — the VAT is declared when the invoice was issued, not
 *      when the customer paid. The page says so in words, next to the figure, because a
 *      partner who assumes otherwise under-declares and finds out two years later.
 */
export default async function VatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const category = ((workshop as { vat_category?: string }).vat_category ?? "A") as VatCategory;
  const closed = vatPeriods(category);
  // The open period is offered first but is never the default: the default stays the one
  // about to be filed. Without it, an invoice captured today falls in no period on offer.
  const open = currentVatPeriod(category);
  const periods = [open, ...closed];
  const chosen = periods.find((p) => p.from === sp.from && p.to === sp.to);
  const from = chosen?.from ?? sp.from ?? closed[0].from;
  const to = chosen?.to ?? sp.to ?? closed[0].to;
  const viewingOpen = from === open.from && to === open.to;

  const supabase = await createClient();
  const [{ data: vatData }, { data: docData }, { data: expData }] = await Promise.all([
    supabase.rpc("partner_vat_return", { p_workshop: workshop.id, p_from: from, p_to: to }),
    supabase
      .from("partner_documents")
      .select("id, number, kind, status, issue_date, bill_to_name, subtotal_cents, discount_cents, vat_cents")
      .eq("workshop_id", workshop.id)
      .in("kind", ["invoice", "credit_note", "debit_note"])
      .in("status", ["sent", "part_paid", "paid", "written_off"])
      .gte("issue_date", from)
      .lte("issue_date", to)
      .is("deleted_at", null)
      .order("issue_date"),
    supabase
      .from("partner_expenses")
      .select("id, supplier_name, expense_date, amount_cents, vat_cents, vat_claimable, category")
      .gte("expense_date", from)
      .lte("expense_date", to)
      .is("deleted_at", null)
      .order("expense_date"),
  ]);

  const vat = (((vatData ?? []) as VatReturn[])[0] ?? EMPTY_VAT_RETURN);
  const docs = (docData ?? []) as {
    id: string; number: string; kind: string; status: string; issue_date: string;
    bill_to_name: string | null; subtotal_cents: number; discount_cents: number; vat_cents: number;
  }[];
  const expenses = (expData ?? []) as {
    id: string; supplier_name: string; expense_date: string; amount_cents: number;
    vat_cents: number; vat_claimable: boolean; category: string;
  }[];

  const payable = vatIsPayable(vat);
  const netAbs = Math.abs(vat.net_vat_cents);
  const q = `from=${from}&to=${to}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("vat.title", locale)}</h1>
          <p className="text-sm text-sand-600">{t("vat.lead", locale)}</p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="vat" locale={locale} />
        </span>
      </div>

      {/* Not VAT registered: this whole screen is a claim they must not make. */}
      {workshop.vat_registered === false ? (
        <Card>
          <CardHeader><CardTitle>{t("vat.notRegisteredTitle", locale)}</CardTitle></CardHeader>
          <p className="text-sm text-sand-600">{t("vat.notRegisteredBody", locale)}</p>
          <Link href="/contractor/settings" className={`${buttonVariants({ variant: "secondary", size: "sm" })} mt-3 self-start`}>
            {t("vat.goToSettings", locale)}
          </Link>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>{t("vat.periodTitle", locale)}</CardTitle></CardHeader>
            <p className="mb-3 text-sm text-sand-600">
              {t("vat.periodBody", locale)}{" "}
              <Badge tone="neutral">{t(`vat.category${category === "monthly" ? "Monthly" : category}`, locale)}</Badge>
            </p>
            <div className="flex flex-wrap gap-2">
              {periods.map((p) => {
                const active = p.from === from && p.to === to;
                const isOpen = p.from === open.from && p.to === open.to;
                return (
                  <Link
                    key={p.from}
                    href={`/vat?from=${p.from}&to=${p.to}`}
                    aria-current={active ? "true" : undefined}
                    className={buttonVariants({ variant: active ? "primary" : "secondary", size: "sm" })}
                  >
                    {shortDate(p.from, locale)} – {shortDate(p.to, locale)}
                    {isOpen ? ` · ${t("vat.periodOpen", locale)}` : ""}
                  </Link>
                );
              })}
            </div>
            {viewingOpen ? (
              <p className="mt-3 text-sm text-sand-600">{t("vat.periodOpenNote", locale)}</p>
            ) : null}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {payable ? t("vat.owingTitle", locale) : t("vat.refundTitle", locale)}
              </CardTitle>
            </CardHeader>
            <p className="text-4xl font-bold tabular-nums text-sand-900">{rands(netAbs)}</p>
            <p className="mt-1 text-sm text-sand-600">
              {payable ? t("vat.owingBody", locale) : t("vat.refundBody", locale)}
            </p>
            <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-600">
              {t("vat.invoiceBasis", locale)}
            </p>

            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-sand-200 pt-3 text-sm sm:max-w-md">
              <dt className="text-sand-600">{t("vat.standardSales", locale)}</dt>
              <dd className="text-right tabular-nums text-sand-900">{rands(vat.standard_ex_cents)}</dd>
              {vat.zero_rated_cents > 0 ? (
                <>
                  <dt className="text-sand-600">{t("vat.zeroRated", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-900">{rands(vat.zero_rated_cents)}</dd>
                </>
              ) : null}
              {vat.credits_ex_cents > 0 ? (
                <>
                  <dt className="text-sand-600">{t("vat.creditsIssued", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-900">−{rands(vat.credits_ex_cents)}</dd>
                </>
              ) : null}
              <dt className="font-medium text-sand-800">{t("vat.outputVat", locale)}</dt>
              <dd className="text-right font-medium tabular-nums text-sand-900">{rands(vat.output_vat_cents)}</dd>

              <dt className="mt-2 text-sand-600">{t("vat.purchases", locale)}</dt>
              <dd className="mt-2 text-right tabular-nums text-sand-900">{rands(vat.input_ex_cents)}</dd>
              <dt className="font-medium text-sand-800">{t("vat.inputVat", locale)}</dt>
              <dd className="text-right font-medium tabular-nums text-sand-900">−{rands(vat.input_vat_cents)}</dd>
              {vat.blocked_vat_cents > 0 ? (
                <>
                  <dt className="text-sand-600">{t("vat.blockedVat", locale)}</dt>
                  <dd className="text-right tabular-nums text-sand-500">{rands(vat.blocked_vat_cents)}</dd>
                </>
              ) : null}

              <dt className="mt-1 border-t border-sand-200 pt-1 font-semibold text-sand-900">
                {payable ? t("vat.netPayable", locale) : t("vat.netRefundable", locale)}
              </dt>
              <dd className="mt-1 border-t border-sand-200 pt-1 text-right font-bold tabular-nums text-sand-900">
                {rands(netAbs)}
              </dd>
            </dl>

            {/* A written-off invoice still declared its VAT. Bad-debt relief (s22) is a
                separate claim with its own conditions, so this points at it rather than
                quietly making it. */}
            {vat.written_off_vat_cents > 0 ? (
              <p className="mt-4 rounded-lg border border-sand-200 bg-sand-50 px-3 py-2 text-sm text-sand-700">
                {t("vat.badDebtNote", locale).replace("{amount}", rands(vat.written_off_vat_cents))}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <a href={`/api/vat/csv?${q}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <DownloadIcon /> {t("vat.downloadCsv", locale)}
              </a>
              <a href={`/api/vat/pdf?${q}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <DownloadIcon /> {t("vat.downloadPdf", locale)}
              </a>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("vat.salesTitle", locale)}</CardTitle></CardHeader>
            {docs.length === 0 ? (
              <AllClear title={t("vat.noSales", locale)} hint={t("vat.noSalesHint", locale)} />
            ) : (
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[36rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-sand-200 text-left text-sand-500">
                      <th className="py-2 pr-3 font-medium">{t("vat.colDate", locale)}</th>
                      <th className="py-2 pr-3 font-medium">{t("vat.colDocument", locale)}</th>
                      <th className="py-2 pr-3 font-medium">{t("vat.colCustomer", locale)}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("vat.colExVat", locale)}</th>
                      <th className="py-2 text-right font-medium">{t("vat.colVat", locale)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => {
                      const sign = d.kind === "credit_note" ? -1 : 1;
                      const net = sign * Math.max(0, d.subtotal_cents - Math.min(d.discount_cents, d.subtotal_cents));
                      return (
                        <tr key={d.id} className="border-b border-sand-100 last:border-0">
                          <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">{shortDate(d.issue_date, locale)}</td>
                          <td className="py-2.5 pr-3">
                            <Link href={`/documents/${d.id}`} className="focus-ring rounded text-brand-700 underline-offset-2 hover:underline">
                              {d.number}
                            </Link>
                            {d.status === "written_off" ? (
                              <Badge tone="danger" className="ml-2">{t("docStatus.written_off", locale)}</Badge>
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-3 text-sand-700">{d.bill_to_name}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">{rands(net)}</td>
                          <td className="py-2.5 text-right tabular-nums text-sand-800">{rands(sign * d.vat_cents)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("vat.purchasesTitle", locale)}</CardTitle></CardHeader>
            {expenses.length === 0 ? (
              <p className="text-sm text-sand-600">
                {t("vat.noPurchases", locale)}{" "}
                <Link href="/expenses" className="focus-ring rounded text-brand-700 underline-offset-2 hover:underline">
                  {t("vat.capturePurchases", locale)}
                </Link>
              </p>
            ) : (
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-sand-200 text-left text-sand-500">
                      <th className="py-2 pr-3 font-medium">{t("vat.colDate", locale)}</th>
                      <th className="py-2 pr-3 font-medium">{t("expenses.colSupplier", locale)}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("vat.colExVat", locale)}</th>
                      <th className="py-2 text-right font-medium">{t("vat.colVat", locale)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((e) => (
                      <tr key={e.id} className="border-b border-sand-100 last:border-0">
                        <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">{shortDate(e.expense_date, locale)}</td>
                        <td className="py-2.5 pr-3 text-sand-900">
                          {e.supplier_name}
                          <span className="block text-xs text-sand-500">{t(`expenseCategory.${e.category}`, locale)}</span>
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">{rands(e.amount_cents)}</td>
                        <td className="py-2.5 text-right tabular-nums text-sand-800">
                          {e.vat_claimable ? rands(e.vat_cents) : <span className="text-sand-400">{rands(0)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
