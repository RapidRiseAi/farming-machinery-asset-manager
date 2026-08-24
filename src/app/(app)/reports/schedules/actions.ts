"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
  requireProfile,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { deliverReportRun, type ClaimedRun } from "@/lib/scheduled-reports";
import { isReportFormat, isReportKey } from "@/lib/report-export";
import { CADENCES, type Cadence } from "@/lib/recurring";

/**
 * Emailed reports (FR-11.5) — the write side.
 *
 * Two gates on every one of these, per the F5 rule that a gate lives at the ACTION and
 * not only in the nav: owner/manager in the SELECTED farm (or support admin), and that
 * farm's Professional+ entitlement. Neither is the tenancy guarantor — the database
 * policies independently recheck the selected-farm authority.
 */

const HERE = "/reports/schedules";
const detailPath = (id: string) => `${HERE}/${id}`;

function revalidateSchedule(id: string): void {
  revalidatePath(HERE);
  revalidatePath(detailPath(id));
}

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function cadence(fd: FormData): Cadence {
  const raw = String(fd.get("cadence") ?? "monthly");
  return (CADENCES as readonly string[]).includes(raw) ? (raw as Cadence) : "monthly";
}

function isoDate(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Owner/manager on a Professional+ farm, or a support admin, plus the farm being acted in. */
async function gate() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${HERE}?error=no-farm`);

  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }

  if (role !== "rr_admin") {
    const plan = await getFarmPlan(farmId);
    if (!planAllows(plan, "advanced_reports")) {
      redirect(`${HERE}?error=upgrade_required`);
    }
  }

  return { profile, farmId, supabase: await createClient() };
}

export async function createReportSchedule(formData: FormData) {
  const { profile, farmId, supabase } = await gate();

  const name = s(formData, "name");
  if (!name) redirect(`${HERE}?error=need-name`);

  const key = String(formData.get("report_key") ?? "all");
  const fmt = String(formData.get("output_format") ?? "xlsx");

  const { data, error } = await supabase
    .from("report_schedules")
    .insert({
      farm_id: farmId,
      name,
      report_key: isReportKey(key) ? key : "all",
      output_format: isReportFormat(fmt) ? fmt : "xlsx",
      cadence: cadence(formData),
      // Today by default: the first report then goes out on tonight's run (covering the
      // period that has just closed) instead of a month of silence while somebody wonders
      // whether they set it up correctly.
      next_run_date: isoDate(s(formData, "next_run_date")) ?? new Date().toISOString().slice(0, 10),
      ends_on: isoDate(s(formData, "ends_on")),
      include_inactive: formData.get("include_inactive") === "on",
      site: s(formData, "site"),
      lang: String(formData.get("lang") ?? "") === "af" ? "af" : "en",
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`${HERE}?error=${encodeURIComponent(error.message)}`);

  // A schedule with nobody on it never sends (0506: no recipients = no period claimed),
  // so whoever set it up is added straight away and can be removed like anyone else.
  const { error: recipientError } = await supabase.from("report_schedule_recipients").insert({
    schedule_id: (data as { id: string }).id,
    farm_id: farmId,
    user_id: profile.id,
  });

  if (recipientError) {
    const id = (data as { id: string }).id;
    revalidateSchedule(id);
    redirect(`${detailPath(id)}?error=${encodeURIComponent(recipientError.message)}`);
  }

  revalidatePath(HERE);
  redirect(`${HERE}?created=1#s-${(data as { id: string }).id}`);
}

export async function updateReportSchedule(formData: FormData) {
  const { farmId, supabase } = await gate();
  const id = s(formData, "id");
  if (!id) redirect(`${HERE}?error=missing-id`);

  const name = s(formData, "name");
  if (!name) redirect(`${detailPath(id)}?error=need-name`);

  const key = String(formData.get("report_key") ?? "all");
  const fmt = String(formData.get("output_format") ?? "xlsx");

  const { error } = await supabase
    .from("report_schedules")
    .update({
      name,
      report_key: isReportKey(key) ? key : "all",
      output_format: isReportFormat(fmt) ? fmt : "xlsx",
      cadence: cadence(formData),
      next_run_date: isoDate(s(formData, "next_run_date")) ?? undefined,
      ends_on: isoDate(s(formData, "ends_on")),
      include_inactive: formData.get("include_inactive") === "on",
      site: s(formData, "site"),
      lang: String(formData.get("lang") ?? "") === "af" ? "af" : "en",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("farm_id", farmId);

  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);
  revalidateSchedule(id);
  redirect(`${detailPath(id)}?saved=1`);
}

/** Pause or resume. Pausing is the reversible answer to "stop emailing me this". */
export async function toggleReportSchedule(formData: FormData) {
  const { farmId, supabase } = await gate();
  const id = s(formData, "id");
  if (!id) redirect(`${HERE}?error=missing-id`);
  const active = String(formData.get("active") ?? "") === "1";

  const { error } = await supabase
    .from("report_schedules")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("farm_id", farmId);

  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);
  revalidateSchedule(id);
  redirect(`${detailPath(id)}?${active ? "resumed" : "paused"}=1`);
}

export async function deleteReportSchedule(formData: FormData) {
  const { profile, farmId, supabase } = await gate();
  const id = s(formData, "id");
  if (!id) redirect(`${HERE}?error=missing-id`);

  const { error } = await supabase
    .from("report_schedules")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id)
    .eq("farm_id", farmId);

  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(HERE);
  redirect(`${HERE}?deleted=1`);
}

export async function addReportRecipient(formData: FormData) {
  const { profile, farmId, supabase } = await gate();
  const id = s(formData, "id");
  if (!id) redirect(`${HERE}?error=missing-id`);

  const who = String(formData.get("who") ?? "user");
  // A farm user is stored as a REFERENCE and nothing else; an outside address is stored
  // because there is nowhere else to keep it. See 0506, judgement 1.
  const row: {
    schedule_id: string;
    farm_id: string;
    user_id: string | null;
    email: string | null;
    created_by: string;
  } = who === "email"
    ? { schedule_id: id, farm_id: farmId, user_id: null, email: s(formData, "email"), created_by: profile.id }
    : { schedule_id: id, farm_id: farmId, user_id: s(formData, "user_id"), email: null, created_by: profile.id };

  if (!row.user_id && !row.email) redirect(`${detailPath(id)}?error=need-recipient`);

  const { error } = await supabase.from("report_schedule_recipients").insert(row);
  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);

  revalidateSchedule(id);
  redirect(`${detailPath(id)}?added=1`);
}

export async function removeReportRecipient(formData: FormData) {
  const { profile, farmId, supabase } = await gate();
  const id = s(formData, "id");
  const recipientId = s(formData, "recipient_id");
  if (!id || !recipientId) redirect(`${HERE}?error=missing-id`);

  const { error } = await supabase
    .from("report_schedule_recipients")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", recipientId)
    .eq("schedule_id", id)
    .eq("farm_id", farmId);

  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);
  revalidateSchedule(id);
  redirect(`${detailPath(id)}?removed=1`);
}

/**
 * "Send the due one now."
 *
 * Goes through the SAME engine the cron uses (`public.run_report_schedule` → ownership
 * check → `app.run_due_report_schedules`), which is what makes it safe: a period already
 * sent is claimed by nobody and the button honestly reports that nothing was due, rather
 * than putting a second copy of August in an accountant's inbox.
 *
 * The build and the send then run under the CALLER'S RLS client, so this path never
 * touches the service role at all.
 */
export async function sendReportScheduleNow(formData: FormData) {
  const { farmId, supabase } = await gate();
  const id = s(formData, "id");
  if (!id) redirect(`${HERE}?error=missing-id`);

  // Bind the submitted id to the farm selected when the action was authorized. The RPC
  // repeats this boundary in SQL; keeping it here also prevents a hand-crafted form from
  // using a manager role in one selected farm to name a schedule in another membership.
  const { data: schedule, error: lookupError } = await supabase
    .from("report_schedules")
    .select("id")
    .eq("id", id)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupError) redirect(`${detailPath(id)}?error=${encodeURIComponent(lookupError.message)}`);
  if (!schedule) redirect(`${HERE}?error=schedule-not-found`);

  const { data, error } = await supabase.rpc("run_report_schedule", { p_id: id });
  if (error) redirect(`${detailPath(id)}?error=${encodeURIComponent(error.message)}`);

  const runs = (data ?? []) as ClaimedRun[];
  if (runs.length === 0) {
    revalidateSchedule(id);
    redirect(`${detailPath(id)}?nothing=1`);
  }

  let sent = 0;
  let failed = 0;
  for (const run of runs) {
    const r = await deliverReportRun(supabase, run);
    sent += r.sent;
    failed += r.failed;
  }

  revalidateSchedule(id);
  redirect(`${detailPath(id)}?sent=${sent}&failed=${failed}`);
}
