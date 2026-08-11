import { requireRole, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { pdfResponse } from "@/lib/pdf/doc";
import { loadStatement, buildStatementPdf, statementFilename } from "@/lib/pdf/statement";
import { parseStatementParty } from "@/lib/statement-party";

export const dynamic = "force-dynamic";

/**
 * A statement of account as a PDF, on the partner's letterhead.
 *
 * The rendering lives in `lib/pdf/statement` so this route and the emailed copy produce
 * the same bytes. `app.partner_statement` is SECURITY INVOKER, so RLS decides whether
 * this partner may see that customer's ledger; a guessed id returns an empty statement
 * rather than someone else's.
 */
export async function GET(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const party = parseStatementParty(url.searchParams);
  if (!party) return new Response("Bad request", { status: 400 });

  const supabase = await createClient();
  const data = await loadStatement(supabase, {
    workshop,
    workshopId: workshop.id,
    farmId: party.farmId,
    clientId: party.clientId,
    from: party.from,
    to: party.to,
    lang: profile.lang,
  });

  return pdfResponse(await buildStatementPdf(data), statementFilename(data.party, party.to));
}
