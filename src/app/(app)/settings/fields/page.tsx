import { redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, getFarmPlan, homePathFor, requireProfile } from "@/lib/auth";
import { planAllows, requiredPlan } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t, type Lang } from "@/lib/i18n";
import { FIELD_TYPES, groupDefinitions, type FieldDefinition } from "@/lib/custom-fields";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field, SelectField, TextField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { defineField, retireField, updateField } from "./actions";

export const dynamic = "force-dynamic";

/** The form fields a definition takes, shared by "new" and "edit" (type is fixed once made). */
function DefinitionFields({ locale, d }: { locale: Lang; d?: FieldDefinition }) {
  return (
    <DialogFields columns={1}>
      <TextField name="label" label={t("customFields.label", locale)} required maxLength={60} defaultValue={d?.label} />
      {d ? null : (
        <SelectField name="field_type" label={t("customFields.type", locale)} required defaultValue="text">
          {FIELD_TYPES.map((type) => <option key={type} value={type}>{t(`customFields.types.${type}`, locale)}</option>)}
        </SelectField>
      )}
      {!d || d.field_type === "number" ? (
        <TextField name="unit" label={t("customFields.unit", locale)} hint={t("customFields.unitHint", locale)} maxLength={16} defaultValue={d?.unit ?? undefined} />
      ) : null}
      {!d || d.field_type === "choice" ? (
        <Field label={t("customFields.choices", locale)} hint={t("customFields.choicesHint", locale)} htmlFor={`choices-${d?.id ?? "new"}`}>
          <textarea id={`choices-${d?.id ?? "new"}`} name="choices" rows={3} className="rounded-md border border-sand-300 bg-surface px-3 py-2 text-sm"
            defaultValue={d?.choices.join("\n")} />
        </Field>
      ) : null}
      <TextField name="group_label" label={t("customFields.group", locale)} hint={t("customFields.groupHint", locale)} maxLength={40} defaultValue={d?.group_label ?? undefined} />
      <SelectField name="visibility" label={t("customFields.visibility", locale)} defaultValue={d?.visibility ?? "everyone"}>
        <option value="everyone">{t("customFields.visibilityEveryone", locale)}</option>
        <option value="managers">{t("customFields.visibilityManagers", locale)}</option>
      </SelectField>
      <input type="hidden" name="required_shown" value="1" />
      <Checkbox name="required" value="1" defaultChecked={d?.required} label={t("customFields.required", locale)} />
    </DialogFields>
  );
}

/**
 * Custom asset fields (task B5, 20261121100000): what a business records about its assets beyond
 * the standard fields. Owners and managers define them on Professional and Complete; renaming or
 * retiring one keeps every value. Essential keeps the standard fields.
 */
export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${homePathFor(profile.role)}?denied=1`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);
  const back = { href: "/settings", label: t("nav.settings", locale) };

  const plan = role === "rr_admin" ? null : await getFarmPlan(farmId);
  if (role !== "rr_admin" && (!plan || !planAllows(plan, "custom_fields"))) {
    return (
      <PageContainer size="narrow">
        <PageHeader title={t("customFields.title", locale)} locale={locale} back={back} />
        <UpgradeNotice feature="custom_fields" requiredPlan={requiredPlan("custom_fields")} currentPlan={plan} locale={locale} canUpgrade={role === "owner"} />
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.from("asset_field_definitions")
    .select("id,key,label,field_type,unit,choices,required,visibility,group_label,sort_order,retired_at")
    .eq("farm_id", farmId);
  const definitions = (data ?? []) as FieldDefinition[];
  const active = groupDefinitions(definitions.filter((d) => !d.retired_at));
  const retired = definitions.filter((d) => d.retired_at);

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("customFields.title", locale)}
        lead={t("customFields.lead", locale)}
        locale={locale}
        back={back}
        actions={
          <DialogForm trigger={t("customFields.new", locale)} triggerIcon={<PlusIcon />} title={t("customFields.newTitle", locale)}
            description={t("customFields.newLead", locale)} closeLabel={t("ui.close", locale)} size="md">
            <form action={defineField}>
              <RequestIdInput action="fields:define" />
              <DefinitionFields locale={locale} />
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        }
      />
      <Flash tone="error" message={error ? errorMessage("load_failed", locale) : errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("customFields.saved", locale) : undefined} />

      {active.length === 0 ? (
        <Card><p className="text-sm text-sand-600">{t("customFields.empty", locale)}</p></Card>
      ) : active.map(({ group, fields }) => (
        <Card key={group ?? "_"}>
          <CardHeader><CardTitle>{group ?? t("customFields.ungrouped", locale)}</CardTitle></CardHeader>
          <ul className="divide-y divide-sand-200">
            {fields.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words font-semibold text-sand-900">{d.label}</p>
                  <p className="text-sm text-sand-600">
                    {t(`customFields.types.${d.field_type}`, locale)}
                    {d.unit ? ` (${d.unit})` : ""}
                    {d.field_type === "choice" ? `: ${d.choices.join(", ")}` : ""}
                    {d.required ? ` · ${t("customFields.requiredShort", locale)}` : ""}
                    {d.visibility === "managers" ? ` · ${t("customFields.visibilityManagers", locale)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <DialogForm trigger={t("customFields.edit", locale)} triggerVariant="secondary" title={t("customFields.editTitle", locale).replace("{label}", d.label)}
                    closeLabel={t("ui.close", locale)} size="md">
                    <form action={updateField}>
                      <input type="hidden" name="id" value={d.id} />
                      <DefinitionFields locale={locale} d={d} />
                      <DialogActions cancelLabel={t("common.cancel", locale)}>
                        <SubmitButton>{t("common.save", locale)}</SubmitButton>
                      </DialogActions>
                    </form>
                  </DialogForm>
                  <ConfirmDialog action={retireField} triggerLabel={t("customFields.retire", locale)} triggerVariant="secondary" triggerSize="sm"
                    title={t("customFields.retireTitle", locale).replace("{label}", d.label)} intro={t("customFields.retireIntro", locale)}
                    confirmLabel={t("customFields.retire", locale)} cancelLabel={t("common.cancel", locale)} closeLabel={t("ui.close", locale)}>
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="retire" value="1" />
                  </ConfirmDialog>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {retired.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("customFields.retired", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("customFields.retiredLead", locale)}</p>
          <ul className="divide-y divide-sand-200">
            {retired.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="break-words text-sand-800">{d.label}</span>
                  <StatusBadge tone="neutral" shape="dash" label={t("customFields.retiredBadge", locale)} />
                </span>
                <form action={retireField}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="retire" value="0" />
                  <SubmitButton variant="secondary" size="sm">{t("customFields.restore", locale)}</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </PageContainer>
  );
}
