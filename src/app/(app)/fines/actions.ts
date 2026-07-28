"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, checkEntitlement } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { isFineStatus, nominationPending, type FineStatus } from "@/lib/fines";

function strOrNull(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function dateOrNull(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function statusOr(fd: FormData, k: string, dflt: FineStatus): FineStatus {
  const v = String(fd.get(k) ?? "");
  return isFineStatus(v) ? v : dflt;
}

/** Owner/manager only, AARTO plan (Complete+) required — enforced server-side, not just hidden. */
async function requireAartoManager() {
  const profile = await requireRole(["owner", "manager"]);
  if (!(await checkEntitlement("aarto", profile)).allowed) redirect("/fines?error=upgrade_required");
  return profile;
}

/**
 * Record an AARTO fine (FR-13.2). The driver may already be identified (a usage-log
 * suggestion the user accepted, or a manual pick) — in which case we advance the status to
 * `driver_identified` unless a later status was explicitly chosen.
 */
export async function createFine(formData: FormData) {
  await requireAartoManager();
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  if (!machineId || !farmId) redirect("/fines?error=Missing+vehicle");

  const driverUserId = strOrNull(formData, "driver_user_id");
  const driverName = strOrNull(formData, "driver_name");
  const hasDriver = driverUserId != null || driverName != null;
  // Minimum status once a driver is known is driver_identified; honour a higher explicit choice.
  let status = statusOr(formData, "status", "received");
  if (hasDriver && status === "received") status = "driver_identified";

  const supabase = await createClient();
  const { error } = await supabase.from("fines").insert({
    farm_id: farmId,
    machine_id: machineId,
    notice_number: strOrNull(formData, "notice_number"),
    authority: strOrNull(formData, "authority"),
    offence: strOrNull(formData, "offence"),
    offence_date: dateOrNull(formData, "offence_date"),
    fine_date: dateOrNull(formData, "fine_date") ?? new Date().toISOString().slice(0, 10),
    amount_cents: parseRandsToCents(String(formData.get("amount") ?? "")),
    nomination_deadline: dateOrNull(formData, "nomination_deadline"),
    status,
    driver_user_id: driverUserId,
    driver_name: driverUserId ? null : driverName,
    notes: strOrNull(formData, "notes"),
  });
  if (error) redirect(`/fines?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/fines");
  const back = String(formData.get("redirect_to") ?? "/fines?saved=fine");
  redirect(back);
}

/** Identify (or re-assign) the responsible driver on an existing fine. */
export async function identifyDriver(formData: FormData) {
  await requireAartoManager();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/fines?error=Missing+fine");
  const driverUserId = strOrNull(formData, "driver_user_id");
  const driverName = strOrNull(formData, "driver_name");

  const supabase = await createClient();
  const { error } = await supabase
    .from("fines")
    .update({
      driver_user_id: driverUserId,
      driver_name: driverUserId ? null : driverName,
      status: "driver_identified",
    })
    .eq("id", id);
  if (error) redirect(`/fines?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/fines");
  redirect("/fines?saved=fine");
}

/**
 * Advance a fine through its lifecycle (nominated / paid / disputed / closed). Leaving the
 * pending set clears the nomination-deadline dedupe markers so the reminder engine stops.
 */
export async function updateFineStatus(formData: FormData) {
  await requireAartoManager();
  const id = String(formData.get("id") ?? "");
  const status = statusOr(formData, "status", "received");
  if (!id) redirect("/fines?error=Missing+fine");

  const patch: Record<string, unknown> = { status };
  if (!nominationPending(status)) {
    patch.nomination_notified_status = null;
    patch.nomination_notified_at = null;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("fines").update(patch).eq("id", id);
  if (error) redirect(`/fines?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/fines");
  redirect("/fines?saved=fine");
}

/** Soft-delete a fine. */
export async function deleteFine(formData: FormData) {
  const profile = await requireAartoManager();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/fines?error=Missing+fine");
  const supabase = await createClient();
  const { error } = await supabase
    .from("fines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/fines?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/fines");
  redirect("/fines?saved=fine");
}
