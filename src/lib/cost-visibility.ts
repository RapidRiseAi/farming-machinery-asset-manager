import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type MachineFinancials = {
  machine_id: string;
  farm_id: string;
  purchase_price_cents: number | null;
  supplier: string | null;
  finance_provider: string | null;
  finance_total_cents: number | null;
  finance_monthly_cents: number | null;
  finance_term_months: number | null;
  finance_interest_bps: number | null;
};

/** Ask the database for the caller's effective, resource-farm cost permission. */
export async function canViewFarmCosts(
  supabase: SupabaseClient,
  farmId: string | null | undefined,
): Promise<boolean> {
  if (!farmId) return false;
  const { data, error } = await supabase.rpc("can_view_farm_costs", { p_farm: farmId });
  return !error && data === true;
}

/**
 * Read the machine columns deliberately removed from authenticated table SELECTs.
 * The SECURITY DEFINER RPC repeats cost and machine-visibility checks before returning
 * a row, so `null` is the fail-closed result for both denial and a missing machine.
 */
export async function readMachineFinancials(
  supabase: SupabaseClient,
  machineId: string,
): Promise<MachineFinancials | null> {
  const { data, error } = await supabase
    .rpc("machine_financials", { p_machine: machineId })
    .maybeSingle();
  return error ? null : (data as MachineFinancials | null);
}
