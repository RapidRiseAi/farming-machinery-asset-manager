"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

function numOrNull(fd: FormData, k: string): number | null {
  const v = String(fd.get(k) ?? "").trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/** Add `months` to an ISO date (yyyy-mm-dd), returning ISO. */
function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Derive next-due reading/date from last-done + interval. The nightly engine
 *  trues up the ok/due/overdue status; we insert a sensible starting point. */
function nextDue(opts: {
  interval_hours: number | null;
  interval_months: number | null;
  last_done_reading: number | null;
  last_done_date: string | null;
}) {
  const next_due_reading =
    opts.interval_hours != null && opts.last_done_reading != null
      ? opts.last_done_reading + opts.interval_hours
      : null;
  const next_due_date =
    opts.interval_months != null && opts.last_done_date != null
      ? addMonths(opts.last_done_date, opts.interval_months)
      : null;
  return { next_due_reading, next_due_date };
}

export async function addServiceLine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const task = strOrNull(formData, "task");
  const interval_hours = numOrNull(formData, "interval_hours");
  const interval_months = numOrNull(formData, "interval_months");
  if (!machineId || !farmId || !task) redirect(`/machines/${machineId}?error=Task+is+required`);
  if (interval_hours == null && interval_months == null)
    redirect(`/machines/${machineId}?error=Set+an+hour+or+month+interval`);

  const last_done_reading = numOrNull(formData, "last_done_reading");
  const last_done_date = strOrNull(formData, "last_done_date");
  const due = nextDue({ interval_hours, interval_months, last_done_reading, last_done_date });

  const supabase = await createClient();
  void profile;
  const { error } = await supabase.from("service_plan_lines").insert({
    farm_id: farmId,
    machine_id: machineId,
    task,
    interval_hours,
    interval_months,
    last_done_reading,
    last_done_date,
    ...due,
    status: "ok",
  });
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=service`);
}

export async function updateServiceLine(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const task = strOrNull(formData, "task");
  const interval_hours = numOrNull(formData, "interval_hours");
  const interval_months = numOrNull(formData, "interval_months");
  if (!id || !task) redirect(`/machines/${machineId}?error=Task+is+required`);

  const last_done_reading = numOrNull(formData, "last_done_reading");
  const last_done_date = strOrNull(formData, "last_done_date");
  const due = nextDue({ interval_hours, interval_months, last_done_reading, last_done_date });

  const supabase = await createClient();
  const { error } = await supabase
    .from("service_plan_lines")
    .update({ task, interval_hours, interval_months, last_done_reading, last_done_date, ...due })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=service`);
}

export async function deleteServiceLine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_plan_lines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=service`);
}

type TemplateLine = { task: string; interval_hours?: number | null; interval_months?: number | null };

/** Apply a service template: insert one plan line per template line, seeding
 *  last-done at the machine's current reading / today. */
export async function applyTemplate(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const templateId = String(formData.get("template_id") ?? "");
  if (!machineId || !farmId || !templateId) redirect(`/machines/${machineId}?error=Pick+a+template`);

  const supabase = await createClient();
  const [{ data: tpl }, { data: mach }] = await Promise.all([
    supabase.from("service_templates").select("lines").eq("id", templateId).maybeSingle(),
    supabase.from("machines").select("current_reading").eq("id", machineId).maybeSingle(),
  ]);
  const lines = ((tpl as { lines: TemplateLine[] } | null)?.lines ?? []) as TemplateLine[];
  if (lines.length === 0) redirect(`/machines/${machineId}?error=Template+has+no+lines`);

  const today = new Date().toISOString().slice(0, 10);
  const currentReading = (mach as { current_reading: number | null } | null)?.current_reading ?? null;

  const rows = lines.map((l) => {
    const interval_hours = l.interval_hours ?? null;
    const interval_months = l.interval_months ?? null;
    const last_done_reading = interval_hours != null ? currentReading : null;
    const last_done_date = interval_months != null ? today : null;
    const due = nextDue({ interval_hours, interval_months, last_done_reading, last_done_date });
    return {
      farm_id: farmId,
      machine_id: machineId,
      task: l.task,
      interval_hours,
      interval_months,
      last_done_reading,
      last_done_date,
      ...due,
      status: "ok",
    };
  });

  const { error } = await supabase.from("service_plan_lines").insert(rows);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=template`);
}
