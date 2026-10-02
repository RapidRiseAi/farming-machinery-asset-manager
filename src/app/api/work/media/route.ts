import { NextResponse } from "next/server";
import { effectiveFarmRole, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadWorkRequestMedia } from "@/lib/workrequest-media";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { canRecordWorkAmount } from "@/lib/work-lifecycle";
import { sameOrigin } from "@/lib/security/same-origin";

export const dynamic = "force-dynamic";

// The farm crew + the assigned contractor may attach media / record amounts.
const CREW = ["owner", "manager", "mechanic", "workshop"];
const KINDS = ["photo", "quote", "invoice"];

/**
 * Attach a quote / invoice / proof file to a work request and optionally record its
 * AMOUNT. An invoice amount is written to `work_requests.invoice_amount_cents` (ex-VAT),
 * which the 0311 sync trigger books as a single `invoice` cost_entry on the machine -
 * so the amount flows into TCO with NO double-count no matter how often it is edited.
 * A quote amount is recorded (never costed). The request is looked up through the
 * authenticated (RLS-scoped) client, which admits the farm crew AND the linked
 * workshop, so a caller can only reach their own farms; the file is stored via the
 * service role; amounts are written through the RLS client (farm-scoped by policy).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const profile = await getProfile();
  if (!profile || !profile.active) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const workRequestId = String(form.get("work_request_id") ?? "");
  const kindRaw = String(form.get("kind") ?? "photo");
  const kind = KINDS.includes(kindRaw) ? kindRaw : "photo";
  if (!workRequestId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const supabase = await createClient();
  const { data: wrData } = await supabase
    .from("work_requests")
    .select("id, farm_id, machine_id, workshop_id, status, vat_rate_bps")
    .eq("id", workRequestId)
    .is("deleted_at", null)
    .maybeSingle();
  const wr = wrData as { id: string; farm_id: string; machine_id: string; workshop_id: string | null; status: string; vat_rate_bps: number | null } | null;
  if (!wr) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // A primary-farm owner can be an operator here; primary role is not authority.
  // Workshop access is already constrained to the linked request by RLS above.
  const role = profile.role === "workshop" ? "workshop" : await effectiveFarmRole(wr.farm_id, profile);
  if (!role || !CREW.includes(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (role === "workshop" && (!wr.workshop_id || profile.workshop_id !== wr.workshop_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (wr.status === "closed") return NextResponse.json({ error: "locked" }, { status: 409 });
  if ((kind === "quote" || kind === "invoice") && (role === "mechanic" || !wr.workshop_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Validate every amount before uploading. Farm users can file an issued supplier
  // document, but only that supplier may author its price and move the billing stage.
  const rawAmount = String(form.get("amount") ?? "").trim();
  const amount = parseRandsToCents(rawAmount);
  if (rawAmount && (kind !== "invoice" && kind !== "quote")) {
    return NextResponse.json({ error: "need-amount" }, { status: 400 });
  }
  if (rawAmount && (kind === "invoice" || kind === "quote")) {
    if (!canRecordWorkAmount(kind, wr.status, role, !!wr.workshop_id)) {
      return NextResponse.json({ error: "work-transition" }, { status: 409 });
    }
    if (amount == null || amount < 0 || (kind === "quote" && amount === 0)) return NextResponse.json({ error: "need-amount" }, { status: 400 });
    const { data: documents, error } = await supabase.from("partner_documents").select("id")
      .eq("work_request_id", wr.id).eq("kind", kind).neq("status", "void").is("deleted_at", null).limit(1);
    if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
    if (documents?.length) return NextResponse.json({ error: "work-use-document" }, { status: 409 });
  }

  const file = form.get("file");
  if (file instanceof File && file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }
  const stored = await uploadWorkRequestMedia(
    createServiceClient(), file instanceof File ? file : null, kind, wr.farm_id, wr.id, profile.id,
  );
  if (file instanceof File && file.size > 0 && !stored) {
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  // Optional amount → the quote (recorded) or invoice (→ cost_entry via 0311) column.
  let amountRecorded = false;
  if ((kind === "invoice" || kind === "quote") && rawAmount && amount != null && amount >= 0) {
    const bps = wr.vat_rate_bps ?? 1500;
    const inclVat = String(form.get("incl_vat") ?? "") === "1";
    const exVat = inclVat ? exVatCents(amount, bps) : amount;
    const { error } = await supabase.rpc("update_work_request", {
      p_request: wr.id,
      [kind === "invoice" ? "p_invoice_cents" : "p_quote_cents"]: exVat,
      p_note: String(form.get("note") ?? "").trim() || null,
    });
    if (error) return NextResponse.json({ error: stored ? "work-file-saved-amount-failed" : error.message, stored }, { status: 409 });
    amountRecorded = true;
  }

  if (!stored && !amountRecorded) return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
  return NextResponse.json({ ok: true, stored, amountRecorded });
}
