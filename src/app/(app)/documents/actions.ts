"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { brandingFrom, snapshotOf } from "@/lib/branding";
import { defaultDueDate, type DocKind, type DocLineKind } from "@/lib/partner-docs";
import { safePath } from "@/lib/safe-path";

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
  farm_id: string | null;
  partner_client_id: string | null;
  corrects_document_id: string | null;
  bill_to_name: string | null;
  bill_to_email: string | null;
  due_date: string | null;
  subject: string | null;
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
    .select(
      "id, farm_id, partner_client_id, corrects_document_id, workshop_id, kind, status, source, " +
      "number, total_cents, vat_rate_bps, machine_id, work_request_id, subject, due_date, " +
      "bill_to_name, bill_to_email",
    )
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
/**
 * Who this document is for (0410). Exactly one of three, and the third is the point:
 * a walk-in job should not require filing a customer before you can bill it.
 */
type Recipient =
  | { farm_id: string; partner_client_id: null }
  | { farm_id: null; partner_client_id: string }
  | { farm_id: null; partner_client_id: null };

/**
 * Resolve the recipient from the form, and REFUSE one the caller cannot reach.
 *
 * A farm must be one this partner is actually linked to, and a client must be one in
 * their own book. Both are re-derived from the database rather than trusted from the
 * form — otherwise a partner could raise an invoice against any farm id they could
 * guess, and the farmer would find it in their costs.
 */
async function resolveRecipient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workshopId: string,
  formData: FormData,
): Promise<Recipient | null> {
  const kind = String(formData.get("recipient_kind") ?? "farm");

  if (kind === "farm") {
    const farmId = s(formData, "farm_id");
    if (!farmId) return null;
    // `workshop_links` is the relationship; an inactive or absent link is a refusal.
    const { data } = await supabase
      .from("workshop_links")
      .select("farm_id")
      .eq("workshop_id", workshopId)
      .eq("farm_id", farmId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    return data ? { farm_id: farmId, partner_client_id: null } : null;
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
    return data ? { farm_id: null, partner_client_id: clientId } : null;
  }

  // A one-time customer. Nothing to verify — there is no record; the name on the
  // document is the whole of it.
  return { farm_id: null, partner_client_id: null };
}

/** The bill-to block off the form. Blank fields fall through to the 0410 seed trigger. */
function billToFields(formData: FormData) {
  return {
    bill_to_name: s(formData, "bill_to_name"),
    bill_to_contact: s(formData, "bill_to_contact"),
    bill_to_email: s(formData, "bill_to_email"),
    bill_to_phone: s(formData, "bill_to_phone"),
    bill_to_address: s(formData, "bill_to_address"),
    bill_to_vat_number: s(formData, "bill_to_vat_number"),
    bill_to_reg_number: s(formData, "bill_to_reg_number"),
    bill_to_reference: s(formData, "bill_to_reference"),
  };
}

export async function createDocument(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/documents?error=upgrade");

  const kind: DocKind = String(formData.get("kind") ?? "quote") === "invoice" ? "invoice" : "quote";
  const { workshop } = await currentWorkshop(profile);
  const branding = brandingFrom(workshop);
  const supabase = await createClient();

  const recipient = await resolveRecipient(supabase, profile.workshop_id!, formData);
  if (!recipient) redirect("/documents?error=missing-recipient");

  const bill = billToFields(formData);
  // A one-time customer has nothing to seed from, so the name has to be typed.
  if (!recipient.farm_id && !recipient.partner_client_id && !bill.bill_to_name) {
    redirect("/documents?error=missing-name");
  }

  const { data: numData, error: numErr } = await supabase.rpc("next_document_number", {
    p_workshop: profile.workshop_id,
    p_kind: kind,
  });
  if (numErr) redirect(`/documents?error=${encodeURIComponent(numErr.message)}`);

  // A client's own payment terms beat the partner's default — that is what agreeing terms
  // with a customer means, and retyping them on every invoice is how they drift.
  let termsDays = kind === "quote" ? branding.quoteValidityDays : branding.invoiceTermsDays;
  if (recipient.partner_client_id && kind === "invoice") {
    const { data: client } = await supabase
      .from("partner_clients")
      .select("payment_terms_days")
      .eq("id", recipient.partner_client_id)
      .maybeSingle();
    const days = (client as { payment_terms_days: number | null } | null)?.payment_terms_days;
    if (days != null) termsDays = days;
  }

  const { data, error } = await supabase
    .from("partner_documents")
    .insert({
      ...recipient,
      ...bill,
      workshop_id: profile.workshop_id,
      machine_id: recipient.farm_id ? s(formData, "machine_id") : null,
      work_request_id: recipient.farm_id ? s(formData, "work_request_id") : null,
      kind,
      status: "draft",
      source: "built",
      number: String(numData),
      subject: s(formData, "subject"),
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: defaultDueDate(kind, new Date(), termsDays, termsDays),
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
/**
 * Void a document, with a reason.
 *
 * This replaces `cancelDocument`, which was available at ANY status including `paid`,
 * recorded no reason, asked for no confirmation and silently soft-deleted the farm's cost
 * entry. A partner who typed R12 000 instead of R1 200 could erase the invoice from the
 * farmer's costs with no explanation of why the number moved.
 *
 * Voiding keeps the document, its number and its history; it stands the money down and
 * says why. That is what VAT Act s21 wants — the cancellation documented, not the
 * paperwork destroyed — and it is the difference between an audit trail with a gap in it
 * and an audit trail that lies.
 *
 * For a WRONG AMOUNT this is the wrong tool: issue a credit note and a fresh invoice, so
 * the customer's account shows what was billed and what was credited back. The UI offers
 * that first for an invoice; this is here for the document that should not exist at all.
 */
export async function voidDocument(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const reason = String(formData.get("void_reason") ?? "").trim();
  if (reason.length < 3) redirect(`/documents/${id}?error=void-reason`);

  const supabase = await createClient();
  const doc = await loadDoc(supabase, id);
  if (!doc) redirect("/documents?error=not-found");
  if (doc.status === "void") redirect(`/documents/${id}?error=already-void`);

  const { error } = await supabase
    .from("partner_documents")
    .update({
      status: "void",
      void_reason: reason.slice(0, 500),
      voided_at: new Date().toISOString(),
      voided_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/documents");
  revalidatePath(`/documents/${id}`);
  redirect(`/documents/${id}?voided=1`);
}

/**
 * Raise a credit note against an issued invoice.
 *
 * The correction path proper. It starts as a DRAFT with the invoice's own lines copied
 * in, because the common case is crediting the whole thing — a partner crediting part of
 * it deletes the lines that were right and keeps the ones that were not, which is the
 * same motion as building any other document and needs no separate screen.
 *
 * The link is a COLUMN (`corrects_document_id`), not a sentence in a description. That is
 * the difference between this and AutoVault, where the statement finds credits by
 * matching `/\b(CN-[A-Z0-9-]{4,})\b/i` against free text and a customer's account
 * therefore depends on how somebody worded a field.
 *
 * The database enforces the rest: 0412 refuses a credit note with no target, and refuses
 * credits that together come to more than the invoice they correct.
 */
export async function createCreditNote(formData: FormData) {
  return createNote(formData, "credit_note");
}

/**
 * A DEBIT note: the invoice went out for too little.
 *
 * The mirror of a credit note and the half AutoVault has that we did not — a partner who
 * left a part off an invoice could previously only raise a second invoice, which reads on
 * the customer's statement as an unrelated charge rather than as a correction to a job
 * they already know about.
 */
export async function createDebitNote(formData: FormData) {
  return createNote(formData, "debit_note");
}

async function createNote(formData: FormData, noteKind: "credit_note" | "debit_note") {
  const profile = await requireRole(["workshop"]);
  const gate = await checkWorkshopEntitlement("build_documents", profile);
  if (!gate.allowed) redirect("/documents?error=upgrade");

  const id = String(formData.get("document_id") ?? "");
  const supabase = await createClient();
  const invoice = await loadDoc(supabase, id);
  if (!invoice || invoice.kind !== "invoice") redirect("/documents?error=not-found");
  if (invoice.status === "draft") redirect(`/documents/${id}?error=not-issued`);

  const { data: numData, error: numErr } = await supabase.rpc("next_document_number", {
    p_workshop: profile.workshop_id,
    p_kind: noteKind,
  });
  if (numErr) redirect(`/documents/${id}?error=${encodeURIComponent(numErr.message)}`);

  const { data: full } = await supabase
    .from("partner_documents")
    .select(
      "farm_id, partner_client_id, machine_id, terms, vat_rate_bps, subject, " +
      "bill_to_name, bill_to_contact, bill_to_email, bill_to_phone, bill_to_address, " +
      "bill_to_vat_number, bill_to_reg_number, bill_to_reference",
    )
    .eq("id", id)
    .single();
  const src = (full ?? {}) as unknown as Record<string, unknown>;

  const { data: created, error } = await supabase
    .from("partner_documents")
    .insert({
      ...src,
      workshop_id: profile.workshop_id,
      corrects_document_id: id,
      kind: noteKind,
      status: "draft",
      source: "built",
      number: String(numData),
      subject: String(formData.get("reason") ?? "").trim() || `Correction to ${invoice.number}`,
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  const newId = (created as { id: string }).id;

  // A CREDIT note copies the invoice's lines in, because crediting the whole thing is the
  // common case and trimming what was actually right is quicker than retyping what was
  // wrong. A DEBIT note starts empty — it is the bit that was LEFT OFF, so there is
  // nothing on the invoice to copy.
  if (noteKind === "debit_note") {
    revalidatePath("/documents");
    redirect(`/documents/${newId}?credit=1`);
  }

  const { data: lines } = await supabase
    .from("partner_document_lines")
    .select("sort_order, kind, part_no, description, qty, unit_price_cents, discount_cents")
    .eq("document_id", id)
    .is("deleted_at", null)
    .order("sort_order");

  const rows = (lines ?? []) as Record<string, unknown>[];
  if (rows.length > 0) {
    await supabase.from("partner_document_lines").insert(
      rows.map((l) => ({ ...l, document_id: newId, farm_id: src.farm_id })),
    );
  }

  revalidatePath("/documents");
  redirect(`/documents/${newId}?credit=1`);
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

// ── Correcting an issued document ────────────────────────────────────────────

/**
 * Edit a document that has already gone out, keeping the version it replaced.
 *
 * The whole edit is one RPC (`revise_document`, 0417) rather than a snapshot followed by
 * an update, because two calls are two transactions and the second one can fail. Doing it
 * in the database means a correction and its history are the same act — there is no state
 * of the world where a document changed and nobody recorded what it said before.
 *
 * The freeze triggers still refuse every other route, so this action is not the guard;
 * it is just the form's end of the one door that exists.
 */
export async function reviseDocument(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("document_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 3) redirect(`/documents/${id}?error=revise-reason`);

  const supabase = await createClient();

  // Only the fields the form actually offered. An absent key means "leave it alone", so a
  // form that edits the due date does not blank the notes.
  const patch: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined) patch[key] = value;
  };
  for (const key of ["subject", "issue_date", "due_date", "notes", "terms",
                     "bill_to_name", "bill_to_contact", "bill_to_email", "bill_to_phone",
                     "bill_to_address", "bill_to_vat_number", "bill_to_reg_number",
                     "bill_to_reference"]) {
    if (formData.has(key)) put(key, String(formData.get(key) ?? "").trim());
  }
  if (formData.has("discount")) {
    put("discount_cents", parseRandsToCents(String(formData.get("discount") ?? "")) ?? 0);
  }
  if (formData.has("vat_percent")) {
    put("vat_rate_bps", percentToBps(String(formData.get("vat_percent") ?? "")) ?? undefined);
  }

  // Lines arrive as parallel arrays from the repeated form fields, and are sent only when
  // the form was the one that edits them.
  let lines: Record<string, unknown>[] | null = null;
  if (formData.has("line_description")) {
    const descriptions = formData.getAll("line_description").map(String);
    const kinds = formData.getAll("line_kind").map(String);
    const partNos = formData.getAll("line_part_no").map(String);
    const qtys = formData.getAll("line_qty").map(String);
    const prices = formData.getAll("line_price").map(String);
    const inclusive = formData.get("prices_incl_vat") != null;
    const rateBps = (patch.vat_rate_bps as number | undefined)
      ?? Number(formData.get("current_vat_rate_bps") ?? 1500);

    lines = descriptions
      .map((description, i) => {
        const typed = parseRandsToCents(prices[i] ?? "") ?? 0;
        return {
          kind: (kinds[i] ?? "part") as DocLineKind,
          part_no: (partNos[i] ?? "").trim() || null,
          description: description.trim(),
          qty: Number(qtys[i] ?? 1) || 0,
          // Prices are typed the way the partner quotes them and stored ex-VAT, exactly as
          // on the draft line form — otherwise a correction would silently change the
          // basis of every figure on the document.
          unit_price_cents: inclusive ? exVatCents(typed, rateBps) : typed,
          discount_cents: 0,
        };
      })
      .filter((l) => l.description !== "");

    if (lines.length === 0) redirect(`/documents/${id}?error=revise-empty`);
  }

  const { error } = await supabase.rpc("revise_document", {
    p_document: id,
    p_reason: reason,
    p_patch: patch,
    p_lines: lines,
  });

  if (error) redirect(`/documents/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/documents/${id}`);
  revalidatePath("/documents");
  redirect(`/documents/${id}?revised=1`);
}
