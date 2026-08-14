"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import { Flash } from "@/components/ui/flash";
import { t, type Lang } from "@/lib/i18n";

/** Withdrawal-only control so consent stays revocable without assistant entitlement. */
export function AiConsentControl({ locale }: { locale: Lang }) {
  const [pending, setPending] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const statusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (withdrawn) statusRef.current?.focus();
  }, [withdrawn]);

  const withdraw = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/assistant/consent", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ allow: false }),
      });
      if (!response.ok) throw new Error("consent_withdraw_failed");
      setWithdrawn(true);
    } catch {
      setError(t("assistant.consentWithdrawFailed", locale));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (withdrawn) {
    return (
      <div ref={statusRef} tabIndex={-1}>
        <Flash tone="success" message={t("assistant.consentWithdrawn", locale)} />
      </div>
    );
  }

  return (
    <div>
      <CardTitle>{t("assistant.consentControlTitle", locale)}</CardTitle>
      <p className="mt-1 text-sm leading-6 text-sand-600">{t("assistant.consentControlBody", locale)}</p>
      {error ? <Flash className="mt-3" tone="error" message={error} /> : null}
      <Button className="mt-4" variant="secondary" loading={pending} onClick={() => void withdraw()}>
        {t("assistant.consentWithdraw", locale)}
      </Button>
    </div>
  );
}
