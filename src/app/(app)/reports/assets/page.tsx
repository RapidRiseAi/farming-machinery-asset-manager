import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate, todayLocal } from "@/lib/format";
import { policyLabel, readBookValues, registerTotals } from "@/lib/depreciation";
import { setDepreciationPolicy } from "./actions";

import { Card, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { GetStarted } from "@/components/ui/empty-state";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import type { BookValueRow } from "@/lib/depreciation";

export const dynamic = "force-dynamic";

/**
 * The asset register: what the fleet is worth, on a date.
 *
 * == THE TWO PEOPLE WHO ASK FOR THIS ==========================================
 * The broker, once a year, wants a schedule of values to insure. The accountant wants
 * book values for the financials. Both answers were assembled by hand off an invoice
 * folder, and both are the same table.
 *
 * == THE DATE IS A FIELD, NOT TODAY ===========================================
 * Because the question is almost never about today. It is "what was this worth at the
 * year end", asked in March about the previous February. `farm_book_values` takes the
 * date, so the register is as-at whatever day is typed rather than a figure that quietly
 * drifts between asking and printing.
 *
 * == IT SAYS WHAT IT IS NOT ===================================================
 * Not a SARS capital-allowance schedule. A farmer who hands this to their accountant
 * believing it is one has been let down by a screen that did not say so, so it says so -
 * on the page, not only in the info panel.
 *
 * == WHO SEES IT ==============================================================
 * Whoever may see the purchase price, decided in the database: `farm_book_values` repeats
 * `machine_financials`' gate, so a farm that has not opened costs to its operators has not
 * opened them here either. `canViewFarmCosts` only decides whether to render words
 * explaining the empty screen instead of an empty table.
 */
export default async function AssetRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ on?: string; error?: string; saved?: string; edit?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);

  const supabase = await createClient();
  const canSeeCosts = await canViewFarmCosts(supabase, farmId);

  const on = sp.on && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? sp.on : undefined;
  const rows = canSeeCosts ? await readBookValues(supabase, farmId, on) : [];
  const totals = registerTotals(rows);
  // The farm day, not UTC: before 02:00 in South Africa UTC is still on yesterday.
  const asAt = on ?? todayLocal();
  // Only the owner and a manager may set a policy. The database refuses anybody else
  // inside `set_machine_depreciation`, so this decides whether to render a control that
  // would be refused rather than deciding anything about the data.
  const canSetPolicy = profile.role === "owner" || profile.role === "manager";
  // `?edit=<machine>` still works as a deep link: it opens that row's dialog on arrival.
  const editId = sp.edit && canSetPolicy ? sp.edit : null;

  const header = (
    <PageHeader
      title={t("depreciation.title", locale)}
      lead={t("depreciation.lead", locale)}
      meta={canSeeCosts ? `${t("depreciation.asAt", locale)}: ${shortDate(asAt, locale)}` : undefined}
      infoKey="assetRegister"
      locale={locale}
      back={{ href: "/reports", label: t("reports.title", locale) }}
    />
  );

  const machineName = (r: BookValueRow) => (r.reg_no ? `${r.name} · ${r.reg_no}` : r.name);

  /*
    The policy editor, one dialog per row. It used to open BELOW the table via ?edit=,
    which on a long fleet meant tapping "Change" and then scrolling to find the form. Both
    method fields are always rendered and the database ignores the one that does not
    apply, so a farm switching from straight line to reducing balance does not have to
    submit twice to see the field it needs.
  */
  const policyDialog = (r: BookValueRow) => (
    <DialogForm
      trigger={t("depreciation.change", locale)}
      triggerVariant="ghost"
      triggerSize="sm"
      title={t("depreciation.policyFor", locale).replace("{machine}", machineName(r))}
      closeLabel={t("ui.close", locale)}
      size="lg"
      defaultOpen={editId === r.machine_id}
    >
      <form action={setDepreciationPolicy} className="flex flex-col gap-3">
        <input type="hidden" name="machine_id" value={r.machine_id} />
        <DialogFields>
          <Field label={t("depreciation.fieldMethod", locale)} htmlFor={`dp-method-${r.machine_id}`}>
            <Select id={`dp-method-${r.machine_id}`} name="method" defaultValue={r.method}>
              <option value="none">{t("depreciation.methodNone", locale)}</option>
              <option value="straight_line">{t("depreciation.methodStraight", locale)}</option>
              <option value="reducing_balance">{t("depreciation.methodReducing", locale)}</option>
            </Select>
          </Field>
          <Field
            label={t("depreciation.fieldYears", locale)}
            htmlFor={`dp-years-${r.machine_id}`}
            hint={t("depreciation.fieldYearsHint", locale)}
          >
            <Input
              id={`dp-years-${r.machine_id}`}
              name="years"
              inputMode="decimal"
              defaultValue={r.life_months != null ? String(r.life_months / 12) : ""}
            />
          </Field>
          <Field
            label={t("depreciation.fieldRate", locale)}
            htmlFor={`dp-rate-${r.machine_id}`}
            hint={t("depreciation.fieldRateHint", locale)}
          >
            <Input
              id={`dp-rate-${r.machine_id}`}
              name="rate"
              inputMode="decimal"
              defaultValue={r.rate_bps != null ? String(r.rate_bps / 100) : ""}
            />
          </Field>
          <Field
            label={t("depreciation.fieldResidual", locale)}
            htmlFor={`dp-residual-${r.machine_id}`}
            hint={t("depreciation.fieldResidualHint", locale)}
          >
            <Input
              id={`dp-residual-${r.machine_id}`}
              name="residual"
              inputMode="decimal"
              defaultValue={r.residual_value_cents != null ? String(r.residual_value_cents / 100) : ""}
            />
          </Field>
          <Field
            label={t("depreciation.fieldStart", locale)}
            htmlFor={`dp-start-${r.machine_id}`}
            hint={t("depreciation.fieldStartHint", locale)}
          >
            <Input id={`dp-start-${r.machine_id}`} name="start" type="date" defaultValue={r.start_date ?? ""} />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={t("depreciation.cancel", locale)}>
          <SubmitButton>{t("depreciation.savePolicy", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  if (!canSeeCosts) {
    return (
      <PageContainer size="wide">
        {header}
        <GetStarted
          title={t("depreciation.deniedTitle", locale)}
          hint={t("depreciation.deniedBody", locale)}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer size="wide">
      {header}
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("depreciation.saved", locale) : undefined} />

      {/* Said on the page rather than only in the info panel: somebody is about to email
          this to their accountant. */}
      <p className="rounded-lg border border-callout-info-edge bg-callout-info-bg px-3.5 py-2.5 text-sm leading-relaxed text-sand-800">
        {t("depreciation.notTaxNote", locale)}
      </p>

      {/* The date is the first control, because the question is almost never about today. */}
      <Card>
        <form className="flex flex-wrap items-end gap-3">
          <Field label={t("depreciation.asAt", locale)} htmlFor="asat" className="flex-1">
            <Input id="asat" name="on" type="date" defaultValue={asAt} />
          </Field>
          <SubmitButton variant="secondary">{t("depreciation.recalculate", locale)}</SubmitButton>
        </form>
      </Card>

      {/*
        One column on a phone, three from `sm`.

        These are whole-fleet figures, so they carry the longest money strings in the
        product: a farm with one combine shows R5 000 000,00. `rands` joins the thousands
        with U+00A0, a NO-BREAK space, which is the right character (nobody wants "R1" on
        one line and "500 000" on the next) and which makes the value a single unbreakable
        token about 200px wide at `text-3xl`. Three of those cannot share 360px, so Chrome
        widened the layout viewport to 442px and ZOOMED THE WHOLE PAGE OUT rather than
        scrolling. Measured, with every other screen sitting at 360. Nothing overflowed,
        which is exactly why no scrollbar ever gave it away.
      */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label={t("depreciation.statCost", locale)} value={rands(totals.cost)} />
        <Stat label={t("depreciation.statBook", locale)} value={rands(totals.book)} tone="brand" />
        <Stat
          label={t("depreciation.statWrittenOff", locale)}
          value={rands(totals.depreciated)}
        />
      </div>

      {/* The register's own to-do list. A machine with a price and no policy is carried at
          cost, which quietly overstates the whole register, so it is counted and named
          rather than left to be noticed. */}
      {totals.undecided > 0 ? (
        <p className="rounded-lg border border-callout-warn-edge bg-callout-warn-bg px-3.5 py-2.5 text-sm leading-relaxed text-callout-warn-ink">
          {t("depreciation.undecidedNote", locale).replace("{n}", String(totals.undecided))}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <GetStarted
          title={t("depreciation.emptyTitle", locale)}
          hint={t("depreciation.emptyBody", locale)}
        />
      ) : (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("depreciation.listTitle", locale)}</CardTitle>
          </div>
          {/* A table here, unlike the other new screens: this one is read at a desk beside
              an insurance schedule, printed, and its columns are compared down the page. */}
          <div className="relative overflow-x-auto">
            <Table stacked>
              <Thead>
                <Tr>
                  <Th>{t("depreciation.colMachine", locale)}</Th>
                  <Th>{t("depreciation.colPolicy", locale)}</Th>
                  <Th className="text-right">{t("depreciation.colCost", locale)}</Th>
                  <Th className="text-right">{t("depreciation.colWrittenOff", locale)}</Th>
                  <Th className="text-right">{t("depreciation.colBook", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((r) => {
                  const policy = policyLabel(r);
                  let policyText = t(policy.key, locale);
                  for (const [k, v] of Object.entries(policy.vars)) {
                    policyText = policyText.replace(`{${k}}`, v);
                  }
                  return (
                    <Tr key={r.machine_id}>
                      <Td label={t("depreciation.colMachine", locale)}>
                        <Link
                          href={`/machines/${r.machine_id}`}
                          className="focus-ring rounded font-medium text-brand-ink hover:underline"
                        >
                          {machineName(r)}
                        </Link>
                        <span className="block text-xs text-sand-500">
                          {enumLabel("machineType", r.type, locale)}
                          {r.purchase_date ? ` · ${shortDate(r.purchase_date, locale)}` : ""}
                        </span>
                      </Td>
                      <Td label={t("depreciation.colPolicy", locale)} className="text-sm text-sand-700">
                        <span className="flex flex-wrap items-center justify-end gap-x-2 lg:justify-start">
                          <span>{policyText}</span>
                          {canSetPolicy ? policyDialog(r) : null}
                        </span>
                      </Td>
                      <Td label={t("depreciation.colCost", locale)} className="text-right tabular-nums">
                        {r.purchase_price_cents != null ? rands(r.purchase_price_cents) : "-"}
                      </Td>
                      <Td label={t("depreciation.colWrittenOff", locale)} className="text-right tabular-nums text-sand-600">
                        {r.depreciated_cents != null ? rands(r.depreciated_cents) : "-"}
                      </Td>
                      <Td label={t("depreciation.colBook", locale)} className="text-right font-semibold tabular-nums">
                        {r.book_value_cents != null ? rands(r.book_value_cents) : "-"}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        </Card>
      )}

    </PageContainer>
  );
}
