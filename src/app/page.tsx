import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { buttonVariants } from "@/components/ui/button";
import { MachinesIcon } from "@/components/ui/icons";

/**
 * The app's front door — and the installed app's `start_url`.
 *
 * This used to be an unconditional splash with a "Sign in to get started" button, which
 * is why the installed app looked like it demanded a login on every launch. The session
 * was never actually lost: the auth cookie is good for over a year and refreshes itself.
 * This entry screen simply never looked at it, so someone who signed in on Monday and
 * opened the app on Tuesday was shown a sign-in page with their live session sitting
 * right there in the cookie jar.
 *
 * Anyone carrying a session now goes straight through to their own home screen.
 *
 * The check is deliberately a COOKIE-PRESENCE test rather than `getUser()`:
 *   - it costs no network round-trip, so a farm on one bar of signal is not left
 *     staring at a splash screen while we wait on an auth server it may not reach;
 *   - it is not a security decision. `/home` re-checks properly, and RLS validates the
 *     JWT on every query — a stale or forged cookie earns a redirect to the login page,
 *     never data.
 */
export default async function HomePage() {
  const store = await cookies();
  // @supabase/ssr stores the session as `sb-<project-ref>-auth-token`, sometimes split
  // across `.0` / `.1` chunks when it outgrows a single cookie.
  const signedIn = store.getAll().some((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
  if (signedIn) redirect("/home");

  const locale = await deviceLocale();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-[1.8rem] text-white shadow-soft">
          <MachinesIcon />
        </span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-sand-900">{t("app.name", locale)}</h1>
          <p className="mt-2 text-lg text-sand-600">{t("app.tagline", locale)}</p>
        </div>
      </div>
      <Link href="/login" className={buttonVariants({ variant: "primary", size: "lg" })}>
        {t("auth.getStarted", locale)}
      </Link>
    </main>
  );
}
