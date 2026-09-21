import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  WARRANTY_CLAIM_COLUMNS,
  WARRANTY_STATUSES,
  claimLook,
  coverLook,
  coverReasonKey,
  coverVerdict,
  daysWaiting,
  type WarrantyClaimRow,
  type WarrantyCover,
} from "@/lib/warranty-claims";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";

import {
  removeWarrantyClaim,
  startWarrantyClaim,
  updateWarrantyClaim,
} from "@/app/(app)/jobcards/warranty-actions";

/**
 * "Was this under warranty?" on the repair it is about, and the claim if there is one.
 *
 * ── Why it lives on the job card ─────────────────────────────────────────────
 * Because that is where the question is asked. A farm looks at a repair, sees what it
 * cost, and wonders whether the dealer should have paid for it. Putting the answer
 * anywhere else means the wondering happens and the looking does not.
 *
 * ── The verdict is about the DAY of the repair ───────────────────────────────
 * `app.job_card_warranty_cover` judges the machine's warranty against this job card's
 * `date_in` and `meter_reading`, not against today. Six weeks later "is it under warranty"
 * can be no while "was it, in January" is still yes, and that gap is where the money goes.
 *
 * ── Three answers, not two ───────────────────────────────────────────────────
 * "Warranty not recorded" is not "out of warranty". It is the amber one, because the farm
 * should go and look at the paperwork rather than be told they have no claim.
 *
 * ── Its own component, and its own reads ─────────────────────────────────────
 * So adding this to a 366-line page is one line there. It costs two queries on a page that
 * already makes several, and both are caller-scoped.
 */
export async function WarrantyPanel({
  jobCardId,
  machineId,
  locale,
  canManage,
}: {
  jobCardId: string;
  machineId: string;
  locale: Lang;
  /** Owner, manager or mechanic. An operator reads the verdict and files nothing. */
  canManage: boolean;
}) {
  const supabase = await createClient();

  const [{ data: coverData }, { data: claimData }] = await Promise.all([
    supabase.rpc("job_card_warranty_cover", { p_job_card: jobCardId }).maybeSingle(),
    supabase
      .from("warranty_claims")
      .select(WARRANTY_CLAIM_COLUMNS)
      .eq("job_card_id", jobCardId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);

  const cover = (coverData as WarrantyCover | null) ?? null;
  const claim = (claimData as WarrantyClaimRow | null) ?? null;
  const verdict = coverVerdict(cover);
  const look = coverLook(verdict);
  const reasonKey = coverReasonKey(cover);
  const waiting = claim ? daysWaiting(claim) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("warranty.title", locale)}</CardTitle>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>
        {cover?.on_date ? (
          <span className="text-sm text-sand-600">
            {t("warranty.coverOn", locale).replace("{date}", shortDate(cover.on_date, locale))}
            {cover.meter_reading != null
              ? ` ${t("warranty.coverAtReading", locale).replace("{reading}", String(cover.meter_reading))}`
              : ""}
          </span>
        ) : null}
      </div>

      {reasonKey ? (
        <p className="mt-1.5 text-sm text-sand-600">{t(reasonKey, locale)}</p>
      ) : null}
      {verdict === "unknown" ? (
        <p className="mt-1.5 text-sm text-sand-600">{t("warranty.unknownHint", locale)}</p>
      ) : null}

      {/* The claim itself. Rendered whenever one exists, whatever the verdict says: a farm
          may well claim on a repair the dates call out of warranty, and win. */}
      {claim ? (
        <div className="mt-4 border-t border-sand-200 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-ink">
                {claim.supplier ?? t("warranty.claimTitle", locale)}
                {claim.reference ? (
                  <span className="text-sand-500"> · {claim.reference}</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-sm text-sand-600">
                {claim.status === "paid" && claim.recovered_ex_vat_cents != null && claim.decided_on
                  ? t("warranty.paidFor", locale)
                      .replace("{amount}", rands(claim.recovered_ex_vat_cents))
                      .replace("{date}", shortDate(claim.decided_on, locale))
                  : waiting != null
                    ? t("warranty.waitingDays", locale).replace("{n}", String(waiting))
                    : claim.submitted_on
                      ? t("warranty.sentOn", locale).replace(
                          "{date}",
                          shortDate(claim.submitted_on, locale),
                        )
                      : ""}
                {claim.claimed_ex_vat_cents != null ? (
                  <span className="text-sand-500">
                    {" · "}
                    {t("warranty.claimedAmount", locale).replace(
                      "{amount}",
                      rands(claim.claimed_ex_vat_cents),
                    )}
                  </span>
                ) : null}
              </p>
            </div>
            <Badge tone={claimLook(claim.status).tone}>
              {t(claimLook(claim.status).labelKey, locale)}
            </Badge>
          </div>
          {claim.notes ? (
            <p className="mt-1.5 text-sm text-sand-600">{claim.notes}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 border-t border-sand-200 pt-3 text-sm text-sand-600">
          {t("warranty.claimNone", locale)}
        </p>
      )}

      {canManage ? (
        <form
          action={claim ? updateWarrantyClaim : startWarrantyClaim}
          className="mt-3 grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="job_card_id" value={jobCardId} />
          <input type="hidden" name="machine_id" value={machineId} />
          {claim ? <input type="hidden" name="id" value={claim.id} /> : null}
          {/* The verdict as it stood when the claim was raised, carried onto the row. */}
          {!claim ? (
            <>
              <input type="hidden" name="covered_by_date" value={String(cover?.covered_by_date)} />
              <input type="hidden" name="covered_by_hours" value={String(cover?.covered_by_hours)} />
            </>
          ) : null}

          <Field
            label={t("warranty.fieldSupplier", locale)}
            htmlFor="wc-supplier"
            hint={t("warranty.fieldSupplierHint", locale)}
          >
            <Input id="wc-supplier" name="supplier" maxLength={80} defaultValue={claim?.supplier ?? ""} />
          </Field>
          <Field label={t("warranty.fieldReference", locale)} htmlFor="wc-ref">
            <Input id="wc-ref" name="reference" maxLength={40} defaultValue={claim?.reference ?? ""} />
          </Field>
          <Field label={t("warranty.fieldStatus", locale)} htmlFor="wc-status">
            <Select id="wc-status" name="status" defaultValue={claim?.status ?? "draft"}>
              {WARRANTY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(claimLook(s).labelKey, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("warranty.fieldSubmitted", locale)} htmlFor="wc-sent">
            <Input
              id="wc-sent"
              name="submitted_on"
              type="date"
              defaultValue={claim?.submitted_on ?? ""}
            />
          </Field>
          <Field label={t("warranty.fieldClaimed", locale)} htmlFor="wc-claimed">
            <Input
              id="wc-claimed"
              name="claimed_ex_vat_cents"
              inputMode="decimal"
              defaultValue={
                claim?.claimed_ex_vat_cents != null ? String(claim.claimed_ex_vat_cents / 100) : ""
              }
            />
          </Field>
          <Field label={t("warranty.fieldRecovered", locale)} htmlFor="wc-recovered">
            <Input
              id="wc-recovered"
              name="recovered_ex_vat_cents"
              inputMode="decimal"
              defaultValue={
                claim?.recovered_ex_vat_cents != null
                  ? String(claim.recovered_ex_vat_cents / 100)
                  : ""
              }
            />
          </Field>
          <Field label={t("warranty.fieldDecided", locale)} htmlFor="wc-decided">
            <Input
              id="wc-decided"
              name="decided_on"
              type="date"
              defaultValue={claim?.decided_on ?? ""}
            />
          </Field>
          <Field label={t("warranty.fieldNotes", locale)} htmlFor="wc-notes">
            <Input id="wc-notes" name="notes" maxLength={300} defaultValue={claim?.notes ?? ""} />
          </Field>

          <div className="sm:col-span-2">
            <p className="mb-2 text-xs text-sand-500">{t("warranty.moneyNote", locale)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton variant="primary">
                {claim ? t("warranty.claimUpdate", locale) : t("warranty.claimStart", locale)}
              </SubmitButton>
            </div>
          </div>
        </form>
      ) : null}

      {/* Its own form, outside the one above: a nested form is invalid HTML and the
          browser silently drops the inner one. */}
      {canManage && claim ? (
        <div className="mt-2">
          <ConfirmDialog
            triggerLabel={t("warranty.claimRemove", locale)}
            triggerVariant="ghost"
            triggerSize="sm"
            triggerIcon={<TrashIcon />}
            title={t("warranty.claimRemoveTitle", locale)}
            intro={t("warranty.claimRemoveBody", locale)}
            confirmLabel={t("warranty.claimRemove", locale)}
            cancelLabel={t("warranty.claimRemoveNo", locale)}
            action={removeWarrantyClaim}
          >
            <input type="hidden" name="id" value={claim.id} />
            <input type="hidden" name="job_card_id" value={jobCardId} />
          </ConfirmDialog>
        </div>
      ) : null}
    </Card>
  );
}
