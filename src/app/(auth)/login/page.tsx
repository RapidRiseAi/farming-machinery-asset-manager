import Link from "next/link";

import { LoginForm } from "./login-form";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { PublicShell } from "@/components/public-shell";

/**
 * Sign in.
 *
 * ── What it looked like before ───────────────────────────────────────────────
 * Two stacked forms each asking for an email address, a card with no background (it used
 * `bg-surface`, a token defined in no committed config, so Tailwind emitted nothing for
 * it), no route back to the landing page, and nothing at all rendered for `?signedup=1` —
 * which is where the sign-up form sends somebody when the automatic sign-in after creating
 * their farm fails. That last one is the reported bug: you fill in the sign-up form, press
 * "Continue to payment", and land on a bare sign-in screen that says nothing, having in
 * fact just had a farm and an invoice created for you.
 *
 * ── The three messages, and why they are separate ────────────────────────────
 * `signedup` is a SUCCESS: everything the person cares about worked and only the session is
 * missing. `resume` is somebody coming back to an address that already has an account.
 * `error` is a genuine failure. Folding them together would tell two out of three people
 * something untrue on a screen where they are already unsure whether they have been
 * charged.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    sent?: string;
    resume?: string;
    /** Sign-up worked but the automatic sign-in did not. See signup/actions.ts. */
    signedup?: string;
    /** Carried by `resume` and `signedup` so the address does not have to be retyped. */
    email?: string;
    /** A password-reset email has been sent — or would have been, if the address exists. */
    reset?: string;
  }>;
}) {
  const sp = await searchParams;
  // Pre-auth there is no profile to read a language from, so the device decides:
  // an explicit choice (cookie) → the phone's Accept-Language → English. Audit bug 2.
  const locale = await deviceLocale();

  /*
    Supabase's own wording used to reach the screen — and the address bar — verbatim:
    "?error=Invalid+login+credentials". The redirect still carries the raw message
    (the server action is unchanged); this translates the ones we recognise into a sentence
    a person can act on, and falls back to something plain for the rest.
  */
  const raw = (sp.error ?? "").toLowerCase();
  const errorMessage = !sp.error
    ? undefined
    : // `no-profile` is what the guards append when nobody is signed in yet. That is not an
      // error the visitor made — showing them "that didn't work" on the login screen they
      // were simply sent to is the same leak in a different costume.
      raw === "no-profile"
      ? undefined
      : raw === "auth"
        ? t("auth.errLinkExpired", locale)
        : raw === "need-email"
          ? t("auth.errNeedEmail", locale)
          : raw === "need-password"
            ? t("auth.errNeedPassword", locale)
            : raw.includes("invalid login") || raw.includes("invalid credentials")
              ? t("auth.errInvalid", locale)
              : raw.includes("not confirmed")
                ? t("auth.errNotConfirmed", locale)
                : raw.includes("rate limit") || raw.includes("too many")
                  ? t("auth.errRate", locale)
                  : t("auth.errGeneric", locale);

  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {t("auth.signInTitle", locale)}
        </h1>
        <p className="mt-1.5 text-sand-600">{t("auth.welcomeSub", locale)}</p>
      </div>

      {/* Everything they care about DID work — the farm, the owner, the subscription and
          the invoice are all committed; only the session is missing. So this is a success
          message, and it is the one thing that was missing when somebody hit this path. */}
      {sp.signedup ? (
        <p className="mt-5 rounded-xl border border-status-ok/30 bg-status-ok/10 p-4 text-sm leading-relaxed text-sand-800">
          {t("auth.signedUp", locale)}
        </p>
      ) : null}

      {/* Worded so it is true whether or not that address has an account: saying "no
          account with that address" on a reset form tells a stranger which addresses exist. */}
      {sp.reset ? (
        <p className="mt-5 rounded-xl border border-sand-200 bg-surface p-4 text-sm leading-relaxed text-sand-700">
          {t("auth.resetSent", locale)}
        </p>
      ) : null}

      {sp.resume ? (
        <p className="mt-5 rounded-xl border border-sand-200 bg-surface p-4 text-sm leading-relaxed text-sand-700">
          {t("auth.resume", locale)}
        </p>
      ) : null}

      <div className="mt-5 rounded-2xl border border-sand-200 bg-surface p-5 shadow-xs sm:p-6">
        <LoginForm
          error={errorMessage}
          sent={sp.sent}
          locale={locale}
          defaultEmail={sp.email}
        />
      </div>

      {/* Much of the workforce this is built for has no work email — they use the QR
          stickers, which need no login at all. The login screen never said so, so drivers
          got stuck at the door. */}
      <div className="mt-4 rounded-2xl border border-sand-200 bg-sand-100 p-4">
        <p className="font-semibold text-sand-900">{t("auth.noEmailTitle", locale)}</p>
        <p className="mt-1 text-sm leading-relaxed text-sand-600">
          {t("auth.noEmailBody", locale)}
        </p>
      </div>

      <p className="mt-6 text-center text-sm text-sand-600">
        {t("auth.noAccount", locale)}{" "}
        <Link href="/signup" className="font-semibold text-brand-ink underline">
          {t("auth.startTrial", locale)}
        </Link>
      </p>
    </PublicShell>
  );
}
