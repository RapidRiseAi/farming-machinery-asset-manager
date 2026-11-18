/**
 * The optional activation catalogue and Done-For-You agreements (20261120100000).
 *
 * The database is the authority: `app.service_order_price` prices an order from the catalogue
 * row and `public.dfy_offer` refuses a managed quote under the floors. This mirrors both, so a
 * screen can show the amount before Rapid Rise offers it and the owner sees the same number the
 * database will hold; `service-orders.test.ts` reads the migration and pins the two together.
 *
 * Commercial rules (approved activation catalogue, 29 October 2026; decision register 12
 * November 2026, decisions 28 to 30):
 *   clean setup        R150 an asset, R750 minimum
 *   document capture   R300 an asset, R1,500 minimum (an alternative to clean setup, never both)
 *   historical work    R500 an hour, scoped
 *   remote training    R500 an hour
 *   on-site training   from R3,500, up to four working hours, plus agreed travel
 *   QR kits            R45 an asset, minimum ten, conditional on a supplier quote: not offered
 *                      until Rapid Rise records the quote and marks the item ready
 *   Done-For-You       from R170 a space a month, R2,500 customer minimum a month; annual terms
 *                      quoted individually, never discounted automatically
 * Nothing here is mandatory: self-service entry, imports and printable QR files cost nothing.
 */

export type ServicePricing = "per_unit" | "hourly" | "from";

export type ServiceCode =
  | "clean_setup"
  | "document_capture"
  | "historical_work"
  | "remote_training"
  | "onsite_training"
  | "qr_kits";

export type CatalogueRule = {
  code: ServiceCode;
  pricing: ServicePricing;
  unitCents: number;
  minimumCents: number | null;
  minQuantity: number | null;
  workGroup: string | null;
  requiresSupplierQuote: boolean;
};

/** The rules as the migration seeds them (the live row is read from the database). */
export const SERVICE_CATALOGUE: readonly CatalogueRule[] = [
  { code: "clean_setup", pricing: "per_unit", unitCents: 15000, minimumCents: 75000, minQuantity: 1, workGroup: "setup", requiresSupplierQuote: false },
  { code: "document_capture", pricing: "per_unit", unitCents: 30000, minimumCents: 150000, minQuantity: 1, workGroup: "setup", requiresSupplierQuote: false },
  { code: "historical_work", pricing: "hourly", unitCents: 50000, minimumCents: null, minQuantity: null, workGroup: null, requiresSupplierQuote: false },
  { code: "remote_training", pricing: "hourly", unitCents: 50000, minimumCents: null, minQuantity: null, workGroup: null, requiresSupplierQuote: false },
  { code: "onsite_training", pricing: "from", unitCents: 350000, minimumCents: null, minQuantity: 1, workGroup: null, requiresSupplierQuote: false },
  { code: "qr_kits", pricing: "per_unit", unitCents: 4500, minimumCents: null, minQuantity: 10, workGroup: null, requiresSupplierQuote: true },
];

export const SERVICE_CODES: readonly ServiceCode[] = SERVICE_CATALOGUE.map((r) => r.code);

export function isServiceCode(value: unknown): value is ServiceCode {
  return typeof value === "string" && (SERVICE_CODES as readonly string[]).includes(value);
}

export type PriceResult = { ok: true; cents: number } | { ok: false; code: "service-invalid" | "service-below-minimum" };

/** `app.service_order_price` for one catalogue row. Readiness is the database's question. */
export function servicePrice(
  rule: Pick<CatalogueRule, "pricing" | "unitCents" | "minimumCents" | "minQuantity">,
  quantity: number,
  quotedCents: number | null,
  travelCents: number,
): PriceResult {
  const travel = travelCents ?? 0;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000 || Math.round(quantity * 100) !== quantity * 100) {
    return { ok: false, code: "service-invalid" };
  }
  if (!Number.isInteger(travel) || travel < 0 || travel > 100000000) return { ok: false, code: "service-invalid" };
  if (rule.pricing !== "from" && travel !== 0) return { ok: false, code: "service-invalid" };
  if (rule.pricing === "per_unit") {
    if (!Number.isInteger(quantity) || quantity < (rule.minQuantity ?? 1)) return { ok: false, code: "service-below-minimum" };
    return { ok: true, cents: Math.max(rule.minimumCents ?? 0, quantity * rule.unitCents) };
  }
  if (rule.pricing === "hourly") {
    if (!Number.isInteger(quantity * 4)) return { ok: false, code: "service-invalid" };
    return { ok: true, cents: Math.round(quantity * rule.unitCents) };
  }
  if (quantity !== 1 || quotedCents == null || !Number.isInteger(quotedCents) || quotedCents < rule.unitCents || quotedCents > 100000000) {
    return { ok: false, code: "service-below-minimum" };
  }
  return { ok: true, cents: quotedCents + travel };
}

export type BillingPeriod = "monthly" | "annual";

/** `app.dfy_space_floor_cents`: from R170 a space a month; twelve times that for a year. */
export function dfySpaceFloorCents(period: BillingPeriod): number {
  return period === "annual" ? 12 * 17000 : 17000;
}

/** `app.dfy_minimum_floor_cents`: R2,500 a customer a month; twelve times that for a year. */
export function dfyMinimumFloorCents(period: BillingPeriod): number {
  return period === "annual" ? 12 * 250000 : 250000;
}

export type DfyPrices = {
  period: BillingPeriod;
  spaceCents: number;
  minSpaces: number;
  equipmentIncluded: number;
  equipmentCents: number;
};

/** `app.dfy_period_total`: the A1 renewal sum on the agreement's own prices. */
export function dfyPeriodTotal(p: Omit<DfyPrices, "period">, full: number, equipment: number): number {
  return Math.max(full, p.minSpaces) * p.spaceCents + Math.max(equipment - p.equipmentIncluded, 0) * p.equipmentCents;
}

/** Why `public.dfy_offer` would refuse these prices, or null. */
export function dfyPriceRefusal(p: DfyPrices): "service-invalid" | "service-below-minimum" | null {
  const ints = [p.spaceCents, p.minSpaces, p.equipmentIncluded, p.equipmentCents];
  if (ints.some((n) => !Number.isInteger(n)) || p.minSpaces < 1 || p.equipmentIncluded < 0) return "service-invalid";
  const floor = dfySpaceFloorCents(p.period);
  if (p.spaceCents < floor || p.equipmentCents < floor || p.minSpaces * p.spaceCents < dfyMinimumFloorCents(p.period)) {
    return "service-below-minimum";
  }
  if (p.spaceCents > 100000000 || p.equipmentCents > 100000000) return "service-below-minimum";
  return null;
}

/** A quantity as people write it: "12", "1.5". */
export function quantityLabel(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(2)));
}

/** Statuses of an agreement and of an order, for the screens' labels. */
export const AGREEMENT_STATUSES = ["offered", "accepted", "active", "superseded", "ended", "cancelled", "expired"] as const;
export const ORDER_STATUSES = ["offered", "accepted", "invoiced", "completed", "cancelled", "expired"] as const;
export const WORK_ACTIVITIES = [
  "maintenance_planning", "workshop_follow_up", "cost_monitoring", "records", "reporting", "setup", "training", "other",
] as const;
