import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth";
import type { AssistantMachine } from "./types";

type MachineRow = {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  status: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
};

type ServiceLineRow = {
  machine_id: string;
  status: "ok" | "due_soon" | "overdue";
  next_due_date: string | null;
  next_due_reading: number | null;
};

const STATUS_RANK = { ok: 1, due_soon: 2, overdue: 3 } as const;

export async function loadAssistantMachines(
  supabase: SupabaseClient,
  farmId: string,
  scope?: { role: Role; userId: string },
): Promise<AssistantMachine[]> {
  let machinesQuery = supabase
    .from("machines")
    .select("id, name, make, model, status, meter_type, current_reading, current_reading_date")
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .not("status", "in", "(retired,sold)")
    .order("name");
  if (scope?.role === "operator") {
    // RLS already understands the additive `see_all_vehicles` grant. Keep the
    // explicit assignment filter as defence in depth unless that signed-in user
    // has the active farm-scoped grant.
    const { data: fullFleetGrant, error: grantError } = await supabase
      .from("user_permission_grants")
      .select("id")
      .eq("farm_id", farmId)
      .eq("user_id", scope.userId)
      .eq("permission", "see_all_vehicles")
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (grantError || !fullFleetGrant) {
      machinesQuery = machinesQuery.eq("assigned_operator_id", scope.userId);
    }
  }
  const machinesResult = await machinesQuery;
  if (machinesResult.error) throw machinesResult.error;
  const machineRows = (machinesResult.data as MachineRow[] | null) ?? [];
  if (machineRows.length === 0) return [];
  const machineIds = machineRows.map((machine) => machine.id);

  const [aliasesResult, serviceResult] = await Promise.all([
    supabase
      .from("asset_aliases")
      .select("machine_id, alias")
      .eq("farm_id", farmId)
      .in("machine_id", machineIds)
      .is("deleted_at", null),
    supabase
      .from("service_plan_lines")
      .select("machine_id, status, next_due_date, next_due_reading")
      .eq("farm_id", farmId)
      .in("machine_id", machineIds)
      .is("deleted_at", null),
  ]);

  if (aliasesResult.error) throw aliasesResult.error;
  if (serviceResult.error) throw serviceResult.error;

  const aliases = new Map<string, string[]>();
  for (const row of (aliasesResult.data as Array<{ machine_id: string; alias: string }> | null) ?? []) {
    aliases.set(row.machine_id, [...(aliases.get(row.machine_id) ?? []), row.alias]);
  }

  const service = new Map<string, ServiceLineRow>();
  for (const line of (serviceResult.data as ServiceLineRow[] | null) ?? []) {
    const current = service.get(line.machine_id);
    if (!current || STATUS_RANK[line.status] > STATUS_RANK[current.status]) service.set(line.machine_id, line);
  }

  return machineRows.map((machine) => {
    const due = service.get(machine.id);
    return {
      id: machine.id,
      name: machine.name,
      make: machine.make,
      model: machine.model,
      aliases: aliases.get(machine.id) ?? [],
      status: machine.status,
      meterType: machine.meter_type,
      currentReading: machine.current_reading == null ? null : Number(machine.current_reading),
      currentReadingDate: machine.current_reading_date,
      serviceStatus: due?.status ?? null,
      nextDueDate: due?.next_due_date ?? null,
      nextDueReading: due?.next_due_reading == null ? null : Number(due.next_due_reading),
    };
  });
}

/**
 * The additive `see_all_vehicles` permission expands what an operator may
 * inspect, not which machines they may change. Keep this write scope separate
 * from `loadAssistantMachines` so the assistant cannot offer a confirmation
 * that the database's assignment checks will reject.
 */
export async function loadOperatorWritableMachineIds(
  supabase: SupabaseClient,
  farmId: string,
  userId: string,
): Promise<string[]> {
  const result = await supabase
    .from("machines")
    .select("id")
    .eq("farm_id", farmId)
    .eq("assigned_operator_id", userId)
    .is("deleted_at", null)
    .not("status", "in", "(retired,sold)");

  if (result.error) throw result.error;
  return ((result.data as Array<{ id: string }> | null) ?? []).map((machine) => machine.id);
}
