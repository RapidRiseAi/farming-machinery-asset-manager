"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import {
  correctMeterReading,
  recordMeterReading,
  recordMeterReplacement,
} from "@/lib/domain/fleet-commands";
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
  if (!role || !["rr_admin", "owner", "manager", "mechanic", "operator"].includes(role)) {
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

/**
 * Undo a mistyped reading.
 *
 * Until this existed, one typo was permanent: `record_meter_reading` refuses anything below
 * the machine's reading, so every true reading afterwards was rejected and every service
 * due date stayed wrong. The reading is voided rather than deleted, the row, the reason
 * and the person survive in the audit trail, and the machine falls back to what the
 * remaining history says.
 */
export async function correctReading(formData: FormData) {
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const readingId = String(formData.get("reading_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const back = `/machines/${machineId}`;

  if (!machineId || !farmId || !readingId) redirect(`${back}?error=meter-correct-missing`);
  const profile = await requireProfile();
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["rr_admin", "owner", "manager"].includes(role)) {
    redirect(`${back}?error=forbidden`);
  }

  const supabase = await createClient();
  try {
    await correctMeterReading(supabase, { farmId, machineId, readingId, reason });
  } catch {
    // Never the raw message: the command refuses in English prose written in a migration.
    redirect(`${back}?error=meter-correct-failed`);
  }

  revalidatePath(back);
  redirect(`${back}?saved=meter-corrected`);
}

/**
 * Record that the hour meter or odometer was replaced.
 *
 * The old hours belonged to the old instrument. This sets the new baseline and rebases the
 * service plan by the difference, so "next due at 1 500 hours" does not become unreachable
 * the moment a meter starts again at zero.
 */
export async function replaceMeter(formData: FormData) {
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const readingRaw = String(formData.get("new_reading") ?? "").trim();
  const newReading = Number(readingRaw);
  const replacedOn = String(formData.get("replaced_on") ?? "").trim() || todayInSouthAfrica();
  const note = String(formData.get("note") ?? "").trim() || null;
  const back = `/machines/${machineId}`;

  if (!machineId || !farmId || readingRaw === "" || !Number.isFinite(newReading) || newReading < 0) {
    redirect(`${back}?error=meter-replace-invalid`);
  }
  const profile = await requireProfile();
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["rr_admin", "owner", "manager"].includes(role)) {
    redirect(`${back}?error=forbidden`);
  }

  const supabase = await createClient();
  try {
    await recordMeterReplacement(supabase, { farmId, machineId, newReading, replacedOn, note });
  } catch {
    redirect(`${back}?error=meter-replace-failed`);
  }

  revalidatePath(back);
  redirect(`${back}?saved=meter-replaced`);
}
