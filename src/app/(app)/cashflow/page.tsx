import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
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
import { Stat } from "@/components/ui/stat";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ForecastTable } from "@/components/cashflow/forecast-table";
import { MovementList } from "@/components/cashflow/movement-list";

export const dynamic = "force-dynamic";

/**
 * What is about to happen to the bank account (0486).
 *
 * `/money` next door answers three questions that all look backwards. This one looks
 * forwards, which is the question a small workshop actually loses sleep over: a partner
 * can be profitable on the P&L, owed R80 000, and still unable to settle a R12 000
 * supplier account on Friday — because profit is an opinion about a period and cash is a
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

  const horizon = horizonDays(sp.days);
  // Typed by the reader and never stored: `bank_statement_lines` (0470) is an import
  // queue, not an authoritative balance, and a forecast that invented one would be
  // believed. Blank is a perfectly good answer — the forecast still reads as a change.
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("cash.title", locale)}</h1>
        <p className="text-sm text-sand-600">{t("cash.lead", locale)}</p>
      </div>

      {/* What you are looking at, and over what window. A GET form so the whole thing is
          a shareable URL and works with no JavaScript at all — the same property the
          period links on /money have. */}
      <Card>
        <CardHeader><CardTitle>{t("cash.windowTitle", locale)}</CardTitle></CardHeader>
        <form method="get" action="/cashflow" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <SelectField
            label={t("cash.horizonLabel", locale)}
            name="days"
            defaultValue={String(horizon)}
            fieldClassName="sm:w-56"
          >
            {CASH_HORIZONS.map((d) => (
              <option key={d} value={String(d)}>
                {t(`cash.horizon.${d}`, locale)}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("cash.openingLabel", locale)}
            name="open"
            inputMode="decimal"
            defaultValue={openingRaw ?? ""}
            hint={t("cash.openingHint", locale)}
            error={openingRejected ? t("cash.openingBad", locale) : undefined}
            fieldClassName="sm:w-56"
          />
          <SubmitButton variant="secondary" className="sm:mb-6">
            {t("cash.apply", locale)}
          </SubmitButton>
        </form>
        <p className="mt-3 text-sm text-sand-600">{t("cash.grossNote", locale)}</p>
      </Card>

      {/* The verdict. Stated in a sentence before any table, because the reader came here
          for one answer and should not have to derive it from five rows. */}
      {runsOut ? (
        <Flash
          tone="error"
          message={t("cash.runsOutWarning", locale)
            .replace("{bucket}", t(`cash.bucket.${runsOut.bucket}`, locale))
            .replace("{amount}", rands((opening ?? 0) + runsOut.running_cents))}
        />
      ) : opening != null ? (
        <Flash
          tone="success"
          message={t("cash.staysPositive", locale).replace("{amount}", rands(closing))}
        />
      ) : (
        <Flash tone="info" message={t("cash.noOpening", locale)} />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("cash.totalIn", locale)} value={rands(totals.in_cents)} />
        <Stat label={t("cash.totalOut", locale)} value={rands(totals.out_cents)} />
        <Stat
          label={t("cash.totalNet", locale)}
          value={rands(totals.net_cents)}
          tone={totals.net_cents < 0 ? "overdue" : "ok"}
          delta={t("cash.netHint", locale)}
        />
      </div>

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
    </div>
  );
}
