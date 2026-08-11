"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { CADENCES, type Cadence } from "@/lib/recurring";

/**
 * Standing invoices (G8).
 *
 * The recipient is resolved the same way a document's is — a farm the partner is actually
 * linked to, a client from their own book, or a typed name — and re-derived from the
 * database rather than trusted from the form, so a schedule cannot be pointed at a farm
 * the partner has no relationship with.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function cadence(fd: FormData): Cadence {
  const raw = String(fd.get("cadence") ?? "monthly");
  return (CADENCES as readonly string[]).includes(raw) ? (raw as Cadence) : "monthly";
}

async function resolveRecipient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workshopId: string,
  formData: FormData,
): Promise<{ farm_id: string | null; partner_client_id: string | null; bill_to_name: string | null } | null> {
  const kind = String(formData.get("recipient_kind") ?? "farm");

  if (kind === "farm") {
    const farmId = s(formData, "farm_id");
    if (!farmId) return null;
    const { data } = await supabase
      .from("workshop_links")
      .select("farm_id")
      .eq("workshop_id", workshopId)
      .eq("farm_id", farmId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    return data ? { farm_id: farmId, partner_client_id: null, bill_to_name: null } : null;
  }

  if (kind === "client") {
    const clientId = s(formData, "partner_client_id");
    if (!clientId) return null;
    const { data } = await supabase
      .from("partner_clients")
      .select("id")
      .eq("id", clientId)
      .eq("workshop_id", workshopId)
      .is("deleted_at", null)
      .maybeSingle();
    return data ? { farm_id: null, partner_client_id: clientId, bill_to_name: null } : null;
  }

  const name = s(formData, "bill_to_name");
  return name ? { farm_id: null, partner_client_id: null, bill_to_name: name } : null;
}

export async function createSchedule(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/recurring?error=upgrade");

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const recipient = await resolveRecipient(supabase, workshop.id, formData);
  if (!recipient) redirect("/recurring?error=missing-recipient");

  const name = s(formData, "name");
  if (!name) redirect("/recurring?error=need-name");

  const rateBps = percentToBps(String(formData.get("vat_percent") ?? "15")) ?? 1500;
  const { data: created, error } = await supabase
    .from("recurring_invoices")
    .insert({
      workshop_id: workshop.id,
      ...recipient,
      name,
      subject: s(formData, "subject"),
      notes: s(formData, "notes"),
      cadence: cadence(formData),
      next_issue_date: s(formData, "next_issue_date") ?? new Date().toISOString().slice(0, 10),
      ends_on: s(formData, "ends_on"),
      vat_rate_bps: rateBps,
      auto_send: formData.get("auto_send") != null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/recurring?error=${encodeURIComponent(error.message)}`);

  // The first line comes off the same form, because a schedule with no lines raises
  // nothing and a partner who has to add one on a second screen may not.
  const description = s(formData, "description");
  const priceCents = parseRandsToCents(String(formData.get("unit_price") ?? ""));
  if (description && priceCents != null && priceCents > 0) {
    const inclusive = formData.get("incl_vat") != null;
    await supabase.from("recurring_invoice_lines").insert({
      recurring_id: (created as { id: string }).id,
      workshop_id: workshop.id,
      sort_order: 0,
      kind: "other",
      description,
      qty: Number(formData.get("qty") ?? 1) || 1,
      unit_price_cents: inclusive ? exVatCents(priceCents, rateBps) : priceCents,
    });
  }

  revalidatePath("/recurring");
  redirect(`/recurring/${(created as { id: string }).id}?saved=1`);
}

export async function addScheduleLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const id = String(formData.get("schedule_id") ?? "");
  const description = s(formData, "description");
  const priceCents = parseRandsToCents(String(formData.get("unit_price") ?? ""));
  if (!description || priceCents == null) redirect(`/recurring/${id}?error=need-line`);

  const supabase = await createClient();
  const { data: sched } = await supabase
    .from("recurring_invoices")
    .select("vat_rate_bps")
    .eq("id", id)
    .maybeSingle();
  const rateBps = (sched as { vat_rate_bps?: number } | null)?.vat_rate_bps ?? 1500;
  const inclusive = formData.get("incl_vat") != null;

  const { error } = await supabase.from("recurring_invoice_lines").insert({
    recurring_id: id,
    workshop_id: workshop.id,
    sort_order: Number(formData.get("sort_order") ?? 0) || 0,
    kind: "other",
    description,
    qty: Number(formData.get("qty") ?? 1) || 1,
    unit_price_cents: inclusive ? exVatCents(priceCents, rateBps) : priceCents,
  });
  if (error) redirect(`/recurring/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/recurring/${id}`);
  redirect(`/recurring/${id}?added=1`);
}

export async function removeScheduleLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("recurring_invoice_lines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", lineId);
  revalidatePath(`/recurring/${id}`);
  redirect(`/recurring/${id}?saved=1`);
}

/** Pause or restart a schedule. The one thing a partner does to one most often. */
export async function toggleSchedule(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const active = String(formData.get("active") ?? "") === "1";
  const supabase = await createClient();
  await supabase
    .from("recurring_invoices")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/recurring");
  redirect(`/recurring/${id}?saved=1`);
}

export async function updateSchedule(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase
    .from("recurring_invoices")
    .update({
      name: s(formData, "name") ?? "—",
      subject: s(formData, "subject"),
      notes: s(formData, "notes"),
      cadence: cadence(formData),
      next_issue_date: s(formData, "next_issue_date") ?? new Date().toISOString().slice(0, 10),
      ends_on: s(formData, "ends_on"),
      auto_send: formData.get("auto_send") != null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) redirect(`/recurring/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/recurring/${id}`);
  redirect(`/recurring/${id}?saved=1`);
}

/**
 * Raise this schedule's next invoice now, rather than waiting for the night.
 *
 * `run_recurring_invoice` checks ownership itself — the generator underneath is SECURITY
 * DEFINER and would otherwise honour any id handed to it. It is also the same code path
 * the cron uses, including the same "already done this period" guard, so pressing it
 * twice cannot produce two invoices.
 */
export async function runScheduleNow(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("run_recurring_invoice", { p_id: id });
  if (error) redirect(`/recurring/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/recurring");
  revalidatePath("/documents");
  redirect(`/recurring/${id}?${Number(data) > 0 ? "raised=1" : "nothing=1"}`);
}

export async function deleteSchedule(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("recurring_invoices")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id, active: false })
    .eq("id", id);
  revalidatePath("/recurring");
  redirect("/recurring?deleted=1");
}
