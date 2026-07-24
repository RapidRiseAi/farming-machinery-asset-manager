"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { isChecklistFieldType, type ChecklistFieldType } from "@/lib/checklists";

// Who may build/maintain checklist templates: farm crew for their own farm's templates,
// RR admin for the GLOBAL library. Operators/workshop are read-only here (they fill
// checklists, they don't design them).
const TEMPLATE_CREW: Role[] = ["owner", "manager", "mechanic", "rr_admin"];

export type TemplateFieldPayload = {
  field_type: ChecklistFieldType;
  label: string;
  required: boolean;
  help_text: string | null;
  config: Record<string, unknown> | null;
};

export type TemplatePayload = {
  id?: string;
  name: string;
  description: string | null;
  machine_type: string | null;
  fields: TemplateFieldPayload[];
};

function sanitizeFields(fields: TemplateFieldPayload[]): TemplateFieldPayload[] {
  return fields
    .filter((f) => isChecklistFieldType(f.field_type) && f.label.trim())
    .map((f) => ({
      field_type: f.field_type,
      label: f.label.trim(),
      required: f.field_type === "section_break" ? false : Boolean(f.required),
      help_text: f.field_type === "section_break" ? null : (f.help_text?.trim() || null),
      config: f.config ?? null,
    }));
}

async function insertFields(
  supabase: Awaited<ReturnType<typeof createClient>>,
  templateId: string,
  farmId: string | null,
  fields: TemplateFieldPayload[],
) {
  if (fields.length === 0) return null;
  const rows = fields.map((f, i) => ({
    template_id: templateId,
    farm_id: farmId,
    sort_order: i,
    field_type: f.field_type,
    label: f.label,
    required: f.required,
    help_text: f.help_text,
    config: f.config,
  }));
  const { error } = await supabase.from("checklist_template_fields").insert(rows);
  return error?.message ?? null;
}

/**
 * Create or update a checklist template + its ordered fields. Called directly from the
 * builder client island. Returns `{ error }` on failure; redirects to /checklists on
 * success. RR admin writes the GLOBAL library (farm_id null); everyone else writes their
 * own farm's templates (RLS enforces both).
 */
export async function saveChecklistTemplate(payload: TemplatePayload): Promise<{ error?: string } | void> {
  const profile = await requireRole(TEMPLATE_CREW);
  const name = payload.name?.trim();
  if (!name) return { error: "Template name is required." };
  const fields = sanitizeFields(payload.fields ?? []);
  if (fields.length === 0) return { error: "Add at least one field." };
  const machineType = payload.machine_type || null;
  const description = payload.description?.trim() || null;

  const supabase = await createClient();

  if (payload.id) {
    // Edit: keep the template's existing scope (farm_id); replace its fields.
    const { data: existing } = await supabase
      .from("checklist_templates")
      .select("id, farm_id")
      .eq("id", payload.id)
      .is("deleted_at", null)
      .maybeSingle();
    const row = existing as { id: string; farm_id: string | null } | null;
    if (!row) return { error: "Template not found." };

    const { error: upErr } = await supabase
      .from("checklist_templates")
      .update({ name, description, machine_type: machineType, updated_at: new Date().toISOString() })
      .eq("id", payload.id);
    if (upErr) return { error: upErr.message };

    // Replace fields (hard delete + re-insert). Completed instances keep their own
    // snapshotted field metadata, so history is unaffected.
    const { error: delErr } = await supabase.from("checklist_template_fields").delete().eq("template_id", payload.id);
    if (delErr) return { error: delErr.message };
    const insErr = await insertFields(supabase, payload.id, row.farm_id, fields);
    if (insErr) return { error: insErr };
  } else {
    const farmId = profile.role === "rr_admin" ? null : profile.farm_id;
    if (profile.role !== "rr_admin" && !farmId) return { error: "No farm." };

    const { data: created, error: insErr } = await supabase
      .from("checklist_templates")
      .insert({ farm_id: farmId, name, description, machine_type: machineType, created_by: profile.id })
      .select("id")
      .single();
    if (insErr || !created) return { error: insErr?.message ?? "Could not create template." };
    const fieldErr = await insertFields(supabase, (created as { id: string }).id, farmId, fields);
    if (fieldErr) return { error: fieldErr };
  }

  revalidatePath("/checklists");
  redirect("/checklists?saved=1");
}

/** Soft-delete a template and its fields (form action from the templates list). */
export async function deleteChecklistTemplate(formData: FormData) {
  const profile = await requireRole(TEMPLATE_CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/checklists?error=Missing+id");
  const supabase = await createClient();
  const now = new Date().toISOString();
  await supabase.from("checklist_template_fields").update({ deleted_at: now, deleted_by: profile.id }).eq("template_id", id).is("deleted_at", null);
  const { error } = await supabase.from("checklist_templates").update({ deleted_at: now, deleted_by: profile.id }).eq("id", id);
  if (error) redirect(`/checklists?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/checklists");
  redirect("/checklists?saved=1");
}

/** Duplicate a template into the user's own scope (form action from the list). */
export async function duplicateChecklistTemplate(formData: FormData) {
  const profile = await requireRole(TEMPLATE_CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/checklists?error=Missing+id");
  const supabase = await createClient();

  const { data: src } = await supabase
    .from("checklist_templates")
    .select("name, description, machine_type, checklist_template_fields(sort_order, field_type, label, required, help_text, config)")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const source = src as
    | { name: string; description: string | null; machine_type: string | null; checklist_template_fields: { sort_order: number; field_type: string; label: string; required: boolean; help_text: string | null; config: Record<string, unknown> | null }[] | null }
    | null;
  if (!source) redirect("/checklists?error=Template+not+found");

  const farmId = profile.role === "rr_admin" ? null : profile.farm_id;
  if (profile.role !== "rr_admin" && !farmId) redirect("/checklists?error=No+farm");

  const { data: created, error: insErr } = await supabase
    .from("checklist_templates")
    .insert({ farm_id: farmId, name: `${source!.name} (copy)`, description: source!.description, machine_type: source!.machine_type, created_by: profile.id })
    .select("id")
    .single();
  if (insErr || !created) redirect(`/checklists?error=${encodeURIComponent(insErr?.message ?? "copy failed")}`);

  const fields = (source!.checklist_template_fields ?? [])
    .filter((f) => isChecklistFieldType(f.field_type))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((f, i) => ({
      template_id: (created as { id: string }).id,
      farm_id: farmId,
      sort_order: i,
      field_type: f.field_type,
      label: f.label,
      required: f.field_type === "section_break" ? false : f.required,
      help_text: f.help_text,
      config: f.config,
    }));
  if (fields.length > 0) {
    await supabase.from("checklist_template_fields").insert(fields);
  }
  revalidatePath("/checklists");
  redirect("/checklists?saved=1");
}
