import { requireRole, currentWorkshop, workshopEntitlementOr403 } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { pdfResponse } from "@/lib/pdf/doc";
import {
  loadSupplierStatement, buildSupplierStatementPdf, supplierStatementFilename,
} from "@/lib/pdf/supplier-statement";
import { isoDateOrNull, defaultSupplierPeriod, isUuid } from "@/lib/supplier-statement";

export const dynamic = "force-dynamic";

/**
 * A supplier statement as a PDF, on the partner's own letterhead (G25).
 *
 * The rendering lives in `lib/pdf/supplier-statement` so this route and anything emailed
 * later produce the same bytes. `app.supplier_statement` is SECURITY INVOKER and
 * `partner_expenses`/`suppliers` are workshop-scoped (0430/0480), so RLS decides: a guessed
 * supplier id belonging to another partner reads back no supplier row at all, and this
 * answers 404 rather than an empty statement carrying this partner's letterhead.
 *
 * The entitlement check answers 403 rather than redirecting — a 302 to HTML would hand the
 * caller a "PDF" full of markup (the F5 rule, restated by 0492).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });
  const denied = await workshopEntitlementOr403("financials", profile);
  if (denied) return denied;

  const { id } = await params;
  if (!isUuid(id)) return new Response("Bad request", { status: 400 });
  const url = new URL(request.url);
  const fallback = defaultSupplierPeriod();
  const from = isoDateOrNull(url.searchParams.get("from")) ?? fallback.from;
  const to = isoDateOrNull(url.searchParams.get("to")) ?? fallback.to;
  if (from > to) return new Response("Bad request", { status: 400 });

  const supabase = await createClient();
  const data = await loadSupplierStatement(supabase, {
    workshop,
    workshopId: workshop.id,
    supplierId: id,
    from,
    to,
    lang: profile.lang,
  });
  if (!data) return new Response("Not found", { status: 404 });

  return pdfResponse(await buildSupplierStatementPdf(data), supplierStatementFilename(data.party, to));
}
