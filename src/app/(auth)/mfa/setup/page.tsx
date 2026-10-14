import Link from "next/link";
import { redirect } from "next/navigation";

import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { readAssurance } from "@/lib/mfa";
import { safePath } from "@/lib/safe-path";
import { createClient } from "@/lib/supabase/server";
import { PublicShell } from "@/components/public-shell";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

/**
 * Setting up two-step sign-in (B9): scan a QR code into an authenticator app, then type one
 * code to prove it works. Required for Rapid Rise staff (the app's layout sends them here
 * until it is done) and offered to everyone from the account page. Outside the app's layout
 * so that sending someone here can never loop.
 */
export default async function MfaSetupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = safePath(sp.next ?? "", "/home");
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?next=${encodeURIComponent("/mfa/setup")}`);
  const assurance = await readAssurance(supabase);
  // A code already set up but not given this session: give it first.
  if (assurance.next === "aal2" && assurance.current !== "aal2") {
    redirect(`/mfa/verify?next=${encodeURIComponent(`/mfa/setup?next=${encodeURIComponent(next)}`)}`);
  }
  const alreadyOn = assurance.next === "aal2";
  const { data: profile } = await supabase.from("users").select("role").eq("id", data.user.id).maybeSingle();
  const required = (profile as { role?: string } | null)?.role === "rr_admin";

  const locale = await deviceLocale();
  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("mfa.setupTitle", locale)}</h1>
        <p className="mt-1.5 text-sand-600">{t(required ? "mfa.setupRequired" : "mfa.setupBody", locale)}</p>
      </div>
      <div className="mt-5 rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
        {alreadyOn ? (
          <div className="flex flex-col gap-4">
            <p className="text-sand-800">{t("mfa.alreadyOn", locale)}</p>
            <Link href="/account" className="focus-ring inline-flex min-h-[48px] items-center rounded text-sm underline">
              {t("mfa.backToAccount", locale)}
            </Link>
          </div>
        ) : (
          <SetupForm next={next} locale={locale} />
        )}
      </div>
    </PublicShell>
  );
}
