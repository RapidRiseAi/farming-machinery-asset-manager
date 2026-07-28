import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse } from "../data";

/** Utilisation & downtime CSV (G1 · §23). used/idle in the machine's meter unit; downtime
 *  days over the analysis window. Farm-scoped by RLS. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));
  const w = data.utilisation.window;

  const rows: (string | number)[][] = [
    [`Utilisation & downtime — ${w.from} to ${w.to}`],
    ["Machine", "Meter", "Used", "Utilisation %", "Idle", "Downtime (days)"],
  ];
  for (const r of data.utilisation.perMachine) {
    const unit = r.meterType === "km" ? "km" : r.meterType === "hours" ? "h" : "";
    rows.push([
      r.name,
      r.meterType,
      r.used != null ? `${r.used.toFixed(r.meterType === "km" ? 0 : 1)} ${unit}`.trim() : "",
      r.pct != null ? r.pct.toFixed(0) : "",
      r.idle != null ? `${r.idle.toFixed(r.meterType === "km" ? 0 : 1)} ${unit}`.trim() : "",
      r.downtimeDays.toFixed(1),
    ]);
  }
  return csvResponse("utilisation-downtime.csv", toCsv(rows));
}
