import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { rands } from "@/lib/money";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { must } from "@/lib/supabase/must";
import { farmBillingGate, openInvoiceForFarm } from "@/lib/billing/service";
import { toIsoDate } from "@/lib/billing/policy";
import {
  accessGraceDays,
  overdueAfterPaying,
  settlingOnInvoice,
  type OpenInvoice,
} from "@/lib/billing/stopped-farm";
import { errorMessage } from "@/lib/errors";
import { COMPANY } from "@/lib/legal";
import { Flash } from "@/components/ui/flash";
import { MachinesIcon } from "@/components/ui/icons";
import { signOut } from "@/app/(app)/actions";
import { payOverdueAction } from "./actions";
import { DownloadLink } from "@/components/ui/download-link";
import { downloadLabels } from "@/lib/interaction-labels";
import { SubmitButton } from "@/components/ui/submit-button";
import { SwitchFarm } from "@/components/billing/switch-farm";
import { SettlingNotice } from "@/components/billing/settling-notice";

/**
 * The screen a farm sees once an invoice is more than seven days overdue (20261029090100).
 *
 * Decided on 26 and 27 October 2026: after the grace, access stops until the farm pays, and
 * its people may only pay and download their records. Nothing is deleted. Like /closed, it
 * lives in (auth) because the (app) layout is where the gate runs: a page inside it would
 * bounce to itself.
 */
export default async function SuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; farm?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const locale = profile.lang;
  const farmId = isUuid(sp.farm) ? sp.farm : profile.farm_id;
  if (!farmId) redirect("/home");

  const supabase = await createClient();
  const gate = await farmBillingGate(supabase, farmId);
  // Paid, extended, or never suspended: nothing to see here.
  if (gate !== "suspended") redirect("/home");

  const role = await effectiveFarmRole(farmId, profile);
  const canPay = role === "owner" || role === "manager";

  // What is owed, read only for somebody who may pay, and then through the SERVICE client.
  // This used to read through the caller's own client on the belief that billing rows are
  // "the owner's and manager's to see"; app.is_farm_billing_admin is owner and Rapid Rise
  // only (20260903160000), so a manager, whom payOverdueAction lets pay, read nothing and
  // was offered Pay now with no amount (review finding app-9). An operator still reads none
  // of it and gets the general sentence instead of the farm's commercial position.
  const bill = canPay ? await payNowFor(createServiceClient(), farmId) : null;
  // Other invoices still keep the farm paused after this payment: say so, and do not
  // promise that everything comes back with this one (review finding app-4).
  const more = bill !== null && bill.stillOverdueCents > 0;
  const here = farmId !== profile.farm_id ? `/suspended?farm=${farmId}` : "/suspended";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface p-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("suspended.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t(more ? "suspended.leadMany" : "suspended.lead", locale)}</p>

        {bill?.paying && bill.payCents > 0 ? (
          <div className="mt-3 rounded-lg border border-sand-200 p-3 text-sm text-ink">
            <p>
              {t("suspended.owedInvoice", locale)
                .replace("{amount}", rands(bill.payCents))
                .replace("{ref}", bill.paying.invoice_ref)
                .replace("{date}", bill.payDue ? shortDate(bill.payDue, locale) : "-")}
            </p>
            {more ? (
              <p className="mt-2">
                {t("suspended.moreOverdue", locale).replace("{amount}", rands(bill.stillOverdueCents))}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="mt-4 rounded-lg bg-brand-tint p-3 text-sm text-ink">{t("suspended.dataSafe", locale)}</p>

        {sp.error ? (
          <div className="mt-4">
            <Flash tone="error" message={errorMessage(sp.error, locale)} />
          </div>
        ) : null}

        {!canPay ? (
          <p className="mt-6 text-sm text-sand-700">{t("suspended.askOwner", locale)}</p>
        ) : bill?.settling ? (
          // The payer is back from Paystack and the webhook has not settled yet: no Pay now,
          // which could only be refused as "already in progress" (review finding app-10).
          <SettlingNotice refreshHref={here} locale={locale} />
        ) : (
          <form action={payOverdueAction} className="mt-6">
            {farmId !== profile.farm_id ? <input type="hidden" name="farm" value={farmId} /> : null}
            {/* The amount on the button is what the checkout charges: one invoice, for
                what is still owed on it. */}
            <SubmitButton className="w-full">
              {bill?.paying && bill.payCents > 0
                ? t("suspended.payAmount", locale).replace("{amount}", rands(bill.payCents))
                : t("suspended.pay", locale)}
            </SubmitButton>
          </form>
        )}

        {canPay ? (
          <p className="mt-3 text-sm text-sand-700">{t("suspended.eft", locale).replace("{email}", COMPANY.email)}</p>
        ) : null}

        <DownloadLink
          href={`/api/farm/export?farm=${farmId}`}
          className="mt-4 flex min-h-12 w-full items-center justify-center rounded-lg border border-sand-300 px-4 text-sm font-medium sm:min-h-11"
          labels={downloadLabels(locale)}
        >
          {t("suspended.download", locale)}
        </DownloadLink>

        <p className="mt-4 text-xs text-sand-700">{t("suspended.help", locale).replace("{email}", COMPANY.email)}</p>
        <SwitchFarm profile={profile} current={farmId} locale={locale} />
      </div>

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

/**
 * What Pay now charges, what else keeps the farm paused, and whether money is already
 * moving, for somebody who may pay (service client, see the page).
 *
 * The invoice is chosen by the checkout's own rule (`openInvoiceForFarm`: the oldest owed,
 * not a service invoice, not a refunded one) and its amount is what is still owed on it,
 * exactly what `beginCheckout` charges. The page used to print the total of every open
 * invoice over a button that charges one (review finding app-4); the checkout stays one
 * invoice per payment, and `overdueAfterPaying` says what is left after it.
 *
 * Every read here is `must`. They decide what the page offers and promises, so a failed
 * one shows the error screen and its retry, not an amount, a promise or a Pay button that
 * may be wrong. They used to be soft, which was right while they only coloured a sentence.
 */
async function payNowFor(svc: SupabaseClient, farmId: string) {
  const [paying, openRead, graceDays] = await Promise.all([
    openInvoiceForFarm(svc, farmId),
    svc
      .from("billing_invoices")
      .select("id, total_incl_cents, amount_paid_cents, due_on, issued_on")
      .eq("farm_id", farmId)
      .eq("status", "open")
      // What keeps the farm paused: not a once-off service invoice.
      .neq("kind", "service")
      .is("deleted_at", null)
      .order("due_on", { ascending: true })
      // A farm has a handful of open invoices at most; the cap is for the read guard.
      .limit(50),
    accessGraceDays(svc),
  ]);
  const open = (must(openRead, "suspended:invoices") ?? []) as OpenInvoice[];
  // A refunded invoice reopens, and is deliberately not owed (the pause and the charge both
  // leave it out): it is not counted as keeping the farm paused.
  const refunds = open.length
    ? ((must(
        await svc
          .from("billing_payments")
          .select("invoice_id")
          .in("invoice_id", open.map((i) => i.id))
          .lt("amount_incl_cents", 0)
          .is("deleted_at", null)
          .limit(100),
        "suspended:refunds",
      ) ?? []) as { invoice_id: string }[])
    : [];
  const refunded = new Set(refunds.map((r) => r.invoice_id));

  return {
    paying,
    payCents: paying ? Math.max(0, paying.total_incl_cents - paying.amount_paid_cents) : 0,
    payDue: paying ? (open.find((i) => i.id === paying.id)?.due_on ?? null) : null,
    // The UTC date, as the gate's current_date is.
    stillOverdueCents: overdueAfterPaying(open, refunded, paying?.id ?? null, graceDays, toIsoDate(new Date())),
    settling: await settlingOnInvoice(svc, farmId, paying?.id ?? null, "suspended:payment-attempt"),
  };
}
