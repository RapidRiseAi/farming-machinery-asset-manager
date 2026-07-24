/**
 * Contractor (workshop) plans & feature entitlements (F12c, spec §1).
 *
 * The two-sided twin of `src/lib/entitlements.ts`: that map gates a FARM's features by
 * its subscription; THIS map gates a CONTRACTOR's portal features by the contractor's
 * plan (stored on `workshops.plan`, migration 0320). Value-first onboarding: every
 * contractor starts on `free` and can already see + act on requests across all their
 * linked farms; premium cross-client extras sit behind `pro`.
 *
 * IMPORTANT — this is NOT a tenancy guard. A contractor's data isolation is guaranteed
 * SOLELY by RLS + `workshop_links` (0100/0101); this map only tailors which portal
 * extras a contractor sees, so it lives app-side with no SQL/RLS mirror (unlike the farm
 * plan's `app.has_entitlement`). PAYMENTS ARE DEFERRED — no money moves here.
 */

export const WORKSHOP_PLANS = ["free", "pro"] as const;
export type WorkshopPlan = (typeof WORKSHOP_PLANS)[number];

/** Ordered rank; a higher plan unlocks everything a lower one does. */
export const WORKSHOP_PLAN_RANK: Record<WorkshopPlan, number> = {
  free: 1,
  pro: 2,
};

/**
 * Contractor feature → the minimum contractor plan that unlocks it. Any feature NOT
 * listed is an ungated core capability available on every plan (the aggregated request
 * inbox, per-kind views, status updates, notes, quote/invoice/proof upload,
 * quick-contact). Premium extras start here:
 *   * client_analytics — cross-client performance panel (per-farm/status rollups).
 */
export const WORKSHOP_FEATURE_MIN_PLAN = {
  client_analytics: "pro",
} as const satisfies Record<string, WorkshopPlan>;

export type WorkshopFeature = keyof typeof WORKSHOP_FEATURE_MIN_PLAN;

export function isWorkshopPlan(value: string): value is WorkshopPlan {
  return (WORKSHOP_PLANS as readonly string[]).includes(value);
}

/** The minimum contractor plan that unlocks `feature`. */
export function workshopRequiredPlan(feature: WorkshopFeature): WorkshopPlan {
  return WORKSHOP_FEATURE_MIN_PLAN[feature];
}

/** Does `plan` unlock `feature`? Unknown/ungated features are always allowed. */
export function workshopPlanAllows(plan: WorkshopPlan, feature: WorkshopFeature): boolean {
  const need = WORKSHOP_FEATURE_MIN_PLAN[feature];
  if (!need) return true;
  return WORKSHOP_PLAN_RANK[plan] >= WORKSHOP_PLAN_RANK[need];
}

/** i18n key for a contractor plan's display name (labels under `contractorPlan.*`). */
export function workshopPlanNameKey(plan: WorkshopPlan): string {
  return `contractorPlan.${plan}`;
}
