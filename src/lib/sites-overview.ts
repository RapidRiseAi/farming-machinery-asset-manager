import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accessibleFarms, effectiveFarmRole, getFarmPlan, type Profile, type Role } from "@/lib/auth";
import { canViewFarmCosts } from "@/lib/cost-visibility";
import { planAllows, type Plan } from "@/lib/entitlements";
import { readAll } from "@/lib/supabase/read-all";
import { must } from "@/lib/supabase/must";

/**
 * The combined view of a person's farms (Complete, `multi_site`).
 *
 * Ordinary switching between the farms someone belongs to stays on every plan; what
 * Complete adds is seeing them together. So a farm is INCLUDED only when it is one the
 * person belongs to (their own membership, read through RLS) AND its own plan is Complete
 * or above. Membership is the access boundary: a farm on the same bill, or with the same
 * owner, contributes nothing unless this person can open it. Each figure is read under the
 * person's own access on that farm, so an operator's count is of what they can see, and
 * money only where that farm lets them see costs.
 *
 * Running cost this month is fuel, parts, labour, workshop invoices and other: the
 * figure the assistant calls running cost. Purchases and finance are not this month's
 * running of the fleet.
 */

const RUNNING_COST_TYPES = ["fuel", "parts", "labour", "invoice", "other"] as const;

export type SiteFigures = {
  machines: number;
  outOfService: number;
  openFaults: number;
  overdueServices: number;
  openJobs: number;
  /** Null when this person may not see this farm's costs. */
  runningCostCents: number | null;
};

export type SiteRow = {
  id: string;
  name: string;
  role: Role | null;
  plan: Plan;
  /** Figures only for a farm whose plan includes the combined view. */
  figures: SiteFigures | null;
};

/** The first day of this month as YYYY-MM-DD, in the farm's own time zone. */
export function monthStart(today: Date = new Date()): string {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit" })
    .format(today);
  return `${local}-01`;
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>, where: string): Promise<number> {
  const result = await query;
  if (result.error) must(result as never, where);
  return result.count ?? 0;
}

async function siteFigures(supabase: SupabaseClient, farmId: string, since: string): Promise<SiteFigures> {
  const [machines, outOfService, openFaults, overdueServices, openJobs, costsVisible] = await Promise.all([
    count(supabase.from("machines").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null)
      .not("status", "in", "(retired,sold)"), "sites:machines"),
    count(supabase.from("machines").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null)
      .eq("status", "out_of_service"), "sites:out-of-service"),
    count(supabase.from("faults").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null)
      .in("status", ["open", "in_job", "scheduled"]), "sites:faults"),
    count(supabase.from("service_plan_lines").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null)
      .eq("status", "overdue"), "sites:overdue"),
    count(supabase.from("job_cards").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null)
      .not("status", "in", "(completed,approved)"), "sites:jobs"),
    canViewFarmCosts(supabase, farmId),
  ]);
  let runningCostCents: number | null = null;
  if (costsVisible) {
    const rows = must(await readAll(() => supabase.from("cost_entries").select("id, amount_cents")
      .eq("farm_id", farmId).is("deleted_at", null).gte("occurred_on", since)
      .in("type", [...RUNNING_COST_TYPES])), "sites:costs") as { amount_cents: number | string }[] | null;
    runningCostCents = (rows ?? []).reduce((sum, r) => sum + (Number(r.amount_cents) || 0), 0);
  }
  return { machines, outOfService, openFaults, overdueServices, openJobs, runningCostCents };
}

/** Every farm this person belongs to, with figures for those on Complete or above. */
export async function loadSitesOverview(supabase: SupabaseClient, profile: Profile, today = new Date()): Promise<SiteRow[]> {
  const farms = await accessibleFarms(profile);
  const since = monthStart(today);
  return Promise.all(farms.map(async (farm) => {
    const [role, plan] = await Promise.all([effectiveFarmRole(farm.id, profile), getFarmPlan(farm.id)]);
    const figures = planAllows(plan, "multi_site") ? await siteFigures(supabase, farm.id, since) : null;
    return { id: farm.id, name: farm.name, role, plan, figures };
  }));
}

/** Totals over the included farms; money only over the farms whose costs this person sees. */
export function siteTotals(rows: SiteRow[]): SiteFigures & { costFarms: number } {
  const included = rows.map((r) => r.figures).filter((f): f is SiteFigures => f !== null);
  const sum = (k: keyof Omit<SiteFigures, "runningCostCents">) => included.reduce((a, f) => a + f[k], 0);
  const withCosts = included.filter((f) => f.runningCostCents !== null);
  return {
    machines: sum("machines"),
    outOfService: sum("outOfService"),
    openFaults: sum("openFaults"),
    overdueServices: sum("overdueServices"),
    openJobs: sum("openJobs"),
    runningCostCents: withCosts.length ? withCosts.reduce((a, f) => a + (f.runningCostCents ?? 0), 0) : null,
    costFarms: withCosts.length,
  };
}

