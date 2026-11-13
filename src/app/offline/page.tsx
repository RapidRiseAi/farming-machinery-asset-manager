import { t, locales } from "@/lib/i18n";
import { MachinesIcon } from "@/components/ui/icons";
import { buttonVariants } from "@/components/ui/button";

// Fallback served by the service worker for never-visited routes while offline.
// No auth, no data, deliberately tiny so it precaches cleanly.
//
// Rendered per request, NOT static (13 November 2026). The content security policy carries a
// fresh nonce on every response (lib/security/csp.ts), and a page built once at build time
// has no nonce on its scripts, so opened online every script on it would be blocked. The service
// worker keeps the copy it fetched at install and serves it offline with no policy header
// (public/sw.js, networkFirstNav), so the nonce in that copy never meets a different one.
export const dynamic = "force-dynamic";

/**
 * The service worker caches one copy for whoever uses this device, so the page must not
 * depend on who asked. It used to render in the default locale only, which gave every
 * Afrikaans user an English page at exactly the moment they could not fetch anything else.
 * The short copy is shown in both languages instead, each block marked with its own `lang`.
 *
 * "Try again" goes to /home, the role dispatcher. It went to /dashboard, which drivers and
 * contractors cannot open, so their retry landed on a refusal.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-5 p-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl text-white">
        <MachinesIcon aria-hidden />
      </span>
      {locales.map((locale, n) => (
        <section key={locale} lang={locale} className="flex flex-col gap-2">
          {n === 0 ? (
            <h1 className="text-xl font-bold text-sand-900">{t("offline.pageTitle", locale)}</h1>
          ) : (
            <h2 className="text-lg font-bold text-sand-900">{t("offline.pageTitle", locale)}</h2>
          )}
          <p className="text-sm text-sand-600">{t("offline.pageBody", locale)}</p>
        </section>
      ))}
      <a href="/home" className={buttonVariants({ variant: "primary", size: "lg" })}>
        {locales.map((locale) => t("offline.retry", locale)).join(" / ")}
      </a>
    </main>
  );
}
