"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, homePathFor, requireProfile, requireUsableFarm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorCode } from "@/lib/action-errors";
import { runOnce } from "@/lib/request-claim";
import { isUuid } from "@/lib/ids";
import { FIELD_TYPES, FIELD_VISIBILITY, parseChoices, valuesFromForm, type FieldDefinition } from "@/lib/custom-fields";

const HERE = "/settings/fields";

/**
 * Custom asset fields (task B5). The database decides everything that matters (role, plan,
 * the business, every value's type: public.asset_field_* in 20261121100000); these actions
 * read the form, call it, and say what happened. No business is taken from the form.
 */
async function gate() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${HERE}?error=no-farm`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);
  // The stop gate: a business that is not open writes nothing (the database refuses again).
  await requireUsableFarm(farmId, profile);
  return { farmId, supabase: await createClient() };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function defineField(form: FormData) {
  return runOnce(form, "fields:define", async () => {
    const { farmId, supabase } = await gate();
    const type = text(form, "field_type");
    const visibility = text(form, "visibility") || "everyone";
    if (!(FIELD_TYPES as readonly string[]).includes(type) || !(FIELD_VISIBILITY as readonly string[]).includes(visibility)) {
      redirect(`${HERE}?error=custom-field-invalid`);
    }
    const { error } = await supabase.rpc("asset_field_define", {
      p_farm: farmId,
      p_label: text(form, "label"),
      p_type: type,
      p_unit: text(form, "unit") || null,
      p_choices: parseChoices(text(form, "choices")),
      p_required: form.get("required") === "1",
      p_visibility: visibility,
      p_group: text(form, "group_label") || null,
    });
    if (error) redirect(`${HERE}?error=${errorCode(error, "settings/fields:define")}`);
    revalidatePath(HERE);
    return `${HERE}?saved=1`;
  }, { whileRunning: `${HERE}?error=still-saving` });
}

export async function updateField(form: FormData) {
  const { supabase } = await gate();
  const id = text(form, "id");
  if (!isUuid(id)) redirect(`${HERE}?error=custom-field-invalid`);
  const choices = form.has("choices") ? parseChoices(text(form, "choices")) : null;
  const { error } = await supabase.rpc("asset_field_update", {
    p_definition: id,
    p_label: text(form, "label") || null,
    p_unit: text(form, "unit") || null,
    p_choices: choices,
    p_required: form.has("required_shown") ? form.get("required") === "1" : null,
    p_visibility: text(form, "visibility") || null,
    p_group: form.has("group_label") ? text(form, "group_label") : null,
    p_sort: null,
  });
  if (error) redirect(`${HERE}?error=${errorCode(error, "settings/fields:update")}`);
  revalidatePath(HERE);
  redirect(`${HERE}?saved=1`);
}

export async function retireField(form: FormData) {
  const { supabase } = await gate();
  const id = text(form, "id");
  if (!isUuid(id)) redirect(`${HERE}?error=custom-field-invalid`);
  const { error } = await supabase.rpc("asset_field_retire", { p_definition: id, p_retire: form.get("retire") !== "0" });
  if (error) redirect(`${HERE}?error=${errorCode(error, "settings/fields:retire")}`);
  revalidatePath(HERE);
  redirect(`${HERE}?saved=1`);
}

/** One asset's values, from its page's dialog. */
export async function setAssetFields(form: FormData) {
  const profile = await requireProfile();
  const machineId = text(form, "machine_id");
  const back = isUuid(machineId) ? `/machines/${machineId}` : "/machines";
  if (!isUuid(machineId)) redirect(`${back}?error=custom-field-invalid`);
  const supabase = await createClient();
  // The definitions this person can see on the asset's business (row security decides).
  const machine = await supabase.from("machines").select("farm_id").eq("id", machineId).maybeSingle();
  if (machine.error || !machine.data) redirect(`${back}?error=${machine.error ? errorCode(machine.error, "settings/fields:set") : "forbidden"}`);
  await requireUsableFarm(machine.data.farm_id, profile);
  const defs = await supabase.from("asset_field_definitions")
    .select("id,key,label,field_type,unit,choices,required,visibility,group_label,sort_order,retired_at")
    .eq("farm_id", machine.data.farm_id);
  if (defs.error) redirect(`${back}?error=${errorCode(defs.error, "settings/fields:set")}`);
  const values = valuesFromForm(form, (defs.data ?? []) as FieldDefinition[]);
  const { error } = await supabase.rpc("asset_field_set", { p_machine: machineId, p_values: values });
  if (error) redirect(`${back}?error=${errorCode(error, "settings/fields:set")}`);
  revalidatePath(back);
  redirect(`${back}?fields=saved`);
}
