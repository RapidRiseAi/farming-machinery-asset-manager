"use client";

import { signInWithPassword, signInWithMagicLink } from "./actions";
import { t, type Locale } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
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

      {/* Real labels that stay put. These were placeholder-only — the question vanishes
          the moment you type, which hurts exactly the people this product is for. */}
      <form action={signInWithPassword} className="flex flex-col gap-3">
        <Field label={t("auth.email", locale)} htmlFor="signin-email">
          <Input id="signin-email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label={t("auth.password", locale)} htmlFor="signin-password">
          <PasswordInput id="signin-password" name="password" required autoComplete="current-password" revealLabel={t("auth.showPassword", locale)} />
        </Field>
        <SubmitButton variant="primary" fullWidth>{t("auth.signIn", locale)}</SubmitButton>
      </form>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-sand-400">
        <span className="h-px flex-1 bg-sand-200" />
        {t("auth.or", locale)}
        <span className="h-px flex-1 bg-sand-200" />
      </div>

      <form action={signInWithMagicLink} className="flex flex-col gap-3">
        <Field label={t("auth.email", locale)} htmlFor="link-email">
          <Input id="link-email" name="email" type="email" required autoComplete="email" />
        </Field>
        <SubmitButton variant="secondary" fullWidth>{t("auth.magicLink", locale)}</SubmitButton>
      </form>
    </div>
  );
}
