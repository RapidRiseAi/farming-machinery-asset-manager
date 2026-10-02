"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProfile, requireFarmRole, type Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { isWorkKind, isWorkStatus, isWorkPriority } from "@/lib/work";
import { canConvertWorkRequest, canRecordWorkAmount, workTransitions } from "@/lib/work-lifecycle";
import { JOB_TYPES } from "@/lib/job-options";

const INITIATORS: Role[] = ["owner", "manager"];
const CREW: Role[] = [...INITIATORS, "mechanic", "workshop"];
function s(fd: FormData, k: string): string | null {
  return String(fd.get(k) ?? "").trim() || null;
}

type WorkRow = {
  id: string; farm_id: string; machine_id: string; workshop_id: string | null;
  status: string; vat_rate_bps: number | null; job_card_id: string | null;
};

async function requestContext(id: string, roles: Role[] = CREW) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data, error } = await supabase.from("work_requests")
    .select("id, farm_id, machine_id, workshop_id, status, vat_rate_bps, job_card_id")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  const row = data as WorkRow | null;
  if (error || !row) redirect("/work?error=not-found");
  const { role } = await requireFarmRole(row.farm_id, roles, `/work/${id}?error=forbidden`, profile);
  if (role === "workshop" && (!row.workshop_id || profile.workshop_id !== row.workshop_id)) {
    redirect(`/work/${id}?error=forbidden`);
  }
  return { supabase, row, profile, role };
}

function refreshRequest(id: string, jobId?: string | null) {
  revalidatePath(`/work/${id}`);
  revalidatePath("/work");
  revalidatePath("/inbox");
  revalidatePath("/contractor");
  if (jobId) revalidatePath(`/jobcards/${jobId}`);
}

export async function createWorkRequest(formData: FormData) {
  const profile = await requireProfile();
  const machineId = s(formData, "machine_id");
  const farmId = s(formData, "farm_id");
  const capture = s(formData, "intake_capture") ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(capture)) redirect("/jobcards?error=save-failed");
  if (!machineId || !farmId) redirect("/machines?error=missing-machine");
  await requireFarmRole(farmId, INITIATORS, `/machines/${machineId}?error=forbidden`, profile);
  const workshopId = s(formData, "workshop_id");
  if (!workshopId) redirect(`/machines/${machineId}?error=need-recipient`);
  const supabase = await createClient();
  const [{ data: machine }, { data: link }, { data: farm }] = await Promise.all([
    supabase.from("machines").select("id").eq("id", machineId).eq("farm_id", farmId).is("deleted_at", null).maybeSingle(),
    supabase.from("workshop_links").select("id").eq("farm_id", farmId).eq("workshop_id", workshopId).eq("status", "active").is("deleted_at", null).maybeSingle(),
    supabase.from("farms").select("settings").eq("id", farmId).maybeSingle(),
  ]);
  if (!machine || !link) redirect(`/machines/${machineId}?error=forbidden`);
  const settings = (farm as { settings?: { vat_rate_bps?: number } } | null)?.settings;
  const kindRaw = s(formData, "kind") ?? "repair";
  const jobType = s(formData, "job_type") ?? (kindRaw === "inspection" ? "inspection" : "repair");
  if (!(JOB_TYPES as readonly string[]).includes(jobType)) redirect(`/machines/${machineId}?error=bad-status`);
  const priorityRaw = s(formData, "priority") ?? "normal";
  const { data, error } = await supabase.rpc("create_work_request_intake", { p_capture: capture, p_request: {
    farm_id: farmId, machine_id: machineId, workshop_id: workshopId,
    kind: isWorkKind(kindRaw) ? kindRaw : "repair",
    job_card_type: jobType,
    priority: isWorkPriority(priorityRaw) ? priorityRaw : "normal",
    status: "requested", title: s(formData, "title"), description: s(formData, "description"),
    created_from_fault_id: s(formData, "fault_id"),
    vat_rate_bps: settings?.vat_rate_bps ?? 1500, created_by: profile.id,
  } });
  if (error || typeof data !== "string") redirect(`/machines/${machineId}?error=${encodeURIComponent(error?.message ?? "save-failed")}`);
  refreshRequest(data);
  revalidatePath(`/machines/${machineId}`);
  if (s(formData, "fault_id")) revalidatePath("/faults");
  redirect(`/work/${data}?intake_token=${capture}`);
}

export async function assignWorkRequestProvider(formData: FormData) {
  const id = s(formData, "id") ?? "";
  const { supabase, row } = await requestContext(id, ["owner", "manager"]);
  const workshopId = s(formData, "workshop_id");
  if (row.workshop_id || row.status !== "requested" || !workshopId) redirect(`/work/${id}?error=bad-status`);
  const { data: link } = await supabase.from("workshop_links").select("id")
    .eq("farm_id", row.farm_id).eq("workshop_id", workshopId).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (!link) redirect(`/work/${id}?error=forbidden`);
  const { data, error } = await supabase.from("work_requests").update({ workshop_id: workshopId })
    .eq("id", id).eq("status", "requested").is("workshop_id", null).select("id").maybeSingle();
  if (error || !data) redirect(`/work/${id}?error=${encodeURIComponent(error?.message ?? "work-changed")}`);
  refreshRequest(id);
  redirect(`/work/${id}?saved=1`);
}

export async function updateWorkRequestStatus(formData: FormData) {
  const id = s(formData, "id") ?? "";
  const status = s(formData, "status") ?? "";
  const { supabase, row, role } = await requestContext(id);
  if (!isWorkStatus(status) || !workTransitions(row.status, role, !!row.workshop_id).includes(status)) {
    redirect(`/work/${id}?error=work-transition`);
  }
  if (status === "accepted") {
    const { data: quotes, error } = await supabase.from("partner_documents").select("id")
      .eq("work_request_id", id).eq("kind", "quote").eq("status", "sent").is("deleted_at", null).limit(1);
    if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);
    if (quotes?.[0]) redirect(`/documents/${quotes[0].id}`);
  }
  const { error } = await supabase.rpc("update_work_request", {
    p_request: id, p_status: status, p_note: s(formData, "note"),
  });
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);
  refreshRequest(id, row.job_card_id);
  redirect(`/work/${id}?saved=1`);
}

export async function addWorkRequestNote(formData: FormData) {
  const id = s(formData, "id") ?? "";
  const { supabase, row, profile } = await requestContext(id);
  const note = s(formData, "note");
  if (!note) redirect(`/work/${id}?error=empty-note`);
  if (row.status === "closed") redirect(`/work/${id}?error=locked`);
  const { error } = await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id, from_status: row.status,
    to_status: row.status, note, by_user: profile.id,
  });
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);
  refreshRequest(id);
  redirect(`/work/${id}?saved=note`);
}

async function recordAmount(formData: FormData, kind: "quote" | "invoice") {
  const id = s(formData, "id") ?? "";
  const { supabase, row, role } = await requestContext(id, ["workshop"]);
  if (!canRecordWorkAmount(kind, row.status, role, !!row.workshop_id)) redirect(`/work/${id}?error=work-transition`);
  // A document is the accounting source when present; don't book the same amount twice.
  const { data: documents, error: documentError } = await supabase.from("partner_documents")
    .select("id").eq("work_request_id", id).eq("kind", kind).neq("status", "void").is("deleted_at", null).limit(1);
  if (documentError) redirect(`/work/${id}?error=${encodeURIComponent(documentError.message)}`);
  if (documents?.length) redirect(`/work/${id}?error=work-use-document`);
  const cents = parseRandsToCents(s(formData, "amount") ?? "");
  if (cents == null || cents < 0 || (kind === "quote" && cents === 0)) redirect(`/work/${id}?error=need-amount`);
  const amount = formData.get("incl_vat") === "1" ? exVatCents(cents, row.vat_rate_bps ?? 1500) : cents;
  const { error } = await supabase.rpc("update_work_request", {
    p_request: id, [kind === "quote" ? "p_quote_cents" : "p_invoice_cents"]: amount,
    p_note: s(formData, "note"),
  });
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);
  refreshRequest(id, row.job_card_id);
  redirect(`/work/${id}?saved=${kind}`);
}

export async function setWorkRequestQuote(formData: FormData) { await recordAmount(formData, "quote"); }
export async function setWorkRequestInvoice(formData: FormData) { await recordAmount(formData, "invoice"); }

export async function convertToJobCard(formData: FormData) {
  const id = s(formData, "id") ?? "";
  const { supabase, row, role } = await requestContext(id);
  if (row.job_card_id) redirect(`/jobcards/${row.job_card_id}`);
  if (!canConvertWorkRequest(row.status, role, !!row.workshop_id)) redirect(`/work/${id}?error=work-transition`);
  const { data: jobId, error } = await supabase.rpc("convert_work_request_to_job_card", { p_request: id });
  if (error || typeof jobId !== "string") redirect(`/work/${id}?error=${encodeURIComponent(error?.message ?? "failed")}`);
  refreshRequest(id, jobId);
  revalidatePath("/jobcards");
  redirect(`/jobcards/${jobId}`);
}
