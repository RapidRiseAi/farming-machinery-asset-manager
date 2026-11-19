"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Rapid Rise's controls for scheduled deletion (20261120120000): holds, a fresh dry run, and the
 * switch. Every action starts with `requireRole(["rr_admin"])` (two-step this session, never a
 * test account); the database checks the admin's id again (`app.service_rr_actor`).
 */

const BACK = "/admin/retention";
const KINDS = ["legal", "dispute", "support", "other"];

export async function placeHold(formData: FormData) {
  const admin = await requireRole(["rr_admin"]);
  const farm = String(formData.get("farm_id") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!isUuid(farm) || !KINDS.includes(kind) || !reason) redirect(`${BACK}?error=retention-invalid`);
  const { error } = await createServiceClient().rpc("retention_place_hold", { p_by: admin.id, p_farm: farm, p_kind: kind, p_reason: reason });
  if (error) redirect(`${BACK}?error=${errorCode(error, "admin:retention-hold", "retention-invalid")}`);
  revalidatePath(BACK);
  redirect(`${BACK}?saved=1`);
}

export async function releaseHold(formData: FormData) {
  const admin = await requireRole(["rr_admin"]);
  const hold = String(formData.get("hold_id") ?? "");
  if (!isUuid(hold)) redirect(`${BACK}?error=retention-invalid`);
  const { error } = await createServiceClient().rpc("retention_release_hold", { p_by: admin.id, p_hold: hold });
  if (error) redirect(`${BACK}?error=${errorCode(error, "admin:retention-release", "retention-invalid")}`);
  revalidatePath(BACK);
  redirect(`${BACK}?saved=1`);
}

/** Schedules and previews now, exactly as the nightly pass does (a dry run while switched off). */
export async function runSchedule() {
  await requireRole(["rr_admin"]);
  const { error } = await createServiceClient().rpc("retention_schedule_run");
  if (error) redirect(`${BACK}?error=${errorCode(error, "admin:retention-run", "try-again")}`);
  revalidatePath(BACK);
  redirect(`${BACK}?saved=1`);
}

/** The founder's decision: on takes the typed phrase; off never does. */
export async function setDeletion(formData: FormData) {
  const admin = await requireRole(["rr_admin"]);
  const enabled = String(formData.get("enabled") ?? "") === "true";
  const { error } = await createServiceClient().rpc("retention_set_enabled", {
    p_by: admin.id, p_enabled: enabled, p_phrase: String(formData.get("phrase") ?? ""),
  });
  if (error) redirect(`${BACK}?error=${errorCode(error, "admin:retention-switch", "retention-invalid")}`);
  revalidatePath(BACK);
  redirect(`${BACK}?saved=1`);
}
