import { redirect } from "next/navigation";

import { signOut } from "@/app/(app)/actions";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { createClient } from "@/lib/supabase/server";
import { PublicShell } from "@/components/public-shell";
import { SubmitButton } from "@/components/ui/submit-button";

export const dynamic = "force-dynamic";

/**
 * Where a test account with a Rapid Rise role lands (20261014120000). The database never
 * treats a test account as Rapid Rise, so rather than admin screens that would all come up
 * empty, this says so and how to reach the real admin account. Outside the app's layout,
 * like the two-step pages, so sending someone here can never loop.
 */
export default async function TestAccountPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const locale = await deviceLocale();

  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("testAccount.title", locale)}</h1>
        <p className="mt-1.5 text-sand-600">{t("testAccount.body", locale)}</p>
      </div>
      <form action={signOut} className="mt-6 text-center">
        <p className="text-xs text-sand-600">{t("gate.signedInAs", locale).replace("{email}", data.user.email ?? "-")}</p>
        <SubmitButton look="plain" className="mt-1 min-h-12 text-sm font-medium text-brand-ink underline sm:min-h-11">
          {t("gate.signOut", locale)}
        </SubmitButton>
      </form>
    </PublicShell>
  );
}
