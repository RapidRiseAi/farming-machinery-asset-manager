/**
 * What is on order (G16, migrations 0473–0475).
 *
 * The shared model the list, the order screen and the server actions all read, so a
 * figure shown on one cannot be interpreted differently on another. Everything in here
 * MIRRORS SQL rather than deciding anything of its own — the totals trigger in 0473 and
 * `app.purchase_order_derived_status` in 0474 are the authority, and these functions
 * exist so a screen can show a running total or an accurate status without waiting for a
 * round trip. Where the two could ever disagree, the database wins; that is why the
 * arithmetic here is deliberately the same arithmetic, in the same order.
 *
 * Money is ex-VAT integer cents, as everywhere else. Quantities are not money and are
 * not cents: oil is ordered in litres and cable in metres, so they carry decimals.
 */

export const PO_STATUSES = [
  "draft",
  "sent",
  "part_received",
  "received",
  "closed",
  "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

export function isPurchaseOrderStatus(v: string | null | undefined): v is PurchaseOrderStatus {
  return !!v && (PO_STATUSES as readonly string[]).includes(v);
}

export type PurchaseOrder = {
  id: string;
  workshop_id: string;
  supplier_name: string;
  reference: string | null;
  order_date: string;
  expected_date: string | null;
  notes: string | null;
  status: PurchaseOrderStatus;
  vat_rate_bps: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  created_at: string;
};

export type PurchaseOrderLine = {
  id: string;
  workshop_id: string;
  purchase_order_id: string;
  sort_order: number;
  description: string;
  part_no: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_price_cents: number;
};

/**
 * PostgREST hands `numeric` back as a JSON number, but a column read through a view or a
 * hand-written select can arrive as a string. Both are accepted here rather than at
 * fifteen call sites, and anything unreadable counts as zero — a quantity that renders as
 * `NaN` is worse than one that renders as nothing.
 */
export function qty(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** What one line is worth, ex-VAT. The same product the 0473 rollup sums. */
export function lineTotalCents(line: Pick<PurchaseOrderLine, "qty_ordered" | "unit_price_cents">): number {
  return Math.round(qty(line.qty_ordered) * (line.unit_price_cents ?? 0));
}

/**
 * The header's three figures, from the lines. Mirrors `app_purchase_order_rollup` plus
 * `app_purchase_order_totals`: subtotal is the sum of the line products, VAT is applied to
 * that sum ONCE rather than per line (rounding each line's VAT separately drifts by a cent
 * or two against the supplier's own invoice), and the total is the two added.
 *
 * Used to show what a line will do to an order BEFORE it is saved. The stored values are
 * what the screen displays afterwards.
 */
export function orderTotalsFromLines(
  lines: Pick<PurchaseOrderLine, "qty_ordered" | "unit_price_cents">[],
  vatRateBps: number,
): { subtotalCents: number; vatCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotalCents(l), 0);
  const vatCents = vatRateBps > 0 ? Math.round((subtotalCents * vatRateBps) / 10000) : 0;
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

/** Still to come on this line. Never negative — an over-delivery is not a negative debt. */
export function outstandingQty(line: Pick<PurchaseOrderLine, "qty_ordered" | "qty_received">): number {
  return Math.max(0, qty(line.qty_ordered) - qty(line.qty_received));
}

export type ReceivedSummary = {
  ordered: number;
  /** Clamped per line, exactly as 0474 clamps it. */
  received: number;
  outstanding: number;
  complete: boolean;
  started: boolean;
};

/**
 * How much of the order has actually turned up.
 *
 * The clamp is the part worth reading twice: a supplier who sends twelve of one item and
 * none of another has not completed the order, and an unclamped sum would say they had —
 * the surplus on one line silently covering the shortfall on the one somebody is waiting
 * for. 0474 does the same thing in SQL and this must not disagree with it.
 */
export function receivedSummary(
  lines: Pick<PurchaseOrderLine, "qty_ordered" | "qty_received">[],
): ReceivedSummary {
  let ordered = 0;
  let received = 0;
  for (const l of lines) {
    const o = qty(l.qty_ordered);
    ordered += o;
    received += Math.min(qty(l.qty_received), o);
  }
  return {
    ordered,
    received,
    outstanding: Math.max(0, ordered - received),
    complete: ordered > 0 && received >= ordered,
    started: received > 0,
  };
}

/**
 * What the status will be once the database has looked at the lines. Mirrors
 * `app.purchase_order_derived_status`, including the part that leaves draft, closed and
 * cancelled alone — those are decisions a person made, not deliveries.
 */
export function derivedStatus(
  current: PurchaseOrderStatus,
  lines: Pick<PurchaseOrderLine, "qty_ordered" | "qty_received">[],
): PurchaseOrderStatus {
  if (current !== "sent" && current !== "part_received" && current !== "received") return current;
  const s = receivedSummary(lines);
  if (s.ordered <= 0 || !s.started) return "sent";
  return s.complete ? "received" : "part_received";
}

/** With the supplier, and something is still owed to us. */
export function isOpen(status: PurchaseOrderStatus): boolean {
  return status === "sent" || status === "part_received";
}

/** Nothing more will happen to this one. */
export function isFinished(status: PurchaseOrderStatus): boolean {
  return status === "closed" || status === "cancelled";
}

/** Overdue = they said it would be here, and it is not. */
export function isLate(order: Pick<PurchaseOrder, "status" | "expected_date">, today = new Date()): boolean {
  if (!isOpen(order.status) || !order.expected_date) return false;
  return order.expected_date < today.toISOString().slice(0, 10);
}

/**
 * Whether the supplier's invoice can be captured against this order yet.
 *
 * Deliberately permissive: a supplier who invoices on despatch bills before anything has
 * arrived, and refusing the capture would mean the invoice goes in with no link to the
 * order at all — which loses precisely the comparison this feature exists to make. Only a
 * draft (never sent) and a cancelled order are refused, because neither can be owed for.
 */
export function canConvert(status: PurchaseOrderStatus): boolean {
  return status !== "draft" && status !== "cancelled";
}

/**
 * Parse a typed quantity. Accepts a comma decimal ("2,5") because a South African
 * keyboard and a South African invoice both use one, and blank means "nothing typed"
 * rather than zero.
 */
export function parseQty(input: string | null | undefined): number | null {
  if (input == null) return null;
  const cleaned = String(input).trim().replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === ".") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Quantities render without trailing zeros: "5" and "2,5", never "5.000". */
export function formatQty(value: number | string | null | undefined): string {
  const n = qty(value);
  const fixed = n.toFixed(3).replace(/\.?0+$/, "");
  return fixed.replace(".", ",");
}
