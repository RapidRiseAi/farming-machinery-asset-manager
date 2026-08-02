"use client";

import { signInWithPassword, signInWithMagicLink } from "./actions";
import { t, type Locale } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";

export function LoginForm({
  error,
  sent,
  locale,
}: {
  error?: string;
  sent?: string;
  /** Device language (cookie → Accept-Language) — there is no profile yet. Audit bug 2. */
  locale: Locale;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Flash tone="error" message={error} />
      <Flash tone="success" message={sent ? t("auth.checkEmail", locale) : undefined} />

      <form action={signInWithPassword} className="flex flex-col gap-2.5">
        <Input name="email" type="email" required autoComplete="email" placeholder={t("auth.email", locale)} />
        <PasswordInput name="password" required autoComplete="current-password" placeholder={t("auth.password", locale)} revealLabel={t("auth.showPassword", locale)} />
        <SubmitButton variant="primary" fullWidth>{t("auth.signIn", locale)}</SubmitButton>
      </form>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-sand-400">
        <span className="h-px flex-1 bg-sand-200" />
        {t("auth.or", locale)}
        <span className="h-px flex-1 bg-sand-200" />
      </div>

      <form action={signInWithMagicLink} className="flex flex-col gap-2.5">
        <Input name="email" type="email" required autoComplete="email" placeholder={t("auth.email", locale)} />
        <SubmitButton variant="secondary" fullWidth>{t("auth.magicLink", locale)}</SubmitButton>
      </form>
    </div>
  );
}
