import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate } from "@/lib/format";
import {
  TYRE_AXLES,
  groupByMachine,
  ratePhrase,
  statusLook,
  treadLook,
  treadUsedPct,
  treadVerdict,
  tyreTotals,
  whereKey,
  type TyreLifeRow,
} from "@/lib/tyres";

import { Card, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { GetStarted } from "@/components/ui/empty-state";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";

import { addTyre, fitTyre, recordTyreCheck, removeTyre } from "./actions";

export const dynamic = "force-dynamic";

type MachineRow = { id: string; name: string; meter_type: string };

/**
 * Every tyre, where it is, and what it has cost per hour.
 *
 * == Why it is worth a screen =================================================
 * On a truck fleet tyres are the second largest running cost after diesel, and on a farm
 * they are the cost nobody measures. Before this, "tyre" existed in FleetWise only as a
 * fault category.
 *
 * == Grouped by machine, ordered by position ==================================
 * Because that is how somebody uses it: they walk round the vehicle. A list ordered by
 * purchase date would be correct and useless.
 *
 * == Three things the screen refuses to state =================================
 * A rate for a tyre with no cost recorded, a rate for one that has not run yet, and a rate
 * for one that has been on both an hours machine and a kilometre machine. The last is the
 * dangerous one: a sum of hours and kilometres looks exactly like an answer, so the row
 * says why there is no figure instead.
 *
 * == "Never checked" is amber, not silent =====================================
 * A tyre nobody has looked at is the one to go and look at. Rendering it the same as a
 * healthy tyre is how a bald tyre stays on a trailer.
 *
 * == Why the forms are in dialogs =============================================
 * The row used to carry two or three buttons that were LINKS, to `?check=<id>`,
 * `?fit=<id>` and `?off=<id>`. Revealing four fields therefore cost a full server
 * render, and the URL you were left on reopened the form the next time you landed
 * there. The fields are the same fields; they now open over the row instead, named
 * after the tyre they are about, so recording a reading against the wrong tyre takes
 * a deliberate misreading of the dialog's own title rather than a mis-scroll.
 */
export default async function TyresPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  const canManage = ["owner", "manager", "mechanic"].includes(profile.role);

  const supabase = await createClient();
  const [{ data: lifeData }, { data: machineData }] = await Promise.all([
    farmId ? supabase.rpc("tyre_life", { p_farm: farmId }) : Promise.resolve({ data: [] }),
    supabase
      .from("machines")
      .select("id, name, meter_type")
      .is("deleted_at", null)
      .order("name"),
  ]);

  const rows = (lifeData as TyreLifeRow[] | null) ?? [];
  const machines = (machineData as MachineRow[] | null) ?? [];
  const { machines: byMachine, unfitted } = groupByMachine(rows);
  const totals = tyreTotals(rows);

  const savedKey =
    sp.saved === "added"
      ? "tyres.savedAdded"
      : sp.saved === "fitted"
        ? "tyres.savedFitted"
        : sp.saved === "removed"
          ? "tyres.savedRemoved"
          : sp.saved === "checked"
            ? "tyres.savedChecked"
            : null;

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);

  /** What to call a tyre in a dialog title, so the dialog names its own subject. */
  const tyreName = (r: TyreLifeRow) =>
    [[r.brand, r.pattern].filter(Boolean).join(" ") || t("tyres.title", locale), r.size]
      .filter(Boolean)
      .join(" · ");

  /** One tyre, wherever it is listed. */
  const tyreRow = (r: TyreLifeRow) => {
    const verdict = treadVerdict(r);
    const look = treadLook(verdict);
    const used = treadUsedPct(r);
    const rate = ratePhrase(r);
    const where = whereKey(r);
    let whereText = t(where.key, locale);
    for (const [k, v] of Object.entries(where.vars)) whereText = whereText.replace(`{${k}}`, v);
    const name = tyreName(r);

    return (
      <li key={r.tyre_id} className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-ink">
              {[r.brand, r.pattern].filter(Boolean).join(" ") || t("tyres.title", locale)}
              {r.size ? <span className="font-normal text-sand-600"> · {r.size}</span> : null}
            </p>
            <p className="mt-0.5 text-sm text-sand-600">
              {whereText}
              {r.axle ? ` · ${enumLabel("tyreAxle", r.axle, locale)}` : ""}
              {r.serial_no ? ` · ${r.serial_no}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusLook(r.status).tone}>{t(statusLook(r.status).labelKey, locale)}</Badge>
            <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>

            {/* Every action this tyre has, behind one button, titled with the tyre. */}
            {canManage ? (
              <ActionMenu title={name} label={t("common.actions", locale)} closeLabel={closeLabel}>
                <DialogForm
                  triggerLook="menuItem"
                  trigger={t("tyres.checkTitle", locale)}
                  title={t("tyres.checkTitle", locale)}
                  description={name}
                  closeLabel={closeLabel}
                  size="md"
                >
                  <form action={recordTyreCheck}>
                    <input type="hidden" name="tyre_id" value={r.tyre_id} />
                    <DialogFields>
                      <Field label={t("tyres.fieldTread", locale)} htmlFor={`tm-${r.tyre_id}`} required>
                        <Input id={`tm-${r.tyre_id}`} name="tread_mm" inputMode="decimal" required />
                      </Field>
                      <Field label={t("tyres.fieldReading", locale)} htmlFor={`rd-${r.tyre_id}`}>
                        <Input id={`rd-${r.tyre_id}`} name="reading" inputMode="decimal" />
                      </Field>
                      <Field label={t("tyres.fieldPressure", locale)} htmlFor={`pk-${r.tyre_id}`}>
                        <Input id={`pk-${r.tyre_id}`} name="pressure_kpa" inputMode="decimal" />
                      </Field>
                      <Field label={t("tyres.fieldPurchaseDate", locale)} htmlFor={`cd-${r.tyre_id}`}>
                        <Input id={`cd-${r.tyre_id}`} name="checked_on" type="date" />
                      </Field>
                    </DialogFields>
                    <DialogActions cancelLabel={cancelLabel}>
                      <SubmitButton variant="primary">{t("tyres.check", locale)}</SubmitButton>
                    </DialogActions>
                  </form>
                </DialogForm>

                {r.status === "fitted" ? (
                  <DialogForm
                    triggerLook="menuItem"
                    triggerTone="danger"
                    trigger={t("tyres.remove", locale)}
                    title={t("tyres.remove", locale)}
                    description={name}
                    closeLabel={closeLabel}
                    size="md"
                  >
                    <form action={removeTyre}>
                      <input type="hidden" name="tyre_id" value={r.tyre_id} />
                      <DialogFields>
                        <Field label={t("tyres.fieldReason", locale)} htmlFor={`rr-${r.tyre_id}`}>
                          <Input id={`rr-${r.tyre_id}`} name="removal_reason" maxLength={80} />
                        </Field>
                        <Field label={t("tyres.fieldFittedOn", locale)} htmlFor={`rd-off-${r.tyre_id}`}>
                          <Input id={`rd-off-${r.tyre_id}`} name="removed_on" type="date" />
                        </Field>
                        <Field label={t("tyres.fieldReading", locale)} htmlFor={`rr2-${r.tyre_id}`}>
                          <Input id={`rr2-${r.tyre_id}`} name="removed_reading" inputMode="decimal" />
                        </Field>
                        <label className="flex items-start gap-3 sm:col-span-2">
                          <input type="checkbox" name="scrap" className="mt-1 size-5" />
                          <span className="text-sm text-sand-800">{t("tyres.fieldScrap", locale)}</span>
                        </label>
                      </DialogFields>
                      <DialogActions cancelLabel={cancelLabel}>
                        <SubmitButton variant="primary">{t("tyres.remove", locale)}</SubmitButton>
                      </DialogActions>
                    </form>
                  </DialogForm>
                ) : r.status !== "scrapped" ? (
                  <DialogForm
                    triggerLook="menuItem"
                    trigger={t("tyres.fit", locale)}
                    title={t("tyres.fit", locale)}
                    description={name}
                    closeLabel={closeLabel}
                    size="md"
                  >
                    <form action={fitTyre}>
                      <input type="hidden" name="tyre_id" value={r.tyre_id} />
                      <DialogFields>
                        <Field label={t("tyres.fieldMachine", locale)} htmlFor={`fm-${r.tyre_id}`} required>
                          <Select id={`fm-${r.tyre_id}`} name="machine_id" required defaultValue="">
                            <option value="" disabled>
                              -
                            </option>
                            {machines.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("tyres.fieldAxle", locale)} htmlFor={`fa-${r.tyre_id}`}>
                          <Select id={`fa-${r.tyre_id}`} name="axle" defaultValue="drive">
                            {TYRE_AXLES.map((a) => (
                              <option key={a} value={a}>
                                {enumLabel("tyreAxle", a, locale)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field
                          label={t("tyres.fieldPosition", locale)}
                          htmlFor={`fp-${r.tyre_id}`}
                          hint={t("tyres.fieldPositionHint", locale)}
                        >
                          <Input id={`fp-${r.tyre_id}`} name="position_label" maxLength={12} />
                        </Field>
                        <Field label={t("tyres.fieldFittedOn", locale)} htmlFor={`fd-${r.tyre_id}`}>
                          <Input id={`fd-${r.tyre_id}`} name="fitted_on" type="date" />
                        </Field>
                        <Field
                          label={t("tyres.fieldReading", locale)}
                          htmlFor={`fr-${r.tyre_id}`}
                          hint={t("tyres.fieldReadingHint", locale)}
                        >
                          <Input id={`fr-${r.tyre_id}`} name="fitted_reading" inputMode="decimal" />
                        </Field>
                      </DialogFields>
                      <DialogActions cancelLabel={cancelLabel}>
                        <SubmitButton variant="primary">{t("tyres.fit", locale)}</SubmitButton>
                      </DialogActions>
                    </form>
                  </DialogForm>
                ) : null}
              </ActionMenu>
            ) : null}
          </div>
        </div>

        {/* Tread: the number, the baseline it is measured against, and a bar. A bar with
            no baseline would be a decoration, so it is only drawn when both are known. */}
        <p className="mt-2 text-sm text-sand-700">
          {r.latest_tread_mm != null ? (
            <>
              {r.new_tread_mm != null
                ? t("tyres.treadOf", locale)
                    .replace("{now}", String(r.latest_tread_mm))
                    .replace("{new}", String(r.new_tread_mm))
                : `${r.latest_tread_mm}mm`}
              {r.latest_checked_on ? (
                <span className="text-sand-500">
                  {" · "}
                  {t("tyres.checkedOn", locale).replace(
                    "{date}",
                    shortDate(r.latest_checked_on, locale),
                  )}
                </span>
              ) : null}
            </>
          ) : (
            t("tyres.neverChecked", locale)
          )}
        </p>
        {used != null ? (
          <div
            className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sand-200"
            role="img"
            aria-label={t("tyres.treadUsed", locale).replace("{pct}", String(used))}
          >
            <div
              className={`h-full rounded-full ${
                verdict === "replace"
                  ? "bg-status-overdue"
                  : verdict === "watch"
                    ? "bg-status-due"
                    : "bg-status-ok"
              }`}
              style={{ width: `${used}%` }}
            />
          </div>
        ) : null}

        {/* What it has cost, or why that cannot be said. */}
        <p className="mt-2 text-sm text-sand-700">
          {rate ? (
            <span className="font-medium">
              {t(rate.key, locale).replace("{amount}", rands(rate.cents))}
            </span>
          ) : r.meter_type == null && (r.units_run ?? 0) > 0 ? (
            <span className="text-sand-500">{t("tyres.mixedUnits", locale)}</span>
          ) : null}
          {r.units_run != null && r.units_run > 0 && r.meter_type ? (
            <span className="text-sand-500">
              {" · "}
              {t("tyres.ranFor", locale)
                .replace("{n}", String(Math.round(r.units_run)))
                .replace(
                  "{unit}",
                  t(r.meter_type === "km" ? "tyres.unitKm" : "tyres.unitHours", locale),
                )}
            </span>
          ) : null}
          {r.purchase_cost_cents != null ? (
            <span className="text-sand-500">{` · ${rands(r.purchase_cost_cents)}`}</span>
          ) : null}
        </p>
      </li>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
            {t("tyres.title", locale)}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <PageInfoButton infoKey="tyres" locale={locale} />
            {/* The one thing you come here to ADD, at the top, where a primary action
                belongs, instead of a nine-field panel below the list. */}
            {canManage ? (
              <DialogForm
                trigger={t("tyres.add", locale)}
                triggerIcon={<PlusIcon />}
                title={t("tyres.addTitle", locale)}
                closeLabel={closeLabel}
              >
                <form action={addTyre}>
                  <DialogFields>
                    <Field label={t("tyres.fieldBrand", locale)} htmlFor="ty-brand">
                      <Input id="ty-brand" name="brand" maxLength={40} />
                    </Field>
                    <Field label={t("tyres.fieldPattern", locale)} htmlFor="ty-pattern">
                      <Input id="ty-pattern" name="pattern" maxLength={40} />
                    </Field>
                    <Field label={t("tyres.fieldSize", locale)} htmlFor="ty-size">
                      <Input id="ty-size" name="size" maxLength={30} />
                    </Field>
                    <Field label={t("tyres.fieldSerial", locale)} htmlFor="ty-serial">
                      <Input id="ty-serial" name="serial_no" maxLength={40} />
                    </Field>
                    <Field label={t("tyres.fieldPurchaseDate", locale)} htmlFor="ty-date">
                      <Input id="ty-date" name="purchase_date" type="date" />
                    </Field>
                    <Field label={t("tyres.fieldCost", locale)} htmlFor="ty-cost">
                      <Input id="ty-cost" name="purchase_cost_cents" inputMode="decimal" />
                    </Field>
                    <Field label={t("tyres.fieldSupplier", locale)} htmlFor="ty-supplier">
                      <Input id="ty-supplier" name="supplier" maxLength={60} />
                    </Field>
                    <Field label={t("tyres.fieldNewTread", locale)} htmlFor="ty-tread">
                      <Input id="ty-tread" name="new_tread_mm" inputMode="decimal" />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label={t("tyres.fieldNotes", locale)} htmlFor="ty-notes">
                        <Input id="ty-notes" name="notes" maxLength={200} />
                      </Field>
                    </div>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel} note={t("tyres.moneyNote", locale)}>
                    <SubmitButton variant="primary">{t("tyres.add", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-sm text-sand-600">{t("tyres.lead", locale)}</p>
      </div>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={savedKey ? t(savedKey, locale) : undefined} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("tyres.statFitted", locale)} value={String(totals.fitted)} />
        <Stat
          label={t("tyres.statReplace", locale)}
          value={String(totals.replace)}
          tone={totals.replace > 0 ? "overdue" : "default"}
        />
        <Stat
          label={t("tyres.statUnchecked", locale)}
          value={String(totals.unchecked)}
          tone={totals.unchecked > 0 ? "due" : "default"}
        />
        <Stat label={t("tyres.statSpend", locale)} value={rands(totals.spendCents)} />
      </div>

      {rows.length === 0 ? (
        <GetStarted title={t("tyres.emptyTitle", locale)} hint={t("tyres.emptyBody", locale)} />
      ) : (
        <>
          {byMachine.map((m) => (
            <Card key={m.id} flush>
              <div className="p-4 pb-0 sm:p-5 sm:pb-0">
                <CardTitle>
                  <Link href={`/machines/${m.id}`} className="focus-ring rounded hover:underline">
                    {m.name}
                  </Link>
                </CardTitle>
              </div>
              <ul className="divide-y divide-sand-200">{m.tyres.map(tyreRow)}</ul>
            </Card>
          ))}

          {unfitted.length > 0 ? (
            <Card flush>
              <div className="p-4 pb-0 sm:p-5 sm:pb-0">
                <CardTitle>{t("tyres.storeTitle", locale)}</CardTitle>
              </div>
              <ul className="divide-y divide-sand-200">{unfitted.map(tyreRow)}</ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
