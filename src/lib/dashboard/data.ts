import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAll } from "@/lib/supabase/read-all";
import { mustAll } from "@/lib/supabase/must";
import type { SourceKey } from "./widgets";

/**
 * The rows the dashboard's widgets count, read once per page load and only for the
 * sources the board on screen uses. Every read goes through RLS as the signed-in
 * person, and money comes from the `_visible` views, which blank it for anyone who may
 * not see costs, so a widget can never show more than the screen it links to.
 *
 * Every read or none (`mustAll`): one failed read once showed an owner "0 overdue, 0
 * open faults", the most reassuring board there is, and false.
 */

export type DashMachine = {
  id: string; name: string; status: string; meter_type: string;
  current_reading: number | null; current_reading_date: string | null;
  warranty_expiry_date: string | null; warranty_expiry_hours: number | null;
  assigned_operator_id: string | null;
};
type DashService = { machine_id: string; status: string; task: string; next_due_date: string | null };
type DashFault = { id: string; machine_id: string; description: string | null; urgency: string | null; status: string; created_at: string };
type DashJobCard = { machine_id: string; type: string; status: string; total_cents: number | null; date_in: string | null; date_out: string | null };
type DashFuel = { machine_id: string | null; date: string; litres: number | null; cost_cents: number | null; anomaly_notified_at: string | null };
type DashLicence = { id: string; machine_id: string; type: string; expiry_date: string; reminder_lead_days: number };
type DashFine = { id: string; machine_id: string; offence: string | null; notice_number: string | null; nomination_deadline: string | null; status: string };

export type DashData = {
  now: Date;
  machines: DashMachine[];
  service: DashService[];
  faults: DashFault[];
  jobCards: DashJobCard[];
  fuel: DashFuel[];
  licences: DashLicence[];
  fines: DashFine[];
};

/** History reaches back far enough for the longest period a widget offers (12 months). */
const HISTORY_MONTHS = 13;
const OPEN_JOB_STATUSES = ["reported", "open", "in_progress", "waiting_parts"];

export async function loadDashData(
  supabase: SupabaseClient,
  farmId: string | null,
  needed: Set<SourceKey>,
  now = new Date(),
): Promise<DashData> {
  const byFarm = <Q,>(q: Q): Q => (farmId ? (q as { eq(c: string, v: string): Q }).eq("farm_id", farmId) : q);
  const since = new Date(now.getFullYear(), now.getMonth() - HISTORY_MONTHS + 1, 1);
  const sinceDate = since.toISOString().slice(0, 10);
  const none = Promise.resolve({ data: [], error: null });

  const [machines, service, faults, jobCards, fuel, licences, fines] = await Promise.all([
    // Machines are read for every board: retired and sold drop out of every count.
    readAll(() => byFarm(supabase.from("machines")
      .select("id, name, status, meter_type, current_reading, current_reading_date, warranty_expiry_date, warranty_expiry_hours, assigned_operator_id")
      .is("deleted_at", null).order("name"))),
    needed.has("service")
      ? readAll(() => byFarm(supabase.from("service_plan_lines").select("machine_id, status, task, next_due_date").is("deleted_at", null)))
      : none,
    needed.has("faults")
      ? readAll(() => byFarm(supabase.from("faults").select("id, machine_id, description, urgency, status, created_at")
          .is("deleted_at", null).or(`status.neq.resolved,created_at.gte.${since.toISOString()}`)
          .order("created_at", { ascending: false })))
      : none,
    needed.has("jobCards")
      ? readAll(() => byFarm(supabase.from("job_cards_visible").select("machine_id, type, status, total_cents, date_in, date_out")
          .is("deleted_at", null).or(`date_out.gte.${sinceDate},status.in.(${OPEN_JOB_STATUSES.join(",")})`)))
      : none,
    needed.has("fuel")
      ? readAll(() => byFarm(supabase.from("fuel_issues_visible").select("machine_id, date, litres, cost_cents, anomaly_notified_at")
          .is("deleted_at", null).gte("date", sinceDate)))
      : none,
    needed.has("licences")
      ? readAll(() => byFarm(supabase.from("licences").select("id, machine_id, type, expiry_date, reminder_lead_days").is("deleted_at", null)))
      : none,
    needed.has("fines")
      ? readAll(() => byFarm(supabase.from("fines").select("id, machine_id, offence, notice_number, nomination_deadline, status")
          .in("status", ["received", "driver_identified"]).is("deleted_at", null)))
      : none,
  ]);
  mustAll([machines, service, faults, jobCards, fuel, licences, fines], "dashboard");

  return {
    now,
    machines: (machines.data as DashMachine[] | null) ?? [],
    service: (service.data as DashService[] | null) ?? [],
    faults: (faults.data as DashFault[] | null) ?? [],
    jobCards: (jobCards.data as DashJobCard[] | null) ?? [],
    fuel: (fuel.data as DashFuel[] | null) ?? [],
    licences: (licences.data as DashLicence[] | null) ?? [],
    fines: (fines.data as DashFine[] | null) ?? [],
  };
}
