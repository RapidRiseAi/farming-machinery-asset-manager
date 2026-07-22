import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse } from "../data";

/** Recurring-problems CSV: most-replaced parts + top fault categories (Scope §4.8). */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const { problems } = await getReportData(supabase, parseFilters(sp));

  const rows: (string | number)[][] = [["Most-replaced part", "Count"]];
  for (const p of problems.topParts) rows.push([p.name, p.count]);
  rows.push(["", ""], ["Top fault category", "Count"]);
  for (const ft of problems.topFaults) rows.push([ft.name, ft.count]);
  return csvResponse("recurring-problems.csv", toCsv(rows));
}
