/**
 * Partner (workshop) products & feature entitlements (F14e, was F12c).
 *
 * The two-sided twin of `src/lib/entitlements.ts`: that map gates a FARM's features by
 * its subscription; THIS map gates a PARTNER's portal by the product they bought
 * (stored on `workshops.plan`, migration 0382).
 *
 * The two products are different in kind, not in size:
 *
 *   portal   The partner's customers see their fleet with the partner in it. Work
 *            requests, vehicle history, the partner's own letterhead, and attaching the
 *            quotes and invoices they already produce in Sage, Xero, a spreadsheet or a
 *            receipt book. Their existing system stays their system.
 *   managed  Everything above, plus running the commercial side here: building quotes
 *            and invoices line by line, converting a quote to an invoice, recording
 *            payments and proofs, and cross-client analytics.
 *
 * The load-bearing decision is what is NOT gated. Uploading a document produced
 * elsewhere is core on every plan, as is branding it — so a partner on `portal` is never
 * dependent on our invoicing to serve their farmers, and nothing they rely on degrades
 * if they never upgrade. Only BUILDING documents here is the paid step up.
 *
 * IMPORTANT — this is NOT a tenancy guard. A partner's data isolation is guaranteed
 * SOLELY by RLS + `workshop_links` (0100/0101) and, for documents, by
 * `app.partner_doc_visible` (0381); this map only tailors which portal features a
 * partner sees, so it lives app-side with no SQL/RLS mirror (unlike the farm plan's
 * `app.has_entitlement`). PAYMENTS ARE DEFERRED — no money moves here.
 */

export const WORKSHOP_PLANS = ["portal", "managed", "books"] as const;
export type WorkshopPlan = (typeof WORKSHOP_PLANS)[number];

/** Ordered rank; a higher plan unlocks everything a lower one does. */
export const WORKSHOP_PLAN_RANK: Record<WorkshopPlan, number> = {
  portal: 1,
  managed: 2,
  books: 3,
};

/**
 * Partner feature → the minimum product that unlocks it. Any feature NOT listed is core
 * and available on every plan: the aggregated request inbox, per-kind views, status
 * updates, notes, quick-contact, business profile & branding, and UPLOADING a quote or
 * invoice produced in the partner's own system.
 *
 *   build_documents  — compose a quote/invoice from line items in FleetWise
 *   record_payments  — log payments and proofs against an invoice
 *   client_analytics — cross-client performance panel (per-farm/status rollups)
 */
export const WORKSHOP_FEATURE_MIN_PLAN = {
  build_documents: "managed",
  record_payments: "managed",
  client_analytics: "managed",
  // The financial-management layer (0492). One feature key rather than nine, because a
  // partner does not buy "the VAT screen" - they buy running their books here, and a map
  // with nine near-identical rows invites them to drift apart the first time somebody
  // gates a new screen and forgets one.
  financials: "books",
} as const satisfies Record<string, WorkshopPlan>;

export type WorkshopFeature = keyof typeof WORKSHOP_FEATURE_MIN_PLAN;

export function isWorkshopPlan(value: string): value is WorkshopPlan {
  return (WORKSHOP_PLANS as readonly string[]).includes(value);
}

/** The minimum partner product that unlocks `feature`. */
export function workshopRequiredPlan(feature: WorkshopFeature): WorkshopPlan {
  return WORKSHOP_FEATURE_MIN_PLAN[feature];
}

/** Does `plan` unlock `feature`? Unknown/ungated features are always allowed. */
export function workshopPlanAllows(plan: WorkshopPlan, feature: WorkshopFeature): boolean {
  const need = WORKSHOP_FEATURE_MIN_PLAN[feature];
  if (!need) return true;
  return WORKSHOP_PLAN_RANK[plan] >= WORKSHOP_PLAN_RANK[need];
}

/** i18n key for a partner product's display name (labels under `contractorPlan.*`). */
export function workshopPlanNameKey(plan: WorkshopPlan): string {
  return `contractorPlan.${plan}`;
}

/**
 * Indicative monthly price per partner product, in whole rands, VAT-INCLUSIVE — the same
 * founder decision that governs the farm-plan display in the admin console. DISPLAY
 * ONLY: nothing here charges anyone, and the billing adapter (`src/lib/billing/*`) is
 * still the no-op. It exists so the admin console and the upgrade nudge can state the
 * difference in price alongside the difference in product, rather than leaving "there is
 * a price difference" as folklore.
 */
/**
 * DELIBERATELY UNSET while the three-tier ladder is priced (0492). The console renders a
 * dash where a number is missing rather than a stale one: a wrong price shown to the
 * person who sells the product is worse than no price, because it gets quoted. Nothing
 * here charges anyone either way — the billing adapter is still the no-op.
 */
export const WORKSHOP_PLAN_PRICE_MONTHLY: Record<WorkshopPlan, number | null> = {
  portal: null,
  managed: null,
  books: null,
};
