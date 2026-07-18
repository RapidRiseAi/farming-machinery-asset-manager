"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

/** Capture a manual meter reading and advance the machine's current reading. */
export async function addReading(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic"]);

  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const readingRaw = String(formData.get("reading") ?? "").trim();
  const dateRaw = String(formData.get("reading_date") ?? "").trim();
  const reading = Number(readingRaw);

  if (!machineId || !farmId || readingRaw === "" || !Number.isFinite(reading) || reading < 0) {
    redirect(`/machines/${machineId}?error=Enter+a+valid+reading`);
  }
  const reading_date = dateRaw || new Date().toISOString().slice(0, 10);

  const supabase = await createClient();
  const { error } = await supabase.from("meter_readings").insert({
    farm_id: farmId,
    machine_id: machineId,
    reading,
    reading_date,
    source: "manual",
    by_user: profile.id,
  });
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);

  // Advance the machine's current reading only if this reading is the newest.
  const { data: m } = await supabase
    .from("machines")
    .select("current_reading_date")
    .eq("id", machineId)
    .maybeSingle();
  const current = (m as { current_reading_date: string | null } | null)?.current_reading_date;
  if (!current || reading_date >= current) {
    await supabase
      .from("machines")
      .update({ current_reading: reading, current_reading_date: reading_date })
      .eq("id", machineId);
  }

  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=reading`);
}
