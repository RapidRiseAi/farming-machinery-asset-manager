import { redirect } from "next/navigation";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { farmBillingGate } from "@/lib/billing/service";
import { Button } from "@/components/ui/button";
import { MachinesIcon } from "@/components/ui/icons";
import { beginCheckoutAction } from "./actions";

/**
 * The screen a farm sees between signing up and paying.
 *
 * It lives in `(auth)` rather than `(app)` on purpose: `(app)/layout.tsx` is where the
 * billing gate runs, so a page inside it would bounce to itself for ever. The trade is
 * that this page carries no app shell — which is correct anyway, because there is nothing
 * here to navigate to yet.
 *
 * It is also the page somebody lands on if they abandon checkout and come back a week
 * later, so it has to work as a resumption and not only as a step in a wizard: the
 * subscription and its invoice already exist by the time anybody gets here (see
 * docs/SIGNUP_AND_QUOTA_BILLING.md §2 — the account is created BEFORE the money moves,
 * because a payment with no farm to attach it to is a refund and an apology).
 */
export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;

  // A contractor or a Rapid Rise admin has no farm subscription to activate, and an
  // operator cannot pay for one. Send everybody who does not belong here home rather than
  // showing them a payment screen about somebody else's account.
  if (!profile.farm_id) redirect("/home");

  const supabase = await createClient();
  const gate = await farmBillingGate(supabase, profile.farm_id);

  // Already paid, or grandfathered, or a farm that never had a subscription. Whatever the
  // reason, there is nothing to activate and the app is theirs.
  if (gate !== "pending") redirect("/home");

  const { data } = await supabase
    .from("billing_subscriptions")
    .select("plan, billing_period, asset_quota")
    .eq("farm_id", profile.farm_id)
    .is("deleted_at", null)
    .maybeSingle();
  const sub = data as
    | { plan: string; billing_period: string; asset_quota: number | null }
    | null;

  const { data: invData } = await supabase
    .from("billing_invoices")
    .select("invoice_ref, total_incl_cents")
    .eq("farm_id", profile.farm_id)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("issued_on", { ascending: false })
    .limit(1)
    .maybeSingle();
  const invoice = invData as { invoice_ref: string; total_incl_cents: number } | null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface-1 p-6">
        <h1 className="text-2xl font-semibold">{t("activate.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t("activate.lead", locale)}</p>

        {sub ? (
          <dl className="mt-5 space-y-2 border-t border-sand-300 pt-5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-sand-700">{t("activate.plan", locale)}</dt>
              <dd className="font-medium">{t(`plan.${sub.plan}`, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-sand-700">{t("activate.vehicles", locale)}</dt>
              <dd className="font-medium">{sub.asset_quota ?? "—"}</dd>
            </div>
            {invoice ? (
              <div className="flex justify-between gap-4">
                <dt className="text-sand-700">{t("activate.amount", locale)}</dt>
                <dd className="font-semibold">{rands(invoice.total_incl_cents)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {sp.error ? (
          <p className="mt-4 rounded-lg bg-status-bad/10 p-3 text-sm text-status-bad">
            {t(`errors.${sp.error}`, locale)}
          </p>
        ) : null}

        <form action={beginCheckoutAction} className="mt-6">
          <Button type="submit" className="w-full">
            {invoice
              ? t("activate.payAmount", locale).replace(
                  "{amount}",
                  rands(invoice.total_incl_cents),
                )
              : t("activate.pay", locale)}
          </Button>
        </form>

        <p className="mt-4 text-xs text-sand-700">{t("activate.note", locale)}</p>
      </div>
    </main>
  );
}
