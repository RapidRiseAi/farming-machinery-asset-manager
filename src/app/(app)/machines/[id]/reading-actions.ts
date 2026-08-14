"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { recordMeterReading } from "@/lib/domain/fleet-commands";
import { todayInSouthAfrica } from "@/lib/assistant/date";

/** Capture a manual meter reading and advance the machine's current reading. */
export async function addReading(formData: FormData) {
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const readingRaw = String(formData.get("reading") ?? "").trim();
  const dateRaw = String(formData.get("reading_date") ?? "").trim();
  const reading = Number(readingRaw);

  if (!machineId || !farmId || readingRaw === "" || !Number.isFinite(reading) || reading < 0) {
    redirect(`/machines/${machineId}?error=Enter+a+valid+reading`);
  }
  const profile = await requireProfile();
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["rr_admin", "owner", "manager", "mechanic"].includes(role)) {
    redirect(`/machines/${machineId}?error=You+cannot+record+a+reading+for+that+farm`);
  }
  const reading_date = dateRaw || todayInSouthAfrica();
  const driverUserId = String(formData.get("driver_user_id") ?? "").trim() || null;

  const supabase = await createClient();
  try {
    await recordMeterReading(supabase, {
      farmId,
      machineId,
      reading,
      readingDate: reading_date,
      driverUserId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the reading";
    redirect(`/machines/${machineId}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=reading`);
}
