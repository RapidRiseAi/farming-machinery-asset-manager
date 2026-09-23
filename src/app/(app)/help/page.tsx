import Link from "next/link";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { COMPANY } from "@/lib/legal";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { PageInfoButton } from "@/components/ui/page-info-button";

import { askForHelp } from "./actions";

export const dynamic = "force-dynamic";

type HelpRequest = {
  id: string;
  subject: string;
  status: "open" | "waiting" | "resolved" | "closed";
  created_at: string;
  resolved_at: string | null;
};

const STATUS_LOOK: Record<HelpRequest["status"], { tone: BadgeTone; key: string }> = {
  open: { tone: "brand", key: "help.statusOpen" },
  waiting: { tone: "warning", key: "help.statusWaiting" },
  resolved: { tone: "ok", key: "help.statusResolved" },
  closed: { tone: "neutral", key: "help.statusClosed" },
};

/**
 * Asking us for help without leaving the product.
 *
 * == What it replaces =========================================================
 * An email address printed on `/billing`. A farmer with a problem had to leave FleetWise,
 * open a mail client, and describe from memory which screen they were on and what plan
 * they are on. Most will not bother, and the ones who do describe it wrongly, so the first
 * reply is always a request for context the product already had.
 *
 * == Anybody signed in may ask ================================================
 * Including a driver. Somebody stuck on a checklist screen is exactly who this is for, and
 * making them find the owner first is how the question never gets asked at all.
 *
 * == What is attached =========================================================
 * The farm, its plan, who asked, and the screen they came from. NOT the billing dossier
 * that `app.support_ticket_evidence` builds for disputes: attaching a card's last four and
 * an attempt history to "the QR code will not scan" would put them in a support queue for
 * no reason.
 *
 * == Their own list, from a function ==========================================
 * `support_tickets` also holds disputes, so the farm reads its questions through
 * `my_help_requests()`, which returns four columns and no evidence at all rather than a
 * widened policy on a table full of billing cases.
 */
export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; from?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.rpc("my_help_requests");
  const requests = (data as HelpRequest[] | null) ?? [];
  const openCount = requests.filter((r) => r.status === "open" || r.status === "waiting").length;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
            {t("help.title", locale)}
          </h1>
          <PageInfoButton infoKey="help" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-600">{t("help.lead", locale)}</p>
      </div>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t("help.sent", locale) : undefined} />

      <Card>
        <CardHeader>
          <CardTitle>{t("help.askTitle", locale)}</CardTitle>
        </CardHeader>
        <form action={askForHelp} className="flex flex-col gap-3">
          {/* Where they came from, so the first reply is not "which screen were you on".
              Validated as a relative path in the action, and the database keeps only three
              named keys whatever this posts. */}
          <input type="hidden" name="path" value={sp.from ?? "/help"} />
          <Field
            label={t("help.subject", locale)}
            htmlFor="help-subject"
            hint={t("help.subjectHint", locale)}
            required
          >
            <Input id="help-subject" name="subject" required maxLength={200} />
          </Field>
          <Field
            label={t("help.message", locale)}
            htmlFor="help-message"
            hint={t("help.messageHint", locale)}
            required
          >
            <Textarea id="help-message" name="message" required rows={6} maxLength={4000} />
          </Field>
          <div>
            <SubmitButton variant="primary">{t("help.send", locale)}</SubmitButton>
          </div>
          <p className="text-xs text-sand-500">{t("help.attachNote", locale)}</p>
        </form>
      </Card>

      {requests.length > 0 ? (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("help.yoursTitle", locale)}</CardTitle>
          </div>
          <ul className="divide-y divide-sand-200">
            {requests.map((r) => {
              const look = STATUS_LOOK[r.status];
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 p-4 sm:p-5">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{r.subject}</p>
                    <p className="mt-0.5 text-xs text-sand-500">
                      {t("help.askedOn", locale).replace("{when}", dateTime(r.created_at, locale))}
                    </p>
                  </div>
                  <Badge tone={look.tone}>{t(look.key, locale)}</Badge>
                </li>
              );
            })}
          </ul>
          {openCount >= 5 ? (
            <p className="border-t border-sand-200 p-4 text-sm text-sand-600 sm:p-5">
              {t("help.atLimit", locale)}
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Email stays, for anybody who would rather, and for anybody who cannot sign in at
          all. Taking it away would make a locked-out customer worse off, which is the one
          group a support form cannot serve. */}
      <p className="text-sm text-sand-600">
        {t("help.orEmail", locale)}{" "}
        <a href={`mailto:${COMPANY.email}`} className="font-medium text-brand-ink underline">
          {COMPANY.email}
        </a>
      </p>

      <p className="text-sm text-sand-600">
        <Link href="/settings" className="font-medium text-brand-ink underline">
          {t("help.backToSettings", locale)}
        </Link>
      </p>
    </div>
  );
}
