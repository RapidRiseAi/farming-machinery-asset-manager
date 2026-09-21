/**
 * Tyres, as the screens read them.
 *
 * Pure functions. The COST arithmetic is SQL's (`app.tyre_life`), because it spans a
 * tyre's whole history across rotations and machines and the inputs live in three tables.
 * What is here is what the screen decides once it has that answer.
 *
 * ── The unit is never assumed ───────────────────────────────────────────────
 * A tractor wears tyres in hours and a truck in kilometres. `tyre_life` returns the unit
 * alongside the number and returns NO unit for a tyre that has run on both, because hours
 * and kilometres cannot be added. Every function here that touches a rate carries that
 * through rather than defaulting to one.
 */

import type { BadgeTone } from "@/components/ui/badge";

/** `public.tyre_status`. */
export const TYRE_STATUSES = ["in_stock", "fitted", "removed", "scrapped"] as const;
/** `public.tyre_axle`. */
export const TYRE_AXLES = ["steer", "drive", "trailer", "implement", "spare", "other"] as const;

export type TyreStatus = (typeof TYRE_STATUSES)[number];
export type TyreAxle = (typeof TYRE_AXLES)[number];

/** One row of `public.tyre_life`. */
export type TyreLifeRow = {
  tyre_id: string;
  brand: string | null;
  pattern: string | null;
  size: string | null;
  serial_no: string | null;
  status: TyreStatus;
  purchase_cost_cents: number | null;
  new_tread_mm: number | null;
  latest_tread_mm: number | null;
  latest_checked_on: string | null;
  machine_id: string | null;
  machine_name: string | null;
  position_label: string | null;
  axle: TyreAxle | null;
  fitted_on: string | null;
  units_run: number | null;
  meter_type: "hours" | "km" | "none" | null;
  cost_per_unit_cents: number | null;
};

/**
 * The legal minimum on a public road in South Africa is 1mm across the tread.
 *
 * Used as the point at which a tyre is REPLACE rather than WATCH, because below it a truck
 * on the R63 is not roadworthy. A farm implement never on a public road is a different
 * question, which is why this is a floor for the warning and not a rule about the machine.
 */
export const LEGAL_MIN_TREAD_MM = 1;

/** Below this a tyre is worth planning to replace rather than reacting to. */
export const WATCH_TREAD_MM = 4;

export type TreadVerdict = "replace" | "watch" | "ok" | "unknown";

/**
 * What the tread reading means.
 *
 * `unknown` when nobody has checked, which is NOT the same as fine. A tyre with no check is
 * the one a farm should go and look at, so it is amber rather than silent.
 */
export function treadVerdict(row: Pick<TyreLifeRow, "latest_tread_mm">): TreadVerdict {
  const mm = row.latest_tread_mm;
  if (mm == null) return "unknown";
  if (mm <= LEGAL_MIN_TREAD_MM) return "replace";
  if (mm <= WATCH_TREAD_MM) return "watch";
  return "ok";
}

export function treadLook(v: TreadVerdict): { tone: BadgeTone; labelKey: string } {
  switch (v) {
    case "replace":
      return { tone: "danger", labelKey: "tyres.treadReplace" };
    case "watch":
      return { tone: "warning", labelKey: "tyres.treadWatch" };
    case "ok":
      return { tone: "ok", labelKey: "tyres.treadOk" };
    default:
      return { tone: "neutral", labelKey: "tyres.treadUnknown" };
  }
}

/**
 * How much of the tread is gone, as a percentage, or null when it cannot be known.
 *
 * Needs both the baseline and a reading: 9mm means nothing without the 20 it started at.
 * Clamped to 0-100 so a reading taken on the wrong tyre cannot render a bar off the end
 * of its track.
 */
export function treadUsedPct(
  row: Pick<TyreLifeRow, "new_tread_mm" | "latest_tread_mm">,
): number | null {
  const { new_tread_mm: base, latest_tread_mm: now } = row;
  if (base == null || now == null || base <= 0) return null;
  const used = ((base - now) / base) * 100;
  return Math.max(0, Math.min(100, Math.round(used)));
}

/** Badge shape for a tyre's own status. */
export function statusLook(s: TyreStatus): { tone: BadgeTone; labelKey: string } {
  switch (s) {
    case "fitted":
      return { tone: "brand", labelKey: "tyres.statusFitted" };
    case "in_stock":
      return { tone: "info", labelKey: "tyres.statusInStock" };
    case "removed":
      return { tone: "neutral", labelKey: "tyres.statusRemoved" };
    default:
      return { tone: "neutral", labelKey: "tyres.statusScrapped" };
  }
}

/** Where a tyre is, in words: "Rooi Massey, LR" or "In the store". */
export function whereKey(row: Pick<TyreLifeRow, "machine_name" | "position_label">): {
  key: string;
  vars: Record<string, string>;
} {
  if (!row.machine_name) return { key: "tyres.whereStore", vars: {} };
  if (!row.position_label) {
    return { key: "tyres.whereMachine", vars: { machine: row.machine_name } };
  }
  return {
    key: "tyres.whereMachinePosition",
    vars: { machine: row.machine_name, position: row.position_label },
  };
}

/**
 * The rate, as a key and its substitutions, or null when it cannot be stated.
 *
 * Null covers three cases that all mean "do not print a number": no cost recorded, nothing
 * run yet, and a tyre that has been on both an hours machine and a km machine. The last is
 * the one worth being careful about, because a sum of hours and kilometres looks exactly
 * like an answer.
 */
export function ratePhrase(
  row: Pick<TyreLifeRow, "cost_per_unit_cents" | "meter_type">,
): { key: string; cents: number } | null {
  if (row.cost_per_unit_cents == null || row.meter_type == null) return null;
  if (row.meter_type === "hours") return { key: "tyres.ratePerHour", cents: row.cost_per_unit_cents };
  if (row.meter_type === "km") return { key: "tyres.ratePerKm", cents: row.cost_per_unit_cents };
  return null;
}

/** Group fitted tyres by machine, keeping the store and the shelf separate. */
export function groupByMachine(rows: readonly TyreLifeRow[]): {
  machines: { id: string; name: string; tyres: TyreLifeRow[] }[];
  unfitted: TyreLifeRow[];
} {
  const machines = new Map<string, { id: string; name: string; tyres: TyreLifeRow[] }>();
  const unfitted: TyreLifeRow[] = [];
  for (const r of rows) {
    if (!r.machine_id || !r.machine_name) {
      unfitted.push(r);
      continue;
    }
    const entry = machines.get(r.machine_id) ?? { id: r.machine_id, name: r.machine_name, tyres: [] };
    entry.tyres.push(r);
    machines.set(r.machine_id, entry);
  }
  for (const m of machines.values()) {
    m.tyres.sort((a, b) => (a.position_label ?? "").localeCompare(b.position_label ?? ""));
  }
  return {
    machines: [...machines.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unfitted: unfitted.sort((a, b) => a.status.localeCompare(b.status)),
  };
}

/** The three figures above the list. */
export function tyreTotals(rows: readonly TyreLifeRow[]): {
  fitted: number;
  replace: number;
  unchecked: number;
  spendCents: number;
} {
  let fitted = 0;
  let replace = 0;
  let unchecked = 0;
  let spendCents = 0;
  for (const r of rows) {
    if (r.status === "fitted") fitted += 1;
    const v = treadVerdict(r);
    if (v === "replace") replace += 1;
    // Only counted for tyres actually ON something: an unchecked tyre in the store is not
    // a job, and counting it would make the number one nobody acts on.
    if (v === "unknown" && r.status === "fitted") unchecked += 1;
    spendCents += r.purchase_cost_cents ?? 0;
  }
  return { fitted, replace, unchecked, spendCents };
}
