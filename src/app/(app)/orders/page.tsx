import Link from "next/link";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { num, shortDate } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { OrderStatus } from "@/components/ui/status";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DialogForm } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";
import { OrderForm } from "@/components/orders/order-form";
import { poErrorMessage } from "@/components/orders/po-error";
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
 * invoiced yet, the last one being where money goes missing, because an invoice nobody is
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

  // "New order" was a six-field form in a card above the list, so the list started
  // below a phone's first screen. It is one button now, rendered ONCE: in the header
  // when there are orders, as the empty state's only action when there are none (two
  // copies would also give the page two sets of the same field ids).
  const newOrder = (
    <DialogForm
      trigger={t("po.newTitle", locale)}
      triggerIcon={<PlusIcon />}
      title={t("po.newTitle", locale)}
      description={t("po.newHint", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <OrderForm locale={locale} action={createOrder} submitLabel={t("po.newSubmit", locale)} />
    </DialogForm>
  );

  return (
    <PageContainer>
      <PageHeader
        title={t("po.title", locale)}
        lead={t("po.lead", locale)}
        infoKey="orders"
        locale={locale}
        actions={orders.length > 0 ? newOrder : undefined}
      />

      <Flash tone="error" message={poErrorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.deleted ? t("po.deletedFlash", locale) : undefined} />

      {/* The three figures only once there is something to count: three zero tiles above
          an empty list say nothing the empty list does not. */}
      {orders.length > 0 ? (
        <StatGrid columns={3}>
          <Stat
            label={t("po.statOnOrder", locale)}
            value={rands(onOrderCents)}
            delta={`${num(open.length, 0)} ${t("po.statOnOrderHint", locale)}`}
            size="md"
          />
          <Stat
            label={t("po.statLate", locale)}
            value={num(late.length, 0)}
            delta={t("po.statLateHint", locale)}
            tone={late.length > 0 ? "overdue" : "default"}
            size="md"
          />
          <Stat
            label={t("po.statToInvoice", locale)}
            value={rands(toInvoiceCents)}
            delta={`${num(toInvoice.length, 0)} ${t("po.statToInvoiceHint", locale)}`}
            tone={toInvoice.length > 0 ? "due" : "default"}
            size="md"
          />
        </StatGrid>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("po.listTitle", locale)}</CardTitle>
        </CardHeader>

        {orders.length === 0 ? (
          <GetStarted title={t("po.emptyTitle", locale)} hint={t("po.emptyBody", locale)} action={newOrder} />
        ) : (
            <Table stacked className="lg:min-w-[46rem]">
              <Thead>
                <Tr className="text-left text-sand-500">
                  <Th className="font-medium">{t("po.colOrder", locale)}</Th>
                  <Th className="font-medium">{t("po.colStatus", locale)}</Th>
                  <Th className="font-medium">{t("po.colExpected", locale)}</Th>
                  <Th className="font-medium">{t("po.colArrived", locale)}</Th>
                  <Th className="text-right font-medium">{t("po.colTotal", locale)}</Th>
                  <Th className="font-medium">{t("po.colInvoice", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {orders.map((o) => {
                  const summary = receivedSummary(byOrder.get(o.id) ?? []);
                  const overdue = isLate(o);
                  return (
                    <Tr key={o.id}>
                      <Td label={t("po.colOrder", locale)}>
                        <Link
                          href={`/orders/${o.id}`}
                          className="focus-ring font-medium text-brand-ink underline underline-offset-2"
                        >
                          {o.reference ?? o.supplier_name}
                        </Link>
                        <span className="block text-xs text-sand-500">
                          {o.reference ? `${o.supplier_name} · ` : ""}
                          {shortDate(o.order_date, locale)}
                        </span>
                      </Td>
                      <Td label={t("po.colStatus", locale)}>
                        <OrderStatus value={o.status} locale={locale} />
                      </Td>
                      <Td label={t("po.colExpected", locale)} className="whitespace-nowrap">
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
                      </Td>
                      <Td label={t("po.colArrived", locale)} className="whitespace-nowrap text-sand-600">
                        {summary.ordered > 0
                          ? `${formatQty(summary.received)} / ${formatQty(summary.ordered)}`
                          : t("po.noLines", locale)}
                      </Td>
                      <Td label={t("po.colTotal", locale)} className="text-right font-medium tabular-nums text-sand-900">
                        {rands(o.total_cents)}
                      </Td>
                      <Td label={t("po.colInvoice", locale)}>
                        {invoiced.has(o.id) ? (
                          <Badge tone="ok">{t("po.invoiced", locale)}</Badge>
                        ) : (
                          <span className="text-xs text-sand-500">{t("po.notInvoiced", locale)}</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
        )}
      </Card>
    </PageContainer>
  );
}
