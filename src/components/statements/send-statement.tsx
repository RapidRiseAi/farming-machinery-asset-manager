"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogFields, useDialogForm } from "@/components/ui/dialog-form";
import { SendIcon } from "@/components/ui/icons";

/**
 * Emailing the statement to the customer, the last step of the monthly-account workflow.
 *
 * It used to unfold its two fields into the page header, between the download buttons,
 * which pushed the whole statement down and looked like part of the header. Now it is a
 * dialog like every other capture here. It posts with `fetch` rather than a server action
 * because the result (sent to which address, or why not) is shown in the dialog itself:
 * the reader stays on the statement they are looking at, and a failure reads next to the
 * address that caused it.
 *
 * The fields live in `SendFields`, inside the dialog, so they mount fresh each time: a
 * second statement does not open on the first one's "sent" line.
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
  return (
    <DialogForm
      trigger={t("statement.send", locale)}
      triggerIcon={<SendIcon />}
      triggerSize="sm"
      title={t("statement.send", locale)}
      closeLabel={t("ui.close", locale)}
    >
      <SendFields party={party} from={from} to={to} defaultEmail={defaultEmail} locale={locale} />
    </DialogForm>
  );
}

function SendFields({
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
  const { close } = useDialogForm();
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <DialogFields columns={1}>
        <Field label={t("email.to", locale)} htmlFor="stmt-email">
          <Input
            id="stmt-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </Field>
        <Field label={t("email.message", locale)} hint={t("statement.sendHint", locale)} htmlFor="stmt-msg">
          <Textarea id="stmt-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <div aria-live="polite">
          {state === "sent" ? (
            <p className="text-sm font-medium text-status-ok">
              {t("email.wentTo", locale).replace("{to}", detail ?? email)}
            </p>
          ) : null}
          {state === "error" ? <p className="text-sm font-medium text-status-overdue">{detail}</p> : null}
        </div>
      </DialogFields>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          {state === "sent" ? t("ui.close", locale) : t("common.cancel", locale)}
        </Button>
        {state === "sent" ? null : (
          <Button type="submit" disabled={state === "sending" || !email}>
            {state === "sending" ? t("email.sending", locale) : t("statement.sendNow", locale)}
          </Button>
        )}
      </div>
    </form>
  );
}
