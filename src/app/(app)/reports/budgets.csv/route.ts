import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Budget-vs-actual CSV (G1 · FR-10.4). Farm-scoped by RLS. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const rows: (string | number)[][] = [
    ["Scope", "Category", "Period", "From", "To", "Budget (R)", "Actual (R)", "Variance (R)", "Used %", "Status"],
  ];
  for (const b of data.budgets) {
    rows.push([
      b.machineId ? b.scope : "Whole farm",
      b.category ?? "All categories",
      b.periodType,
      b.periodStart,
      b.periodEnd,
      centsToR(b.amount),
      centsToR(b.actual),
      centsToR(b.variance),
      b.pct != null ? b.pct.toFixed(0) : "",
      b.status === "over" ? "Over budget" : b.status === "warning" ? "Near limit" : "Under budget",
    ]);
  }
  return csvResponse("budget-vs-actual.csv", toCsv(rows));
}
