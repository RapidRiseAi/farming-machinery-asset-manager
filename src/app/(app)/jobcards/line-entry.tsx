"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { rands, parseRandsToCents, exVatCents } from "@/lib/money";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import { addLine } from "./actions";

export function LineEntry({
  jobCardId,
  farmId,
  vatRateBps,
  locale,
}: {
  jobCardId: string;
  farmId: string;
  vatRateBps: number;
  locale: Locale;
}) {
  const [kind, setKind] = useState<"part" | "labour" | "other">("part");
  const [inclVat, setInclVat] = useState(false);
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [hours, setHours] = useState("");
  const [rate, setRate] = useState("");
  const [queued, setQueued] = useState(false);

  // Offline: queue the line locally (idempotency UUID + client ts) instead of failing.
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (isOnline() || !canQueueOffline()) return; // online → native server action
    e.preventDefault();
    const form = e.currentTarget;
    await queueMutation({ type: "add_job_line", scope: "app", fields: fieldsFromForm(form) });
    setQty(""); setUnit(""); setHours(""); setRate("");
    setQueued(true);
    window.setTimeout(() => setQueued(false), 2500);
  };

  // Live preview of what will be stored (the DB trigger computes the canonical total).
  const baseCents = parseRandsToCents(kind === "labour" ? rate : unit) ?? 0;
  const mult = kind === "part" ? Number(qty) || 0 : kind === "labour" ? Number(hours) || 0 : 1;
  const enteredTotal = Math.round(baseCents * (mult || (kind === "other" ? 1 : 0)));
  const exUnit = inclVat ? exVatCents(baseCents, vatRateBps) : baseCents;
  const exTotal = Math.round(exUnit * (mult || (kind === "other" ? 1 : 0)));
  const vatTotal = enteredTotal - exTotal;
  const showPreview = baseCents > 0;

  return (
    <form action={addLine} onSubmit={onSubmit} className="flex flex-col gap-3 rounded-xl border border-sand-200 bg-sand-50/60 p-3">
      <input type="hidden" name="job_card_id" value={jobCardId} />
      <input type="hidden" name="farm_id" value={farmId} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("jobcards.kind", locale)} htmlFor="line-kind">
          <Select id="line-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="part">{t("jobcards.partKind", locale)}</option>
            <option value="labour">{t("jobcards.labourKind", locale)}</option>
            <option value="other">{t("jobcards.otherKind", locale)}</option>
          </Select>
        </Field>
        <Field label={t("jobcards.description", locale)} htmlFor="line-desc">
          <Input id="line-desc" name="description" />
        </Field>
      </div>

      {kind === "part" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t("jobcards.partNo", locale)} htmlFor="line-partno">
            <Input id="line-partno" name="part_no" />
          </Field>
          <Field label={t("jobcards.qty", locale)} htmlFor="line-qty">
            <Input id="line-qty" name="qty" type="number" inputMode="decimal" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label={t("jobcards.unitCost", locale)} htmlFor="line-unit">
            <Input id="line-unit" name="unit_cost" type="number" inputMode="decimal" step="0.01" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
        </div>
      ) : kind === "labour" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("jobcards.hours", locale)} htmlFor="line-hours">
            <Input id="line-hours" name="hours" type="number" inputMode="decimal" step="0.01" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <Field label={t("jobcards.rate", locale)} htmlFor="line-rate">
            <Input id="line-rate" name="rate" type="number" inputMode="decimal" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
      ) : (
        <Field label={t("jobcards.amount", locale)} htmlFor="line-amount">
          <Input id="line-amount" name="unit_cost" type="number" inputMode="decimal" step="0.01" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </Field>
      )}

      <label className="flex items-center gap-2 text-sm text-sand-700">
        <input type="checkbox" name="incl_vat" value="1" checked={inclVat} onChange={(e) => setInclVat(e.target.checked)} className="h-4 w-4 rounded border-sand-300" />
        {t("jobcards.inclVat", locale)}
      </label>

      {showPreview ? (
        <p className="text-sm text-sand-600" aria-live="polite">
          {inclVat
            ? `${rands(enteredTotal)} ${t("jobcards.incl", locale)} → ${rands(exTotal)} ${t("jobcards.ex", locale)} + ${rands(vatTotal)} ${t("jobcards.vat", locale)}`
            : `${rands(exTotal)} ${t("jobcards.ex", locale)}`}
        </p>
      ) : null}

      <SubmitButton variant="primary" size="sm" className="self-start">{t("jobcards.add", locale)}</SubmitButton>
      {queued ? (
        <p role="status" className="text-sm font-medium text-status-due">✓ {t("offline.savedOffline", locale)}</p>
      ) : null}
    </form>
  );
}
