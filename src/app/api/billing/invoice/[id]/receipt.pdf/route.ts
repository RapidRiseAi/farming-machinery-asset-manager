import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadReceipt } from "@/lib/billing/receipt";
import { buildBillingReceiptPdf } from "@/lib/pdf/billing-receipt";
import { pdfResponse } from "@/lib/pdf/doc";

/**
 * The receipt for an invoice, on demand.
 *
 * ── Why this was missing and why it matters ──────────────────────────────────
 * `buildBillingReceiptPdf` was only ever reached from `sendDueReceipts`, so the receipt
 * existed exactly once — in an email. If that mail bounced, was deleted, or went to an
 * address that turned out to be wrong, the customer had no way to get the document their
 * own bookkeeping needs, and neither did we without running a script.
 *
 * ── The guard is RLS, not a check written here ───────────────────────────────
 * The read goes through the CALLER's client and the SELECT policy on `billing_invoices` is
 * `app.is_farm_billing_admin(farm_id)`. So an invoice belonging to another farm, or to this
 * farm but requested by a driver, simply is not there — no farm_id comparison for somebody
 * to forget, and no way for this route to be more permissive than every other surface.
 *
 * ── A receipt is not an invoice ──────────────────────────────────────────────
 * This refuses anything not `paid`. The document says "Paid in full", and serving it for
 * money that has not arrived would be handing somebody a false record of payment — which is
 * worse than not offering the download at all. Wanting a copy of what you OWE is a real
 * need and a different document; it is not this one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // `getProfile` rather than `requireProfile`: the latter REDIRECTS to /login, and anything
  // that follows redirects — a browser download, curl -L, a script — would save the HTML
  // login page as "FW-2026-000005.pdf". The VAT routes settled this when they shipped: a
  // file endpoint answers with a status, not a page.
  const profile = await getProfile();
  if (!profile || !profile.active) {
    return NextResponse.json({ error: "auth" }, { status: 401 });
  }
  const supabase = await createClient();

  const { data } = await supabase
    .from("billing_invoices")
    .select("id, invoice_ref, status")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const invoice = data as { id: string; invoice_ref: string; status: string } | null;

  // Not found and not allowed are answered identically, on purpose: telling somebody an
  // invoice exists but is not theirs is itself a disclosure.
  if (!invoice) return NextResponse.json({ error: "not-found" }, { status: 404 });

  if (invoice.status !== "paid") {
    return NextResponse.json({ error: "billing-not-paid" }, { status: 409 });
  }

  const receipt = await loadReceipt(supabase, invoice.id, profile.lang);
  if (!receipt) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const pdf = await buildBillingReceiptPdf(receipt);
  return pdfResponse(pdf, `${invoice.invoice_ref}.pdf`);
}
