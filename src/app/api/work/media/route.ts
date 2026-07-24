import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadWorkRequestMedia } from "@/lib/workrequest-media";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { workStatusStep } from "@/lib/work";

export const dynamic = "force-dynamic";

// The farm crew + the assigned contractor may attach media / record amounts.
const CREW = ["owner", "manager", "mechanic", "workshop"];
const KINDS = ["photo", "quote", "invoice"];

/**
 * Attach a quote / invoice / proof file to a work request and optionally record its
 * AMOUNT. An invoice amount is written to `work_requests.invoice_amount_cents` (ex-VAT),
 * which the 0311 sync trigger books as a single `invoice` cost_entry on the machine —
 * so the amount flows into TCO with NO double-count no matter how often it is edited.
 * A quote amount is recorded (never costed). The request is looked up through the
 * authenticated (RLS-scoped) client — which admits the farm crew AND the linked
 * workshop — so a caller can only reach their own farms; the file is stored via the
 * service role; amounts are written through the RLS client (farm-scoped by policy).
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active || !CREW.includes(profile.role)) {
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
    .select("id, farm_id, machine_id, status, vat_rate_bps")
    .eq("id", workRequestId)
    .is("deleted_at", null)
    .maybeSingle();
  const wr = wrData as { id: string; farm_id: string; machine_id: string; status: string; vat_rate_bps: number | null } | null;
  if (!wr) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const file = form.get("file");
  const stored = await uploadWorkRequestMedia(
    createServiceClient(), file instanceof File ? file : null, kind, wr.farm_id, wr.id, profile.id,
  );

  // Optional amount → the quote (recorded) or invoice (→ cost_entry via 0311) column.
  let amountRecorded = false;
  const amount = parseRandsToCents(String(form.get("amount") ?? ""));
  if ((kind === "invoice" || kind === "quote") && amount != null && amount > 0) {
    const bps = wr.vat_rate_bps ?? 1500;
    const inclVat = String(form.get("incl_vat") ?? "") === "1";
    const exVat = inclVat ? exVatCents(amount, bps) : amount;
    const col = kind === "invoice" ? "invoice_amount_cents" : "quote_amount_cents";
    const target = kind === "invoice" ? "invoiced" : "quoted";
    const advance = workStatusStep(wr.status) < workStatusStep(target);
    const { error } = await supabase
      .from("work_requests")
      .update({ [col]: exVat, vat_rate_bps: bps, ...(advance ? { status: target } : {}), updated_at: new Date().toISOString() })
      .eq("id", wr.id);
    if (error) return NextResponse.json({ error: "amount_update_failed" }, { status: 500 });

    await supabase.from("work_request_events").insert({
      farm_id: wr.farm_id, work_request_id: wr.id,
      from_status: wr.status, to_status: advance ? target : wr.status,
      note: String(form.get("note") ?? "").trim() || null, by_user: profile.id,
    });
    amountRecorded = true;
  }

  if (!stored && !amountRecorded) return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
  return NextResponse.json({ ok: true, stored, amountRecorded });
}
