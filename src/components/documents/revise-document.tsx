"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, TextField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { rands } from "@/lib/money";
import { vatPercent } from "@/lib/format";
import { documentTotals, DOC_LINE_KINDS, type DocLine, type DocLineKind } from "@/lib/partner-docs";
import { reviseDocument } from "@/app/(app)/documents/actions";

export type ReviseLine = Pick<DocLine, "kind" | "part_no" | "description" | "qty" | "unit_price_cents">;

/**
 * Correct a document that has already gone out.
 *
 * A monthly-account customer never looks at an individual invoice — they pay off a
 * statement. For them, an invoice plus a credit note plus a replacement invoice, where one
 * corrected line belongs, makes the statement harder to read rather than more honest. So
 * the amount is editable, and the guarantee is that every version is kept.
 *
 * The form says that out loud before you start typing, because the person doing this
 * should know that what they are about to change is on file either way. That is not a
 * warning — it is the reason they are allowed to do it at all.
 *
 * Prices are typed the way the partner quotes them (the VAT-inclusive switch) and stored
 * ex-VAT, exactly as on the draft line form. A correction that silently changed the basis
 * of every figure would be a worse bug than the one being corrected.
 */
export function ReviseDocument({
  documentId,
  number,
  lines,
  vatRateBps,
  totalCents,
  amountPaidCents,
  revision,
  locale,
}: {
  documentId: string;
  number: string;
  lines: ReviseLine[];
  vatRateBps: number;
  totalCents: number;
  amountPaidCents: number;
  revision: number;
  locale: Lang;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ReviseLine[]>(
    lines.length > 0 ? lines : [{ kind: "part", part_no: null, description: "", qty: 1, unit_price_cents: 0 }],
  );
  const [inclusive, setInclusive] = useState(false);

  const preview = documentTotals(
    rows.map((r) => ({ qty: r.qty, unit_price_cents: r.unit_price_cents, discount_cents: 0 })),
    vatRateBps,
  );
  // What the customer will owe if this is saved. Shown live, because the number moving is
  // the whole point of opening the form.
  const previewTotal = inclusive
    ? rows.reduce((s, r) => s + Math.round(r.qty * r.unit_price_cents), 0)
    : preview.totalCents;

  const set = (i: number, patch: Partial<ReviseLine>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (!open) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {t("revise.title", locale)}
            {revision > 1 ? (
              <Badge tone="info" className="ml-2 align-middle">
                {t("revise.versionN", locale).replace("{n}", String(revision))}
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <p className="mb-3 text-sm text-sand-600">{t("revise.intro", locale)}</p>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {t("revise.open", locale)}
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("revise.title", locale)}</CardTitle>
      </CardHeader>

      <form action={reviseDocument} className="flex flex-col gap-3">
        <input type="hidden" name="document_id" value={documentId} />
        <input type="hidden" name="current_vat_rate_bps" value={vatRateBps} />

        <Field
          label={t("revise.reason", locale)}
          hint={t("revise.reasonHint", locale)}
          htmlFor="revise-reason"
        >
          <Input id="revise-reason" name="reason" required minLength={3} maxLength={300} />
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-sand-900">{t("revise.items", locale)}</p>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-sand-200 p-3 sm:grid-cols-[1fr,7rem,6rem,8rem,auto]">
              <Field label={t("revise.description", locale)} htmlFor={`d${i}`}>
                <Input
                  id={`d${i}`}
                  name="line_description"
                  value={r.description}
                  onChange={(e) => set(i, { description: e.target.value })}
                  required
                />
              </Field>
              <Field label={t("revise.partNo", locale)} htmlFor={`p${i}`}>
                <Input
                  id={`p${i}`}
                  name="line_part_no"
                  value={r.part_no ?? ""}
                  onChange={(e) => set(i, { part_no: e.target.value })}
                />
              </Field>
              <Field label={t("revise.qty", locale)} htmlFor={`q${i}`}>
                <Input
                  id={`q${i}`}
                  name="line_qty"
                  type="number"
                  step="0.001"
                  min={0}
                  value={r.qty}
                  onChange={(e) => set(i, { qty: Number(e.target.value) })}
                />
              </Field>
              <Field
                label={inclusive ? t("revise.priceIncl", locale) : t("revise.priceEx", locale)}
                htmlFor={`u${i}`}
              >
                <Input
                  id={`u${i}`}
                  name="line_price"
                  inputMode="decimal"
                  value={(r.unit_price_cents / 100).toFixed(2)}
                  onChange={(e) =>
                    set(i, { unit_price_cents: Math.round((Number(e.target.value) || 0) * 100) })
                  }
                />
              </Field>
              <Field label={t("revise.lineKind", locale)} htmlFor={`k${i}`}>
                <Select
                  id={`k${i}`}
                  name="line_kind"
                  value={r.kind}
                  onChange={(e) => set(i, { kind: e.target.value as DocLineKind })}
                >
                  {DOC_LINE_KINDS.map((k) => (
                    <option key={k} value={k}>{t(`lineKind.${k}`, locale)}</option>
                  ))}
                </Select>
              </Field>
              {rows.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="sm:col-span-5 sm:justify-self-start"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  {t("revise.removeLine", locale)}
                </Button>
              ) : null}
            </div>
          ))}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() =>
              setRows((prev) => [...prev, { kind: "part", part_no: null, description: "", qty: 1, unit_price_cents: 0 }])
            }
          >
            {t("revise.addLine", locale)}
          </Button>
        </div>

        <label className="flex min-h-12 items-center gap-3 text-sm text-sand-800">
          <input
            type="checkbox"
            name="prices_incl_vat"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
            className="h-5 w-5 rounded border-sand-300 text-brand-600"
          />
          {t("revise.inclVat", locale).replace("{pct}", vatPercent(vatRateBps))}
        </label>

        {/* What it was, and what it is about to become. */}
        <dl className="grid grid-cols-[1fr,auto] gap-y-1 rounded-lg bg-sand-50 p-3 text-sm">
          <dt className="text-sand-600">{t("revise.wasTotal", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-700 line-through">{rands(totalCents)}</dd>
          <dt className="font-medium text-sand-900">{t("revise.willBeTotal", locale)}</dt>
          <dd className="text-right font-semibold tabular-nums text-sand-900">{rands(previewTotal)}</dd>
          {amountPaidCents > 0 ? (
            <>
              <dt className="text-sand-600">{t("revise.alreadyPaid", locale)}</dt>
              <dd className="text-right tabular-nums text-sand-700">{rands(amountPaidCents)}</dd>
            </>
          ) : null}
        </dl>

        {amountPaidCents > 0 && previewTotal < amountPaidCents ? (
          <p className="text-sm font-medium text-status-bad">{t("revise.belowPaid", locale)}</p>
        ) : null}

        <p className="text-sm text-sand-500">
          {t("revise.keptOnFile", locale).replace("{number}", number)}
        </p>

        <div className="flex flex-wrap gap-2">
          <SubmitButton>{t("revise.save", locale)}</SubmitButton>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel", locale)}
          </Button>
        </div>
      </form>
    </Card>
  );
}
