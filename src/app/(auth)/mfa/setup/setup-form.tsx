"use client";

import { useState } from "react";

import { t, type Lang } from "@/lib/i18n";
import { cleanCode } from "@/lib/mfa";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { Photo } from "@/components/ui/photo";

type Enrolment = { id: string; qr: string; secret: string };

/**
 * Enrol an authenticator app in the browser (Supabase's own flow): start, scan, type one
 * code. An abandoned earlier attempt leaves an unverified factor behind, and Supabase caps
 * those, so each start clears them first.
 */
export function SetupForm({ next, locale }: { next: string; locale: Lang }) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(undefined);
    const supabase = createClient();
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const factor of list?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error: enrolError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `FleetWise ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    });
    setBusy(false);
    if (enrolError || !data || data.type !== "totp") {
      setError(t("mfa.startFailed", locale));
      return;
    }
    setEnrolment({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrolment) return;
    const code = cleanCode(String(new FormData(event.currentTarget).get("code") ?? ""));
    if (!code) {
      setError(t("mfa.notSixDigits", locale));
      return;
    }
    setBusy(true);
    setError(undefined);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId: enrolment.id, code });
    if (verifyError) {
      setBusy(false);
      setError(t("mfa.wrongCode", locale));
      return;
    }
    window.location.assign(next);
  }

  if (!enrolment) {
    return (
      <div className="flex flex-col gap-4">
        <Flash tone="error" message={error} clearParams={false} />
        <p className="text-sm text-sand-700">{t("mfa.step1", locale)}</p>
        <Button type="button" onClick={start} disabled={busy}>
          {t("mfa.start", locale)}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-4">
      <Flash tone="error" message={error} clearParams={false} />
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-sand-700">
        <li>{t("mfa.step1", locale)}</li>
        <li>{t("mfa.step2", locale)}</li>
        <li>{t("mfa.step3", locale)}</li>
      </ol>
      {/* White behind the code in either theme: a scanner reads dark on light. */}
      <Photo src={enrolment.qr} alt={t("mfa.qrAlt", locale)} size="card" priority className="mx-auto h-48 w-48 rounded-lg bg-white p-2" imgClassName="object-contain" />
      <p className="text-sm text-sand-700">
        {t("mfa.keyLabel", locale)}:{" "}
        <code className="break-all rounded bg-sand-100 px-1.5 py-0.5 font-mono text-sand-900">{enrolment.secret}</code>
      </p>
      <Field label={t("mfa.codeLabel", locale)} htmlFor="mfa-setup-code">
        <Input id="mfa-setup-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={9} required />
      </Field>
      <Button type="submit" disabled={busy}>
        {t("mfa.confirm", locale)}
      </Button>
    </form>
  );
}
