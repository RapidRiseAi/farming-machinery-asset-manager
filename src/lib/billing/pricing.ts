/**
 * What a farm owes for a period — the arithmetic, and nothing else.
 *
 * THE SAME SUM IS DONE IN TWO PLACES AND THEY MUST AGREE.
 * `app.billing_derive_invoice_totals` (migration 20260903160000) computes the money on
 * every invoice row, and this file computes the money the screen shows before the
 * invoice exists. A customer reads both in the same minute. If they round differently,
 * both are useless, so this is a deliberate mirror:
 *
 *     total_incl = unit_price_incl × asset_count × months_charged
 *     subtotal_ex = app.ex_vat_cents(total_incl, rate)   ← exVatCents() in src/lib/money.ts
 *     vat         = total_incl − subtotal_ex
 *
 * The VAT split is derived by SUBTRACTION, never by a second rounding. That is what
 * makes `subtotal + vat = total` hold on every row — which the database checks, in
 * `billing_invoices_split_ck`. Rounding both halves independently is the classic way to
 * be one cent out on a bill.
 *
 * PRICES ARE VAT-INCLUSIVE. The catalogue stores what the customer agreed to pay; the
 * ex-VAT figure is derived from it. Today Rapid Rise is NOT VAT-registered, so the rate
 * is 0, `vatCents` is 0 and `subtotalExVatCents === totalInclCents` — and a UI must not
 * print a VAT line or head anything "Tax invoice" (VAT Act s20(4) reserves that for a
 * registered vendor). The machinery is built in full anyway so registering later is a
 * flag flip that restates no historical invoice.
 *
 * NO PRICE IS HARDCODED HERE, DELIBERATELY. `docs/FLEETWISE_FOUNDER_DECISIONS.md` #1 and
 * the shipped `src/lib/entitlements.ts` disagree, and the founder has confirmed neither,
 * so `billing_price_versions` ships EMPTY and every price arrives as an argument. A
 * price-on-application plan arrives as `null` and can never be auto-invoiced — which is
 * the correct behaviour for a negotiated price, not a gap.
 *
 * SCOPE: farms paying Rapid Rise for FleetWise. Nothing to do with `partner_documents`.
 */

import { ANNUAL_MONTHS_CHARGED, type BillingPeriod, type Plan } from "@/lib/entitlements";
import { exVatCents } from "@/lib/money";

// ── What counts as a billable vehicle ─────────────────────────────────────────

/**
 * Machine statuses that are NOT billed. Held here as a literal rather than imported
 * from `machine-options.ts` so this module stays free of the i18n dictionaries — but
 * the two are asserted equal in `pricing.test.ts`, so they cannot drift silently.
 */
export const NON_BILLABLE_MACHINE_STATUSES = ["retired", "sold"] as const;

/**
 * The billable rule, in one sentence, in one place.
 *
 * `out_of_service` STILL COUNTS: a broken tractor is still on the system, still holding
 * its history, still costing us to host — and a farm that could stop paying by marking
 * its fleet as broken is a farm with a free plan. This is character-for-character the
 * rule `app.billable_asset_count` uses, which is itself the rule
 * `app.recount_farm_assets` (0251) already uses for `farms.asset_count`.
 */
export const BILLABLE_ASSET_RULE =
  "Billable vehicles: non-deleted machines, excluding retired and sold. out_of_service still counts.";

export function isBillableMachineStatus(status: string): boolean {
  return !(NON_BILLABLE_MACHINE_STATUSES as readonly string[]).includes(status);
}

/** Count billable vehicles from a list of statuses (a soft-deleted row is not passed in). */
export function billableAssetCount(statuses: readonly string[]): number {
  return statuses.reduce((n, s) => (isBillableMachineStatus(s) ? n + 1 : n), 0);
}

// ── The arithmetic ────────────────────────────────────────────────────────────

export type InvoiceAmounts = {
  /** VAT-inclusive total, integer cents. The figure the customer pays. */
  totalInclCents: number;
  /** Derived, never stored as the source. */
  subtotalExVatCents: number;
  /** `total − subtotal`. Zero while Rapid Rise is not VAT-registered. */
  vatCents: number;
};

export type AmountInput = {
  /** Per vehicle, per month, VAT-INCLUSIVE, integer cents. */
  unitPriceInclCents: number;
  assetCount: number;
  /** 1 for monthly; the annual pre-pay term (normally 10) for annual. */
  monthsCharged: number;
  /** VAT rate in basis points. 0 while unregistered. */
  vatRateBps: number;
};

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`billing pricing: ${name} must be an integer >= ${min}`);
  }
}

/**
 * The invoice sum. Throws on inputs that cannot produce a defensible bill (a fractional
 * cent, a negative count, an overflow past the safe-integer range) rather than
 * returning a plausible wrong number — money arithmetic that guesses is worse than
 * money arithmetic that stops.
 */
export function invoiceAmounts(input: AmountInput): InvoiceAmounts {
  assertCount("unitPriceInclCents", input.unitPriceInclCents, 0);
  assertCount("assetCount", input.assetCount, 0);
  assertCount("monthsCharged", input.monthsCharged, 1);
  assertCount("vatRateBps", input.vatRateBps, 0);
  if (input.vatRateBps > 10_000) {
    throw new RangeError("billing pricing: vatRateBps must be <= 10000 (100%)");
  }

  const total = input.unitPriceInclCents * input.assetCount * input.monthsCharged;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("billing pricing: total exceeds the safe integer range");
  }

  const ex = exVatCents(total, input.vatRateBps);
  return { totalInclCents: total, subtotalExVatCents: ex, vatCents: total - ex };
}

/**
 * How many months a period charges for. Annual pre-pay is two months free, so an annual
 * invoice charges 10 — but the price version carries its own `months_charged`, so an
 * explicit value always wins. The offer can change without rewriting history or hunting
 * for a constant.
 */
export function monthsChargedFor(period: BillingPeriod, fromPriceVersion?: number | null): number {
  if (fromPriceVersion != null) {
    assertCount("monthsCharged", fromPriceVersion, 1);
    return fromPriceVersion;
  }
  return period === "annual" ? ANNUAL_MONTHS_CHARGED : 1;
}

// ── The quote ─────────────────────────────────────────────────────────────────

export type QuoteInput = {
  plan: Plan;
  billingPeriod: BillingPeriod;
  /**
   * Per vehicle, per month, VAT-inclusive cents — straight off
   * `billing_price_versions.per_vehicle_monthly_incl_cents`. NULL means price on
   * application (a bespoke plan), and there is no such thing as auto-invoicing one.
   */
  unitPriceInclCents: number | null;
  assetCount: number;
  /** `billing_price_versions.months_charged`. Omit to take the period's default. */
  monthsCharged?: number | null;
  /** `billing_price_versions.vat_rate_bps`. Omit for the unregistered reality: 0. */
  vatRateBps?: number | null;
};

export type SubscriptionQuote =
  | ({
      ok: true;
      plan: Plan;
      billingPeriod: BillingPeriod;
      unitPriceInclCents: number;
      assetCount: number;
      monthsCharged: number;
      vatRateBps: number;
      /**
       * False when the total is zero — a farm with no billable vehicles. The generator
       * raises no invoice for one; it moves the billing date on instead, so it does not
       * reconsider the same farm every night.
       */
      chargeable: boolean;
    } & InvoiceAmounts)
  | {
      ok: false;
      /**
       * `price_on_application` — a bespoke plan; a human quotes it.
       * `no_active_price`     — the catalogue has no confirmed price yet (today's state).
       * `invalid_input`       — a caller bug; `detail` says which field, never a value.
       */
      reason: "price_on_application" | "no_active_price" | "invalid_input";
      detail?: string;
    };

/**
 * Price a subscription period. Never throws: a bad input comes back as `ok:false` so a
 * screen can say something honest instead of falling over on a farm's billing page.
 */
export function quoteSubscription(input: QuoteInput): SubscriptionQuote {
  if (input.unitPriceInclCents == null) {
    return { ok: false, reason: "price_on_application" };
  }

  const vatRateBps = input.vatRateBps ?? 0;
  let monthsCharged: number;
  try {
    monthsCharged = monthsChargedFor(input.billingPeriod, input.monthsCharged ?? null);
  } catch {
    return { ok: false, reason: "invalid_input", detail: "monthsCharged" };
  }

  let amounts: InvoiceAmounts;
  try {
    amounts = invoiceAmounts({
      unitPriceInclCents: input.unitPriceInclCents,
      assetCount: input.assetCount,
      monthsCharged,
      vatRateBps,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_input",
      detail: err instanceof RangeError ? err.message : "amounts",
    };
  }

  return {
    ok: true,
    plan: input.plan,
    billingPeriod: input.billingPeriod,
    unitPriceInclCents: input.unitPriceInclCents,
    assetCount: input.assetCount,
    monthsCharged,
    vatRateBps,
    chargeable: amounts.totalInclCents > 0,
    ...amounts,
  };
}

/**
 * What a price version says one vehicle costs per month, for display beside a total.
 * On an annual plan the customer pays for 10 months across 12, so the effective monthly
 * figure is lower than the list price — and showing the list price beside an annual
 * total is how a bill stops adding up in a customer's head.
 */
export function effectiveMonthlyPerVehicleCents(
  unitPriceInclCents: number | null,
  period: BillingPeriod,
  monthsCharged?: number | null,
): number | null {
  if (unitPriceInclCents == null) return null;
  if (period !== "annual") return unitPriceInclCents;
  const months = monthsChargedFor("annual", monthsCharged ?? null);
  return Math.round((unitPriceInclCents * months) / 12);
}
