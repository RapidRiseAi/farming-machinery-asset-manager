import Link from "next/link";
import type { ReactNode } from "react";

import { APP_NAME } from "@/lib/env";
import { COMPANY } from "@/lib/legal";
import { t, localeOf, type Lang } from "@/lib/i18n";
import { BrandMark, Wordmark } from "@/components/ui/brand-mark";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";
import { ArrowUpRightIcon } from "@/components/ui/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/** The marketing website. Its "Log in" lands on /login, so these pages are its next step. */
export const WEBSITE = "https://fleet-wise.co.za";

/**
 * The website's content column (headerInner: 1440px, 4% each side), for every full-width
 * section on these pages, so the header's logo, a hero's eyebrow, a strip of cards and the
 * footer all start on the same line. The percentage resolves against a FULL-WIDTH parent;
 * inside a grid cell it would be 4% of the cell (see HeroAside).
 */
export const SITE_GUTTER = "mx-auto w-full max-w-[1440px] px-6 sm:px-[4%]";

/**
 * The frame around every page somebody sees BEFORE they have an account: the front page,
 * sign in, sign up, the legal pages, the two-step and email-confirm screens.
 *
 * == It looks like the website ================================================
 * A visitor arrives here from fleet-wise.co.za (its "Log in" points at /login), so these
 * pages wear the website's own clothes (fleetwise-website Desktop.module.css): a white
 * header with the logo tile and FLEETWISE in capitals, a link back and a green "Get in
 * touch" button; a FleetWise Black footer; and, on sign in and sign up, the website's
 * contact-page split, a deep green panel beside a cream form. `.site-form` gives the forms
 * the website's taller fields and bold labels (globals.css).
 *
 * == Why these share a shell ==================================================
 * They were unrelated layouts with different headers, and a visitor moving between them
 * could reasonably wonder whether they were still on the same site. That is not a small
 * thing on the screens where somebody decides whether to type a card number into you.
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
  children: ReactNode;
  /**
   * `narrow` for a single form, `wide` for content, `full` for a page that lays out its own
   * full-width sections (the split sign-in, the front page's hero, the legal pages).
   */
  width?: "narrow" | "wide" | "full";
  /**
   * False on a page whose URL is the whole point, /auth/confirm: the switch returns to the
   * path WITHOUT its query, which there would drop the one-time sign-in token.
   */
  languageSwitch?: boolean;
}) {
  const footerLink =
    "inline-flex min-h-[48px] items-center gap-1 text-sm text-white/80 transition-colors hover:text-accent sm:min-h-0 sm:py-1";
  return (
    <div className="site-form flex min-h-dvh flex-col bg-surface-raised">
      <header className="sticky top-0 z-30 border-b border-edge-soft bg-surface/95 backdrop-blur-md">
        <div className={cn(SITE_GUTTER, "flex h-16 items-center justify-between gap-3 sm:h-20")}>
          <Link href="/" className="focus-ring flex min-h-[48px] min-w-0 items-center gap-2.5 rounded-lg" aria-label={APP_NAME}>
            <BrandMark size="site" priority />
            <Wordmark name={APP_NAME} caps className="truncate max-sm:text-xl" />
          </Link>
          <div className="flex shrink-0 items-center gap-2 sm:gap-5">
            <a
              href={WEBSITE}
              className="focus-ring hidden min-h-[44px] items-center gap-1 rounded text-sm font-medium text-ink hover:text-brand-ink md:inline-flex"
            >
              {t("publicNav.website", locale)}
              <ArrowUpRightIcon className="text-base" />
            </a>
            {/* The kit's green button (the website's header button is the same green). `hidden`
                outranks the kit's `inline-flex` until `lg:`, where the variant brings it back. */}
            <a
              href={`${WEBSITE}/contact`}
              className={buttonVariants({ variant: "primary", className: "hidden gap-3 font-bold lg:inline-flex" })}
            >
              {t("publicNav.getInTouch", locale)}
              <ArrowUpRightIcon className="text-base" />
            </a>
            {/* The switcher shows the LANGUAGE choice, which is independent of tone, an
                af-pro reader must see AF selected, not "af-pro". `localeOf` is the same
                narrowing every other caller of this control uses. */}
            {languageSwitch ? (
              <DeviceLanguageSwitcher current={localeOf(locale)} label={t("auth.language", locale)} />
            ) : null}
          </div>
        </div>
      </header>

      <main
        className={cn(
          "w-full flex-1",
          width !== "full" && "mx-auto px-6 pb-12",
          width === "wide" && "max-w-5xl",
          width === "narrow" && "max-w-md",
        )}
      >
        {children}
      </main>

      <footer className="bg-black pb-6 pt-14 text-white">
        <div className={cn(SITE_GUTTER, "grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]")}>
          <div>
            <Link href="/" className="focus-ring inline-flex min-h-[48px] items-center gap-2.5 rounded-lg" aria-label={APP_NAME}>
              <BrandMark size="site" />
              <Wordmark name={APP_NAME} caps tone="footer" />
            </Link>
            <p className="mt-5 text-sm leading-7 text-white/75">
              {t("publicNav.tagline", locale)}
              <br />
              {t("publicNav.taglineSub", locale)}
            </p>
            <a
              href={`mailto:${COMPANY.email}`}
              className="mt-3 inline-flex min-h-[48px] items-center gap-2 text-sm text-accent hover:underline sm:min-h-[44px]"
            >
              {COMPANY.email}
              <ArrowUpRightIcon className="text-base" />
            </a>
          </div>
          <nav aria-label={t("publicNav.goodToKnow", locale)} className="flex flex-col items-start">
            <h2 className="mb-3 text-sm font-semibold text-white">{t("publicNav.goodToKnow", locale)}</h2>
            <Link href="/login" className={footerLink}>{t("publicNav.signIn", locale)}</Link>
            <Link href="/signup" className={footerLink}>{t("auth.startTrial", locale)}</Link>
            <Link href="/become-a-partner" className={footerLink}>{t("publicNav.becomePartner", locale)}</Link>
            <a href={WEBSITE} className={footerLink}>
              {t("publicNav.website", locale)}
              <ArrowUpRightIcon className="text-sm" />
            </a>
            <a href={`${WEBSITE}/contact`} className={footerLink}>
              {t("publicNav.getInTouch", locale)}
              <ArrowUpRightIcon className="text-sm" />
            </a>
          </nav>
          <div className="flex flex-col items-start">
            <h2 className="mb-3 text-sm font-semibold text-white">{t("publicNav.company", locale)}</h2>
            <p className="text-sm leading-6 text-white/75">
              {COMPANY.legalName}
              <br />
              {t("publicNav.reg", locale)} {COMPANY.regNumber}
              <br />
              {COMPANY.address}
            </p>
            <Link href="/terms" className={cn(footerLink, "mt-2")}>{t("publicNav.terms", locale)}</Link>
            <Link href="/privacy" className={footerLink}>{t("publicNav.privacy", locale)}</Link>
          </div>
        </div>
        <div className={cn(SITE_GUTTER, "mt-10")}>
          <div className="flex flex-col gap-2 border-t border-white/20 pt-5 text-xs text-white/70 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("publicNav.copyright", locale).replace("{year}", String(new Date().getFullYear()))}</span>
            <span>{t("publicNav.product", locale)}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * The website's contact-page split: a deep green panel (`aside`) beside a cream panel
 * holding the form. On a phone the panel comes first, kept short so the form is close.
 */
export function SplitLayout({
  aside,
  children,
  formWidth = "md",
}: {
  aside: ReactNode;
  children: ReactNode;
  /** `md` for a short form (sign in), `xl` for one with a plan picker (sign up). */
  formWidth?: "md" | "xl";
}) {
  return (
    <div className="grid lg:min-h-[calc(100dvh-5rem)] lg:grid-cols-[minmax(380px,0.82fr)_minmax(0,1.18fr)]">
      {aside}
      <div className="px-6 pb-16 pt-10 sm:px-[4vw] lg:px-16 lg:py-20">
        <div className={cn("w-full", formWidth === "xl" ? "max-w-3xl" : "max-w-lg")}>{children}</div>
      </div>
    </div>
  );
}

/**
 * The green panel: a gold eyebrow in capitals, the headline with its second line in gold,
 * a lead and points with gold square tiles, as the website's contact page. The headline is
 * the page's `h1`; the form beside it carries an `h2`, as the website does. On a phone only
 * the eyebrow and headline show, so the form is a short scroll away.
 */
export function HeroAside({
  eyebrow,
  title,
  accent,
  lead,
  points = [],
}: {
  eyebrow: string;
  title: string;
  accent: string;
  lead?: string;
  points?: { icon: ReactNode; title: string; body?: string }[];
}) {
  return (
    <section className="bg-brand-800 px-6 py-10 text-white sm:px-[4vw] lg:py-20 lg:pl-[calc(max(0px,(100vw_-_1440px)/2)_+_4vw)] lg:pr-12">
      {/* Sticky beside a long form (sign up), so the steps stay in view, not a green void. */}
      <div className="lg:sticky lg:top-28 lg:max-w-xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
        <h1 className="mt-4 text-4xl font-bold leading-[1.04] tracking-[-0.04em] text-white lg:text-5xl 2xl:text-6xl">
          {title}
          <span className="block text-accent">{accent}</span>
        </h1>
        {lead ? <p className="mt-6 hidden max-w-md text-lg leading-relaxed text-white/85 lg:block">{lead}</p> : null}
        {points.length > 0 ? (
          <ul className="mt-10 hidden gap-4 lg:grid">
            {points.map((p) => (
              <li key={p.title} className="grid grid-cols-[2.5rem_1fr] items-start gap-3.5">
                <span aria-hidden="true" className="grid size-10 place-items-center bg-gold-500 text-lg font-bold text-accent-on-fill">
                  {p.icon}
                </span>
                <span>
                  <strong className="block text-base font-bold text-white">{p.title}</strong>
                  {p.body ? <span className="block text-sm leading-relaxed text-white/80">{p.body}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
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
