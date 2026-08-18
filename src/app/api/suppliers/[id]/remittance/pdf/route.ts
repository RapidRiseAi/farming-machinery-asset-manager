import { requireRole, currentWorkshop, workshopEntitlementOr403 } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { pdfResponse } from "@/lib/pdf/doc";
import {
  loadSupplierRemittance, buildSupplierRemittancePdf, supplierRemittanceFilename,
} from "@/lib/pdf/supplier-statement";
import { isoDateOrNull, isUuid } from "@/lib/supplier-statement";

export const dynamic = "force-dynamic";

/**
 * A remittance advice as a PDF, on the partner's own letterhead (G25).
 *
 * The document that stops an argument: one EFT covering six invoices, allocated by the
 * person who sent the money rather than guessed at by the person who received it. Without
 * one, a supplier commonly settles the oldest invoice and chases the partner for money they
 * have already been paid.
 *
 * The payment date is REQUIRED and not defaulted. Everything else on this feature has a
 * sensible fallback window; a remittance does not, because guessing the date would produce a
 * document asserting that a payment was made on a day it may not have been, addressed to
 * somebody who will act on it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });
  const denied = await workshopEntitlementOr403("financials", profile);
  if (denied) return denied;

  const { id } = await params;
  if (!isUuid(id)) return new Response("Bad request", { status: 400 });

  const paidOn = isoDateOrNull(new URL(request.url).searchParams.get("paid"));
  if (!paidOn) return new Response("Bad request", { status: 400 });

  const supabase = await createClient();
  const data = await loadSupplierRemittance(supabase, {
    workshop,
    workshopId: workshop.id,
    supplierId: id,
    paidOn,
    lang: profile.lang,
  });
  if (!data) return new Response("Not found", { status: 404 });

  return pdfResponse(
    await buildSupplierRemittancePdf(data),
    supplierRemittanceFilename(data.party, paidOn),
  );
}
