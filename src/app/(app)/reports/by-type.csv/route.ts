import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse, centsToR } from "../data";

/** Spend-by-job-type CSV (Scope §4.8 farm maintenance summary). Farm-scoped by RLS. */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp));

  const rows: (string | number)[][] = [["Job type", "Total (R)"]];
  for (const r of data.byType) rows.push([r.type.replace(/_/g, " "), centsToR(r.total)]);
  return csvResponse("spend-by-type.csv", toCsv(rows));
}
