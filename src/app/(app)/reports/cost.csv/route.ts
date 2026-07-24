import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Cost-per-machine CSV for the accountant (Scope §4.8). Farm-scoped by RLS. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const rows: (string | number)[][] = [["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Spend in period (R)", "TCO (R)", "Cost per hour (R)", "Cost per km (R)"]];
  for (const r of data.costPerMachine) {
    rows.push([
      r.name, centsToR(r.parts), centsToR(r.labour), centsToR(r.other), centsToR(r.total), centsToR(r.tco),
      r.perHour != null ? centsToR(r.perHour) : "", r.perKm != null ? centsToR(r.perKm) : "",
    ]);
  }
  return csvResponse("cost-per-machine.csv", toCsv(rows));
}
