"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES } from "@/lib/expenses";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PurchaseOrder } from "@/lib/purchase-orders";
import { convertOrder } from "@/app/(app)/orders/actions";

/**
 * The supplier's invoice arrived — capture it, and remember which order it settles.
 *
 * This is the ONLY place in the feature where money enters the books. Everything before it
 * is a commitment; this row is the cost, and it is the same `partner_expenses` row it
 * would have been if no purchase order had ever existed.
 *
 * A client component for the reason the expense form is one, plus a second: it shows the
 * VAT split live, AND it compares what is being invoiced against what was ordered. That
 * comparison is the entire commercial point of keeping purchase orders — a supplier who
 * ships eight and invoices ten is not rare, and nobody catches it by remembering what the
 * order said three weeks ago. The difference is stated in rands, before anything is saved.
 *
 * The amount is PREFILLED from the order and fully editable: the order is what we asked
 * for, the invoice is what we are being charged, and a price rise between the two is
 * ordinary. Storing the ordered amount because it was convenient would make the books
 * disagree with the paper. `convertOrder` does the same arithmetic server-side and both
 * call `splitInclusive`, so the preview cannot disagree with what is stored.
 */
export function ConvertForm({ locale, order }: { locale: Lang; order: PurchaseOrder }) {
  const [amount, setAmount] = useState((order.subtotal_cents / 100).toFixed(2));
  // Unchecked to start, because the figure above it is the order's EX-VAT subtotal. The
  // switch is here for the partner who would rather type the big number off the invoice.
  const [inclusive, setInclusive] = useState(false);
  const [percent, setPercent] = useState(String(order.vat_rate_bps / 100));
  const [vatOverride, setVatOverride] = useState("");

  const rateBps = percentToBps(percent) ?? 0;
  const typed = parseRandsToCents(amount) ?? 0;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };
  const overrideCents = parseRandsToCents(vatOverride);
  const vatCents = rateBps === 0 ? 0 : overrideCents != null && overrideCents >= 0 ? overrideCents : split.vatCents;

  // Compared ex-VAT against ex-VAT, so a different VAT rate on the invoice cannot show up
  // as an overcharge on the goods.
  const difference = split.exCents - order.subtotal_cents;

  return (
    <form action={convertOrder} className="flex flex-col gap-3">
      <input type="hidden" name="order_id" value={order.id} />

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          name="supplier_name"
          id="convert-supplier"
          label={t("po.supplier", locale)}
          defaultValue={order.supplier_name}
          required
        />
        <TextField
          name="reference"
          id="convert-reference"
          label={t("po.invoiceNumber", locale)}
          hint={t("po.invoiceNumberHint", locale)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField name="category" id="convert-category" label={t("po.category", locale)} defaultValue="parts">
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`expenseCategory.${c}`, locale)}
            </option>
          ))}
        </SelectField>
        <TextField
          name="expense_date"
          id="convert-date"
          type="date"
          label={t("po.invoiceDate", locale)}
          hint={t("po.invoiceDateHint", locale)}
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
        <TextField name="paid_on" id="convert-paid" type="date" label={t("po.paidOn", locale)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("po.invoiceAmount", locale)} htmlFor="convert-amount">
          <Input
            id="convert-amount"
            name="amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label={t("po.vatPercent", locale)} htmlFor="convert-vat-percent">
          <div className="relative">
            <Input
              id="convert-vat-percent"
              name="vat_percent"
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="pr-9"
            />
            <span
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base font-medium text-sand-500"
              aria-hidden
            >
              %
            </span>
          </div>
        </Field>
        <Field label={t("po.vatAmount", locale)} htmlFor="convert-vat-amount" hint={t("po.vatAmountHint", locale)}>
          <Input
            id="convert-vat-amount"
            name="vat_amount"
            inputMode="decimal"
            value={vatOverride}
            onChange={(e) => setVatOverride(e.target.value)}
          />
        </Field>
      </div>

      <label className="flex items-center gap-3 text-sm text-sand-700">
        <input
          type="checkbox"
          name="amount_incl_vat"
          className="h-5 w-5 rounded border-sand-300 text-brand-600"
          checked={inclusive}
          onChange={(e) => setInclusive(e.target.checked)}
        />
        {t("po.inclVat", locale)}
      </label>

      {typed > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
          <p>
            {t("po.splitPreview", locale)}{" "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents)}</span>
            {rateBps > 0 ? (
              <>
                {" + "}
                <span className="font-semibold tabular-nums text-sand-900">{rands(vatCents)}</span>{" "}
                {t("po.splitVat", locale)}
              </>
            ) : null}
            {" = "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents + vatCents)}</span>
          </p>

          {/* The comparison the order exists to make. Silence when it matches. */}
          {difference === 0 ? (
            <p className="text-status-ok">{t("po.matchesOrder", locale)}</p>
          ) : (
            <p className={difference > 0 ? "font-medium text-status-warn" : "text-sand-600"}>
              {difference > 0 ? t("po.moreThanOrdered", locale) : t("po.lessThanOrdered", locale)}{" "}
              <span className="font-semibold tabular-nums">{rands(Math.abs(difference))}</span>{" "}
              {t("po.comparedToOrder", locale)}{" "}
              <span className="tabular-nums">{rands(order.subtotal_cents)}</span>
            </p>
          )}
        </div>
      ) : null}

      <label className="flex items-start gap-3 text-sm text-sand-700">
        <input
          type="checkbox"
          name="vat_claimable"
          defaultChecked
          className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
        />
        <span>
          {t("po.claimable", locale)}
          <span className="block text-xs text-sand-500">{t("po.claimableHint", locale)}</span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          name="supplier_vat_number"
          id="convert-supplier-vat"
          label={t("po.supplierVat", locale)}
          hint={t("po.supplierVatHint", locale)}
        />
        <TextField name="description" id="convert-description" label={t("po.expenseDescription", locale)} />
      </div>

      <SubmitButton className="self-start">{t("po.convertSave", locale)}</SubmitButton>
    </form>
  );
}
