import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadPartnerDocFile } from "@/lib/partner-media";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { brandingFrom, snapshotOf } from "@/lib/branding";

export const dynamic = "force-dynamic";

/**
 * Attach a quote or invoice the partner produced in THEIR OWN system (F14b).
 *
 * This is the path that keeps a partner independent of us. They run Sage, Xero, a
 * spreadsheet or a receipt book; they upload the finished PDF and type the total; the
 * farmer sees it in their document list, the invoice lands in the farm's cost ledger
 * exactly once, and nobody has to re-key line items into a second system. It is
 * deliberately NOT gated by the managed product — a partner on `portal` can do this on
 * day one (see src/lib/contractor-plan.ts).
 *
 * The total is typed VAT-INCLUSIVE, because that is the number printed on the document
 * they are holding. We store the ex-VAT figure in `subtotal_cents` (the ledger's
 * currency) and let the row carry the VAT and inclusive total, so an uploaded document
 * and a built one add up the same way in every report.
 *
 * The farm is resolved through the RLS-bound client, so a partner can only raise a
 * document against a farm they are actually linked to; the file is written by the service
 * role under the farm's own storage prefix.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const isPartner = profile.role === "workshop";
  const isFarmSide = profile.role === "owner" || profile.role === "manager";
  if (!isPartner && !isFarmSide) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const farmId = String(form.get("farm_id") ?? "");
  const workshopId = isPartner ? profile.workshop_id : String(form.get("workshop_id") ?? "");
  const kind = String(form.get("kind") ?? "invoice") === "quote" ? "quote" : "invoice";
  const totalIncl = parseRandsToCents(String(form.get("total") ?? ""));
  const file = form.get("file");

  if (!farmId || !workshopId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (totalIncl == null || totalIncl <= 0) return NextResponse.json({ error: "missing_total" }, { status: 400 });

  const supabase = await createClient();

  // The partner's letterhead and VAT rate — the uploaded document still carries their
  // identity in the list, and the same rate the rest of their paperwork uses.
  const { data: shopData } = await supabase.from("workshops").select("*").eq("id", workshopId).maybeSingle();
  const brand = brandingFrom(shopData as never);
  const vatBps = brand.defaultVatRateBps;
  const exVat = exVatCents(totalIncl, vatBps);

  const { data: numData, error: numErr } = await supabase.rpc("next_document_number", {
    p_workshop: workshopId,
    p_kind: kind,
  });
  if (numErr) return NextResponse.json({ error: numErr.message }, { status: 400 });

  // Insert first with a placeholder path so the row's id can key the storage object, then
  // fill the path in. `source = 'uploaded'` makes the totals authoritative as typed —
  // the 0381 rollup trigger deliberately leaves uploaded documents alone.
  const { data: created, error } = await supabase
    .from("partner_documents")
    .insert({
      farm_id: farmId,
      workshop_id: workshopId,
      machine_id: String(form.get("machine_id") ?? "") || null,
      work_request_id: String(form.get("work_request_id") ?? "") || null,
      kind,
      status: "sent",
      source: "uploaded",
      number: String(numData),
      subject: String(form.get("subject") ?? "") || null,
      issue_date: String(form.get("issue_date") ?? "") || new Date().toISOString().slice(0, 10),
      due_date: String(form.get("due_date") ?? "") || null,
      subtotal_cents: exVat,
      vat_cents: totalIncl - exVat,
      total_cents: totalIncl,
      vat_rate_bps: vatBps,
      upload_path: "pending",
      issuer_snapshot: snapshotOf(brand),
      sent_at: new Date().toISOString(),
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const docId = (created as { id: string }).id;

  const svc = createServiceClient();
  const path = await uploadPartnerDocFile(svc, file, farmId, docId, "document");
  if (!path) {
    // No file means no uploaded document — the check constraint would have caught a null,
    // and a row pointing at "pending" would be a lie. Take it back out.
    await supabase.from("partner_documents").update({ deleted_at: new Date().toISOString() }).eq("id", docId);
    return NextResponse.json({ error: "upload_failed" }, { status: 400 });
  }

  await supabase.from("partner_documents").update({ upload_path: path }).eq("id", docId);

  return NextResponse.json({ ok: true, id: docId, number: String(numData) });
}
