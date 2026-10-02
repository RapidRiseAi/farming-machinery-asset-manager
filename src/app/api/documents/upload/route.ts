import { NextResponse } from "next/server";
import { currentFarmId, effectiveFarmRole, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { brandingFrom, snapshotOf } from "@/lib/branding";
import { sameOrigin } from "@/lib/security/same-origin";
import { readBoundedFormData } from "@/lib/security/bounded-form";
import { sameSupplierUpload, supplierFileHash, validSupplierTotal, type SupplierDocumentReceipt } from "@/lib/supplier-document-upload";

export const dynamic = "force-dynamic";

/**
 * Attach a quote or invoice the partner produced in THEIR OWN system (F14b).
 *
 * This is the path that keeps a partner independent of us. They run Sage, Xero, a
 * spreadsheet or a receipt book; they upload the finished PDF and type the total; the
 * farmer sees it in their document list, the invoice lands in the farm's cost ledger
 * exactly once, and nobody has to re-key line items into a second system. It is
 * deliberately NOT gated by the managed product, a partner on `portal` can do this on
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
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const profile = await getProfile();
  if (!profile || !profile.active) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const isPartner = profile.role === "workshop";

  let form: FormData;
  try {
    form = await readBoundedFormData(request, 9 * 1024 * 1024);
  } catch (error) {
    return NextResponse.json({ error: "bad_request" }, { status: error instanceof RangeError ? 413 : 400 });
  }

  const farmId = String(form.get("farm_id") ?? "").trim() || (!isPartner ? await currentFarmId(profile) : null);
  if (!farmId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const resourceRole = isPartner ? "workshop" : await effectiveFarmRole(farmId, profile);
  if (resourceRole !== "workshop" && resourceRole !== "owner" && resourceRole !== "manager") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const workshopId = isPartner ? profile.workshop_id : String(form.get("workshop_id") ?? "");
  const kind = String(form.get("kind") ?? "invoice") === "quote" ? "quote" : "invoice";
  const capture = String(form.get("capture_id") ?? "");
  const supplierNumber = String(form.get("number") ?? "").trim();
  const totalIncl = parseRandsToCents(String(form.get("total") ?? ""));
  const file = form.get("file");

  if (!farmId || !workshopId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!supplierNumber || supplierNumber.length > 120) return NextResponse.json({ error: "document-number-required" }, { status: 400 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(capture)) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  if (!(file.type.startsWith("image/") || file.type === "application/pdf")) return NextResponse.json({ error: "bad-file-type" }, { status: 400 });
  if (!validSupplierTotal(kind, totalIncl)) return NextResponse.json({ error: "missing_total" }, { status: 400 });

  const supabase = await createClient();
  const { data: link } = await supabase.from("workshop_links").select("id")
    .eq("farm_id", farmId).eq("workshop_id", workshopId).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (!link) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const requestId = String(form.get("work_request_id") ?? "").trim() || null;
  const machineId = String(form.get("machine_id") ?? "").trim() || null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileHash = await supplierFileHash(bytes);
  const path = `${farmId}/${capture}/document-${fileHash}.${file.type === "application/pdf" ? "pdf" : "image"}`;
  const receipt: SupplierDocumentReceipt = {
    id: capture, farm_id: farmId, workshop_id: workshopId, machine_id: machineId,
    work_request_id: requestId, kind, source: "uploaded", created_by: profile.id,
    total_cents: totalIncl, subject: String(form.get("subject") ?? "").trim() || null,
    issue_date: String(form.get("issue_date") ?? "") || new Date().toISOString().slice(0, 10),
    due_date: String(form.get("due_date") ?? "") || null, upload_path: path, number: supplierNumber,
  };
  const receiptColumns = "id,farm_id,workshop_id,machine_id,work_request_id,kind,source,created_by,total_cents,subject,issue_date,due_date,upload_path,status,number";
  type SavedReceipt = SupplierDocumentReceipt & { status: string };
  const readReceipt = async () => await supabase.from("partner_documents").select(receiptColumns).eq("id", capture).is("deleted_at", null).maybeSingle();
  const initial = await readReceipt();
  if (initial.error) return NextResponse.json({ error: "save-failed" }, { status: 500 });
  let saved = initial.data as SavedReceipt | null;
  if (saved && !sameSupplierUpload(saved, receipt)) return NextResponse.json({ error: "work-changed" }, { status: 409 });
  // The receipt is authoritative even if another session has since closed the work.
  if (saved && saved.status !== "draft") return NextResponse.json({ ok: true, id: saved.id, number: saved.number });
  if (requestId) {
    const { data: work } = await supabase.from("work_requests").select("farm_id, machine_id, workshop_id, status")
      .eq("id", requestId).is("deleted_at", null).maybeSingle();
    if (!work || work.farm_id !== farmId || work.workshop_id !== workshopId || work.machine_id !== machineId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (kind === "invoice" ? !["completed", "invoiced"].includes(work.status) : !["requested", "viewed", "quoted"].includes(work.status)) {
      return NextResponse.json({ error: "work-transition" }, { status: 409 });
    }
  }

  // The partner's letterhead and VAT rate, the uploaded document still carries their
  // identity in the list, and the same rate the rest of their paperwork uses.
  const { data: shopData } = await supabase.from("workshops").select("*").eq("id", workshopId).maybeSingle();
  const brand = brandingFrom(shopData as never);
  const vatBps = brand.defaultVatRateBps;
  const exVat = exVatCents(totalIncl, vatBps);

  if (!saved) {
    // This document was already issued elsewhere. Preserve its printed number and
    // leave FleetWise's supplier numbering sequence for documents authored here.
    const { error } = await supabase.from("partner_documents").insert({
      ...receipt, status: "draft", subtotal_cents: exVat,
      vat_cents: totalIncl - exVat, vat_rate_bps: vatBps, issuer_snapshot: snapshotOf(brand),
    });
    if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 400 });
    // Concurrent retries can race on INSERT; both must use the same stored payload.
    const result = await readReceipt();
    saved = result.data as SavedReceipt | null;
    if (error?.code === "23505" && !result.error && !saved) return NextResponse.json({ error: "document-number-used" }, { status: 409 });
    if (result.error || !saved || !sameSupplierUpload(saved, receipt)) return NextResponse.json({ error: "work-changed" }, { status: 409 });
    if (saved.status !== "draft") return NextResponse.json({ ok: true, id: saved.id, number: saved.number });
  }

  const svc = createServiceClient();
  const { error: uploadError } = await svc.storage.from("partner-docs").upload(path, bytes, { contentType: file.type, upsert: false });
  if (uploadError && !["409", "Duplicate"].includes(String(uploadError.statusCode ?? uploadError.name))) return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  const { error: attachmentError } = await svc.from("attachments").upsert({
    id: capture, farm_id: farmId, parent_type: "partner_document", parent_id: capture,
    kind: "invoice", storage_path: path, created_by: profile.id,
  }, { onConflict: "id", ignoreDuplicates: true });
  if (attachmentError) return NextResponse.json({ error: "upload_failed" }, { status: 500 });

  const { data: issued, error: saveError } = await supabase.from("partner_documents")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", capture).eq("status", "draft").select("id").maybeSingle();
  if (!issued) {
    const result = await readReceipt();
    const concurrent = result.data as SavedReceipt | null;
    if (!result.error && concurrent && concurrent.status !== "draft" && sameSupplierUpload(concurrent, receipt)) {
      return NextResponse.json({ ok: true, id: capture, number: concurrent.number });
    }
    // Retain the draft and receipt so an uncertain upload can safely be retried.
    return NextResponse.json({ error: saveError?.message ?? "upload_failed", id: capture }, { status: 409 });
  }
  return NextResponse.json({ ok: true, id: capture, number: saved.number });
}
