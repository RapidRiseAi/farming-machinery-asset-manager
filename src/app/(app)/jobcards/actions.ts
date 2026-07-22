"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";

// Who may work job cards (Scope §2): internal mechanic, manager, owner, external workshop.
const CREW: Role[] = ["owner", "manager", "mechanic", "workshop"];
const JOB_TYPES = ["scheduled_service", "repair", "inspection", "other"];
const JOB_STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed"];
const LINE_KINDS = ["part", "labour", "other"];

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function num(fd: FormData, k: string): number | null {
  const v = s(fd, k);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function createJobCard(formData: FormData) {
  const profile = await requireRole(CREW);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const typeRaw = String(formData.get("type") ?? "repair");
  const type = JOB_TYPES.includes(typeRaw) ? typeRaw : "repair";
  const faultId = s(formData, "fault_id");
  if (!machineId || !farmId) redirect("/machines?error=Missing+machine");

  const supabase = await createClient();
  // Snapshot the farm's current VAT rate onto the card (money is stored ex-VAT).
  const { data: farm } = await supabase.from("farms").select("settings").eq("id", farmId).maybeSingle();
  const settings = (farm?.settings ?? {}) as Record<string, unknown>;
  const vatRateBps = typeof settings.vat_rate_bps === "number" ? (settings.vat_rate_bps as number) : 1500;

  const { data, error } = await supabase
    .from("job_cards")
    .insert({
      farm_id: farmId,
      machine_id: machineId,
      type,
      status: "open",
      created_from_fault_id: faultId,
      mechanic_user_id: profile.role === "mechanic" || profile.role === "workshop" ? profile.id : null,
      workshop_id: profile.workshop_id ?? null,
      vat_rate_bps: vatRateBps,
      date_in: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/machines/${machineId}?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  if (faultId) {
    await supabase.from("faults").update({ status: "in_job", job_card_id: data.id }).eq("id", faultId);
  }
  redirect(`/jobcards/${data.id}`);
}

export async function saveJobCard(formData: FormData) {
  await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards");
  const supabase = await createClient();
  const statusRaw = String(formData.get("status") ?? "open");
  const status = JOB_STATUSES.includes(statusRaw) ? statusRaw : "open";
  const { error } = await supabase
    .from("job_cards")
    .update({
      date_in: s(formData, "date_in"),
      date_out: s(formData, "date_out"),
      reported_problem: s(formData, "reported_problem"),
      diagnosis: s(formData, "diagnosis"),
      work_performed: s(formData, "work_performed"),
      recommendations: s(formData, "recommendations"),
      meter_reading: num(formData, "meter_reading"),
      status,
    })
    .eq("id", id);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=1`);
}

export async function addLine(formData: FormData) {
  await requireRole(CREW);
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const kindRaw = String(formData.get("kind") ?? "part");
  const kind = LINE_KINDS.includes(kindRaw) ? kindRaw : "part";
  if (!jobCardId || !farmId) redirect(`/jobcards/${jobCardId}?error=Missing+ids`);

  const supabase = await createClient();

  // Money is stored ex-VAT (Scope §6). If the user entered VAT-inclusive prices,
  // convert to ex-VAT using the card's own VAT rate (authoritative, from the DB).
  const inclVat = String(formData.get("incl_vat") ?? "") === "1";
  let unitCents = kind === "labour" ? null : parseRandsToCents(String(formData.get("unit_cost") ?? ""));
  let rateCents = kind === "labour" ? parseRandsToCents(String(formData.get("rate") ?? "")) : null;
  if (inclVat) {
    const { data: jc } = await supabase.from("job_cards").select("vat_rate_bps").eq("id", jobCardId).maybeSingle();
    const bps = (jc as { vat_rate_bps: number } | null)?.vat_rate_bps ?? 1500;
    if (unitCents != null) unitCents = exVatCents(unitCents, bps);
    if (rateCents != null) rateCents = exVatCents(rateCents, bps);
  }

  const { error } = await supabase.from("job_card_lines").insert({
    farm_id: farmId,
    job_card_id: jobCardId,
    kind,
    description: s(formData, "description"),
    part_no: s(formData, "part_no"),
    qty: kind === "part" ? num(formData, "qty") : null,
    unit_cost_cents: unitCents,
    hours: kind === "labour" ? num(formData, "hours") : null,
    rate_cents: rateCents,
  });
  if (error) redirect(`/jobcards/${jobCardId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=line`);
}

export async function removeLine(formData: FormData) {
  await requireRole(CREW);
  const id = String(formData.get("line_id") ?? "");
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const supabase = await createClient();
  // soft delete — the totals trigger re-sums non-deleted lines
  await supabase
    .from("job_card_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=line`);
}

export async function completeJobCard(formData: FormData) {
  await requireRole(CREW);
  const id = String(formData.get("id") ?? "");
  const meterReading = num(formData, "meter_reading");
  const supabase = await createClient();
  // meter_reading is mandatory at service (Scope §4.4) — keep whatever's set/entered
  const { error } = await supabase
    .from("job_cards")
    .update({
      status: "completed",
      date_out: new Date().toISOString().slice(0, 10),
      ...(meterReading != null ? { meter_reading: meterReading } : {}),
    })
    .eq("id", id);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=completed`);
}

/** Owner/manager approval — locks the card (money/history tamper-evident). */
export async function approveJobCard(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase
    .from("job_cards")
    .update({
      status: "approved",
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
      locked: true,
    })
    .eq("id", id);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=approved`);
}

/** Toggle whether this (scheduled-service) job covers a given service-plan line. */
export async function toggleServiceLine(formData: FormData) {
  await requireRole(CREW);
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const lineId = String(formData.get("service_plan_line_id") ?? "");
  const on = String(formData.get("on") ?? "") === "1";
  const supabase = await createClient();
  if (on) {
    await supabase
      .from("job_card_service_lines")
      .insert({ job_card_id: jobCardId, service_plan_line_id: lineId, farm_id: farmId });
  } else {
    await supabase
      .from("job_card_service_lines")
      .delete()
      .eq("job_card_id", jobCardId)
      .eq("service_plan_line_id", lineId);
  }
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=service`);
}
