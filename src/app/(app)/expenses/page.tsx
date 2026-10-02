import { redirect } from "next/navigation";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { expenseTotalCents, EXPENSE_CATEGORIES, type Expense } from "@/lib/expenses";
import type { SupplierOption } from "@/lib/suppliers";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted, FilteredEmpty } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { filterState } from "@/components/ui/filter-state";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { ReceiptUpload } from "@/components/expenses/receipt-upload";
import { signedReceiptUrls, claimNeedsProof } from "@/lib/receipt-media";
import { markExpensePaid, deleteExpense, removeReceipt } from "./actions";

export const dynamic = "force-dynamic";

/**
 * What the partner bought (G6).
 *
 * Turnover is not profit, and output VAT is not a VAT return. Until this screen existed
 * the product could tell a workshop exactly what it had billed and nothing whatsoever
 * about what it had spent, so "did this month make money?" and "what do I owe SARS?"
 * were both unanswerable, and the answer to both lived in a spreadsheet somewhere else.
 *
 * The list is deliberately ordered by the SUPPLIER's invoice date rather than by capture
 * date, because that is the date a VAT period is built from and a partner catching up on
 * a shoebox of receipts needs to see them fall into the right months.
 */
export default async function ExpensesPage({
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

  const supabase = await createClient();
  const [{ data }, { data: supplierData }, { data: orderData }] = await Promise.all([
    supabase
      .from("partner_expenses")
      .select("*")
      .is("deleted_at", null)
      .order("expense_date", { ascending: false })
      .limit(200),
    // The book, for the capture form's picker. Inactive suppliers are left out: they are
    // the ones this workshop has stopped buying from, and offering them is how a dormant
    // record quietly comes back to life. Their history is untouched either way.
    supabase
      .from("suppliers")
      .select("id, name")
      .is("deleted_at", null)
      .eq("active", true)
      .order("name", { ascending: true }),
    // Orders, so an expense converted from one can say which. Fetched as a small map rather
    // than a PostgREST embed because the same page already loads everything else flat, and
    // a workshop's live order book is a short list.
    supabase
      .from("purchase_orders")
      .select("id, reference, order_date")
      .is("deleted_at", null),
  ]);

  // `supplier_id` (0481) and `purchase_order_id` (0475) are on the row but not on the
  // shared `Expense` type, which several other screens read, widened here rather than
  // there so this page can render the two links without changing what they see.
  type ExpenseRow = Expense & { supplier_id: string | null; purchase_order_id: string | null };
  const expenses = (data ?? []) as ExpenseRow[];
  const suppliers = (supplierData ?? []) as SupplierOption[];
  const orders = new Map(
    ((orderData ?? []) as { id: string; reference: string | null; order_date: string }[]).map((o) => [o.id, o])
  );

  const spentCents = expenses.reduce((s, e) => s + expenseTotalCents(e), 0);
  const unpaid = expenses.filter((e) => !e.paid_on);
  const unpaidCents = unpaid.reduce((s, e) => s + expenseTotalCents(e), 0);
  const claimableVat = expenses
    .filter((e) => e.vat_claimable)
    .reduce((s, e) => s + e.vat_cents, 0);

  // One round trip for the whole page rather than a signed URL per row.
  const receiptUrls = await signedReceiptUrls(supabase, expenses.map((e) => e.receipt_path));

  // VAT being claimed with no supplier tax invoice behind it. Never blocked at capture -
  // stated here and on the return, because it is what an auditor disallows.
  const unsupported = expenses.filter(claimNeedsProof);
  const unsupportedVat = unsupported.reduce((s, e) => s + e.vat_cents, 0);

  // == Filters ==
  // Two questions a partner actually asks of this list: "what have I not paid yet / what
  // is missing its tax invoice", and "what did I spend on X". Both are plain URL params,
  // validated here, so an unknown value shows everything rather than nothing.
  const SHOW = ["unpaid", "noproof"] as const;
  const show = (SHOW as readonly string[]).includes(sp.show ?? "") ? sp.show : undefined;
  const category = (EXPENSE_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? sp.category : undefined;
  const search = new URLSearchParams(
    Object.entries({ show, category }).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const filterGroups = [
    {
      paramName: "show",
      label: t("filters.status", locale),
      current: show,
      options: [
        { value: "", label: t("filters.all", locale) },
        { value: "unpaid", label: t("expenses.filterUnpaid", locale), count: unpaid.length },
        { value: "noproof", label: t("expenses.filterNoProof", locale), count: unsupported.length },
      ],
    },
    {
      paramName: "category",
      label: t("expenses.category", locale),
      current: category,
      options: [
        { value: "", label: t("filters.all", locale) },
        ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`expenseCategory.${c}`, locale) })),
      ],
    },
  ];
  const filtered = filterState("/expenses", search, filterGroups);
  const shown = expenses.filter(
    (e) =>
      (show !== "unpaid" || !e.paid_on) &&
      (show !== "noproof" || claimNeedsProof(e)) &&
      (!category || e.category === category),
  );

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);

  return (
    <PageContainer>
      <PageHeader
        title={t("expenses.title", locale)}
        lead={t("expenses.lead", locale)}
        infoKey="expenses"
        locale={locale}
        actions={<ExpenseForm locale={locale} vatRegistered={workshop.vat_registered !== false} suppliers={suppliers} />}
      />

      {/* Receipt failures get sentences. A raw "receipt-too_big" on screen is the same
          defect as the CSV import's "name_required, Preview", and it is not the user's
          job to know our error codes. Other codes on this page still pass through. */}
      <Flash
        tone="error"
        message={
          sp.error && sp.error.startsWith("receipt-")
            ? t(`expenses.receiptErr.${sp.error.slice("receipt-".length)}`, locale)
            : sp.error
        }
      />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.attached ? t("expenses.receiptAttachedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.deleted ? t("expenses.deletedFlash", locale) : undefined} />

      {/* Stated once at the top as an amount, because "three rows have a warning triangle"
          and "R2 400 of your claim has no invoice behind it" are read very differently. */}
      {unsupportedVat > 0 ? (
        <Flash
          tone="warning"
          clearParams={false}
          message={`${t("expenses.unsupportedWarning", locale)} ${rands(unsupportedVat)} (${unsupported.length}).`}
        />
      ) : null}

      {/* What is still owed to suppliers first: it is the figure that turns into a payment
          this week. What was spent and what can be claimed follow. */}
      {expenses.length > 0 ? (
        <StatGrid columns={3}>
          <Stat
            size="md"
            label={t("expenses.statUnpaid", locale)}
            value={rands(unpaidCents)}
            delta={`${unpaid.length} ${t("expenses.statUnpaidHint", locale)}`}
            tone={unpaidCents > 0 ? "due" : "default"}
          />
          <Stat size="md" label={t("expenses.statSpent", locale)} value={rands(spentCents)} />
          <Stat size="md" label={t("expenses.statVat", locale)} value={rands(claimableVat)} delta={t("expenses.statVatHint", locale)} />
        </StatGrid>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("expenses.listTitle", locale)}</CardTitle>
        </CardHeader>

        {expenses.length === 0 ? (
          <GetStarted title={t("expenses.emptyTitle", locale)} hint={t("expenses.emptyBody", locale)} />
        ) : (
          <div className="flex flex-col gap-3">
            <FilterBar
              path="/expenses"
              search={search}
              groups={filterGroups}
              filtersLabel={t("filters.filters", locale)}
              clearLabel={t("filters.clear", locale)}
              rememberKey="expenses"
            />
            {shown.length === 0 ? (
              <FilteredEmpty
                filtered={filtered.active}
                clearHref={filtered.clearHref}
                title={t("empty.noMatchTitle", locale)}
                hint={t("empty.noMatchHint", locale)}
                clearLabel={t("empty.clearFilters", locale)}
              >
                <GetStarted title={t("expenses.emptyTitle", locale)} hint={t("expenses.emptyBody", locale)} />
              </FilteredEmpty>
            ) : (
              <Table stacked className="lg:min-w-[40rem]">
                <Thead>
                  <Tr className="text-left text-sand-500">
                    <Th className="font-medium">{t("expenses.colDate", locale)}</Th>
                    <Th className="font-medium">{t("expenses.colSupplier", locale)}</Th>
                    <Th className="font-medium">{t("expenses.colCategory", locale)}</Th>
                    <Th className="text-right font-medium">{t("expenses.colTotal", locale)}</Th>
                    <Th className="font-medium">{t("expenses.colPaid", locale)}</Th>
                    <Th className="font-medium">{t("expenses.colProof", locale)}</Th>
                    <Th />
                  </Tr>
                </Thead>
                <Tbody>
                  {shown.map((e) => {
                    const total = rands(expenseTotalCents(e));
                    return (
                      <Tr key={e.id}>
                        <Td label={t("expenses.colDate", locale)} className="whitespace-nowrap text-sand-600">{shortDate(e.expense_date, locale)}</Td>
                        <Td label={t("expenses.colSupplier", locale)}>
                          <span className="text-sand-900">{e.supplier_name}</span>
                          {e.reference ? <span className="block break-all font-mono text-xs text-sand-500">{e.reference}</span> : null}
                          {e.description ? <span className="block text-xs text-sand-500">{e.description}</span> : null}
                          {/* Where this invoice came from. 0475 records the link and nothing
                              showed it, so the one thing an order is raised for, checking that
                              what was billed is what was agreed, meant hunting for the order
                              by supplier and date. The reference is the number said down the
                              phone; a nameless order still gets a link, because the row without
                              one is the one most in need of opening. */}
                          {e.purchase_order_id ? (
                            <a
                              href={`/orders/${e.purchase_order_id}`}
                              className="focus-ring mt-0.5 block text-xs font-medium text-brand-ink underline underline-offset-2"
                            >
                              {t("supplier.fromOrder", locale)}{" "}
                              {orders.get(e.purchase_order_id)?.reference ?? t("supplier.fromOrderNoRef", locale)}
                            </a>
                          ) : null}
                        </Td>
                        <Td label={t("expenses.colCategory", locale)}>
                          <Badge tone="neutral">{t(`expenseCategory.${e.category}`, locale)}</Badge>
                        </Td>
                        {/* The total is what left the bank; the VAT inside it is the detail
                            under it, not a column of its own. */}
                        <Td label={t("expenses.colTotal", locale)} className="text-right tabular-nums">
                          <span className="font-semibold text-sand-900">{total}</span>
                          {e.vat_cents > 0 ? (
                            <span className="block whitespace-nowrap text-xs text-sand-500">
                              {rands(e.vat_cents)} {t("expenses.splitVat", locale)}
                              {/* A partner who cannot claim it needs to see WHY it is not in
                                  the return, or the total will look wrong every quarter. */}
                              {!e.vat_claimable ? ` · ${t("expenses.notClaimable", locale)}` : ""}
                            </span>
                          ) : null}
                        </Td>
                        <Td label={t("expenses.colPaid", locale)} className="whitespace-nowrap">
                          {e.paid_on ? (
                            <span className="text-sand-600">{shortDate(e.paid_on, locale)}</span>
                          ) : (
                            <Badge tone="warning">{t("expenses.filterUnpaid", locale)}</Badge>
                          )}
                        </Td>
                        <Td label={t("expenses.colProof", locale)} className="whitespace-nowrap">
                          {e.receipt_path ? (
                            <a
                              href={receiptUrls.get(e.receipt_path) ?? "#"}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="focus-ring inline-flex min-h-[48px] items-center text-sm font-medium text-brand-ink underline underline-offset-2 lg:min-h-0"
                            >
                              {t("expenses.receiptView", locale)}
                            </a>
                          ) : claimNeedsProof(e) ? (
                            <span className="text-xs text-status-warn">{t("expenses.receiptMissing", locale)}</span>
                          ) : (
                            <span className="text-sand-400">-</span>
                          )}
                        </Td>
                        <Td className="text-right">
                          <ActionMenu
                            title={`${e.supplier_name} · ${total}`}
                            label={t("common.actions", locale)}
                            closeLabel={closeLabel}
                          >
                            {!e.paid_on ? (
                              <form action={markExpensePaid}>
                                <input type="hidden" name="expense_id" value={e.id} />
                                <SubmitButton look="menuItem">{t("expenses.markPaid", locale)}</SubmitButton>
                              </form>
                            ) : null}
                            {e.receipt_path ? (
                              <ConfirmDialog
                                action={removeReceipt}
                                triggerLook="menuItem"
                                triggerLabel={t("expenses.receiptRemove", locale)}
                                title={t("expenses.receiptRemoveTitle", locale)}
                                intro={e.supplier_name}
                                consequences={[t("expenses.receiptRemoveConsequence", locale)]}
                                confirmLabel={t("expenses.receiptRemove", locale)}
                                cancelLabel={cancelLabel}
                                closeLabel={closeLabel}
                              >
                                <input type="hidden" name="expense_id" value={e.id} />
                              </ConfirmDialog>
                            ) : (
                              <ReceiptUpload expenseId={e.id} locale={locale} compact look="menuItem" />
                            )}
                            <ConfirmDialog
                              action={deleteExpense}
                              triggerLook="menuItem"
                              triggerLabel={t("common.remove", locale)}
                              triggerIcon={<TrashIcon />}
                              title={t("expenses.deleteTitle", locale)}
                              intro={`${e.supplier_name} · ${total}`}
                              consequences={[t("expenses.deleteConsequence", locale)]}
                              confirmLabel={t("common.remove", locale)}
                              cancelLabel={cancelLabel}
                              closeLabel={closeLabel}
                            >
                              <input type="hidden" name="expense_id" value={e.id} />
                            </ConfirmDialog>
                          </ActionMenu>
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            )}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
