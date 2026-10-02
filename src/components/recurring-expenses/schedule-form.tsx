"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { percentToBps, shortDate, todayLocal } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES } from "@/lib/expenses";
import { CADENCES, advanceByCadence, type Cadence } from "@/lib/recurring-expenses";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogForm, DialogFields, DialogSection, DialogActions } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";
import { createExpenseSchedule } from "@/app/(app)/recurring-expenses/actions";

/**
 * Setting up a standing cost (rent, insurance, a debit order), in a dialog.
 *
 * It used to sit open on `/recurring-expenses` above the list of schedules, so the
 * screen opened on an empty form rather than on what is due. Now one button asks for it.
 * What every schedule needs (name, supplier, amount, how often, from when) is up front;
 * the VAT arithmetic and the optional extras are two collapsed groups.
 *
 * A client component for two live previews: the ex-VAT/VAT split of the amount typed,
 * and the next two dates the schedule will fall on, so "monthly from the 31st" shows what
 * it means before it is saved. The fields live in `ScheduleFields`, inside the dialog, so
 * they mount fresh each time it opens.
 */
export function ExpenseScheduleForm({ locale, vatRegistered }: { locale: Lang; vatRegistered: boolean }) {
  return (
    <DialogForm
      trigger={t("recexp.addTitle", locale)}
      triggerIcon={<PlusIcon />}
      title={t("recexp.addTitle", locale)}
      closeLabel={t("ui.close", locale)}
      size="lg"
    >
      <ScheduleFields locale={locale} vatRegistered={vatRegistered} />
    </DialogForm>
  );
}

function ScheduleFields({ locale, vatRegistered }: { locale: Lang; vatRegistered: boolean }) {
  const [amount, setAmount] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [percent, setPercent] = useState(vatRegistered ? "15" : "0");
  const [vatOverride, setVatOverride] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [start, setStart] = useState(todayLocal());

  const rateBps = percentToBps(percent) ?? 0;
  const typed = parseRandsToCents(amount) ?? 0;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };
  const overrideCents = parseRandsToCents(vatOverride);
  const vatCents = rateBps === 0 ? 0 : overrideCents != null && overrideCents >= 0 ? overrideCents : split.vatCents;

  const then = /^\d{4}-\d{2}-\d{2}$/.test(start) ? advanceByCadence(start, cadence) : "";
  const after = then ? advanceByCadence(then, cadence) : "";

  return (
    <form action={createExpenseSchedule}>
      <DialogFields>
        <TextField name="name" label={t("recexp.name", locale)} hint={t("recexp.nameHint", locale)} required />
        <TextField
          name="supplier_name"
          label={t("recexp.supplier", locale)}
          hint={t("recexp.supplierHint", locale)}
          required
        />

        <Field label={t("recexp.amount", locale)} htmlFor="recexp_amount">
          <Input
            id="recexp_amount"
            name="amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <SelectField name="category" label={t("recexp.category", locale)} defaultValue="rent">
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`expenseCategory.${c}`, locale)}
            </option>
          ))}
        </SelectField>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Checkbox
            name="amount_incl_vat"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
            label={t("recexp.inclVat", locale)}
          />
          {typed > 0 ? (
            <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700" aria-live="polite">
              {t("recexp.splitPreview", locale)}{" "}
              <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents)}</span>
              {rateBps > 0 ? (
                <>
                  {" + "}
                  <span className="font-semibold tabular-nums text-sand-900">{rands(vatCents)}</span>{" "}
                  {t("recexp.splitVat", locale)}
                </>
              ) : null}
              {" = "}
              <span className="font-semibold tabular-nums text-sand-900">{rands(split.exCents + vatCents)}</span>
            </p>
          ) : null}
        </div>

        <SelectField
          name="cadence"
          label={t("recexp.howOften", locale)}
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {t(`cadence.${c}`, locale)}
            </option>
          ))}
        </SelectField>
        <TextField
          name="next_due_date"
          type="date"
          label={t("recexp.firstOn", locale)}
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />

        {then ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700 sm:col-span-2" aria-live="polite">
            {t("recexp.thenPreview", locale)} <span className="font-medium text-sand-900">{shortDate(then, locale)}</span>,{" "}
            <span className="font-medium text-sand-900">{shortDate(after, locale)}</span>…
          </p>
        ) : null}

        <div className="sm:col-span-2">
          <Checkbox
            name="auto_paid"
            label={t("recexp.autoPaid", locale)}
            hint={t("recexp.autoPaidHint", locale)}
          />
        </div>

        <DialogSection title={t("expenses.vatDetail", locale)}>
          <Field label={t("recexp.vatPercent", locale)} htmlFor="recexp_vat_percent">
            <div className="relative">
              <Input
                id="recexp_vat_percent"
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
          <Field label={t("recexp.vatAmount", locale)} htmlFor="recexp_vat_amount" hint={t("recexp.vatAmountHint", locale)}>
            <Input
              id="recexp_vat_amount"
              name="vat_amount"
              inputMode="decimal"
              value={vatOverride}
              onChange={(e) => setVatOverride(e.target.value)}
            />
          </Field>
          {/* Not offered when the business is not registered for VAT: it can never reclaim
              input VAT, so the question has one answer. The 0490 trigger forces it either
              way; this stops the screen suggesting a choice exists. */}
          <div className="sm:col-span-2">
            {vatRegistered ? (
              <Checkbox
                name="vat_claimable"
                defaultChecked
                label={t("recexp.claimable", locale)}
                hint={t("recexp.claimableHint", locale)}
              />
            ) : (
              <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-600">
                {t("recexp.claimableNotRegistered", locale)}
              </p>
            )}
          </div>
          <div className="sm:col-span-2">
            <TextField name="supplier_vat_number" label={t("recexp.supplierVat", locale)} hint={t("recexp.supplierVatHint", locale)} />
          </div>
        </DialogSection>

        <DialogSection title={t("expenses.moreDetail", locale)}>
          <TextField name="reference" label={t("recexp.reference", locale)} hint={t("recexp.referenceHint", locale)} />
          <TextField name="ends_on" type="date" label={t("recexp.endsOn", locale)} hint={t("recexp.endsOnHint", locale)} />
          <div className="sm:col-span-2">
            <TextField name="description" label={t("recexp.description", locale)} hint={t("recexp.descriptionHint", locale)} />
          </div>
        </DialogSection>
      </DialogFields>

      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <SubmitButton>{t("recexp.save", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
