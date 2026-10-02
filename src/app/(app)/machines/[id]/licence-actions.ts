"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { withTab } from "@/components/ui/tabs-url";
import { LICENCE_TYPES } from "@/lib/compliance";

function strOrNull(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function intOr(fd: FormData, k: string, dflt: number): number {
  const n = Number(String(fd.get(k) ?? "").trim());
  return Number.isFinite(n) ? Math.round(n) : dflt;
}
function licenceType(fd: FormData): string {
  const v = String(fd.get("type") ?? "vehicle_licence");
  return (LICENCE_TYPES as readonly string[]).includes(v) ? v : "vehicle_licence";
}

/** Add a licence / renewal to a machine (FR-13.3). */
export async function addLicence(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const expiry = strOrNull(formData, "expiry_date");
  if (!machineId || !farmId) redirect(withTab(`/machines/${machineId}?error=Missing+machine`, "papers"));
  if (!expiry) redirect(withTab(`/machines/${machineId}?error=Expiry+date+is+required`, "papers"));

  const supabase = await createClient();
  const { error } = await supabase.from("licences").insert({
    farm_id: farmId,
    machine_id: machineId,
    type: licenceType(formData),
    number: strOrNull(formData, "number"),
    expiry_date: expiry,
    reminder_lead_days: intOr(formData, "reminder_lead_days", 30),
    notes: strOrNull(formData, "notes"),
  });
  if (error) redirect(withTab(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`, "papers"));
  revalidatePath(`/machines/${machineId}`);
  redirect(withTab(`/machines/${machineId}?saved=licence`, "papers"));
}

/** Edit a licence. Resets the notify marker so a corrected date re-evaluates cleanly. */
export async function updateLicence(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const expiry = strOrNull(formData, "expiry_date");
  if (!id) redirect(withTab(`/machines/${machineId}?error=Missing+id`, "papers"));
  if (!expiry) redirect(withTab(`/machines/${machineId}?error=Expiry+date+is+required`, "papers"));

  const supabase = await createClient();
  const { error } = await supabase
    .from("licences")
    .update({
      type: licenceType(formData),
      number: strOrNull(formData, "number"),
      expiry_date: expiry,
      reminder_lead_days: intOr(formData, "reminder_lead_days", 30),
      notes: strOrNull(formData, "notes"),
      notified_status: null,
      last_notified_at: null,
    })
    .eq("id", id);
  if (error) redirect(withTab(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`, "papers"));
  revalidatePath(`/machines/${machineId}`);
  redirect(withTab(`/machines/${machineId}?saved=licence`, "papers"));
}

/** Soft-delete a licence. */
export async function deleteLicence(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(withTab(`/machines/${machineId}?error=Missing+id`, "papers"));
  const supabase = await createClient();
  const { error } = await supabase
    .from("licences")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(withTab(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`, "papers"));
  revalidatePath(`/machines/${machineId}`);
  redirect(withTab(`/machines/${machineId}?saved=licence`, "papers"));
}
