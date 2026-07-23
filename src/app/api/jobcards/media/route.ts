import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadJobCardMedia } from "@/lib/jobcard-media";
import { parseRandsToCents, exVatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

// Who may attach media / record invoices on a job card (Scope §2, §8).
const CREW = ["owner", "manager", "mechanic", "workshop"];
const KINDS = ["photo", "quote", "invoice"];

/**
 * Attach a quote / invoice / photo to a job card, and optionally record an invoice
 * AMOUNT as an `invoice` cost entry that flows into the asset's TCO (FR-8.2, FR-8.4,
 * FR-4.5). The job card is looked up through the authenticated (RLS-scoped) client so a
 * caller can only reach their own farm's cards; the file is stored via the service role;
 * the cost entry is inserted through the RLS client (farm-scoped by policy).
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

  const jobCardId = String(form.get("job_card_id") ?? "");
  const kindRaw = String(form.get("kind") ?? "photo");
  const kind = KINDS.includes(kindRaw) ? kindRaw : "photo";
  if (!jobCardId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const supabase = await createClient();
  // RLS scopes this to the caller's farm(s); an unauthorised id returns null.
  const { data: jcData } = await supabase
    .from("job_cards")
    .select("id, farm_id, machine_id, vat_rate_bps, date_out")
    .eq("id", jobCardId)
    .is("deleted_at", null)
    .maybeSingle();
  const jc = jcData as { id: string; farm_id: string; machine_id: string; vat_rate_bps: number; date_out: string | null } | null;
  if (!jc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const file = form.get("file");
  const stored = await uploadJobCardMedia(createServiceClient(), file instanceof File ? file : null, kind, jc.farm_id, jc.id, profile.id);

  // Recording an invoice amount raises the asset's TCO (FR-8.4).
  let invoiceRecorded = false;
  const amount = parseRandsToCents(String(form.get("invoice_amount") ?? ""));
  if (kind === "invoice" && amount != null && amount > 0) {
    const bps = jc.vat_rate_bps ?? 1500;
    const inclVat = String(form.get("incl_vat") ?? "") === "1";
    const exVat = inclVat ? exVatCents(amount, bps) : amount;
    const note = String(form.get("note") ?? "").trim() || null;
    const { error } = await supabase.from("cost_entries").insert({
      farm_id: jc.farm_id,
      machine_id: jc.machine_id,
      type: "invoice",
      amount_cents: exVat,
      vat_rate_bps: bps,
      source_type: "job_card",
      source_id: jc.id,
      occurred_on: jc.date_out ?? new Date().toISOString().slice(0, 10),
      note,
      created_by: profile.id,
    });
    if (error) return NextResponse.json({ error: "cost_insert_failed" }, { status: 500 });
    invoiceRecorded = true;
  }

  if (!stored && !invoiceRecorded) return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
  return NextResponse.json({ ok: true, stored, invoiceRecorded });
}
