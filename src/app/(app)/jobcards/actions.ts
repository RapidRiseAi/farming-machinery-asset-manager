"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFarmRole, requireProfile } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { JOB_TYPES, JOB_STATUSES, LINE_KINDS } from "@/lib/job-options";
import { canViewFarmCosts } from "@/lib/cost-visibility";

// Who may work job cards (Scope §2): internal mechanic, manager, owner, external workshop.
const CREW: Role[] = ["rr_admin", "owner", "manager", "mechanic", "workshop"];

async function jobCardContext(id: string, roles: readonly Role[] = CREW) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data } = await supabase
    .from("job_cards")
    .select("farm_id, machine_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as { farm_id: string; machine_id: string } | null;
  if (!row) redirect("/jobcards?error=not-found");
  const auth = await requireFarmRole(
    row.farm_id,
    roles,
    `/jobcards/${id}?error=forbidden`,
    profile,
  );
  return { ...auth, machineId: row.machine_id, supabase };
}

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
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const typeRaw = String(formData.get("type") ?? "repair");
  const type = (JOB_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : "repair";
  const faultId = s(formData, "fault_id");
  if (!machineId || !farmId) redirect("/machines?error=Missing+machine");

  const profile = await requireProfile();
  const { role } = await requireFarmRole(
    farmId,
    CREW,
    `/machines/${machineId}?error=forbidden`,
    profile,
  );
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
      .select("id, job_card_id")
      .eq("id", faultId)
      .eq("farm_id", farmId)
      .eq("machine_id", machineId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!fault) redirect(`/machines/${machineId}?error=not-found`);
    if ((fault as { job_card_id: string | null }).job_card_id) {
      redirect(`/machines/${machineId}?error=already-linked`);
    }
  }
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
      mechanic_user_id: role === "mechanic" || role === "workshop" ? profile.id : null,
      workshop_id: profile.workshop_id ?? null,
      vat_rate_bps: vatRateBps,
      date_in: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/machines/${machineId}?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  // Linking the source fault is performed atomically by the database trigger. Keeping
  // the side effect in the same transaction prevents a card from being created while
  // its fault remains open after a transient second request fails.
  redirect(`/jobcards/${data.id}`);
}

export async function saveJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards");
  const { farmId, supabase } = await jobCardContext(id);
  const statusRaw = String(formData.get("status") ?? "open");
  const status = (JOB_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : "open";
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
    .eq("id", id)
    .eq("farm_id", farmId);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=1`);
}

export async function addLine(formData: FormData) {
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const postedFarmId = String(formData.get("farm_id") ?? "");
  const kindRaw = String(formData.get("kind") ?? "part");
  const kind = (LINE_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : "part";
  if (!jobCardId || !postedFarmId) redirect(`/jobcards/${jobCardId}?error=Missing+ids`);

  const { farmId, supabase } = await jobCardContext(jobCardId);
  if (postedFarmId !== farmId) redirect(`/jobcards/${jobCardId}?error=wrong-farm`);

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
  const id = String(formData.get("line_id") ?? "");
  const jobCardId = String(formData.get("job_card_id") ?? "");
  if (!id || !jobCardId) redirect(`/jobcards/${jobCardId}?error=missing-ids`);
  const { farmId, supabase } = await jobCardContext(jobCardId);
  // soft delete — the totals trigger re-sums non-deleted lines
  await supabase
    .from("job_card_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("job_card_id", jobCardId)
    .eq("farm_id", farmId);
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=line`);
}

export async function completeJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards?error=missing-id");
  const meterReading = num(formData, "meter_reading");
  const { farmId, supabase } = await jobCardContext(id);
  // meter_reading is mandatory at service (Scope §4.4) — keep whatever's set/entered
  const { error } = await supabase
    .from("job_cards")
    .update({
      status: "completed",
      date_out: new Date().toISOString().slice(0, 10),
      ...(meterReading != null ? { meter_reading: meterReading } : {}),
    })
    .eq("id", id)
    .eq("farm_id", farmId);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=completed`);
}

/** Owner/manager approval — locks the card (money/history tamper-evident). */
export async function approveJobCard(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/jobcards?error=missing-id");
  const { profile, farmId, supabase } = await jobCardContext(id, ["owner", "manager"]);
  const { error } = await supabase
    .from("job_cards")
    .update({
      status: "approved",
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
      locked: true,
    })
    .eq("id", id)
    .eq("farm_id", farmId);
  if (error) redirect(`/jobcards/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${id}`);
  redirect(`/jobcards/${id}?saved=approved`);
}

/**
 * Apply a machine's service kit (F9) to a job card: append one part line per kit item.
 * The kit items store ex-VAT unit costs, so the lines are inserted ex-VAT directly (no
 * VAT conversion). Each new line flows to cost_entries/TCO + history via the existing
 * 0211 job_card_lines trigger — the ONLY kit→cost path, so there is no double-count.
 */
export async function applyServiceKit(formData: FormData) {
  const jobCardId = String(formData.get("job_card_id") ?? "");
  const postedFarmId = String(formData.get("farm_id") ?? "");
  const kitId = String(formData.get("service_kit_id") ?? "");
  if (!jobCardId || !postedFarmId || !kitId) redirect(`/jobcards/${jobCardId}?error=Pick+a+kit`);

  const { farmId, supabase } = await jobCardContext(jobCardId);
  if (postedFarmId !== farmId) redirect(`/jobcards/${jobCardId}?error=wrong-farm`);
  // Masked prices are not zero-priced parts. Only a cost-authorized person may
  // copy a priced kit; operational crew can still enter their own work lines.
  if (!(await canViewFarmCosts(supabase, farmId))) redirect(`/jobcards/${jobCardId}?error=forbidden`);
  const { data: itemData } = await supabase
    .from("service_kit_items_visible")
    .select("part_no, description, qty, unit_cost_cents")
    .eq("service_kit_id", kitId)
    .eq("farm_id", farmId)
    .is("deleted_at", null);
  const items = (itemData as { part_no: string | null; description: string | null; qty: number | null; unit_cost_cents: number | null }[] | null) ?? [];
  if (items.length === 0) redirect(`/jobcards/${jobCardId}?error=Kit+has+no+items`);

  const rows = items.map((i) => ({
    farm_id: farmId,
    job_card_id: jobCardId,
    kind: "part",
    description: i.description,
    part_no: i.part_no,
    qty: i.qty ?? 1,
    unit_cost_cents: i.unit_cost_cents, // already ex-VAT
  }));
  const { error } = await supabase.from("job_card_lines").insert(rows);
  if (error) redirect(`/jobcards/${jobCardId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=line`);
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
  const { farmId, machineId, supabase } = await jobCardContext(jobCardId);
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
      .insert({
        job_card_id: jobCardId,
        service_plan_line_id: lineId,
        farm_id: farmId,
        machine_id: machineId,
      });
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
  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=service`);
}
