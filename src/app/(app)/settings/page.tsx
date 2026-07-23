import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { updateSettings } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";

type Settings = Record<string, unknown>;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "owner" && profile.role !== "manager") redirect("/dashboard");
  const locale = profile.language;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.from("farms").select("name, settings").eq("id", profile.farm_id ?? "").maybeSingle();
  const farm = data as { name: string; settings: Settings } | null;
  const s = (farm?.settings ?? {}) as Record<string, unknown>;
  const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
  const b = (k: string) => s[k] === true;

  const check = "h-5 w-5 rounded border-sand-300 text-brand-600";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("settings.title", locale)} — {farm?.name}</h1>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      <form action={updateSettings} className="flex flex-col gap-4">
        <Card>
          <CardHeader><CardTitle>{t("settings.thresholds", locale)}</CardTitle></CardHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("settings.dueHours", locale)} htmlFor="due_soon_hours">
              <Input id="due_soon_hours" name="due_soon_hours" type="number" defaultValue={n("due_soon_hours", 25)} />
            </Field>
            <Field label={t("settings.dueDays", locale)} htmlFor="due_soon_days">
              <Input id="due_soon_days" name="due_soon_days" type="number" defaultValue={n("due_soon_days", 14)} />
            </Field>
            <Field label={t("settings.staleDays", locale)} htmlFor="stale_reading_days">
              <Input id="stale_reading_days" name="stale_reading_days" type="number" defaultValue={n("stale_reading_days", 30)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.money", locale)}</CardTitle></CardHeader>
          <Field label={t("settings.vatRate", locale)} htmlFor="vat_rate_bps">
            <Input id="vat_rate_bps" name="vat_rate_bps" type="number" defaultValue={n("vat_rate_bps", 1500)} />
          </Field>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.workflow", locale)}</CardTitle></CardHeader>
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2.5 text-sm text-sand-800">
              <input type="checkbox" name="approval_required" defaultChecked={b("approval_required")} className={check} />
              {t("settings.approvalRequired", locale)}
            </label>
            <label className="flex items-center gap-2.5 text-sm text-sand-800">
              <input type="checkbox" name="cost_visible_to_operators" defaultChecked={b("cost_visible_to_operators")} className={check} />
              {t("settings.costVisible", locale)}
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.quietHours", locale)}</CardTitle></CardHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("settings.quietStart", locale)} htmlFor="quiet_hours_start">
              <Input id="quiet_hours_start" name="quiet_hours_start" type="number" min={0} max={23} defaultValue={n("quiet_hours_start", 20)} />
            </Field>
            <Field label={t("settings.quietEnd", locale)} htmlFor="quiet_hours_end">
              <Input id="quiet_hours_end" name="quiet_hours_end" type="number" min={0} max={23} defaultValue={n("quiet_hours_end", 5)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.expirySection", locale)}</CardTitle></CardHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("settings.warrantyLeadDays", locale)} htmlFor="warranty_lead_days">
              <Input id="warranty_lead_days" name="warranty_lead_days" type="number" min={0} defaultValue={n("warranty_lead_days", 30)} />
            </Field>
            <Field label={t("settings.warrantyHoursLead", locale)} htmlFor="warranty_hours_lead">
              <Input id="warranty_hours_lead" name="warranty_hours_lead" type="number" min={0} defaultValue={n("warranty_hours_lead", 50)} />
            </Field>
            <Field label={t("settings.licenceLeadDays", locale)} htmlFor="licence_lead_days">
              <Input id="licence_lead_days" name="licence_lead_days" type="number" min={0} defaultValue={n("licence_lead_days", 30)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.fuelSection", locale)}</CardTitle></CardHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("settings.fuelAnomalyPct", locale)} htmlFor="fuel_anomaly_pct">
              <Input id="fuel_anomaly_pct" name="fuel_anomaly_pct" type="number" min={1} defaultValue={n("fuel_anomaly_pct", 50)} />
            </Field>
            <Field label={t("settings.fuelMinHistory", locale)} htmlFor="fuel_anomaly_min_history">
              <Input id="fuel_anomaly_min_history" name="fuel_anomaly_min_history" type="number" min={1} defaultValue={n("fuel_anomaly_min_history", 3)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.language", locale)}</CardTitle></CardHeader>
          <Field label={t("settings.language", locale)} htmlFor="default_language">
            <Select id="default_language" name="default_language" defaultValue={(s.default_language as string) ?? "af"}>
              <option value="af">{t("settings.afrikaans", locale)}</option>
              <option value="en">{t("settings.english", locale)}</option>
            </Select>
          </Field>
        </Card>

        <SubmitButton variant="primary" className="self-start">{t("settings.save", locale)}</SubmitButton>
      </form>
    </div>
  );
}
