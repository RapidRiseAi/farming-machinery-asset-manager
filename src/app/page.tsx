import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { rands } from "@/lib/money";
import { PLANS, perVehicleMonthlyCents } from "@/lib/entitlements";
import { PublicShell, SITE_GUTTER, Tick } from "@/components/public-shell";
import { ArrowRightIcon, ArrowUpRightIcon, CalendarIcon, CashIcon, DeviceIcon } from "@/components/ui/icons";

/** Each claim's icon, in the website's green square. */
const POINT_ICON = { due: <CalendarIcon />, costs: <CashIcon />, offline: <DeviceIcon /> } as const;

/**
 * The app's front door, and the installed app's `start_url`.
 *
 * == The session check, which is load-bearing and stays =======================
 * This used to be an unconditional splash with a "Sign in to get started" button, which is
 * why the installed app looked like it demanded a login on every launch. The session was
 * never lost: the auth cookie is good for over a year and refreshes itself; this screen
 * simply never looked at it. Anyone carrying one goes straight to their own home.
 *
 * It is deliberately a COOKIE-PRESENCE test rather than `getUser()`: it costs no network
 * round trip, so a farm on one bar of signal is not left staring at a splash while we wait
 * on an auth server it may not reach, and it is not a security decision. `/home` re-checks
 * properly and RLS validates the JWT on every query, so a stale or forged cookie earns a
 * redirect, never data.
 *
 * == What changed =============================================================
 * For everybody else this was a logo, a tagline and one button that said "Get started",
 * which went to SIGN IN, so a new visitor's only offered path was a form asking for
 * credentials they do not have, and somebody returning had to guess that "get started"
 * meant "sign in". Now it says what the product does, and offers the two things a person
 * actually wants: come in, or start.
 *
 * The price is real and read from the same catalogue the invoice is priced from, because a
 * landing page quoting a figure the checkout contradicts is worse than quoting none.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  // A sign-in link whose return address Supabase would not accept lands HERE, on its Site
  // URL, carrying the one-time code. Nothing on this page reads it, so the person arrived
  // signed out (5 November). Hand it to the callback, which knows what to do with it.
  const { code } = await searchParams;
  if (code) redirect(`/auth/callback?code=${encodeURIComponent(code)}`);

  const store = await cookies();
  // @supabase/ssr stores the session as `sb-<project-ref>-auth-token`, sometimes split
  // across `.0` / `.1` chunks when it outgrows a single cookie.
  const signedIn = store.getAll().some((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
  if (signedIn) redirect("/home");

  const locale = await deviceLocale();

  // The cheapest plan that is actually on sale. Not hard-coded: `entitlements.ts` is the
  // same source the sign-up page and the invoice both price from.
  const cheapest = PLANS
    .map((p) => perVehicleMonthlyCents(p, "monthly"))
    .filter((c): c is number => typeof c === "number")
    .sort((a, b) => a - b)[0];

  const points = ["due", "costs", "offline"] as const;

  return (
    <PublicShell locale={locale} width="full">
      {/* == The website's hero: the same photograph, headline and buttons ========== */}
      <section className="relative isolate overflow-hidden bg-brand-950">
        {/* hero.jpg, "Tractor and baler at sunset" by Jed Owen, Unsplash licence, the
            website's own hero (fleetwise-website docs/ASSETS.md). Atmosphere only. */}
        <Image src="/images/hero.jpg" alt="" fill priority sizes="100vw" className="-z-20 object-cover object-[70%_center]" />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-b from-brand-950/95 via-brand-950/85 to-brand-950/70 lg:bg-gradient-to-r lg:from-brand-950 lg:via-brand-950/85 lg:to-brand-950/10"
        />
        <div className={`${SITE_GUTTER} pb-24 pt-14 lg:pb-32 lg:pt-24`}>
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent">{t("landing.eyebrow", locale)}</p>
            <h1 className="mt-5 text-4xl font-bold leading-[1.04] tracking-[-0.04em] text-white sm:text-5xl xl:text-6xl">
              {t("auth.heroTitle", locale)}
              <span className="block text-accent">{t("auth.heroAccent", locale)}</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/90">{t("landing.sub", locale)}</p>

            {/* Two paths, and the screen says which is which. The old page offered one button
                labelled "Get started" that went to sign IN. */}
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="focus-ring inline-flex min-h-[52px] items-center justify-between gap-4 rounded-md bg-gold-500 px-5 text-sm font-bold text-accent-on-fill transition hover:bg-gold-400 sm:justify-center"
              >
                {t("landing.start", locale)}
                <ArrowUpRightIcon className="text-base" />
              </Link>
              <Link
                href="/login"
                className="focus-ring inline-flex min-h-[52px] items-center justify-between gap-4 rounded-md border-2 border-white px-5 text-sm font-bold text-white transition hover:bg-white/10 sm:justify-center"
              >
                {t("landing.signIn", locale)}
                <ArrowRightIcon className="text-base" />
              </Link>
            </div>

            {cheapest ? (
              <p className="mt-6 flex items-center gap-2 text-sm text-white/85">
                <Tick className="text-accent" />
                {t("landing.priceFrom", locale).replace("{price}", rands(cheapest))}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* == What it does: the website's white strip with a gold top rule ============= */}
      <section className={`relative -mt-12 ${SITE_GUTTER}`}>
        <h2 className="sr-only">{t("landing.headline", locale)}</h2>
        <div className="grid border-t-4 border-gold-500 bg-surface shadow-soft sm:grid-cols-3">
          {points.map((k, i) => (
            <div key={k} className={`p-6 sm:p-7 ${i > 0 ? "border-t border-edge-soft sm:border-l sm:border-t-0" : ""}`}>
              <span aria-hidden="true" className="grid size-11 place-items-center bg-brand-600 text-xl text-white">
                {POINT_ICON[k]}
              </span>
              <h3 className="mt-4 text-lg font-bold text-ink">{t(`landing.point.${k}.title`, locale)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{t(`landing.point.${k}.body`, locale)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* == The three things a person worries about before paying =========== */}
      <section className={`${SITE_GUTTER} py-14`}>
        <ul className="grid gap-4 sm:grid-cols-3">
          {(["cancel", "card", "data"] as const).map((k) => (
            <li key={k} className="flex items-start gap-3 text-base text-ink">
              <Tick className="mt-0.5 text-status-ok" />
              <span>{t(`landing.trust.${k}`, locale)}</span>
            </li>
          ))}
        </ul>

        {/* The workforce this is built for often has no work email at all. Saying so here,
            not only on the sign-in screen, stops a driver concluding the product is not for
            them before they ever reach a login box. */}
        <p className="mt-10 max-w-3xl border-l-4 border-gold-500 bg-surface p-5 text-base leading-relaxed text-ink-muted shadow-xs">
          {t("landing.drivers", locale)}
        </p>
      </section>
    </PublicShell>
  );
}
