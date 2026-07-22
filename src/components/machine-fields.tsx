import { MACHINE_TYPES, METER_TYPES } from "@/lib/machine-options";
import { t, type Locale } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Defaults = {
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
  location?: string | null;
  notes?: string | null;
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wider text-sand-400">{children}</h3>;
}

/** Shared machine input fields for the create + edit forms, on the UI kit. */
export function MachineFields({ machine, locale = "en" }: { machine?: Defaults; locale?: Locale }) {
  const m = machine ?? {};
  const price =
    m.purchase_price_cents != null ? (m.purchase_price_cents / 100).toFixed(2) : "";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SectionTitle>{t("machines.sections.identity", locale)}</SectionTitle>
        <Field label={t("machines.name", locale)} htmlFor="name" required>
          <Input id="name" name="name" required defaultValue={m.name ?? ""} />
        </Field>
        <Field label={t("machines.type", locale)} htmlFor="type">
          <Select id="type" name="type" defaultValue={m.type ?? "tractor"}>
            {MACHINE_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`machineType.${ty}`, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t("machines.make", locale)} htmlFor="make">
            <Input id="make" name="make" defaultValue={m.make ?? ""} />
          </Field>
          <Field label={t("machines.model", locale)} htmlFor="model">
            <Input id="model" name="model" defaultValue={m.model ?? ""} />
          </Field>
          <Field label={t("machines.year", locale)} htmlFor="year">
            <Input id="year" name="year" type="number" inputMode="numeric" defaultValue={m.year ?? ""} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("machines.serialNo", locale)} htmlFor="serial_no">
            <Input id="serial_no" name="serial_no" defaultValue={m.serial_no ?? ""} />
          </Field>
          <Field label={t("machines.regNo", locale)} htmlFor="reg_no">
            <Input id="reg_no" name="reg_no" defaultValue={m.reg_no ?? ""} />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>{t("machines.sections.meter", locale)}</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("machines.meterType", locale)} htmlFor="meter_type">
            <Select id="meter_type" name="meter_type" defaultValue={m.meter_type ?? "hours"}>
              {METER_TYPES.map((mt) => (
                <option key={mt} value={mt}>
                  {t(`meterType.${mt}`, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("machines.currentReading", locale)} htmlFor="current_reading">
            <Input
              id="current_reading"
              name="current_reading"
              type="number"
              inputMode="decimal"
              step="0.1"
              defaultValue={m.current_reading ?? ""}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>{t("machines.sections.purchase", locale)}</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("machines.purchaseDate", locale)} htmlFor="purchase_date">
            <Input id="purchase_date" name="purchase_date" type="date" defaultValue={m.purchase_date ?? ""} />
          </Field>
          <Field label={t("machines.purchasePrice", locale)} htmlFor="purchase_price">
            <Input id="purchase_price" name="purchase_price" type="number" inputMode="decimal" step="0.01" defaultValue={price} />
          </Field>
          <Field label={t("machines.supplier", locale)} htmlFor="supplier">
            <Input id="supplier" name="supplier" defaultValue={m.supplier ?? ""} />
          </Field>
          <Field label={t("machines.location", locale)} htmlFor="location">
            <Input id="location" name="location" defaultValue={m.location ?? ""} />
          </Field>
          <Field label={t("machines.warrantyDate", locale)} htmlFor="warranty_expiry_date">
            <Input id="warranty_expiry_date" name="warranty_expiry_date" type="date" defaultValue={m.warranty_expiry_date ?? ""} />
          </Field>
          <Field label={t("machines.warrantyHours", locale)} htmlFor="warranty_expiry_hours">
            <Input id="warranty_expiry_hours" name="warranty_expiry_hours" type="number" inputMode="decimal" step="0.1" defaultValue={m.warranty_expiry_hours ?? ""} />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>{t("machines.sections.notes", locale)}</SectionTitle>
        <Field label={t("machines.notes", locale)} htmlFor="notes">
          <Textarea id="notes" name="notes" rows={3} defaultValue={m.notes ?? ""} />
        </Field>
      </div>
    </div>
  );
}
