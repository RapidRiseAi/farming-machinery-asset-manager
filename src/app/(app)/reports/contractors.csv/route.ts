import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Contractor analytics CSV (F13): outstanding quote/invoice value, throughput by status,
 *  responsiveness, and per-contractor spend. Farm-scoped by RLS; respects report filters. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const c = (await getReportData(supabase, parseFilters(sp), await currentFarmId(profile))).contractors;

  const rows: (string | number)[][] = [];
  rows.push(["Metric", "Count", "Value (R)"]);
  rows.push(["Outstanding quotes", c.outstandingQuotes.count, centsToR(c.outstandingQuotes.value)]);
  rows.push(["Outstanding invoices", c.outstandingInvoices.count, centsToR(c.outstandingInvoices.value)]);
  rows.push(["Spend via contractors", "", centsToR(c.spendViaContractors)]);
  rows.push([]);
  rows.push(["Responsiveness (avg hours)", "requested→viewed", c.responsiveness.requestedToViewedHrs ?? ""]);
  rows.push(["", "viewed→quoted", c.responsiveness.viewedToQuotedHrs ?? ""]);
  rows.push(["", "sample (requests)", c.responsiveness.sample]);
  rows.push([]);
  rows.push(["Work requests by status", "", ""]);
  for (const s of c.byStatus) rows.push([s.status, s.count, ""]);
  rows.push([]);
  rows.push(["Contractor", "Requests", "Invoiced", "Spend (R)"]);
  for (const p of c.perContractor) rows.push([p.name, p.requests, p.invoiced, centsToR(p.spend)]);

  return csvResponse("contractors.csv", toCsv(rows));
}
