import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { COMPANY } from "@/lib/legal";
import { t, localeOf, type Lang } from "@/lib/i18n";
import { BrandMark, Wordmark } from "@/components/ui/brand-mark";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";

/**
 * The frame around every page somebody sees BEFORE they have an account: the landing page,
 * sign in, sign up, the terms.
 *
 * == Why these three share a shell ============================================
 * They were three unrelated layouts with three different headers, and a visitor moving
 * between them could reasonably wonder whether they were still on the same site. That is
 * not a small thing on the screens where somebody decides whether to type a card number
 * into you.
 *
 * == What the footer is for ===================================================
 * A registered company name, a registration number and a real address, on every page before
 * the sale. Half of looking trustworthy is being identifiable, and for a South African
 * electronic transaction, ECTA §43 wants exactly this information available before somebody
 * transacts, not buried afterwards.
 */
export function PublicShell({
  locale,
  children,
  width = "narrow",
  languageSwitch = true,
}: {
  locale: Lang;
  children: React.ReactNode;
  /** `narrow` for a form, `wide` for the landing page's content. */
  width?: "narrow" | "wide";
  /**
   * False on a page whose URL is the whole point, /auth/confirm: the switch returns to the
   * path WITHOUT its query, which there would drop the one-time sign-in token.
   */
  languageSwitch?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-sand-50">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-5">
        <Link href="/" className="focus-ring flex min-h-[48px] items-center gap-2.5 rounded-lg" aria-label={APP_NAME}>
          <BrandMark priority />
          <Wordmark name={APP_NAME} />
        </Link>
        {/* The switcher shows the LANGUAGE choice, which is independent of tone, an
            af-pro reader must see AF selected, not "af-pro". `localeOf` is the same
            narrowing every other caller of this control uses. */}
        {languageSwitch ? (
          <DeviceLanguageSwitcher current={localeOf(locale)} label={t("auth.language", locale)} />
        ) : null}
      </header>

      <main
        className={`mx-auto w-full flex-1 px-6 pb-12 ${
          width === "wide" ? "max-w-5xl" : "max-w-md"
        }`}
      >
        {children}
      </main>

      <footer className="mx-auto w-full max-w-5xl px-6 py-8 text-sm text-sand-600">
        <div className="border-t border-sand-200 pt-6">
          <div className="flex flex-wrap gap-x-5 sm:gap-y-2">
            <Link href="/terms" className="inline-flex min-h-[48px] items-center underline hover:text-sand-900 sm:min-h-0">
              {t("publicNav.terms", locale)}
            </Link>
            <Link href="/privacy" className="inline-flex min-h-[48px] items-center underline hover:text-sand-900 sm:min-h-0">
              {t("publicNav.privacy", locale)}
            </Link>
            <a href={`mailto:${COMPANY.email}`} className="inline-flex min-h-[48px] items-center underline hover:text-sand-900 sm:min-h-0">
              {COMPANY.email}
            </a>
          </div>
          <p className="mt-3 text-sand-500">
            {COMPANY.legalName} · {t("publicNav.reg", locale)} {COMPANY.regNumber} ·{" "}
            {COMPANY.address}
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * The brand beside a sign-in form on a wide screen: FleetWise Black (the palette's ground
 * for "premium sections, logo background", so the logo's own black runs into it), the
 * mark large, the brand's first message, and three things the product really does, with
 * gold ticks. Nothing here is a claim the product cannot back (BRAND.md: no invented
 * counts or endorsements). Hidden on a phone, where the form comes first.
 */
export function BrandPanel({ locale }: { locale: Lang }) {
  return (
    <aside className="relative hidden overflow-hidden rounded-3xl bg-black p-10 text-white shadow-soft lg:flex lg:min-h-[32rem] lg:flex-col lg:justify-between">
      {/* A low green glow from one corner, so the black has depth and reads as FleetWise. */}
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-32 -right-24 size-96 rounded-full bg-brand-600/40 blur-3xl" />
      <BrandMark size="lg" className="relative" />
      <div className="relative">
        <p className="max-w-sm text-3xl font-bold leading-tight tracking-tight">{t("auth.brandTitle", locale)}</p>
        <ul className="mt-6 flex flex-col gap-3 text-base text-white/85">
          {(["brandPoint1", "brandPoint2", "brandPoint3"] as const).map((k) => (
            <li key={k} className="flex items-start gap-3">
              {/* The gold fill colour, on black (9.89:1), not on cream. */}
              <Tick className="mt-0.5 text-accent" />
              <span>{t(`auth.${k}`, locale)}</span>
            </li>
          ))}
        </ul>
        <span aria-hidden="true" className="mt-8 block h-1 w-16 rounded-full bg-gold-500" />
      </div>
    </aside>
  );
}

/** A tick. Inline rather than an icon import, because it is decoration beside real words. */
export function Tick({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`size-5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}
