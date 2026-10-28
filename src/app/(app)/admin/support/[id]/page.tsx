import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must, soft } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime, roleLabel } from "@/lib/format";
import { isUuid } from "@/lib/ids";
import { dueState, isCustomerKind } from "@/lib/support/sla";
import { mailtoHref, telHref, waHref } from "@/lib/contact";

import { Card, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { Fact, FactList } from "@/components/ui/facts";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { ChatIcon } from "@/components/ui/icons";
import { MessageThread, StaffStatusBadge, type ThreadMessage } from "@/components/support/support-parts";
import { impersonateFarm } from "@/app/(app)/admin/farms/[id]/actions";

import { addStaffNote, assignTicket, replyAsStaff, setTicketStatus } from "../actions";

export const dynamic = "force-dynamic";

type Ticket = {
  id: string;
  kind: string;
  status: string;
  subject: string;
  channel: string;
  is_test: boolean;
  external_ref: string | null;
  opened_at: string;
  next_due: string | null;
  first_response_due_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by_name: string | null;
  context: { path?: string; app_version?: string; locale?: string } | null;
  farm: { id: string; name: string; is_test: boolean; plan: string; status: string; billing_email: string | null } | null;
  workshop: { id: string; name: string; is_test: boolean } | null;
  asker: { id: string; name: string; email: string | null; phone: string | null; role: string; language: string; active: boolean } | null;
  assignee: { id: string; name: string } | null;
  messages: ThreadMessage[];
};

/**
 * One support case, worked: the conversation (internal notes marked), who asked and how
 * to reach them, the client it is about, and the actions. Reply is the page's one primary
 * action; a note, the status and the assignee sit in the menu beside it.
 *
 * "Look inside this farm" enters support mode with this case as the reason, so the
 * owner's visit list says why Rapid Rise came in (20261028100700).
 */
export default async function AdminTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; sent?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;

  const supabase = await createClient();
  const data = must(await supabase.rpc("support_ticket", { p_ticket: id }), "admin-ticket:read");
  const ticket = (data as Ticket | null) ?? null;
  if (!ticket) notFound();
  // soft: only the assignee choices; without them the dialog offers "nobody" alone.
  const staff = ((soft(await supabase.rpc("support_staff"), "admin-ticket:staff") as { id: string; name: string }[] | null) ?? []);

  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const customer = isCustomerKind(ticket.kind);
  const due = dueState(ticket.next_due, new Date());
  const asker = ticket.asker;
  const tel = telHref(asker?.phone);
  const wa = waHref(asker?.phone);
  const mail = mailtoHref(asker?.email, ticket.subject);
  const link = "focus-ring rounded font-medium text-brand-ink underline underline-offset-2 break-all";

  const reply = customer ? (
    <DialogForm
      trigger={t("support.replyAction", locale)}
      triggerIcon={<ChatIcon />}
      title={t("support.staffReplyTitle", locale)}
      description={t("support.staffReplyHint", locale)}
      closeLabel={closeLabel}
      size="md"
    >
      <form action={replyAsStaff}>
        <RequestIdInput action="support:reply" />
        <input type="hidden" name="ticket_id" value={ticket.id} />
        <DialogFields columns={1}>
          <Field label={t("support.replyBody", locale)} htmlFor="staff-reply" required>
            <Textarea id="staff-reply" name="body" required rows={6} maxLength={4000} />
          </Field>
          <Field label={t("support.replyThen", locale)} htmlFor="staff-reply-status">
            <Select id="staff-reply-status" name="status" defaultValue="waiting">
              <option value="waiting">{t("support.replyThenWaiting", locale)}</option>
              <option value="open">{t("support.replyThenOpen", locale)}</option>
            </Select>
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("support.replySend", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;

  const menu = (
    <ActionMenu title={ticket.subject} label={t("common.actions", locale)} closeLabel={closeLabel}>
      <DialogForm
        triggerLook="menuItem"
        trigger={t("support.noteAction", locale)}
        title={t("support.noteTitle", locale)}
        description={t("support.noteHint", locale)}
        closeLabel={closeLabel}
        size="md"
      >
        <form action={addStaffNote}>
          <RequestIdInput action="support:note" />
          <input type="hidden" name="ticket_id" value={ticket.id} />
          <DialogFields columns={1}>
            <Field label={t("support.noteChannel", locale)} htmlFor="note-channel">
              <Select id="note-channel" name="channel" defaultValue="in_app">
                <option value="in_app">{t("support.noteChannelNote", locale)}</option>
                {["phone", "whatsapp", "email", "in_person"].map((c) => (
                  <option key={c} value={c}>{t(`support.channel.${c}`, locale)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("support.noteBody", locale)} htmlFor="note-body" required>
              <Textarea id="note-body" name="body" required rows={5} maxLength={4000} />
            </Field>
          </DialogFields>
          <DialogActions cancelLabel={cancelLabel}>
            <SubmitButton variant="primary">{t("support.noteSave", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>

      <DialogForm
        triggerLook="menuItem"
        trigger={t("support.statusAction", locale)}
        title={t("support.statusTitle", locale)}
        description={t("support.statusHint", locale)}
        closeLabel={closeLabel}
        size="md"
      >
        <form action={setTicketStatus}>
          <input type="hidden" name="ticket_id" value={ticket.id} />
          <DialogFields columns={1}>
            <Field label={t("support.colStatus", locale)} htmlFor="ticket-status">
              <Select id="ticket-status" name="status" defaultValue={ticket.status === "open" || ticket.status === "waiting" ? "resolved" : ticket.status}>
                {["open", "waiting", "resolved", "closed"].map((s) => (
                  <option key={s} value={s}>{t(`support.status.${s}`, locale)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("support.resolution", locale)} htmlFor="ticket-resolution" hint={t("support.resolutionHint", locale)}>
              <Textarea id="ticket-resolution" name="resolution" rows={4} maxLength={2000} defaultValue={ticket.resolution ?? ""} />
            </Field>
          </DialogFields>
          <DialogActions cancelLabel={cancelLabel}>
            <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>

      <DialogForm
        triggerLook="menuItem"
        trigger={t("support.assignAction", locale)}
        title={t("support.assignTitle", locale)}
        description={ticket.subject}
        closeLabel={closeLabel}
        size="md"
      >
        <form action={assignTicket}>
          <input type="hidden" name="ticket_id" value={ticket.id} />
          <DialogFields columns={1}>
            <Field label={t("support.colAssignee", locale)} htmlFor="ticket-assignee">
              <Select id="ticket-assignee" name="assignee" defaultValue={ticket.assignee?.id ?? ""}>
                <option value="">{t("support.assigneeNone", locale)}</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
          </DialogFields>
          <DialogActions cancelLabel={cancelLabel}>
            <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
          </DialogActions>
        </form>
      </DialogForm>
    </ActionMenu>
  );

  return (
    <PageContainer size="default">
      <PageHeader
        title={ticket.subject}
        back={{ href: "/admin/support", label: t("support.queueTitle", locale) }}
        badge={<StaffStatusBadge status={ticket.status} locale={locale} />}
        meta={`${t(`support.kind.${ticket.kind}`, locale)} · ${dateTime(ticket.opened_at, locale)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {reply}
            {menu}
          </div>
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone={sp.sent === "noemail" ? "warning" : "success"}
        message={
          sp.sent === "noemail"
            ? t("support.replySavedNoEmail", locale)
            : sp.sent
              ? t("support.replySavedEmailed", locale)
              : sp.saved
                ? t("ui.saved", locale)
                : undefined
        }
      />

      {ticket.is_test ? <Flash tone="info" clearParams={false} message={t("support.testCaseNote", locale)} /> : null}

      <Card>
        <FactList>
          <Fact
            label={t("support.colDue", locale)}
            value={due === "none" ? t("support.dueNothing", locale) : `${t(`support.due.${due}`, locale)}, ${dateTime(ticket.next_due, locale)}`}
          />
          {customer ? (
            <Fact
              label={t("support.firstAnswer", locale)}
              value={ticket.first_response_at ? dateTime(ticket.first_response_at, locale) : t("support.notYet", locale)}
              hint={ticket.first_response_due_at ? t("support.promisedBy", locale).replace("{when}", dateTime(ticket.first_response_due_at, locale)) : undefined}
            />
          ) : null}
          <Fact label={t("support.colAssignee", locale)} value={ticket.assignee?.name ?? t("support.assigneeNone", locale)} />
          <Fact label={t("support.channelLabel", locale)} value={t(`support.channel.${ticket.channel}`, locale)} />
          {ticket.context?.path ? <Fact label={t("support.cameFrom", locale)} value={ticket.context.path} /> : null}
          {ticket.external_ref ? <Fact label={t("support.externalRef", locale)} value={ticket.external_ref} /> : null}
          {ticket.resolution ? (
            <Fact
              label={t("support.resolution", locale)}
              value={ticket.resolution}
              hint={ticket.resolved_by_name ? t("support.resolvedBy", locale).replace("{name}", ticket.resolved_by_name) : undefined}
            />
          ) : null}
        </FactList>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="ticket-thread">
        <h2 id="ticket-thread" className="text-base font-bold text-sand-900">{t("support.threadTitle", locale)}</h2>
        {ticket.messages.length ? (
          <MessageThread messages={ticket.messages} locale={locale} staffView />
        ) : (
          <p className="text-sm text-sand-600">{t("support.threadEmpty", locale)}</p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {asker ? (
          <Card>
            <CardTitle>{t("support.askerTitle", locale)}</CardTitle>
            <FactList className="mt-2">
              <Fact label={t("support.askerName", locale)} value={asker.name} hint={roleLabel(asker.role, locale)} />
              {asker.email && mail ? <Fact label={t("support.channelEmail", locale)} value={<a href={mail} className={link}>{asker.email}</a>} /> : null}
              {asker.phone && tel ? (
                <Fact
                  label={t("support.channelPhone", locale)}
                  value={
                    <span className="flex flex-wrap gap-3">
                      <a href={tel} className={link}>{asker.phone}</a>
                      {wa ? <a href={wa} className={link} target="_blank" rel="noopener noreferrer">{t("support.channel.whatsapp", locale)}</a> : null}
                    </span>
                  }
                />
              ) : null}
              <Fact label={t("support.askerLanguage", locale)} value={asker.language === "af" ? t("settings.afrikaans", locale) : t("settings.english", locale)} />
            </FactList>
          </Card>
        ) : null}

        {ticket.farm ? (
          <Card>
            <CardTitle>{t("support.clientTitle", locale)}</CardTitle>
            <FactList className="mt-2">
              <Fact
                label={t("adminHome.clientName", locale)}
                value={<Link href={`/admin/farms/${ticket.farm.id}`} className={link}>{ticket.farm.name}</Link>}
                hint={ticket.farm.is_test ? t("adminHome.testBadge", locale) : undefined}
              />
              <Fact label={t("adminHome.plan", locale)} value={t(`plan.${ticket.farm.plan}`, locale)} />
              <Fact
                label={t("adminHome.billing", locale)}
                value={<Link href={`/admin/billing?farm=${ticket.farm.id}`} className={link}>{t("adminHome.seeBilling", locale)}</Link>}
              />
            </FactList>
            <form action={impersonateFarm} className="mt-4">
              <input type="hidden" name="id" value={ticket.farm.id} />
              <input type="hidden" name="ticket_id" value={ticket.id} />
              <SubmitButton variant="secondary" size="sm">{t("adminHome.lookInsideForCase", locale)}</SubmitButton>
            </form>
          </Card>
        ) : ticket.workshop ? (
          <Card>
            <CardTitle>{t("support.clientTitle", locale)}</CardTitle>
            <p className="mt-2 text-sm text-sand-700">
              {ticket.workshop.name} {ticket.workshop.is_test ? <Badge tone="warning">{t("adminHome.testBadge", locale)}</Badge> : null}
            </p>
          </Card>
        ) : null}
      </div>
    </PageContainer>
  );
}
