import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { rands } from "@/lib/money";
import { PLANS, perVehicleMonthlyCents } from "@/lib/entitlements";
import { PublicShell, Tick } from "@/components/public-shell";

/**
 * The app's front door — and the installed app's `start_url`.
 *
 * ── The session check, which is load-bearing and stays ───────────────────────
 * This used to be an unconditional splash with a "Sign in to get started" button, which is
 * why the installed app looked like it demanded a login on every launch. The session was
 * never lost: the auth cookie is good for over a year and refreshes itself; this screen
 * simply never looked at it. Anyone carrying one goes straight to their own home.
 *
 * It is deliberately a COOKIE-PRESENCE test rather than `getUser()`: it costs no network
 * round trip, so a farm on one bar of signal is not left staring at a splash while we wait
 * on an auth server it may not reach — and it is not a security decision. `/home` re-checks
 * properly and RLS validates the JWT on every query, so a stale or forged cookie earns a
 * redirect, never data.
 *
 * ── What changed ─────────────────────────────────────────────────────────────
 * For everybody else this was a logo, a tagline and one button that said "Get started",
 * which went to SIGN IN — so a new visitor's only offered path was a form asking for
 * credentials they do not have, and somebody returning had to guess that "get started"
 * meant "sign in". Now it says what the product does, and offers the two things a person
 * actually wants: come in, or start.
 *
 * The price is real and read from the same catalogue the invoice is priced from, because a
 * landing page quoting a figure the checkout contradicts is worse than quoting none.
 */
export default async function LandingPage() {
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
    <PublicShell locale={locale} width="wide">
      {/* ── What this is ──────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-2xl pt-6 text-center sm:pt-12">
        <h1 className="text-3xl font-bold tracking-tight text-sand-900 sm:text-4xl">
          {t("landing.headline", locale)}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-sand-600">
          {t("landing.sub", locale)}
        </p>

        {/* Two paths, and the screen says which is which. The old page offered one button
            labelled "Get started" that went to sign IN. */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/signup"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-600 px-6 text-base font-semibold text-white shadow-soft transition hover:bg-brand-700 sm:min-h-11"
          >
            {t("landing.start", locale)}
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-sand-300 bg-surface px-6 text-base font-semibold text-sand-900 transition hover:bg-sand-100 sm:min-h-11"
          >
            {t("landing.signIn", locale)}
          </Link>
        </div>

        {cheapest ? (
          <p className="mt-4 text-sm text-sand-600">
            {t("landing.priceFrom", locale).replace("{price}", rands(cheapest))}
          </p>
        ) : null}
      </section>

      {/* ── What it does, in three concrete claims ────────────────────────── */}
      <section className="mx-auto mt-12 grid max-w-4xl gap-4 sm:mt-16 sm:grid-cols-3">
        {points.map((k) => (
          <div key={k} className="rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs">
            <span className="flex size-9 items-center justify-center rounded-lg bg-brand-50 text-brand-ink">
              <Tick />
            </span>
            <h2 className="mt-3 font-semibold text-sand-900">
              {t(`landing.point.${k}.title`, locale)}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-sand-600">
              {t(`landing.point.${k}.body`, locale)}
            </p>
          </div>
        ))}
      </section>

      {/* ── The three things a person worries about before paying ─────────── */}
      <section className="mx-auto mt-10 max-w-3xl rounded-2xl border border-sand-200 bg-surface p-5 sm:mt-12">
        <ul className="grid gap-3 sm:grid-cols-3">
          {(["cancel", "card", "data"] as const).map((k) => (
            <li key={k} className="flex items-start gap-2.5 text-sm text-sand-700">
              <Tick className="mt-0.5 text-status-ok" />
              <span>{t(`landing.trust.${k}`, locale)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* The workforce this is built for often has no work email at all. Saying so here,
          not only on the sign-in screen, stops a driver concluding the product is not for
          them before they ever reach a login box. */}
      <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-sand-600">
        {t("landing.drivers", locale)}
      </p>
    </PublicShell>
  );
}
