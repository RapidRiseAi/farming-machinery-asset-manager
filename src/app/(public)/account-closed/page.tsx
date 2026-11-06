import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { PublicShell } from "@/components/public-shell";

/** Somewhere to land: the account they were signed in to no longer exists. */
export default async function AccountClosedPage() {
  const locale = await deviceLocale();
  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-3xl font-bold tracking-tight text-ink">{t("closure.doneTitle", locale)}</h1>
        <p className="mt-2 text-lg text-ink-muted">{t("closure.doneBody", locale)}</p>
      </div>
    </PublicShell>
  );
}
