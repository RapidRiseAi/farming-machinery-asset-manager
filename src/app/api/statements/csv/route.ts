import { requireRole, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse, centsToR } from "@/app/(app)/reports/data";
import { withRunningBalance, statementLabel, type StatementRow } from "@/lib/statement";
import { parseStatementParty } from "@/lib/statement-party";

export const dynamic = "force-dynamic";

/**
 * The statement as a spreadsheet — for the partner's bookkeeper, who will want to sort it.
 *
 * Same `app.partner_statement` call as the screen and the PDF, so the three cannot
 * disagree. Money is written in rands with the sign convention a ledger uses: charges
 * positive, credits and payments positive in their own column, and a running balance.
 */
export async function GET(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });

  const party = parseStatementParty(new URL(request.url).searchParams);
  if (!party) return new Response("Bad request", { status: 400 });
  const { from, to } = party;

  const supabase = await createClient();
  const { data } = await supabase.rpc("partner_statement", {
    p_workshop: workshop.id,
    p_farm: party.farmId,
    p_client: party.clientId,
    p_from: from,
    p_to: to,
  });

  const rows: (string | number)[][] = [
    ["Date", "Type", "Reference", "Detail", "Charged (R)", "Paid off (R)", "Balance (R)", "Due"],
  ];
  for (const l of withRunningBalance((data ?? []) as StatementRow[])) {
    rows.push([
      l.entry_date,
      l.kind,
      l.reference ?? "",
      statementLabel(l, profile.lang),
      l.debit_cents ? centsToR(l.debit_cents) : "",
      l.credit_cents ? centsToR(l.credit_cents) : "",
      centsToR(l.balance_cents),
      l.due_date ?? "",
    ]);
  }

  return csvResponse(`statement-${from}-to-${to}.csv`, toCsv(rows));
}
