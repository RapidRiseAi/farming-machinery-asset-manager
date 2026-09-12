import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse } from "../data";
import { reportGrid } from "@/lib/report-export";
import { canViewFarmCosts } from "@/lib/cost-visibility";

/** Per-machine fuel CSV (litres, spend, consumption) for the SARS diesel logbook basis (Scope §9).
 *  The grid itself lives in src/lib/report-export.ts so this download and the emailed
 *  copy a schedule sends (FR-11.5) are the same columns, not two lists to keep in step. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("fuel", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  if (!(await canViewFarmCosts(supabase, farmId)))
    return new Response("Cost access is disabled", { status: 403 });
  const data = await getReportData(supabase, parseFilters(sp), farmId);

  const grid = reportGrid(data, "fuel");
  return csvResponse(grid.filename, toCsv(grid.rows));
}
