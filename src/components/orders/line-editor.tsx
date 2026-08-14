import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon, PlusIcon } from "@/components/ui/icons";
import { GetStarted } from "@/components/ui/empty-state";
import {
  lineTotalCents,
  outstandingQty,
  formatQty,
  qty as toQty,
  type PurchaseOrder,
  type PurchaseOrderLine,
} from "@/lib/purchase-orders";
import { addLine, saveLine, removeLine } from "@/app/(app)/orders/actions";

/**
 * What is being bought, and what of it has turned up.
 *
 * Each line is its own small form rather than a read-only row with an "edit" mode. That is
 * a deliberate trade: it is more markup, and it means the screen is honest about the two
 * things that actually happen at a parts counter — the price on the delivery note is not
 * always the price that was agreed, and quantities arrive in instalments. Making the
 * second require a mode switch is how a receiving record stops being kept.
 *
 * Money on a line is stored ex-VAT (the header carries the rate), so the edit fields say
 * "ex VAT" outright. Only the ADD form offers the inclusive-price switch, because that is
 * where a price is copied off a supplier's quote, which may be quoted either way.
 *
 * Server component: every control here is a form field or a submit, and the confirmation
 * on a destructive press is the shared dialog, which brings its own client boundary.
 */
export function LineEditor({
  locale,
  order,
  lines,
  editable,
}: {
  locale: Lang;
  order: PurchaseOrder;
  lines: PurchaseOrderLine[];
  /** False once the order is cancelled — there is nothing left to buy or receive. */
  editable: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("po.linesTitle", locale)}</CardTitle>
      </CardHeader>

      {lines.length === 0 ? (
        <GetStarted title={t("po.linesEmptyTitle", locale)} hint={t("po.linesEmptyBody", locale)} />
      ) : (
        <ul className="flex flex-col gap-3">
          {lines.map((line) => {
            const outstanding = outstandingQty(line);
            const over = toQty(line.qty_received) > toQty(line.qty_ordered);
            return (
              <li key={line.id} className="rounded-xl border border-sand-200 bg-white p-3">
                <form action={saveLine} className="flex flex-col gap-3">
                  <input type="hidden" name="order_id" value={order.id} />
                  <input type="hidden" name="line_id" value={line.id} />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField
                      name="description"
                      id={`desc-${line.id}`}
                      label={t("po.lineDescription", locale)}
                      defaultValue={line.description}
                      required
                      fieldClassName="sm:col-span-2"
                      disabled={!editable}
                    />
                    <TextField
                      name="part_no"
                      id={`part-${line.id}`}
                      label={t("po.linePartNo", locale)}
                      defaultValue={line.part_no ?? ""}
                      disabled={!editable}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField
                      name="qty_ordered"
                      id={`qty-${line.id}`}
                      inputMode="decimal"
                      label={t("po.lineQtyOrdered", locale)}
                      defaultValue={formatQty(line.qty_ordered)}
                      required
                      disabled={!editable}
                    />
                    <TextField
                      name="unit_price"
                      id={`price-${line.id}`}
                      inputMode="decimal"
                      label={t("po.lineUnitPriceExVat", locale)}
                      defaultValue={(line.unit_price_cents / 100).toFixed(2)}
                      disabled={!editable}
                    />
                    {/* The one field somebody standing at the tailgate is here to fill in,
                        so it says what it means rather than "qty 2". */}
                    <Field label={t("po.lineQtyReceived", locale)} htmlFor={`recv-${line.id}`}>
                      <Input
                        id={`recv-${line.id}`}
                        name="qty_received"
                        inputMode="decimal"
                        defaultValue={formatQty(line.qty_received)}
                        disabled={!editable}
                      />
                    </Field>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-sm text-sand-600">
                      {t("po.lineTotal", locale)}{" "}
                      <span className="font-semibold tabular-nums text-sand-900">
                        {rands(lineTotalCents(line))}
                      </span>
                    </span>

                    {over ? (
                      <Badge tone="warning">{t("po.lineOverDelivered", locale)}</Badge>
                    ) : outstanding > 0 ? (
                      <Badge tone="neutral">
                        {formatQty(outstanding)} {t("po.lineStillToCome", locale)}
                      </Badge>
                    ) : (
                      <Badge tone="ok">{t("po.lineAllHere", locale)}</Badge>
                    )}

                    {editable ? (
                      <span className="ml-auto flex items-center gap-2">
                        <SubmitButton variant="secondary" size="sm">
                          {t("po.lineSave", locale)}
                        </SubmitButton>
                      </span>
                    ) : null}
                  </div>
                </form>

                {editable ? (
                  <div className="mt-2 flex justify-end border-t border-sand-100 pt-2">
                    <ConfirmDialog
                      action={removeLine}
                      triggerLabel={t("common.remove", locale)}
                      triggerIcon={<TrashIcon />}
                      triggerVariant="ghost"
                      triggerSize="sm"
                      title={t("po.lineRemoveTitle", locale)}
                      intro={line.description}
                      consequences={[
                        t("po.lineRemoveConsequence", locale),
                        t("po.lineRemoveTotals", locale),
                      ]}
                      confirmLabel={t("common.remove", locale)}
                      cancelLabel={t("common.cancel", locale)}
                      closeLabel={t("ui.close", locale)}
                    >
                      <input type="hidden" name="order_id" value={order.id} />
                      <input type="hidden" name="line_id" value={line.id} />
                    </ConfirmDialog>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editable ? (
        <form action={addLine} className="mt-4 flex flex-col gap-3 border-t border-sand-200 pt-4">
          <input type="hidden" name="order_id" value={order.id} />
          <p className="text-sm font-semibold text-sand-800">{t("po.addLineTitle", locale)}</p>

          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              name="description"
              label={t("po.lineDescription", locale)}
              hint={t("po.lineDescriptionHint", locale)}
              required
              fieldClassName="sm:col-span-2"
            />
            <TextField name="part_no" label={t("po.linePartNo", locale)} hint={t("po.linePartNoHint", locale)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="qty_ordered"
              inputMode="decimal"
              label={t("po.lineQtyOrdered", locale)}
              hint={t("po.lineQtyHint", locale)}
              required
            />
            <TextField name="unit_price" inputMode="decimal" label={t("po.lineUnitPrice", locale)} />
          </div>

          {/* A trade counter quotes ex-VAT and a till slip is inclusive. Asking which one
              was typed is the only way to stop the commonest capture error, and the
              conversion to ex-VAT cents happens on the server. */}
          <label className="flex items-center gap-3 text-sm text-sand-700">
            <input
              type="checkbox"
              name="price_incl_vat"
              className="h-5 w-5 rounded border-sand-300 text-brand-600"
            />
            {t("po.lineInclVat", locale)}
          </label>

          <SubmitButton className="self-start" leftIcon={<PlusIcon />}>
            {t("po.addLine", locale)}
          </SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}
