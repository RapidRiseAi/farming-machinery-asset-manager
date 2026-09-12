import Link from "next/link";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { MachinesIcon } from "@/components/ui/icons";

/**
 * The 404.
 *
 * There was no not-found page anywhere in the product, so a deleted document, a
 * revoked link or a mistyped id dropped the user onto Next's default: unstyled,
 * outside the app shell, English only, and with no way back — in an app that
 * otherwise keeps 3,626 translation keys at parity.
 *
 * This is the ROOT not-found, so it renders inside the root layout only and has
 * no access to a session. That is why it links to `/home` (the role dispatcher)
 * rather than guessing a destination, and why it stays self-contained rather
 * than importing app-shell chrome that would need a profile to render.
 *
 * Language comes from `deviceLocale()` — the cookie, then Accept-Language —
 * which is the same signal the root layout uses for `<html lang>`, so the two
 * always agree.
 */
export default async function NotFound() {
  const locale = await deviceLocale();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl text-white shadow-soft">
        <MachinesIcon aria-hidden />
      </span>

      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {t("notFound.title", locale)}
        </h1>
        {/* Says plainly that this is not the reader's fault. A 404 in a work tool
            is usually a stale link, and people assume they broke something. */}
        <p className="text-base text-ink-muted">{t("notFound.body", locale)}</p>
      </div>

      <div className="flex w-full flex-col gap-2.5">
        <Link
          href="/home"
          className="focus-ring flex min-h-[48px] items-center justify-center rounded-lg bg-brand-600 px-5 text-base font-semibold text-white shadow-xs transition-colors hover:bg-brand-700"
        >
          {t("notFound.home", locale)}
        </Link>
        <Link
          href="/login"
          className="focus-ring flex min-h-[48px] items-center justify-center rounded-lg border border-edge bg-surface px-5 text-base font-medium text-ink transition-colors hover:bg-surface-sunken"
        >
          {t("notFound.signIn", locale)}
        </Link>
      </div>
    </main>
  );
}
