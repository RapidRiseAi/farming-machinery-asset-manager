"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents } from "@/lib/money";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { billQuoteStage } from "@/app/(app)/documents/actions";

export type QuoteBilling = {
  quoted_cents: number;
  billed_cents: number;
  draft_cents: number;
  remaining_cents: number;
  over_billed: boolean;
  invoice_count: number;
};

/**
 * "Bill part of this job."
 *
 * A deposit up front and a payment on completion are the same act to a ledger — an
 * invoice for part of an agreed job — so this is one control, not two features. The
 * quick buttons are the amounts a workshop actually says out loud (half up front, the
 * rest at the end); the amount box is there for everything else.
 *
 * It shows what has already been billed against the quote, because the question a
 * partner has at this moment is never "what does the job cost" — they wrote the quote —
 * it is "how much of it have I already asked for".
 */
export function BillInStages({
  documentId,
  billing,
  locale,
}: {
  documentId: string;
  billing: QuoteBilling;
  locale: Lang;
}) {
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");

  const typed = parseRandsToCents(amount);
  const pct = Number.parseFloat(percent);
  const previewCents =
    typed != null && typed > 0
      ? typed
      : Number.isFinite(pct) && pct > 0
        ? Math.round((billing.quoted_cents * pct) / 100)
        : 0;

  const setPct = (p: number) => {
    setPercent(String(p));
    setAmount("");
  };
  const billTheRest = () => {
    setAmount(String(billing.remaining_cents / 100));
    setPercent("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("stage.title", locale)}</CardTitle>
      </CardHeader>

      <p className="text-sm text-sand-600">{t("stage.intro", locale)}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-sand-200 bg-sand-50 px-3 py-2.5 text-sm sm:max-w-sm">
        <dt className="text-sand-600">{t("stage.quoted", locale)}</dt>
        <dd className="text-right tabular-nums text-sand-900">{rands(billing.quoted_cents)}</dd>
        <dt className="text-sand-600">{t("stage.billed", locale)}</dt>
        <dd className="text-right tabular-nums text-sand-900">{rands(billing.billed_cents)}</dd>
        {billing.draft_cents > 0 ? (
          <>
            <dt className="text-sand-600">{t("stage.inDraft", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-500">{rands(billing.draft_cents)}</dd>
          </>
        ) : null}
        <dt className="font-medium text-sand-800">{t("stage.remaining", locale)}</dt>
        <dd className="text-right font-semibold tabular-nums text-sand-900">{rands(billing.remaining_cents)}</dd>
      </dl>

      {/* Billing past the quote is allowed — jobs grow — but it is never a silent thing. */}
      {billing.over_billed ? (
        <p className="mt-2 text-sm text-status-warn">
          <Badge tone="warning" className="mr-2 align-middle">{t("stage.overBilledBadge", locale)}</Badge>
          {t("stage.overBilled", locale)}
        </p>
      ) : null}

      <form action={billQuoteStage} className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="document_id" value={documentId} />

        <div className="flex flex-wrap gap-2">
          {[25, 50, 75].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPct(p)}
              className="focus-ring min-h-[48px] rounded-lg border border-sand-300 px-3 text-sm font-medium text-sand-800 hover:bg-sand-50 sm:min-h-[40px]"
            >
              {p}%
            </button>
          ))}
          <button
            type="button"
            onClick={billTheRest}
            className="focus-ring min-h-[48px] rounded-lg border border-sand-300 px-3 text-sm font-medium text-sand-800 hover:bg-sand-50 sm:min-h-[40px]"
          >
            {t("stage.theRest", locale)}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("stage.percent", locale)} htmlFor="stage_percent">
            <div className="relative">
              <Input
                id="stage_percent"
                name="percent"
                inputMode="decimal"
                value={percent}
                onChange={(e) => { setPercent(e.target.value); setAmount(""); }}
                className="pr-9"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base font-medium text-sand-500" aria-hidden>
                %
              </span>
            </div>
          </Field>
          <Field label={t("stage.amount", locale)} htmlFor="stage_amount" hint={t("stage.amountHint", locale)}>
            <Input
              id="stage_amount"
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setPercent(""); }}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField name="billing_stage" label={t("stage.which", locale)} defaultValue={billing.invoice_count === 0 ? "deposit" : "progress"}>
            <option value="deposit">{t("stage.kindDeposit", locale)}</option>
            <option value="progress">{t("stage.kindProgress", locale)}</option>
            <option value="final">{t("stage.kindFinal", locale)}</option>
          </SelectField>
          <TextField name="stage_label" label={t("stage.label", locale)} hint={t("stage.labelHint", locale)} />
        </div>

        {previewCents > 0 ? (
          <p className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-sand-700">
            {t("stage.preview", locale)}{" "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(previewCents)}</span>
            {previewCents > billing.remaining_cents ? (
              <span className="block text-status-warn">{t("stage.previewOver", locale)}</span>
            ) : null}
          </p>
        ) : null}

        <SubmitButton className="self-start">{t("stage.create", locale)}</SubmitButton>
      </form>
    </Card>
  );
}
