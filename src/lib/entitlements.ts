/**
 * FleetWise plans & feature entitlements — the SINGLE SOURCE OF TRUTH.
 *
 * The Postgres helper `app.has_entitlement` (migration 0251) mirrors this map exactly
 * (same plan ranks, same feature → minimum-plan table). The app enforces gates
 * in-process from here (fast, no round-trip); the SQL helper is the defence-in-depth
 * twin used in RLS-adjacent checks and proven by the isolation suite. If you change a
 * rank or a feature requirement here, change 0251 too.
 *
 * FR-19.1 (non-payment parts) / FR-19.2 (gating). Payment/charging is DEFERRED — the
 * pricing table below is DISPLAY ONLY and no money moves anywhere (see src/lib/billing).
 */

export const PLANS = ["essential", "professional", "complete", "done_for_you"] as const;
export type Plan = (typeof PLANS)[number];

/** Ordered rank; higher unlocks everything a lower plan has. Mirrors app.plan_rank. */
export const PLAN_RANK: Record<Plan, number> = {
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
  aarto: "complete",
  voice_ai: "complete",
  multi_site: "complete",
  whatsapp: "complete",
  api_access: "done_for_you",
} as const satisfies Record<string, Plan>;

export type Feature = keyof typeof FEATURE_MIN_PLAN;

/** The minimum plan that unlocks `feature`. */
export function requiredPlan(feature: Feature): Plan {
  return FEATURE_MIN_PLAN[feature];
}

/** Does `plan` unlock `feature`? Unknown/ungated features are always allowed. */
export function planAllows(plan: Plan, feature: Feature): boolean {
  const need = FEATURE_MIN_PLAN[feature];
  if (!need) return true;
  return PLAN_RANK[plan] >= PLAN_RANK[need];
}

/** Every feature key `plan` unlocks (used to filter nav / build a client-safe set). */
export function entitledFeatures(plan: Plan): Feature[] {
  return (Object.keys(FEATURE_MIN_PLAN) as Feature[]).filter((f) => planAllows(plan, f));
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

// ── Pricing (DISPLAY ONLY — no charging; FR-19.1/19.3 non-payment parts) ──────────
// Per-vehicle-per-month price in integer cents, ex-VAT (ZAR), consistent with the
// money-in-cents rule. Annual billing applies a two-months-free discount (÷12 → the
// effective per-month figure shown). done_for_you is a bespoke / managed plan → POA.
export type PlanPrice = {
  /** Per-vehicle-per-month, ex-VAT, in cents. null = price on application (bespoke). */
  perVehicleMonthlyCents: number | null;
};

export const PLAN_PRICING: Record<Plan, PlanPrice> = {
  essential: { perVehicleMonthlyCents: 3900 },
  professional: { perVehicleMonthlyCents: 6900 },
  complete: { perVehicleMonthlyCents: 9900 },
  done_for_you: { perVehicleMonthlyCents: null },
};

/** Annual pre-pay gives 2 months free (pay for 10). Effective monthly = list × 10/12. */
export const ANNUAL_MONTHS_CHARGED = 10;

/**
 * Effective per-vehicle-per-month price (cents) for a plan + billing period — DISPLAY
 * ONLY. Returns null for a price-on-application (bespoke) plan.
 */
export function perVehicleMonthlyCents(plan: Plan, period: BillingPeriod): number | null {
  const base = PLAN_PRICING[plan].perVehicleMonthlyCents;
  if (base == null) return null;
  if (period === "annual") return Math.round((base * ANNUAL_MONTHS_CHARGED) / 12);
  return base;
}

/**
 * Indicative recurring subtotal (cents, ex-VAT) for `assetCount` vehicles — DISPLAY
 * ONLY. Monthly period → per-month total; annual period → per-YEAR total (list ×
 * ANNUAL_MONTHS_CHARGED). Returns null for a bespoke plan.
 */
export function subscriptionSubtotalCents(
  plan: Plan,
  period: BillingPeriod,
  assetCount: number
): number | null {
  const base = PLAN_PRICING[plan].perVehicleMonthlyCents;
  if (base == null) return null;
  const n = Math.max(0, assetCount);
  if (period === "annual") return base * ANNUAL_MONTHS_CHARGED * n;
  return base * n;
}
