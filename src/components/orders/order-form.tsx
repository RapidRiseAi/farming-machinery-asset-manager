import { t, type Lang } from "@/lib/i18n";
import { TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PurchaseOrder } from "@/lib/purchase-orders";

/**
 * The order's own details — who it is with, our reference for it, and when they said it
 * would arrive. One form serves both raising a new order and correcting an existing one,
 * so the two can never drift apart.
 *
 * A server component on purpose: there is no arithmetic to preview here (the money is on
 * the lines), so nothing is gained by shipping it to the browser.
 *
 * VAT is asked in PERCENT and posted as `vat_percent`, matching the expense form. A field
 * called `vat_rate_bps` with 1500 in it reads as fifteen hundred percent to everybody who
 * is not a programmer — the mistake this product has already made once and fixed.
 */
export function OrderForm({
  locale,
  action,
  order,
  submitLabel,
}: {
  locale: Lang;
  action: (formData: FormData) => void | Promise<void>;
  order?: PurchaseOrder;
  submitLabel: string;
}) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="flex flex-col gap-3">
      {order ? <input type="hidden" name="order_id" value={order.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          name="supplier_name"
          id={order ? `supplier-${order.id}` : undefined}
          label={t("po.supplier", locale)}
          hint={t("po.supplierHint", locale)}
          defaultValue={order?.supplier_name ?? ""}
          required
        />
        <TextField
          name="reference"
          id={order ? `reference-${order.id}` : undefined}
          label={t("po.reference", locale)}
          hint={t("po.referenceHint", locale)}
          defaultValue={order?.reference ?? ""}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="order_date"
          id={order ? `order-date-${order.id}` : undefined}
          type="date"
          label={t("po.orderDate", locale)}
          defaultValue={order?.order_date ?? today}
        />
        <TextField
          name="expected_date"
          id={order ? `expected-${order.id}` : undefined}
          type="date"
          label={t("po.expectedDate", locale)}
          hint={t("po.expectedHint", locale)}
          defaultValue={order?.expected_date ?? ""}
        />
        {/* Percent, not the stored basis points — and without the "%" a display helper
            would add, because this is an input rather than a reading. */}
        <TextField
          name="vat_percent"
          id={order ? `vat-${order.id}` : undefined}
          inputMode="decimal"
          label={t("po.vatPercent", locale)}
          hint={t("po.vatPercentHint", locale)}
          defaultValue={String((order?.vat_rate_bps ?? 1500) / 100)}
        />
      </div>

      <TextareaField
        name="notes"
        id={order ? `notes-${order.id}` : undefined}
        rows={2}
        label={t("po.notes", locale)}
        hint={t("po.notesHint", locale)}
        defaultValue={order?.notes ?? ""}
      />

      <SubmitButton className="self-start">{submitLabel}</SubmitButton>
    </form>
  );
}
