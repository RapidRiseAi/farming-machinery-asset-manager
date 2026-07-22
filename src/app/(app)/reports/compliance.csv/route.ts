import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters, toCsv, csvResponse } from "../data";

/** Service-compliance CSV: status counts + current overdue list (Scope §4.8). */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const { compliance } = await getReportData(supabase, parseFilters(sp));

  const rows: (string | number)[][] = [
    ["Metric", "Value"],
    ["OK", compliance.ok],
    ["Due soon", compliance.dueSoon],
    ["Overdue", compliance.overdue],
    ["", ""],
    ["Overdue machine", "Task"],
  ];
  for (const o of compliance.overdueList) rows.push([o.name, o.task]);
  return csvResponse("service-compliance.csv", toCsv(rows));
}
