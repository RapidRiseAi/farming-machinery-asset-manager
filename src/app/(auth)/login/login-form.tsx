"use client";

import { signInWithPassword, signInWithMagicLink } from "./actions";
import { t } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";

export function LoginForm({ error, sent }: { error?: string; sent?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Flash tone="error" message={error} />
      <Flash tone="success" message={sent ? t("auth.checkEmail") : undefined} />

      <form action={signInWithPassword} className="flex flex-col gap-2.5">
        <Input name="email" type="email" required autoComplete="email" placeholder={t("auth.email")} />
        <Input name="password" type="password" required autoComplete="current-password" placeholder={t("auth.password")} />
        <SubmitButton variant="primary" fullWidth>{t("auth.signIn")}</SubmitButton>
      </form>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-sand-400">
        <span className="h-px flex-1 bg-sand-200" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-sand-200" />
      </div>

      <form action={signInWithMagicLink} className="flex flex-col gap-2.5">
        <Input name="email" type="email" required autoComplete="email" placeholder={t("auth.email")} />
        <SubmitButton variant="secondary" fullWidth>{t("auth.magicLink")}</SubmitButton>
      </form>
    </div>
  );
}
