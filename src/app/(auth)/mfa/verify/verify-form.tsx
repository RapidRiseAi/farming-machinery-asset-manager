"use client";

import { useState } from "react";

import { t, type Lang } from "@/lib/i18n";
import { cleanCode } from "@/lib/mfa";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";

/**
 * The code, checked against the person's authenticator factor in the browser (Supabase's
 * own flow). A full page load follows success so the server reads the upgraded session.
 */
export function VerifyForm({ next, locale }: { next: string; locale: Lang }) {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = cleanCode(String(new FormData(event.currentTarget).get("code") ?? ""));
    if (!code) {
      setError(t("mfa.notSixDigits", locale));
      return;
    }
    setBusy(true);
    setError(undefined);
    const supabase = createClient();
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = (factors?.totp ?? []).find((f) => f.status === "verified");
    if (!factor) {
      window.location.assign(next);
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (verifyError) {
      setBusy(false);
      setError(t("mfa.wrongCode", locale));
      return;
    }
    window.location.assign(next);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Flash tone="error" message={error} clearParams={false} />
      <Field label={t("mfa.codeLabel", locale)} htmlFor="mfa-code">
        <Input
          id="mfa-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          autoFocus
          required
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {t("mfa.verifyButton", locale)}
      </Button>
    </form>
  );
}
