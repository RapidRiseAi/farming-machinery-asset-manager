"use client";

import { useState } from "react";
import { MACHINE_TYPES, METER_TYPES, defaultMeterFor } from "@/lib/machine-options";
import { meterUnit } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DialogFields, DialogSection } from "@/components/ui/dialog-form";

/** The machine values the form can start from. Only these cross to the client. */
export type MachineFieldDefaults = {
  name?: string | null;
  type?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  serial_no?: string | null;
  reg_no?: string | null;
  meter_type?: string | null;
  current_reading?: number | null;
  purchase_date?: string | null;
  purchase_price_cents?: number | null;
  supplier?: string | null;
  warranty_expiry_date?: string | null;
  warranty_expiry_hours?: number | null;
  assigned_operator_id?: string | null;
  location?: string | null;
  cost_centre?: string | null;
  department?: string | null;
  notes?: string | null;
  finance_provider?: string | null;
  finance_total_cents?: number | null;
  finance_monthly_cents?: number | null;
  finance_term_months?: number | null;
  finance_interest_bps?: number | null;
};

export type MachineFieldOperator = { id: string; name: string };

const has = (...values: unknown[]) => values.some((v) => v != null && v !== "");
const randsInput = (cents: number | null | undefined) => (cents != null ? (cents / 100).toFixed(2) : "");

/**
 * The machine form's fields, for the add page and the Edit dialog.
 *
 * == A short first step ======================================================
 * Name, type and meter are all a machine needs to start being useful (a service plan
 * runs off the meter). Everything else sits in a named, collapsed `DialogSection`, so
 * the add page is four fields and a photo instead of twenty-five, and nothing is
 * removed: the sections are native `<details>`, their fields stay mounted and submit
 * whether or not they are open. When EDITING, a section that already holds a value
 * opens by itself, so an update never hides what the person came to change.
 *
 * == The type drives the meter, on create only ===============================
 * A bakkie starts on km, an implement on no meter, the rest on hours, until the person
 * picks a meter themselves; then the form leaves it alone. Editing never re-defaults:
 * changing a machine's type must not quietly change how its history is read.
 */
export function MachineFieldsForm({
  machine,
  operators,
  locale,
  costCentres = [],
  departments = [],
  locations = [],
}: {
  machine?: MachineFieldDefaults;
  operators?: MachineFieldOperator[];
  locale: Lang;
  costCentres?: string[];
  departments?: string[];
  locations?: string[];
}) {
  const isNew = !machine;
  const m = machine ?? {};
  const [type, setType] = useState<string>(m.type ?? "tractor");
  const [meter, setMeter] = useState<string>(m.meter_type ?? defaultMeterFor(m.type ?? "tractor"));
  const [meterChosen, setMeterChosen] = useState(!isNew);

  const onType = (next: string) => {
    setType(next);
    if (!meterChosen) setMeter(defaultMeterFor(next));
  };

  const unit = meterUnit(meter, locale);
  const withUnit = (label: string) => (unit ? `${label} (${unit})` : label);
  // A calendar-only machine has no reading and no warranty by meter. An existing value
  // stays visible, so saving the Edit dialog can never blank it out unseen.
  const showMeterWarranty = meter !== "none" || m.warranty_expiry_hours != null;
  const warrantyMeterLabel = meter === "km" ? t("machines.warrantyKm", locale) : t("machines.warrantyHours", locale);
  const interestPct = m.finance_interest_bps != null ? String(m.finance_interest_bps / 100) : "";

  return (
    <div className="flex flex-col gap-4">
      <DialogFields>
        <div className="sm:col-span-2">
          <Field label={t("machines.name", locale)} htmlFor="name" required>
            <Input id="name" name="name" required maxLength={120} autoComplete="off" defaultValue={m.name ?? ""} />
          </Field>
        </div>
        <Field label={t("machines.type", locale)} htmlFor="type">
          <Select id="type" name="type" value={type} onChange={(e) => onType(e.target.value)}>
            {MACHINE_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`machineType.${ty}`, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("machines.meterType", locale)} htmlFor="meter_type">
          <Select
            id="meter_type"
            name="meter_type"
            value={meter}
            onChange={(e) => {
              setMeter(e.target.value);
              setMeterChosen(true);
            }}
          >
            {METER_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {t(`meterType.${mt}`, locale)}
              </option>
            ))}
          </Select>
        </Field>
        {/* The reading is only asked for when the machine is added: after that it moves
            through Log reading, and the Edit dialog's old box saved nothing at all. */}
        {isNew && meter !== "none" ? (
          <Field label={withUnit(t("machines.currentReading", locale))} htmlFor="current_reading">
            <Input
              id="current_reading"
              name="current_reading"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              defaultValue={m.current_reading ?? ""}
            />
          </Field>
        ) : null}

        <DialogSection
          title={t("machines.sections.details", locale)}
          defaultOpen={!isNew && has(m.make, m.model, m.year, m.reg_no, m.serial_no)}
        >
          <Field label={t("machines.make", locale)} htmlFor="make">
            <Input id="make" name="make" defaultValue={m.make ?? ""} />
          </Field>
          <Field label={t("machines.model", locale)} htmlFor="model">
            <Input id="model" name="model" defaultValue={m.model ?? ""} />
          </Field>
          <Field label={t("machines.year", locale)} htmlFor="year">
            <Input id="year" name="year" type="number" inputMode="numeric" min={1900} max={2100} defaultValue={m.year ?? ""} />
          </Field>
          {/* Every type keeps Reg no: a trailer filed as an implement carries a licence disc. */}
          <Field label={t("machines.regNo", locale)} htmlFor="reg_no">
            <Input id="reg_no" name="reg_no" autoCapitalize="characters" defaultValue={m.reg_no ?? ""} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("machines.serialNo", locale)} htmlFor="serial_no">
              <Input id="serial_no" name="serial_no" autoCapitalize="characters" defaultValue={m.serial_no ?? ""} />
            </Field>
          </div>
        </DialogSection>

        <DialogSection
          title={t("machines.sections.placement", locale)}
          defaultOpen={!isNew && has(m.location, m.cost_centre, m.department, m.assigned_operator_id)}
        >
          <Field label={t("machines.location", locale)} htmlFor="location">
            <Input id="location" name="location" list="machine-locations" defaultValue={m.location ?? ""} />
          </Field>
          {operators ? (
            <Field label={t("machines.assignedOperator", locale)} htmlFor="assigned_operator_id">
              <Select id="assigned_operator_id" name="assigned_operator_id" defaultValue={m.assigned_operator_id ?? ""}>
                <option value="">{t("machines.noOperator", locale)}</option>
                {operators.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {/* Suggest the values already in use: "CC-100" and "cc 100" used to become two
              separate filters on the list. A native datalist, not a custom dropdown. */}
          <Field label={t("machines.costCentre", locale)} htmlFor="cost_centre">
            <Input id="cost_centre" name="cost_centre" list="machine-cost-centres" defaultValue={m.cost_centre ?? ""} />
          </Field>
          <Field label={t("machines.department", locale)} htmlFor="department">
            <Input id="department" name="department" list="machine-departments" defaultValue={m.department ?? ""} />
          </Field>
        </DialogSection>

        <DialogSection
          title={t("machines.sections.purchase", locale)}
          defaultOpen={
            !isNew &&
            has(m.purchase_date, m.purchase_price_cents, m.supplier, m.warranty_expiry_date, m.warranty_expiry_hours)
          }
        >
          <Field label={t("machines.purchaseDate", locale)} htmlFor="purchase_date">
            <Input id="purchase_date" name="purchase_date" type="date" defaultValue={m.purchase_date ?? ""} />
          </Field>
          <Field label={t("machines.purchasePrice", locale)} htmlFor="purchase_price">
            <Input id="purchase_price" name="purchase_price" type="number" inputMode="decimal" step="0.01" min={0} defaultValue={randsInput(m.purchase_price_cents)} />
          </Field>
          <Field label={t("machines.supplier", locale)} htmlFor="supplier">
            <Input id="supplier" name="supplier" defaultValue={m.supplier ?? ""} />
          </Field>
          <Field label={t("machines.warrantyDate", locale)} htmlFor="warranty_expiry_date">
            <Input id="warranty_expiry_date" name="warranty_expiry_date" type="date" defaultValue={m.warranty_expiry_date ?? ""} />
          </Field>
          {showMeterWarranty ? (
            <Field label={warrantyMeterLabel} htmlFor="warranty_expiry_hours">
              <Input id="warranty_expiry_hours" name="warranty_expiry_hours" type="number" inputMode="decimal" step="0.1" min={0} defaultValue={m.warranty_expiry_hours ?? ""} />
            </Field>
          ) : null}
        </DialogSection>

        <DialogSection
          title={t("machines.sections.finance", locale)}
          defaultOpen={
            !isNew &&
            has(m.finance_provider, m.finance_total_cents, m.finance_monthly_cents, m.finance_term_months, m.finance_interest_bps)
          }
        >
          <div className="sm:col-span-2">
            <Field label={t("machines.financeProvider", locale)} htmlFor="finance_provider">
              <Input id="finance_provider" name="finance_provider" defaultValue={m.finance_provider ?? ""} />
            </Field>
          </div>
          <Field label={t("machines.financeTotal", locale)} htmlFor="finance_total">
            <Input id="finance_total" name="finance_total" type="number" inputMode="decimal" step="0.01" min={0} defaultValue={randsInput(m.finance_total_cents)} />
          </Field>
          <Field label={t("machines.financeMonthly", locale)} htmlFor="finance_monthly">
            <Input id="finance_monthly" name="finance_monthly" type="number" inputMode="decimal" step="0.01" min={0} defaultValue={randsInput(m.finance_monthly_cents)} />
          </Field>
          <Field label={t("machines.financeTerm", locale)} htmlFor="finance_term_months">
            <Input id="finance_term_months" name="finance_term_months" type="number" inputMode="numeric" min={0} defaultValue={m.finance_term_months ?? ""} />
          </Field>
          {/* Asked in percent, as the bank quotes it. The field keeps its posted name and
              the action stores basis points, so the column and the read view are unchanged. */}
          <Field label={t("machines.financeInterestPct", locale)} htmlFor="finance_interest_bps">
            <Input id="finance_interest_bps" name="finance_interest_bps" type="number" inputMode="decimal" step="0.01" min={0} max={100} defaultValue={interestPct} />
          </Field>
        </DialogSection>

        <DialogSection title={t("machines.sections.notes", locale)} defaultOpen={!isNew && has(m.notes)}>
          <div className="sm:col-span-2">
            <Field label={t("machines.notes", locale)} htmlFor="notes">
              <Textarea id="notes" name="notes" rows={3} defaultValue={m.notes ?? ""} />
            </Field>
          </div>
        </DialogSection>
      </DialogFields>

      <datalist id="machine-locations">
        {locations.map((v) => <option key={v} value={v} />)}
      </datalist>
      <datalist id="machine-cost-centres">
        {costCentres.map((v) => <option key={v} value={v} />)}
      </datalist>
      <datalist id="machine-departments">
        {departments.map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  );
}
