import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters } from "../data";
import { buildReportWorkbook } from "@/lib/report-export";

/**
 * Single multi-sheet Excel (.xlsx) workbook covering every report family (FR-11.4). One
 * worksheet per family the CSV routes cover, reusing the SAME header labels + row data,
 * but money as REAL NUMBERS in Rands (server-only OOXML writer; nothing ships to the
 * client). Farm-scoped by RLS; gated on "advanced_reports" exactly like the CSV routes.
 *
 * The sheets are built in src/lib/report-export.ts, which is also what a scheduled report
 * emails (FR-11.5) — so the workbook a person downloads and the one that arrives by post
 * on the 1st are the same file, not two implementations that agree today.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const workbook = buildReportWorkbook(data, "all");
  return new Response(new Uint8Array(workbook), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="fleetwise-reports.xlsx"',
    },
  });
}
