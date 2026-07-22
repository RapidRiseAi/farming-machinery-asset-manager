import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Cost-per-machine CSV for the accountant (Scope §4.8). Farm-scoped by RLS. */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp));

  const rows: (string | number)[][] = [["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Total (R)", "Cost per hour (R)"]];
  for (const r of data.costPerMachine) {
    rows.push([r.name, centsToR(r.parts), centsToR(r.labour), centsToR(r.other), centsToR(r.total), r.perHour != null ? centsToR(r.perHour) : ""]);
  }
  return csvResponse("cost-per-machine.csv", toCsv(rows));
}
