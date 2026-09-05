import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate, dateTime } from "@/lib/format";
import { PLANS, BILLING_PERIODS } from "@/lib/entitlements";
import {
  billingProvider,
  billingConfigured,
  chargingEnabled,
  paystackKeyMode,
} from "@/lib/billing/config";

import {
  ATTEMPT_COLUMNS,
  ATTEMPT_LOOK,
  FARM_BILLING_COLUMNS,
  INVOICE_COLUMNS,
  INVOICE_LOOK,
  PAYMENT_COLUMNS,
  PRICE_COLUMNS,
  SETTINGS_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  SUBSCRIPTION_LOOK,
  adminBillingRows,
  adminTotals,
  anyActivePrice,
  billingLook,
  payableInvoice,
  reconcileQueue,
  retryOffer,
  type AttemptRow,
  type BillingSettingsRow,
  type FarmBillingRow,
  type InvoiceRow,
  type PaymentRow,
  type PriceRow,
  type SubscriptionRow,
} from "@/lib/billing/view";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { Flash } from "@/components/ui/flash";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { GetStarted } from "@/components/ui/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { buttonVariants } from "@/components/ui/button";
import { AdminIcon, CheckIcon, LockIcon, SearchIcon, WarningIcon } from "@/components/ui/icons";

// Written by Agent 2. Imported, never re-declared.
import { adminReconcileAttempt, adminRetryCharge, adminSetPlan } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Rapid Rise's own view of who is paying, and of whether anything CAN be charged.
 *
 * ── WHY THE KILL SWITCH IS THE FIRST CARD ────────────────────────────────────
 * Charging is guarded by two independent env values — `BILLING_PROVIDER=paystack` wires
 * the adapter, `BILLING_CHARGING_ENABLED=true` additionally permits a charge — and both
 * default OFF. An administrator pressing "try this payment again" is about to move real
 * money out of a farmer's account, so the state of both switches is stated in words at
 * the top of the screen rather than being something you infer from a button failing.
 *
 * They are read SERVER-SIDE, through `lib/billing/config.ts`, which reads
 * `process.env` lazily inside each call. Nothing about the key itself is rendered: the
 * most this page says is whether the configured key has a test or a live shape, which is
 * the one fact that changes what a demonstration costs.
 *
 * ── WHAT IS DELIBERATELY NOT READABLE HERE ───────────────────────────────────
 * A Paystack authorization code, an authorization email, a hosted-checkout URL, an
 * access code, and every raw webhook payload. The first two are withheld by a COLUMN
 * grant in the database, so this page could not render them if it tried; the rest are
 * simply never selected (`ATTEMPT_COLUMNS` in `view.ts`), and `billing_webhook_events` is
 * service-role only, with no policy and no grant for `authenticated` at all. A billing
 * console is exactly the screen that ends up in a support screenshot.
 *
 * ── TWO PLANS, SHOWN AS TWO ──────────────────────────────────────────────────
 * `billing_subscriptions.plan` is what the farm BOUGHT; `farms.plan` is what the
 * entitlement gates actually honour. They part company only while a farm is downgraded
 * for non-payment. Collapsing them into one column would lose the record of what the
 * customer is owed on recovery, so the list shows both and names the difference.
 *
 * ── THE DETAIL PANEL IS A QUERY PARAM, NOT A ROUTE ───────────────────────────
 * `?farm=<id>` selects a subscription and the panel renders beneath the list. One screen,
 * no nested layout, and the back link is an ordinary anchor rather than history state.
 */
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ farm?: string; error?: string; saved?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const selectedFarmId = sp.farm && /^[0-9a-f-]{36}$/i.test(sp.farm) ? sp.farm : null;

  const supabase = await createClient();
  const [{ data: settingsData }, { data: priceData }, { data: subData }, { data: farmData }] =
    await Promise.all([
      supabase.from("billing_settings").select(SETTINGS_COLUMNS).eq("singleton", true).maybeSingle(),
      supabase
        .from("billing_price_versions")
        .select(PRICE_COLUMNS)
        .order("version_label", { ascending: true }),
      supabase
        .from("billing_subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      supabase.from("farms").select(FARM_BILLING_COLUMNS).order("name", { ascending: true }),
    ]);

  const settings = (settingsData as BillingSettingsRow | null) ?? null;
  const prices = (priceData as PriceRow[] | null) ?? [];
  const subs = (subData as SubscriptionRow[] | null) ?? [];
  const farms = (farmData as FarmBillingRow[] | null) ?? [];

  const rows = adminBillingRows(subs, farms);
  const totals = adminTotals(rows);
  const priced = anyActivePrice(prices);

  const selected = selectedFarmId ? rows.find((r) => r.sub.farm_id === selectedFarmId) ?? null : null;

  // Only fetch the detail when a farm is actually open — three more queries on every
  // list render would be paid by an administrator who has not asked for them yet.
  let invoices: InvoiceRow[] = [];
  let attempts: AttemptRow[] = [];
  let payments: PaymentRow[] = [];
  if (selected) {
    const [{ data: i }, { data: a }, { data: p }] = await Promise.all([
      supabase
        .from("billing_invoices")
        .select(INVOICE_COLUMNS)
        .eq("farm_id", selected.sub.farm_id)
        .is("deleted_at", null)
        .order("period_start", { ascending: false })
        .limit(12),
      supabase
        .from("billing_payment_attempts")
        .select(ATTEMPT_COLUMNS)
        .eq("farm_id", selected.sub.farm_id)
        .order("requested_at", { ascending: false })
        .limit(12),
      supabase
        .from("billing_payments")
        .select(PAYMENT_COLUMNS)
        .eq("farm_id", selected.sub.farm_id)
        .is("deleted_at", null)
        .order("paid_at", { ascending: false })
        .limit(12),
    ]);
    invoices = (i as InvoiceRow[] | null) ?? [];
    attempts = (a as AttemptRow[] | null) ?? [];
    payments = (p as PaymentRow[] | null) ?? [];
  }

  const payable = payableInvoice(invoices);
  const offer = retryOffer(payable, attempts);
  const needsReconcile = reconcileQueue(attempts);

  const provider = billingProvider();
  const configured = billingConfigured();
  const charging = chargingEnabled();
  const keyMode = paystackKeyMode();
  const farmName = selected?.farm?.name ?? "—";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">
            {t("adminBilling.title", locale)}
          </h1>
          <p className="text-sm text-sand-600">{t("adminBilling.lead", locale)}</p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="adminBilling" locale={locale} />
        </span>
      </div>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("ui.savedChanges", locale) : undefined} />

      {/* ── The safety switch, in words ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("adminBilling.switchTitle", locale)}</CardTitle>
        </CardHeader>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <dt className="text-sand-600">{t("adminBilling.switchProvider", locale)}</dt>
          <dd className="font-medium text-sand-900 sm:text-right">
            {provider === "paystack"
              ? configured
                ? t("adminBilling.switchProviderPaystack", locale)
                : t("adminBilling.switchProviderConfigured", locale)
              : t("adminBilling.switchProviderNone", locale)}
          </dd>

          <dt className="text-sand-600">{t("adminBilling.switchCharging", locale)}</dt>
          <dd className="sm:text-right">
            <StatusBadge
              label={
                charging
                  ? t("adminBilling.switchChargingOn", locale)
                  : t("adminBilling.switchChargingOff", locale)
              }
              tone={charging ? "warning" : "neutral"}
              shape={charging ? "triangle" : "dash"}
              size="md"
            />
          </dd>

          <dt className="text-sand-600">{t("adminBilling.switchKey", locale)}</dt>
          <dd className="font-medium text-sand-900 sm:text-right">
            {keyMode === "live"
              ? t("adminBilling.switchKeyLive", locale)
              : keyMode === "test"
                ? t("adminBilling.switchKeyTest", locale)
                : keyMode === "unknown"
                  ? t("adminBilling.switchKeyUnknown", locale)
                  : t("adminBilling.switchKeyNone", locale)}
          </dd>
        </dl>
        <p className="mt-3 text-sm text-sand-600">{t("adminBilling.switchNote", locale)}</p>
      </Card>

      {/* ── The price list. Empty on purpose, and it says so. ───────────────── */}
      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardTitle>{t("adminBilling.priceTitle", locale)}</CardTitle>
        </div>
        {!priced ? (
          <div className="p-4 sm:p-5">
            <div className="rounded-lg border border-callout-info-edge bg-callout-info-bg px-3.5 py-3">
              <p className="text-base font-semibold text-sand-900">
                {t("adminBilling.priceNoneTitle", locale)}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-sand-800">
                {t("adminBilling.priceNoneBody", locale)}
              </p>
            </div>
          </div>
        ) : null}
        {prices.length > 0 ? (
          <div className="mt-3">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("adminBilling.colVersion", locale)}</Th>
                  <Th>{t("adminBilling.colPlan", locale)}</Th>
                  <Th>{t("adminBilling.colPeriod", locale)}</Th>
                  <Th className="text-right">{t("adminBilling.colPerVehicle", locale)}</Th>
                  <Th className="text-right">{t("adminBilling.colMonths", locale)}</Th>
                  <Th>{t("adminBilling.colPriceStatus", locale)}</Th>
                  <Th>{t("adminBilling.colWindow", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {prices.map((p) => (
                  <Tr key={p.id}>
                    <Td className="font-medium text-sand-900">{p.version_label}</Td>
                    <Td className="text-sand-600">{t(`plan.${p.plan}`, locale)}</Td>
                    <Td className="text-sand-600">{t(`billingPeriod.${p.billing_period}`, locale)}</Td>
                    <Td className="text-right tabular-nums">
                      {p.per_vehicle_monthly_incl_cents == null
                        ? t("adminBilling.priceOnApplication", locale)
                        : rands(p.per_vehicle_monthly_incl_cents)}
                    </Td>
                    <Td className="text-right tabular-nums">{p.months_charged}</Td>
                    <Td>
                      <Badge tone={p.status === "active" ? "ok" : "neutral"}>
                        {enumLabel("billingInvoiceStatus", p.status, locale) === p.status
                          ? p.status
                          : p.status}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-sand-600">
                      {p.effective_from ? shortDate(p.effective_from, locale) : "—"}
                      {p.effective_to ? ` – ${shortDate(p.effective_to, locale)}` : ""}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <p className="px-4 py-3 text-xs text-sand-500 sm:px-5">
              {t("adminBilling.priceInclusive", locale)}{" "}
              {settings?.vat_registered ? null : t("adminBilling.noVatNote", locale)}
            </p>
          </div>
        ) : null}
      </Card>

      {/* ── Headline counts ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("adminBilling.statAll", locale)} value={totals.all} />
        <Stat
          label={t("adminBilling.statFailing", locale)}
          value={totals.failing}
          tone={totals.failing > 0 ? "due" : "default"}
        />
        <Stat
          label={t("adminBilling.statDowngraded", locale)}
          value={totals.downgraded}
          tone={totals.downgraded > 0 ? "overdue" : "default"}
        />
        <Stat label={t("adminBilling.statTrialing", locale)} value={totals.trialing} />
      </div>

      {/* ── Every farm, worst first ─────────────────────────────────────────── */}
      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardTitle>{t("adminBilling.listTitle", locale)}</CardTitle>
        </div>
        {rows.length === 0 ? (
          <div className="p-4 sm:p-5">
            <GetStarted
              icon={<AdminIcon />}
              title={t("adminBilling.listEmptyTitle", locale)}
              hint={t("adminBilling.listEmptyBody", locale)}
            />
          </div>
        ) : (
          <div className="mt-3">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("adminBilling.colFarm", locale)}</Th>
                  <Th>{t("adminBilling.colCommercial", locale)}</Th>
                  <Th>{t("adminBilling.colEffective", locale)}</Th>
                  <Th>{t("adminBilling.colPeriod", locale)}</Th>
                  <Th>{t("adminBilling.colStatus", locale)}</Th>
                  <Th className="text-right">{t("adminBilling.colVehicles", locale)}</Th>
                  <Th>{t("adminBilling.colNext", locale)}</Th>
                  <Th className="text-right">{t("adminBilling.colFailures", locale)}</Th>
                  <Th>{t("adminBilling.colLastFailure", locale)}</Th>
                  <Th>{t("adminBilling.colAction", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((r) => {
                  const look = billingLook(SUBSCRIPTION_LOOK, r.sub.status);
                  return (
                    <Tr key={r.sub.id}>
                      <Td className="font-medium text-sand-900">{r.farm?.name ?? "—"}</Td>
                      <Td className="text-sand-600">{t(`plan.${r.sub.plan}`, locale)}</Td>
                      <Td>
                        {r.diverged ? (
                          <>
                            <span className="block font-medium text-status-overdue">
                              {t(`plan.${r.effectivePlan}`, locale)}
                            </span>
                            <span className="block text-xs text-sand-500">
                              {t("adminBilling.divergedNote", locale)}
                            </span>
                          </>
                        ) : (
                          <span className="text-sand-500">{t("adminBilling.sameAsBought", locale)}</span>
                        )}
                      </Td>
                      <Td className="text-sand-600">
                        {t(`billingPeriod.${r.sub.billing_period}`, locale)}
                      </Td>
                      <Td>
                        <StatusBadge
                          label={enumLabel("billingSubStatus", r.sub.status, locale)}
                          tone={look.tone}
                          shape={look.shape}
                        />
                      </Td>
                      <Td className="text-right tabular-nums">{r.farm?.asset_count ?? 0}</Td>
                      <Td className="whitespace-nowrap text-sand-600">
                        {r.sub.next_billing_on ? shortDate(r.sub.next_billing_on, locale) : "—"}
                      </Td>
                      <Td
                        className={`text-right tabular-nums ${
                          r.sub.failed_attempt_count > 0 ? "text-status-overdue" : "text-sand-600"
                        }`}
                      >
                        {r.sub.failed_attempt_count}
                      </Td>
                      <Td className="text-sand-600">
                        {r.sub.last_failure_at ? (
                          <>
                            <span className="block whitespace-nowrap">
                              {shortDate(r.sub.last_failure_at, locale)}
                            </span>
                            {r.sub.last_failure_code ? (
                              <span className="block text-xs text-sand-500">
                                {r.sub.last_failure_code}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        <Link
                          href={`/admin/billing?farm=${r.sub.farm_id}`}
                          className={buttonVariants({ variant: "secondary", size: "sm" })}
                        >
                          {t("adminBilling.open", locale)}
                        </Link>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* ── One farm in detail ──────────────────────────────────────────────── */}
      {!selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("adminBilling.chooseFarmTitle", locale)}</CardTitle>
          </CardHeader>
          <p className="text-sm text-sand-600">{t("adminBilling.chooseFarmBody", locale)}</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight text-sand-900">
                {t("adminBilling.detailTitle", locale).replace("{farm}", farmName)}
              </h2>
              <p className="text-sm text-sand-600">{t("adminBilling.detailLead", locale)}</p>
            </div>
            <Link
              href="/admin/billing"
              className={`ml-auto ${buttonVariants({ variant: "secondary", size: "sm" })}`}
            >
              {t("adminBilling.backToList", locale)}
            </Link>
          </div>

          {/* An unresolved attempt blocks its bill entirely. Said first, because the
              correct next action is to look that reference up, not to charge again. */}
          {offer.kind === "blocked" ? (
            <Card className="border-callout-warn-edge bg-callout-warn-bg">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0 text-xl text-callout-warn-ink" aria-hidden>
                  <WarningIcon />
                </span>
                <div className="min-w-0">
                  <p className="text-base font-semibold text-sand-900">
                    {t("adminBilling.blockedTitle", locale)}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-sand-800">
                    {t("adminBilling.blockedBody", locale)}
                  </p>
                </div>
              </div>
            </Card>
          ) : null}

          {/* ── Change what they are billed for ─────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>{t("adminBilling.changeTitle", locale)}</CardTitle>
            </CardHeader>
            <p className="text-sm text-sand-600">{t("adminBilling.changeLead", locale)}</p>
            <form action={adminSetPlan} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="farmId" value={selected.sub.farm_id} />
              <input type="hidden" name="subscriptionId" value={selected.sub.id} />
              <Field
                label={t("adminBilling.changePlanField", locale)}
                htmlFor="billing-plan"
                className="flex-1"
              >
                <Select id="billing-plan" name="plan" defaultValue={selected.sub.plan}>
                  {PLANS.map((p) => (
                    <option key={p} value={p}>
                      {t(`plan.${p}`, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("adminBilling.changePeriodField", locale)}
                htmlFor="billing-period"
                className="flex-1"
              >
                <Select
                  id="billing-period"
                  name="billingPeriod"
                  defaultValue={selected.sub.billing_period}
                >
                  {BILLING_PERIODS.map((b) => (
                    <option key={b} value={b}>
                      {t(`billingPeriod.${b}`, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton variant="primary">{t("adminBilling.changeSave", locale)}</SubmitButton>
            </form>
            <p className="mt-2 text-xs text-sand-500">{t("adminBilling.changeNote", locale)}</p>
          </Card>

          {/* ── Bills ───────────────────────────────────────────────────────── */}
          <Card flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardTitle>{t("adminBilling.invoicesTitle", locale)}</CardTitle>
            </div>
            {invoices.length === 0 ? (
              <p className="p-4 text-sm text-sand-500 sm:p-5">{t("adminBilling.noInvoices", locale)}</p>
            ) : (
              <div className="mt-3">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>{t("adminBilling.colRef", locale)}</Th>
                      <Th>{t("adminBilling.colIssued", locale)}</Th>
                      <Th className="text-right">{t("adminBilling.colTotal", locale)}</Th>
                      <Th className="text-right">{t("adminBilling.colPaidAmount", locale)}</Th>
                      <Th>{t("adminBilling.colStatus", locale)}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {invoices.map((inv) => {
                      const look = billingLook(INVOICE_LOOK, inv.status);
                      return (
                        <Tr key={inv.id}>
                          <Td className="font-medium text-sand-900">{inv.invoice_ref}</Td>
                          <Td className="whitespace-nowrap text-sand-600">
                            {inv.issued_on ? shortDate(inv.issued_on, locale) : "—"}
                          </Td>
                          <Td className="text-right tabular-nums">{rands(inv.total_incl_cents)}</Td>
                          <Td className="text-right tabular-nums">{rands(inv.amount_paid_cents)}</Td>
                          <Td>
                            <StatusBadge
                              label={enumLabel("billingInvoiceStatus", inv.status, locale)}
                              tone={look.tone}
                              shape={look.shape}
                            />
                          </Td>
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>
              </div>
            )}

            {offer.kind === "offer" ? (
              <div className="p-4 sm:p-5">
                <ConfirmDialog
                  action={adminRetryCharge}
                  tone="danger"
                  triggerVariant="danger"
                  triggerLabel={t("adminBilling.retryTrigger", locale)}
                  triggerIcon={<CheckIcon />}
                  title={t("adminBilling.retryDialogTitle", locale).replace(
                    "{amount}",
                    rands(offer.amountCents),
                  )}
                  intro={t("adminBilling.retryIntro", locale)
                    .replace("{amount}", rands(offer.amountCents))
                    .replace("{farm}", farmName)
                    .replace("{ref}", offer.invoice.invoice_ref)}
                  facts={[
                    { label: t("adminBilling.retryFactFarm", locale), value: farmName },
                    {
                      label: t("adminBilling.retryFactBill", locale),
                      value: offer.invoice.invoice_ref,
                    },
                    {
                      label: t("adminBilling.retryFactAmount", locale),
                      value: rands(offer.amountCents),
                    },
                  ]}
                  consequences={[
                    t("adminBilling.retryEffect1", locale),
                    t("adminBilling.retryEffect2", locale),
                  ]}
                  footnote={t("adminBilling.retryFootnote", locale)}
                  confirmLabel={t("adminBilling.retryYes", locale)}
                  cancelLabel={t("adminBilling.retryNo", locale)}
                  closeLabel={t("ui.close", locale)}
                >
                  <input type="hidden" name="farmId" value={selected.sub.farm_id} />
                  <input type="hidden" name="invoiceId" value={offer.invoice.id} />
                </ConfirmDialog>
              </div>
            ) : null}
          </Card>

          {/* ── Attempts ────────────────────────────────────────────────────── */}
          <Card flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardTitle>{t("adminBilling.attemptsTitle", locale)}</CardTitle>
            </div>
            {attempts.length === 0 ? (
              <p className="p-4 text-sm text-sand-500 sm:p-5">{t("adminBilling.noAttempts", locale)}</p>
            ) : (
              <div className="mt-3">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>{t("adminBilling.colWhen", locale)}</Th>
                      <Th>{t("adminBilling.colKind", locale)}</Th>
                      <Th className="text-right">{t("adminBilling.colAmount", locale)}</Th>
                      <Th>{t("adminBilling.colOutcome", locale)}</Th>
                      <Th>{t("adminBilling.colReference", locale)}</Th>
                      <Th>{t("adminBilling.colResponse", locale)}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {attempts.map((a) => {
                      const look = billingLook(ATTEMPT_LOOK, a.status);
                      return (
                        <Tr key={a.id}>
                          <Td className="whitespace-nowrap text-sand-600">
                            {dateTime(a.requested_at, locale)}
                          </Td>
                          <Td className="text-sand-600">
                            {enumLabel("billingAttemptKind", a.kind, locale)}
                          </Td>
                          <Td className="text-right tabular-nums">{rands(a.amount_incl_cents)}</Td>
                          <Td>
                            <StatusBadge
                              label={enumLabel("billingAttemptStatus", a.status, locale)}
                              tone={look.tone}
                              shape={look.shape}
                            />
                          </Td>
                          <Td className="text-sand-600">{a.attempt_ref}</Td>
                          <Td className="text-sand-600">
                            {a.gateway_response ?? a.failure_reason ?? "—"}
                          </Td>
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>
              </div>
            )}

            {needsReconcile.length > 0 ? (
              <div className="flex flex-col gap-2 p-4 sm:p-5">
                {needsReconcile.map((a) => (
                  <ConfirmDialog
                    key={a.id}
                    action={adminReconcileAttempt}
                    tone="brand"
                    triggerVariant="secondary"
                    triggerLabel={`${t("adminBilling.reconcileTrigger", locale)} · ${a.attempt_ref}`}
                    triggerIcon={<SearchIcon />}
                    title={t("adminBilling.reconcileDialogTitle", locale).replace(
                      "{ref}",
                      a.attempt_ref,
                    )}
                    intro={t("adminBilling.reconcileIntro", locale)}
                    facts={[
                      { label: t("adminBilling.reconcileFactRef", locale), value: a.attempt_ref },
                      {
                        label: t("adminBilling.reconcileFactAmount", locale),
                        value: rands(a.amount_incl_cents),
                      },
                      {
                        label: t("adminBilling.reconcileFactWhen", locale),
                        value: dateTime(a.requested_at, locale),
                      },
                    ]}
                    consequences={[
                      t("adminBilling.reconcileEffect1", locale),
                      t("adminBilling.reconcileEffect2", locale),
                    ]}
                    confirmLabel={t("adminBilling.reconcileYes", locale)}
                    cancelLabel={t("adminBilling.retryNo", locale)}
                    closeLabel={t("ui.close", locale)}
                  >
                    <input type="hidden" name="farmId" value={selected.sub.farm_id} />
                    <input type="hidden" name="attemptId" value={a.id} />
                  </ConfirmDialog>
                ))}
              </div>
            ) : null}
          </Card>

          {/* ── Money received ──────────────────────────────────────────────── */}
          <Card flush>
            <div className="p-4 pb-0 sm:p-5 sm:pb-0">
              <CardTitle>{t("adminBilling.paymentsTitle", locale)}</CardTitle>
            </div>
            {payments.length === 0 ? (
              <p className="p-4 text-sm text-sand-500 sm:p-5">{t("adminBilling.noPayments", locale)}</p>
            ) : (
              <div className="mt-3">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>{t("adminBilling.colWhen", locale)}</Th>
                      <Th className="text-right">{t("adminBilling.colAmount", locale)}</Th>
                      <Th>{t("adminBilling.colChannel", locale)}</Th>
                      <Th>{t("adminBilling.colReference", locale)}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {payments.map((p) => (
                      <Tr key={p.id}>
                        <Td className="whitespace-nowrap text-sand-600">
                          {dateTime(p.paid_at, locale)}
                        </Td>
                        <Td className="text-right tabular-nums">{rands(p.amount_incl_cents)}</Td>
                        <Td className="text-sand-600">{p.channel ?? "—"}</Td>
                        <Td className="text-sand-600">{p.provider_reference ?? "—"}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            )}
            <p className="flex items-start gap-2 px-4 py-3 text-xs text-sand-500 sm:px-5">
              <span className="mt-0.5 shrink-0 text-sm" aria-hidden>
                <LockIcon />
              </span>
              <span>{t("adminBilling.credentialNote", locale)}</span>
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
