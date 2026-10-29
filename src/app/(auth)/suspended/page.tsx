import { redirect } from "next/navigation";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { rands } from "@/lib/money";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";
import { soft } from "@/lib/supabase/must";
import { farmBillingGate } from "@/lib/billing/service";
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

  // What is owed, read through the caller's own client: billing rows are the owner's and
  // manager's to see (app.is_farm_billing_admin), so an operator reads the general sentence
  // instead of the farm's commercial position. Soft: the page must work without it.
  const owed = canPay
    ? ((soft(
        await supabase
          .from("billing_invoices")
          .select("id, invoice_ref, total_incl_cents, amount_paid_cents, due_on")
          .eq("farm_id", farmId)
          .eq("status", "open")
          // What keeps the farm paused: not a once-off service invoice.
          .neq("kind", "service")
          .is("deleted_at", null)
          .order("due_on", { ascending: true })
          // A farm has a handful of open invoices at most; the cap is for the read guard.
          .limit(50),
        "suspended:invoices",
      ) as { id: string; invoice_ref: string; total_incl_cents: number; amount_paid_cents: number; due_on: string | null }[] | null) ?? [])
    : [];
  // A refunded invoice reopens, and is deliberately not owed (the pause and the charge both
  // leave it out): it is not added to what this page asks for.
  const refunded = owed.length
    ? new Set(((soft(
        await supabase.from("billing_payments").select("invoice_id")
          .in("invoice_id", owed.map((i) => i.id)).lt("amount_incl_cents", 0).is("deleted_at", null).limit(100),
        "suspended:refunds",
      ) as { invoice_id: string }[] | null) ?? []).map((r) => r.invoice_id))
    : new Set<string>();
  const counting = owed.filter((i) => !refunded.has(i.id));
  const outstanding = counting.reduce((sum, i) => sum + Math.max(0, i.total_incl_cents - i.amount_paid_cents), 0);
  const oldest = counting.find((i) => i.due_on)?.due_on ?? null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
        <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
      </div>

      <div className="rounded-2xl border border-sand-300 bg-surface p-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("suspended.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t("suspended.lead", locale)}</p>

        {canPay && outstanding > 0 ? (
          <p className="mt-3 rounded-lg border border-sand-200 p-3 text-sm text-ink">
            {t("suspended.owed", locale)
              .replace("{amount}", rands(outstanding))
              .replace("{date}", oldest ? shortDate(oldest, locale) : "-")}
          </p>
        ) : null}

        <p className="mt-4 rounded-lg bg-brand-tint p-3 text-sm text-ink">{t("suspended.dataSafe", locale)}</p>

        {sp.error ? (
          <div className="mt-4">
            <Flash tone="error" message={errorMessage(sp.error, locale)} />
          </div>
        ) : null}

        {canPay ? (
          <form action={payOverdueAction} className="mt-6">
            {farmId !== profile.farm_id ? <input type="hidden" name="farm" value={farmId} /> : null}
            <SubmitButton className="w-full">{t("suspended.pay", locale)}</SubmitButton>
          </form>
        ) : (
          <p className="mt-6 text-sm text-sand-700">{t("suspended.askOwner", locale)}</p>
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
