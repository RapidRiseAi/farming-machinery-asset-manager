import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { t, type Lang } from "@/lib/i18n";
import { displayValue, fieldInputName, groupDefinitions, type FieldDefinition, type FieldValue } from "@/lib/custom-fields";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, FactList } from "@/components/ui/facts";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field, SelectField, TextField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { setAssetFields } from "@/app/(app)/settings/fields/actions";

/**
 * The business's own fields on one asset (task B5). Row security decides what this person
 * sees (a "managers" field is hidden from others); values are shown as text, never markup.
 * Owners and managers change them in a dialog; retired fields keep their values, read-only.
 */
export async function CustomFieldsCard({ supabase, machineId, farmId, canEdit, locale }: {
  supabase: SupabaseClient; machineId: string; farmId: string; canEdit: boolean; locale: Lang;
}) {
  const [defs, values] = await Promise.all([
    supabase.from("asset_field_definitions")
      .select("id,key,label,field_type,unit,choices,required,visibility,group_label,sort_order,retired_at").eq("farm_id", farmId),
    supabase.from("asset_field_values")
      .select("definition_id,value_text,value_number,value_date,value_bool").eq("machine_id", machineId),
  ]);
  // Nothing defined (or not readable, e.g. a plan without custom fields): no card at all.
  if (defs.error || values.error) return null;
  const definitions = (defs.data ?? []) as FieldDefinition[];
  if (definitions.length === 0) return null;
  const byDef = new Map(((values.data ?? []) as FieldValue[]).map((v) => [v.definition_id, v]));
  const yes = t("common.yes", locale), no = t("common.no", locale);
  const shown = definitions.filter((d) => !d.retired_at || byDef.has(d.id));
  const active = definitions.filter((d) => !d.retired_at);
  const current = (d: FieldDefinition) => byDef.get(d.id);

  return (
    <Card>
      <CardHeader
        action={canEdit && active.length > 0 ? (
          <DialogForm trigger={t("customFields.editValues", locale)} triggerVariant="secondary" title={t("customFields.editValuesTitle", locale)}
            closeLabel={t("ui.close", locale)} size="md">
            <form action={setAssetFields}>
              <input type="hidden" name="machine_id" value={machineId} />
              <DialogFields columns={1}>
                {groupDefinitions(active).flatMap(({ fields }) => fields).map((d) => {
                  const name = fieldInputName(d.id);
                  const v = current(d);
                  if (d.field_type === "yes_no") return (
                    <div key={d.id}>
                      <input type="hidden" name={`${name}__shown`} value="1" />
                      <Checkbox name={name} value="1" defaultChecked={v?.value_bool === true} label={d.label} />
                    </div>
                  );
                  if (d.field_type === "choice") return (
                    <SelectField key={d.id} name={name} label={d.label} required={d.required} defaultValue={v?.value_text ?? ""}>
                      <option value="">{t("customFields.noValue", locale)}</option>
                      {d.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                    </SelectField>
                  );
                  return (
                    <TextField key={d.id} name={name} label={d.unit ? `${d.label} (${d.unit})` : d.label} required={d.required}
                      type={d.field_type === "date" ? "date" : "text"} inputMode={d.field_type === "number" ? "decimal" : undefined}
                      maxLength={d.field_type === "text" ? 500 : undefined}
                      defaultValue={d.field_type === "number" ? (v?.value_number ?? "") as string : d.field_type === "date" ? v?.value_date ?? "" : v?.value_text ?? ""} />
                  );
                })}
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("common.save", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        ) : undefined}
      >
        <CardTitle>{t("customFields.cardTitle", locale)}</CardTitle>
      </CardHeader>
      {groupDefinitions(shown).map(({ group, fields }) => (
        <div key={group ?? "_"} className="mb-3 last:mb-0">
          {group ? <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sand-500">{group}</p> : null}
          <FactList>
            {fields.map((d) => (
              <Fact key={d.id} label={d.retired_at ? `${d.label} (${t("customFields.retiredBadge", locale)})` : d.label}
                value={displayValue(d, current(d), yes, no) ?? t("customFields.noValue", locale)} />
            ))}
          </FactList>
        </div>
      ))}
      {canEdit ? (
        <p className="mt-2 text-xs text-sand-500">
          <Link href="/settings/fields" className="underline">{t("customFields.manage", locale)}</Link>
        </p>
      ) : null}
    </Card>
  );
}
