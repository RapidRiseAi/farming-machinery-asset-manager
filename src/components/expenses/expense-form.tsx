"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES } from "@/lib/expenses";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { createExpense } from "@/app/(app)/expenses/actions";

/**
 * Capturing a supplier invoice, in the order the paper is read.
 *
 * The form is a client component for one reason: it shows the split live. A partner types
 * R1 150,00 off a till slip and sees "R1 000,00 + R150,00 VAT" appear underneath before
 * pressing anything. That is what stops the commonest capture error — entering the
 * inclusive amount into an ex-VAT field — and it is invisible in a server-rendered form.
 *
 * The VAT box is pre-filled from the rate and stays editable, because the supplier's own
 * VAT line is what may legally be claimed. `createExpense` does the same arithmetic
 * server-side; this preview cannot disagree with it because both call `splitInclusive`.
 */
export function ExpenseForm({ locale, vatRegistered }: { locale: Lang; vatRegistered: boolean }) {
  const [amount, setAmount] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [percent, setPercent] = useState(vatRegistered ? "15" : "0");
  const [vatOverride, setVatOverride] = useState("");

  const rateBps = percentToBps(percent) ?? 0;
  const typed = parseRandsToCents(amount) ?? 0;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };
  const overrideCents = parseRandsToCents(vatOverride);
  const vatCents = rateBps === 0 ? 0 : (overrideCents != null && overrideCents >= 0 ? overrideCents : split.vatCents);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("expenses.addTitle", locale)}</CardTitle>
      </CardHeader>

      <form action={createExpense} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="supplier_name" label={t("expenses.supplier", locale)} required />
          <TextField name="reference" label={t("expenses.reference", locale)} hint={t("expenses.referenceHint", locale)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField name="category" label={t("expenses.category", locale)} defaultValue="parts">
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`expenseCategory.${c}`, locale)}</option>
            ))}
          </SelectField>
          <TextField
            name="expense_date"
            type="date"
            label={t("expenses.date", locale)}
            hint={t("expenses.dateHint", locale)}
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
          <TextField name="paid_on" type="date" label={t("expenses.paidOn", locale)} hint={t("expenses.paidOnHint", locale)} />
        </div>

        <TextField name="description" label={t("expenses.description", locale)} />

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("expenses.amount", locale)} htmlFor="expense_amount">
            <Input
              id="expense_amount"
              name="amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t("expenses.vatPercent", locale)} htmlFor="expense_vat_percent">
            <div className="relative">
              <Input
                id="expense_vat_percent"
                name="vat_percent"
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="pr-9"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base font-medium text-sand-500" aria-hidden>
                %
              </span>
            </div>
          </Field>
          <Field
            label={t("expenses.vatAmount", locale)}
            htmlFor="expense_vat_amount"
            hint={t("expenses.vatAmountHint", locale)}
          >
            <Input
              id="expense_vat_amount"
              name="vat_amount"
              inputMode="decimal"
              placeholder={rateBps > 0 ? String(split.vatCents / 100) : "0"}
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
          {t("expenses.inclVat", locale)}
        </label>

        {/* The live split. The whole reason this form is a client component. */}
        {typed > 0 ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
            {t("expenses.splitPreview", locale)}{" "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents)}</span>
            {rateBps > 0 ? (
              <>
                {" + "}
                <span className="font-semibold tabular-nums text-sand-900">{rands(vatCents)}</span>{" "}
                {t("expenses.splitVat", locale)}
              </>
            ) : null}
            {" = "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents + vatCents)}</span>
          </p>
        ) : null}

        <label className="flex items-start gap-3 text-sm text-sand-700">
          <input
            type="checkbox"
            name="vat_claimable"
            defaultChecked
            className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
          />
          <span>
            {t("expenses.claimable", locale)}
            <span className="block text-xs text-sand-500">{t("expenses.claimableHint", locale)}</span>
          </span>
        </label>

        <TextField name="supplier_vat_number" label={t("expenses.supplierVat", locale)} hint={t("expenses.supplierVatHint", locale)} />

        {/* Optional at capture, because the paper is usually still in the bakkie. The row
            and the VAT return carry the warning until it arrives. */}
        <Field
          label={t("expenses.receiptLabel", locale)}
          hint={t("expenses.receiptHint", locale)}
          htmlFor="expense_receipt"
        >
          <input
            id="expense_receipt"
            type="file"
            name="receipt"
            accept="image/*,application/pdf"
            className="focus-ring block w-full rounded-lg border border-sand-300 bg-white px-3 py-2.5 text-sm text-sand-700 file:mr-3 file:rounded-md file:border-0 file:bg-sand-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sand-700"
          />
        </Field>

        <SubmitButton className="self-start">{t("expenses.save", locale)}</SubmitButton>
      </form>
    </Card>
  );
}
