"use client";

import { useRef, useState } from "react";

import { reportClientError } from "@/lib/client-report";
import { t, type Lang } from "@/lib/i18n";
import { cleanCode } from "@/lib/mfa";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { asError } from "@/lib/single-flight";

/**
 * The code, checked against the person's authenticator factor in the browser (Supabase's
 * own flow). A full page load follows success so the server reads the upgraded session.
 */
export function VerifyForm({ next, locale }: { next: string; locale: Lang }) {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // One check at a time: a second Enter while the first is out would spend the same code
  // twice and report the second as wrong. Held on success too, while the page leaves.
  const checking = useRef(false);

  const release = () => {
    checking.current = false;
    setBusy(false);
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checking.current) return;
    const code = cleanCode(String(new FormData(event.currentTarget).get("code") ?? ""));
    if (!code) {
      setError(t("mfa.notSixDigits", locale));
      return;
    }
    checking.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const supabase = createClient();
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      // Not knowing the factors is a failure, not "none": moving on would only bounce
      // the person back here without a word.
      if (listError) throw listError;
      const factor = (factors?.totp ?? []).find((f) => f.status === "verified");
      if (!factor) {
        window.location.assign(next);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (verifyError) {
        release();
        setError(t("mfa.wrongCode", locale));
        return;
      }
      window.location.assign(next);
    } catch (failure) {
      // No signal or the auth service down: say so, and give the button back.
      reportClientError(asError(failure), "mfa:verify");
      release();
      setError(t("interaction.actionFailed", locale));
    }
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
