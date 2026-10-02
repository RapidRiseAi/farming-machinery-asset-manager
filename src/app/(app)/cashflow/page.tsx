import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop, checkWorkshopEntitlement } from "@/lib/auth";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  horizonDays, parseOpening, cashflowTotals, runsOutAt,
  CASH_HORIZONS, SUPPLIER_TERMS_DAYS, EMPTY_BUCKETS,
  type CashflowBucket, type CashflowMovement,
} from "@/lib/cashflow";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogForm, DialogFields, DialogActions } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { PeriodChips } from "@/components/books/period-chips";
import { RememberView } from "@/components/books/remember-view";
import { ForecastTable } from "@/components/cashflow/forecast-table";
import { MovementList } from "@/components/cashflow/movement-list";

export const dynamic = "force-dynamic";

/**
 * What is about to happen to the bank account (0486).
 *
 * `/money` next door answers three questions that all look backwards. This one looks
 * forwards, which is the question a small workshop actually loses sleep over: a partner
 * can be profitable on the P&L, owed R80 000, and still unable to settle a R12 000
 * supplier account on Friday, because profit is an opinion about a period and cash is a
 * fact about a date.
 *
 * Ordered by what gets acted on. The verdict first (is there a week where this goes
 * under), then the table that shows which week, then the individual movements, because
 * the reader's next action is almost always about ONE of them: phone the farmer who is
 * forty days late, or ring the supplier and ask for another two weeks.
 *
 * Every figure is GROSS. The ledger is ex-VAT because that is what a P&L and a VAT return
 * are made of; a bank account is not. When a farmer settles an invoice the bank receives
 * the VAT-inclusive total, and the fact that some of it goes to SARS in six weeks does not
 * help on Friday. The screen says this once, in words, rather than on every row.
 */
export default async function CashflowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/dashboard");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  // Running the books here is the `books` product (0492). Denied BEFORE any query runs,
  // so a partner without it never causes the data to be read, let alone rendered.
  const gate = await checkWorkshopEntitlement("financials", profile);
  if (!gate.allowed) {
    return (
      <PageContainer size="narrow">
        <UpgradeNotice
          feature="financials"
          requiredPlan={gate.requiredPlan}
          currentPlan={gate.plan}
          locale={locale}
        />
      </PageContainer>
    );
  }

  const horizon = horizonDays(sp.days);
  // Typed by the reader and never stored: `bank_statement_lines` (0470) is an import
  // queue, not an authoritative balance, and a forecast that invented one would be
  // believed. Blank is a perfectly good answer, the forecast still reads as a change.
  const openingRaw = sp.open;
  const opening = parseOpening(openingRaw);
  const openingRejected = openingRaw != null && openingRaw.trim() !== "" && opening == null;

  const supabase = await createClient();
  const [{ data: bucketData }, { data: itemData }] = await Promise.all([
    supabase.rpc("partner_cashflow", { p_workshop: workshop.id, p_horizon_days: horizon }),
    supabase.rpc("partner_cashflow_items", { p_workshop: workshop.id, p_horizon_days: horizon }),
  ]);

  const buckets = ((bucketData ?? []) as CashflowBucket[]);
  const rows = buckets.length > 0 ? buckets : EMPTY_BUCKETS;
  const items = (itemData ?? []) as CashflowMovement[];

  const totals = cashflowTotals(rows);
  const runsOut = runsOutAt(rows, opening);
  const closing = (opening ?? 0) + (rows[rows.length - 1]?.running_cents ?? 0);

  // The window and the bank balance are remembered on this device, the balance because it
  // is typed every Monday by the same person. A visit that names neither reopens the last
  // view; one that names either is the new view to keep (an emptied balance is dropped
  // from what is kept, which is how it is forgotten).
  const urlChose = sp.days != null || sp.open != null;
  const keep = new URLSearchParams();
  if (sp.days) keep.set("days", String(horizon));
  if (opening != null && openingRaw) keep.set("open", openingRaw.trim());
  const openParam = opening != null && openingRaw ? `&open=${encodeURIComponent(openingRaw.trim())}` : "";

  return (
    <PageContainer>
      <PageHeader title={t("cash.title", locale)} lead={t("cash.lead", locale)} />
      <RememberView storageKey="cashflow-view" value={urlChose ? keep.toString() : null} restore="/cashflow" />

      {/* What you are looking at: the window as chips (links, so it is a shareable URL and
          works before any JavaScript), and the bank balance stated as a fact. Typing the
          balance is a capture, so it lives behind its own button. */}
      <section aria-label={t("cash.windowTitle", locale)} className="flex flex-col gap-3">
        <PeriodChips
          label={t("cash.horizonLabel", locale)}
          items={CASH_HORIZONS.map((d) => ({
            key: String(d),
            href: `/cashflow?days=${d}${openParam}`,
            label: t(`cash.horizon.${d}`, locale),
            active: d === horizon,
          }))}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 text-sm text-sand-600">
            {t("cash.openingLabel", locale)}:{" "}
            {opening != null ? (
              <span className="font-semibold tabular-nums text-sand-900">{rands(opening)}</span>
            ) : (
              <span className="text-sand-500">{t("cash.openingNone", locale)}</span>
            )}
          </p>
          <DialogForm
            trigger={opening != null ? t("cash.changeOpening", locale) : t("cash.setOpening", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={t("cash.openingLabel", locale)}
            closeLabel={t("ui.close", locale)}
            defaultOpen={openingRejected}
          >
            <form method="get" action="/cashflow">
              <input type="hidden" name="days" value={String(horizon)} />
              <DialogFields>
                <TextField
                  label={t("cash.openingLabel", locale)}
                  name="open"
                  inputMode="decimal"
                  defaultValue={openingRaw ?? ""}
                  hint={t("cash.openingHint", locale)}
                  error={openingRejected ? t("cash.openingBad", locale) : undefined}
                />
              </DialogFields>
              <DialogActions cancelLabel={t("common.cancel", locale)}>
                <SubmitButton>{t("cash.apply", locale)}</SubmitButton>
              </DialogActions>
            </form>
          </DialogForm>
        </div>
        <p className="text-sm text-sand-500">{t("cash.grossNote", locale)}</p>
      </section>

      {/* The verdict. Stated in a sentence before any table, because the reader came here
          for one answer and should not have to derive it from five rows. */}
      {runsOut ? (
        <Flash
          tone="error"
          clearParams={false}
          message={t("cash.runsOutWarning", locale)
            .replace("{bucket}", t(`cash.bucket.${runsOut.bucket}`, locale))
            .replace("{amount}", rands((opening ?? 0) + runsOut.running_cents))}
        />
      ) : opening != null ? (
        <Flash
          tone="success"
          clearParams={false}
          message={t("cash.staysPositive", locale).replace("{amount}", rands(closing))}
        />
      ) : (
        <Flash tone="info" clearParams={false} message={t("cash.noOpening", locale)} />
      )}

      <StatGrid columns={3}>
        <Stat size="md" label={t("cash.totalIn", locale)} value={rands(totals.in_cents)} />
        <Stat size="md" label={t("cash.totalOut", locale)} value={rands(totals.out_cents)} />
        <Stat
          size="md"
          label={t("cash.totalNet", locale)}
          value={rands(totals.net_cents)}
          tone={totals.net_cents < 0 ? "overdue" : "ok"}
          delta={t("cash.netHint", locale)}
        />
      </StatGrid>

      <Card>
        <CardHeader><CardTitle>{t("cash.forecastTitle", locale)}</CardTitle></CardHeader>
        <ForecastTable rows={rows} openingCents={opening} locale={locale} />
        <p className="mt-3 text-xs text-sand-500">
          {t("cash.termsNote", locale).replace("{days}", String(SUPPLIER_TERMS_DAYS))}
        </p>
        <p className="mt-1 text-xs text-sand-500">{t("cash.undatedNote", locale)}</p>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("cash.movementsTitle", locale)}</CardTitle></CardHeader>
        {items.length === 0 ? (
          <AllClear title={t("cash.noneTitle", locale)} hint={t("cash.noneBody", locale)} />
        ) : (
          <>
            <p className="mb-3 text-sm text-sand-600">
              {t("cash.movementsLead", locale)
                .replace("{count}", String(items.length))
                .replace("{date}", shortDate(new Date(), locale))}
            </p>
            <MovementList items={items} locale={locale} />
          </>
        )}
      </Card>
    </PageContainer>
  );
}
