import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Per-machine fuel CSV (litres, spend, consumption) for the accountant / SARS diesel
 *  logbook basis (Scope §9). Farm-scoped by RLS; respects the report period + filters. */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("fuel", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const rows: (string | number)[][] = [["Machine", "Litres", "Fuel spend (R)", "Consumption", "Unit"]];
  for (const r of data.fuel.perMachine) {
    rows.push([
      r.name,
      r.litres,
      centsToR(r.spend),
      r.consumption != null ? r.consumption.toFixed(2) : "",
      r.consumption != null ? (r.meterType === "km" ? "L/100km" : "L/hr") : "",
    ]);
  }
  rows.push([]);
  rows.push(["Purchased (deliveries) litres", data.fuel.purchasedLitres, "spend (R)", centsToR(data.fuel.purchasedSpend)]);
  rows.push(["Used by machines (draws) litres", data.fuel.totalLitres, "spend (R)", centsToR(data.fuel.totalSpend)]);
  return csvResponse("fuel.csv", toCsv(rows));
}
