// One paid provider call inside a spending hold (task B5): hold first, call only if the hold was
// granted, settle whatever happened. Shared by reading documents into the import review and
// reading manuals for questions. The app passes the AI usage ledger's holdBudget/settleHold, so
// both are paid from the one owner-chosen assistance limit (task A3).

import type { Attempt, Hold, Units } from "@/lib/ai-usage/ledger";

export type HoldStep = (units: Units, model: string) => Promise<Hold>;
export type SettleStep = (holdId: string, attempts: Attempt[]) => Promise<unknown>;

export type HeldResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "spend_refused"; error: string }
  | { ok: false; reason: "provider_failed"; value?: T };

/**
 * `call` returns its value, what it used and whether the value is usable. An unusable answer is
 * settled as failed with its cost recorded and nothing billed; a throw is settled as failed.
 * Never throws.
 */
export async function runHeld<T>(args: {
  model: string;
  estimate: Units;
  hold: HoldStep;
  settle: SettleStep;
  call: () => Promise<{ value: T; units: Units; costUsd?: number | null; usable: boolean }>;
}): Promise<HeldResult<T>> {
  const hold = await args.hold(args.estimate, args.model);
  if (!hold.ok) return { ok: false, reason: "spend_refused", error: hold.reason };
  const started = Date.now();
  try {
    const out = await args.call();
    await args.settle(hold.id, [{
      model: args.model,
      outcome: out.usable ? "ok" : "failed",
      units: out.units,
      costUsd: out.costUsd ?? null,
      measured: "server",
      // The provider did the work even when its answer was unusable: its cost is recorded, nothing billed.
      charged: !out.usable,
      latencyMs: Date.now() - started,
    }]);
    return out.usable ? { ok: true, value: out.value } : { ok: false, reason: "provider_failed", value: out.value };
  } catch {
    await args.settle(hold.id, [{ model: args.model, outcome: "failed", latencyMs: Date.now() - started }]);
    return { ok: false, reason: "provider_failed" };
  }
}
