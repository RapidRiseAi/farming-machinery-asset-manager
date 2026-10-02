"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFarmRole, requireProfile } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { exVatCents } from "@/lib/money";
import { JOB_TYPES } from "@/lib/job-options";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { todayInSouthAfrica } from "@/lib/assistant/date";
import { canEditJobWork, canChangeJobStatus, jobCardPatch, needsJobMeter, parseJobLine, type JobWork } from "@/lib/jobcard-workflow";

// Who may work job cards (Scope §2): internal mechanic, manager, owner, external workshop.
const CREW: Role[] = ["rr_admin", "owner", "manager", "mechanic", "workshop"];

type JobContextRow = JobWork & {
  farm_id: string; machine_id: string; type: string; updated_at: string;
  meter_reading: number | null; work_performed: string | null; date_in: string | null;
  date_out: string | null; vat_rate_bps: number;
};

function fail(id: string, code: string): never {
  redirect(`/jobcards/${id}?error=${encodeURIComponent(code)}`);
}

function refreshJob(id: string, machineId: string) {
  for (const path of [`/jobcards/${id}`, "/jobcards", `/machines/${machineId}`, "/work", "/inbox", "/contractor", "/dashboard"]) revalidatePath(path);
}

async function jobCardContext(id: string, roles: readonly Role[] = CREW, edit = true) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_cards")
    .select("farm_id, machine_id, type, status, locked, work_mode, workshop_id, updated_at, meter_reading, work_performed, date_in, date_out, vat_rate_bps")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) fail(id, "save-failed");
  const row = data as JobContextRow | null;
  if (!row) redirect("/jobcards?error=not-found");
  const auth = await requireFarmRole(
    row.farm_id,
    roles,
    `/jobcards/${id}?error=forbidden`,
    profile,
  );
  if (edit && !canEditJobWork(row, auth.role, profile.workshop_id)) fail(id, "job-not-editable");
  return { ...auth, machineId: row.machine_id, supabase, job: row };
}

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
export async function createJobCard(formData: FormData) {
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const typeRaw = String(formData.get("type") ?? "repair");
  const type = (JOB_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : "repair";
  const faultId = s(formData, "fault_id");
  const capture = s(formData, "intake_capture") ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(capture)) redirect("/jobcards?error=save-failed");
  if (!machineId || !farmId) redirect("/machines?error=Missing+machine");

  const profile = await requireProfile();
  const { role } = await requireFarmRole(
    farmId,
    CREW,
    `/machines/${machineId}?error=forbidden`,
    profile,
  );
  const workMode = role === "workshop" ? "external" : s(formData, "work_mode") ?? "internal";
  const providerName = s(formData, "external_provider_name");
  if (!["internal", "external"].includes(workMode)) redirect("/jobcards?error=job-work-mode");
  if (workMode === "external" && role !== "workshop") {
    if (!["owner", "manager", "rr_admin"].includes(role)) redirect("/jobcards?error=forbidden");
    if (!providerName) redirect("/jobcards?error=job-provider-required");
  }
  const supabase = await createClient();
  const { data: machine } = await supabase
    .from("machines")
    .select("id")
    .eq("id", machineId)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!machine) redirect("/machines?error=not-found");
  if (faultId) {
    const { data: fault } = await supabase
      .from("faults")
      .select("id")
      .eq("id", faultId)
      .eq("farm_id", farmId)
      .eq("machine_id", machineId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!fault) redirect(`/machines/${machineId}?error=not-found`);
    // The receipt RPC acknowledges an already-created card before its source-fault
    // guard runs. A lost response can therefore be retried after the fault is linked.
  }
  // Snapshot the farm's current VAT rate onto the card (money is stored ex-VAT).
  const { data: farm } = await supabase.from("farms").select("settings").eq("id", farmId).maybeSingle();
  const settings = (farm?.settings ?? {}) as Record<string, unknown>;
  const vatRateBps = typeof settings.vat_rate_bps === "number" ? (settings.vat_rate_bps as number) : 1500;

  const { data, error } = await supabase.rpc("create_job_card_intake", {
    p_capture: capture,
    p_job: {
      farm_id: farmId,
      machine_id: machineId,
      type,
      status: "open",
      work_mode: workMode,
      external_provider_name: workMode === "external" && role !== "workshop" ? providerName : null,
      reported_problem: s(formData, "reported_problem"),
      created_from_fault_id: faultId,
      mechanic_user_id: role === "mechanic" || role === "workshop" ? profile.id : null,
      workshop_id: role === "workshop" ? profile.workshop_id : null,
      vat_rate_bps: vatRateBps,
      date_in: todayInSouthAfrica(),
    },
  });
  if (error || typeof data !== "string") redirect(`/jobcards?error=${encodeURIComponent(error?.message ?? "save-failed")}`);

  // Linking the source fault is performed atomically by the database trigger. Keeping
  // the side effect in the same transaction prevents a card from being created while
  // its fault remains open after a transient second request fails.
  refreshJob(data, machineId);
  if (faultId) revalidatePath("/faults");
  redirect(`/jobcards/${data}?intake_token=${capture}`);
}

export async function saveJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards");
  const { farmId, machineId, supabase, job } = await jobCardContext(id);
  let patch: ReturnType<typeof jobCardPatch>;
  try { patch = jobCardPatch(formData); }
  catch (error) { fail(id, error instanceof Error ? error.message : "save-failed"); }
  if (!Object.keys(patch).length) fail(id, "job-no-changes");
  const dateIn = formData.has("date_in") ? patch.date_in : job.date_in;
  const dateOut = formData.has("date_out") ? patch.date_out : job.date_out;
  if (dateIn && dateOut && String(dateOut) < String(dateIn)) fail(id, "job-invalid-date");
  if (dateOut && String(dateOut) > todayInSouthAfrica()) fail(id, "job-invalid-date");
  const { data, error } = await supabase
    .from("job_cards")
    .update(patch)
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("updated_at", s(formData, "updated_at") ?? job.updated_at)
    .select("id").maybeSingle();
  if (error) fail(id, "save-failed");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=1`);
}

export async function addLine(formData: FormData) {
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const postedFarmId = String(formData.get("farm_id") ?? "");
  if (!jobCardId || !postedFarmId) redirect(`/jobcards/${jobCardId}?error=Missing+ids`);

  const { farmId, machineId, supabase, job } = await jobCardContext(jobCardId, CREW, false);
  if (postedFarmId !== farmId) redirect(`/jobcards/${jobCardId}?error=wrong-farm`);

  // Money is stored ex-VAT (Scope §6). If the user entered VAT-inclusive prices,
  // convert to ex-VAT using the card's own VAT rate (authoritative, from the DB).
  const inclVat = String(formData.get("incl_vat") ?? "") === "1";
  let line: ReturnType<typeof parseJobLine>;
  try { line = parseJobLine(formData); }
  catch (error) { fail(jobCardId, error instanceof Error ? error.message : "job-invalid-line"); }
  if (inclVat) {
    if (line.unit_cost_cents != null) line.unit_cost_cents = exVatCents(line.unit_cost_cents, job.vat_rate_bps);
    if (line.rate_cents != null) line.rate_cents = exVatCents(line.rate_cents, job.vat_rate_bps);
  }

  const draftToken = s(formData, "draft_token");
  if (!draftToken || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftToken)) fail(jobCardId, "job-invalid-line");
  const { error } = await supabase.rpc("record_job_card_line", { p_job: jobCardId, p_capture: draftToken, p_line: line });
  if (error) fail(jobCardId, "save-failed");
  refreshJob(jobCardId, machineId);
  const acknowledgement = draftToken && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftToken) ? `&line_token=${draftToken}` : "";
  redirect(`/jobcards/${jobCardId}?saved=line${acknowledgement}`);
}

/** Correct a line in place while preserving prices hidden from this worker. */
export async function editJobLine(formData: FormData) {
  const jobCardId = s(formData, "job_card_id") ?? "";
  const lineId = s(formData, "line_id") ?? "";
  const version = s(formData, "line_updated_at");
  const { farmId, machineId, supabase, job } = await jobCardContext(jobCardId);
  if (!lineId || !version) fail(jobCardId, "job-invalid-line");
  let line: ReturnType<typeof parseJobLine>;
  try { line = parseJobLine(formData); }
  catch (error) { fail(jobCardId, error instanceof Error ? error.message : "job-invalid-line"); }
  const patch: Record<string, unknown> = { description: line.description, part_no: line.part_no, qty: line.qty, hours: line.hours };
  if (await canViewFarmCosts(supabase, farmId)) {
    const inclusive = s(formData, "incl_vat") === "1";
    patch.unit_cost_cents = inclusive && line.unit_cost_cents != null ? exVatCents(line.unit_cost_cents, job.vat_rate_bps) : line.unit_cost_cents;
    patch.rate_cents = inclusive && line.rate_cents != null ? exVatCents(line.rate_cents, job.vat_rate_bps) : line.rate_cents;
  }
  const { data, error } = await supabase.from("job_card_lines").update(patch)
    .eq("id", lineId).eq("job_card_id", jobCardId).eq("farm_id", farmId)
    .eq("kind", line.kind).eq("updated_at", version).is("deleted_at", null).select("id").maybeSingle();
  if (error) fail(jobCardId, "save-failed");
  if (!data) fail(jobCardId, "job-changed");
  refreshJob(jobCardId, machineId);
  redirect(`/jobcards/${jobCardId}?saved=line&line_token=${encodeURIComponent(s(formData, "draft_token") ?? "")}`);
}

export async function removeLine(formData: FormData) {
  const id = String(formData.get("line_id") ?? "");
  const jobCardId = String(formData.get("job_card_id") ?? "");
  if (!id || !jobCardId) redirect(`/jobcards/${jobCardId}?error=missing-ids`);
  const { machineId, supabase } = await jobCardContext(jobCardId);
  const { error, data } = await supabase.rpc("remove_job_card_line", {
    p_job: jobCardId, p_line: id, p_version: s(formData, "line_updated_at"),
  });
  if (error) fail(jobCardId, "save-failed");
  if (!data) fail(jobCardId, "job-changed");
  refreshJob(jobCardId, machineId);
  redirect(`/jobcards/${jobCardId}?saved=line`);
}

export async function completeJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards?error=missing-id");
  const { farmId, machineId, supabase, job } = await jobCardContext(id);
  if (!job.work_performed?.trim()) fail(id, "job-work-required");
  if (job.status !== "in_progress") fail(id, "job-invalid-transition");
  const { data: machine } = await supabase.from("machines").select("meter_type,current_reading,current_reading_date").eq("id", machineId).single();
  if (!machine) fail(id, "not-found");
  if (needsJobMeter(job.type, machine.meter_type) && job.meter_reading == null) fail(id, "job-meter-required");
  if (job.meter_reading != null && machine.current_reading != null && machine.current_reading_date
    && (job.date_out ?? todayInSouthAfrica()) >= machine.current_reading_date
    && job.meter_reading < machine.current_reading) fail(id, "job-meter-decreased");
  const { data, error } = await supabase
    .from("job_cards")
    .update({
      status: "completed",
      date_out: job.date_out ?? todayInSouthAfrica(),
    })
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("updated_at", s(formData, "updated_at") ?? job.updated_at)
    .eq("status", "in_progress")
    .select("id").maybeSingle();
  if (error) fail(id, "save-failed");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=completed`);
}

/** Owner/manager approval, locks the card (money/history tamper-evident). */
export async function approveJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards?error=missing-id");
  const { profile, farmId, machineId, supabase, job } = await jobCardContext(id, ["owner", "manager"], false);
  if (job.status !== "completed" || job.locked) fail(id, "job-invalid-transition");
  const { data, error } = await supabase
    .from("job_cards")
    .update({
      status: "approved",
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
      locked: true,
    })
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("updated_at", s(formData, "updated_at") ?? job.updated_at)
    .eq("status", "completed")
    .select("id").maybeSingle();
  if (error) fail(id, "save-failed");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=approved`);
}

export async function changeJobCardStatus(formData: FormData) {
  const id = s(formData, "id");
  if (!id) redirect("/jobcards?error=missing-id");
  const { farmId, machineId, job, supabase } = await jobCardContext(id);
  const status = s(formData, "status") ?? "";
  if (!canChangeJobStatus(job.status, status)) fail(id, "job-invalid-transition");
  const { data, error } = await supabase.from("job_cards").update({ status })
    .eq("id", id).eq("farm_id", farmId).eq("status", job.status)
    .eq("updated_at", s(formData, "updated_at") ?? job.updated_at).select("id").maybeSingle();
  if (error) fail(id, "save-failed");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=1`);
}

export async function returnJobCard(formData: FormData) {
  const id = s(formData, "id");
  if (!id) redirect("/jobcards?error=missing-id");
  const { farmId, machineId, job, supabase } = await jobCardContext(id, ["owner", "manager"], false);
  const reason = s(formData, "reason");
  if (!reason || reason.length < 3) fail(id, "job-return-reason");
  if (job.status !== "completed" || job.locked) fail(id, "job-invalid-transition");
  const { data, error } = await supabase.from("job_cards").update({ status: "in_progress", review_note: reason })
    .eq("id", id).eq("farm_id", farmId).eq("status", "completed")
    .eq("updated_at", s(formData, "updated_at") ?? job.updated_at).select("id").maybeSingle();
  if (error) fail(id, "save-failed");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=returned`);
}

export async function assignJobWorker(formData: FormData) {
  const id = s(formData, "id") ?? "";
  const { farmId, machineId, job, supabase } = await jobCardContext(id, ["owner", "manager"]);
  if (job.work_mode !== "internal") fail(id, "forbidden");
  const { data, error } = await supabase.from("job_cards").update({ mechanic_user_id: s(formData, "mechanic_user_id") })
    .eq("id", id).eq("farm_id", farmId).eq("updated_at", s(formData, "updated_at") ?? job.updated_at).select("id").maybeSingle();
  if (error) fail(id, "job-assignee-invalid");
  if (!data) fail(id, "job-changed");
  refreshJob(id, machineId);
  redirect(`/jobcards/${id}?saved=1`);
}

/**
 * Apply a machine's service kit (F9) to a job card: append one part line per kit item.
 * The kit items store ex-VAT unit costs, so the lines are inserted ex-VAT directly (no
 * VAT conversion). Each new line flows to cost_entries/TCO + history via the existing
 * 0211 job_card_lines trigger, the ONLY kit→cost path, so there is no double-count.
 */
export async function applyServiceKit(formData: FormData) {
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const postedFarmId = String(formData.get("farm_id") ?? "");
  const kitId = String(formData.get("service_kit_id") ?? "");
  if (!jobCardId || !postedFarmId || !kitId) redirect(`/jobcards/${jobCardId}?error=Pick+a+kit`);

  const { farmId, machineId, supabase } = await jobCardContext(jobCardId);
  if (postedFarmId !== farmId) redirect(`/jobcards/${jobCardId}?error=wrong-farm`);
  const capture = s(formData, "capture_id");
  if (!capture) fail(jobCardId, "job-invalid-line");
  const { error } = await supabase.rpc("apply_job_card_kit", { p_job: jobCardId, p_kit: kitId, p_capture: capture });
  if (error) fail(jobCardId, "save-failed");
  refreshJob(jobCardId, machineId);
  redirect(`/jobcards/${jobCardId}?saved=line&kit_token=${encodeURIComponent(capture)}`);
}

/** Toggle whether this (scheduled-service) job covers a given service-plan line. */
export async function toggleServiceLine(formData: FormData) {
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const postedFarmId = String(formData.get("farm_id") ?? "");
  const lineId = String(formData.get("service_plan_line_id") ?? "");
  const on = String(formData.get("on") ?? "") === "1";
  if (!jobCardId || !postedFarmId || !lineId) {
    redirect(`/jobcards/${jobCardId}?error=missing-ids`);
  }
  const { farmId, machineId, supabase, job } = await jobCardContext(jobCardId);
  if (job.type !== "scheduled_service") fail(jobCardId, "job-invalid-transition");
  if (postedFarmId !== farmId) redirect(`/jobcards/${jobCardId}?error=wrong-farm`);
  const { data: serviceLine } = await supabase
    .from("service_plan_lines")
    .select("id")
    .eq("id", lineId)
    .eq("farm_id", farmId)
    .eq("machine_id", machineId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!serviceLine) redirect(`/jobcards/${jobCardId}?error=not-found`);
  if (on) {
    const { error } = await supabase
      .from("job_card_service_lines")
      .upsert({
        job_card_id: jobCardId,
        service_plan_line_id: lineId,
        farm_id: farmId,
        machine_id: machineId,
      }, { onConflict: "job_card_id,service_plan_line_id", ignoreDuplicates: true });
    if (error) redirect(`/jobcards/${jobCardId}?error=save-failed`);
  } else {
    const { error } = await supabase
      .from("job_card_service_lines")
      .delete()
      .eq("job_card_id", jobCardId)
      .eq("service_plan_line_id", lineId)
      .eq("farm_id", farmId)
      .eq("machine_id", machineId);
    if (error) redirect(`/jobcards/${jobCardId}?error=save-failed`);
  }
  refreshJob(jobCardId, machineId);
  redirect(`/jobcards/${jobCardId}?saved=service`);
}
