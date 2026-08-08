"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { relativeDate } from "@/lib/format";

export type EmailAttempt = {
  id: string;
  to_email: string;
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
};

/**
 * Email this document to the customer.
 *
 * A client component because the send is a fetch with a JSON reply, not a navigation —
 * the partner stays on the document and sees what happened. A server action would work
 * too, but the useful outcome here is "it went to this address" or "it bounced, and this
 * is why", and that reads better in place than as a flash after a redirect.
 *
 * The history underneath answers the question a partner actually asks the next day: did
 * it go, and where. Failures are shown with the provider's message, because a bounce that
 * nobody sees is worse than no send at all — the partner would go on believing the
 * customer had been told.
 */
export function EmailDocument({
  documentId,
  defaultTo,
  customerName,
  history,
  locale,
}: {
  documentId: string;
  defaultTo: string;
  customerName: string;
  history: EmailAttempt[];
  locale: Lang;
}) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function send() {
    setState("sending");
    setDetail(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, cc: cc || null, message: message || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; to?: string };
      if (res.ok) {
        setState("sent");
        setDetail(body.to ?? to);
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

  const lastSent = history.find((h) => h.status === "sent");

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("email.title", locale)}
          {lastSent ? (
            <Badge tone="ok" className="ml-2 align-middle">{t("email.sentBadge", locale)}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>

      {lastSent ? (
        <p className="mb-3 text-sm text-sand-600">
          {t("email.lastSent", locale)
            .replace("{to}", lastSent.to_email)
            .replace("{when}", relativeDate(lastSent.created_at, locale))}
        </p>
      ) : (
        <p className="mb-3 text-sm text-sand-600">
          {t("email.never", locale).replace("{name}", customerName)}
        </p>
      )}

      {!open ? (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {lastSent ? t("email.sendAgain", locale) : t("email.send", locale)}
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label={t("email.to", locale)} htmlFor="email-to">
            <Input
              id="email-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label={t("email.cc", locale)} hint={t("email.ccHint", locale)} htmlFor="email-cc">
            <Input id="email-cc" type="email" value={cc} onChange={(e) => setCc(e.target.value)} />
          </Field>
          <Field label={t("email.message", locale)} hint={t("email.messageHint", locale)} htmlFor="email-msg">
            <Textarea id="email-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={send} disabled={state === "sending" || !to}>
              {state === "sending" ? t("email.sending", locale) : t("email.sendNow", locale)}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel", locale)}
            </Button>
          </div>

          {state === "sent" ? (
            <p className="text-sm font-medium text-status-ok">
              {t("email.wentTo", locale).replace("{to}", detail ?? to)}
            </p>
          ) : null}
          {state === "error" ? (
            <p className="text-sm font-medium text-status-bad">{detail}</p>
          ) : null}
        </div>
      )}

      {history.length > 0 ? (
        <details className="mt-3 border-t border-sand-100 pt-3">
          <summary className="cursor-pointer text-sm font-medium text-sand-700">
            {t("email.history", locale).replace("{n}", String(history.length))}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sand-700">{h.to_email}</span>
                <span className={h.status === "sent" ? "text-sand-500" : "text-status-bad"}>
                  {h.status === "sent" ? relativeDate(h.created_at, locale) : (h.error ?? t("email.failed", locale))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
