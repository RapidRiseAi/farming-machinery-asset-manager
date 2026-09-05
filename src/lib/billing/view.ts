/**
 * Presentation helpers for the two SaaS-billing screens (`/billing`, `/admin/billing`).
 *
 * PURE. No I/O, no `"use server"`, no Supabase client, no `process.env`. Everything here
 * is a function of its arguments, so the owner's screen, the admin's screen and any
 * future PDF cannot disagree about what a status means or what the next charge comes to.
 *
 * Three things live here for reasons worth stating:
 *
 * 1. THE COLUMN LISTS. `billing_payment_methods.authorization_code` is a Paystack
 *    CHARGING CREDENTIAL and is deliberately not granted to `authenticated` at the
 *    column level (migration 20260903160100). A browser session doing `select=*` on that
 *    table gets a permission ERROR — which is the intended behaviour, and also a
 *    500 on a screen a farmer is looking at. So the safe columns are enumerated ONCE,
 *    here, and both pages spread the same constant. Adding a column to that table
 *    therefore defaults to invisible, which is the right way round.
 *
 * 2. THE ESTIMATE. `billing_price_versions` ships EMPTY on purpose: the founder has not
 *    confirmed a price and two documents in this repo disagree about it. So the estimate
 *    is a DISCRIMINATED UNION with an explicit `unpriced` case, not a number that quietly
 *    falls back to zero. A screen cannot accidentally render R0,00 as if it were the
 *    price, because there is no number to render until a price exists.
 *
 * 3. VAT. Rapid Rise is not VAT-registered, and `app.billing_force_vat_rate` pins the
 *    rate to 0 on every invoice while that holds. The VAT arithmetic is still built in
 *    full and gated on one boolean, so registering later is a flag flip rather than a
 *    rewrite — and no historical invoice is restated, because each one carries the rate
 *    it was raised under.
 */

import type { StatusLook } from "@/components/ui/badge";
import { exVatCents, vatOfInclCents } from "@/lib/money";
import { billableAssetCount } from "@/lib/billing/pricing";

// ── The safe column lists ────────────────────────────────────────────────────

/**
 * Every column of `billing_payment_methods` a browser session may read.
 *
 * `authorization_code` and `authorization_email` are ABSENT and must stay absent. They
 * are the credential; the rest is the masked summary a person needs to recognise their
 * own card.
 */
export const PAYMENT_METHOD_COLUMNS =
  "id, farm_id, provider, card_brand, last4, exp_month, exp_year, card_type, bank, " +
  "country_code, bin, reusable, is_default, status, last_used_at, removed_at, created_at";

export const SUBSCRIPTION_COLUMNS =
  "id, farm_id, plan, billing_period, status, price_version_label, trial_ends_on, " +
  "anchor_day, current_period_start, current_period_end, next_billing_on, " +
  "default_payment_method_id, cancel_at_period_end, cancellation_reason, cancelled_at, " +
  "ended_on, failed_attempt_count, last_failure_code, last_failure_at, next_retry_on, " +
  "grace_ends_on, plan_before_downgrade, downgraded_at, created_at";

export const INVOICE_COLUMNS =
  "id, farm_id, invoice_ref, status, period_start, period_end, issued_on, due_on, plan, " +
  "billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, " +
  "vat_rate_bps, subtotal_ex_vat_cents, vat_cents, total_incl_cents, amount_paid_cents, " +
  "currency, voided_reason";

/**
 * Attempts, minus `authorization_url` and `access_code`.
 *
 * Neither is a credential in the authorization-code sense, but both are single-use
 * payment URLs for one specific transaction and neither belongs on a page that gets
 * screenshotted into a support thread. A fresh checkout mints a fresh one.
 */
export const ATTEMPT_COLUMNS =
  "id, farm_id, invoice_id, subscription_id, attempt_ref, kind, status, attempt_number, " +
  "amount_incl_cents, currency, provider, provider_reference, provider_transaction_id, " +
  "gateway_response, failure_reason, requested_at, resolved_at, reconciled_at, reconcile_note";

export const PAYMENT_COLUMNS =
  "id, farm_id, invoice_id, attempt_id, amount_incl_cents, currency, paid_at, provider, " +
  "provider_reference, channel, note";

// ── Row shapes, as the screens read them ─────────────────────────────────────

export type BillingPlan = "essential" | "professional" | "complete" | "done_for_you";
export type BillingPeriodValue = "monthly" | "annual";

export type SubscriptionRow = {
  id: string;
  farm_id: string;
  plan: string;
  billing_period: string;
  status: string;
  price_version_label: string | null;
  trial_ends_on: string | null;
  anchor_day: number | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_billing_on: string | null;
  default_payment_method_id: string | null;
  cancel_at_period_end: boolean;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  ended_on: string | null;
  failed_attempt_count: number;
  last_failure_code: string | null;
  last_failure_at: string | null;
  next_retry_on: string | null;
  grace_ends_on: string | null;
  plan_before_downgrade: string | null;
  downgraded_at: string | null;
  created_at: string;
};

export type PriceRow = {
  id: string;
  version_label: string;
  plan: string;
  billing_period: string;
  per_vehicle_monthly_incl_cents: number | null;
  months_charged: number;
  vat_rate_bps: number;
  status: string;
  effective_from: string | null;
  effective_to: string | null;
};

export type PaymentMethodRow = {
  id: string;
  farm_id: string;
  provider: string;
  card_brand: string | null;
  last4: string | null;
  exp_month: string | null;
  exp_year: string | null;
  card_type: string | null;
  bank: string | null;
  country_code: string | null;
  bin: string | null;
  reusable: boolean;
  is_default: boolean;
  status: string;
  last_used_at: string | null;
  removed_at: string | null;
  created_at: string;
};

export type InvoiceRow = {
  id: string;
  farm_id: string;
  invoice_ref: string;
  status: string;
  period_start: string;
  period_end: string;
  issued_on: string | null;
  due_on: string | null;
  plan: string;
  billing_period: string;
  asset_count: number;
  unit_price_incl_cents: number;
  months_charged: number;
  price_version_label: string;
  vat_rate_bps: number;
  subtotal_ex_vat_cents: number;
  vat_cents: number;
  total_incl_cents: number;
  amount_paid_cents: number;
  currency: string;
  voided_reason: string | null;
};

export type AttemptRow = {
  id: string;
  farm_id: string;
  invoice_id: string | null;
  subscription_id: string | null;
  attempt_ref: string;
  kind: string;
  status: string;
  attempt_number: number;
  amount_incl_cents: number;
  currency: string;
  provider: string;
  provider_reference: string | null;
  provider_transaction_id: number | null;
  gateway_response: string | null;
  failure_reason: string | null;
  requested_at: string;
  resolved_at: string | null;
  reconciled_at: string | null;
  reconcile_note: string | null;
};

export type PaymentRow = {
  id: string;
  farm_id: string;
  invoice_id: string | null;
  attempt_id: string | null;
  amount_incl_cents: number;
  currency: string;
  paid_at: string;
  provider: string;
  provider_reference: string | null;
  channel: string | null;
  note: string | null;
};

export type BillingSettingsRow = {
  vat_registered: boolean;
  vat_rate_bps: number;
  legal_name: string;
  support_email: string | null;
  billing_email: string | null;
  trial_days: number;
  grace_days: number;
  retry_offsets_days: number[] | null;
  downgrade_to_plan: string;
};

// ── Status vocabulary ────────────────────────────────────────────────────────
//
// Shape + word + colour, the same three signals every other domain enum in this app
// carries (`components/ui/badge.tsx`). These maps live here rather than in the shared
// `status.tsx` so that adding a billing state cannot disturb the ten domains already
// rendering from that file; the shapes and tones are drawn from the same vocabulary, so
// a billing badge still reads as part of the same system.

/** Subscription lifecycle. `grace` and `past_due` are deliberately different shapes:
 *  one is "we are still trying", the other is "we have stopped trying". */
export const SUBSCRIPTION_LOOK: Record<string, StatusLook> = {
  trialing: { tone: "info", shape: "clock" },
  active: { tone: "ok", shape: "dot" },
  past_due: { tone: "warning", shape: "triangle" },
  grace: { tone: "warning", shape: "clock" },
  downgraded: { tone: "danger", shape: "square" },
  non_renewing: { tone: "neutral", shape: "half" },
  cancelled: { tone: "neutral", shape: "dash" },
};

/** Invoice lifecycle. Mirrors the partner-side `DOC_LOOK` where the states coincide. */
export const INVOICE_LOOK: Record<string, StatusLook> = {
  draft: { tone: "neutral", shape: "ring" },
  open: { tone: "info", shape: "clock" },
  paid: { tone: "ok", shape: "check" },
  uncollectible: { tone: "danger", shape: "dash" },
  void: { tone: "neutral", shape: "dash" },
};

/** One attempt to take money. `unknown` is the one that blocks everything else. */
export const ATTEMPT_LOOK: Record<string, StatusLook> = {
  pending: { tone: "info", shape: "clock" },
  succeeded: { tone: "ok", shape: "check" },
  failed: { tone: "danger", shape: "square" },
  abandoned: { tone: "neutral", shape: "dash" },
  unknown: { tone: "warning", shape: "triangle" },
};

const NEUTRAL: StatusLook = { tone: "neutral", shape: "ring" };

/** Look a state up, falling back to a neutral ring rather than rendering nothing. */
export function billingLook(
  map: Record<string, StatusLook>,
  value: string | null | undefined,
): StatusLook {
  return (value && map[value]) || NEUTRAL;
}

// ── The estimate ─────────────────────────────────────────────────────────────

/**
 * What the next charge would come to, or an honest statement that we cannot say.
 *
 * `unpriced` is TODAY'S STATE and the reason this is a union rather than a number: with
 * no active price row the invoice generator raises nothing, so nothing is being charged
 * and there is no figure to show. Rendering R0,00 there would be a lie in the one
 * direction a customer would not question.
 *
 * `bespoke` is a price-on-application plan (`per_vehicle_monthly_incl_cents` null). It
 * can never be auto-invoiced, which is the correct behaviour for a negotiated price.
 */
export type Estimate =
  | { kind: "unpriced" }
  | { kind: "bespoke"; versionLabel: string }
  | {
      kind: "priced";
      versionLabel: string;
      /** Per vehicle per month, VAT-inclusive cents. */
      perVehicleInclCents: number;
      assetCount: number;
      /** 1 for monthly; the annual pre-pay term (2 months free → 10) for annual. */
      monthsCharged: number;
      /** perVehicle × assets × months, VAT-inclusive cents. The figure that is charged. */
      totalInclCents: number;
      /** 0 while Rapid Rise is not VAT-registered. */
      vatRateBps: number;
      /** Only meaningful when `vatRateBps > 0`. */
      subtotalExVatCents: number;
      vatCents: number;
    };

/**
 * Pick the price version that applies right now.
 *
 * The DB already enforces at most one `active` row per plan+period, and
 * `app.billing_active_price` applies the same window. This repeats the window check
 * client-side rather than trusting the query's filters, because the consequence of
 * getting it wrong is showing somebody a price that is not theirs.
 */
export function activePrice(
  rows: PriceRow[] | null | undefined,
  plan: string,
  period: string,
  today = new Date(),
): PriceRow | null {
  const day = isoDay(today);
  for (const r of rows ?? []) {
    if (r.plan !== plan || r.billing_period !== period) continue;
    if (r.status !== "active") continue;
    if (r.effective_from && r.effective_from > day) continue;
    if (r.effective_to && r.effective_to < day) continue;
    return r;
  }
  return null;
}

/** `YYYY-MM-DD` for a Date, in local terms — the same shape a Postgres `date` arrives as. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The next charge, given the active price (or its absence), the billable vehicle count
 * and whether the seller is VAT-registered.
 *
 * `total = unit_price_incl × asset_count × months_charged` — the same arithmetic
 * `app.generate_billing_invoices` uses, so the estimate and the invoice agree.
 */
export function estimateNextCharge({
  price,
  assetCount,
  vatRegistered,
}: {
  price: PriceRow | null;
  assetCount: number;
  vatRegistered: boolean;
}): Estimate {
  if (!price) return { kind: "unpriced" };
  const unit = price.per_vehicle_monthly_incl_cents;
  if (unit == null) return { kind: "bespoke", versionLabel: price.version_label };

  const months = price.months_charged;
  const total = unit * Math.max(0, assetCount) * months;
  // While `billing_settings.vat_registered` is false a DB trigger pins every invoice's
  // rate to zero, so showing the catalogue rate here would contradict the document that
  // actually gets raised. One boolean, and the whole VAT presentation follows it.
  const rate = vatRegistered ? price.vat_rate_bps : 0;
  return {
    kind: "priced",
    versionLabel: price.version_label,
    perVehicleInclCents: unit,
    assetCount: Math.max(0, assetCount),
    monthsCharged: months,
    totalInclCents: total,
    vatRateBps: rate,
    subtotalExVatCents: exVatCents(total, rate),
    vatCents: vatOfInclCents(total, rate),
  };
}

/** Does anything on this screen need a VAT row? One test, used by every total. */
export function showsVat(vatRegistered: boolean, rateBps: number | null | undefined): boolean {
  return vatRegistered && (rateBps ?? 0) > 0;
}

// ── What happens next, in words ──────────────────────────────────────────────

/**
 * The single most important line on the owner's screen: when money moves, or why it
 * will not. Returns a descriptor rather than a sentence so the page keeps every string
 * in the dictionaries.
 */
export type NextCharge =
  | { kind: "none" }
  | { kind: "unpriced" }
  | { kind: "trialEnds"; on: string }
  | { kind: "endsOn"; on: string }
  | { kind: "retryOn"; on: string }
  | { kind: "graceEndsOn"; on: string }
  | { kind: "dueOn"; on: string };

export function nextChargeState(
  sub: SubscriptionRow | null,
  estimate: Estimate,
): NextCharge {
  if (!sub) return { kind: "none" };
  if (sub.status === "cancelled") return { kind: "none" };
  if (sub.status === "non_renewing" || sub.cancel_at_period_end) {
    const on = sub.ended_on ?? sub.current_period_end;
    return on ? { kind: "endsOn", on } : { kind: "none" };
  }
  if (sub.status === "grace" && sub.grace_ends_on) {
    return { kind: "graceEndsOn", on: sub.grace_ends_on };
  }
  if (sub.status === "past_due" && sub.next_retry_on) {
    return { kind: "retryOn", on: sub.next_retry_on };
  }
  if (sub.status === "trialing" && sub.trial_ends_on) {
    return { kind: "trialEnds", on: sub.trial_ends_on };
  }
  // Everything below here is "a charge is coming" — and with no confirmed price there
  // is no charge coming, whatever the date column says.
  if (estimate.kind !== "priced") return { kind: "unpriced" };
  return sub.next_billing_on ? { kind: "dueOn", on: sub.next_billing_on } : { kind: "none" };
}

/**
 * The calm explanation shown when something has gone wrong with a payment.
 *
 * Returns the tone and the i18n stem; the wording lives in the dictionaries because it
 * is the copy that matters most on this screen — a farmer reading it is already worried,
 * and the one thing they need told is that nothing has been deleted.
 */
export type AccountNotice = {
  tone: "info" | "warning" | "error" | "success";
  /** `billing.notice.<stem>Title` / `…Body` in the dictionaries. */
  stem: string;
  /** Show the "try the payment again" button beneath it. */
  offerRetry: boolean;
};

export function accountNotice(sub: SubscriptionRow | null): AccountNotice | null {
  if (!sub) return null;
  switch (sub.status) {
    case "past_due":
      return { tone: "warning", stem: "pastDue", offerRetry: true };
    case "grace":
      return { tone: "warning", stem: "grace", offerRetry: true };
    case "downgraded":
      return { tone: "error", stem: "downgraded", offerRetry: true };
    case "non_renewing":
      return { tone: "info", stem: "nonRenewing", offerRetry: false };
    case "cancelled":
      return { tone: "info", stem: "cancelled", offerRetry: false };
    case "trialing":
      return { tone: "info", stem: "trialing", offerRetry: false };
    default:
      return null;
  }
}

// ── Small formatting decisions, made once ────────────────────────────────────

/** What is still owed on an invoice, never below zero (a refund is its own row). */
export function outstandingCents(inv: Pick<InvoiceRow, "total_incl_cents" | "amount_paid_cents">): number {
  return Math.max(0, inv.total_incl_cents - inv.amount_paid_cents);
}

/**
 * A card's expiry as `MM/YY`, or null when the provider gave us neither.
 *
 * Never `toLocaleString` and never a Date — these arrive from Paystack as text and are
 * displayed as text; parsing them into a date only invents a timezone question.
 */
export function cardExpiry(month: string | null, year: string | null): string | null {
  if (!month && !year) return null;
  const mm = (month ?? "").padStart(2, "0").slice(-2);
  const yy = (year ?? "").slice(-2);
  if (!mm.trim() || !yy.trim()) return null;
  return `${mm}/${yy}`;
}

/** The card brand as a word, capitalised for display. Falls back to nothing. */
export function cardBrandLabel(brand: string | null): string | null {
  if (!brand) return null;
  const b = brand.trim();
  if (!b) return null;
  return b.charAt(0).toUpperCase() + b.slice(1);
}

/** The cards a farm may actually be charged on: active, reusable, not removed. */
export function usableCards(rows: PaymentMethodRow[] | null | undefined): PaymentMethodRow[] {
  return (rows ?? []).filter((r) => r.status === "active" && !r.removed_at);
}

/** The default card, else the newest usable one, else null. */
export function primaryCard(rows: PaymentMethodRow[] | null | undefined): PaymentMethodRow | null {
  const usable = usableCards(rows);
  return usable.find((r) => r.is_default) ?? usable[0] ?? null;
}

/**
 * The one attempt that blocks every other attempt on an invoice.
 *
 * `pending` or `unknown` means the provider has not answered — recovery is verifying
 * THAT reference, never charging again — so a screen offering "try again" beside one of
 * these would be offering the exact thing that takes money twice.
 */
export function blockingAttempt(
  attempts: AttemptRow[] | null | undefined,
  invoiceId: string,
): AttemptRow | null {
  return (
    (attempts ?? []).find(
      (a) => a.invoice_id === invoiceId && (a.status === "pending" || a.status === "unknown"),
    ) ?? null
  );
}

/** The invoice a "pay now" / "try again" button should act on: the oldest still owed. */
export function payableInvoice(invoices: InvoiceRow[] | null | undefined): InvoiceRow | null {
  const owed = (invoices ?? []).filter(
    (i) => (i.status === "open" || i.status === "draft") && outstandingCents(i) > 0,
  );
  owed.sort((a, b) => a.period_start.localeCompare(b.period_start));
  return owed[0] ?? null;
}

/** Subscriptions an administrator should look at first. Worst first, as the app does. */
const ADMIN_ORDER: Record<string, number> = {
  downgraded: 0,
  grace: 1,
  past_due: 2,
  trialing: 3,
  active: 4,
  non_renewing: 5,
  cancelled: 6,
};

export function adminRank(status: string): number {
  return ADMIN_ORDER[status] ?? 9;
}

/** True when the commercial plan and the effective plan have parted company. */
export function planDiverged(
  sub: Pick<SubscriptionRow, "plan">,
  effectivePlan: string | null | undefined,
): boolean {
  return !!effectivePlan && effectivePlan !== sub.plan;
}

// ── Column lists for the tables the screens read alongside billing ───────────

/**
 * The price catalogue, as the screens read it.
 *
 * Enumerated rather than `*` for the same reason as everything else here: a column
 * added to this table later should have to be asked for. `notes` is deliberately absent
 * — it is an internal remark about a price generation, not something to put in front of
 * the customer it prices.
 */
export const PRICE_COLUMNS =
  "id, version_label, plan, billing_period, per_vehicle_monthly_incl_cents, " +
  "months_charged, vat_rate_bps, status, effective_from, effective_to";

/**
 * The seller's own settings. `authenticated` may read this table in full — they are our
 * company details and they appear on the customer's own invoice — but the screens want
 * only the handful of fields that change what is rendered.
 *
 * NOTE the primary key is a uuid and the one-row invariant is carried by a separate
 * `singleton boolean` (pinned true by a check constraint, unique-indexed). So the query
 * is `.eq("singleton", true)`, never a filter on `id`.
 */
export const SETTINGS_COLUMNS =
  "vat_registered, vat_rate_bps, legal_name, support_email, billing_email, " +
  "trial_days, grace_days, retry_offsets_days, downgrade_to_plan";

/**
 * The farm row, for the EFFECTIVE plan.
 *
 * `farms.plan` is what every entitlement gate resolves from; `billing_subscriptions.plan`
 * is what the farm bought. They part company only while a farm is downgraded for
 * non-payment, and the administrator's screen has to show both at once — so the farm row
 * is read separately rather than inferred from the subscription.
 */
export const FARM_BILLING_COLUMNS = "id, name, plan, billing_period, status, asset_count";

export type FarmBillingRow = {
  id: string;
  name: string;
  plan: string;
  billing_period: string;
  status: string;
  asset_count: number;
};

// ── The billable count, and the sentence that explains it ────────────────────

export type AssetBreakdown = { total: number; billable: number; notCounted: number };

/**
 * What is being counted, what is not, and the total — from the farm's own machine
 * statuses.
 *
 * The rule is `pricing.ts`'s `billableAssetCount`, which is `app.billable_asset_count`'s,
 * which is `app.recount_farm_assets`'s (0251). Counting here rather than reading
 * `farms.asset_count` is deliberate: a bill has to be able to say "37 counted, 4 not",
 * and a single maintained integer cannot say the second half. The two agree, because the
 * trigger applies the same rule; if they ever stop agreeing, the number that shows its
 * working is the one worth trusting.
 */
export function assetBreakdown(statuses: readonly string[]): AssetBreakdown {
  const billable = billableAssetCount(statuses);
  return { total: statuses.length, billable, notCounted: statuses.length - billable };
}

// ── Grouping, so a row can show what happened to it ──────────────────────────

/** Every payment recorded against one invoice, newest first. */
export function paymentsFor(
  payments: PaymentRow[] | null | undefined,
  invoiceId: string,
): PaymentRow[] {
  return (payments ?? [])
    .filter((p) => p.invoice_id === invoiceId)
    .sort((a, b) => b.paid_at.localeCompare(a.paid_at));
}

/** Every attempt made on one invoice, newest first. */
export function attemptsFor(
  attempts: AttemptRow[] | null | undefined,
  invoiceId: string,
): AttemptRow[] {
  return (attempts ?? [])
    .filter((a) => a.invoice_id === invoiceId)
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
}

/**
 * Attempts somebody has to look at before anything else can happen on their invoice.
 *
 * `unknown` first and oldest first, because an `unknown` attempt BLOCKS its invoice
 * entirely: the provider never told us whether the money moved, so the only safe
 * recovery is verifying that exact reference. A `pending` row is the same shape of
 * problem, one step earlier.
 */
export function reconcileQueue(attempts: AttemptRow[] | null | undefined): AttemptRow[] {
  return (attempts ?? [])
    .filter((a) => a.status === "unknown" || a.status === "pending")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "unknown" ? -1 : 1;
      return a.requested_at.localeCompare(b.requested_at);
    });
}

/**
 * Whether a "try the payment again" button may be offered — and if not, what is in the
 * way, so the screen can say so instead of showing a button that always fails.
 *
 * The middle test is the one that matters. An attempt still in flight means the provider
 * has not told us whether the money moved; a retry beside it is the exact button that
 * takes a farmer's money twice. The database refuses it anyway
 * (`billing_payment_attempts_inflight_uq`), which is what makes the refusal safe — but a
 * screen that offers it is still lying about what will happen.
 */
export type RetryOffer =
  | { kind: "offer"; invoice: InvoiceRow; amountCents: number }
  | { kind: "blocked"; by: AttemptRow }
  | { kind: "none" };

export function retryOffer(
  invoice: InvoiceRow | null,
  attempts: AttemptRow[] | null | undefined,
): RetryOffer {
  if (!invoice) return { kind: "none" };
  const blocking = blockingAttempt(attempts, invoice.id);
  if (blocking) return { kind: "blocked", by: blocking };
  const owed = outstandingCents(invoice);
  if (owed <= 0) return { kind: "none" };
  return { kind: "offer", invoice, amountCents: owed };
}

// ── The administrator's list ─────────────────────────────────────────────────

/**
 * One row of `/admin/billing`: the subscription, the farm it belongs to, and whether the
 * two plans have parted company.
 *
 * A subscription whose farm row is missing is KEPT rather than dropped. It should not
 * happen — `farm_id` is a NOT NULL foreign key — but an administrator's list exists
 * precisely to show the state nobody expected, and quietly filtering a row out of a
 * billing console is how a farm stops being chased.
 */
export type AdminBillingRow = {
  sub: SubscriptionRow;
  farm: FarmBillingRow | null;
  /** `farms.plan` — what the entitlement gates actually honour. */
  effectivePlan: string | null;
  /** True when the effective plan is not the plan they bought (a non-payment downgrade). */
  diverged: boolean;
};

export function adminBillingRows(
  subs: SubscriptionRow[] | null | undefined,
  farms: FarmBillingRow[] | null | undefined,
): AdminBillingRow[] {
  const byId = new Map((farms ?? []).map((f) => [f.id, f]));
  const rows: AdminBillingRow[] = (subs ?? []).map((sub) => {
    const farm = byId.get(sub.farm_id) ?? null;
    const effectivePlan = farm?.plan ?? null;
    return { sub, farm, effectivePlan, diverged: planDiverged(sub, effectivePlan) };
  });
  // Worst first, as every ranked list in this app orders itself; then by name, so the
  // order is stable between renders rather than however Postgres happened to feel.
  rows.sort((a, b) => {
    const r = adminRank(a.sub.status) - adminRank(b.sub.status);
    if (r !== 0) return r;
    return (a.farm?.name ?? "").localeCompare(b.farm?.name ?? "");
  });
  return rows;
}

/** How many of the listed subscriptions are in each state worth a headline. */
export function adminTotals(rows: AdminBillingRow[]): {
  all: number;
  failing: number;
  downgraded: number;
  trialing: number;
} {
  return {
    all: rows.length,
    failing: rows.filter((r) => r.sub.status === "past_due" || r.sub.status === "grace").length,
    downgraded: rows.filter((r) => r.sub.status === "downgraded").length,
    trialing: rows.filter((r) => r.sub.status === "trialing").length,
  };
}

/**
 * Is there any price at all that could be charged today?
 *
 * `billing_price_versions` ships EMPTY on purpose, so this is `false` in every
 * environment until the founder confirms a figure. Both screens lead with that fact
 * rather than rendering a total of R0,00 — the one wrong number a customer would never
 * think to question.
 */
export function anyActivePrice(rows: PriceRow[] | null | undefined, today = new Date()): boolean {
  const day = isoDay(today);
  return (rows ?? []).some(
    (r) =>
      r.status === "active" &&
      r.per_vehicle_monthly_incl_cents != null &&
      !(r.effective_from && r.effective_from > day) &&
      !(r.effective_to && r.effective_to < day),
  );
}
