/**
 * FLEETWISE plans & feature entitlements, the SINGLE SOURCE OF TRUTH.
 *
 * The Postgres helper `app.has_entitlement` (migration 0251) mirrors this map exactly
 * (same plan ranks, same feature → minimum-plan table). The app enforces gates
 * in-process from here (fast, no round-trip); the SQL helper is the defence-in-depth
 * twin used in RLS-adjacent checks and proven by the isolation suite. If you change a
 * rank or a feature requirement here, change 0251 too.
 *
 * FR-19.1 / FR-19.2 (gating). The pricing table below is what a farmer is QUOTED on
 * screen; what they are INVOICED comes from `billing_price_versions` (see src/lib/billing),
 * and a test reads the seeding migration to keep the two the same number.
 */

export const PLANS = ["essential", "professional", "complete", "done_for_you"] as const;
export type Plan = (typeof PLANS)[number];

/** Ordered rank; higher unlocks everything a lower plan has. Mirrors app.plan_rank. */
const PLAN_RANK: Record<Plan, number> = {
  essential: 1,
  professional: 2,
  complete: 3,
  done_for_you: 4,
};

export const BILLING_PERIODS = ["monthly", "annual"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/**
 * Feature → the minimum plan that unlocks it. Mirrors app.feature_min_rank.
 * Any feature NOT listed here is an ungated core capability (available on every plan:
 * machines, job cards, faults, service scheduling, meter readings, QR capture, alerts,
 * team, settings). Per FR-19.2: dashboard = Professional+, voice AI & AARTO = Complete+.
 */
export const FEATURE_MIN_PLAN = {
  dashboard: "professional",
  advanced_reports: "professional",
  fuel: "professional",
  tco: "professional",
  // Trip scheduling, assignments, deliveries and trip finance (decision 16). The driving
  // log with written stops is on every plan (`driving_log` below).
  trips: "professional",
  // In-app maps, route planning, reported positions and driving paths (decision 18). The
  // `map` feature flag (src/lib/features.ts) is the readiness switch on top of the plan.
  maps: "complete",
  aarto: "complete",
  voice_ai: "complete",
  multi_site: "complete",
  whatsapp: "complete",
  api_access: "done_for_you",
} as const satisfies Record<string, Plan>;

export type Feature = keyof typeof FEATURE_MIN_PLAN;

/**
 * Gated features that exist but are not yet advertised on the plan comparison: they wait
 * for their verification (decision 31). Their gates still apply.
 */
export const NOT_YET_ADVERTISED: readonly Feature[] = ["maps"];

/**
 * Every capability the matrix names: the gated features above, two analytics that share
 * `tco`'s placement but are refused for support equipment by name, and the every-plan
 * capabilities the equipment profile is judged against. Mirrors app.feature_min_rank
 * (20261114090200); entitlements.test.ts reads that migration to keep them equal.
 */
export const CAPABILITY_MIN_PLAN = {
  ...FEATURE_MIN_PLAN,
  budgets: "professional",
  depreciation: "professional",
  driving_log: "essential",
  driver_workflow: "essential",
  road_licensing: "essential",
  finance_agreements: "essential",
  tyre_detail: "essential",
  sale_warranty_packs: "essential",
  general_chat: "essential",
} as const satisfies Record<string, Plan>;

export type Capability = keyof typeof CAPABILITY_MIN_PLAN;

/**
 * The management/billing profile of an asset (20261114090100). Kept here rather than
 * imported from machine-options.ts so this module stays free of the i18n dictionaries.
 */
export type AssetProfileKey = "full" | "equipment";

/**
 * What each profile can never have, on any plan, Complete included (decisions 3 and 33).
 * Support equipment keeps identification, photos, a written location, hour readings,
 * service reminders, faults, checklists and inspections, repair jobs with ordinary parts,
 * labour and cost lines, documents, QR codes, sale and warranty packs and chat. Mirrors
 * app.profile_refuses (20261114090200).
 */
export const PROFILE_REFUSES: Record<AssetProfileKey, readonly Capability[]> = {
  full: [],
  equipment: [
    "driving_log",
    "driver_workflow",
    "trips",
    "maps",
    "road_licensing",
    "fuel",
    "tco",
    "depreciation",
    "finance_agreements",
    "budgets",
    "tyre_detail",
  ],
};

/** The minimum plan that unlocks `feature`. */
export function requiredPlan(feature: Capability): Plan {
  return CAPABILITY_MIN_PLAN[feature];
}

/** Does `plan` unlock `feature`? Unknown/ungated features are always allowed. */
export function planAllows(plan: Plan, feature: Capability): boolean {
  const need = CAPABILITY_MIN_PLAN[feature];
  if (!need) return true;
  return PLAN_RANK[plan] >= PLAN_RANK[need];
}

/** Does this profile refuse `feature` outright, whatever the plan? */
export function profileRefuses(profile: AssetProfileKey | string | null | undefined, feature: Capability): boolean {
  if (profile !== "equipment") return false;
  return PROFILE_REFUSES.equipment.includes(feature);
}

/**
 * The whole matrix for one asset: its business's plan AND its own profile. A full asset
 * follows its plan; support equipment never gets a refused tool, however high the plan.
 * Mirrors app.asset_allows.
 */
export function assetAllows(plan: Plan, profile: AssetProfileKey | string | null | undefined, feature: Capability): boolean {
  return planAllows(plan, feature) && !profileRefuses(profile, feature);
}

export function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

export function isBillingPeriod(value: string): value is BillingPeriod {
  return (BILLING_PERIODS as readonly string[]).includes(value);
}

/** i18n key for a plan's display name (labels live in en/af.json under `plan.*`). */
export function planNameKey(plan: Plan): string {
  return `plan.${plan}`;
}

export type PlanPrice = {
  /** Per-vehicle-per-month, VAT-inclusive, in cents. null = price on application (bespoke). */
  perVehicleMonthlyCents: number | null;
};

/**
 * THE NOVEMBER 2026 LIST: R49 / R79 / R99, Done-For-You quoted.
 *
 * Founder decisions of 29 October 2026, published on the FLEETWISE website on
 * 4 November 2026 and seeded as the `launch-2026-11` generation by migration
 * 20261104200000. The launch list (R44 / R73 / R89 / R250, 4 September 2026) is retired
 * and still prices the agreements pinned to it; nobody's price moved.
 *
 * Done-For-You is remote fleet management QUOTED per customer (from R170 per vehicle a
 * month, at least R2,500 a month). A marketing floor is not a price anybody can be
 * auto-invoiced at, so it is null here and has no current row in the catalogue: sign-up,
 * plan changes and the invoice run all treat it as price on application.
 *
 * This table is DISPLAY. The money that is actually charged comes from
 * `billing_price_versions`, because an invoice must be defensible from its own snapshot
 * years later. `safety.test.ts` reads the migration and
 * `supabase/tests/billing_subscription.sql` §(0) asserts the rows, so the quote and the
 * bill cannot drift apart silently.
 */
export const PLAN_PRICING: Record<Plan, PlanPrice> = {
  essential: { perVehicleMonthlyCents: 4900 },
  professional: { perVehicleMonthlyCents: 7900 },
  complete: { perVehicleMonthlyCents: 9900 },
  done_for_you: { perVehicleMonthlyCents: null },
};

/**
 * The fewest vehicle slots a subscription on the current list is billed for: five, so
 * R245 / R395 / R495 a month (`billing_price_versions.min_billed_slots`). Sign-up starts
 * here and will not go below it; a slot change refuses to. Per subscription, which today
 * is per farm: the website's pooled multi-site subscription is set up by staff until a
 * billing-customer grouping exists.
 */
export const MIN_BILLED_SLOTS = 5;

/** The slots a quote is priced on: what was asked for, or the minimum if that is more. */
export function billedSlots(requested: number): number {
  return Math.max(MIN_BILLED_SLOTS, Math.max(0, Math.floor(requested)));
}

/** Annual pre-pay gives 2 months free (pay for 10). Effective monthly = list × 10/12. */
export const ANNUAL_MONTHS_CHARGED = 10;

/**
 * Effective per-vehicle-per-month price (cents, VAT-inclusive) for a plan + billing
 * period, DISPLAY ONLY. Returns null for a price-on-application (bespoke) plan.
 */
export function perVehicleMonthlyCents(plan: Plan, period: BillingPeriod): number | null {
  const base = PLAN_PRICING[plan].perVehicleMonthlyCents;
  if (base == null) return null;
  if (period === "annual") return Math.round((base * ANNUAL_MONTHS_CHARGED) / 12);
  return base;
}

/**
 * Indicative recurring subtotal (cents, VAT-inclusive) for `assetCount` vehicles, at
 * least the minimum, DISPLAY ONLY. Monthly period → per-month total; annual period → per-YEAR total (list ×
 * ANNUAL_MONTHS_CHARGED). Returns null for a bespoke plan.
 */
export function subscriptionSubtotalCents(
  plan: Plan,
  period: BillingPeriod,
  assetCount: number
): number | null {
  const base = PLAN_PRICING[plan].perVehicleMonthlyCents;
  if (base == null) return null;
  const n = billedSlots(assetCount);
  if (period === "annual") return base * ANNUAL_MONTHS_CHARGED * n;
  return base * n;
}
