import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { expenseTotalCents, type Expense } from "@/lib/expenses";
import type { SupplierOption } from "@/lib/suppliers";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";
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
 * about what it had spent — so "did this month make money?" and "what do I owe SARS?"
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
  // shared `Expense` type, which several other screens read — widened here rather than
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

  // VAT being claimed with no supplier tax invoice behind it. Never blocked at capture —
  // stated here and on the return, because it is what an auditor disallows.
  const unsupported = expenses.filter(claimNeedsProof);
  const unsupportedVat = unsupported.reduce((s, e) => s + e.vat_cents, 0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("expenses.title", locale)}</h1>
          <p className="text-sm text-sand-600">{t("expenses.lead", locale)}</p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="expenses" locale={locale} />
        </span>
      </div>

      {/* Receipt failures get sentences. A raw "receipt-too_big" on screen is the same
          defect as the CSV import's "name_required — Preview", and it is not the user's
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
          message={`${t("expenses.unsupportedWarning", locale)} ${rands(unsupportedVat)} (${unsupported.length}).`}
        />
      ) : null}

      {expenses.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={t("expenses.statSpent", locale)} value={rands(spentCents)} />
          <Stat
            label={t("expenses.statUnpaid", locale)}
            value={rands(unpaidCents)}
            delta={`${unpaid.length} ${t("expenses.statUnpaidHint", locale)}`}
            tone={unpaidCents > 0 ? "due" : "default"}
          />
          <Stat label={t("expenses.statVat", locale)} value={rands(claimableVat)} delta={t("expenses.statVatHint", locale)} />
        </div>
      ) : null}

      <ExpenseForm locale={locale} vatRegistered={workshop.vat_registered !== false} suppliers={suppliers} />

      <Card>
        <CardHeader>
          <CardTitle>{t("expenses.listTitle", locale)}</CardTitle>
        </CardHeader>

        {expenses.length === 0 ? (
          <GetStarted title={t("expenses.emptyTitle", locale)} hint={t("expenses.emptyBody", locale)} />
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-sand-200 text-left text-sand-500">
                  <th className="py-2 pr-3 font-medium">{t("expenses.colDate", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("expenses.colSupplier", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("expenses.colCategory", locale)}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("expenses.colExVat", locale)}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("expenses.colVat", locale)}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("expenses.colTotal", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("expenses.colPaid", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("expenses.colProof", locale)}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-b border-sand-100 last:border-0">
                    <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">{shortDate(e.expense_date, locale)}</td>
                    <td className="py-2.5 pr-3">
                      <span className="text-sand-900">{e.supplier_name}</span>
                      {e.reference ? <span className="block font-mono text-xs text-sand-500">{e.reference}</span> : null}
                      {e.description ? <span className="block text-xs text-sand-500">{e.description}</span> : null}
                      {/* Where this invoice came from. 0475 records the link and nothing
                          showed it, so the one thing an order is raised for — checking that
                          what was billed is what was agreed — meant hunting for the order
                          by supplier and date. The reference is the number said down the
                          phone; a nameless order still gets a link, because the row without
                          one is the one most in need of opening. */}
                      {e.purchase_order_id ? (
                        <a
                          href={`/orders/${e.purchase_order_id}`}
                          className="focus-ring mt-0.5 block text-xs font-medium text-brand-700 underline underline-offset-2"
                        >
                          {t("supplier.fromOrder", locale)}{" "}
                          {orders.get(e.purchase_order_id)?.reference ?? t("supplier.fromOrderNoRef", locale)}
                        </a>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone="neutral">{t(`expenseCategory.${e.category}`, locale)}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">{rands(e.amount_cents)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-sand-800">
                      {rands(e.vat_cents)}
                      {/* A partner who cannot claim it needs to see WHY it is not in the
                          return, or the total will look wrong to them every quarter. */}
                      {e.vat_cents > 0 && !e.vat_claimable ? (
                        <span className="block text-xs text-status-warn">{t("expenses.notClaimable", locale)}</span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-medium tabular-nums text-sand-900">
                      {rands(expenseTotalCents(e))}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {e.paid_on ? (
                        <span className="text-sand-600">{shortDate(e.paid_on, locale)}</span>
                      ) : (
                        <form action={markExpensePaid}>
                          <input type="hidden" name="expense_id" value={e.id} />
                          <SubmitButton variant="ghost" size="sm">{t("expenses.markPaid", locale)}</SubmitButton>
                        </form>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {e.receipt_path ? (
                        <span className="flex items-center gap-2">
                          <a
                            href={receiptUrls.get(e.receipt_path) ?? "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="focus-ring text-sm font-medium text-brand-700 underline underline-offset-2"
                          >
                            {t("expenses.receiptView", locale)}
                          </a>
                          <ConfirmDialog
                            action={removeReceipt}
                            triggerLabel={t("expenses.receiptRemove", locale)}
                            triggerVariant="ghost"
                            triggerSize="sm"
                            title={t("expenses.receiptRemoveTitle", locale)}
                            intro={e.supplier_name}
                            consequences={[t("expenses.receiptRemoveConsequence", locale)]}
                            confirmLabel={t("expenses.receiptRemove", locale)}
                            cancelLabel={t("common.cancel", locale)}
                            closeLabel={t("ui.close", locale)}
                          >
                            <input type="hidden" name="expense_id" value={e.id} />
                          </ConfirmDialog>
                        </span>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          <ReceiptUpload expenseId={e.id} locale={locale} compact />
                          {claimNeedsProof(e) ? (
                            <span className="text-xs text-status-warn">{t("expenses.receiptMissing", locale)}</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <ConfirmDialog
                        action={deleteExpense}
                        triggerLabel={t("common.remove", locale)}
                        triggerIcon={<TrashIcon />}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        title={t("expenses.deleteTitle", locale)}
                        intro={`${e.supplier_name} · ${rands(expenseTotalCents(e))}`}
                        consequences={[t("expenses.deleteConsequence", locale)]}
                        confirmLabel={t("common.remove", locale)}
                        cancelLabel={t("common.cancel", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="expense_id" value={e.id} />
                      </ConfirmDialog>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
