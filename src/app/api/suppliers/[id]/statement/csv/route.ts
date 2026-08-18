import { requireRole, currentWorkshop, workshopEntitlementOr403 } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse, centsToR } from "@/app/(app)/reports/data";
import {
  withSupplierRunningBalance, supplierStatementTotals, supplierStatementLabel,
  isoDateOrNull, defaultSupplierPeriod, isUuid, type SupplierStatementRow,
} from "@/lib/supplier-statement";

export const dynamic = "force-dynamic";

/**
 * The supplier statement as a spreadsheet — for the partner's bookkeeper, who will want to
 * sort it, and for the supplier's, who will want to tie it to their own ledger.
 *
 * Same `app.supplier_statement` call as the screen and the PDF, so the three cannot
 * disagree. Amounts are GROSS (the supplier's ex-VAT figure plus their own VAT line) because
 * that is what leaves the bank and what /money's payables ageing already uses; the header
 * says so, since a column called "Charged (R)" in a spreadsheet has nobody standing beside
 * it to explain.
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
  // RLS is the access check: another partner's supplier reads back nothing here, so the
  // download is refused rather than served empty under this partner's name.
  const [{ data: who }, { data: stmt }] = await Promise.all([
    supabase.from("suppliers").select("id, name").eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.rpc("supplier_statement", {
      p_workshop: workshop.id, p_supplier: id, p_from: from, p_to: to,
    }),
  ]);
  if (!who) return new Response("Not found", { status: 404 });

  const supplier = who as { id: string; name: string };
  const rows = (stmt ?? []) as SupplierStatementRow[];
  const totals = supplierStatementTotals(rows);

  const out: (string | number)[][] = [
    ["Supplier statement", supplier.name],
    ["Period", `${from} to ${to}`],
    ["Amounts", "Include VAT — what left, or has to leave, the bank"],
    ["Due by", "Derived from this supplier's payment terms (30 days where none is on file)"],
    [],
    ["Date", "Type", "Their invoice", "Detail", "Category", "Due by", "Charged (R)", "Paid (R)", "Balance (R)"],
  ];
  for (const l of withSupplierRunningBalance(rows)) {
    out.push([
      l.entry_date,
      l.kind,
      l.reference ?? "",
      supplierStatementLabel(l, profile.lang),
      l.category ?? "",
      l.due_date ?? "",
      l.debit_cents ? centsToR(l.debit_cents) : "",
      l.credit_cents ? centsToR(l.credit_cents) : "",
      centsToR(l.balance_cents),
    ]);
  }

  out.push(
    [],
    ["Summary", "Amount (R)"],
    ["Balance brought forward", centsToR(totals.openingCents)],
    ["Invoiced by them", centsToR(totals.billedCents)],
    ["Paid to them", centsToR(-totals.paidCents)],
    ["Balance owed", centsToR(totals.closingCents)],
  );

  return csvResponse(`supplier-statement-${from}-to-${to}.csv`, toCsv(out));
}
