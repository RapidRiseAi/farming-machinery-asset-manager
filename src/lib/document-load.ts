import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PdfContext, PdfDocRow, PdfLine } from "@/lib/pdf/partner-document";

/**
 * Everything a document needs to render, fetched once.
 *
 * Two callers with very different access stories share it: the authenticated PDF and
 * detail routes, which pass the RLS-bound client and let `app.partner_doc_visible` decide
 * what they may see; and the customer's public link, which passes the SERVICE client
 * after validating an unguessable token — the same shape as the public QR flow, where
 * anon has zero database access and a server route does the read.
 *
 * Sharing the loader is what keeps the two copies of a document identical. It also puts
 * the machine column name in one place: it is `reg_no`, and two call sites had been
 * selecting `reg_number` (which is the WORKSHOP's company registration number, a
 * different thing on a different table). PostgREST rejects the unknown column, the code
 * ignored the error, and the vehicle block silently disappeared from every partner
 * document PDF and from the document detail page.
 */

const DOC_COLUMNS =
  "id, farm_id, partner_client_id, workshop_id, machine_id, work_request_id, quote_id, " +
  "corrects_document_id, kind, status, source, number, subject, issue_date, due_date, " +
  "subtotal_cents, discount_cents, vat_cents, total_cents, vat_rate_bps, amount_paid_cents, " +
  "notes, terms, declined_reason, void_reason, voided_at, upload_path, issuer_snapshot, " +
  "customer_snapshot, public_token, viewed_at, accepted_at, accepted_by_name, accepted_via, " +
  "sent_at, paid_at, created_by, created_at, " +
  "bill_to_name, bill_to_contact, bill_to_email, bill_to_phone, bill_to_address, " +
  "bill_to_vat_number, bill_to_reg_number, bill_to_reference";

export type LoadedDocument = PdfContext & {
  doc: PdfDocRow & {
    farm_id: string | null;
    partner_client_id: string | null;
    workshop_id: string;
    machine_id: string | null;
    public_token: string;
    corrects_document_id: string | null;
    viewed_at: string | null;
    accepted_at: string | null;
    accepted_by_name: string | null;
    sent_at: string | null;
    declined_reason: string | null;
    upload_path: string | null;
  };
};

/** Load by id (RLS decides) or by public token (the caller has already validated it). */
export async function loadDocument(
  supabase: SupabaseClient,
  by: { id: string } | { token: string },
): Promise<LoadedDocument | null> {
  const query = supabase.from("partner_documents").select(DOC_COLUMNS).is("deleted_at", null);
  const { data } = await ("id" in by ? query.eq("id", by.id) : query.eq("public_token", by.token)).maybeSingle();
  const doc = data as LoadedDocument["doc"] | null;
  if (!doc) return null;

  const [{ data: lineData }, { data: shopData }, { data: machineData }, { data: correctsData }] =
    await Promise.all([
      supabase
        .from("partner_document_lines")
        .select("description, part_no, qty, unit_price_cents, line_total_cents")
        .eq("document_id", doc.id)
        .is("deleted_at", null)
        .order("sort_order"),
      supabase.from("workshops").select("*").eq("id", doc.workshop_id).maybeSingle(),
      doc.machine_id
        ? supabase.from("machines").select("name, reg_no").eq("id", doc.machine_id).maybeSingle()
        : Promise.resolve({ data: null }),
      doc.corrects_document_id
        ? supabase
            .from("partner_documents")
            .select("number, issue_date")
            .eq("id", doc.corrects_document_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  return {
    doc,
    lines: (lineData ?? []) as PdfLine[],
    workshop: shopData,
    machine: machineData as { name: string; reg_no: string | null } | null,
    corrects: correctsData as { number: string; issue_date: string } | null,
  };
}
