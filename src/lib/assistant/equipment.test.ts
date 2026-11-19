import assert from "node:assert/strict";
import { test } from "node:test";

import { equipmentRefusal } from "./equipment";
import { fuelSummary, type FarmDataScope } from "./farm-data";
import { ASSISTANT_INTENTS, type AssistantMachine } from "./types";

// Scenario 36: equipment commands cannot create fuel records or fuel analytics, even on Complete.

const PUMP: AssistantMachine = {
  id: "a3600000-0000-4000-9000-000000000001", name: "Borehole pump", make: null, model: null,
  type: "pump_generator", aliases: [], status: "active", meterType: "hours", profile: "equipment",
} as AssistantMachine;
const TRACTOR: AssistantMachine = {
  id: "a3600000-0000-4000-9000-000000000002", name: "JD 6120", make: "John Deere", model: "6120",
  type: "tractor", aliases: [], status: "active", meterType: "hours", profile: "full",
} as AssistantMachine;

test("support equipment refuses a diesel draw and nothing else the assistant can write", () => {
  for (const intent of ASSISTANT_INTENTS) {
    const want = intent === "log_fuel" ? "equipment-refused-fuel" : null;
    assert.equal(equipmentRefusal(intent, PUMP), want, intent);
    assert.equal(equipmentRefusal(intent, TRACTOR), null, `${intent} on a full asset`);
  }
  // A row read before the profile column existed is a full asset, as every existing asset is.
  assert.equal(equipmentRefusal("log_fuel", { profile: null }), null);
  assert.equal(equipmentRefusal("log_fuel", null), null, "no asset matched yet: the next question decides");
  assert.equal(equipmentRefusal(null, PUMP), null);
});

/** A database where every query is empty and only the fuel functions answer. */
function scopeWith(rpc: Record<string, (args: Record<string, unknown>) => unknown>): FarmDataScope {
  const empty = { data: [], error: null };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === "then" ? (resolve: (v: unknown) => void) => resolve(empty) : () => chain),
    apply: () => chain,
  });
  const supabase = {
    from: () => chain,
    rpc: async (name: string, args: Record<string, unknown>) => ({ data: rpc[name]?.(args) ?? [], error: null }),
  };
  return {
    supabase, farmId: "a3000000-0000-4000-9000-000000000001", role: "manager",
    machines: [PUMP, TRACTOR], costsVisible: false,
  } as unknown as FarmDataScope;
}

test("no fuel consumption rate for support equipment, even with old draws on record", async () => {
  const scope = scopeWith({
    assistant_fuel_summary: (args) => args.p_by === "machine" ? [
      { machine_id: PUMP.id, month: null, litres: 100, cost_cents: null, draws: 2, priced_draws: 0 },
      { machine_id: TRACTOR.id, month: null, litres: 200, cost_cents: null, draws: 4, priced_draws: 0 },
    ] : [],
    assistant_fuel_consumption: () => [
      { machine_id: PUMP.id, interval_litres: 100, meter_span: 50 },
      { machine_id: TRACTOR.id, interval_litres: 200, meter_span: 40 },
    ],
  });
  const summary = await fuelSummary(scope, {}, "2026-11-19") as {
    byMachine: Array<{ machine: string; litres: number; litresPerHour?: number }>;
  };
  const pump = summary.byMachine.find((row) => row.machine === PUMP.name);
  const tractor = summary.byMachine.find((row) => row.machine === TRACTOR.name);
  assert.ok(pump, "the pump's old draws stay on record");
  assert.equal(pump!.litres, 100);
  assert.equal(pump!.litresPerHour, undefined, "no fuel analysis for support equipment");
  assert.equal(tractor!.litresPerHour, 5, "a full asset keeps its rate");
});
