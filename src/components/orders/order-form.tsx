import { t, type Lang } from "@/lib/i18n";
import { todayLocal } from "@/lib/format";
import { TextField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogSection } from "@/components/ui/dialog-form";
import type { PurchaseOrder } from "@/lib/purchase-orders";

/**
 * The order's own details, who it is with, our reference for it, and when they said it
 * would arrive. One form serves both raising a new order and correcting an existing one,
 * so the two can never drift apart.
 *
 * It always lives inside a `DialogForm` ("New order" on the list, "Edit details" on an
 * order), so its submit sits in `DialogActions`, which closes the dialog once the save
 * lands. Supplier, reference and the two dates are what an order is; VAT and notes are
 * folded into "More details", opened by default when an existing order has notes.
 *
 * A server component on purpose: there is no arithmetic to preview here (the money is on
 * the lines), so nothing is gained by shipping it to the browser.
 *
 * VAT is asked in PERCENT and posted as `vat_percent`, matching the expense form. A field
 * called `vat_rate_bps` with 1500 in it reads as fifteen hundred percent to everybody who
 * is not a programmer, the mistake this product has already made once and fixed.
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
  const today = todayLocal();
  // Distinct ids for the new-order and edit forms, should both ever share a page.
  const idp = order ? `po-${order.id}` : "po-new";

  return (
    <form action={action} className="flex flex-col gap-3">
      {order ? <input type="hidden" name="order_id" value={order.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          name="supplier_name"
          id={`${idp}-supplier`}
          label={t("po.supplier", locale)}
          hint={t("po.supplierHint", locale)}
          defaultValue={order?.supplier_name ?? ""}
          required
        />
        <TextField
          name="reference"
          id={`${idp}-reference`}
          label={t("po.reference", locale)}
          hint={t("po.referenceHint", locale)}
          defaultValue={order?.reference ?? ""}
        />
        <TextField
          name="order_date"
          id={`${idp}-order-date`}
          type="date"
          label={t("po.orderDate", locale)}
          defaultValue={order?.order_date ?? today}
        />
        <TextField
          name="expected_date"
          id={`${idp}-expected`}
          type="date"
          label={t("po.expectedDate", locale)}
          hint={t("po.expectedHint", locale)}
          defaultValue={order?.expected_date ?? ""}
        />

        <DialogSection title={t("po.moreDetails", locale)} defaultOpen={Boolean(order?.notes)}>
          {/* Percent, not the stored basis points, and without the "%" a display helper
              would add, because this is an input rather than a reading. */}
          <TextField
            name="vat_percent"
            id={`${idp}-vat`}
            inputMode="decimal"
            label={t("po.vatPercent", locale)}
            hint={t("po.vatPercentHint", locale)}
            defaultValue={String((order?.vat_rate_bps ?? 1500) / 100)}
          />
          <TextareaField
            name="notes"
            id={`${idp}-notes`}
            rows={2}
            label={t("po.notes", locale)}
            hint={t("po.notesHint", locale)}
            defaultValue={order?.notes ?? ""}
            fieldClassName="sm:col-span-2"
          />
        </DialogSection>
      </div>

      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <SubmitButton variant="primary">{submitLabel}</SubmitButton>
      </DialogActions>
    </form>
  );
}
