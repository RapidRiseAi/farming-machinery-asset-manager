import Link from "next/link";

import { requireRole, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate, vatPercent } from "@/lib/format";

import {
  ATTEMPT_COLUMNS,
  INVOICE_COLUMNS,
  PAYMENT_COLUMNS,
  PAYMENT_METHOD_COLUMNS,
  PRICE_COLUMNS,
  SETTINGS_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  FARM_BILLING_COLUMNS,
  SUBSCRIPTION_LOOK,
  INVOICE_LOOK,
  accountNotice,
  activePrice,
  assetBreakdown,
  billingLook,
  cardBrandLabel,
  cardExpiry,
  cardExpiryState,
  estimateNextCharge,
  nextChargeState,
  outstandingCents,
  paymentsFor,
  payableInvoice,
  primaryCard,
  planDiverged,
  retryOffer,
  showsVat,
  type AttemptRow,
  type BillingSettingsRow,
  type FarmBillingRow,
  type InvoiceRow,
  type PaymentMethodRow,
  type PaymentRow,
  type PriceRow,
  type SubscriptionRow,
} from "@/lib/billing/view";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { GetStarted } from "@/components/ui/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { buttonVariants } from "@/components/ui/button";
import { AdminIcon, DocumentsIcon, InfoIcon, LockIcon, WarningIcon } from "@/components/ui/icons";

// Written by Agent 2. Imported, never re-declared — a "use server" module is the only
// place a server action may live, and duplicating one here would give the same button
// two different implementations.
import {
  cancelSubscription,
  changeOwnPlan,
  changeVehicleSlots,
  replacePaymentMethod,
  retryPayment,
  startCheckout,
} from "./actions";
import { PLANS, BILLING_PERIODS } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * What FleetWise costs this farm, how it gets paid, and every bill and receipt.
 *
 * ── WHO MAY OPEN IT ──────────────────────────────────────────────────────────
 * The owner and Rapid Rise, and nobody else. `requireRole` bounces everyone else to
 * their OWN home rather than to `/dashboard`, which for a driver is the owner's money
 * page. This is a route-level denial, not a hidden nav item: RLS refuses the rows too
 * (`app.is_farm_billing_admin`), so a manager typing the URL gets neither the screen nor
 * the data behind it.
 *
 * ── THE ONE THING THIS SCREEN MUST NOT DO ────────────────────────────────────
 * There is no confirmed price. `billing_price_versions` ships EMPTY on purpose — two
 * documents in this repo disagree about the figures and the founder has confirmed
 * neither — so with no active price row the invoice generator raises nothing and nothing
 * can be charged.
 *
 * A screen that quietly rendered R0,00 there would be stating a price, and R0,00 is the
 * one wrong price a customer would never think to question. So the estimate arrives as a
 * DISCRIMINATED UNION (`Estimate` in `lib/billing/view.ts`) with an explicit `unpriced`
 * case, and this page renders words for it: your plan is on, nothing is being charged, a
 * price will be confirmed, and you will be asked for a card before anything is taken.
 * The moment a price is activated the same code path renders the real figure — no edit
 * here, no deploy.
 *
 * ── VAT ──────────────────────────────────────────────────────────────────────
 * Rapid Rise is not VAT-registered, and `app.billing_force_vat_rate` pins every invoice's
 * rate to zero while that holds. So no VAT line appears and nothing is ever headed "Tax
 * invoice" (VAT Act s20(4) reserves that for a registered vendor). The arithmetic is
 * built in full behind `showsVat()`, so registering later is a flag flip that restates
 * no historical bill.
 *
 * ── THE CREDENTIAL RULE ──────────────────────────────────────────────────────
 * `billing_payment_methods.authorization_code` is a Paystack charging credential and is
 * not granted to `authenticated` at the COLUMN level. `select=*` on that table returns a
 * permission error, which is intended — and would also be a 500 on a farmer's screen. So
 * the columns are enumerated once in `view.ts` and spread here. Note the query does NOT
 * filter on `deleted_at` either: that column is not granted, and a WHERE clause needs
 * SELECT privilege on what it names. The RLS policy already excludes deleted rows.
 *
 * ── THE STRESSED READER ──────────────────────────────────────────────────────
 * `past_due`, `grace` and `downgraded` are written as a person would say them: what
 * happened, what to do about it, and — every time, without exception — that NOTHING HAS
 * BEEN DELETED. A farmer reading this screen is already worried, and a dunning notice
 * would be the wrong genre for a message whose real content is "your data is fine".
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; checkout?: string }>;
}) {
  const profile = await requireRole(["owner", "rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;

  // rr_admin has no farm of its own; in support mode `currentFarmId` narrows to the
  // customer being helped, which is exactly the farm whose bill should be on screen.
  const farmId = profile.role === "rr_admin" ? await currentFarmId(profile) : profile.farm_id;

  // Who may change what the farm pays. The same rule `requireBillingAdmin` enforces in the
  // actions — owner, or Rapid Rise — and it is enforced THERE regardless of this. Hiding a
  // control is not a guard; this only spares a manager a button that would refuse them.
  const canManage = profile.role === "owner" || profile.role === "rr_admin";

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("billing.title", locale)}</h1>
        <p className="text-sm text-sand-600">{t("billing.lead", locale)}</p>
      </div>
      <span className="ml-auto">
        <PageInfoButton infoKey="billing" locale={locale} />
      </span>
    </div>
  );

  if (!farmId) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {header}
        <GetStarted
          icon={<AdminIcon />}
          title={t("billing.noFarmTitle", locale)}
          hint={t("billing.noFarmBody", locale)}
          action={
            profile.role === "rr_admin" ? (
              <Link href="/admin/billing" className={buttonVariants({ variant: "primary" })}>
                {t("billing.noFarmCta", locale)}
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  const supabase = await createClient();
  const [
    { data: farmData },
    { data: settingsData },
    { data: subData },
    { data: priceData },
    { data: machineData },
    { data: invoiceData },
    { data: paymentData },
    { data: attemptData },
    { data: methodData },
  ] = await Promise.all([
    supabase.from("farms").select(FARM_BILLING_COLUMNS).eq("id", farmId).maybeSingle(),
    // The primary key is a uuid; the one-row invariant lives on `singleton`, so this is
    // the only correct way to address the row.
    supabase.from("billing_settings").select(SETTINGS_COLUMNS).eq("singleton", true).maybeSingle(),
    supabase
      .from("billing_subscriptions")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase.from("billing_price_versions").select(PRICE_COLUMNS).eq("status", "active"),
    supabase.from("machines").select("status").eq("farm_id", farmId).is("deleted_at", null),
    supabase
      .from("billing_invoices")
      .select(INVOICE_COLUMNS)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .order("period_start", { ascending: false })
      .limit(24),
    supabase
      .from("billing_payments")
      .select(PAYMENT_COLUMNS)
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .order("paid_at", { ascending: false })
      .limit(48),
    supabase
      .from("billing_payment_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("farm_id", farmId)
      .order("requested_at", { ascending: false })
      .limit(24),
    // NEVER `*`, and never a filter on `deleted_at` — see the credential note above.
    supabase.from("billing_payment_methods").select(PAYMENT_METHOD_COLUMNS).eq("farm_id", farmId),
  ]);

  const farm = (farmData as FarmBillingRow | null) ?? null;
  const settings = (settingsData as BillingSettingsRow | null) ?? null;
  const sub = (subData as SubscriptionRow | null) ?? null;
  const prices = (priceData as PriceRow[] | null) ?? [];
  const statuses = ((machineData as { status: string }[] | null) ?? []).map((m) => m.status);
  const invoices = (invoiceData as InvoiceRow[] | null) ?? [];
  const payments = (paymentData as PaymentRow[] | null) ?? [];
  const attempts = (attemptData as AttemptRow[] | null) ?? [];
  const methods = (methodData as PaymentMethodRow[] | null) ?? [];

  const vatRegistered = settings?.vat_registered ?? false;
  const assets = assetBreakdown(statuses);

  // The COMMERCIAL plan (what they bought) drives the price lookup; `farms.plan` is the
  // EFFECTIVE plan and may be lower while a payment is outstanding. Pricing a downgraded
  // farm off its reduced plan would quietly change what they are billed for missing a
  // payment, which is not what a downgrade is.
  const commercialPlan = sub?.plan ?? farm?.plan ?? "essential";
  const period = sub?.billing_period ?? farm?.billing_period ?? "monthly";
  const price = activePrice(prices, commercialPlan, period);
  const estimate = estimateNextCharge({ price, assetCount: assets.billable, vatRegistered });
  const next = nextChargeState(sub, estimate);
  const notice = accountNotice(sub);
  const diverged = sub ? planDiverged(sub, farm?.plan) : false;

  const card = primaryCard(methods);
  // Mirrors `app.billing_cards_expiring` exactly — same 45-day horizon, same
  // end-of-the-printed-month reading, same silences — so the screen and the email cannot
  // become two opinions. `view.test.ts` pins the arithmetic and it was compared against
  // the SQL itself over 182 (month, year) pairs.
  const expiry = cardExpiryState(card, sub, new Date().toISOString().slice(0, 10));
  const payable = payableInvoice(invoices);
  const offer = retryOffer(payable, attempts);

  const nextSentence = (() => {
    switch (next.kind) {
      case "dueOn":
        return t("billing.nextDue", locale).replace("{date}", shortDate(next.on, locale));
      case "trialEnds":
        return t("billing.nextTrial", locale).replace("{date}", shortDate(next.on, locale));
      case "retryOn":
        return t("billing.nextRetry", locale).replace("{date}", shortDate(next.on, locale));
      case "graceEndsOn":
        return t("billing.nextGrace", locale).replace("{date}", shortDate(next.on, locale));
      case "endsOn":
        return t("billing.nextEnds", locale).replace("{date}", shortDate(next.on, locale));
      case "unpriced":
        return t("billing.nextUnpriced", locale);
      default:
        return t("billing.nextNone", locale);
    }
  })();

  const endsOn = sub?.ended_on ?? sub?.current_period_end ?? null;
  const cancellable =
    !!sub && sub.status !== "cancelled" && sub.status !== "non_renewing" && !sub.cancel_at_period_end;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {header}

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.savedChanges", locale) : undefined} />

      {/* Back from Paystack. The callback computes this state carefully and then nothing
          rendered it, so somebody who had just handed over a card was told nothing at all.
          "Pending" gets its own sentence rather than being folded into failure: it is the
          ordinary case where the webhook is a second behind the browser, and telling
          somebody their payment failed when it is merely in flight makes them pay twice. */}
      {sp.checkout === "paid" ? (
        <Flash tone="success" message={t("billing.checkoutPaid", locale)} />
      ) : null}
      {/* The callback sends everybody here. That is a fair receipt and a poor welcome:
          a farm that has just paid has NO vehicles yet, and nothing else on this page
          points at adding one. Shown only while the fleet really is empty, so it
          disappears the moment it stops being true rather than nagging somebody who has
          forty machines. */}
      {sp.checkout === "paid" && assets.total === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("billing.nextStepsTitle", locale)}</CardTitle>
          </CardHeader>
          <p className="text-sm leading-relaxed text-sand-700">
            {t("billing.nextStepsBody", locale)}
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Link href="/machines/new" className={buttonVariants({ variant: "primary" })}>
              {t("billing.nextStepsAdd", locale)}
            </Link>
            <Link href="/onboarding" className={buttonVariants({ variant: "secondary" })}>
              {t("billing.nextStepsChecklist", locale)}
            </Link>
          </div>
        </Card>
      ) : null}

      {sp.checkout === "pending" ? (
        <Flash tone="info" message={t("billing.checkoutPending", locale)} />
      ) : null}
      {sp.checkout === "failed" ? (
        <Flash tone="error" message={t("billing.checkoutFailed", locale)} />
      ) : null}
      {sp.checkout === "unknown" ? (
        <Flash tone="warning" message={t("billing.checkoutUnknown", locale)} />
      ) : null}

      {/* What has gone wrong, in the order a worried person needs it: what happened,
          what to do, and that nothing has been deleted. */}
      {notice ? (
        <Card
          className={
            notice.tone === "error"
              ? "border-callout-danger-edge bg-callout-danger-bg"
              : notice.tone === "warning"
                ? "border-callout-warn-edge bg-callout-warn-bg"
                : "border-callout-info-edge bg-callout-info-bg"
          }
        >
          <div className="flex items-start gap-3">
            <span
              className={
                notice.tone === "info"
                  ? "mt-0.5 shrink-0 text-xl text-callout-info-ink"
                  : notice.tone === "error"
                    ? "mt-0.5 shrink-0 text-xl text-callout-danger-ink"
                    : "mt-0.5 shrink-0 text-xl text-callout-warn-ink"
              }
              aria-hidden
            >
              {notice.tone === "info" ? <InfoIcon /> : <WarningIcon />}
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold text-sand-900">
                {t(`billing.notice.${notice.stem}Title`, locale)}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-sand-800">
                {t(`billing.notice.${notice.stem}Body`, locale)}
              </p>
              {notice.offerRetry ? (
                <p className="mt-2 text-sm font-medium text-sand-800">
                  {t("billing.notice.nothingDeleted", locale)}
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ── The plan ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("billing.planTitle", locale)}</CardTitle>
        </CardHeader>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <dt className="text-sand-600">{t("billing.planField", locale)}</dt>
          <dd className="font-medium text-sand-900 sm:text-right">
            {t(`plan.${diverged && farm ? farm.plan : commercialPlan}`, locale)}
          </dd>

          <dt className="text-sand-600">{t("billing.periodField", locale)}</dt>
          <dd className="font-medium text-sand-900 sm:text-right">{t(`billingPeriod.${period}`, locale)}</dd>

          {sub ? (
            <>
              <dt className="text-sand-600">{t("billing.statusField", locale)}</dt>
              <dd className="sm:text-right">
                <StatusBadge
                  label={enumLabel("billingSubStatus", sub.status, locale)}
                  tone={billingLook(SUBSCRIPTION_LOOK, sub.status).tone}
                  shape={billingLook(SUBSCRIPTION_LOOK, sub.status).shape}
                  size="md"
                />
              </dd>
            </>
          ) : null}
        </dl>

        {diverged && sub ? (
          <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-700">
            {/* The sentence has no {plan}/{bought} slots, so these two replaces did
                nothing. Naming both plans here would be an improvement, but it is a copy
                decision in two languages rather than a bug fix — the card above already
                states the plan in force. */}
            {t("billing.reducedNote", locale)}
          </p>
        ) : null}

        {!sub ? (
          <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-700">
            <span className="block font-semibold text-sand-900">{t("billing.noSubTitle", locale)}</span>
            {t("billing.noSubBody", locale)}
          </p>
        ) : null}

        {sub && canManage ? (
          <form action={changeOwnPlan} className="mt-4 border-t border-sand-200 pt-4">
            <p className="text-sm font-semibold text-sand-900">
              {t("billing.changePlanTitle", locale)}
            </p>
            <p className="mt-1 text-sm text-sand-600">{t("billing.changePlanNote", locale)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="plan">
                {t("billing.planField", locale)}
              </label>
              <select
                id="plan"
                name="plan"
                defaultValue={sub.plan}
                className="min-h-12 flex-1 rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
              >
                {PLANS.map((p) => (
                  <option key={p} value={p}>
                    {t(`plan.${p}`, locale)}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="billing_period">
                {t("billing.periodField", locale)}
              </label>
              <select
                id="billing_period"
                name="billing_period"
                defaultValue={sub.billing_period}
                className="min-h-12 flex-1 rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
              >
                {BILLING_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`billingPeriod.${p}`, locale)}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secondary">
                {t("billing.changePlanSubmit", locale)}
              </SubmitButton>
            </div>
          </form>
        ) : null}
      </Card>

      {/* ── What is being counted, and the rule, in words ───────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("billing.vehiclesTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-3xl font-bold leading-none tracking-tight tabular-nums text-sand-900">
          {assets.billable === 1
            ? t("billing.vehiclesCountOne", locale)
            : t("billing.vehiclesCount", locale).replace("{n}", String(assets.billable))}
        </p>
        <p className="mt-2 text-sm text-sand-700">
          {assets.notCounted > 0
            ? t("billing.vehiclesNotCounted", locale)
                .replace("{n}", String(assets.notCounted))
                .replace("{total}", String(assets.total))
            : t("billing.vehiclesAllCounted", locale).replace("{total}", String(assets.total))}
        </p>
        <p className="mt-2 text-sm text-sand-600">{t("billing.vehiclesRule", locale)}</p>

        {sub && canManage ? (
          <form action={changeVehicleSlots} className="mt-4 border-t border-sand-200 pt-4">
            <p className="text-sm font-semibold text-sand-900">
              {t("billing.slotsTitle", locale)}
            </p>
            <p className="mt-1 text-sm text-sand-600">
              {sub.asset_quota == null
                ? t("billing.slotsNoneYet", locale)
                : t("billing.slotsUsing", locale)
                    .replace("{used}", String(assets.billable))
                    .replace("{quota}", String(sub.asset_quota))}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="quota">
                {t("billing.slotsTitle", locale)}
              </label>
              <input
                id="quota"
                name="quota"
                type="number"
                inputMode="numeric"
                min={Math.max(assets.billable, 1)}
                defaultValue={sub.asset_quota ?? Math.max(assets.billable, 1)}
                className="min-h-12 w-28 rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
              />
              <SubmitButton variant="secondary">
                {t("billing.slotsSubmit", locale)}
              </SubmitButton>
            </div>
            <p className="mt-2 text-xs text-sand-600">{t("billing.slotsRule", locale)}</p>
          </form>
        ) : null}
      </Card>

      {/* ── The estimate. `unpriced` is today's state and is said in words. ─── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("billing.estimateTitle", locale)}</CardTitle>
        </CardHeader>

        {estimate.kind === "unpriced" ? (
          <div className="rounded-lg border border-callout-info-edge bg-callout-info-bg px-3.5 py-3">
            <p className="text-base font-semibold text-sand-900">{t("billing.unpricedTitle", locale)}</p>
            <p className="mt-1 text-sm leading-relaxed text-sand-800">{t("billing.unpricedBody", locale)}</p>
            <p className="mt-2 text-sm leading-relaxed text-sand-700">{t("billing.unpricedNote", locale)}</p>
          </div>
        ) : estimate.kind === "bespoke" ? (
          <div className="rounded-lg border border-sand-200 bg-sand-50 px-3.5 py-3">
            <p className="text-base font-semibold text-sand-900">{t("billing.bespokeTitle", locale)}</p>
            <p className="mt-1 text-sm leading-relaxed text-sand-700">{t("billing.bespokeBody", locale)}</p>
          </div>
        ) : (
          <>
            <p className="text-3xl font-bold leading-none tracking-tight tabular-nums text-sand-900">
              {rands(estimate.totalInclCents)}
            </p>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <dt className="text-sand-600">{t("billing.perVehicle", locale)}</dt>
              <dd className="tabular-nums text-sand-900 sm:text-right">
                {rands(estimate.perVehicleInclCents)}
              </dd>

              <dt className="text-sand-600">{t("billing.timesVehicles", locale).replace("{n}", String(estimate.assetCount))}</dt>
              <dd className="tabular-nums text-sand-900 sm:text-right">
                {rands(estimate.perVehicleInclCents * estimate.assetCount)}
              </dd>

              {estimate.monthsCharged > 1 ? (
                <>
                  <dt className="text-sand-600">
                    {t("billing.timesMonths", locale).replace("{n}", String(estimate.monthsCharged))}
                  </dt>
                  <dd className="tabular-nums text-sand-900 sm:text-right">
                    {rands(estimate.totalInclCents)}
                  </dd>
                </>
              ) : null}

              {/* Built in full and gated on one boolean: registering for VAT later is a
                  flag flip, not a rewrite. Today it renders nothing at all. */}
              {showsVat(vatRegistered, estimate.vatRateBps) ? (
                <>
                  <dt className="text-sand-600">{t("billing.subtotal", locale)}</dt>
                  <dd className="tabular-nums text-sand-900 sm:text-right">
                    {rands(estimate.subtotalExVatCents)}
                  </dd>
                  <dt className="text-sand-600">
                    {t("billing.vat", locale).replace("{rate}", vatPercent(estimate.vatRateBps))}
                  </dt>
                  <dd className="tabular-nums text-sand-900 sm:text-right">{rands(estimate.vatCents)}</dd>
                </>
              ) : null}

              <dt className="font-semibold text-sand-900">{t("billing.total", locale)}</dt>
              <dd className="font-semibold tabular-nums text-sand-900 sm:text-right">
                {rands(estimate.totalInclCents)}
              </dd>
            </dl>

            {period === "annual" ? (
              <p className="mt-2 text-sm text-sand-600">
                {t("billing.annualNote", locale).replace("{n}", String(estimate.monthsCharged))}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-sand-500">
              {t("billing.priceVersion", locale).replace("{label}", estimate.versionLabel)}
            </p>
            {!vatRegistered ? (
              <p className="mt-1 text-xs text-sand-500">{t("billing.noVatNote", locale)}</p>
            ) : null}
          </>
        )}

        <div className="mt-4 border-t border-sand-200 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-sand-500">
            {t("billing.nextTitle", locale)}
          </p>
          <p className="mt-1 text-sm text-sand-800">{nextSentence}</p>
        </div>
      </Card>

      {/* ── How you pay ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("billing.cardTitle", locale)}</CardTitle>
        </CardHeader>

        {card ? (
          <div>
            <p className="text-base font-semibold text-sand-900">
              {cardBrandLabel(card.card_brand)
                ? t("billing.cardLine", locale)
                    .replace("{brand}", cardBrandLabel(card.card_brand) as string)
                    .replace("{last4}", card.last4 ?? "····")
                : t("billing.cardLineNoBrand", locale).replace("{last4}", card.last4 ?? "····")}
            </p>
            {cardExpiry(card.exp_month, card.exp_year) ? (
              <p className="mt-1 text-sm text-sand-700">
                {t("billing.cardExpires", locale).replace(
                  "{expiry}",
                  cardExpiry(card.exp_month, card.exp_year) as string,
                )}
              </p>
            ) : null}
            {card.is_default ? (
              <p className="mt-1 text-sm text-sand-600">{t("billing.cardDefault", locale)}</p>
            ) : null}
            <p className="mt-2 text-xs text-sand-500">{t("billing.cardOnly4", locale)}</p>
          </div>
        ) : (
          <div>
            <p className="text-base font-semibold text-sand-900">{t("billing.cardNone", locale)}</p>
            <p className="mt-1 text-sm text-sand-700">{t("billing.cardNoneBody", locale)}</p>
          </div>
        )}

        {/* What the system has known for up to 45 days and never said on a screen.
            WARN, NEVER BLOCK: a card past its printed expiry often still works — issuers
            reissue on the same PAN and the networks run account-updater services — so
            nothing here stops a charge being attempted. It sits directly above the
            "Replace card" button, which is the one thing that fixes it. */}
        {expiry.kind === "soon" || expiry.kind === "expired" ? (
          <div className="mt-4">
            <Flash
              tone={expiry.kind === "expired" ? "error" : "warning"}
              message={t(
                expiry.kind === "expired" ? "billing.cardExpired" : "billing.cardExpiringSoon",
                locale,
              ).replace("{date}", shortDate(expiry.on, locale))}
            />
          </div>
        ) : null}

        {/* An attempt still in flight blocks every other attempt on that bill: the
            provider never said whether the money moved, so the only safe recovery is
            verifying that exact reference. A "try again" button here would be offering
            the one action that takes the money twice. */}
        {offer.kind === "blocked" ? (
          <div className="mt-4 rounded-lg border border-callout-warn-edge bg-callout-warn-bg px-3.5 py-3">
            <p className="text-sm font-semibold text-sand-900">{t("billing.waitTitle", locale)}</p>
            <p className="mt-1 text-sm text-sand-800">
              {t("billing.waitBody", locale).replace("{date}", shortDate(offer.by.requested_at, locale))}
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          {offer.kind === "offer" ? (
            card ? (
              <form action={retryPayment}>
                <input type="hidden" name="farmId" value={farmId} />
                <input type="hidden" name="invoiceId" value={offer.invoice.id} />
                <SubmitButton variant="primary">
                  {sub && (sub.status === "past_due" || sub.status === "grace" || sub.status === "downgraded")
                    ? t("billing.tryAgain", locale)
                    : t("billing.payNow", locale).replace("{amount}", rands(offer.amountCents))}
                </SubmitButton>
              </form>
            ) : (
              <form action={startCheckout}>
                <input type="hidden" name="farmId" value={farmId} />
                <input type="hidden" name="invoiceId" value={offer.invoice.id} />
                <SubmitButton variant="primary">
                  {t("billing.payNow", locale).replace("{amount}", rands(offer.amountCents))}
                </SubmitButton>
              </form>
            )
          ) : null}

          {card ? (
            <form action={replacePaymentMethod}>
              <input type="hidden" name="farmId" value={farmId} />
              <SubmitButton variant="secondary">{t("billing.replaceCard", locale)}</SubmitButton>
            </form>
          ) : estimate.kind === "priced" && offer.kind !== "offer" ? (
            // Only offered when there is genuinely a price to charge against. With the
            // catalogue empty there is nothing to authorise a card for, and a button
            // that cannot do anything is its own small dishonesty.
            <form action={startCheckout}>
              <input type="hidden" name="farmId" value={farmId} />
              <SubmitButton variant="primary">{t("billing.addCard", locale)}</SubmitButton>
            </form>
          ) : null}
        </div>
      </Card>

      {/* ── Bills and receipts ─────────────────────────────────────────────── */}
      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardTitle>{t("billing.historyTitle", locale)}</CardTitle>
          <p className="mt-1 text-sm text-sand-600">{t("billing.historyLead", locale)}</p>
        </div>

        {invoices.length === 0 ? (
          <div className="p-4 sm:p-5">
            <GetStarted
              icon={<DocumentsIcon />}
              title={t("billing.historyEmptyTitle", locale)}
              hint={t("billing.historyEmptyBody", locale)}
            />
          </div>
        ) : (
          <div className="mt-3">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("billing.colRef", locale)}</Th>
                  <Th>{t("billing.colPeriod", locale)}</Th>
                  <Th className="text-right">{t("billing.colVehicles", locale)}</Th>
                  <Th className="text-right">{t("billing.colTotal", locale)}</Th>
                  <Th>{t("billing.colPaid", locale)}</Th>
                  <Th>{t("billing.colStatus", locale)}</Th>
                  <Th>{t("billing.colReceipt", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {invoices.map((inv) => {
                  const owed = outstandingCents(inv);
                  const receipts = paymentsFor(payments, inv.id);
                  const look = billingLook(INVOICE_LOOK, inv.status);
                  return (
                    <Tr key={inv.id}>
                      <Td className="font-medium text-sand-900">{inv.invoice_ref}</Td>
                      <Td className="whitespace-nowrap text-sand-600">
                        {shortDate(inv.period_start, locale)} – {shortDate(inv.period_end, locale)}
                      </Td>
                      <Td className="text-right tabular-nums">{inv.asset_count}</Td>
                      <Td className="text-right tabular-nums">{rands(inv.total_incl_cents)}</Td>
                      <Td>
                        <span className="block tabular-nums text-sand-900">
                          {rands(inv.amount_paid_cents)}
                        </span>
                        {owed > 0 ? (
                          <span className="block text-xs text-status-due">
                            {t("billing.stillOwed", locale).replace("{amount}", rands(owed))}
                          </span>
                        ) : receipts.length > 0 ? (
                          <span className="block text-xs text-sand-500">
                            {t("billing.receiptOn", locale).replace(
                              "{date}",
                              shortDate(receipts[0].paid_at, locale),
                            )}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <StatusBadge
                          label={enumLabel("billingInvoiceStatus", inv.status, locale)}
                          tone={look.tone}
                          shape={look.shape}
                        />
                      </Td>
                      <Td>
                        {/* Two documents, and they are not interchangeable. The RECEIPT
                            says "Paid in full", so it is offered only when that is true —
                            handing it over for money that has not arrived would be a false
                            record of payment. The INVOICE is the bill: it is what somebody
                            needs in order to PAY, and until now it existed nowhere in the
                            product, so a farm office that pays against invoices had nothing
                            to file. Both routes enforce this as well; these are only the
                            affordances. */}
                        <div className="flex flex-col gap-1">
                          {inv.status === "paid" ? (
                            <a
                              href={`/api/billing/invoice/${inv.id}/receipt.pdf`}
                              className="text-sm font-medium text-brand-ink underline"
                            >
                              {t("billing.downloadReceipt", locale)}
                            </a>
                          ) : null}
                          {/* Not `draft` — never issued, so nobody has decided to charge it
                              — and not `void`, which was withdrawn. */}
                          {inv.status !== "draft" && inv.status !== "void" ? (
                            <a
                              href={`/api/billing/invoice/${inv.id}/invoice.pdf`}
                              className="text-sm font-medium text-brand-ink underline"
                            >
                              {t("billing.downloadInvoice", locale)}
                            </a>
                          ) : null}
                          {inv.status === "draft" || inv.status === "void" ? (
                            <span className="text-sm text-sand-500">—</span>
                          ) : null}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* ── Stopping ───────────────────────────────────────────────────────── */}
      {cancellable && sub ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("billing.cancelTitle", locale)}</CardTitle>
          </CardHeader>
          <p className="text-sm text-sand-700">{t("billing.cancelLead", locale)}</p>
          <div className="mt-3">
            <ConfirmDialog
              action={cancelSubscription}
              triggerVariant="secondary"
              triggerLabel={t("billing.cancelTrigger", locale)}
              triggerIcon={<LockIcon />}
              title={t("billing.cancelDialogTitle", locale)}
              intro={t("billing.cancelIntro", locale).replace(
                "{date}",
                endsOn ? shortDate(endsOn, locale) : t("ui.none", locale),
              )}
              facts={[
                { label: t("billing.cancelFactPlan", locale), value: t(`plan.${sub.plan}`, locale) },
                {
                  label: t("billing.cancelFactUntil", locale),
                  value: endsOn ? shortDate(endsOn, locale) : t("ui.none", locale),
                },
              ]}
              consequencesTitle={t("billing.cancelWhatHappens", locale)}
              consequences={[
                t("billing.cancelEffect1", locale),
                t("billing.cancelEffect2", locale).replace(
                  "{date}",
                  endsOn ? shortDate(endsOn, locale) : t("ui.none", locale),
                ),
                t("billing.cancelEffect3", locale),
              ]}
              footnote={t("billing.cancelFootnote", locale)}
              confirmLabel={t("billing.cancelYes", locale)}
              cancelLabel={t("billing.cancelNo", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="farmId" value={farmId} />
              <input type="hidden" name="subscriptionId" value={sub.id} />
            </ConfirmDialog>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("billing.helpTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="text-sm text-sand-700">
          {settings?.support_email || settings?.billing_email
            ? t("billing.helpBody", locale).replace(
                "{email}",
                (settings.support_email || settings.billing_email) as string,
              )
            : t("billing.helpNoEmail", locale)}
        </p>
      </Card>
    </div>
  );
}
