/**
 * What is on the shelf (§6 inventory, migrations 0450–0451).
 *
 * `parts_catalogue` is a list of part numbers; this is the count of them. The split is
 * deliberate — a catalogue row may be GLOBAL (RR-seeded, `farm_id` null) and shared by
 * every farm, so a quantity cannot live on it. A farm "starts tracking" a part by creating
 * a `stock_items` row against it, which is also what keeps the store to the handful of
 * parts a farm actually holds rather than the whole catalogue at zero.
 *
 * `on_hand` is maintained by a trigger from `stock_movements` and must never be written
 * from here. Anything in this file that looks like it computes a quantity is computing a
 * PREVIEW for the screen, not a value to store.
 */

export const MOVE_KINDS = ["receipt", "issue", "adjustment", "return"] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

export type StockItem = {
  id: string;
  farm_id: string;
  part_catalogue_id: string;
  unit: string;
  on_hand: number;
  reorder_point: number | null;
  bin: string | null;
};

export type StockMovement = {
  id: string;
  stock_item_id: string;
  kind: MoveKind;
  qty: number;
  unit_cost_cents: number | null;
  machine_id: string | null;
  job_card_id: string | null;
  occurred_on: string;
  note: string | null;
};

/**
 * The TS mirror of `app.stock_needs_reorder`. Kept in step with the SQL for the same
 * reason `lib/fuel.ts` mirrors the consumption engine: the screen and the nightly nudge
 * must agree, or a farmer sees a green row and gets an alert about it the same night.
 *
 * A part with no reorder point is NOT low at zero — it is untracked for reordering, and
 * inventing a threshold produces nightly noise nobody asked for.
 */
export function needsReorder(item: Pick<StockItem, "on_hand" | "reorder_point">): boolean {
  return item.reorder_point != null && item.on_hand <= item.reorder_point;
}

/** Below zero means the store has issued what it never recorded receiving. */
export function isNegative(item: Pick<StockItem, "on_hand">): boolean {
  return item.on_hand < 0;
}

export type StockTone = "ok" | "low" | "negative";

export function stockTone(item: Pick<StockItem, "on_hand" | "reorder_point">): StockTone {
  if (isNegative(item)) return "negative";
  return needsReorder(item) ? "low" : "ok";
}

/**
 * How a quantity changes the shelf. The sign lives here and in the SQL rollup, nowhere
 * else — `qty` on a movement is always positive so that a row cannot be read two ways.
 */
export function signedQty(kind: MoveKind, qty: number): number {
  return kind === "issue" ? -qty : qty;
}

/**
 * Whether this movement will put a cost against the machine (0450's rule).
 *
 * Exported so the capture form can SAY so before the user presses anything — "this will
 * also add R500 to the tractor's costs" is the kind of thing that should never be a
 * surprise discovered later in a report.
 */
export function movementBooksCost(m: {
  kind: MoveKind;
  machine_id: string | null;
  job_card_id: string | null;
  unit_cost_cents: number | null;
  qty: number;
}): boolean {
  return (
    m.kind === "issue" &&
    !!m.machine_id &&
    !m.job_card_id &&
    Math.round((m.unit_cost_cents ?? 0) * m.qty) > 0
  );
}

/** Quantities read as words, not floats: 3, 2.5, 0.25 — never "3.000". */
export function qtyLabel(qty: number, unit: string): string {
  const n = Number(qty);
  const trimmed = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
  return `${trimmed} ${unit}`;
}
