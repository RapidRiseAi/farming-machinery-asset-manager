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

/**
 * Records one fuel draw and, when it names a machine and a meter, the driver-usage log
 * that goes with it — atomically (20260920090000).
 *
 * The cost is passed VAT-INCLUSIVE, as the farmer typed it off the pump slip. The command
 * converts it with the farm's own rate and stores ex-VAT cents with the rate captured, the
 * same arithmetic as the QR path and as `exVatCents`. The caller does not do money maths.
 */
export async function recordFuelIssue(
  supabase: SupabaseClient,
  input: {
    farmId: string;
    tankId: string;
    machineId?: string | null;
    date: string;
    litres: number;
    meterReading?: number | null;
    costInclCents?: number | null;
    activity?: string | null;
    driverUserId?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_fuel_issue", {
    p_farm: input.farmId,
    p_tank: input.tankId,
    p_machine: input.machineId ?? null,
    p_date: input.date,
    p_litres: input.litres,
    p_meter: input.meterReading ?? null,
    p_cost_incl_cents: input.costInclCents ?? null,
    p_activity: input.activity ?? null,
    p_driver_user: input.driverUserId ?? null,
  });
  return uuidResult(data, error);
}

/**
 * Voids one mistyped meter reading and rolls the machine back to what the surviving
 * history says (20260920100000). Returns the machine's reading after the correction, or
 * null when nothing is left to fall back to.
 */
export async function correctMeterReading(
  supabase: SupabaseClient,
  input: { farmId: string; machineId: string; readingId: string; reason?: string | null },
): Promise<number | null> {
  const { data, error } = await supabase.rpc("correct_meter_reading", {
    p_farm: input.farmId,
    p_machine: input.machineId,
    p_reading: input.readingId,
    p_reason: input.reason ?? null,
  });
  if (error) throw new FleetCommandError(error.code ?? "command_failed", error.message);
  return data === null || data === undefined ? null : Number(data);
}

/**
 * Records that a machine's hour meter or odometer was replaced: a new baseline, and a
 * service plan rebased by the difference (20260920100000).
 */
export async function recordMeterReplacement(
  supabase: SupabaseClient,
  input: {
    farmId: string;
    machineId: string;
    newReading: number;
    replacedOn: string;
    note?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_meter_replacement", {
    p_farm: input.farmId,
    p_machine: input.machineId,
    p_new_reading: input.newReading,
    p_replaced_on: input.replacedOn,
    p_note: input.note ?? null,
  });
  return uuidResult(data, error);
}
