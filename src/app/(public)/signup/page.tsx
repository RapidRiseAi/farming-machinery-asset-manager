import Link from "next/link";

import { companyTypes, t } from "@/lib/i18n";
import { TERMS_VERSION } from "@/lib/legal";
import { deviceLocale } from "@/lib/locale";
import { errorMessage } from "@/lib/errors";
import {
  PLANS,
  perVehicleMonthlyCents,
  ANNUAL_MONTHS_CHARGED,
  FEATURE_MIN_PLAN,
  type Feature,
} from "@/lib/entitlements";

/**
 * What every plan includes, however cheap.
 *
 * These are the capabilities `FEATURE_MIN_PLAN` deliberately does NOT list, because they
 * are ungated, the vehicle register, QR capture, servicing, job cards and faults. They
 * are the reason somebody buys Essential at all, so leaving them off the comparison would
 * make the cheapest plan look empty.
 */
const CORE_FEATURE_KEYS = ["coreRegister", "coreServicing", "coreJobCards", "coreQr"] as const;
import { Field, SelectField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { HeroAside, PublicShell, SplitLayout, Tick } from "@/components/public-shell";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { turnstileWidget } from "@/lib/security/turnstile";
import { PlanPicker } from "./plan-picker";
import { signUp } from "./actions";

/**
 * The front door. Public, anonymous, and the only page in the product that creates a farm.
 *
 * Zero anonymous database access, like every other public page here: the prices come from
 * `src/lib/entitlements.ts`, which a test asserts agrees with the migration that seeds
 * `billing_price_versions`, and suite section (0) asserts again in SQL. What is DISPLAYED
 * and what is CHARGED therefore cannot drift, and the invoice is priced from the
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
  // The bot check, or null while its keys are not set (then nothing renders).
  const captcha = turnstileWidget(locale);

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

  // The same gold square the green panel numbers its steps with, as the website's contact page.
  const step = (nth: number, label: string) => (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="grid size-8 place-items-center bg-gold-500 text-sm font-bold text-accent-on-fill">
        {nth}
      </span>
      <h3 className="text-lg font-bold text-ink">{label}</h3>
    </div>
  );

  return (
    <PublicShell locale={locale} width="full">
      {/* The website's contact-page split: the three steps on the green, the form on cream. */}
      <SplitLayout
        formWidth="xl"
        aside={
          <HeroAside
            eyebrow={t("signup.eyebrow", locale)}
            title={t("signup.heroTitle", locale)}
            accent={t("signup.heroAccent", locale)}
            lead={t("signup.lead", locale)}
            points={[
              { icon: "1", title: t("signup.stepPlan", locale), body: t("signup.stepPlanHint", locale) },
              { icon: "2", title: t("signup.stepDetails", locale), body: t("signup.stepDetailsHint", locale) },
              { icon: "3", title: t("signup.stepPay", locale), body: t("signup.stepPayHint", locale) },
            ]}
          />
        }
      >
      <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        {t("signup.title", locale)}
      </h2>
      <p className="mt-2 text-lg text-ink-muted lg:hidden">{t("signup.lead", locale)}</p>

      {sp.error ? (
        <div className="mt-5">
          <Flash tone="error" message={errorMessage(sp.error, locale)} />
        </div>
      ) : null}

      <form action={signUp} className="mt-8 space-y-5">
        {/* Step 1, the plan, the period and the vehicle count all move one number, so
            they belong in one box. The picker itself is untouched: its arithmetic is
            proven across 24 plan/period/count combinations. */}
        <section className="rounded-md border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
          {step(1, t("signup.stepPlan", locale))}
          <div className="mt-4">
        <PlanPicker
          options={options}
          // Keyed off `FEATURE_MIN_PLAN` itself so the comparison cannot advertise a
          // feature on a plan whose gate will refuse it. Labels only; the mapping is the
          // gate's.
          featureLabels={Object.fromEntries(
            (Object.keys(FEATURE_MIN_PLAN) as Feature[]).map((f) => [
              f,
              t(`signup.feat.${f}`, locale),
            ]),
          )}
          coreFeatures={CORE_FEATURE_KEYS.map((k) => t(`signup.feat.${k}`, locale))}
          labels={{
            vehicles: t("signup.vehicles", locale),
            compareTitle: t("signup.compareTitle", locale),
            compareShow: t("signup.compareShow", locale),
            compareHide: t("signup.compareHide", locale),
            compareFeature: t("signup.compareFeature", locale),
            compareChosen: t("signup.compareChosen", locale),
            compareYes: t("signup.compareYes", locale),
            compareNo: t("signup.compareNo", locale),
            compareSwipe: t("signup.compareSwipe", locale),
            saveAnnual: t("signup.saveAnnual", locale),
            annualPerMonth: t("signup.annualPerMonth", locale),
            vehiclesHelp: t("signup.vehiclesHelp", locale),
            vehiclesFewer: t("signup.vehiclesFewer", locale),
            vehiclesMore: t("signup.vehiclesMore", locale),
            totalMonthlyNote: t("signup.totalMonthlyNote", locale),
            totalAnnualNote: t("signup.totalAnnualNote", locale),
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

        {/* Step 2, who they are. On the kit's Field/Input, which carry the 48px floor,
            real labels that stay put, and `aria-invalid` wiring. The hand-rolled inputs
            this replaces used `bg-surface`, a token committed config never defined, so
            they had no background at all in production. */}
        <section className="rounded-md border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
          {step(2, t("signup.stepDetails", locale))}
          <div className="mt-4 space-y-4">
            <SelectField
              name="company_type"
              id="company_type"
              label={t("signup.companyType", locale)}
              hint={t("signup.companyTypeHint", locale)}
              required
              defaultValue=""
            >
              <option value="" disabled>{t("signup.companyTypeChoose", locale)}</option>
              {companyTypes.map((c) => (
                <option key={c} value={c}>{t(`companyType.${c}`, locale)}</option>
              ))}
            </SelectField>
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
            affirmative act, and "by continuing you agree" is weaker precisely because the
            visitor need never have seen it. The links open in a new tab so a half-filled
            form is not thrown away by somebody who stops to read.

            The version travels with the form, so what gets recorded is what this page
            rendered rather than whatever is current by the time the submit lands. */}
        <section className="rounded-md border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
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

          {/* No promo-code box (founder record of 26 October 2026): a Founding Farmer deal is
              negotiated with Rapid Rise and set on the farm by staff, never typed in here. */}

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

        {captcha ? (
          <div className="mt-4">
            <TurnstileWidget siteKey={captcha.siteKey} language={captcha.language} />
          </div>
        ) : null}

        {/* SubmitButton, not a bare button: it disables itself while the farm is being
            created, so a second tap on a slow connection cannot start a second sign-up.
            The note that sat under it repeated the three ticks above word for word. */}
        <SubmitButton fullWidth size="lg" className="mt-4" pendingText={t("signup.submitting", locale)}>
          {t("signup.submit", locale)}
        </SubmitButton>
        </section>
      </form>

      <p className="mt-8 text-sm text-ink-muted">
        {t("signup.haveAccount", locale)}{" "}
        <Link href="/login" className="font-bold text-brand-ink underline underline-offset-4">
          {t("signup.signIn", locale)}
        </Link>
      </p>
      </SplitLayout>
    </PublicShell>
  );
}
