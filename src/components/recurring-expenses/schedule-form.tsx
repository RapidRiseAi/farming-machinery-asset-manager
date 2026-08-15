"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES } from "@/lib/expenses";
import { CADENCES, advanceByCadence, type Cadence } from "@/lib/recurring-expenses";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { createExpenseSchedule } from "@/app/(app)/recurring-expenses/actions";

/**
 * Setting up a standing cost.
 *
 * A client component for two reasons, both of them things that are impossible to see in a
 * static form and expensive to get wrong TWELVE TIMES rather than once:
 *
 *  1. The VAT split, shown live. A partner types R5 175,00 off the landlord's invoice and
 *     sees "R4 500,00 + R675,00 VAT" appear underneath before pressing anything. That is
 *     what stops the commonest capture error — the inclusive amount typed into an ex-VAT
 *     field — and on a schedule the error repeats every month until somebody notices.
 *  2. The next two dates. A schedule started on the 31st falls on the 28th in February and
 *     the 31st again in March; seeing both before saving is what stops a partner assuming
 *     it has drifted. The arithmetic is `advanceByCadence`, which mirrors
 *     `app.advance_by_cadence`, so this preview cannot disagree with the generator.
 */
export function ExpenseScheduleForm({ locale, vatRegistered }: { locale: Lang; vatRegistered: boolean }) {
  const [amount, setAmount] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [percent, setPercent] = useState(vatRegistered ? "15" : "0");
  const [vatOverride, setVatOverride] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));

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
    <Card>
      <CardHeader>
        <CardTitle>{t("recexp.addTitle", locale)}</CardTitle>
      </CardHeader>

      <form action={createExpenseSchedule} className="flex flex-col gap-3">
        <TextField name="name" label={t("recexp.name", locale)} hint={t("recexp.nameHint", locale)} required />

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="supplier_name"
            label={t("recexp.supplier", locale)}
            hint={t("recexp.supplierHint", locale)}
            required
          />
          <TextField name="reference" label={t("recexp.reference", locale)} hint={t("recexp.referenceHint", locale)} />
        </div>

        <SelectField name="category" label={t("recexp.category", locale)} defaultValue="rent">
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`expenseCategory.${c}`, locale)}
            </option>
          ))}
        </SelectField>

        <div className="grid gap-3 sm:grid-cols-3">
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
        </div>

        <label className="flex items-center gap-3 text-sm text-sand-700">
          <input
            type="checkbox"
            name="amount_incl_vat"
            className="h-5 w-5 rounded border-sand-300 text-brand-600"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
          />
          {t("recexp.inclVat", locale)}
        </label>

        {typed > 0 ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
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

        <div className="grid gap-3 sm:grid-cols-3">
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
          <TextField name="ends_on" type="date" label={t("recexp.endsOn", locale)} hint={t("recexp.endsOnHint", locale)} />
        </div>

        {then ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
            {t("recexp.thenPreview", locale)} <span className="font-medium text-sand-900">{then}</span>,{" "}
            <span className="font-medium text-sand-900">{after}</span>…
          </p>
        ) : null}

        <label className="flex items-start gap-3 text-sm text-sand-700">
          <input type="checkbox" name="vat_claimable" defaultChecked className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600" />
          <span>
            {t("recexp.claimable", locale)}
            <span className="block text-xs text-sand-500">{t("recexp.claimableHint", locale)}</span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm text-sand-700">
          <input type="checkbox" name="auto_paid" className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600" />
          <span>
            {t("recexp.autoPaid", locale)}
            <span className="block text-xs text-sand-500">{t("recexp.autoPaidHint", locale)}</span>
          </span>
        </label>

        <TextField name="supplier_vat_number" label={t("recexp.supplierVat", locale)} hint={t("recexp.supplierVatHint", locale)} />
        <TextField name="description" label={t("recexp.description", locale)} hint={t("recexp.descriptionHint", locale)} />

        <SubmitButton className="self-start">{t("recexp.save", locale)}</SubmitButton>
      </form>
    </Card>
  );
}
