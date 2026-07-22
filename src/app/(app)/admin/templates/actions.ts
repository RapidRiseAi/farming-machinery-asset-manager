"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { MACHINE_TYPES } from "@/lib/machine-options";

type TemplateLine = { task: string; interval_hours: number | null; interval_months: number | null };

/** Parse the textarea "lines" format: one per row — `Task | hours | months`. */
function parseLines(raw: string): TemplateLine[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [task, h, m] = l.split("|").map((x) => x.trim());
      const hours = h ? Number(h) : NaN;
      const months = m ? Number(m) : NaN;
      return {
        task: task ?? "",
        interval_hours: Number.isFinite(hours) ? hours : null,
        interval_months: Number.isFinite(months) ? months : null,
      };
    })
    .filter((l) => l.task && (l.interval_hours != null || l.interval_months != null));
}

export async function createTemplate(formData: FormData) {
  await requireRole(["rr_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  const machineTypeRaw = String(formData.get("machine_type") ?? "");
  const machine_type = MACHINE_TYPES.includes(machineTypeRaw as (typeof MACHINE_TYPES)[number]) ? machineTypeRaw : null;
  const lines = parseLines(String(formData.get("lines") ?? ""));
  if (!name) redirect("/admin/templates?error=Name+is+required");
  if (lines.length === 0) redirect("/admin/templates?error=Add+at+least+one+valid+line");

  const supabase = await createClient();
  // farm_id null = global library template; st_ins policy allows rr_admin.
  const { error } = await supabase.from("service_templates").insert({ farm_id: null, machine_type, name, lines });
  if (error) redirect(`/admin/templates?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/templates");
  redirect("/admin/templates?saved=1");
}

export async function updateTemplate(formData: FormData) {
  await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const machineTypeRaw = String(formData.get("machine_type") ?? "");
  const machine_type = MACHINE_TYPES.includes(machineTypeRaw as (typeof MACHINE_TYPES)[number]) ? machineTypeRaw : null;
  const lines = parseLines(String(formData.get("lines") ?? ""));
  if (!id || !name || lines.length === 0) redirect("/admin/templates?error=Name+and+lines+required");

  const supabase = await createClient();
  const { error } = await supabase.from("service_templates").update({ name, machine_type, lines }).eq("id", id);
  if (error) redirect(`/admin/templates?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/templates");
  redirect("/admin/templates?saved=1");
}

export async function deleteTemplate(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_templates")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/admin/templates?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/templates");
  redirect("/admin/templates?saved=1");
}
