import type { Metadata } from "next";
import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { HeroAside, PublicShell, SplitLayout } from "@/components/public-shell";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, SelectField } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { CheckIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { applyToPartner } from "./actions";

/**
 * The public way to ask to become a partner.
 *
 * There are no prices here on purpose (founder decision, 6 November 2026). It is a request to
 * Rapid Rise, who contact the business and agree terms, pricing and any partnership agreement
 * according to what they offer, whether they qualify, and who can vouch for them. The plans
 * appear only as a rough steer, and "not sure" is the default answer.
 */
export const metadata: Metadata = { title: "Become a partner" };

const KINDS = ["mechanic", "auto_electrician", "parts_supplier", "panel_beater", "tyre", "towing", "other"] as const;

export default async function BecomeAPartnerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  const locale = await deviceLocale();
  const say = (key: string) => t(`become.${key}`, locale).replaceAll("{app}", () => APP_NAME);

  return (
    <PublicShell locale={locale} width="full">
      <SplitLayout
        formWidth="xl"
        aside={
          <HeroAside
            eyebrow={say("eyebrow")}
            title={say("heroTitle")}
            accent={say("heroAccent")}
            lead={say("lead")}
            points={[
              { icon: "1", title: say("stepAsk"), body: say("stepAskHint") },
              { icon: "2", title: say("stepTalk"), body: say("stepTalkHint") },
              { icon: "3", title: say("stepAgree"), body: say("stepAgreeHint") },
            ]}
          />
        }
      >
        {sp.sent ? (
          <div className="flex items-start gap-3">
            <CheckIcon className="mt-1 shrink-0 text-2xl text-status-ok" />
            <div className="min-w-0">
              <h2 className="text-3xl font-bold tracking-tight text-ink">{say("sentTitle")}</h2>
              <p className="mt-2 text-lg text-ink-muted">{say("sentBody")}</p>
              <Link href="/login" className={`mt-6 ${buttonVariants({ variant: "secondary" })}`}>
                {t("publicNav.signIn", locale)}
              </Link>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{say("title")}</h2>
            <p className="mt-2 text-lg text-ink-muted">{say("intro")}</p>
            <p className="mt-2 text-lg text-ink-muted lg:hidden">{say("lead")}</p>
            <Flash tone="error" message={errorMessage(sp.error, locale)} className="mt-5" />

            <form action={applyToPartner} className="mt-8 space-y-5">
              {/* Not for people: see `applyToPartner`. */}
              <input type="text" name="company_site" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={say("businessName")} htmlFor="ap_business">
                  <Input id="ap_business" name="business_name" required minLength={2} maxLength={120} autoComplete="organization" />
                </Field>
                <SelectField name="kind" id="ap_kind" label={say("trade")} defaultValue="mechanic">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{t(`partnerKind.${k}`, locale)}</option>
                  ))}
                </SelectField>
                <Field label={say("contactName")} htmlFor="ap_contact">
                  <Input id="ap_contact" name="contact_name" required minLength={2} maxLength={120} autoComplete="name" />
                </Field>
                <Field label={say("email")} htmlFor="ap_email">
                  <Input id="ap_email" name="email" type="email" inputMode="email" required maxLength={200} autoComplete="email" />
                </Field>
                <Field label={say("phone")} htmlFor="ap_phone">
                  <Input id="ap_phone" name="phone" inputMode="tel" required minLength={6} maxLength={40} autoComplete="tel" />
                </Field>
                <Field label={say("website")} htmlFor="ap_website">
                  <Input id="ap_website" name="website" inputMode="url" maxLength={200} />
                </Field>
              </div>

              <Field label={say("area")} htmlFor="ap_area" hint={say("areaHint")}>
                <Input id="ap_area" name="area" required minLength={2} maxLength={200} />
              </Field>
              <Field label={say("offer")} htmlFor="ap_offer" hint={say("offerHint")}>
                <Textarea id="ap_offer" name="offer" rows={4} required minLength={2} maxLength={2000} />
              </Field>
              <Field label={say("vouch")} htmlFor="ap_vouch" hint={say("vouchHint")}>
                <Textarea id="ap_vouch" name="vouch" rows={3} maxLength={2000} />
              </Field>
              <SelectField name="plan" id="ap_plan" label={say("plan")} defaultValue="" hint={say("planHint")}>
                <option value="">{say("planNotSure")}</option>
                <option value="portal">{say("planPortal")}</option>
                <option value="managed">{say("planManaged")}</option>
                <option value="books">{say("planBooks")}</option>
              </SelectField>

              <Checkbox
                name="consent"
                required
                label={say("consent")}
                hint={
                  <Link href="/privacy" className="underline">
                    {t("publicNav.privacy", locale)}
                  </Link>
                }
              />

              <SubmitButton size="lg" fullWidth pendingText={say("pending")}>
                {say("submit")}
              </SubmitButton>
            </form>
          </>
        )}
      </SplitLayout>
    </PublicShell>
  );
}
