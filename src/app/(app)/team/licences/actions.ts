"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { homePathFor, requireProfile } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";

/**
 * Driver and operator documents, the licence in the person's pocket.
 *
 * == Why these writes go through the BROWSER client ===========================
 * Everywhere money is involved this codebase reaches for the service client, because the
 * engine's functions are service-role only. Here the opposite is right: `driver_credentials`
 * has a real SELECT and write policy, owner/manager write, the person reads their own row,
 * a linked workshop sees nothing, and using the service key would step over every one of
 * those rules and put the whole guarantee in this file instead of in the database.
 *
 * So the role check below is a courtesy that produces a sentence. RLS is what actually
 * refuses, and `supabase/tests/driver_credentials.sql` proves it by trying: a driver
 * extending their own expired PrDP updates zero rows.
 *
 * == The one thing a farm must not be able to do ==============================
 * Change WHO a credential belongs to. Re-pointing an existing row at a different person is
 * how one driver's valid licence silently becomes another's, on a record the farm may
 * later rely on in front of an AARTO nomination. `user_id` and `person_name` are set once,
 * at capture, and are not in the update path at all, a mistake is deleted and recaptured,
 * which leaves both events in `audit_log`.
 */

const TYPES = ["drivers_licence", "prdp", "competency", "medical", "induction", "other"];

async function requireTeamManager() {
  const profile = await requireProfile();
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.role || !["owner", "manager"].includes(state.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId: state.farmId };
}

function bounce(code: string): never {
  redirect(`/team/licences?error=${encodeURIComponent(code)}`);
}

/** Blank → null. An empty date posted as "" is not a date, and `""::date` is an error. */
function dateOrNull(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bounce("credential-bad-date");
  return v;
}

export async function addDriverCredential(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireTeamManager();

  const type = String(formData.get("type") ?? "").trim();
  if (!TYPES.includes(type)) bounce("credential-bad-type");

  // Either a person on the farm, or a name. The database enforces exactly one of the two;
  // this turns "which one did they mean" into a decision made here rather than a check
  // constraint reaching a farmer.
  const userId = String(formData.get("user_id") ?? "").trim();
  const personName = String(formData.get("person_name") ?? "").trim();
  if (userId && personName) bounce("credential-two-people");
  if (!userId && !personName) bounce("credential-no-person");
  if (userId && !/^[0-9a-f-]{36}$/i.test(userId)) bounce("credential-no-person");

  const expiry = dateOrNull(String(formData.get("expiry_date") ?? ""));
  const issued = dateOrNull(String(formData.get("issued_on") ?? ""));
  if (issued && expiry && expiry < issued) bounce("credential-backwards");

  const leadRaw = String(formData.get("reminder_lead_days") ?? "").trim();
  let lead = 30;
  if (leadRaw !== "") {
    const n = Number(leadRaw);
    if (!Number.isInteger(n) || n < 0 || n > 365) bounce("credential-bad-lead");
    lead = n;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("driver_credentials").insert({
    farm_id: farmId,
    user_id: userId || null,
    person_name: userId ? null : personName,
    type,
    code: String(formData.get("code") ?? "").trim() || null,
    number: String(formData.get("number") ?? "").trim() || null,
    issued_on: issued,
    expiry_date: expiry,
    reminder_lead_days: lead,
    notes: String(formData.get("notes") ?? "").trim() || null,
    created_by: profile.id,
  });
  if (error) bounce("credential-save-failed");

  revalidatePath("/team/licences");
  redirect("/team/licences?saved=credential-added");
}

/**
 * Renew one: a new expiry date, and the reminder bookkeeping cleared.
 *
 * Clearing `notified_status` is the whole job. Without it the nightly pass compares the
 * new status against the old marker, finds them the same where a renewal moved a row from
 * `expired` straight back to `expired` on a short renewal, and stays silent, or worse,
 * keeps the row marked `expired` so the weekly re-fire never stops for a document that is
 * now perfectly valid.
 */
export async function renewDriverCredential(formData: FormData): Promise<void> {
  await requireTeamManager();

  const id = String(formData.get("id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) bounce("credential-missing");

  const expiry = dateOrNull(String(formData.get("expiry_date") ?? ""));
  if (!expiry) bounce("credential-bad-date");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("driver_credentials")
    .update({
      expiry_date: expiry,
      issued_on: dateOrNull(String(formData.get("issued_on") ?? "")),
      number: String(formData.get("number") ?? "").trim() || null,
      notified_status: null,
      last_notified_at: null,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) bounce("credential-save-failed");
  // RLS returns success with zero rows to somebody the policy refuses. Saying "saved"
  // there would be the screen telling a farm that a licence had been renewed when the
  // database had declined to write it.
  if (!data || data.length === 0) bounce("credential-missing");

  revalidatePath("/team/licences");
  redirect("/team/licences?saved=credential-renewed");
}

/** Soft delete, per the global convention: the row leaves the screen, not the history. */
export async function removeDriverCredential(formData: FormData): Promise<void> {
  const { profile } = await requireTeamManager();

  const id = String(formData.get("id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) bounce("credential-missing");

  const supabase = await createClient();
  // Checked BEFORE the write rather than with `.select()` after it. A soft delete makes the
  // row fail its own SELECT policy (`deleted_at is null`), so asking the update to return
  // it asks for the one row the policy has just been told to hide, the same trap that
  // made `correct_meter_reading` a definer function earlier in this schema.
  const { data: found } = await supabase
    .from("driver_credentials")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!found) bounce("credential-missing");

  const { error } = await supabase
    .from("driver_credentials")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) bounce("credential-save-failed");

  revalidatePath("/team/licences");
  redirect("/team/licences?saved=credential-removed");
}
