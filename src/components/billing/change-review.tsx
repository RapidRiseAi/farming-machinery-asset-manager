import Link from "next/link";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, FactList } from "@/components/ui/facts";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { buttonVariants } from "@/components/ui/button";
import { lostFeatures } from "@/lib/billing/calculator";
import { quoteOpen, quotePayNow, type QuoteRow } from "@/lib/billing/view";
import { isPlan } from "@/lib/entitlements";
import { shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";

type Action = (formData: FormData) => Promise<void>;

/** "5 full spaces, 1 extra equipment space", or the plan and term. */
function sideLabel(q: QuoteRow, side: "from" | "to", locale: Lang): string {
  if (q.change === "plan") {
    const plan = side === "from" ? q.from_plan : q.to_plan;
    const period = side === "from" ? q.from_period : q.to_period;
    return `${t(`plan.${plan}`, locale)} · ${t(`billingPeriod.${period}`, locale)}`;
  }
  const full = side === "from" ? q.from_full : q.to_full;
  const extra = side === "from" ? q.from_equipment_extra : q.to_equipment_extra;
  return t("billing.changeSpaces", locale)
    .replace("{full}", String(full ?? q.full_in_use))
    .replace("{extra}", String(extra));
}

/**
 * The priced change, before the owner says yes: what it is now and after, today's charge
 * after any credit, the credit an upgrade gives back, when it starts, the next renewal total,
 * the features a lower plan gives up and that the records made with them stay readable, and
 * how long the price holds. Every figure is the one the engine stored on the quote; the
 * accept form sends them back, so a price that moved is refused rather than charged.
 */
export function ChangeReview({
  quote,
  locale,
  accept,
}: {
  quote: QuoteRow;
  locale: Lang;
  accept: Action;
}) {
  const open = quoteOpen(quote);
  const payNow = quotePayNow(quote);
  const fromCredit = Math.max(quote.charge_now_cents - payNow, 0);
  const lost =
    quote.change === "plan" && isPlan(quote.from_plan) && isPlan(quote.to_plan)
      ? lostFeatures(quote.from_plan, quote.to_plan)
      : [];
  const atRenewal = quote.mode === "renewal";

  return (
    <Card className="border-callout-info-edge bg-callout-info-bg">
      <CardHeader>
        <CardTitle>{t("billing.quoteHeading", locale)}</CardTitle>
      </CardHeader>
      <FactList>
        <Fact label={t("billing.changeNowLabel", locale)} value={sideLabel(quote, "from", locale)} />
        <Fact label={t("billing.changeAfterLabel", locale)} value={sideLabel(quote, "to", locale)} />
        <Fact
          label={t("billing.quoteNowLine", locale)}
          value={payNow > 0 ? rands(payNow) : t("billing.quoteNoCharge", locale)}
        />
        {fromCredit > 0 ? (
          <Fact label={t("billing.changeFromCredit", locale)} value={rands(fromCredit)} />
        ) : null}
        {quote.credit_now_cents > 0 ? (
          <Fact label={t("billing.changeCreditLine", locale)} value={rands(quote.credit_now_cents)} />
        ) : null}
        <Fact
          label={t("billing.changeStarts", locale)}
          value={atRenewal ? shortDate(quote.effective_on, locale) : t("billing.changeStartsNow", locale)}
        />
        {!atRenewal && quote.days_in_period > 0 ? (
          <Fact
            label={t("billing.changeDaysLeft", locale)}
            value={t("billing.changeDaysOf", locale)
              .replace("{n}", String(quote.days_remaining))
              .replace("{of}", String(quote.days_in_period))}
          />
        ) : null}
        {quote.current_renewal_cents != null || quote.next_renewal_cents != null ? (
          <Fact
            label={t("billing.changeRenewal", locale)}
            value={t("billing.changeBeforeAfter", locale)
              .replace("{before}", quote.current_renewal_cents != null ? rands(quote.current_renewal_cents) : "-")
              .replace("{after}", quote.next_renewal_cents != null ? rands(quote.next_renewal_cents) : "-")}
          />
        ) : null}
      </FactList>

      {quote.change === "capacity" && quote.to_equipment_extra > quote.from_equipment_extra ? (
        <p className="mt-3 text-sm leading-relaxed text-sand-800">{t("billing.changeEquipmentRenewalNote", locale)}</p>
      ) : null}
      {lost.length > 0 ? (
        <div className="mt-3 text-sm leading-relaxed text-sand-800">
          <p className="font-semibold text-sand-900">{t("billing.changeLostTitle", locale)}</p>
          <ul className="mt-1 list-disc pl-5">
            {lost.map((f) => (
              <li key={f}>{t(`signup.feat.${f}`, locale)}</li>
            ))}
          </ul>
          <p className="mt-1">{t("billing.changeLostKept", locale)}</p>
        </div>
      ) : null}
      <p className="mt-3 text-sm leading-relaxed text-sand-800">
        {t(atRenewal ? "billing.changeAtRenewalNote" : payNow > 0 ? "billing.changePaidFirstNote" : "billing.changeNowNote", locale)}
      </p>

      {open ? (
        <>
          <p className="mt-2 text-xs text-sand-600">{t("billing.changeExpiresNote", locale)}</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <form action={accept}>
              <RequestIdInput action="billing:accept-change" />
              <input type="hidden" name="quote_id" value={quote.id} />
              <input type="hidden" name="charge_cents" value={String(quote.charge_now_cents)} />
              <input type="hidden" name="credit_cents" value={String(quote.credit_now_cents)} />
              <input type="hidden" name="next_renewal_cents" value={quote.next_renewal_cents == null ? "" : String(quote.next_renewal_cents)} />
              <SubmitButton variant="primary">
                {t(payNow > 0 ? "billing.changeAcceptPay" : "billing.quoteConfirm", locale)}
              </SubmitButton>
            </form>
            <Link href="/billing" className={buttonVariants({ variant: "secondary" })}>
              {t("billing.quoteCancel", locale)}
            </Link>
          </div>
        </>
      ) : (
        <div className="mt-3">
          <p className="text-sm font-semibold text-sand-900">{t("billing.changeExpired", locale)}</p>
          <Link href="/billing?manage=1" className={`mt-3 ${buttonVariants({ variant: "secondary" })}`}>
            {t("billing.quoteAdjust", locale)}
          </Link>
        </div>
      )}
    </Card>
  );
}

/**
 * Changes accepted and not yet made: one waiting for its payment (pay or cancel it), and
 * changes scheduled for the renewal (cancel; asking for another replaces it).
 */
export function PendingChanges({
  quotes,
  locale,
  pay,
  cancel,
}: {
  quotes: QuoteRow[];
  locale: Lang;
  pay: Action;
  cancel: Action;
}) {
  const waiting = quotes.filter((q) => q.status === "awaiting_payment" || q.status === "scheduled");
  if (waiting.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("billing.pendingChangesTitle", locale)}</CardTitle>
      </CardHeader>
      <ul className="flex flex-col divide-y divide-sand-200">
        {waiting.map((q) => (
          <li key={q.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <p className="text-sm text-sand-900">
              <span className="font-semibold">{sideLabel(q, "to", locale)}</span>
              <span className="text-sand-600"> ({sideLabel(q, "from", locale)})</span>
            </p>
            <p className="text-sm text-sand-700">
              {q.status === "awaiting_payment"
                ? t("billing.pendingAwaiting", locale).replace("{amount}", rands(quotePayNow(q)))
                : t("billing.pendingScheduled", locale)
                    .replace("{date}", shortDate(q.effective_on, locale))
                    .replace("{amount}", q.next_renewal_cents != null ? rands(q.next_renewal_cents) : "-")}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {q.status === "awaiting_payment" && q.invoice_id ? (
                <form action={pay}>
                  <RequestIdInput action="billing:pay-change" />
                  <input type="hidden" name="invoice_id" value={q.invoice_id} />
                  <SubmitButton variant="primary">{t("billing.pendingPay", locale)}</SubmitButton>
                </form>
              ) : null}
              <form action={cancel}>
                <input type="hidden" name="quote_id" value={q.id} />
                <SubmitButton variant="secondary">{t("billing.pendingCancel", locale)}</SubmitButton>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
