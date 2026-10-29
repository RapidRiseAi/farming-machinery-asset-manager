import { redirect } from "next/navigation";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { must } from "@/lib/supabase/must";
import { farmBillingGate, openInvoiceForFarm } from "@/lib/billing/service";
import { settlingOnInvoice } from "@/lib/billing/stopped-farm";
import { SettlingNotice } from "@/components/billing/settling-notice";
import { signOut } from "@/app/(app)/actions";
import { Flash } from "@/components/ui/flash";
import { errorMessage } from "@/lib/errors";
import { MachinesIcon } from "@/components/ui/icons";
import { beginCheckoutAction } from "./actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { isUuid } from "@/lib/ids";
import { SwitchFarm } from "@/components/billing/switch-farm";

/**
 * The screen a farm sees between signing up and paying.
 *
 * It lives in `(auth)` rather than `(app)` on purpose: `(app)/layout.tsx` is where the
 * billing gate runs, so a page inside it would bounce to itself for ever. The trade is
 * that this page carries no app shell, which is correct anyway, because there is nothing
 * here to navigate to yet.
 *
 * It is also the page somebody lands on if they abandon checkout and come back a week
 * later, so it has to work as a resumption and not only as a step in a wizard: the
 * subscription and its invoice already exist by the time anybody gets here (see
 * docs/SIGNUP_AND_QUOTA_BILLING.md §2, the account is created BEFORE the money moves,
 * because a payment with no farm to attach it to is a refund and an apology).
 */
export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; farm?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;

  // A contractor or a Rapid Rise admin has no farm subscription to activate, and an
  // operator cannot pay for one. Send everybody who does not belong here home rather than
  // showing them a payment screen about somebody else's account.
  // The farm being activated: the one the layout said (?farm=) or the home farm.
  const farmId = isUuid(sp.farm) ? sp.farm : profile.farm_id;
  if (!farmId) redirect("/home");

  const supabase = await createClient();
  const gate = await farmBillingGate(supabase, farmId);

  // Already paid, or grandfathered, or a farm that never had a subscription. Whatever the
  // reason, there is nothing to activate and the app is theirs.
  if (gate !== "pending") redirect("/home");

  // Who may pay, decided as `beginCheckoutAction` decides it: owner or manager on THIS farm.
  // Everybody else is told to ask one of them, rather than offered a button whose only
  // answer is "you do not have permission".
  const role = await effectiveFarmRole(farmId, profile);
  const canPay = role === "owner" || role === "manager";

  // Somebody who may pay reads the plan and the invoice through the SERVICE client. RLS on
  // the billing tables is app.is_farm_billing_admin, owner and Rapid Rise only, so a
  // manager, whom the action lets pay, read no plan, no vehicles and no amount, and was
  // shown a bare "Pay" (review finding app-9). Anybody else reads through their own session
  // and sees what RLS lets them see, which for an operator is nothing.
  const svc = canPay ? createServiceClient() : null;
  const reader = svc ?? supabase;

  const data = must(
    await reader
      .from("billing_subscriptions")
      .select("plan, billing_period, asset_quota")
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .maybeSingle(),
    "activate:subscription",
  );
  const sub = data as
    | { plan: string; billing_period: string; asset_quota: number | null }
    | null;

  // The invoice the Pay button will charge, chosen exactly as the checkout chooses it
  // (openInvoiceForFarm: not a once-off service invoice, not a refunded one). Reading "the
  // latest open invoice" showed an onboarding fee's amount over a checkout that charged the
  // plan.
  const invoice = await openInvoiceForFarm(reader, farmId);
  // What the checkout will charge: what is still owed on it, not its total. A sign-up that
  // paid in two transfers, one of which bounced, owes half (beginCheckout charges total
  // less paid).
  const owedCents = invoice ? Math.max(0, invoice.total_incl_cents - invoice.amount_paid_cents) : 0;

  // Has this person ALREADY paid, seconds ago? The callback's redirect to /billing bounces
  // back here until the webhook settles, so the answer is read from the ledger
  // (settlingOnInvoice says why). Only attempts on THIS invoice count: a reopened farm that
  // once paid by card was told "payment received" over its new bill and never shown a Pay
  // button again (review finding app-1). Read only for somebody who may pay, as nobody
  // else is shown the button it replaces.
  const settling = svc
    ? await settlingOnInvoice(svc, farmId, invoice?.id ?? null, "activate:payment-attempt")
    : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface p-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("activate.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t("activate.lead", locale)}</p>

        {sub ? (
          <dl className="mt-5 space-y-2 border-t border-sand-300 pt-5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-sand-700">{t("activate.plan", locale)}</dt>
              <dd className="font-medium">{t(`plan.${sub.plan}`, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-sand-700">{t("activate.vehicles", locale)}</dt>
              <dd className="font-medium">{sub.asset_quota ?? "-"}</dd>
            </div>
            {invoice ? (
              <div className="flex justify-between gap-4">
                <dt className="text-sand-700">{t("activate.amount", locale)}</dt>
                <dd className="font-semibold">{rands(owedCents)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {/* `t("errors." + code)` printed the literal `errors.billing-unavailable` at a
            customer: `t()` returns the key on a miss and the catalogue spells it
            `errors.billingUnavailable`. `errorMessage()` is the shared resolver that
            exists so a code never reaches a screen. */}
        {sp.error ? (
          <div className="mt-4">
            <Flash tone="error" message={errorMessage(sp.error, locale)} />
          </div>
        ) : null}

        {!canPay ? (
          <p className="mt-6 text-sm text-sand-700">{t("activate.askOwner", locale)}</p>
        ) : settling ? (
          // No Pay button while money is already moving on this invoice (SettlingNotice).
          <SettlingNotice
            settling={settling}
            refreshHref={farmId !== profile.farm_id ? `/activate?farm=${farmId}` : "/activate"}
            locale={locale}
          />
        ) : (
          <>
            <form action={beginCheckoutAction} className="mt-6">
              {farmId !== profile.farm_id ? <input type="hidden" name="farm" value={farmId} /> : null}
              <SubmitButton className="w-full">
                {invoice
                  ? t("activate.payAmount", locale).replace(
                      "{amount}",
                      rands(owedCents),
                    )
                  : t("activate.pay", locale)}
              </SubmitButton>
            </form>

            <p className="mt-4 text-xs text-sand-700">{t("activate.note", locale)}</p>
          </>
        )}
      </div>

      {/* Every app route bounces here, and until now there was no way off the screen -
          somebody signed in to the wrong account, or on a shared farm-office machine, had
          one button and no exit. Saying WHO they are signed in as is half of it: "this is
          not me" cannot be acted on if the page never says who "me" is. */}
      <SwitchFarm profile={profile} current={farmId} locale={locale} />

      <form action={signOut} className="text-center">
        <p className="text-xs text-sand-600">
          {t("gate.signedInAs", locale).replace("{email}", profile.email ?? "-")}
        </p>
        <SubmitButton look="plain" className="mt-1 min-h-12 text-sm font-medium text-brand-ink underline sm:min-h-11">
          {t("gate.signOut", locale)}
        </SubmitButton>
      </form>
    </main>
  );
}
