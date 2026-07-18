"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { MACHINE_TYPES, MACHINE_STATUSES, METER_TYPES } from "@/lib/machine-options";

function str(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function intOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function numOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const inList = (list: readonly string[], v: string) => list.includes(v);

export async function createMachine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/machines?error=No+farm+context");

  const name = str(formData, "name");
  const type = String(formData.get("type") ?? "");
  if (!name) redirect("/machines/new?error=Name+is+required");
  if (!inList(MACHINE_TYPES, type)) redirect("/machines/new?error=Invalid+type");

  const meterInput = String(formData.get("meter_type") ?? "hours");
  const meter_type = inList(METER_TYPES, meterInput) ? meterInput : "hours";
  const current_reading = numOrNull(formData, "current_reading");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("machines")
    .insert({
      farm_id: profile.farm_id,
      name,
      type,
      make: str(formData, "make"),
      model: str(formData, "model"),
      year: intOrNull(formData, "year"),
      serial_no: str(formData, "serial_no"),
      reg_no: str(formData, "reg_no"),
      meter_type,
      current_reading,
      current_reading_date: current_reading != null ? new Date().toISOString().slice(0, 10) : null,
      status: "active",
    })
    .select("id")
    .single();

  if (error || !data) redirect(`/machines/new?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  revalidatePath("/machines");
  redirect(`/machines/${data.id}`);
}

export async function updateMachine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/machines?error=Missing+id");

  const name = str(formData, "name");
  const type = String(formData.get("type") ?? "");
  const status = String(formData.get("status") ?? "active");
  if (!name) redirect(`/machines/${id}?error=Name+is+required`);
  if (!inList(MACHINE_TYPES, type)) redirect(`/machines/${id}?error=Invalid+type`);
  if (!inList(MACHINE_STATUSES, status)) redirect(`/machines/${id}?error=Invalid+status`);

  const meterInput = String(formData.get("meter_type") ?? "hours");
  const meter_type = inList(METER_TYPES, meterInput) ? meterInput : "hours";

  const supabase = await createClient();
  // RLS scopes this to the caller's farm; profile is used only to gate the role.
  void profile;
  const { error } = await supabase
    .from("machines")
    .update({
      name,
      type,
      make: str(formData, "make"),
      model: str(formData, "model"),
      year: intOrNull(formData, "year"),
      serial_no: str(formData, "serial_no"),
      reg_no: str(formData, "reg_no"),
      meter_type,
      status,
    })
    .eq("id", id);

  if (error) redirect(`/machines/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/machines/${id}`);
  redirect(`/machines/${id}?saved=1`);
}
