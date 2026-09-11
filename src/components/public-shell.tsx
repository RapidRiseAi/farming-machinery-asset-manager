import Link from "next/link";

import { APP_NAME } from "@/lib/env";
import { COMPANY } from "@/lib/legal";
import { t, localeOf, type Lang } from "@/lib/i18n";
import { MachinesIcon } from "@/components/ui/icons";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";

/**
 * The frame around every page somebody sees BEFORE they have an account: the landing page,
 * sign in, sign up, the terms.
 *
 * ── Why these three share a shell ────────────────────────────────────────────
 * They were three unrelated layouts with three different headers, and a visitor moving
 * between them could reasonably wonder whether they were still on the same site. That is
 * not a small thing on the screens where somebody decides whether to type a card number
 * into you.
 *
 * ── What the footer is for ───────────────────────────────────────────────────
 * A registered company name, a registration number and a real address, on every page before
 * the sale. Half of looking trustworthy is being identifiable — and for a South African
 * electronic transaction, ECTA §43 wants exactly this information available before somebody
 * transacts, not buried afterwards.
 */
export function PublicShell({
  locale,
  children,
  width = "narrow",
}: {
  locale: Lang;
  children: React.ReactNode;
  /** `narrow` for a form, `wide` for the landing page's content. */
  width?: "narrow" | "wide";
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-sand-50">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5" aria-label={APP_NAME}>
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <MachinesIcon className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-sand-900">{APP_NAME}</span>
        </Link>
        {/* The switcher shows the LANGUAGE choice, which is independent of tone — an
            af-pro reader must see AF selected, not "af-pro". `localeOf` is the same
            narrowing every other caller of this control uses. */}
        <DeviceLanguageSwitcher current={localeOf(locale)} label={t("auth.language", locale)} />
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
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/terms" className="underline hover:text-sand-900">
              {t("publicNav.terms", locale)}
            </Link>
            <Link href="/privacy" className="underline hover:text-sand-900">
              {t("publicNav.privacy", locale)}
            </Link>
            <a href={`mailto:${COMPANY.email}`} className="underline hover:text-sand-900">
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
