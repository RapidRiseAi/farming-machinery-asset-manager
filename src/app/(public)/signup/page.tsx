import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { TERMS_VERSION } from "@/lib/legal";
import { deviceLocale } from "@/lib/locale";
import { errorMessage } from "@/lib/errors";
import { PLANS, perVehicleMonthlyCents, ANNUAL_MONTHS_CHARGED } from "@/lib/entitlements";
import { MachinesIcon } from "@/components/ui/icons";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";
import { PlanPicker } from "./plan-picker";
import { signUp } from "./actions";

/**
 * The front door. Public, anonymous, and the only page in the product that creates a farm.
 *
 * Zero anonymous database access, like every other public page here: the prices come from
 * `src/lib/entitlements.ts`, which a test asserts agrees with the migration that seeds
 * `billing_price_versions`, and suite section (0) asserts again in SQL. What is DISPLAYED
 * and what is CHARGED therefore cannot drift — and the invoice is priced from the
 * catalogue regardless of anything this form sends.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  // Pre-auth there is no profile to read a language from, so the device decides.
  const locale = await deviceLocale();

  const options = PLANS.map((plan) => {
    const monthly = perVehicleMonthlyCents(plan, "monthly");
    return {
      plan,
      label: t(`plan.${plan}`, locale),
      blurb: t(`signup.blurb.${plan}`, locale),
      monthlyCents: monthly,
      // Annual is billed as ten months of the list price (founder decision: two months
      // free). Shown per vehicle per YEAR, because that is what leaves the bank.
      annualCents: monthly == null ? null : monthly * ANNUAL_MONTHS_CHARGED,
    };
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MachinesIcon className="size-8 text-brand-ink" aria-hidden="true" />
          <span className="text-xl font-semibold text-brand-ink">{APP_NAME}</span>
        </div>
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </div>

      <div>
        <h1 className="text-2xl font-semibold">{t("signup.title", locale)}</h1>
        <p className="mt-2 text-sand-700">{t("signup.lead", locale)}</p>
      </div>

      {sp.error ? (
        <p className="rounded-lg bg-status-bad/10 p-3 text-sm text-status-bad">
          {errorMessage(sp.error, locale)}
        </p>
      ) : null}

      <form action={signUp} className="space-y-6">
        <PlanPicker
          options={options}
          labels={{
            vehicles: t("signup.vehicles", locale),
            monthly: t("signup.monthly", locale),
            annual: t("signup.annual", locale),
            perMonth: t("signup.perMonth", locale),
            perYear: t("signup.perYear", locale),
            total: t("signup.total", locale),
            annualNote: t("signup.annualNote", locale),
            unavailable: t("signup.unavailable", locale),
            choosePlan: t("signup.choosePlan", locale),
            howOften: t("signup.howOften", locale),
          }}
        />

        <div className="space-y-4 border-t border-sand-300 pt-6">
          <div>
            <label htmlFor="farm_name" className="block text-sm font-medium">
              {t("signup.farmName", locale)}
            </label>
            <input
              id="farm_name"
              name="farm_name"
              required
              autoComplete="organization"
              className="mt-1 min-h-12 w-full rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
            />
          </div>
          <div>
            <label htmlFor="name" className="block text-sm font-medium">
              {t("signup.yourName", locale)}
            </label>
            <input
              id="name"
              name="name"
              required
              autoComplete="name"
              className="mt-1 min-h-12 w-full rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              {t("signup.email", locale)}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 min-h-12 w-full rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              {t("signup.password", locale)}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 min-h-12 w-full rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
            />
            <p className="mt-1 text-xs text-sand-700">{t("signup.passwordHint", locale)}</p>
          </div>
        </div>

        {/* An explicit tick, not a line of small print. ECTA §43 and the Consumer
            Protection Act both want the terms available BEFORE the transaction and an
            affirmative act — and "by continuing you agree" is weaker precisely because the
            visitor need never have seen it. The links open in a new tab so a half-filled
            form is not thrown away by somebody who stops to read.

            The version travels with the form, so what gets recorded is what this page
            rendered rather than whatever is current by the time the submit lands. */}
        <input type="hidden" name="terms_version" value={TERMS_VERSION} />
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-sand-300 bg-surface-1 p-4">
          <input type="checkbox" name="terms" required className="mt-1 size-5" />
          <span className="text-sm text-sand-800">
            {t("signup.termsPre", locale)}{" "}
            <a href="/terms" target="_blank" rel="noopener" className="font-medium text-brand-ink underline">
              {t("signup.termsLink", locale)}
            </a>{" "}
            {t("signup.termsAnd", locale)}{" "}
            <a href="/privacy" target="_blank" rel="noopener" className="font-medium text-brand-ink underline">
              {t("signup.privacyLink", locale)}
            </a>
            {t("signup.termsPost", locale)}
          </span>
        </label>

        <button
          type="submit"
          className="min-h-12 w-full rounded-lg bg-brand-500 px-4 font-semibold text-white sm:min-h-11"
        >
          {t("signup.submit", locale)}
        </button>
        <p className="text-xs text-sand-700">{t("signup.note", locale)}</p>
      </form>

      <p className="text-sm text-sand-700">
        {t("signup.haveAccount", locale)}{" "}
        <Link href="/login" className="font-medium text-brand-ink underline">
          {t("signup.signIn", locale)}
        </Link>
      </p>
    </main>
  );
}
