import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate, vatPercent } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import { OrderStatus } from "@/components/ui/status";
import { OrderForm } from "@/components/orders/order-form";
import { LineEditor } from "@/components/orders/line-editor";
import { ConvertForm } from "@/components/orders/convert-form";
import {
  receivedSummary,
  isOpen,
  isLate,
  canConvert,
  formatQty,
  type PurchaseOrder,
  type PurchaseOrderLine,
} from "@/lib/purchase-orders";
import { expenseTotalCents, type Expense } from "@/lib/expenses";
import { setOrderStatus, receiveAll, updateOrder, deleteOrder } from "../actions";

export const dynamic = "force-dynamic";

/**
 * One purchase order (G16), in the order the questions are asked: what state is it in,
 * what is still to come, has it been invoiced, and only then the details of the order
 * itself. Editing the header is last on purpose — it is the thing least often needed
 * once an order is out, and putting it first would bury the receiving fields under a
 * form nobody came here to fill in.
 *
 * RLS decides visibility; this page only decides what to offer. A partner from another
 * workshop following a guessed link reads nothing and lands back on the list.
 */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const { data } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const order = data as PurchaseOrder | null;
  if (!order) redirect("/orders?error=po-notFound");

  const { data: lineRows } = await supabase
    .from("purchase_order_lines")
    .select("*")
    .eq("purchase_order_id", order.id)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  const lines = (lineRows ?? []) as PurchaseOrderLine[];

  // The supplier invoice, if it has arrived. 0475's unique index means there is at most
  // one live row here, so `maybeSingle` is a statement about the schema, not a guess.
  const { data: expenseRow } = await supabase
    .from("partner_expenses")
    .select("*")
    .eq("purchase_order_id", order.id)
    .is("deleted_at", null)
    .maybeSingle();
  const expense = expenseRow as Expense | null;

  const summary = receivedSummary(lines);
  const editable = order.status !== "cancelled";
  const late = isLate(order);

  const error = sp.error?.startsWith("po-")
    ? t(`po.err.${sp.error.slice("po-".length)}`, locale)
    : sp.error;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0">
          <Link
            href="/orders"
            className="focus-ring text-sm font-medium text-brand-700 underline underline-offset-2"
          >
            {t("po.backToList", locale)}
          </Link>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-sand-900">
            {order.reference ? `${order.reference} · ` : ""}
            {order.supplier_name}
          </h1>
          <p className="text-sm text-sand-600">
            {t("po.orderedOn", locale)} {shortDate(order.order_date, locale)}
            {order.expected_date ? (
              <>
                {" · "}
                {t("po.dueOn", locale)} {shortDate(order.expected_date, locale)}
              </>
            ) : null}
          </p>
        </div>
        <span className="ml-auto">
          <OrderStatus value={order.status} locale={locale} size="md" />
        </span>
      </div>

      <Flash tone="error" message={error} />
      <Flash tone="success" message={sp.created ? t("po.createdFlash", locale) : undefined} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.added ? t("po.addedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.received ? t("po.receivedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.converted ? t("po.convertedFlash", locale) : undefined} />
      {late ? <Flash tone="warning" message={t("po.lateWarning", locale)} /> : null}

      {/* What it is worth, and how much of it is standing on the floor. Both are read
          from the header, which the 0473 trigger keeps in step with the lines. */}
      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
              {t("po.subtotal", locale)}
            </p>
            <p className="text-lg font-semibold tabular-nums text-sand-900">{rands(order.subtotal_cents)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
              {t("po.vat", locale)} ({vatPercent(order.vat_rate_bps)})
            </p>
            <p className="text-lg font-semibold tabular-nums text-sand-900">{rands(order.vat_cents)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
              {t("po.total", locale)}
            </p>
            <p className="text-lg font-bold tabular-nums text-sand-900">{rands(order.total_cents)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
              {t("po.arrived", locale)}
            </p>
            <p className="text-lg font-semibold tabular-nums text-sand-900">
              {summary.ordered > 0
                ? `${formatQty(summary.received)} / ${formatQty(summary.ordered)}`
                : "—"}
            </p>
            {summary.outstanding > 0 ? (
              <p className="text-xs text-sand-500">
                {formatQty(summary.outstanding)} {t("po.stillToCome", locale)}
              </p>
            ) : null}
          </div>
        </div>

        {/* The lifecycle, as buttons that say what they do. Nothing here types a status
            that the 0474 engine owns — sending an order is a decision, receiving one is
            an observation, and only the first is a button. */}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-sand-200 pt-4">
          {order.status === "draft" ? (
            <form action={setOrderStatus}>
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="status" value="sent" />
              <SubmitButton size="sm" disabled={lines.length === 0}>
                {t("po.markSent", locale)}
              </SubmitButton>
            </form>
          ) : null}

          {isOpen(order.status) && lines.length > 0 ? (
            <form action={receiveAll}>
              <input type="hidden" name="order_id" value={order.id} />
              <SubmitButton size="sm" variant="secondary">
                {t("po.receiveAll", locale)}
              </SubmitButton>
            </form>
          ) : null}

          {order.status !== "closed" && order.status !== "cancelled" && order.status !== "draft" ? (
            <ConfirmDialog
              action={setOrderStatus}
              triggerLabel={t("po.close", locale)}
              triggerVariant="secondary"
              triggerSize="sm"
              tone="brand"
              title={t("po.closeTitle", locale)}
              intro={t("po.closeIntro", locale)}
              consequences={[t("po.closeConsequence", locale)]}
              confirmLabel={t("po.close", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="status" value="closed" />
            </ConfirmDialog>
          ) : null}

          {order.status !== "cancelled" ? (
            <ConfirmDialog
              action={setOrderStatus}
              triggerLabel={t("po.cancel", locale)}
              triggerVariant="ghost"
              triggerSize="sm"
              title={t("po.cancelTitle", locale)}
              intro={`${order.supplier_name} · ${rands(order.total_cents)}`}
              consequences={[t("po.cancelConsequence", locale), t("po.cancelKeeps", locale)]}
              confirmLabel={t("po.cancel", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="status" value="cancelled" />
            </ConfirmDialog>
          ) : (
            <form action={setOrderStatus}>
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="status" value="draft" />
              <SubmitButton size="sm" variant="ghost">
                {t("po.reopen", locale)}
              </SubmitButton>
            </form>
          )}

          {/* Deleting is refused server-side once an invoice points at the order, so the
              button is not offered either — an action that always fails is worse than an
              action that is not there. */}
          {!expense ? (
            <span className="ml-auto">
              <ConfirmDialog
                action={deleteOrder}
                triggerLabel={t("common.remove", locale)}
                triggerIcon={<TrashIcon />}
                triggerVariant="ghost"
                triggerSize="sm"
                title={t("po.deleteTitle", locale)}
                intro={`${order.supplier_name} · ${rands(order.total_cents)}`}
                consequences={[t("po.deleteConsequence", locale), t("po.deletePrefer", locale)]}
                confirmLabel={t("common.remove", locale)}
                cancelLabel={t("common.cancel", locale)}
                closeLabel={t("ui.close", locale)}
              >
                <input type="hidden" name="order_id" value={order.id} />
              </ConfirmDialog>
            </span>
          ) : null}
        </div>
      </Card>

      <LineEditor locale={locale} order={order} lines={lines} editable={editable} />

      {/* The invoice. The only place in this feature where money enters the books. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("po.invoiceTitle", locale)}</CardTitle>
        </CardHeader>

        {expense ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-sand-700">
              {t("po.invoiceRecorded", locale)}{" "}
              <span className="font-semibold tabular-nums text-sand-900">
                {rands(expenseTotalCents(expense))}
              </span>{" "}
              {t("po.invoiceOn", locale)} {shortDate(expense.expense_date, locale)}
              {expense.reference ? ` · ${expense.reference}` : ""}
            </p>
            {expense.amount_cents !== order.subtotal_cents ? (
              <p className="text-sm text-status-warn">
                {t("po.invoiceDiffers", locale)}{" "}
                <span className="font-semibold tabular-nums">
                  {rands(Math.abs(expense.amount_cents - order.subtotal_cents))}
                </span>{" "}
                {expense.amount_cents > order.subtotal_cents
                  ? t("po.invoiceMore", locale)
                  : t("po.invoiceLess", locale)}
              </p>
            ) : (
              <Badge tone="ok">{t("po.invoiceMatches", locale)}</Badge>
            )}
            <p className="text-sm text-sand-600">
              <Link
                href="/expenses"
                className="focus-ring font-medium text-brand-700 underline underline-offset-2"
              >
                {t("po.seeInExpenses", locale)}
              </Link>
            </p>
          </div>
        ) : canConvert(order.status) ? (
          <>
            <p className="mb-3 text-sm text-sand-600">{t("po.invoiceHint", locale)}</p>
            <ConvertForm locale={locale} order={order} />
          </>
        ) : (
          <p className="text-sm text-sand-600">{t("po.invoiceNotYet", locale)}</p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("po.detailsTitle", locale)}</CardTitle>
        </CardHeader>
        <OrderForm
          locale={locale}
          action={updateOrder}
          order={order}
          submitLabel={t("po.detailsSubmit", locale)}
        />
      </Card>
    </div>
  );
}
