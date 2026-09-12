import Link from "next/link";

import { t } from "@/lib/i18n";
import { TERMS_VERSION } from "@/lib/legal";
import { deviceLocale } from "@/lib/locale";
import { errorMessage } from "@/lib/errors";
import { PLANS, perVehicleMonthlyCents, ANNUAL_MONTHS_CHARGED } from "@/lib/entitlements";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Flash } from "@/components/ui/flash";
import { PublicShell, Tick } from "@/components/public-shell";
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

  const step = (nth: number, label: string) => (
    <div className="flex items-center gap-2.5">
      <span className="flex size-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
        {nth}
      </span>
      <h2 className="font-semibold text-sand-900">{label}</h2>
    </div>
  );

  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">
          {t("signup.title", locale)}
        </h1>
        <p className="mt-1.5 text-sand-600">{t("signup.lead", locale)}</p>
      </div>

      {sp.error ? (
        <div className="mt-5">
          <Flash tone="error" message={errorMessage(sp.error, locale)} />
        </div>
      ) : null}

      <form action={signUp} className="mt-5 space-y-4">
        {/* Step 1 — the plan, the period and the vehicle count all move one number, so
            they belong in one box. The picker itself is untouched: its arithmetic is
            proven across 24 plan/period/count combinations. */}
        <section className="rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs">
          {step(1, t("signup.stepPlan", locale))}
          <div className="mt-4">
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

          </div>
        </section>

        {/* Step 2 — who they are. On the kit's Field/Input, which carry the 48px floor,
            real labels that stay put, and `aria-invalid` wiring. The hand-rolled inputs
            this replaces used `bg-surface`, a token committed config never defined, so
            they had no background at all in production. */}
        <section className="rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs">
          {step(2, t("signup.stepDetails", locale))}
          <div className="mt-4 space-y-4">
            <Field label={t("signup.farmName", locale)} htmlFor="farm_name">
              <Input id="farm_name" name="farm_name" required autoComplete="organization" />
            </Field>
            <Field label={t("signup.yourName", locale)} htmlFor="name">
              <Input id="name" name="name" required autoComplete="name" />
            </Field>
            <Field
              label={t("signup.email", locale)}
              htmlFor="email"
              hint={t("signup.emailHint", locale)}
            >
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </Field>
            <Field
              label={t("signup.password", locale)}
              htmlFor="password"
              hint={t("signup.passwordHint", locale)}
            >
              <PasswordInput id="password" name="password" required minLength={8} autoComplete="new-password" />
            </Field>
          </div>
        </section>

        {/* An explicit tick, not a line of small print. ECTA §43 and the Consumer
            Protection Act both want the terms available BEFORE the transaction and an
            affirmative act — and "by continuing you agree" is weaker precisely because the
            visitor need never have seen it. The links open in a new tab so a half-filled
            form is not thrown away by somebody who stops to read.

            The version travels with the form, so what gets recorded is what this page
            rendered rather than whatever is current by the time the submit lands. */}
        <section className="rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs">
          {step(3, t("signup.stepPay", locale))}

          {/* The three things somebody actually worries about with a card in their hand,
              next to the button rather than in small print under it. */}
          <ul className="mt-4 space-y-2">
            {(["card", "cancel", "open"] as const).map((k) => (
              <li key={k} className="flex items-start gap-2.5 text-sm text-sand-700">
                <Tick className="mt-0.5 text-status-ok" />
                <span>{t(`signup.assure.${k}`, locale)}</span>
              </li>
            ))}
          </ul>

        <input type="hidden" name="terms_version" value={TERMS_VERSION} />
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-sand-200 bg-sand-50 p-4">
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
          className="mt-4 min-h-12 w-full rounded-xl bg-brand-600 px-4 text-base font-semibold text-white shadow-soft transition hover:bg-brand-700 sm:min-h-11"
        >
          {t("signup.submit", locale)}
        </button>
        <p className="mt-3 text-xs leading-relaxed text-sand-600">{t("signup.note", locale)}</p>
        </section>
      </form>

      <p className="mt-6 text-center text-sm text-sand-600">
        {t("signup.haveAccount", locale)}{" "}
        <Link href="/login" className="font-medium text-brand-ink underline">
          {t("signup.signIn", locale)}
        </Link>
      </p>
    </PublicShell>
  );
}
