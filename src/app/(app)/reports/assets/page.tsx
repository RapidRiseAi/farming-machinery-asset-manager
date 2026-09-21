import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate } from "@/lib/format";
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
import { PageInfoButton } from "@/components/ui/page-info-button";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/**
 * The asset register: what the fleet is worth, on a date.
 *
 * ── THE TWO PEOPLE WHO ASK FOR THIS ──────────────────────────────────────────
 * The broker, once a year, wants a schedule of values to insure. The accountant wants
 * book values for the financials. Both answers were assembled by hand off an invoice
 * folder, and both are the same table.
 *
 * ── THE DATE IS A FIELD, NOT TODAY ───────────────────────────────────────────
 * Because the question is almost never about today. It is "what was this worth at the
 * year end", asked in March about the previous February. `farm_book_values` takes the
 * date, so the register is as-at whatever day is typed rather than a figure that quietly
 * drifts between asking and printing.
 *
 * ── IT SAYS WHAT IT IS NOT ───────────────────────────────────────────────────
 * Not a SARS capital-allowance schedule. A farmer who hands this to their accountant
 * believing it is one has been let down by a screen that did not say so, so it says so —
 * on the page, not only in the info panel.
 *
 * ── WHO SEES IT ──────────────────────────────────────────────────────────────
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
  const asAt = on ?? new Date().toISOString().slice(0, 10);
  // Only the owner and a manager may set a policy. The database refuses anybody else
  // inside `set_machine_depreciation`, so this decides whether to render a control that
  // would be refused rather than deciding anything about the data.
  const canSetPolicy = profile.role === "owner" || profile.role === "manager";
  const editing = sp.edit && canSetPolicy ? rows.find((r) => r.machine_id === sp.edit) ?? null : null;

  const header = (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
          {t("depreciation.title", locale)}
        </h1>
        <PageInfoButton infoKey="assetRegister" locale={locale} />
      </div>
      <p className="mt-1 text-sm text-sand-600">{t("depreciation.lead", locale)}</p>
    </div>
  );

  if (!canSeeCosts) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {header}
        <GetStarted
          title={t("depreciation.deniedTitle", locale)}
          hint={t("depreciation.deniedBody", locale)}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
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

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("depreciation.statCost", locale)} value={rands(totals.cost)} />
        <Stat label={t("depreciation.statBook", locale)} value={rands(totals.book)} tone="brand" />
        <Stat
          label={t("depreciation.statWrittenOff", locale)}
          value={rands(totals.depreciated)}
        />
      </div>

      {/* The register's own to-do list. A machine with a price and no policy is carried at
          cost, which quietly overstates the whole register — so it is counted and named
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
            <Table>
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
                      <Td>
                        <Link
                          href={`/machines/${r.machine_id}`}
                          className="focus-ring rounded font-medium text-brand-ink hover:underline"
                        >
                          {r.reg_no ? `${r.name} · ${r.reg_no}` : r.name}
                        </Link>
                        <span className="block text-xs text-sand-500">
                          {enumLabel("machineType", r.type, locale)}
                          {r.purchase_date ? ` · ${shortDate(r.purchase_date, locale)}` : ""}
                        </span>
                      </Td>
                      <Td className="text-sm text-sand-700">
                        {policyText}
                        {canSetPolicy ? (
                          <Link
                            href={`/reports/assets?${on ? `on=${on}&` : ""}edit=${r.machine_id}`}
                            className="ml-2 text-xs font-medium text-brand-ink underline"
                          >
                            {t("depreciation.change", locale)}
                          </Link>
                        ) : null}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.purchase_price_cents != null ? rands(r.purchase_price_cents) : "—"}
                      </Td>
                      <Td className="text-right tabular-nums text-sand-600">
                        {r.depreciated_cents != null ? rands(r.depreciated_cents) : "—"}
                      </Td>
                      <Td className="text-right font-semibold tabular-nums">
                        {r.book_value_cents != null ? rands(r.book_value_cents) : "—"}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        </Card>
      )}

      {/* The policy editor, below the table rather than inside a row: a form nested in a
          horizontally scrolling table is a form somebody has to scroll sideways to submit,
          and this one is filled in at a desk with a schedule of values beside it. Both
          method fields are always rendered and the database ignores the one that does not
          apply, so a farm switching from straight line to reducing balance does not have
          to submit twice to see the field they need. */}
      {editing ? (
        <Card>
          <CardTitle>
            {t("depreciation.policyFor", locale).replace(
              "{machine}",
              editing.reg_no ? `${editing.name} · ${editing.reg_no}` : editing.name,
            )}
          </CardTitle>
          <form action={setDepreciationPolicy} className="mt-3 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="machine_id" value={editing.machine_id} />
            <Field label={t("depreciation.fieldMethod", locale)} htmlFor="dp-method">
              <Select id="dp-method" name="method" defaultValue={editing.method}>
                <option value="none">{t("depreciation.methodNone", locale)}</option>
                <option value="straight_line">{t("depreciation.methodStraight", locale)}</option>
                <option value="reducing_balance">{t("depreciation.methodReducing", locale)}</option>
              </Select>
            </Field>
            <Field
              label={t("depreciation.fieldYears", locale)}
              htmlFor="dp-years"
              hint={t("depreciation.fieldYearsHint", locale)}
            >
              <Input
                id="dp-years"
                name="years"
                inputMode="decimal"
                defaultValue={editing.life_months != null ? String(editing.life_months / 12) : ""}
              />
            </Field>
            <Field
              label={t("depreciation.fieldRate", locale)}
              htmlFor="dp-rate"
              hint={t("depreciation.fieldRateHint", locale)}
            >
              <Input
                id="dp-rate"
                name="rate"
                inputMode="decimal"
                defaultValue={editing.rate_bps != null ? String(editing.rate_bps / 100) : ""}
              />
            </Field>
            <Field
              label={t("depreciation.fieldResidual", locale)}
              htmlFor="dp-residual"
              hint={t("depreciation.fieldResidualHint", locale)}
            >
              <Input
                id="dp-residual"
                name="residual"
                inputMode="decimal"
                defaultValue={
                  editing.residual_value_cents != null
                    ? String(editing.residual_value_cents / 100)
                    : ""
                }
              />
            </Field>
            <Field
              label={t("depreciation.fieldStart", locale)}
              htmlFor="dp-start"
              hint={t("depreciation.fieldStartHint", locale)}
            >
              <Input id="dp-start" name="start" type="date" defaultValue={editing.start_date ?? ""} />
            </Field>
            <div className="flex items-end gap-2 sm:col-span-2">
              <SubmitButton variant="primary">{t("depreciation.savePolicy", locale)}</SubmitButton>
              <Link
                href={`/reports/assets${on ? `?on=${on}` : ""}`}
                className={buttonVariants({ variant: "ghost" })}
              >
                {t("depreciation.cancel", locale)}
              </Link>
            </div>
          </form>
        </Card>
      ) : null}

      <p className="text-sm text-sand-600">
        <Link href="/reports" className="font-medium text-brand-ink underline">
          {t("depreciation.backToReports", locale)}
        </Link>
      </p>
    </div>
  );
}
