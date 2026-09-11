"use client";

import { signInWithPassword, signInWithMagicLink } from "./actions";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";

export function LoginForm({
  error,
  sent,
  locale,
  defaultEmail,
}: {
  error?: string;
  sent?: string;
  /** Device language (cookie → Accept-Language) — there is no profile yet. Audit bug 2. */
  locale: Lang;
  /**
   * Carried over from a sign-up whose automatic sign-in failed, or from somebody returning
   * to an address that already has an account. Retyping it is the difference between a
   * five-second recovery and giving up.
   */
  defaultEmail?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Flash tone="error" message={error} />
      <Flash tone="success" message={sent ? t("auth.checkEmail", locale) : undefined} />

      {/*
        ONE form, one email field, two ways in.

        This was two separate forms stacked with an "OR" between them, EACH with its own box
        labelled "Email" — so anyone who filled in the top one and then decided to use the
        link had to type their address again, on the very first screen of the product. Both
        server actions read `formData.get("email")`, so they are untouched: the second
        button just posts the same form to the other one via `formAction`.

        `password` is not `required` in HTML because it is irrelevant to the link path; the
        action checks it instead.

        Real labels that stay put, too. These were placeholder-only, and a placeholder
        vanishes the moment you type — which fails exactly the people this product is for.
      */}
      <form action={signInWithPassword} className="flex flex-col gap-4">
        <Field label={t("auth.email", locale)} htmlFor="signin-email">
          <Input
            id="signin-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={defaultEmail}
            placeholder="jy@jouplaas.co.za"
          />
        </Field>

        <Field label={t("auth.password", locale)} htmlFor="signin-password">
          <PasswordInput
            id="signin-password"
            name="password"
            autoComplete="current-password"
          />
        </Field>

        <SubmitButton fullWidth>{t("auth.signIn", locale)}</SubmitButton>

        <div className="flex items-center gap-3 py-1">
          <span className="h-px flex-1 bg-sand-200" />
          <span className="text-xs font-medium uppercase tracking-wide text-sand-500">
            {t("auth.or", locale)}
          </span>
          <span className="h-px flex-1 bg-sand-200" />
        </div>

        <SubmitButton variant="secondary" fullWidth formAction={signInWithMagicLink}>
          {t("auth.magicLink", locale)}
        </SubmitButton>

        {/* There was no "forgot password" anywhere in the product. The button above IS the
            recovery path — it signs you in without one — it just never said so, leaving a
            locked-out person with no obvious route back in. */}
        <p className="text-center text-sm leading-relaxed text-sand-600">
          {t("auth.forgotPassword", locale)}
        </p>
      </form>
    </div>
  );
}
