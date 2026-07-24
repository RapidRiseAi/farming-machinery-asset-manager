"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import {
  isWorkKind, isWorkStatus, isWorkPriority, workStatusStep, type WorkStatus,
} from "@/lib/work";

// Who initiates a work request (the farm side): owner/manager/mechanic.
const INITIATORS: Role[] = ["owner", "manager", "mechanic"];
// Who works a request through its lifecycle: the farm crew + the assigned contractor.
const CREW: Role[] = ["owner", "manager", "mechanic", "workshop"];

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/** Resolve the ex-VAT cents for a typed Rand amount, honouring a VAT-inclusive flag. */
function exVat(amountRands: string, inclVat: boolean, bps: number): number | null {
  const cents = parseRandsToCents(amountRands);
  if (cents == null || cents <= 0) return null;
  return inclVat ? exVatCents(cents, bps) : cents;
}

/** The farm's VAT rate (basis points), for VAT-inclusive → ex-VAT conversion. */
async function farmVatBps(supabase: Awaited<ReturnType<typeof createClient>>, farmId: string): Promise<number> {
  const { data } = await supabase.from("farms").select("settings").eq("id", farmId).maybeSingle();
  const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  return typeof settings.vat_rate_bps === "number" ? (settings.vat_rate_bps as number) : 1500;
}

// ── Create (farmer initiates from a vehicle) ─────────────────────────────────
export async function createWorkRequest(formData: FormData) {
  const profile = await requireRole(INITIATORS);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const kindRaw = String(formData.get("kind") ?? "repair");
  const kind = isWorkKind(kindRaw) ? kindRaw : "repair";
  const prioRaw = String(formData.get("priority") ?? "normal");
  const priority = isWorkPriority(prioRaw) ? prioRaw : "normal";
  const workshopId = s(formData, "workshop_id");
  if (!machineId || !farmId) redirect("/machines?error=Missing+machine");

  const supabase = await createClient();
  const vatBps = await farmVatBps(supabase, farmId);
  const { data, error } = await supabase
    .from("work_requests")
    .insert({
      farm_id: farmId,
      machine_id: machineId,
      workshop_id: workshopId,
      kind,
      priority,
      status: "requested",
      title: s(formData, "title"),
      description: s(formData, "description"),
      vat_rate_bps: vatBps,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/machines/${machineId}?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  // Opening event for the timeline.
  await supabase.from("work_request_events").insert({
    farm_id: farmId, work_request_id: data.id,
    from_status: null, to_status: "requested",
    note: s(formData, "description"), by_user: profile.id,
  });
  redirect(`/work/${data.id}`);
}

// ── Advance status (+ an event, + optional note) ─────────────────────────────
export async function updateWorkRequestStatus(formData: FormData) {
  const profile = await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  const statusRaw = String(formData.get("status") ?? "");
  if (!id || !isWorkStatus(statusRaw)) redirect(`/work/${id}?error=Bad+status`);
  const status = statusRaw as WorkStatus;

  const supabase = await createClient();
  const { data: wr } = await supabase
    .from("work_requests").select("id, farm_id, status").eq("id", id).is("deleted_at", null).maybeSingle();
  const row = wr as { id: string; farm_id: string; status: string } | null;
  if (!row) redirect("/work?error=Not+found");

  const { error } = await supabase
    .from("work_requests").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);

  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id,
    from_status: row.status, to_status: status,
    note: s(formData, "note"), by_user: profile.id,
  });
  revalidatePath(`/work/${id}`);
  redirect(`/work/${id}?saved=1`);
}

// ── Progress note (no status change) ─────────────────────────────────────────
export async function addWorkRequestNote(formData: FormData) {
  const profile = await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  const note = s(formData, "note");
  if (!id || !note) redirect(`/work/${id}?error=Empty+note`);

  const supabase = await createClient();
  const { data: wr } = await supabase
    .from("work_requests").select("farm_id, status").eq("id", id).is("deleted_at", null).maybeSingle();
  const row = wr as { farm_id: string; status: string } | null;
  if (!row) redirect("/work?error=Not+found");

  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id,
    from_status: row.status, to_status: row.status, note, by_user: profile.id,
  });
  revalidatePath(`/work/${id}`);
  redirect(`/work/${id}?saved=note`);
}

// ── Record a quote amount (recorded, NOT costed until invoiced) ──────────────
export async function setWorkRequestQuote(formData: FormData) {
  const profile = await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/work");

  const supabase = await createClient();
  const { data: wr } = await supabase
    .from("work_requests").select("farm_id, status, vat_rate_bps").eq("id", id).is("deleted_at", null).maybeSingle();
  const row = wr as { farm_id: string; status: string; vat_rate_bps: number | null } | null;
  if (!row) redirect("/work?error=Not+found");

  const bps = row.vat_rate_bps ?? (await farmVatBps(supabase, row.farm_id));
  const cents = exVat(String(formData.get("amount") ?? ""), String(formData.get("incl_vat") ?? "") === "1", bps);
  if (cents == null) redirect(`/work/${id}?error=Enter+a+quote+amount`);

  // Recording a quote naturally advances the request to "quoted" (never backwards).
  const advance = workStatusStep(row.status) < workStatusStep("quoted");
  const { error } = await supabase
    .from("work_requests")
    .update({ quote_amount_cents: cents, vat_rate_bps: bps, ...(advance ? { status: "quoted" } : {}), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);

  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id,
    from_status: row.status, to_status: advance ? "quoted" : (row.status as WorkStatus),
    note: s(formData, "note"), by_user: profile.id,
  });
  revalidatePath(`/work/${id}`);
  redirect(`/work/${id}?saved=quote`);
}

// ── Record an invoice amount → an `invoice` cost_entry (0311 trigger; no double-count) ──
export async function setWorkRequestInvoice(formData: FormData) {
  const profile = await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/work");

  const supabase = await createClient();
  const { data: wr } = await supabase
    .from("work_requests").select("farm_id, status, vat_rate_bps").eq("id", id).is("deleted_at", null).maybeSingle();
  const row = wr as { farm_id: string; status: string; vat_rate_bps: number | null } | null;
  if (!row) redirect("/work?error=Not+found");

  const bps = row.vat_rate_bps ?? (await farmVatBps(supabase, row.farm_id));
  const cents = exVat(String(formData.get("amount") ?? ""), String(formData.get("incl_vat") ?? "") === "1", bps);
  if (cents == null) redirect(`/work/${id}?error=Enter+an+invoice+amount`);

  const advance = workStatusStep(row.status) < workStatusStep("invoiced");
  const { error } = await supabase
    .from("work_requests")
    .update({ invoice_amount_cents: cents, vat_rate_bps: bps, ...(advance ? { status: "invoiced" } : {}), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) redirect(`/work/${id}?error=${encodeURIComponent(error.message)}`);

  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id,
    from_status: row.status, to_status: advance ? "invoiced" : (row.status as WorkStatus),
    note: s(formData, "note"), by_user: profile.id,
  });
  revalidatePath(`/work/${id}`);
  redirect(`/work/${id}?saved=invoice`);
}

// ── Convert a work request into a job card (keeps maintenance history unified) ──
// The job card is created empty (no lines) and back-linked, so the request's invoice
// cost (0311) is NOT duplicated by job-card lines — the operator adds lines only for
// work they actually itemise.
export async function convertToJobCard(formData: FormData) {
  const profile = await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/work");

  const supabase = await createClient();
  const { data: wr } = await supabase
    .from("work_requests")
    .select("id, farm_id, machine_id, workshop_id, kind, status, vat_rate_bps, job_card_id")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  const row = wr as {
    id: string; farm_id: string; machine_id: string; workshop_id: string | null;
    kind: string; status: string; vat_rate_bps: number | null; job_card_id: string | null;
  } | null;
  if (!row) redirect("/work?error=Not+found");
  if (row.job_card_id) redirect(`/jobcards/${row.job_card_id}`);

  const bps = row.vat_rate_bps ?? (await farmVatBps(supabase, row.farm_id));
  const jobType = row.kind === "inspection" ? "inspection" : "repair";
  const { data: jc, error } = await supabase
    .from("job_cards")
    .insert({
      farm_id: row.farm_id,
      machine_id: row.machine_id,
      type: jobType,
      status: "open",
      workshop_id: row.workshop_id,
      mechanic_user_id: profile.role === "mechanic" || profile.role === "workshop" ? profile.id : null,
      vat_rate_bps: bps,
      date_in: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();
  if (error || !jc) redirect(`/work/${id}?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  await supabase.from("work_requests").update({ job_card_id: jc.id, updated_at: new Date().toISOString() }).eq("id", id);
  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id, work_request_id: id,
    from_status: row.status, to_status: row.status as WorkStatus,
    note: "→ job card", by_user: profile.id,
  });
  redirect(`/jobcards/${jc.id}`);
}
