"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { percentToBps, todayLocal } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES } from "@/lib/expenses";
import type { SupplierOption } from "@/lib/suppliers";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogForm, DialogFields, DialogSection, DialogActions } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";
import { createExpense } from "@/app/(app)/expenses/actions";

/**
 * Capturing a supplier invoice, in the order the paper is read, in a dialog.
 *
 * It used to be a card of fourteen fields on the page, above the list it fills, so the
 * list a partner came to read started below a form they had not asked for. Now the page
 * shows what was bought and one button asks for what is new. The dialog keeps the paper's
 * order: who, how much, when, what for, and the slip itself; the VAT arithmetic and the
 * extras (reference, note, paid date, supplier VAT number) sit in two collapsed groups,
 * because the defaults are right for nearly every till slip.
 *
 * The form is a client component for one reason: it shows the split live. A partner types
 * R1 150,00 off a till slip and sees "R1 000,00 + R150,00 VAT" appear underneath before
 * pressing anything. That is what stops the commonest capture error, entering the
 * inclusive amount into an ex-VAT field, and it is invisible in a server-rendered form.
 *
 * The VAT box is pre-filled from the rate and stays editable, because the supplier's own
 * VAT line is what may legally be claimed. `createExpense` does the same arithmetic
 * server-side; this preview cannot disagree with it because both call `splitInclusive`.
 *
 * The fields live in `ExpenseFields`, inside the dialog, so they mount when it opens and
 * a second invoice never starts with the first one's amount still typed in.
 *
 * == The supplier is a picker, and still a text box (G18) ====================
 *
 * Choosing from the book is what stops the third spelling of one business appearing on the
 * payables ageing. But a supplier invoice arrives from whoever the workshop bought from
 * that morning, and refusing to capture it until somebody has filed the business would move
 * the friction to the worst possible moment, so "someone new" stays one keystroke away and
 * writes plain text, exactly as it did before. The 0481 trigger links that text to a record
 * if one already matches, so typing the name of a supplier you forgot was on the list ends
 * up in the same place as picking it.
 */
export function ExpenseForm({
  locale,
  vatRegistered,
  suppliers = [],
}: {
  locale: Lang;
  vatRegistered: boolean;
  suppliers?: readonly SupplierOption[];
}) {
  return (
    <DialogForm
      trigger={t("expenses.addButton", locale)}
      triggerIcon={<PlusIcon />}
      title={t("expenses.addTitle", locale)}
      closeLabel={t("ui.close", locale)}
      size="lg"
    >
      <ExpenseFields locale={locale} vatRegistered={vatRegistered} suppliers={suppliers} />
    </DialogForm>
  );
}

function ExpenseFields({
  locale,
  vatRegistered,
  suppliers,
}: {
  locale: Lang;
  vatRegistered: boolean;
  suppliers: readonly SupplierOption[];
}) {
  const [amount, setAmount] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [percent, setPercent] = useState(vatRegistered ? "15" : "0");
  const [vatOverride, setVatOverride] = useState("");
  // "" means "someone new", the default, so a workshop with an empty book sees exactly the
  // form it saw before this feature existed.
  const [supplierId, setSupplierId] = useState("");

  const rateBps = percentToBps(percent) ?? 0;
  const typed = parseRandsToCents(amount) ?? 0;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };
  const overrideCents = parseRandsToCents(vatOverride);
  const vatCents = rateBps === 0 ? 0 : (overrideCents != null && overrideCents >= 0 ? overrideCents : split.vatCents);

  return (
    <form action={createExpense}>
      <DialogFields>
        {suppliers.length > 0 ? (
          <SelectField
            name="supplier_id"
            label={t("expenses.supplier", locale)}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            hint={supplierId === "" ? t("supplier.pickHint", locale) : undefined}
          >
            <option value="">{t("supplier.pickNew", locale)}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </SelectField>
        ) : null}

        {/* Shown whenever no record was chosen, which is every time for a workshop that
            has filed nobody, and the "someone new" case for everyone else. `required` is
            conditional for the same reason: the field is not on the form at all when a
            supplier has been picked, and a required field nobody can see cannot be
            satisfied. */}
        {supplierId === "" ? (
          <TextField
            name="supplier_name"
            label={suppliers.length > 0 ? t("supplier.newName", locale) : t("expenses.supplier", locale)}
            required
          />
        ) : null}

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

        <TextField
          name="expense_date"
          type="date"
          label={t("expenses.date", locale)}
          hint={t("expenses.dateHint", locale)}
          defaultValue={todayLocal()}
        />

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Checkbox
            name="amount_incl_vat"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
            label={t("expenses.inclVat", locale)}
          />
          {/* The live split. The whole reason this form is a client component. */}
          {typed > 0 ? (
            <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700" aria-live="polite">
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
        </div>

        <SelectField name="category" label={t("expenses.category", locale)} defaultValue="parts">
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`expenseCategory.${c}`, locale)}</option>
          ))}
        </SelectField>

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
            className="focus-ring block w-full min-w-0 rounded-lg border border-sand-300 bg-surface px-3 py-2.5 text-sm text-sand-700 file:mr-3 file:rounded-md file:border-0 file:bg-sand-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sand-700"
          />
        </Field>

        <DialogSection title={t("expenses.vatDetail", locale)}>
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

          {/* A business that is not registered for VAT can never reclaim input VAT, so asking
              is not a choice, it is a question with one answer, and offering it invites the
              wrong one. The 0490 trigger forces the column false regardless of what is
              posted; this only stops the screen implying otherwise. The VAT itself is still
              captured, because it really was paid, it is simply all cost. */}
          <div className="sm:col-span-2">
            {!vatRegistered ? (
              <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-600">
                {t("expenses.claimableNotRegistered", locale)}
              </p>
            ) : (
              <Checkbox
                name="vat_claimable"
                defaultChecked
                label={t("expenses.claimable", locale)}
                hint={t("expenses.claimableHint", locale)}
              />
            )}
          </div>

          <div className="sm:col-span-2">
            <TextField name="supplier_vat_number" label={t("expenses.supplierVat", locale)} hint={t("expenses.supplierVatHint", locale)} />
          </div>
        </DialogSection>

        <DialogSection title={t("expenses.moreDetail", locale)}>
          <TextField name="reference" label={t("expenses.reference", locale)} hint={t("expenses.referenceHint", locale)} />
          <TextField name="paid_on" type="date" label={t("expenses.paidOn", locale)} hint={t("expenses.paidOnHint", locale)} />
          <div className="sm:col-span-2">
            <TextField name="description" label={t("expenses.description", locale)} />
          </div>
        </DialogSection>
      </DialogFields>

      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <SubmitButton>{t("expenses.save", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
