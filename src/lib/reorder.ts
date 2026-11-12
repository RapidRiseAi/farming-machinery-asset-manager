
export const MIN_LOOKAHEAD_DAYS = 1;
export const MAX_LOOKAHEAD_DAYS = 365;

/**
 * One machine + kit that contributed to a committed quantity.
 *
 * The commitment is auditable on purpose. A machine with more than one kit counts all of
 * them, because nothing in the schema records which service a kit belongs to (0503 header),
 * so the screen has to be able to show its working rather than assert a total.
 */
export type CommitmentSource = {
  machine_id: string;
  machine: string | null;
  kit: string | null;
  qty: number;
};

/** A row of `public.stock_shortfall(p_farm, p_days)`. */
export type ShortfallRow = {
  stock_item_id: string;
  part_no: string | null;
  description: string | null;
  unit: string;
  bin: string | null;
  on_hand: number;
  reorder_point: number | null;
  committed_qty: number;
  /** on hand minus committed. Negative means the schedule needs more than the shelf holds. */
  projected_qty: number;
  /** How many short, never negative. Zero when the shelf covers the commitment. */
  short_qty: number;
  is_short: boolean;
  /** The 0451 rule, at or below the minimum you set, carried alongside, not replaced. */
  needs_reorder: boolean;
  machine_count: number;
  sources: CommitmentSource[] | null;
};

/**
 * The rows worth showing in the "what the next N days need" view.
 *
 * A shelf with nothing committed belongs in the store list above it, not here: this view
 * exists to answer one question, and padding it with parts no service is waiting on is how
 * the answer stops being visible.
 */
export function committedRows(rows: ShortfallRow[]): ShortfallRow[] {
  return rows.filter((r) => qty(r.committed_qty) > 0);
}

/**
 * Numeric columns cross PostgREST as JSON numbers, but a `numeric` is the one type where
 * that is worth not assuming, the difference between 9 and "9.00" is invisible until a
 * comparison silently does the wrong thing. Coerced once, here, rather than at each use.
 */
function qty(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** How many shelves cannot cover what is already scheduled. Drives the count at the top. */
export function shortfallCount(rows: ShortfallRow[]): number {
  return rows.reduce((n, r) => n + (r.is_short ? 1 : 0), 0);
}

/**
 * Sort worst first: short shelves before covered ones, then by how short, then by how much
 * of the shelf the schedule has spoken for. A reorder list read top-down should be a
 * shopping list, not an alphabet.
 */
export function bySeverity(a: ShortfallRow, b: ShortfallRow): number {
  if (a.is_short !== b.is_short) return a.is_short ? -1 : 1;
  const aShort = qty(a.short_qty), bShort = qty(b.short_qty);
  if (aShort !== bShort) return bShort - aShort;
  const cover = (r: ShortfallRow) =>
    qty(r.committed_qty) === 0 ? 0 : qty(r.committed_qty) / Math.max(qty(r.on_hand), 0.0001);
  return cover(b) - cover(a);
}

/**
 * `sources` arrives as jsonb. Anything that is not the expected shape is dropped rather
 * than rendered, because this panel's whole job is to be checkable.
 */
export function readSources(value: unknown): CommitmentSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const o = raw as Record<string, unknown>;
    const qty = Number(o.qty);
    if (typeof o.machine_id !== "string" || !Number.isFinite(qty)) return [];
    return [{
      machine_id: o.machine_id,
      machine: typeof o.machine === "string" ? o.machine : null,
      kit: typeof o.kit === "string" ? o.kit : null,
      qty,
    }];
  });
}

/**
 * Group a row's sources by machine, so the panel reads "New Holland, 250 h kit, 500 h kit:
 * 8" rather than repeating a machine name once per kit line.
 */
export function sourcesByMachine(
  sources: CommitmentSource[],
): { machine_id: string; machine: string | null; kits: string[]; qty: number }[] {
  const byMachine = new Map<string, { machine_id: string; machine: string | null; kits: string[]; qty: number }>();
  for (const s of sources) {
    const found = byMachine.get(s.machine_id);
    if (found) {
      found.qty += s.qty;
      if (s.kit && !found.kits.includes(s.kit)) found.kits.push(s.kit);
    } else {
      byMachine.set(s.machine_id, {
        machine_id: s.machine_id,
        machine: s.machine,
        kits: s.kit ? [s.kit] : [],
        qty: s.qty,
      });
    }
  }
  return [...byMachine.values()].sort((a, b) => b.qty - a.qty);
}

/** Clamp a typed lookahead the same way SQL does on read, so the form cannot store junk. */
export function clampLookahead(input: string | number | null | undefined): number | null {
  if (input == null || input === "") return null;
  const n = typeof input === "number" ? input : Number(String(input).trim().replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_LOOKAHEAD_DAYS, Math.max(MIN_LOOKAHEAD_DAYS, Math.round(n)));
}
