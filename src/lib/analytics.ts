/**
 * Fleet analytics — feature G1 (Scope §23 utilisation + downtime, FR-10.5 repair-vs-
 * replace). Shared by the machine-detail and reports surfaces so both agree.
 *
 * Downtime itself is computed in SQL (0361 app.fleet_downtime, reconstructed from the
 * audit_log status trail); this module holds the constants + the two metrics that are
 * naturally computed in the app from lightweight data:
 *   • Utilisation — hours (or km) used vs the period's available capacity, from meter
 *     readings; and
 *   • Repair-vs-replace — lifetime maintenance/repair spend as a % of purchase price.
 * All money is integer cents, ex-VAT.
 */
import type { CostBreakdown } from "@/lib/cost";

/** Statuses that mean a machine is DOWN (mirrors 0361's downtime reconstruction). */
export const DOWN_STATUSES = ["in_workshop", "out_of_service"] as const;

/** Trailing window (days) over which the machine-detail page shows utilisation/downtime. */
export const UTILISATION_WINDOW_DAYS = 90;

/**
 * Assumed capacity per calendar day, used to turn "used" into a utilisation %.
 * These are farm-configurable (settings `utilisation_hours_per_day` /
 * `utilisation_km_per_day`); the defaults are sensible farm-fleet values.
 */
export const DEFAULT_HOURS_PER_DAY = 10;
export const DEFAULT_KM_PER_DAY = 200;

/** Default repair-vs-replace threshold: flag once lifetime repair spend ≥ 60% of price. */
export const DEFAULT_REPAIR_REPLACE_PCT = 60;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC; date-only). */
export function addDaysYmd(dateYmd: string, days: number): string {
  const d = new Date(`${dateYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

/** Inclusive calendar-day count of [from, to] (both YYYY-MM-DD). Minimum 1. */
export function daysInWindow(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1;
  return Math.round((to - from) / 86400000) + 1;
}

/**
 * The bounded analysis window for reports: utilisation/downtime are recent-activity
 * rates, so an unbounded "all time" report uses a trailing UTILISATION_WINDOW_DAYS window
 * ending at the report's `to` (or today).
 */
export function analysisWindow(
  from: string | null,
  to: string | null,
  today = ymd(new Date()),
): { from: string; to: string } {
  const end = to ?? today;
  const start = from ?? addDaysYmd(end, -UTILISATION_WINDOW_DAYS);
  return { from: start, to: end };
}

export type MeterReadingLite = { reading: number | null; reading_date: string | null };

export type Utilisation = {
  meterType: string;
  days: number;
  /** Metered units used in the window (hours or km); null when not derivable. */
  used: number | null;
  /** Capacity in the window (hours or km); null for meterless machines. */
  available: number | null;
  /** used ÷ available × 100; null when either side is missing. */
  pct: number | null;
  /** available − used, floored at 0 (the "idle" side); null when not derivable. */
  idle: number | null;
};

/**
 * Utilisation of one asset over [fromYmd, toYmd].
 *
 * used  = (last reading on/before `to`) − (baseline reading), where the baseline is the
 *         last reading on/before `from`, or — if the asset has no pre-window reading —
 *         the first reading inside the window. Meters are monotonic (hours/km only
 *         accumulate), so this net delta is the units actually clocked up in the window.
 * avail = days-in-window × capacity/day (hours or km); meterless assets have none.
 * pct   = used ÷ avail × 100; idle = avail − used (the "idle vs used" split, §23).
 */
export function computeUtilisation(
  readings: MeterReadingLite[],
  meterType: string,
  fromYmd: string,
  toYmd: string,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
  kmPerDay = DEFAULT_KM_PER_DAY,
): Utilisation {
  const days = daysInWindow(fromYmd, toYmd);
  const sorted = readings
    .filter((r) => r.reading != null && r.reading_date)
    .map((r) => ({ v: Number(r.reading), d: r.reading_date!.slice(0, 10) }))
    .sort((a, b) => a.d.localeCompare(b.d));

  let startV: number | null = null;
  for (const r of sorted) if (r.d <= fromYmd) startV = r.v; // last reading on/before `from`
  if (startV == null) {
    const firstIn = sorted.find((r) => r.d >= fromYmd && r.d <= toYmd);
    startV = firstIn ? firstIn.v : null;
  }
  let endV: number | null = null;
  for (const r of sorted) if (r.d <= toYmd) endV = r.v; // last reading on/before `to`

  const used = startV != null && endV != null && endV >= startV ? endV - startV : null;
  const available =
    meterType === "hours" ? days * hoursPerDay : meterType === "km" ? days * kmPerDay : null;
  const pct = used != null && available != null && available > 0 ? (used / available) * 100 : null;
  const idle = used != null && available != null ? Math.max(0, available - used) : null;

  return { meterType, days, used, available, pct, idle };
}

export type RepairReplace = {
  /** Lifetime maintenance/repair spend (parts + labour + other + contractor invoices). */
  maintCents: number;
  /** Basis of comparison — the purchase price (proxy for current value). */
  baseCents: number;
  /** maintCents ÷ baseCents × 100; null when there is no purchase price to compare. */
  ratioPct: number | null;
  thresholdPct: number;
  /** True once ratio ≥ threshold — surface a "consider replacing" flag (FR-10.5). */
  flagged: boolean;
};

/**
 * Repair-vs-replace indicator (FR-10.5). Maintenance/repair cost = the running-repair
 * cost types (parts, labour, other, contractor invoices) — NOT purchase, finance or fuel
 * (those are acquisition / running-fuel, not repair). Flag when that lifetime spend
 * crosses `thresholdPct` of the machine's purchase price.
 */
export function repairVsReplace(
  breakdown: CostBreakdown,
  purchasePriceCents: number | null | undefined,
  thresholdPct = DEFAULT_REPAIR_REPLACE_PCT,
): RepairReplace {
  const maintCents = breakdown.parts + breakdown.labour + breakdown.other + breakdown.invoice;
  const baseCents = purchasePriceCents ?? 0;
  const ratioPct = baseCents > 0 ? (maintCents / baseCents) * 100 : null;
  const flagged = ratioPct != null && ratioPct >= thresholdPct;
  return { maintCents, baseCents, ratioPct, thresholdPct, flagged };
}
