/**
 * Cost & TCO helpers shared by machine detail and reports, so both surfaces compute
 * the same numbers (fixes gap-analysis D-2/D-3). All money is integer cents, ex-VAT.
 */

export const COST_TYPES = [
  "purchase",
  "finance",
  "fuel",
  "parts",
  "labour",
  "invoice",
  "other",
] as const;
export type CostType = (typeof COST_TYPES)[number];

export type CostBreakdown = Record<CostType, number>;

export function emptyBreakdown(): CostBreakdown {
  return { purchase: 0, finance: 0, fuel: 0, parts: 0, labour: 0, invoice: 0, other: 0 };
}

/** Sum `{type, amount_cents}` rows into a per-type breakdown + total (cents). */
export function summariseCosts(
  rows: { type: string; amount_cents: number | null }[],
): { total: number; breakdown: CostBreakdown } {
  const breakdown = emptyBreakdown();
  let total = 0;
  for (const r of rows) {
    const amt = r.amount_cents ?? 0;
    total += amt;
    if ((COST_TYPES as readonly string[]).includes(r.type)) breakdown[r.type as CostType] += amt;
    else breakdown.other += amt;
  }
  return { total, breakdown };
}

/**
 * Cost per meter unit on a consistent lifetime basis: lifetime TCO ÷ lifetime meter
 * reading (Scope §23). This is the single definition used by BOTH machine detail and
 * reports — a lifetime numerator over a lifetime denominator — so cost-per-hour and
 * cost-per-km never disagree between the two surfaces (D-2). Returns integer cents, or
 * null when the reading is missing / zero.
 */
export function costPerMeter(tcoCents: number, reading: number | null | undefined): number | null {
  return reading != null && reading > 0 ? Math.round(tcoCents / reading) : null;
}
