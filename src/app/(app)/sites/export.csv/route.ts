import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadSitesOverview, monthStart } from "@/lib/sites-overview";
import { csvResponse, toCsv } from "@/app/(app)/reports/data";

/**
 * The combined view of your farms as a CSV, the farm named on every row (Complete). Only
 * farms the page itself would show figures for are written: the person's own farms whose
 * plan includes the combined view. Money is in rand, ex VAT, where they may see it.
 */
export async function GET() {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const supabase = await createClient();
  const rows = (await loadSitesOverview(supabase, profile)).filter((r) => r.figures !== null);
  if (!rows.length) return new Response("Upgrade required", { status: 403 });
  const out: (string | number)[][] = [[
    "farm", "machines", "out_of_service", "open_faults", "overdue_services", "open_job_cards",
    `running_cost_since_${monthStart()}_rand_ex_vat`,
  ]];
  for (const r of rows) {
    const f = r.figures!;
    out.push([
      r.name, f.machines, f.outOfService, f.openFaults, f.overdueServices, f.openJobs,
      f.runningCostCents === null ? "" : (f.runningCostCents / 100).toFixed(2),
    ]);
  }
  return csvResponse(`fleetwise-sites-${monthStart()}.csv`, toCsv(out));
}
