import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  withSupplierRunningBalance, supplierStatementTotals, supplierStatementLabel,
  supplierStatementPeriods, defaultSupplierPeriod, supplierPaymentDates,
  remittanceTotals, isoDateOrNull, SUPPLIER_AGEING_BUCKETS, EMPTY_SUPPLIER_AGEING,
  type SupplierStatementRow, type SupplierAgeing, type RemittanceRow,
} from "@/lib/supplier-statement";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { DownloadIcon, ChevronLeftIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

type SupplierRow = {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  vat_number: string | null;
  account_number: string | null;
  payment_terms_days: number | null;
  active: boolean;
};

/**
 * One supplier's account: what they invoiced, what has been paid, what is still owed — and
 * the remittance advice to send with the next payment (G25, migration 0502).
 *
 * /money has been able to say "you owe Bolt & Bearing R80 500" since 0460, and there was no
 * way to open that line. This is the other half: the same question the SUPPLIER asks when
 * they ring, answered from the same ledger, so the partner is not reading a figure off one
 * screen and reconstructing the history of it in a spreadsheet.
 *
 * Everything on the page comes out of SQL (`app.supplier_statement`, `app.supplier_ageing`,
 * `app.supplier_remittance`), so this page, the PDF and the CSV cannot drift from each other
 * or from what /money shows. The one thing computed here is the wording, deliberately:
 * `supplierStatementLabel` writes the lines in the reader's language, which a Postgres
 * function cannot do.
 *
 * Two limitations are stated in words rather than hidden. Amounts are GROSS, because that is
 * what leaves the bank and what the payables ageing already uses; and a due date is DERIVED
 * from the supplier's own filed terms (0491's rule, 30 days where nothing was filed) because
 * a supplier invoice does not carry one.
 */
export default async function SupplierAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  // Suppliers belong to a workshop, not a farm — a farm reading who its contractor buys
  // from, what it pays and on what terms is reading the margin behind every quote it is
  // given (F16). RLS refuses it too; this is the door, not the lock.
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Running the books here is the `books` product (0492). Denied BEFORE any query runs, so
  // a partner without it never causes the data to be read, let alone rendered.
  const gate = await checkWorkshopEntitlement("financials", profile);
  if (!gate.allowed) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </div>
    );
  }

  const supabase = await createClient();
  const { data: supplierData } = await supabase
    .from("suppliers")
    .select("id, name, contact_person, phone, email, address, vat_number, account_number, payment_terms_days, active")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  // A guessed id, another workshop's supplier and a retracted one all land here — RLS
  // returns no row, so there is nothing to distinguish and nothing that should be.
  const supplier = supplierData as SupplierRow | null;
  if (!supplier) redirect("/suppliers?error=not-found");

  const periods = supplierStatementPeriods();
  const fallback = defaultSupplierPeriod();
  const from = isoDateOrNull(sp.from) ?? fallback.from;
  const to = isoDateOrNull(sp.to) ?? fallback.to;
  const activeKey = periods.find((p) => p.from === from && p.to === to)?.key ?? null;

  const [{ data: stmtData }, { data: agedData }] = await Promise.all([
    supabase.rpc("supplier_statement", {
      p_workshop: workshop.id, p_supplier: supplier.id, p_from: from, p_to: to,
    }),
    supabase.rpc("supplier_ageing", { p_workshop: workshop.id, p_supplier: supplier.id }),
  ]);

  const rows = (stmtData ?? []) as SupplierStatementRow[];
  const ageing = ((agedData ?? []) as SupplierAgeing[])[0] ?? EMPTY_SUPPLIER_AGEING;
  const lines = withSupplierRunningBalance(rows);
  const totals = supplierStatementTotals(rows);

  // A remittance is keyed on the day the money left, so the days on which this supplier was
  // actually paid are the only ones for which one can exist. Offered as choices, with the
  // most recent one selected — a partner opening this after a Friday payment run wants the
  // advice for that run, not an empty form.
  const paidDates = supplierPaymentDates(rows);
  const chosenPaid = isoDateOrNull(sp.paid) ?? paidDates[0] ?? null;

  let remittance: RemittanceRow[] = [];
  if (chosenPaid) {
    const { data } = await supabase.rpc("supplier_remittance", {
      p_workshop: workshop.id, p_supplier: supplier.id, p_paid_on: chosenPaid,
    });
    remittance = (data ?? []) as RemittanceRow[];
  }
  const remit = remittanceTotals(remittance);

  const qs = `from=${from}&to=${to}`;
  const stmtPdf = `/api/suppliers/${supplier.id}/statement/pdf?${qs}`;
  const stmtCsv = `/api/suppliers/${supplier.id}/statement/csv?${qs}`;
  const remitPdf = chosenPaid ? `/api/suppliers/${supplier.id}/remittance/pdf?paid=${chosenPaid}` : "#";
  const remitCsv = chosenPaid ? `/api/suppliers/${supplier.id}/remittance/csv?paid=${chosenPaid}` : "#";

  const contact = [supplier.contact_person, supplier.phone, supplier.email].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <Link
          href="/suppliers"
          className="focus-ring inline-flex min-h-[2.75rem] items-center gap-1 rounded text-sm font-medium text-brand-700 sm:min-h-0"
        >
          <ChevronLeftIcon className="text-[1.1rem]" /> {t("supplierStatement.back", locale)}
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-sand-900">{supplier.name}</h1>
            {supplier.active ? null : <Badge tone="neutral">{t("supplier.inactive", locale)}</Badge>}
            <PageInfoButton infoKey="supplierStatement" locale={locale} />
          </div>
          <p className="mt-0.5 text-sm text-sand-600">{contact || t("supplierStatement.noContact", locale)}</p>
          <p className="text-xs text-sand-500">
            {[
              supplier.payment_terms_days != null
                ? `${t("supplier.termsShort", locale)} ${supplier.payment_terms_days}`
                : t("supplierStatement.termsAssumed", locale),
              supplier.account_number ? `${t("supplier.accountShort", locale)} ${supplier.account_number}` : null,
              supplier.vat_number ? `${t("supplier.vatShort", locale)} ${supplier.vat_number}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={stmtPdf} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <DownloadIcon className="text-[1.1rem]" /> {t("supplierStatement.pdf", locale)}
          </a>
          <a href={stmtCsv} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("supplierStatement.csv", locale)}
          </a>
        </div>
      </div>

      <Flash tone="error" message={sp.error} />

      {/* What is owed, first. That is the question a supplier account is opened for; the
          ledger below is how it got there. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("supplierStatement.owedNow", locale)}</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat
            label={t("supplierStatement.totalOwed", locale)}
            value={rands(ageing.total_cents)}
            tone={ageing.total_cents > 0 ? "brand" : "default"}
          />
          {SUPPLIER_AGEING_BUCKETS.map((b) => {
            const cents = ageing[b.field];
            return (
              <Stat
                key={b.key}
                label={t(`supplierStatement.age.${b.key}`, locale)}
                value={rands(cents)}
                tone={cents > 0 && b.key !== "current" ? "due" : "default"}
              />
            );
          })}
        </div>
        <p className="mt-2 text-sm text-sand-500">{t("supplierStatement.ageingHint", locale)}</p>
        <p className="text-sm text-sand-500">{t("supplierStatement.grossHint", locale)}</p>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("supplierStatement.periodTitle", locale)}</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => (
            <Link
              key={p.key}
              href={`/suppliers/${supplier.id}?from=${p.from}&to=${p.to}`}
              aria-current={activeKey === p.key ? "true" : undefined}
              className={buttonVariants({ variant: activeKey === p.key ? "primary" : "secondary", size: "sm" })}
            >
              {t(`supplierStatement.period.${p.key}`, locale)}
            </Link>
          ))}
        </div>
        {/* A native GET form, so choosing your own window needs no JavaScript and the URL
            stays the shareable thing it already is. */}
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t("supplierStatement.from", locale)} htmlFor="stmt_from">
            <Input id="stmt_from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field label={t("supplierStatement.to", locale)} htmlFor="stmt_to">
            <Input id="stmt_to" name="to" type="date" defaultValue={to} />
          </Field>
          <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            {t("supplierStatement.show", locale)}
          </button>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("supplierStatement.ledgerTitle", locale)}
            <Badge tone="neutral" className="ml-2 align-middle">
              {shortDate(from, locale)} – {shortDate(to, locale)}
            </Badge>
          </CardTitle>
        </CardHeader>

        {lines.length === 0 ? (
          <AllClear
            title={t("supplierStatement.emptyTitle", locale)}
            hint={t("supplierStatement.emptyBody", locale)}
          />
        ) : (
          <>
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[38rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-sand-200 text-left text-sand-500">
                    <th className="py-2 pr-3 font-medium">{t("supplierStatement.date", locale)}</th>
                    <th className="py-2 pr-3 font-medium">{t("supplierStatement.what", locale)}</th>
                    <th className="py-2 pr-3 font-medium">{t("supplierStatement.dueBy", locale)}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("supplierStatement.charged", locale)}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("supplierStatement.paid", locale)}</th>
                    <th className="py-2 text-right font-medium">{t("supplierStatement.balance", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={`${l.kind}-${l.expense_id ?? "opening"}-${i}`} className="border-b border-sand-100 last:border-0">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">{shortDate(l.entry_date, locale)}</td>
                      <td className="py-2.5 pr-3">
                        <span className="text-sand-900">{supplierStatementLabel(l, locale)}</span>
                        {l.reference ? <span className="ml-2 font-mono text-xs text-sand-500">{l.reference}</span> : null}
                        {l.category ? (
                          <span className="block text-xs text-sand-500">
                            {t(`expenseCategory.${l.category}`, locale)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-sand-500">
                        {l.due_date ? shortDate(l.due_date, locale) : ""}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-sand-900">
                        {l.debit_cents ? rands(l.debit_cents) : ""}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-sand-900">
                        {l.credit_cents ? rands(l.credit_cents) : ""}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums text-sand-900">
                        {rands(l.balance_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-sand-200 pt-3 text-sm sm:max-w-sm">
              <dt className="text-sand-600">{t("supplierStatement.opening", locale)}</dt>
              <dd className="text-right tabular-nums text-sand-900">{rands(totals.openingCents)}</dd>
              <dt className="text-sand-600">{t("supplierStatement.billed", locale)}</dt>
              <dd className="text-right tabular-nums text-sand-900">{rands(totals.billedCents)}</dd>
              <dt className="text-sand-600">{t("supplierStatement.paidOff", locale)}</dt>
              <dd className="text-right tabular-nums text-sand-900">−{rands(totals.paidCents)}</dd>
              <dt className="pt-1 font-semibold text-sand-900">{t("supplierStatement.closing", locale)}</dt>
              <dd className="pt-1 text-right font-semibold tabular-nums text-sand-900">
                {rands(totals.closingCents)}
              </dd>
            </dl>
            <p className="mt-2 text-sm text-sand-500">{t("supplierStatement.dueHint", locale)}</p>
          </>
        )}
      </Card>

      {/* The remittance. Its own card, because it is a document that goes OUT to somebody
          who will act on it, not a view of the account. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("supplierStatement.remitTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm text-sand-600">{t("supplierStatement.remitLead", locale)}</p>

        {/* The days this supplier was actually paid, straight off the statement's own payment
            lines. The date field is always here as well: a partner may want an advice for a
            run that falls outside the window they happen to be looking at. */}
        {paidDates.length === 0 ? (
          <p className="mt-3 text-sm text-sand-500">{t("supplierStatement.remitNoneInPeriod", locale)}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {paidDates.map((d) => (
              <Link
                key={d}
                href={`/suppliers/${supplier.id}?${qs}&paid=${d}`}
                aria-current={d === chosenPaid ? "true" : undefined}
                className={buttonVariants({ variant: d === chosenPaid ? "primary" : "secondary", size: "sm" })}
              >
                {shortDate(d, locale)}
              </Link>
            ))}
          </div>
        )}

        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <Field
            label={t("supplierStatement.remitDate", locale)}
            htmlFor="remit_date"
            hint={t("supplierStatement.remitDateHint", locale)}
          >
            <Input id="remit_date" name="paid" type="date" defaultValue={chosenPaid ?? ""} />
          </Field>
          <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            {t("supplierStatement.show", locale)}
          </button>
        </form>

        {chosenPaid ? (
          remittance.length === 0 ? (
            <p className="mt-3 text-sm text-sand-500">{t("supplierStatement.remitEmpty", locale)}</p>
          ) : (
            <>
              <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-sand-200 text-left text-sand-500">
                      <th className="py-2 pr-3 font-medium">{t("supplierStatement.theirInvoice", locale)}</th>
                      <th className="py-2 pr-3 font-medium">{t("supplierStatement.dated", locale)}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("supplierStatement.exVat", locale)}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("supplierStatement.vat", locale)}</th>
                      <th className="py-2 text-right font-medium">{t("supplierStatement.total", locale)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {remittance.map((r) => (
                      <tr key={r.expense_id} className="border-b border-sand-100 last:border-0">
                        <td className="py-2.5 pr-3">
                          <span className="font-mono text-sand-900">{r.reference ?? "—"}</span>
                          {r.description ? (
                            <span className="block text-xs text-sand-500">{r.description}</span>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">
                          {shortDate(r.expense_date, locale)}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">{rands(r.amount_cents)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">{rands(r.vat_cents)}</td>
                        <td className="py-2.5 text-right font-medium tabular-nums text-sand-900">
                          {rands(r.total_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-sand-200 pt-3">
                <p className="text-sm text-sand-700">
                  {remit.bills === 1
                    ? t("supplierStatement.remitOne", locale)
                    : t("supplierStatement.remitMany", locale).replace("{n}", String(remit.bills))}{" "}
                  <span className="font-semibold tabular-nums text-sand-900">{rands(remit.totalCents)}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <a href={remitPdf} className={buttonVariants({ variant: "primary", size: "sm" })}>
                    <DownloadIcon className="text-[1.1rem]" /> {t("supplierStatement.remitPdf", locale)}
                  </a>
                  <a href={remitCsv} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    {t("supplierStatement.csv", locale)}
                  </a>
                </div>
              </div>
            </>
          )
        ) : null}
      </Card>
    </div>
  );
}
