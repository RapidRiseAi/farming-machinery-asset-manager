import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { OrderStatus } from "@/components/ui/status";
import { OrderForm } from "@/components/orders/order-form";
import {
  receivedSummary,
  isOpen,
  isLate,
  formatQty,
  type PurchaseOrder,
  type PurchaseOrderLine,
} from "@/lib/purchase-orders";
import { createOrder } from "./actions";

export const dynamic = "force-dynamic";

/**
 * What is on order (G16).
 *
 * `partner_expenses` records a purchase the day the supplier's invoice arrives. That is
 * right for the books and useless on the floor: between phoning the supplier and the
 * invoice turning up, this product held no record at all of what was coming, what it was
 * going to cost, or what arrived short. This screen is that record.
 *
 * Ordered newest first, because the question being asked is almost always about something
 * recent. The three figures at the top are the ones a workshop actually worries about: how
 * much is committed but not yet delivered, what is late, and what has arrived and not been
 * invoiced yet — the last one being where money goes missing, because an invoice nobody is
 * expecting is an invoice nobody checks.
 */
export default async function OrdersPage({
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
  const { data } = await supabase
    .from("purchase_orders")
    .select("*")
    .is("deleted_at", null)
    .order("order_date", { ascending: false })
    .limit(200);
  const orders = (data ?? []) as PurchaseOrder[];

  // One round trip for every line on the page rather than a query per order. RLS scopes
  // both reads to this workshop, so the `in` list cannot widen anything.
  const ids = orders.map((o) => o.id);
  const { data: lineRows } = ids.length
    ? await supabase
        .from("purchase_order_lines")
        .select("id, purchase_order_id, qty_ordered, qty_received")
        .in("purchase_order_id", ids)
        .is("deleted_at", null)
    : { data: [] };

  const byOrder = new Map<string, Pick<PurchaseOrderLine, "qty_ordered" | "qty_received">[]>();
  for (const l of (lineRows ?? []) as (Pick<PurchaseOrderLine, "qty_ordered" | "qty_received"> & {
    purchase_order_id: string;
  })[]) {
    const list = byOrder.get(l.purchase_order_id) ?? [];
    list.push(l);
    byOrder.set(l.purchase_order_id, list);
  }

  // Which orders the supplier has already invoiced. The link lives on the expense (0475).
  const { data: expenseRows } = await supabase
    .from("partner_expenses")
    .select("purchase_order_id")
    .not("purchase_order_id", "is", null)
    .is("deleted_at", null);
  const invoiced = new Set(
    ((expenseRows ?? []) as { purchase_order_id: string }[]).map((e) => e.purchase_order_id),
  );

  const open = orders.filter((o) => isOpen(o.status));
  const onOrderCents = open.reduce((sum, o) => sum + o.total_cents, 0);
  const late = orders.filter((o) => isLate(o));
  const toInvoice = orders.filter(
    (o) => !invoiced.has(o.id) && (isOpen(o.status) || o.status === "received"),
  );
  const toInvoiceCents = toInvoice.reduce((sum, o) => sum + o.total_cents, 0);

  const error = sp.error?.startsWith("po-")
    ? t(`po.err.${sp.error.slice("po-".length)}`, locale)
    : sp.error;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("po.title", locale)}</h1>
        <p className="text-sm text-sand-600">{t("po.lead", locale)}</p>
      </div>

      <Flash tone="error" message={error} />
      <Flash tone="success" message={sp.deleted ? t("po.deletedFlash", locale) : undefined} />

      {orders.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label={t("po.statOnOrder", locale)}
            value={rands(onOrderCents)}
            delta={`${open.length} ${t("po.statOnOrderHint", locale)}`}
          />
          <Stat
            label={t("po.statLate", locale)}
            value={String(late.length)}
            delta={t("po.statLateHint", locale)}
            tone={late.length > 0 ? "overdue" : "default"}
          />
          <Stat
            label={t("po.statToInvoice", locale)}
            value={rands(toInvoiceCents)}
            delta={`${toInvoice.length} ${t("po.statToInvoiceHint", locale)}`}
            tone={toInvoice.length > 0 ? "due" : "default"}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("po.newTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("po.newHint", locale)}</p>
        <OrderForm locale={locale} action={createOrder} submitLabel={t("po.newSubmit", locale)} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("po.listTitle", locale)}</CardTitle>
        </CardHeader>

        {orders.length === 0 ? (
          <GetStarted title={t("po.emptyTitle", locale)} hint={t("po.emptyBody", locale)} />
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-sand-200 text-left text-sand-500">
                  <th className="py-2 pr-3 font-medium">{t("po.colOrder", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("po.colStatus", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("po.colExpected", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("po.colArrived", locale)}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("po.colTotal", locale)}</th>
                  <th className="py-2 pr-3 font-medium">{t("po.colInvoice", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const summary = receivedSummary(byOrder.get(o.id) ?? []);
                  const overdue = isLate(o);
                  return (
                    <tr key={o.id} className="border-b border-sand-100 last:border-0">
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/orders/${o.id}`}
                          className="focus-ring font-medium text-brand-700 underline underline-offset-2"
                        >
                          {o.reference ?? o.supplier_name}
                        </Link>
                        <span className="block text-xs text-sand-500">
                          {o.reference ? `${o.supplier_name} · ` : ""}
                          {shortDate(o.order_date, locale)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <OrderStatus value={o.status} locale={locale} />
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {o.expected_date ? (
                          <span className={overdue ? "font-medium text-status-overdue" : "text-sand-600"}>
                            {shortDate(o.expected_date, locale)}
                            {overdue ? (
                              <span className="block text-xs">{t("po.lateHint", locale)}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-sand-400">{t("po.noDate", locale)}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-sand-600">
                        {summary.ordered > 0
                          ? `${formatQty(summary.received)} / ${formatQty(summary.ordered)}`
                          : t("po.noLines", locale)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-medium tabular-nums text-sand-900">
                        {rands(o.total_cents)}
                      </td>
                      <td className="py-2.5 pr-3">
                        {invoiced.has(o.id) ? (
                          <Badge tone="ok">{t("po.invoiced", locale)}</Badge>
                        ) : (
                          <span className="text-xs text-sand-500">{t("po.notInvoiced", locale)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
