import type { SupabaseClient } from "@supabase/supabase-js";

export class FleetCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FleetCommandError";
  }
}

function uuidResult(data: unknown, error: { code?: string; message: string } | null): string {
  if (error) throw new FleetCommandError(error.code ?? "command_failed", error.message);
  if (typeof data !== "string" || !/^[0-9a-f-]{36}$/i.test(data)) {
    throw new FleetCommandError("command_failed", "The operation did not return a record ID.");
  }
  return data;
}

/** Atomic, RLS-bound fault creation used by forms and assistant confirmation. */
export async function recordFault(
  supabase: SupabaseClient,
  input: {
    farmId: string;
    machineId: string;
    description: string;
    urgency: "can_work" | "limping" | "stopped";
    category?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_fault", {
    p_farm: input.farmId,
    p_machine: input.machineId,
    p_description: input.description,
    p_urgency: input.urgency,
    p_category: input.category ?? null,
  });
  return uuidResult(data, error);
}

/** Atomic reading + driver-usage capture. The DB trigger advances service state. */
export async function recordMeterReading(
  supabase: SupabaseClient,
  input: {
    farmId: string;
    machineId: string;
    reading: number;
    readingDate: string;
    driverUserId?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_meter_reading", {
    p_farm: input.farmId,
    p_machine: input.machineId,
    p_reading: input.reading,
    p_reading_date: input.readingDate,
    p_driver_user: input.driverUserId ?? null,
  });
  return uuidResult(data, error);
}

/**
 * Records a generic completed-service card and meter reading atomically. It deliberately
 * does not claim or reset any scheduled service-plan line without a later, explicit
 * human selection of the work that was actually completed.
 */
export async function recordCompletedService(
  supabase: SupabaseClient,
  input: {
    farmId: string;
    machineId: string;
    reading: number;
    serviceDate: string;
    workPerformed?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_completed_service", {
    p_farm: input.farmId,
    p_machine: input.machineId,
    p_meter_reading: input.reading,
    p_service_date: input.serviceDate,
    p_work_performed: input.workPerformed ?? null,
  });
  return uuidResult(data, error);
}
