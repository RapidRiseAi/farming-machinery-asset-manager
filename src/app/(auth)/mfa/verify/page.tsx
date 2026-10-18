import { redirect } from "next/navigation";

import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { readAssurance } from "@/lib/mfa";
import { safePath } from "@/lib/safe-path";
import { createClient } from "@/lib/supabase/server";
import { PublicShell } from "@/components/public-shell";
import { signOut } from "@/app/(app)/actions";
import { VerifyForm } from "./verify-form";
import { SubmitButton } from "@/components/ui/submit-button";

export const dynamic = "force-dynamic";

/**
 * The second step of signing in (B9): the six-digit code from the person's authenticator
 * app, asked for whenever a session has only the password behind it and the person has set
 * a code up. Outside the app's layout on purpose, as the layout is what sends people here.
 */
export default async function MfaVerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = safePath(sp.next ?? "", "/home");
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?next=${encodeURIComponent(next)}`);
  const assurance = await readAssurance(supabase);
  // Nothing to give (no code set up) or already given: carry on.
  if (assurance.current === "aal2" || assurance.next !== "aal2") redirect(next);

  const locale = await deviceLocale();
  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("mfa.verifyTitle", locale)}</h1>
        <p className="mt-1.5 text-sand-600">{t("mfa.verifyBody", locale)}</p>
      </div>
      <div className="mt-5 rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
        <VerifyForm next={next} locale={locale} />
      </div>
      <form action={signOut} className="mt-4 text-center">
        <SubmitButton look="plain" className="focus-ring inline-flex min-h-[48px] items-center rounded px-3 text-sm text-sand-600 underline">
          {t("mfa.otherAccount", locale)}
        </SubmitButton>
      </form>
    </PublicShell>
  );
}
