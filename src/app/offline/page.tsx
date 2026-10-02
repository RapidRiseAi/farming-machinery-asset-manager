import { t, locales } from "@/lib/i18n";
import { MachinesIcon } from "@/components/ui/icons";
import { buttonVariants } from "@/components/ui/button";

// Static fallback served by the service worker for never-visited routes while offline.
// No auth, no data, deliberately tiny so it precaches cleanly.
export const dynamic = "force-static";

/**
 * Force-static means one HTML for everybody, so there is no request to read a language
 * from. It used to render in the default locale only, which gave every Afrikaans user an
 * English page at exactly the moment they could not fetch anything else. The short copy
 * is shown in both languages instead, each block marked with its own `lang`.
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
