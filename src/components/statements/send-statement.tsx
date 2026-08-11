"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

/**
 * Send this statement to the customer.
 *
 * Sits beside the PDF and spreadsheet buttons rather than in a card of its own: the three
 * are the same decision — what do I do with this statement — and separating the one that
 * matters most for a monthly account would be odd.
 *
 * A client component because the useful outcome is "it went to this address" or "it
 * bounced, and this is why", which reads better in place than as a flash after a redirect.
 */
export function SendStatement({
  party,
  from,
  to,
  defaultEmail,
  locale,
}: {
  party: string;
  from: string;
  to: string;
  defaultEmail: string;
  locale: Lang;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function send() {
    setState("sending");
    setDetail(null);
    try {
      const res = await fetch("/api/statements/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ party, from, to, email, message: message || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; to?: string };
      if (res.ok) {
        setState("sent");
        setDetail(body.to ?? email);
      } else {
        setState("error");
        setDetail(
          body.error === "email-not-configured"
            ? t("email.notConfigured", locale)
            : body.error === "no-address"
              ? t("email.badAddress", locale)
              : (body.error ?? t("email.failed", locale)),
        );
      }
    } catch {
      setState("error");
      setDetail(t("email.failed", locale));
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="primary" size="sm" onClick={() => setOpen(true)}>
        {t("statement.send", locale)}
      </Button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-sand-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:max-w-md">
        <Field label={t("email.to", locale)} htmlFor="stmt-email">
          <Input
            id="stmt-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label={t("email.message", locale)} hint={t("statement.sendHint", locale)} htmlFor="stmt-msg">
          <Textarea id="stmt-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={send} disabled={state === "sending" || !email}>
            {state === "sending" ? t("email.sending", locale) : t("statement.sendNow", locale)}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel", locale)}
          </Button>
        </div>
        {state === "sent" ? (
          <p className="text-sm font-medium text-status-ok">
            {t("email.wentTo", locale).replace("{to}", detail ?? email)}
          </p>
        ) : null}
        {state === "error" ? <p className="text-sm font-medium text-status-bad">{detail}</p> : null}
      </div>
    </div>
  );
}
