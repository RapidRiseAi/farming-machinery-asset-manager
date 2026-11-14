/**
 * What a customer's mix of full spaces and support equipment costs, the arithmetic and
 * nothing else (BRIEF section 4; decision register of 12 November 2026).
 *
 * THE SAME SUM IS `app.billing_renewal_cents` in 20261114090300_equipment_pricing_capacity.sql,
 * which the invoice run, the renewal notice and every preview call. `calculator.test.ts`
 * reads that migration's price rows and checks the figures here are the figures there, and
 * both sides are tested on the founder's fixtures, so the screen and the bill cannot drift.
 *
 *   F = purchased full spaces, at least five
 *   E = support equipment in use for the renewal period
 *   A = the plan's included equipment, once per customer subscription
 *   monthly = F x monthly rate + max(0, E - A) x R15
 *   annual  = F x annual rate  + max(0, E - A) x R150
 *
 * Annual is the STATED annual price (R490 / R790 / R990), never a monthly price times a
 * number of months. Equipment is a quantity: no item is labelled free or paid. Integer
 * cents, VAT-inclusive, and 0% VAT while Rapid Rise is not registered (billing_settings).
 */

import {
  CAPABILITY_MIN_PLAN,
  PLAN_PRICING,
  planAllows,
  type BillingPeriod,
  type Capability,
  type Plan,
} from "@/lib/entitlements";

/** The plans a customer can buy online, in comparison order. Done-For-You is quoted. */
export const SELF_SERVICE_PLANS = ["essential", "professional", "complete"] as const satisfies readonly Plan[];
export type SelfServicePlan = (typeof SELF_SERVICE_PLANS)[number];

/** The fewest full spaces a subscription is billed for. Mirrors min_billed_slots. */
export const MIN_FULL_SPACES = 5;

/**
 * The most full spaces sign-up takes online (decision 39). More is a capacity check and a
 * quote, not a refusal and not a technical maximum; it is not an equipment cap either.
 * Mirrors app.self_service_max_full_spaces().
 */
export const SELF_SERVICE_MAX_FULL_SPACES = 200;

/** Extra support equipment, the same on every plan: R15 a month, R150 a year. */
export const EXTRA_EQUIPMENT_CENTS: Record<BillingPeriod, number> = { monthly: 1500, annual: 15000 };

export type Mix = { fullSpaces: number; equipment: number };

function whole(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** One full space for one billing period, from the explicit list. Null for a quoted plan. */
export function fullSpacePeriodCents(plan: Plan, period: BillingPeriod): number | null {
  const p = PLAN_PRICING[plan];
  return period === "annual" ? p.perVehicleAnnualCents : p.perVehicleMonthlyCents;
}

/** The plan's included equipment, once per customer subscription. */
export function includedEquipment(plan: Plan): number {
  return PLAN_PRICING[plan].includedEquipment;
}

/** How many equipment spaces are CHARGED: the count beyond the allowance, never a label. */
export function chargedEquipment(plan: Plan, equipment: number): number {
  return Math.max(0, whole(equipment) - includedEquipment(plan));
}

export type Renewal = {
  plan: Plan;
  period: BillingPeriod;
  /** Full spaces billed: the purchase, at least the minimum. */
  fullSpaces: number;
  fullCents: number;
  equipment: number;
  includedEquipment: number;
  chargedEquipment: number;
  equipmentCents: number;
  totalCents: number;
};

/**
 * The renewal total for a mix on a plan, before separate usage, storage or accepted
 * services. Null for a plan with no list price (Done-For-You is quoted).
 */
export function renewal(plan: Plan, period: BillingPeriod, mix: Mix): Renewal | null {
  const space = fullSpacePeriodCents(plan, period);
  if (space == null) return null;
  const fullSpaces = Math.max(MIN_FULL_SPACES, whole(mix.fullSpaces));
  const equipment = whole(mix.equipment);
  const charged = chargedEquipment(plan, equipment);
  const fullCents = fullSpaces * space;
  const equipmentCents = charged * EXTRA_EQUIPMENT_CENTS[period];
  return {
    plan,
    period,
    fullSpaces,
    fullCents,
    equipment,
    includedEquipment: includedEquipment(plan),
    chargedEquipment: charged,
    equipmentCents,
    totalCents: fullCents + equipmentCents,
  };
}

/** The four monthly fixtures of BRIEF section 4, as the founder stated them. */
export const MONTHLY_FIXTURES: readonly { fullSpaces: number; equipment: number; essential: number; professional: number; complete: number }[] = [
  { fullSpaces: 5, equipment: 2, essential: 24500, professional: 39500, complete: 49500 },
  { fullSpaces: 5, equipment: 5, essential: 29000, professional: 39500, complete: 49500 },
  { fullSpaces: 5, equipment: 15, essential: 44000, professional: 54500, complete: 49500 },
  { fullSpaces: 5, equipment: 20, essential: 51500, professional: 62000, complete: 57000 },
];

export type PlanOption = {
  plan: SelfServicePlan;
  totalCents: number;
  /** Every needed capability is on this plan. */
  suppliesNeeds: boolean;
  /** The lowest total among the plans that supply the needs. Never applied automatically. */
  lowest: boolean;
  current: boolean;
};

/**
 * All three plans' renewal totals for the customer's actual mix, the lowest one that
 * supplies what they need marked (BRIEF section 4: Complete can cost less than
 * Professional because of its allowance, and a lower tier can cost more). The screen shows
 * the choice; nothing here switches anybody's plan.
 */
export function comparePlans(
  period: BillingPeriod,
  mix: Mix,
  needs: readonly Capability[] = [],
  currentPlan: Plan | null = null,
): PlanOption[] {
  const rows = SELF_SERVICE_PLANS.map((plan) => {
    const r = renewal(plan, period, mix);
    return {
      plan,
      totalCents: r ? r.totalCents : Number.POSITIVE_INFINITY,
      suppliesNeeds: needs.every((need) => need in CAPABILITY_MIN_PLAN && planAllows(plan, need)),
      lowest: false,
      current: plan === currentPlan,
    };
  });
  const candidates = rows.filter((r) => r.suppliesNeeds && Number.isFinite(r.totalCents));
  if (candidates.length > 0) {
    const min = Math.min(...candidates.map((r) => r.totalCents));
    // On a tie the cheaper tier is not "better"; the higher one gives more for the same.
    const pick = [...candidates].reverse().find((r) => r.totalCents === min);
    if (pick) pick.lowest = true;
  }
  return rows;
}

export type SignupRoute =
  | { kind: "self_service"; fullSpaces: number }
  /** Over the online line: a capacity check and a quote (decision 39). */
  | { kind: "quote"; fullSpaces: number };

/**
 * Where a requested number of full spaces goes at sign-up. Below the minimum is raised to
 * it (the invoice bills it anyway); above the self-service line is a quote. Equipment does
 * not count towards the line.
 */
export function signupRoute(requestedFullSpaces: number): SignupRoute {
  const n = Math.max(MIN_FULL_SPACES, whole(requestedFullSpaces));
  return n > SELF_SERVICE_MAX_FULL_SPACES ? { kind: "quote", fullSpaces: n } : { kind: "self_service", fullSpaces: n };
}

export type CapacityView = {
  /** In use now. */
  activeFull: number;
  activeEquipment: number;
  /** Paid for or included and available now (null: no ceiling, a metered subscription). */
  freeFull: number | null;
  freeEquipment: number | null;
  /** What the next renewal will bill. */
  nextRenewalFull: number;
  nextRenewalChargedEquipment: number;
};

/**
 * The three numbers a screen shows for capacity, kept apart where they differ: what is in
 * use, what is paid or included and free now, and what the next renewal bills. Mirrors the
 * `full` and `equipment` objects of public.asset_capacity_summary.
 */
export function capacityView(input: {
  plan: Plan;
  purchasedFull: number | null;
  pendingFull?: number | null;
  activeFull: number;
  activeEquipment: number;
  extraEquipmentPaid: number;
}): CapacityView {
  const included = includedEquipment(input.plan);
  const metered = input.purchasedFull == null;
  return {
    activeFull: whole(input.activeFull),
    activeEquipment: whole(input.activeEquipment),
    freeFull: metered ? null : Math.max(0, whole(input.purchasedFull ?? 0) - whole(input.activeFull)),
    freeEquipment: metered ? null : Math.max(0, included + whole(input.extraEquipmentPaid) - whole(input.activeEquipment)),
    nextRenewalFull: Math.max(MIN_FULL_SPACES, whole(input.pendingFull ?? input.purchasedFull ?? input.activeFull)),
    nextRenewalChargedEquipment: chargedEquipment(input.plan, input.activeEquipment),
  };
}
