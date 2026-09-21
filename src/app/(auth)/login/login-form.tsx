"use client";

import { signInWithPassword, signInWithMagicLink, sendPasswordReset } from "./actions";
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
  /** Device language (cookie, then Accept-Language). There is no profile yet. */
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
        ONE form, one email field, three ways forward.

        This was two separate forms stacked with an "OR" between them, EACH with its own box
        labelled "Email", so anyone who filled in the top one and then decided to use the
        link had to type their address again on the very first screen of the product. All
        three server actions read `formData.get("email")`, so they are untouched: the other
        two buttons post the same form to a different one via `formAction`.

        `password` is not `required` in HTML because it is irrelevant to the link path; the
        action checks it instead.

        Real labels that stay put, too. These were placeholder-only, and a placeholder
        vanishes the moment you type, which fails exactly the people this product is for.
      */}
      <form action={signInWithPassword} className="flex flex-col gap-4">
        <Field label={t("auth.email", locale)} htmlFor="signin-email">
          <Input
            id="signin-email"
            name="email"
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={defaultEmail}
          />
        </Field>

        {/*
          "Forgot?" sits on the password label row, which is where every other product on
          the internet puts it and therefore where people look. It used to be a sentence of
          explanation followed by an underlined button, two stacked blocks below the form,
          competing with the two real buttons above them.

          It is still a submit button posting this same form, so the address is typed once.
          `formNoValidate` because a reset needs the email and nothing else, and an empty
          password box must not block it.
        */}
        <Field
          label={t("auth.password", locale)}
          htmlFor="signin-password"
          labelAction={
            <button
              type="submit"
              formAction={sendPasswordReset}
              formNoValidate
              // Negative margins around real padding: the tappable box is 46px tall
              // without the label row growing to match. A 22px target is a miss on a
              // phone held in a work glove, and the probe measures it.
              className="focus-ring -mx-2 -my-3 rounded px-2 py-3 text-sm font-medium text-brand-ink underline underline-offset-2"
            >
              {t("auth.forgot", locale)}
            </button>
          }
        >
          <PasswordInput
            id="signin-password"
            name="password"
            autoComplete="current-password"
            revealLabel={t("auth.revealPassword", locale)}
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

        {/* The way in for somebody who has no password, or cannot remember one, and does
            not want to set a new one to read a job card. `formNoValidate` for the same
            reason as above: it needs the address only. */}
        <SubmitButton
          variant="secondary"
          fullWidth
          formAction={signInWithMagicLink}
          formNoValidate
        >
          {t("auth.magicLink", locale)}
        </SubmitButton>

        <p className="text-center text-sm leading-relaxed text-sand-500">
          {t("auth.magicLinkHint", locale)}
        </p>
      </form>
    </div>
  );
}
