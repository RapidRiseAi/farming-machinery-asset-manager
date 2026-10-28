import { notFound } from "next/navigation";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { isUuid } from "@/lib/ids";

import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { ChatIcon } from "@/components/ui/icons";
import { CustomerStatusBadge, MessageThread, type ThreadMessage } from "@/components/support/support-parts";

import { replyToHelp } from "../actions";

export const dynamic = "force-dynamic";

type HelpThread = {
  id: string;
  subject: string;
  kind: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  mine: boolean;
  asked_by_name: string | null;
  farm_name: string | null;
  answer_by: string | null;
  messages: ThreadMessage[];
};

/**
 * One request and its conversation, for the person who asked (or their farm's owner or
 * manager). Public messages only: Rapid Rise's internal notes never leave the desk, and
 * Rapid Rise answers as Fleet Wise support, never as a named member of staff
 * (`my_help_request`, 20261028100900). Anything else, another farm's request included,
 * is "not found".
 */
export default async function HelpRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; sent?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;

  const supabase = await createClient();
  // must: a failed read is the error screen, not "not found" for a request that exists.
  const data = must(await supabase.rpc("my_help_request", { p_ticket: id }), "help:thread");
  const thread = (data as HelpThread | null) ?? null;
  if (!thread) notFound();

  const closed = thread.status === "closed";
  const meta = [
    t("help.askedOn", locale).replace("{when}", dateTime(thread.created_at, locale)),
    !thread.mine && thread.asked_by_name ? t("support.askedBy", locale).replace("{name}", thread.asked_by_name) : null,
    thread.farm_name,
  ]
    .filter(Boolean)
    .join(" · ");

  const replyDialog = closed ? undefined : (
    <DialogForm
      trigger={t("support.replyAction", locale)}
      triggerIcon={<ChatIcon />}
      title={t("support.replyTitle", locale)}
      description={thread.subject}
      closeLabel={t("ui.close", locale)}
      size="md"
    >
      <form action={replyToHelp}>
        <RequestIdInput action="help:reply" />
        <input type="hidden" name="ticket_id" value={thread.id} />
        <DialogFields columns={1}>
          <Field label={t("support.replyBody", locale)} htmlFor="reply-body" required>
            <Textarea id="reply-body" name="body" required rows={5} maxLength={4000} />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton variant="primary">{t("support.replySend", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={thread.subject}
        back={{ href: "/help", label: t("help.title", locale) }}
        meta={meta}
        badge={<CustomerStatusBadge status={thread.status} locale={locale} />}
        actions={replyDialog}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone="success"
        message={sp.saved ? t("help.sent", locale) : sp.sent ? t("support.replySent", locale) : undefined}
      />

      {thread.kind !== "help_request" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-sand-700">
          <Badge tone="info">{t(`support.kind.${thread.kind}`, locale)}</Badge>
          {t(`support.kindNote.${thread.kind}`, locale)}
        </p>
      ) : null}

      {thread.answer_by ? (
        <Card>
          <p className="text-sm text-sand-700">
            {t("support.answerBy", locale).replace("{when}", dateTime(thread.answer_by, locale))}
          </p>
        </Card>
      ) : null}

      <MessageThread messages={thread.messages} locale={locale} />

      {closed ? <p className="text-sm text-sand-600">{t("support.closedNote", locale)}</p> : null}
    </PageContainer>
  );
}
