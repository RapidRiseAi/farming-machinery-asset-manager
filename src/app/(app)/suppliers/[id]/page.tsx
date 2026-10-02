import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
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
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { cn } from "@/components/ui/cn";
import { DownloadIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * A choice among windows or payment days. It states which one is SELECTED (tinted, with
 * aria-current), it is not an action: these were filled primary buttons, so the page
 * carried three green buttons and none of them was the thing to do.
 */
const choiceChip = (on: boolean) =>
  cn(
    "focus-ring inline-flex min-h-[48px] items-center rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-[40px]",
    on
      ? "border-brand-600 bg-brand-tint text-brand-ink"
      : "border-sand-300 bg-surface text-sand-700 hover:bg-sand-50",
  );

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
 * One supplier's account: what they invoiced, what has been paid, what is still owed, and
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
  // Suppliers belong to a workshop, not a farm, a farm reading who its contractor buys
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
      <PageContainer>
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const { data: supplierData } = await supabase
    .from("suppliers")
    .select("id, name, contact_person, phone, email, address, vat_number, account_number, payment_terms_days, active")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  // A guessed id, another workshop's supplier and a retracted one all land here, RLS
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
  // most recent one selected, a partner opening this after a Friday payment run wants the
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
  const terms = [
    supplier.payment_terms_days != null
      ? `${t("supplier.termsShort", locale)} ${supplier.payment_terms_days}`
      : t("supplierStatement.termsAssumed", locale),
    supplier.account_number ? `${t("supplier.accountShort", locale)} ${supplier.account_number}` : null,
    supplier.vat_number ? `${t("supplier.vatShort", locale)} ${supplier.vat_number}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PageContainer>
      <PageHeader
        title={supplier.name}
        back={{ href: "/suppliers", label: t("supplierStatement.back", locale) }}
        badge={supplier.active ? null : <Badge tone="neutral">{t("supplier.inactive", locale)}</Badge>}
        meta={terms}
        lead={contact || t("supplierStatement.noContact", locale)}
        infoKey="supplierStatement"
        locale={locale}
        actions={
          <>
            <a href={stmtPdf} className={buttonVariants({ variant: "secondary" })}>
              <DownloadIcon className="text-lg" /> {t("supplierStatement.pdf", locale)}
            </a>
            <a href={stmtCsv} className={buttonVariants({ variant: "ghost" })}>
              {t("supplierStatement.csv", locale)}
            </a>
          </>
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />

      {/* What is owed, first. That is the question a supplier account is opened for; the
          ledger below is how it got there. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("supplierStatement.owedNow", locale)}</CardTitle>
        </CardHeader>
        {/* Phone: the total across the top, the four age buckets two by two under it.
            Five money tiles in one row only from lg, where each has room for a
            seven-figure amount (rands is one unbreakable token). */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label={t("supplierStatement.totalOwed", locale)}
            value={rands(ageing.total_cents)}
            tone={ageing.total_cents > 0 ? "brand" : "default"}
            size="md"
            className="col-span-2 sm:col-span-1"
          />
          {SUPPLIER_AGEING_BUCKETS.map((b) => {
            const cents = ageing[b.field];
            return (
              <Stat
                key={b.key}
                label={t(`supplierStatement.age.${b.key}`, locale)}
                value={rands(cents)}
                tone={cents > 0 && b.key !== "current" ? "due" : "default"}
                size="md"
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
        {/* Each window applies on tap. Your own dates open a small dialog instead of
            sitting on the page as two date boxes and a button; it is still a native GET
            form, so it needs no JavaScript to submit and the URL stays shareable. */}
        <div className="flex flex-wrap items-center gap-2">
          {periods.map((p) => (
            <Link
              key={p.key}
              href={`/suppliers/${supplier.id}?from=${p.from}&to=${p.to}`}
              aria-current={activeKey === p.key ? "true" : undefined}
              className={choiceChip(activeKey === p.key)}
            >
              {t(`supplierStatement.period.${p.key}`, locale)}
            </Link>
          ))}
          <DialogForm
            trigger={
              activeKey === null
                ? `${shortDate(from, locale)} ${t("supplierStatement.rangeTo", locale)} ${shortDate(to, locale)}`
                : t("supplierStatement.customPeriod", locale)
            }
            triggerVariant={activeKey === null ? "secondary" : "ghost"}
            triggerSize="sm"
            title={t("supplierStatement.customPeriod", locale)}
            closeLabel={t("ui.close", locale)}
            size="md"
          >
            <form method="get">
              <DialogFields>
                <TextField id="stmt_from" name="from" type="date" label={t("supplierStatement.from", locale)} defaultValue={from} />
                <TextField id="stmt_to" name="to" type="date" label={t("supplierStatement.to", locale)} defaultValue={to} />
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <Button type="submit" variant="primary">{t("supplierStatement.show", locale)}</Button>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("supplierStatement.ledgerTitle", locale)}
            <Badge tone="neutral" className="ml-2 align-middle">
              {shortDate(from, locale)} {t("supplierStatement.rangeTo", locale)} {shortDate(to, locale)}
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
              <Table stacked className="lg:min-w-[38rem]">
                <Thead>
                  <Tr className="text-left text-sand-500">
                    <Th className="font-medium">{t("supplierStatement.date", locale)}</Th>
                    <Th className="font-medium">{t("supplierStatement.what", locale)}</Th>
                    <Th className="font-medium">{t("supplierStatement.dueBy", locale)}</Th>
                    <Th className="text-right font-medium">{t("supplierStatement.charged", locale)}</Th>
                    <Th className="text-right font-medium">{t("supplierStatement.paid", locale)}</Th>
                    <Th className="text-right font-medium">{t("supplierStatement.balance", locale)}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {lines.map((l, i) => (
                    <Tr key={`${l.kind}-${l.expense_id ?? "opening"}-${i}`}>
                      <Td label={t("supplierStatement.date", locale)} className="whitespace-nowrap text-sand-600">{shortDate(l.entry_date, locale)}</Td>
                      <Td label={t("supplierStatement.what", locale)}>
                        <span className="text-sand-900">{supplierStatementLabel(l, locale)}</span>
                        {l.reference ? <span className="ml-2 font-mono text-xs text-sand-500">{l.reference}</span> : null}
                        {l.category ? (
                          <span className="block text-xs text-sand-500">
                            {t(`expenseCategory.${l.category}`, locale)}
                          </span>
                        ) : null}
                      </Td>
                      <Td label={t("supplierStatement.dueBy", locale)} className="whitespace-nowrap text-sand-500">
                        {l.due_date ? shortDate(l.due_date, locale) : ""}
                      </Td>
                      <Td label={t("supplierStatement.charged", locale)} className="text-right tabular-nums text-sand-900">
                        {l.debit_cents ? rands(l.debit_cents) : ""}
                      </Td>
                      <Td label={t("supplierStatement.paid", locale)} className="text-right tabular-nums text-sand-900">
                        {l.credit_cents ? rands(l.credit_cents) : ""}
                      </Td>
                      <Td label={t("supplierStatement.balance", locale)} className="text-right font-medium tabular-nums text-sand-900">
                        {rands(l.balance_cents)}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>

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
                className={choiceChip(d === chosenPaid)}
              >
                {shortDate(d, locale)}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-2">
          <DialogForm
            trigger={t("supplierStatement.otherDate", locale)}
            triggerVariant="ghost"
            triggerSize="sm"
            title={t("supplierStatement.remitDate", locale)}
            description={t("supplierStatement.remitDateHint", locale)}
            closeLabel={t("ui.close", locale)}
            size="md"
          >
            <form method="get">
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <DialogFields columns={1}>
                <TextField id="remit_date" name="paid" type="date" label={t("supplierStatement.remitDate", locale)} defaultValue={chosenPaid ?? ""} required />
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <Button type="submit" variant="primary">{t("supplierStatement.show", locale)}</Button>
              </DialogActions>
            </form>
          </DialogForm>
        </div>

        {chosenPaid ? (
          remittance.length === 0 ? (
            <p className="mt-3 text-sm text-sand-500">{t("supplierStatement.remitEmpty", locale)}</p>
          ) : (
            <>
              <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <Table stacked className="lg:min-w-[34rem]">
                  <Thead>
                    <Tr className="text-left text-sand-500">
                      <Th className="font-medium">{t("supplierStatement.theirInvoice", locale)}</Th>
                      <Th className="font-medium">{t("supplierStatement.dated", locale)}</Th>
                      <Th className="text-right font-medium">{t("supplierStatement.exVat", locale)}</Th>
                      <Th className="text-right font-medium">{t("supplierStatement.vat", locale)}</Th>
                      <Th className="text-right font-medium">{t("supplierStatement.total", locale)}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {remittance.map((r) => (
                      <Tr key={r.expense_id}>
                        <Td label={t("supplierStatement.theirInvoice", locale)}>
                          <span className="font-mono text-sand-900">{r.reference ?? "-"}</span>
                          {r.description ? (
                            <span className="block text-xs text-sand-500">{r.description}</span>
                          ) : null}
                        </Td>
                        <Td label={t("supplierStatement.dated", locale)} className="whitespace-nowrap text-sand-600">
                          {shortDate(r.expense_date, locale)}
                        </Td>
                        <Td label={t("supplierStatement.exVat", locale)} className="text-right tabular-nums text-sand-800">{rands(r.amount_cents)}</Td>
                        <Td label={t("supplierStatement.vat", locale)} className="text-right tabular-nums text-sand-800">{rands(r.vat_cents)}</Td>
                        <Td label={t("supplierStatement.total", locale)} className="text-right font-medium tabular-nums text-sand-900">
                          {rands(r.total_cents)}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
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
                    <DownloadIcon className="text-lg" /> {t("supplierStatement.remitPdf", locale)}
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
    </PageContainer>
  );
}
