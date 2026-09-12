import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadReceipt } from "@/lib/billing/receipt";
import { buildBillingReceiptPdf } from "@/lib/pdf/billing-receipt";
import { pdfResponse } from "@/lib/pdf/doc";

/**
 * The bill itself — what is owed, by when, and how to pay it.
 *
 * ── Why this is a second route and not a flag on the first ───────────────────
 * The receipt route refuses anything not `paid`, and it is right to: that document says
 * "Paid in full", and serving it for money that has not arrived would hand somebody a
 * false record of payment. But that left the OTHER document — the one a farm office
 * actually needs in order to get a bill paid — existing nowhere at all. Not on the
 * screen, not in an email, not in the product. A farm that pays against invoices had
 * nothing to file, and the only way to obtain one was to ask Rapid Rise.
 *
 * Two routes rather than `?kind=`, because the rule about WHO may download WHAT is
 * different for each, and a rule expressed as a query parameter is a rule somebody will
 * eventually pass the wrong way round.
 *
 * ── The guard is RLS, not a check written here ───────────────────────────────
 * The read goes through the CALLER's client and the SELECT policy on `billing_invoices`
 * is `app.is_farm_billing_admin(farm_id)`. An invoice belonging to another farm, or to
 * this farm but requested by a driver, simply is not there — no farm_id comparison for
 * somebody to forget, and no way for this route to be more permissive than every other
 * surface. Not-found and not-allowed are answered identically on purpose: telling
 * somebody an invoice exists but is not theirs is itself a disclosure.
 *
 * ── What it refuses, and why each one ────────────────────────────────────────
 * A `draft` invoice has not been issued. The generator assembles as draft and issues in
 * the same transaction (that ordering was itself a defect once — `billing_freeze_invoice_line`
 * refuses lines on an issued invoice), so a draft sitting on screen means something went
 * wrong upstream, and handing it over as a bill would be asking for money nobody has
 * decided to charge.
 *
 * A `void` invoice should not exist. Serving it as a bill is the clearest possible way to
 * have somebody pay a charge that was withdrawn.
 *
 * `uncollectible` is deliberately NOT refused: it is still a real debt, written off in
 * our books rather than forgiven, and a customer asking for a copy of it should get one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // `getProfile`, never `requireProfile`: the latter REDIRECTS to /login, and anything
  // that follows redirects — a browser download, `curl -L`, a script — would save the
  // HTML login page as "FW-2026-000005.pdf". A file endpoint answers with a status, not
  // a page. The VAT routes settled this when they shipped.
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

  if (!invoice) return NextResponse.json({ error: "not-found" }, { status: 404 });

  if (invoice.status === "draft") {
    return NextResponse.json({ error: "billing-not-issued" }, { status: 409 });
  }
  if (invoice.status === "void") {
    return NextResponse.json({ error: "billing-voided" }, { status: 409 });
  }

  const doc = await loadReceipt(supabase, invoice.id, profile.lang, "invoice");
  if (!doc) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const pdf = await buildBillingReceiptPdf(doc);
  return pdfResponse(pdf, `${invoice.invoice_ref}.pdf`);
}
