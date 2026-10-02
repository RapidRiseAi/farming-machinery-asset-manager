import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { errorMessage } from "@/lib/errors";
import { requireProfile, homePathFor, currentPlan } from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { countLabel, hourOfDay, num, quietHoursRange, vatPercent } from "@/lib/format";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { updateSettings } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Fact, FactList } from "@/components/ui/facts";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { VatRateField } from "@/components/vat-rate-field";
import { OWNED_FIELD } from "@/lib/settings";

type Settings = Record<string, unknown>;

/**
 * How this farm is configured.
 *
 * == It states its settings, it is not a form ==================================
 * This screen used to be one `<form>` holding twenty-two input boxes across nine cards,
 * with a jump-to nav across the top and a sticky Save that followed you down. All three
 * of those were treatments for the same problem, which is that the page was too big to
 * take in: you could not answer "what is our VAT rate?" without reading the contents of
 * a text field, and the page looked like work outstanding rather than a record of
 * decisions already taken.
 *
 * So each group now STATES its values and carries one `Edit` button that opens just
 * that group's fields. The jump nav and the sticky Save are gone because there is
 * nothing long left to navigate or to save.
 *
 * == What that required of the action =========================================
 * `updateSettings` rebuilt the whole settings blob from the submitted form, falling
 * back to defaults for anything absent, so a three-field dialog would have reset the
 * other fifteen settings. Each dialog therefore declares the keys it owns in
 * `__fields`, and the action merges over what is stored. See `src/lib/settings.ts`.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "owner" && profile.role !== "manager") redirect(`${homePathFor(profile.role)}?denied=1`);
  const locale = profile.lang;
  const sp = await searchParams;
  // The same gate the shell's "API access" nav item uses, so the link below appears
  // exactly when the nav row does.
  const { plan } = await currentPlan(profile);
  const apiAllowed = plan != null && planAllows(plan, "api_access");

  const supabase = await createClient();
  const { data } = await supabase
    .from("farms")
    .select("name, settings, trading_name, reg_number, vat_number, billing_address, billing_email")
    .eq("id", profile.farm_id ?? "")
    .maybeSingle();
  const farm = data as {
    name: string; settings: Settings;
    trading_name: string | null; reg_number: string | null; vat_number: string | null;
    billing_address: string | null; billing_email: string | null;
  } | null;
  const s = (farm?.settings ?? {}) as Record<string, unknown>;
  const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
  const b = (k: string) => s[k] === true;

  // Units live in the VALUE ("25 hours"), not in the label ("... (hours) 25").
  const hoursOf = (v: number) => countLabel(v, "settings.nHoursOne", "settings.nHours", locale);
  const daysOf = (v: number) => countLabel(v, "settings.nDaysOne", "settings.nDays", locale);
  const inHours = t("settings.inHours", locale);
  const inDays = t("settings.inDays", locale);
  const inPercent = t("settings.inPercent", locale);
  const hourOptions = Array.from({ length: 24 }, (_, h) => (
    <option key={h} value={String(h)}>
      {hourOfDay(h, locale)}
    </option>
  ));
  const heading = (id: string, key: string) => (
    <h2 id={id} className="pt-2 text-lg font-semibold tracking-tight text-ink">
      {t(key, locale)}
    </h2>
  );
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const notSet = t("settings.notSet", locale);
  const yesNo = (on: boolean) => t(on ? "common.yes" : "common.no", locale);

  /**
   * One settings group: its values, and an Edit button that opens only its fields.
   *
   * `owns` becomes the `__fields` marker, which is what keeps this dialog from
   * resetting the eight other groups when it saves.
   */
  const group = ({
    title,
    owns,
    facts,
    fields,
    hint,
  }: {
    title: string;
    owns: string[];
    facts: ReactNode;
    fields: ReactNode;
    hint?: string;
  }) => (
    <Card>
      <CardHeader
        action={
          <DialogForm
            trigger={t("common.edit", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={title}
            description={hint}
            closeLabel={closeLabel}
            size="md"
          >
            <form action={updateSettings}>
              <input type="hidden" name={OWNED_FIELD} value={owns.join(" ")} />
              <DialogFields columns={1}>{fields}</DialogFields>
              <DialogActions cancelLabel={cancelLabel}>
                <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        }
      >
        <CardTitle as="h3">{title}</CardTitle>
      </CardHeader>
      <FactList>{facts}</FactList>
    </Card>
  );

  return (
    <PageContainer size="narrow">
      {/* The farm's name is the quiet line, not part of the h1: "Settings, Weltevrede
          Boerdery" wrapped on a phone, and the farm switcher already names it there. */}
      <PageHeader title={t("settings.title", locale)} meta={farm?.name || undefined} infoKey="settings" locale={locale} />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />

      {/* Personal settings (language, wording, alerts) belong to the person, not the
          farm. They live in Your account and preferences, which every role can open. */}
      <p className="text-sm text-sand-600">
        {t("settings.personalLink", locale)}{" "}
        <Link href="/account" className="focus-ring rounded font-medium text-brand-ink underline underline-offset-2">
          {t("settings.personalLinkCta", locale)}
        </Link>
      </p>
      {/* /settings/api names Settings in its back link; this is the way there from here,
          not only from the nav. */}
      {apiAllowed ? (
        <p className="text-sm text-sand-600">
          {t("settings.apiLink", locale)}{" "}
          <Link href="/settings/api" className="focus-ring rounded font-medium text-brand-ink underline underline-offset-2">
            {t("nav.apiTokens", locale)}
          </Link>
        </p>
      ) : null}

      {/* == Money and invoices ================================================ */}
      <section aria-labelledby="settings-money" className="flex flex-col gap-4">
        {heading("settings-money", "settings.sectionMoney")}

        {/* Without these, an invoice a contractor raises against this farm is not a
            full tax invoice over R5 000 (VAT Act s20(4)) and the farm cannot claim the
            input VAT back. They go on the document, not in a settings blob, which is
            also why this group's `__fields` is what permits the billing RPC to run. */}
        {group({
          title: t("settings.billingSection", locale),
          hint: t("settings.billingHint", locale),
          owns: ["trading_name", "reg_number", "vat_number", "billing_address", "billing_email"],
          facts: (
            <>
              <Fact
                label={t("settings.tradingName", locale)}
                value={farm?.trading_name || notSet}
                muted={!farm?.trading_name}
              />
              <Fact label={t("settings.regNo", locale)} value={farm?.reg_number || notSet} muted={!farm?.reg_number} />
              <Fact label={t("settings.vatNo", locale)} value={farm?.vat_number || notSet} muted={!farm?.vat_number} />
              <Fact
                label={t("settings.billingEmail", locale)}
                value={<span className="break-all">{farm?.billing_email || notSet}</span>}
                muted={!farm?.billing_email}
              />
              <Fact
                label={t("settings.billingAddress", locale)}
                value={<span className="whitespace-pre-line">{farm?.billing_address || notSet}</span>}
                muted={!farm?.billing_address}
              />
            </>
          ),
          fields: (
            <>
              <Field label={t("settings.tradingName", locale)} htmlFor="trading_name">
                <Input id="trading_name" name="trading_name" defaultValue={farm?.trading_name ?? ""} />
              </Field>
              <Field label={t("settings.regNo", locale)} htmlFor="reg_number">
                <Input id="reg_number" name="reg_number" defaultValue={farm?.reg_number ?? ""} />
              </Field>
              <Field label={t("settings.vatNo", locale)} hint={t("settings.vatNoHint", locale)} htmlFor="vat_number">
                <Input id="vat_number" name="vat_number" defaultValue={farm?.vat_number ?? ""} />
              </Field>
              <Field
                label={t("settings.billingEmail", locale)}
                hint={t("settings.billingEmailHint", locale)}
                htmlFor="billing_email"
              >
                <Input id="billing_email" name="billing_email" type="email" defaultValue={farm?.billing_email ?? ""} />
              </Field>
              <Field
                label={t("settings.billingAddress", locale)}
                hint={t("settings.billingAddressHint", locale)}
                htmlFor="billing_address"
              >
                <Textarea id="billing_address" name="billing_address" rows={2} defaultValue={farm?.billing_address ?? ""} />
              </Field>
            </>
          ),
        })}

        {group({
          title: t("settings.money", locale),
          owns: ["vat_rate_bps"],
          facts: <Fact label={t("settings.vatRateShort", locale)} value={vatPercent(n("vat_rate_bps", 1500))} />,
          fields: <VatRateField defaultBps={n("vat_rate_bps", 1500)} locale={locale} />,
        })}
      </section>

      {/* == Reminders and alerts ============================================== */}
      <section aria-labelledby="settings-alerts" className="flex flex-col gap-4">
        {heading("settings-alerts", "settings.sectionAlerts")}

        {group({
          title: t("settings.thresholds", locale),
          owns: ["due_soon_hours", "due_soon_days", "stale_reading_days"],
          facts: (
            <>
              <Fact label={t("settings.dueHours", locale)} value={hoursOf(n("due_soon_hours", 25))} />
              <Fact label={t("settings.dueDays", locale)} value={daysOf(n("due_soon_days", 14))} />
              <Fact label={t("settings.staleDays", locale)} value={daysOf(n("stale_reading_days", 30))} />
            </>
          ),
          fields: (
            <>
              <Field label={t("settings.dueHours", locale)} hint={inHours} htmlFor="due_soon_hours">
                <Input id="due_soon_hours" name="due_soon_hours" type="number" inputMode="numeric" min={0} defaultValue={n("due_soon_hours", 25)} />
              </Field>
              <Field label={t("settings.dueDays", locale)} hint={inDays} htmlFor="due_soon_days">
                <Input id="due_soon_days" name="due_soon_days" type="number" inputMode="numeric" min={0} defaultValue={n("due_soon_days", 14)} />
              </Field>
              <Field label={t("settings.staleDays", locale)} hint={inDays} htmlFor="stale_reading_days">
                <Input id="stale_reading_days" name="stale_reading_days" type="number" inputMode="numeric" min={0} defaultValue={n("stale_reading_days", 30)} />
              </Field>
            </>
          ),
        })}

        {group({
          title: t("settings.expirySection", locale),
          owns: ["warranty_lead_days", "warranty_hours_lead", "licence_lead_days", "aarto_nomination_lead_days"],
          facts: (
            <>
              <Fact label={t("settings.warrantyLeadDays", locale)} value={daysOf(n("warranty_lead_days", 30))} />
              <Fact label={t("settings.warrantyHoursLead", locale)} value={hoursOf(n("warranty_hours_lead", 50))} />
              <Fact label={t("settings.licenceLeadDays", locale)} value={daysOf(n("licence_lead_days", 30))} />
              <Fact label={t("settings.aartoLeadDays", locale)} value={daysOf(n("aarto_nomination_lead_days", 14))} />
            </>
          ),
          fields: (
            <>
              <Field label={t("settings.warrantyLeadDays", locale)} hint={inDays} htmlFor="warranty_lead_days">
                <Input id="warranty_lead_days" name="warranty_lead_days" type="number" inputMode="numeric" min={0} defaultValue={n("warranty_lead_days", 30)} />
              </Field>
              <Field label={t("settings.warrantyHoursLead", locale)} hint={inHours} htmlFor="warranty_hours_lead">
                <Input id="warranty_hours_lead" name="warranty_hours_lead" type="number" inputMode="numeric" min={0} defaultValue={n("warranty_hours_lead", 50)} />
              </Field>
              <Field label={t("settings.licenceLeadDays", locale)} hint={inDays} htmlFor="licence_lead_days">
                <Input id="licence_lead_days" name="licence_lead_days" type="number" inputMode="numeric" min={0} defaultValue={n("licence_lead_days", 30)} />
              </Field>
              <Field label={t("settings.aartoLeadDays", locale)} hint={inDays} htmlFor="aarto_nomination_lead_days">
                <Input id="aarto_nomination_lead_days" name="aarto_nomination_lead_days" type="number" inputMode="numeric" min={0} defaultValue={n("aarto_nomination_lead_days", 14)} />
              </Field>
            </>
          ),
        })}

        {group({
          title: t("settings.fuelSection", locale),
          owns: ["fuel_anomaly_pct", "fuel_anomaly_min_history"],
          facts: (
            <>
              <Fact label={t("settings.fuelAnomalyPct", locale)} value={`${num(n("fuel_anomaly_pct", 50))}%`} />
              <Fact
                label={t("settings.fuelMinHistory", locale)}
                value={countLabel(n("fuel_anomaly_min_history", 3), "settings.nDrawsOne", "settings.nDraws", locale)}
              />
            </>
          ),
          fields: (
            <>
              <Field label={t("settings.fuelAnomalyPct", locale)} hint={inPercent} htmlFor="fuel_anomaly_pct">
                <Input id="fuel_anomaly_pct" name="fuel_anomaly_pct" type="number" inputMode="numeric" min={1} defaultValue={n("fuel_anomaly_pct", 50)} />
              </Field>
              <Field label={t("settings.fuelMinHistory", locale)} htmlFor="fuel_anomaly_min_history">
                <Input id="fuel_anomaly_min_history" name="fuel_anomaly_min_history" type="number" inputMode="numeric" min={1} defaultValue={n("fuel_anomaly_min_history", 3)} />
              </Field>
            </>
          ),
        })}

        {group({
          title: t("settings.quietHours", locale),
          hint: t("settings.quietHint", locale),
          owns: ["quiet_hours_start", "quiet_hours_end"],
          facts: (
            <Fact
              label={t("settings.quietWindow", locale)}
              value={quietHoursRange(n("quiet_hours_start", 20), n("quiet_hours_end", 5), locale)}
              hint={t("account.quietUrgent", locale)}
            />
          ),
          fields: (
            <>
              <Field label={t("settings.quietStart", locale)} htmlFor="quiet_hours_start">
                <Select id="quiet_hours_start" name="quiet_hours_start" defaultValue={String(n("quiet_hours_start", 20))}>
                  {hourOptions}
                </Select>
              </Field>
              <Field label={t("settings.quietEnd", locale)} htmlFor="quiet_hours_end">
                <Select id="quiet_hours_end" name="quiet_hours_end" defaultValue={String(n("quiet_hours_end", 5))}>
                  {hourOptions}
                </Select>
              </Field>
            </>
          ),
        })}
      </section>

      {/* == Workflow and reports ============================================== */}
      <section aria-labelledby="settings-workflow" className="flex flex-col gap-4">
        {heading("settings-workflow", "settings.sectionWorkflow")}

        {group({
          title: t("settings.workflow", locale),
          owns: ["approval_required", "cost_visible_to_operators"],
          facts: (
            <>
              <Fact label={t("settings.approvalRequired", locale)} value={yesNo(b("approval_required"))} />
              <Fact label={t("settings.costVisible", locale)} value={yesNo(b("cost_visible_to_operators"))} />
            </>
          ),
          fields: (
            <div className="flex flex-col">
              <Checkbox
                name="approval_required"
                defaultChecked={b("approval_required")}
                label={t("settings.approvalRequired", locale)}
              />
              <Checkbox
                name="cost_visible_to_operators"
                defaultChecked={b("cost_visible_to_operators")}
                label={t("settings.costVisible", locale)}
              />
            </div>
          ),
        })}

        {group({
          title: t("settings.analyticsSection", locale),
          owns: ["repair_replace_pct", "utilisation_hours_per_day", "utilisation_km_per_day"],
          facts: (
            <>
              <Fact
                label={t("settings.repairReplacePct", locale)}
                value={t("settings.pctOfPrice", locale).replace("{n}", num(n("repair_replace_pct", 60)))}
              />
              <Fact label={t("settings.utilHoursPerDay", locale)} value={hoursOf(n("utilisation_hours_per_day", 10))} />
              <Fact
                label={t("settings.utilKmPerDay", locale)}
                value={t("settings.nKm", locale).replace("{n}", num(n("utilisation_km_per_day", 200), 0))}
              />
            </>
          ),
          fields: (
            <>
              <Field label={t("settings.repairReplacePct", locale)} hint={inPercent} htmlFor="repair_replace_pct">
                <Input id="repair_replace_pct" name="repair_replace_pct" type="number" inputMode="numeric" min={1} defaultValue={n("repair_replace_pct", 60)} />
              </Field>
              <Field label={t("settings.utilHoursPerDay", locale)} hint={inHours} htmlFor="utilisation_hours_per_day">
                <Input id="utilisation_hours_per_day" name="utilisation_hours_per_day" type="number" inputMode="numeric" min={1} defaultValue={n("utilisation_hours_per_day", 10)} />
              </Field>
              <Field label={t("settings.utilKmPerDay", locale)} htmlFor="utilisation_km_per_day">
                <Input id="utilisation_km_per_day" name="utilisation_km_per_day" type="number" inputMode="numeric" min={1} defaultValue={n("utilisation_km_per_day", 200)} />
              </Field>
            </>
          ),
        })}

        {/* The language NEW people start in, not the owner's own (that is on /account). */}
        {group({
          title: t("settings.language", locale),
          owns: ["default_language"],
          facts: (
            <Fact
              label={t("settings.languageFact", locale)}
              value={t(s.default_language === "en" ? "settings.english" : "settings.afrikaans", locale)}
              hint={t("settings.languageHint", locale)}
            />
          ),
          fields: (
            <Field label={t("settings.languageFact", locale)} htmlFor="default_language">
              <Select id="default_language" name="default_language" defaultValue={(s.default_language as string) ?? "af"}>
                <option value="af">{t("settings.afrikaans", locale)}</option>
                <option value="en">{t("settings.english", locale)}</option>
              </Select>
            </Field>
          ),
        })}
      </section>
    </PageContainer>
  );
}
