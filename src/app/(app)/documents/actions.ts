"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { brandingFrom, snapshotOf } from "@/lib/branding";
import { defaultDueDate, type DocKind, type DocLineKind } from "@/lib/partner-docs";

/**
 * Quotes and invoices (F14b/F14c).
 *
 * Two audiences share these actions, and RLS (0381) decides what each can reach:
 *   * the ISSUING PARTNER builds, sends, converts and records payment;
 *   * the RECEIVING FARM's owner/manager accepts or declines a quote, and can record a
 *     document they were handed on paper.
 *
 * Two rules are enforced here rather than left to the UI:
 *   1. BUILDING a document from line items requires the `managed` product. UPLOADING one
 *      produced in the partner's own system does not — that is core on every plan, so a
 *      partner is never dependent on our invoicing (F14e).
 *   2. Once a document is sent it stops being editable. It is a record of what someone
 *      was told they owed; changing it afterwards would make the ledger a rumour.
 */

const FARM_SIDE: Role[] = ["owner", "manager"];
const BOTH_SIDES: Role[] = ["owner", "manager", "mechanic", "workshop"];

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function back(fd: FormData, fallback: string): string {
  const to = String(fd.get("back") ?? "");
  return to.startsWith("/") && !to.startsWith("//") ? to : fallback;
}

type DocRow = {
  id: string;
  farm_id: string;
  workshop_id: string;
  kind: DocKind;
  status: string;
  source: string;
  number: string;
  total_cents: number;
  vat_rate_bps: number;
  machine_id: string | null;
  work_request_id: string | null;
};

/** Load a document through RLS — a caller who cannot see it gets `null`, not an error. */
async function loadDoc(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<DocRow | null> {
  const { data } = await supabase
    .from("partner_documents")
    .select("id, farm_id, workshop_id, kind, status, source, number, total_cents, vat_rate_bps, machine_id, work_request_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as DocRow | null) ?? null;
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Start a new quote or invoice. The number is allocated by `app.next_document_number`
 * (0380), which increments the partner's own counter under a row lock — so two staff
 * pressing "New invoice" at the same second get INV-0007 and INV-0008, never two 0007s.
 */
export async function createDocument(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/documents?error=upgrade");

  const farmId = String(formData.get("farm_id") ?? "");
  const kind: DocKind = String(formData.get("kind") ?? "quote") === "invoice" ? "invoice" : "quote";
  if (!farmId) redirect("/documents?error=missing-farm");

  const { workshop } = await currentWorkshop(profile);
  const branding = brandingFrom(workshop);
  const supabase = await createClient();

  const { data: numData, error: numErr } = await supabase.rpc("next_document_number", {
    p_workshop: profile.workshop_id,
    p_kind: kind,
  });
  if (numErr) redirect(`/documents?error=${encodeURIComponent(numErr.message)}`);

  const { data, error } = await supabase
    .from("partner_documents")
    .insert({
      farm_id: farmId,
      workshop_id: profile.workshop_id,
      machine_id: s(formData, "machine_id"),
      work_request_id: s(formData, "work_request_id"),
      kind,
      status: "draft",
      source: "built",
      number: String(numData),
      subject: s(formData, "subject"),
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: defaultDueDate(kind, new Date(), branding.quoteValidityDays, branding.invoiceTermsDays),
      vat_rate_bps: branding.defaultVatRateBps,
      terms: branding.terms,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/documents?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/documents");
  redirect(`/documents/${(data as { id: string }).id}`);
}

// ── Lines ────────────────────────────────────────────────────────────────────

/**
 * Add a line. Prices are typed the way a partner quotes them — the form says whether the
 * figure is VAT-inclusive — and stored ex-VAT, so the ledger stays consistent with every
 * other cost in the system. The line total and the document totals are computed by the
 * 0381 triggers; nothing here types a total.
 */
export async function addDocumentLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/documents?error=upgrade");

  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status !== "draft") redirect(`/documents/${id}?error=locked`);

  const kindRaw = String(formData.get("kind") ?? "part");
  const kind: DocLineKind = kindRaw === "labour" || kindRaw === "other" ? kindRaw : "part";
  const description = String(formData.get("description") ?? "").trim();
  if (!description) redirect(`/documents/${id}?error=need-description`);

  const qty = Number.parseFloat(String(formData.get("qty") ?? "1"));
  const priceCents = parseRandsToCents(String(formData.get("unit_price") ?? ""));
  const inclVat = formData.get("incl_vat") != null;

  const { count } = await supabase
    .from("partner_document_lines")
    .select("id", { count: "exact", head: true })
    .eq("document_id", id)
    .is("deleted_at", null);

  const { error } = await supabase.from("partner_document_lines").insert({
    farm_id: doc.farm_id,
    document_id: id,
    sort_order: count ?? 0,
    kind,
    part_no: s(formData, "part_no"),
    description,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    unit_price_cents: priceCents == null ? 0 : inclVat ? exVatCents(priceCents, doc.vat_rate_bps) : priceCents,
  });

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}?added=1`);
}

export async function removeDocumentLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status !== "draft") redirect(`/documents/${id}?error=locked`);

  await supabase
    .from("partner_document_lines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", lineId)
    .eq("document_id", id);

  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}`);
}

/** Subject, dates, VAT rate, whole-document discount and notes, while still a draft. */
export async function updateDocument(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status !== "draft") redirect(`/documents/${id}?error=locked`);

  const discount = parseRandsToCents(String(formData.get("discount") ?? ""));
  const { error } = await supabase
    .from("partner_documents")
    .update({
      subject: s(formData, "subject"),
      issue_date: s(formData, "issue_date") ?? undefined,
      due_date: s(formData, "due_date"),
      discount_cents: discount ?? 0,
      notes: s(formData, "notes"),
      terms: s(formData, "terms"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}?saved=1`);
}

// ── Issue ────────────────────────────────────────────────────────────────────

/**
 * Send the document to the farmer. This is the moment it stops being a draft: the
 * letterhead is frozen onto the row (so a rebrand next year cannot restate this
 * invoice), the 0381 notify trigger tells the farm's owner/manager, and — for an
 * invoice — the cost trigger books it into the farm's ledger exactly once.
 */
export async function sendDocument(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status !== "draft") redirect(`/documents/${id}?error=already-sent`);
  if (doc.source === "built" && doc.total_cents <= 0) redirect(`/documents/${id}?error=empty`);

  const { workshop } = await currentWorkshop();
  const { data: farmData } = await supabase.from("farms").select("name").eq("id", doc.farm_id).maybeSingle();

  const { error } = await supabase
    .from("partner_documents")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      issuer_snapshot: snapshotOf(brandingFrom(workshop)),
      customer_snapshot: { name: (farmData as { name: string } | null)?.name ?? null },
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/documents/${id}`);
  revalidatePath("/documents");
  redirect(`/documents/${id}?sent=1`);
}

/**
 * Turn an accepted quote into an invoice: same lines, same vehicle, same job, a new
 * number, back to draft so the partner can adjust before issuing. The quote stays as it
 * was — the pair is the record of what was agreed versus what was billed.
 */
export async function convertQuoteToInvoice(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/documents?error=upgrade");

  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc || doc.kind !== "quote") redirect("/documents?error=not-found");

  const { workshop } = await currentWorkshop(profile);
  const branding = brandingFrom(workshop);

  const { data: numData, error: numErr } = await supabase.rpc("next_document_number", {
    p_workshop: doc.workshop_id,
    p_kind: "invoice",
  });
  if (numErr) redirect(`/documents/${id}?error=${encodeURIComponent(numErr.message)}`);

  const { data: full } = await supabase
    .from("partner_documents")
    .select("subject, notes, terms, discount_cents, vat_rate_bps")
    .eq("id", id)
    .maybeSingle();
  const src = (full ?? {}) as { subject?: string | null; notes?: string | null; terms?: string | null; discount_cents?: number; vat_rate_bps?: number };

  const { data: created, error } = await supabase
    .from("partner_documents")
    .insert({
      farm_id: doc.farm_id,
      workshop_id: doc.workshop_id,
      machine_id: doc.machine_id,
      work_request_id: doc.work_request_id,
      quote_id: doc.id,
      kind: "invoice",
      status: "draft",
      source: "built",
      number: String(numData),
      subject: src.subject ?? null,
      notes: src.notes ?? null,
      terms: src.terms ?? branding.terms,
      discount_cents: src.discount_cents ?? 0,
      vat_rate_bps: src.vat_rate_bps ?? branding.defaultVatRateBps,
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: defaultDueDate("invoice", new Date(), branding.quoteValidityDays, branding.invoiceTermsDays),
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  const invoiceId = (created as { id: string }).id;

  const { data: lines } = await supabase
    .from("partner_document_lines")
    .select("sort_order, kind, part_no, description, qty, unit_price_cents, discount_cents")
    .eq("document_id", id)
    .is("deleted_at", null)
    .order("sort_order");

  const rows = (lines ?? []) as Record<string, unknown>[];
  if (rows.length) {
    await supabase
      .from("partner_document_lines")
      .insert(rows.map((l) => ({ ...l, farm_id: doc.farm_id, document_id: invoiceId })));
  }

  revalidatePath("/documents");
  redirect(`/documents/${invoiceId}?converted=1`);
}

// ── The farmer's side ────────────────────────────────────────────────────────

/** Accept a quote. The partner sees it immediately; no money moves until they invoice. */
export async function acceptDocument(formData: FormData) {
  await requireRole(FARM_SIDE);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc || doc.kind !== "quote") redirect("/documents?error=not-found");

  await supabase
    .from("partner_documents")
    .update({ status: "accepted", accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath("/documents");
  redirect(`${back(formData, `/documents/${id}`)}?accepted=1`);
}

/** Decline a quote, with the reason the partner will read. */
export async function declineDocument(formData: FormData) {
  await requireRole(FARM_SIDE);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc || doc.kind !== "quote") redirect("/documents?error=not-found");

  await supabase
    .from("partner_documents")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: s(formData, "reason"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  revalidatePath("/documents");
  redirect(`${back(formData, `/documents/${id}`)}?declined=1`);
}

// ── Payments ─────────────────────────────────────────────────────────────────

/**
 * Record a payment against an invoice. Either side may log one — the partner because
 * they saw it land, the farmer because they sent it — and the 0381 rollup moves the
 * invoice to part-paid or paid on its own. Payments are rows, so a part payment is a
 * fact rather than an edited balance.
 */
export async function recordPayment(formData: FormData) {
  const profile = await requireRole(BOTH_SIDES);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc || doc.kind !== "invoice") redirect("/documents?error=not-found");

  // Recording payments is part of the managed product — but only for the PARTNER. A
  // farmer telling their supplier "I have paid this" is never gated.
  if (profile.role === "workshop") {
    const gate = await checkWorkshopEntitlement("record_payments", profile);
    if (!gate.allowed) redirect(`/documents/${id}?error=upgrade`);
  }

  const amount = parseRandsToCents(String(formData.get("amount") ?? ""));
  if (amount == null || amount <= 0) redirect(`/documents/${id}?error=need-amount`);

  const { error } = await supabase.from("partner_payments").insert({
    farm_id: doc.farm_id,
    document_id: id,
    amount_cents: amount,
    paid_on: s(formData, "paid_on") ?? new Date().toISOString().slice(0, 10),
    method: s(formData, "method"),
    reference: s(formData, "reference"),
    note: s(formData, "note"),
    recorded_by: profile.id,
  });

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}?paid=1`);
}

export async function removePayment(formData: FormData) {
  const profile = await requireRole(BOTH_SIDES);
  const id = String(formData.get("document_id") ?? "");
  const paymentId = String(formData.get("payment_id") ?? "");
  const supabase = await createClient();

  await supabase
    .from("partner_payments")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", paymentId)
    .eq("document_id", id);

  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}`);
}

// ── Withdraw ─────────────────────────────────────────────────────────────────

/**
 * Cancel a document. Nothing is destroyed: the row stays, the status says cancelled, and
 * the cost trigger stands the ledger entry down — so a mistaken invoice stops counting
 * against the farm's TCO without erasing the fact that it was sent.
 */
export async function cancelDocument(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");

  await supabase
    .from("partner_documents")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath("/documents");
  redirect(`/documents/${id}?cancelled=1`);
}

/** Delete a draft outright — nothing was ever sent, so there is no record to preserve. */
export async function deleteDraft(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status !== "draft") redirect(`/documents/${id}?error=locked`);

  await supabase
    .from("partner_documents")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);

  revalidatePath("/documents");
  redirect("/documents?deleted=1");
}
