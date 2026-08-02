import { LoginForm } from "./login-form";
import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { MachinesIcon } from "@/components/ui/icons";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  // Pre-auth there is no profile to read a language from, so the device decides:
  // an explicit choice (cookie) → the phone's Accept-Language → English. Audit bug 2.
  const locale = await deviceLocale();

  /*
    Supabase's own wording used to reach the screen — and the address bar — verbatim:
    "?error=Invalid+login+credentials". The redirect still carries the raw message
    (unchanged server action); this just translates the ones we recognise into a
    sentence a person can act on, and falls back to something plain for the rest.
  */
  const raw = (sp.error ?? "").toLowerCase();
  const errorMessage = !sp.error
    ? undefined
    : raw.includes("invalid login") || raw.includes("invalid credentials")
      ? t("auth.errInvalid", locale)
      : raw.includes("not confirmed")
        ? t("auth.errNotConfirmed", locale)
        : raw.includes("rate limit") || raw.includes("too many")
          ? t("auth.errRate", locale)
          : t("auth.errGeneric", locale);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-[1.8rem] text-white shadow-soft">
          <MachinesIcon />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-sand-500">{t("auth.welcomeSub", locale)}</p>
        </div>
      </div>
      <LoginForm error={errorMessage} sent={sp.sent} locale={locale} />
      {/* Much of the workforce this is built for has no work email — they use the QR
          stickers, which need no login at all. The login screen never said so, so
          drivers got stuck at the door. */}
      <div className="rounded-xl border border-sand-200 bg-white p-4">
        <p className="font-semibold text-sand-900">{t("auth.noEmailTitle", locale)}</p>
        <p className="mt-1 text-sm leading-relaxed text-sand-600">{t("auth.noEmailBody", locale)}</p>
      </div>

      <div className="flex justify-center">
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </div>
    </main>
  );
}
