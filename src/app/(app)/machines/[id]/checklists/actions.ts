"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { isChecklistFieldType, type ChecklistFieldType } from "@/lib/checklists";
import { uploadChecklistPhotoDataUrl } from "@/lib/checklist-media";

// Who may FILL a checklist (pre-use inspection, service sign-off, condition report):
// the broad operational crew, including operators and linked workshops. Designing
// templates is a separate, narrower permission (see /checklists/actions.ts).
const FILL_CREW: Role[] = ["owner", "manager", "mechanic", "workshop", "operator"];

export type ChecklistValueInput = {
  template_field_id: string | null;
  sort_order: number;
  field_type: ChecklistFieldType;
  label: string;
  value_text: string | null;
  notes: string | null;
  photo_data_url: string | null;
};

export type ChecklistInstanceInput = {
  machine_id: string;
  template_id: string | null;
  template_name: string;
  status: "draft" | "completed";
  meter_reading: number | null;
  notes: string | null;
  values: ChecklistValueInput[];
};

/**
 * Save a filled checklist for a machine. Called directly from the fill renderer client
 * island. Creates the instance, uploads any photo-field images (base64 ferried through)
 * to the farm-scoped bucket, and writes one value row per field (snapshotting label/type
 * so the saved checklist renders even if the template later changes). Returns `{ error }`
 * on failure; redirects to the saved checklist on success.
 */
export async function createChecklistInstance(
  input: ChecklistInstanceInput,
): Promise<{ error?: string } | void> {
  const profile = await requireRole(FILL_CREW);
  const machineId = input.machine_id;
  if (!machineId) return { error: "Missing machine." };
  const status = input.status === "draft" ? "draft" : "completed";

  const supabase = await createClient();

  // Resolve the machine's farm (RLS scopes this to farms the user can reach).
  const { data: m } = await supabase
    .from("machines")
    .select("id, farm_id")
    .eq("id", machineId)
    .maybeSingle();
  const machine = m as { id: string; farm_id: string } | null;
  if (!machine) return { error: "Machine not found." };
  const farmId = machine.farm_id;

  const now = new Date().toISOString();
  const { data: created, error: insErr } = await supabase
    .from("checklist_instances")
    .insert({
      farm_id: farmId,
      machine_id: machineId,
      template_id: input.template_id,
      template_name: input.template_name?.trim() || "Checklist",
      status,
      meter_reading: input.meter_reading,
      notes: input.notes?.trim() || null,
      performed_by: profile.id,
      completed_at: status === "completed" ? now : null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insErr || !created) return { error: insErr?.message ?? "Could not save checklist." };
  const instanceId = (created as { id: string }).id;

  // Build value rows; upload photos first so each row can cite its attachment.
  const rows: Record<string, unknown>[] = [];
  for (const v of input.values) {
    if (!isChecklistFieldType(v.field_type)) continue;
    let attachmentId: string | null = null;
    if (v.field_type === "photo" && v.photo_data_url) {
      attachmentId = await uploadChecklistPhotoDataUrl(supabase, farmId, instanceId, v.photo_data_url, profile.id);
    }
    rows.push({
      farm_id: farmId,
      instance_id: instanceId,
      template_field_id: v.template_field_id,
      sort_order: v.sort_order,
      field_type: v.field_type,
      label: v.label?.slice(0, 500) || "Field",
      value_text: v.field_type === "photo" || v.field_type === "section_break" ? null : (v.value_text?.trim() || null),
      notes: v.field_type === "section_break" ? null : (v.notes?.trim() || null),
      attachment_id: attachmentId,
    });
  }
  if (rows.length > 0) {
    const { error: valErr } = await supabase.from("checklist_instance_values").insert(rows);
    if (valErr) return { error: valErr.message };
  }

  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}/checklists/${instanceId}`);
}

/** Soft-delete a filled checklist and its values (form action from the saved view). */
export async function deleteChecklistInstance(formData: FormData) {
  const profile = await requireRole(FILL_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id || !machineId) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const now = new Date().toISOString();
  await supabase.from("checklist_instance_values").update({ deleted_at: now, deleted_by: profile.id }).eq("instance_id", id).is("deleted_at", null);
  const { error } = await supabase.from("checklist_instances").update({ deleted_at: now, deleted_by: profile.id }).eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=checklist`);
}
