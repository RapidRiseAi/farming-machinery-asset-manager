import Link from "next/link";

import { t } from "@/lib/i18n";
import { APP_NAME } from "@/lib/env";
import { deviceLocale, isLocale } from "@/lib/locale";
import { PublicShell } from "@/components/public-shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { confirmSignIn } from "./actions";

/**
 * Where the button in an invite email lands.
 *
 * Opening this page does nothing but show a button. Mail scanners open every link in a
 * message to check it, and a link that signed in on GET would be spent by the scanner
 * before the person ever saw it (lib/email/invite.ts has the rest of that story).
 *
 * `lang` only chooses the words on this one page. It is never written to the language
 * cookie: `syncLocaleOnSignIn` reads that cookie as the person's own explicit choice.
 */
export const dynamic = "force-dynamic";

const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; farm?: string; lang?: string }>;
}) {
  const sp = await searchParams;
  const locale = isLocale(sp.lang) ? sp.lang : await deviceLocale();
  const token = typeof sp.token_hash === "string" && TOKEN_HASH.test(sp.token_hash) ? sp.token_hash : null;
  const app = (s: string) => s.replace("{app}", () => APP_NAME);

  return (
    <PublicShell locale={locale}>
      <div className="pt-4 sm:pt-10">
        <div className="rounded-2xl border border-sand-200 bg-surface p-6 shadow-xs">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{app(t("authConfirm.title", locale))}</h1>
          <p className="mt-2 text-sand-700">{t(token ? "authConfirm.body" : "authConfirm.broken", locale)}</p>
          {token ? (
            <form action={confirmSignIn} className="mt-6">
              <input type="hidden" name="token_hash" value={token} />
              <input type="hidden" name="farm" value={typeof sp.farm === "string" ? sp.farm : ""} />
              <SubmitButton size="lg" fullWidth pendingText={t("authConfirm.pending", locale)}>
                {app(t("authConfirm.button", locale))}
              </SubmitButton>
            </form>
          ) : (
            <Link
              href="/login"
              className={`mt-6 ${buttonVariants({ variant: "primary", size: "lg", fullWidth: true })}`}
            >
              {t("authConfirm.toLogin", locale)}
            </Link>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
