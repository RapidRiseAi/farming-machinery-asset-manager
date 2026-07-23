import { t, defaultLocale } from "@/lib/i18n";

// Static fallback served by the service worker for never-visited routes while offline.
// No auth, no data — deliberately tiny so it precaches cleanly.
export const dynamic = "force-static";

export default function OfflinePage() {
  const locale = defaultLocale;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">🚜</span>
      <h1 className="text-xl font-bold text-sand-900">{t("offline.pageTitle", locale)}</h1>
      <p className="text-sm text-sand-600">{t("offline.pageBody", locale)}</p>
      <a
        href="/dashboard"
        className="focus-ring min-h-[48px] rounded-lg bg-brand-600 px-5 py-3 text-base font-semibold text-white"
      >
        {t("offline.retry", locale)}
      </a>
    </main>
  );
}
