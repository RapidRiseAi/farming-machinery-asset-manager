"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";

// Owner/manager/mechanic maintain a machine's service kit (the parts BOM). Operators
// and external workshops are read-only here.
const KIT_CREW: Role[] = ["owner", "manager", "mechanic"];

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function num(fd: FormData, k: string): number | null {
  const v = s(fd, k);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Create a machine-level service kit (the parts needed at a service). */
export async function createServiceKit(formData: FormData) {
  const profile = await requireRole(KIT_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const name = s(formData, "name");
  if (!machineId || !farmId || !name) redirect(`/machines/${machineId}?error=Kit+name+is+required`);

  const supabase = await createClient();
  const { error } = await supabase.from("service_kits").insert({
    farm_id: farmId,
    machine_id: machineId,
    name,
    notes: s(formData, "notes"),
    created_by: profile.id,
  });
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=kit`);
}

export async function deleteServiceKit(formData: FormData) {
  const profile = await requireRole(KIT_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const now = new Date().toISOString();
  // Soft-delete the kit and its items together (items cascade on hard delete only).
  await supabase.from("service_kit_items").update({ deleted_at: now, deleted_by: profile.id }).eq("service_kit_id", id).is("deleted_at", null);
  const { error } = await supabase.from("service_kits").update({ deleted_at: now, deleted_by: profile.id }).eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=kit`);
}

/** Add an item to a kit. May reference a catalogue part (prefill snapshot) or be a
 *  free part_no. Unit cost is captured ex-VAT (Scope §6), matching the catalogue. */
export async function addKitItem(formData: FormData) {
  await requireRole(KIT_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const kitId = String(formData.get("service_kit_id") ?? "");
  if (!machineId || !farmId || !kitId) redirect(`/machines/${machineId}?error=Missing+ids`);

  const supabase = await createClient();
  const catalogueId = s(formData, "part_catalogue_id");
  let partNo = s(formData, "part_no");
  let description = s(formData, "description");
  let unitCents = parseRandsToCents(String(formData.get("unit_cost") ?? ""));

  // If a catalogue part was chosen but fields were left blank, snapshot from it.
  if (catalogueId && (partNo == null || description == null || unitCents == null)) {
    const { data: part } = await supabase
      .from("parts_catalogue")
      .select("part_no, description, typical_cost_cents")
      .eq("id", catalogueId)
      .maybeSingle();
    const p = part as { part_no: string; description: string | null; typical_cost_cents: number | null } | null;
    if (p) {
      partNo = partNo ?? p.part_no;
      description = description ?? p.description;
      unitCents = unitCents ?? p.typical_cost_cents;
    }
  }
  if (partNo == null && description == null) redirect(`/machines/${machineId}?error=Pick+a+part+or+enter+a+part+number`);

  const { error } = await supabase.from("service_kit_items").insert({
    farm_id: farmId,
    service_kit_id: kitId,
    part_catalogue_id: catalogueId,
    part_no: partNo,
    description,
    qty: num(formData, "qty") ?? 1,
    unit_cost_cents: unitCents,
  });
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=kit`);
}

export async function updateKitItem(formData: FormData) {
  await requireRole(KIT_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_kit_items")
    .update({
      part_no: s(formData, "part_no"),
      description: s(formData, "description"),
      qty: num(formData, "qty") ?? 1,
      unit_cost_cents: parseRandsToCents(String(formData.get("unit_cost") ?? "")),
    })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=kit`);
}

export async function deleteKitItem(formData: FormData) {
  const profile = await requireRole(KIT_CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_kit_items")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=kit`);
}
