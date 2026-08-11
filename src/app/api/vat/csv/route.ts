import { requireRole, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse, centsToR } from "@/app/(app)/reports/data";
import { EMPTY_VAT_RETURN, type VatReturn } from "@/lib/expenses";

export const dynamic = "force-dynamic";

/**
 * The VAT return as a spreadsheet — the summary, then every document and expense behind
 * it, so the partner (or their accountant) can tie each figure back to a source document.
 *
 * A summary alone is not enough at filing time: SARS queries land months later and the
 * question is always "which invoices make up this number". Same RPC as the screen and the
 * PDF, so all three agree.
 */
export async function GET(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = await createClient();
  const [{ data: vatData }, { data: docs }, { data: exps }] = await Promise.all([
    supabase.rpc("partner_vat_return", { p_workshop: workshop.id, p_from: from, p_to: to }),
    supabase
      .from("partner_documents")
      .select("number, kind, status, issue_date, bill_to_name, bill_to_vat_number, subtotal_cents, discount_cents, vat_cents")
      .eq("workshop_id", workshop.id)
      .in("kind", ["invoice", "credit_note", "debit_note"])
      .in("status", ["sent", "part_paid", "paid", "written_off"])
      .gte("issue_date", from).lte("issue_date", to)
      .is("deleted_at", null)
      .order("issue_date"),
    supabase
      .from("partner_expenses")
      .select("supplier_name, supplier_vat_number, reference, category, expense_date, amount_cents, vat_cents, vat_claimable")
      .gte("expense_date", from).lte("expense_date", to)
      .is("deleted_at", null)
      .order("expense_date"),
  ]);

  const v = (((vatData ?? []) as VatReturn[])[0] ?? EMPTY_VAT_RETURN);
  const rows: (string | number)[][] = [
    ["VAT return", `${from} to ${to}`],
    ["Basis", "Invoice basis — VAT is declared when the invoice was issued, not when it was paid"],
    [],
    ["Summary", "Amount (R)"],
    ["Standard-rated sales (ex VAT)", centsToR(v.standard_ex_cents)],
    ["Zero-rated sales (ex VAT)", centsToR(v.zero_rated_cents)],
    ["Credit notes issued (ex VAT)", centsToR(-v.credits_ex_cents)],
    ["Output VAT", centsToR(v.output_vat_cents)],
    ["Purchases (ex VAT, claimable)", centsToR(v.input_ex_cents)],
    ["Input VAT", centsToR(v.input_vat_cents)],
    ["VAT paid but not claimable", centsToR(v.blocked_vat_cents)],
    [v.net_vat_cents >= 0 ? "NET PAYABLE TO SARS" : "NET REFUNDABLE", centsToR(Math.abs(v.net_vat_cents))],
    ["Of which declared on written-off invoices", centsToR(v.written_off_vat_cents)],
    [],
    ["Sales", "Date", "Document", "Customer", "Customer VAT no", "Ex VAT (R)", "VAT (R)"],
  ];

  for (const d of (docs ?? []) as Record<string, string | number | null>[]) {
    const sign = d.kind === "credit_note" ? -1 : 1;
    const net = sign * Math.max(0, Number(d.subtotal_cents) - Math.min(Number(d.discount_cents), Number(d.subtotal_cents)));
    rows.push([
      "", String(d.issue_date), String(d.number), String(d.bill_to_name ?? ""),
      String(d.bill_to_vat_number ?? ""), centsToR(net), centsToR(sign * Number(d.vat_cents)),
    ]);
  }

  rows.push([], ["Purchases", "Date", "Supplier", "Supplier VAT no", "Reference", "Category", "Ex VAT (R)", "VAT claimed (R)"]);
  for (const e of (exps ?? []) as Record<string, string | number | boolean | null>[]) {
    rows.push([
      "", String(e.expense_date), String(e.supplier_name), String(e.supplier_vat_number ?? ""),
      String(e.reference ?? ""), String(e.category),
      centsToR(Number(e.amount_cents)), e.vat_claimable ? centsToR(Number(e.vat_cents)) : centsToR(0),
    ]);
  }

  return csvResponse(`vat-return-${from}-to-${to}.csv`, toCsv(rows));
}
