import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse } from "../data";
import { reportGrid } from "@/lib/report-export";

/** Utilisation & downtime CSV (G1 · §23) over the analysis window. Farm-scoped by RLS.
 *  The grid itself lives in src/lib/report-export.ts so this download and the emailed
 *  copy a schedule sends (FR-11.5) are the same columns, not two lists to keep in step. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const grid = reportGrid(data, "utilisation");
  return csvResponse(grid.filename, toCsv(grid.rows));
}
