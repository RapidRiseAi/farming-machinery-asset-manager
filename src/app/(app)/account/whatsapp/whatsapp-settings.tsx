"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogForm } from "@/components/ui/dialog-form";
import { Fact, FactList } from "@/components/ui/facts";

export type LinkStatus = { id: string; farmId: string; farmName: string; phone: string; notifications: boolean; assistant: boolean; expiresAt: string; assistantUntil: string };

export function WhatsAppSettings({ locale, status, enabled, farmName }: {
  locale: Lang; status: LinkStatus | null; enabled: boolean; farmName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [challenge, setChallenge] = useState<{ challengeId: string; url: string } | null>(null);
  async function submit(body: unknown) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/whatsapp/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) {
        setMessage(t(result.error === "not_verified" ? "whatsapp.notVerified" : "whatsapp.failed", locale));
        return;
      }
      if (result.challengeId) setChallenge(result);
      else { setChallenge(null); setMessage(t("whatsapp.saved", locale)); router.refresh(); }
    } catch { setMessage(t("whatsapp.failed", locale)); }
    finally { setBusy(false); }
  }
  return <Card>
    <CardHeader><CardTitle>{t("whatsapp.title", locale)}</CardTitle></CardHeader>
    <p className="text-sm text-sand-600">{enabled ? t("whatsapp.explainer", locale) : t("whatsapp.notConfigured", locale)}</p>
    {farmName ? <p className="my-3 text-sm font-medium">{t("whatsapp.selectedFarm", locale)}: {farmName}</p> : null}
    {status ? <>
      <FactList>
        <Fact label={t("whatsapp.linkedFarm", locale)} value={status.farmName} />
        <Fact label={t("whatsapp.phone", locale)} value={`+${status.phone}`} />
        <Fact label={t("whatsapp.notifications", locale)} value={t(status.notifications ? "whatsapp.on" : "whatsapp.off", locale)} />
        <Fact label={t("whatsapp.assistant", locale)} value={t(status.assistant ? "whatsapp.on" : "whatsapp.off", locale)} />
        <Fact label={t("whatsapp.expires", locale)} value={new Date(status.expiresAt).toLocaleString(locale.startsWith("af") ? "af-ZA" : "en-ZA", { timeZone: "Africa/Johannesburg" })} />
        {status.assistant ? <Fact label={t("whatsapp.assistantUntil", locale)} value={new Date(status.assistantUntil).toLocaleString(locale.startsWith("af") ? "af-ZA" : "en-ZA", { timeZone: "Africa/Johannesburg" })} /> : null}
      </FactList>
      <div className="my-4 flex flex-wrap gap-3">
        {status.assistant && enabled ? <Button disabled={busy} onClick={() => submit({ action: "authorize" })}>{t("whatsapp.authorize", locale)}</Button> : null}
        <Button variant="secondary" disabled={busy} onClick={() => submit({ action: "disconnect" })}>{t("whatsapp.disconnect", locale)}</Button>
      </div>
    </> : null}
    {enabled && farmName ? <DialogForm trigger={t(status ? "whatsapp.replace" : "whatsapp.connect", locale)} title={t("whatsapp.connect", locale)} closeLabel={t("ui.close", locale)}>
      <form className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void submit({ action: "begin", phone: data.get("phone"), notifications: data.get("notifications") === "on", assistant: data.get("assistant") === "on" });
      }}>
        <TextField label={t("whatsapp.phone", locale)} name="phone" type="tel" required placeholder="+27..." autoComplete="tel" />
        <Checkbox name="notifications" label={t("whatsapp.notificationsConsent", locale)} />
        <Checkbox name="assistant" label={t("whatsapp.assistantConsent", locale)} />
        <p className="text-sm text-sand-600">{t("whatsapp.privacy", locale)}</p>
        <Button type="submit" disabled={busy}>{t("whatsapp.begin", locale)}</Button>
        {challenge ? <div className="flex flex-col gap-3" aria-live="polite">
          <p>{t("whatsapp.verifyInstructions", locale)}</p>
          <a href={challenge.url} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline">{t("whatsapp.open", locale)}</a>
          <Button type="button" disabled={busy} onClick={() => submit({ action: "finish", challengeId: challenge.challengeId })}>{t("whatsapp.finish", locale)}</Button>
        </div> : null}
        {message ? <p role="status">{message}</p> : null}
      </form>
    </DialogForm> : null}
    <p className="mt-4 text-sm text-sand-600">{t("whatsapp.stop", locale)}</p>
    {message ? <p className="mt-3" role="status">{message}</p> : null}
  </Card>;
}
