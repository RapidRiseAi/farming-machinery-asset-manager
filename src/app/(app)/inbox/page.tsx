import Link from "next/link";
import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { relativeDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { formatNotification } from "@/lib/notifications/format";
import { INBOX_ACTION_STATUSES } from "@/lib/inbox";
import { workKindLabel, workPriorityLabel, workPriorityTone } from "@/lib/work";
import { acceptQuote, approveInvoice, openInboxAlert, markAllInboxRead } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Flash } from "@/components/ui/flash";
import { AllClear } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { WorkStatus } from "@/components/ui/status";
import {
  InboxIcon, WorkIcon, BellIcon, PhoneIcon, ChatIcon, MailIcon, ChevronRightIcon, MachinesIcon, CheckIcon,
} from "@/components/ui/icons";

type WorkRequest = {
  id: string; machine_id: string; workshop_id: string | null; kind: string; status: string;
  priority: string; title: string | null; quote_amount_cents: number | null;
  invoice_amount_cents: number | null; updated_at: string; created_at: string;
};
type Workshop = { id: string; name: string; kind: string; phone: string | null; whatsapp: string | null; email: string | null };
type Note = { id: string; template: string; payload: Record<string, unknown>; read_at: string | null; created_at: string };

const savedMsg: Record<string, string> = {
  quote_accepted: "inbox.quoteAccepted",
  invoice_approved: "inbox.invoiceApproved",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  // Owner/manager cockpit (spec §4). Other roles are bounced to their own home.
  const profile = await requireRole(["owner", "manager"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [wrRes, noteRes, msRes, wsRes] = await Promise.all([
    supabase
      .from("work_requests_visible")
      .select("id, machine_id, workshop_id, kind, status, priority, title, quote_amount_cents, invoice_amount_cents, updated_at, created_at")
      .is("deleted_at", null)
      .neq("status", "closed")
      .order("updated_at", { ascending: false }),
    supabase
      .from("notifications")
      .select("id, template, payload, read_at, created_at")
      .eq("user_id", profile.id)
      .is("deleted_at", null)
      .or(`deliver_after.is.null,deliver_after.lte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase.from("machines").select("id, name").is("deleted_at", null),
    supabase.from("workshops").select("id, name, kind, phone, whatsapp, email"),
  ]);

  const requests = (wrRes.data as WorkRequest[] | null) ?? [];
  const notes = (noteRes.data as Note[] | null) ?? [];
  const machines = (msRes.data as { id: string; name: string }[] | null) ?? [];
  const workshops = (wsRes.data as Workshop[] | null) ?? [];
  const nameById = new Map(machines.map((m) => [m.id, m.name]));
  const wsById = new Map(workshops.map((w) => [w.id, w]));

  // Which requests have an unread alert → the "new activity" dot on a request card.
  const unreadWrIds = new Set(
    notes
      .filter((n) => n.read_at == null && n.payload?.work_request_id)
      .map((n) => String(n.payload.work_request_id))
  );

  // Items where the ball is in the owner's court: accept a quote / approve an invoice.
  // Longest-waiting first, and only that one gets the filled button: three green
  // "Approve" buttons on one screen leave nothing to look at first.
  const actionItems = requests
    .filter((r) => (INBOX_ACTION_STATUSES as readonly string[]).includes(r.status))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const actionIds = new Set(actionItems.map((r) => r.id));
  const outstandingQuotes = actionItems.filter((r) => r.status === "quoted");
  const outstandingInvoices = actionItems.filter((r) => r.status === "invoiced");
  const quoteValue = outstandingQuotes.reduce((a, r) => a + (r.quote_amount_cents ?? 0), 0);
  const invoiceValue = outstandingInvoices.reduce((a, r) => a + (r.invoice_amount_cents ?? 0), 0);

  // Active work grouped by vehicle (each request shows its contractor). The decisions
  // above are left out: they used to appear here again, and a third time in the feed.
  const byMachine = new Map<string, WorkRequest[]>();
  for (const r of requests) {
    if (actionIds.has(r.id)) continue;
    const list = byMachine.get(r.machine_id) ?? [];
    list.push(r);
    byMachine.set(r.machine_id, list);
  }
  const machineGroups = [...byMachine.entries()]
    .map(([machineId, list]) => ({ machineId, name: nameById.get(machineId) ?? "-", list }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const unreadCount = notes.filter((n) => n.read_at == null).length;
  // The feed: the five newest unread alerts that are not already a decision card above.
  const recent = notes
    .filter((n) => n.read_at == null)
    .filter((n) => !(n.payload?.work_request_id && actionIds.has(String(n.payload.work_request_id))))
    .slice(0, 5);

  // Contacting the contractor, behind one "Contact" button titled with their name.
  // Icon AND word on every item: three unlabelled glyphs used to sit millimetres from
  // the button that spends money, and then three full-width buttons under it.
  const contactMenu = (ws: Workshop | undefined) => {
    if (!ws) return null;
    const tel = telHref(ws.phone);
    const wa = waHref(ws.whatsapp ?? ws.phone, t("contact.waPrefill", locale));
    const mail = mailtoHref(ws.email);
    if (!tel && !wa && !mail) return null;
    return (
      <ActionMenu
        title={ws.name}
        label={`${t("inbox.contact", locale)}: ${ws.name}`}
        closeLabel={t("ui.close", locale)}
        trigger={
          <>
            <ChatIcon className="text-base" />
            {t("inbox.contact", locale)}
          </>
        }
      >
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className={menuItemClass()}>
            <ChatIcon className="text-base" />
            {t("contact.whatsapp", locale)}
          </a>
        ) : null}
        {tel ? (
          <a href={tel} className={menuItemClass()}>
            <PhoneIcon className="text-base" />
            {t("contact.call", locale)}
          </a>
        ) : null}
        {mail ? (
          <a href={mail} className={menuItemClass()}>
            <MailIcon className="text-base" />
            {t("contact.email", locale)}
          </a>
        ) : null}
      </ActionMenu>
    );
  };

  const amountOf = (r: WorkRequest) =>
    r.status === "invoiced" ? r.invoice_amount_cents : r.status === "quoted" ? r.quote_amount_cents : (r.invoice_amount_cents ?? r.quote_amount_cents);

  // The split, said once in the header's quiet line. It was a whole card repeating the
  // subtitle's total at text-3xl, which pushed the first Approve off a phone's screen.
  const split =
    outstandingInvoices.length > 0 && outstandingQuotes.length > 0
      ? `${t("inbox.billsToPay", locale)} ${rands(invoiceValue)} · ${t("inbox.pricesToAccept", locale)} ${rands(quoteValue)}`
      : undefined;

  return (
    <PageContainer>
      <PageHeader
        title={t("inbox.waitingForYou", locale)}
        infoKey="inbox"
        locale={locale}
        meta={split}
        lead={
          actionItems.length === 0
            ? t("inbox.subtitle", locale)
            : (actionItems.length === 1
                ? t("inbox.oneDecisionWorth", locale)
                : t("inbox.decisionsWorth", locale).replace("{n}", String(actionItems.length))
              ).replace("{amount}", rands(quoteValue + invoiceValue))
        }
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/* Needs your action, accept quotes / approve invoices inline */}
      <Card>
        <CardHeader
          action={
            <Link href="/work" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-ink">
              {t("nav.work", locale)}
              <ChevronRightIcon className="text-base" />
            </Link>
          }
        >
          <CardTitle>{t("inbox.needsAction", locale)}</CardTitle>
        </CardHeader>
        {actionItems.length === 0 ? (
          <AllClear
            icon={<InboxIcon />}
            title={t("inbox.nothingWaitingTitle", locale)}
            hint={t("inbox.nothingWaitingHint", locale)}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {actionItems.map((r, index) => {
              const ws = r.workshop_id ? wsById.get(r.workshop_id) : undefined;
              const isQuote = r.status === "quoted";
              const amount = amountOf(r);
              const sameAsQuote =
                !isQuote && r.quote_amount_cents != null && r.invoice_amount_cents === r.quote_amount_cents;
              return (
                /*
                  One card per decision. The row used to put the machine-name link, three
                  icon-only contact buttons and the approve submit in a single flex row -
                  five targets within a few millimetres, the largest of which spends money.
                  A bill for finished work and a quote for work not started also rendered
                  identically; they are different decisions and now look different.
                */
                <li
                  key={r.id}
                  className={`rounded-xl border p-4 ${isQuote ? "border-sand-200 bg-surface" : "border-callout-warn-edge bg-callout-warn-bg/40"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {unreadWrIds.has(r.id) ? (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label={t("notifications.unread", locale)} />
                        ) : null}
                        <Link href={`/work/${r.id}`} className="focus-ring truncate rounded text-base font-semibold text-sand-900 hover:underline">
                          {nameById.get(r.machine_id) ?? "-"}
                        </Link>
                        <Badge tone={isQuote ? "brand" : "warning"}>
                          {isQuote ? t("inbox.priceToAccept", locale) : t("inbox.billToPay", locale)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-sand-600">
                        {r.title || workKindLabel(r.kind, locale)}
                        {ws ? ` · ${ws.name}` : ""}
                      </p>
                      {isQuote ? (
                        <p className="mt-1 text-sm text-sand-500">{t("inbox.standingStill", locale)}</p>
                      ) : sameAsQuote ? (
                        <p className="mt-1 text-sm text-sand-500">{t("inbox.confirmSameAsQuote", locale)}</p>
                      ) : r.quote_amount_cents != null && r.invoice_amount_cents != null ? (
                        <p className="mt-1 text-sm font-medium text-status-due">
                          {t("inbox.confirmDiffersFromQuote", locale).replace(
                            "{diff}",
                            rands(Math.abs(r.invoice_amount_cents - r.quote_amount_cents)),
                          )}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      {/* A bill says what they billed: "Quoted" on an invoice was wrong on
                          the one screen that commits money. */}
                      <p className="text-xs text-sand-500">{t(isQuote ? "inbox.amountQuoted" : "inbox.amountBilled", locale)}</p>
                      <p className="text-xl font-bold tabular-nums text-sand-950">
                        {amount != null ? rands(amount) : "-"}
                      </p>
                      <p className="mt-0.5 text-xs text-sand-400">
                        {t("inbox.sentWhen", locale).replace("{when}", relativeDate(r.updated_at, locale))}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {/*
                      Audit bug 5: both of these commit the farm to real money and used to
                      fire straight from a `size="sm"` submit. The server action, its `id`
                      field and its redirect are unchanged, there is now a step in front
                      that names the amount and, for a bill, compares it to the quote.
                    */}
                    <ConfirmDialog
                      action={isQuote ? acceptQuote : approveInvoice}
                      tone="brand"
                      triggerVariant={index === 0 ? "primary" : "secondary"}
                      triggerLabel={isQuote ? t("inbox.confirmQuoteYes", locale) : t("inbox.confirmInvoiceYes", locale)}
                      triggerIcon={<CheckIcon />}
                      title={
                        amount == null
                          ? isQuote
                            ? t("inbox.confirmQuoteTitleNoAmount", locale)
                            : t("inbox.confirmInvoiceTitleNoAmount", locale)
                          : (isQuote
                              ? t("inbox.confirmQuoteTitle", locale)
                              : t("inbox.confirmInvoiceTitle", locale)
                            ).replace("{amount}", rands(amount))
                      }
                      intro={(isQuote ? t("inbox.confirmQuoteIntro", locale) : t("inbox.confirmInvoiceIntro", locale)).replace("{contractor}", ws?.name ?? t("inbox.theContractor", locale))}
                      facts={[
                        { label: t("inbox.confirmMachine", locale), value: nameById.get(r.machine_id) ?? "-" },
                        ...(r.quote_amount_cents != null
                          ? [{ label: t("inbox.confirmQuoted", locale), value: rands(r.quote_amount_cents) }]
                          : []),
                        ...(!isQuote && r.invoice_amount_cents != null
                          ? [
                              {
                                label: t("inbox.confirmBilled", locale),
                                value: rands(r.invoice_amount_cents),
                                hint:
                                  r.quote_amount_cents == null
                                    ? undefined
                                    : sameAsQuote
                                      ? t("inbox.confirmSameAsQuote", locale)
                                      : t("inbox.confirmDiffersFromQuote", locale).replace(
                                          "{diff}",
                                          rands(Math.abs(r.invoice_amount_cents - r.quote_amount_cents)),
                                        ),
                              },
                            ]
                          : []),
                      ]}
                      confirmLabel={isQuote ? t("inbox.confirmQuoteYes", locale) : t("inbox.confirmInvoiceYes", locale)}
                      cancelLabel={t("inbox.confirmNotYet", locale)}
                      closeLabel={t("ui.close", locale)}
                    >
                      <input type="hidden" name="id" value={r.id} />
                    </ConfirmDialog>

                    {/*
                      Accept and Approve used to be the ONLY actions on the card, saying
                      no, or querying a bill that does not match its quote, had no path at
                      all, so those conversations happened on WhatsApp and the system lost
                      them. This deep-links to the request, where the note and the status
                      change already live.
                    */}
                    <Link href={`/work/${r.id}`} className={buttonVariants({ variant: "secondary" })}>
                      {isQuote ? t("inbox.tooExpensive", locale) : t("inbox.somethingWrong", locale)}
                    </Link>

                    {contactMenu(ws)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Active work grouped by vehicle + contractor */}
      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.activeWork", locale)}</CardTitle>
        </CardHeader>
        {actionItems.length > 0 ? (
          <p className="-mt-2 mb-3 text-sm text-sand-500">
            {t("inbox.waitingAbove", locale).replace("{n}", String(actionItems.length))}
          </p>
        ) : null}
        {machineGroups.length === 0 ? (
          <AllClear icon={<WorkIcon />} title={t("inbox.noActiveWork", locale)} hint={t("inbox.noActiveWorkHint", locale)} />
        ) : (
          <div className="flex flex-col gap-4">
            {machineGroups.map((g) => (
              <section key={g.machineId} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <MachinesIcon className="text-lg text-sand-400" />
                  <Link href={`/machines/${g.machineId}`} className="focus-ring rounded text-sm font-semibold text-sand-900 hover:underline">{g.name}</Link>
                  <span className="text-xs text-sand-400">{g.list.length}</span>
                </div>
                <ul className="flex flex-col pl-6">
                  {g.list.map((r) => {
                    const ws = r.workshop_id ? wsById.get(r.workshop_id) : undefined;
                    const amount = amountOf(r);
                    return (
                      <li key={r.id}>
                        {/* The whole row opens the request, and the chevron says so. */}
                        <Link href={`/work/${r.id}`} className="focus-ring -mx-2 flex min-h-[48px] items-center justify-between gap-3 rounded-lg px-2 hover:bg-sand-50 sm:min-h-[40px]">
                          <span className="flex min-w-0 items-center gap-2">
                            {unreadWrIds.has(r.id) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden /> : null}
                            <span className="truncate text-sm text-sand-700">
                              {workKindLabel(r.kind, locale)}{r.title ? ` · ${r.title}` : ""}
                              {ws ? ` · ${ws.name}` : ` · ${t("work.unassigned", locale)}`}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {/* Only a priority worth shouting about: "Low" on a row is noise. */}
                            {r.priority === "high" || r.priority === "urgent" ? <Badge tone={workPriorityTone(r.priority)}>{workPriorityLabel(r.priority, locale)}</Badge> : null}
                            {amount != null ? <span className="hidden text-xs font-medium tabular-nums text-sand-500 sm:inline">{rands(amount)}</span> : null}
                            <WorkStatus value={r.status} locale={locale} />
                            <ChevronRightIcon className="text-base text-sand-400" />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {/* Recent activity, the notification feed, surfaced richly */}
      {/* Recent activity: only what is new, and not what is already a decision above.
          Opening a row marks it read; "Mark all read" sits beside the feed it affects. */}
      <Card>
        <CardHeader
          action={
            <span className="flex flex-wrap items-center justify-end gap-x-3">
              {unreadCount > 0 ? (
                <form action={markAllInboxRead}>
                  <Button type="submit" variant="ghost" size="sm">
                    <CheckIcon />
                    {t("notifications.markAllRead", locale)}
                  </Button>
                </form>
              ) : null}
              <Link href="/notifications" className="focus-ring inline-flex min-h-[48px] items-center gap-0.5 rounded-md text-sm font-medium text-brand-ink sm:min-h-0">
                {t("nav.notifications", locale)}
                <ChevronRightIcon className="text-base" />
              </Link>
            </span>
          }
        >
          <CardTitle>{t("inbox.recentActivity", locale)}</CardTitle>
        </CardHeader>
        {notes.length === 0 ? (
          <AllClear icon={<BellIcon />} title={t("notifications.empty", locale)} hint={t("notifications.emptyHint", locale)} />
        ) : recent.length === 0 ? (
          <p className="text-sm text-sand-500">{t("inbox.nothingNew", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {recent.map((n) => {
              const machineName = n.payload?.machine_id ? nameById.get(String(n.payload.machine_id)) : undefined;
              return (
                <li key={n.id}>
                  <form action={openInboxAlert}>
                    <input type="hidden" name="id" value={n.id} />
                    <button
                      type="submit"
                      className="focus-ring -mx-2 flex min-h-[48px] w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-2.5 text-left hover:bg-sand-50"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-sand-900">
                          {formatNotification(n.template, n.payload ?? {}, locale, machineName)}
                        </span>
                        <span className="block text-xs text-sand-500">{relativeDate(n.created_at, locale)}</span>
                      </span>
                      <ChevronRightIcon className="shrink-0 text-base text-sand-400" />
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
