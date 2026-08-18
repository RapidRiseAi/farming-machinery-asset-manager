import { requireRole, currentWorkshop, workshopEntitlementOr403 } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse, centsToR } from "@/app/(app)/reports/data";
import { remittanceTotals, isoDateOrNull, isUuid, type RemittanceRow } from "@/lib/supplier-statement";

export const dynamic = "force-dynamic";

/**
 * The remittance as a spreadsheet.
 *
 * Some suppliers want the PDF for their file and some want the rows to paste into their own
 * ledger, and a partner should not have to retype the second from the first. Same
 * `app.supplier_remittance` call as the screen and the PDF.
 *
 * Ex-VAT and VAT are separate columns here, unlike the statement's single gross figure: the
 * supplier is reconciling each line against their own tax invoice, which shows both.
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
  const [{ data: who }, { data: rowData }] = await Promise.all([
    supabase.from("suppliers").select("id, name, account_number").eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.rpc("supplier_remittance", {
      p_workshop: workshop.id, p_supplier: id, p_paid_on: paidOn,
    }),
  ]);
  if (!who) return new Response("Not found", { status: 404 });

  const supplier = who as { id: string; name: string; account_number: string | null };
  const rows = (rowData ?? []) as RemittanceRow[];
  const totals = remittanceTotals(rows);

  const out: (string | number)[][] = [
    ["Remittance advice", supplier.name],
    ["Payment date", paidOn],
    // The number the supplier quotes back on the phone, and the one thing that lets them
    // allocate the payment without ringing to ask who sent it.
    ["Our account with you", supplier.account_number ?? ""],
    [],
    ["Your invoice", "Dated", "Detail", "Category", "Ex VAT (R)", "VAT (R)", "Total (R)"],
  ];
  for (const r of rows) {
    out.push([
      r.reference ?? "",
      r.expense_date,
      r.description ?? "",
      r.category ?? "",
      centsToR(r.amount_cents),
      centsToR(r.vat_cents),
      centsToR(r.total_cents),
    ]);
  }

  out.push(
    [],
    ["Invoices settled", totals.bills],
    ["Ex VAT (R)", centsToR(totals.exCents)],
    ["VAT (R)", centsToR(totals.vatCents)],
    ["Paid (R)", centsToR(totals.totalCents)],
  );

  return csvResponse(`remittance-${paidOn}.csv`, toCsv(out));
}
