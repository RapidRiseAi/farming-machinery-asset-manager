import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { relativeDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { formatNotification, notificationUrl } from "@/lib/notifications/format";
import { INBOX_ACTION_STATUSES } from "@/lib/inbox";
import { workStatusLabel, workKindLabel, workStatusTone, workPriorityLabel, workPriorityTone } from "@/lib/work";
import { acceptQuote, approveInvoice, markInboxRead, markAllInboxRead } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { EmptyState, AllClear } from "@/components/ui/empty-state";
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
  const locale = profile.language;
  const sp = await searchParams;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [wrRes, noteRes, msRes, wsRes] = await Promise.all([
    supabase
      .from("work_requests")
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
  const actionItems = requests.filter((r) => (INBOX_ACTION_STATUSES as readonly string[]).includes(r.status));
  const outstandingQuotes = actionItems.filter((r) => r.status === "quoted");
  const outstandingInvoices = actionItems.filter((r) => r.status === "invoiced");
  const quoteValue = outstandingQuotes.reduce((a, r) => a + (r.quote_amount_cents ?? 0), 0);
  const invoiceValue = outstandingInvoices.reduce((a, r) => a + (r.invoice_amount_cents ?? 0), 0);

  // Active work grouped by vehicle (each request shows its contractor).
  const byMachine = new Map<string, WorkRequest[]>();
  for (const r of requests) {
    const list = byMachine.get(r.machine_id) ?? [];
    list.push(r);
    byMachine.set(r.machine_id, list);
  }
  const machineGroups = [...byMachine.entries()]
    .map(([machineId, list]) => ({ machineId, name: nameById.get(machineId) ?? "—", list }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const unreadCount = notes.filter((n) => n.read_at == null).length;

  // Quick-contact buttons for a request's assigned contractor (reuse F12a contact.ts).
  const contactButtons = (ws: Workshop | undefined) => {
    if (!ws) return null;
    const tel = telHref(ws.phone);
    const wa = waHref(ws.whatsapp ?? ws.phone, t("contact.waPrefill", locale));
    const mail = mailtoHref(ws.email);
    if (!tel && !wa && !mail) return null;
    return (
      // Icon AND word, never icon-only — three unlabelled glyphs used to sit millimetres
      // from the button that spends money.
      <div className="flex flex-wrap gap-1.5">
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary" })}>
            <ChatIcon className="text-[1.05rem]" />
            {t("contact.whatsapp", locale)}
          </a>
        ) : null}
        {tel ? (
          <a href={tel} className={buttonVariants({ variant: "ghost" })}>
            <PhoneIcon className="text-[1.05rem]" />
            {t("contact.call", locale)}
          </a>
        ) : null}
        {mail && !wa && !tel ? (
          <a href={mail} className={buttonVariants({ variant: "ghost" })}>
            <MailIcon className="text-[1.05rem]" />
            {t("contact.email", locale)}
          </a>
        ) : null}
      </div>
    );
  };

  const amountOf = (r: WorkRequest) =>
    r.status === "invoiced" ? r.invoice_amount_cents : r.status === "quoted" ? r.quote_amount_cents : (r.invoice_amount_cents ?? r.quote_amount_cents);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight text-sand-950">
            {t("inbox.waitingForYou", locale)}
          </h1>
          <p className="mt-1 text-sm text-sand-500">
            {actionItems.length === 0
              ? t("inbox.subtitle", locale)
              : (actionItems.length === 1
                  ? t("inbox.oneDecisionWorth", locale)
                  : t("inbox.decisionsWorth", locale).replace("{n}", String(actionItems.length))
                ).replace("{amount}", rands(quoteValue + invoiceValue))}
          </p>
        </div>
        {unreadCount > 0 ? (
          <form action={markAllInboxRead}>
            <Button type="submit" variant="ghost" size="sm">{t("notifications.markAllRead", locale)}</Button>
          </form>
        ) : null}
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/*
        One total and a two-line split. This was four tiles — outstanding quotes, quote
        value, outstanding invoices, invoice value — count and money separated, so the
        owner had to pair them mentally.
      */}
      {actionItems.length > 0 ? (
        <Card>
          <p className="text-sm font-medium text-sand-600">{t("inbox.ifYouSayYes", locale)}</p>
          <p className="mt-0.5 text-3xl font-bold tabular-nums tracking-tight text-sand-950">
            {rands(quoteValue + invoiceValue)}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-sand-100 pt-3 text-sm">
            {outstandingInvoices.length > 0 ? (
              <div>
                <dt className="text-sand-500">
                  {t("inbox.billsToPay", locale)}{" "}
                  <span className="text-sand-400">({t("inbox.workIsDone", locale)})</span>
                </dt>
                <dd className="text-lg font-semibold tabular-nums text-sand-900">{rands(invoiceValue)}</dd>
              </div>
            ) : null}
            {outstandingQuotes.length > 0 ? (
              <div>
                <dt className="text-sand-500">{t("inbox.pricesToAccept", locale)}</dt>
                <dd className="text-lg font-semibold tabular-nums text-sand-900">{rands(quoteValue)}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {/* Needs your action — accept quotes / approve invoices inline */}
      <Card>
        <CardHeader
          action={
            <Link href="/work" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700">
              {t("nav.work", locale)}
              <ChevronRightIcon className="text-[1rem]" />
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
            {actionItems.map((r) => {
              const ws = r.workshop_id ? wsById.get(r.workshop_id) : undefined;
              const isQuote = r.status === "quoted";
              const amount = amountOf(r);
              const sameAsQuote =
                !isQuote && r.quote_amount_cents != null && r.invoice_amount_cents === r.quote_amount_cents;
              return (
                /*
                  One card per decision. The row used to put the machine-name link, three
                  icon-only contact buttons and the approve submit in a single flex row —
                  five targets within a few millimetres, the largest of which spends money.
                  A bill for finished work and a quote for work not started also rendered
                  identically; they are different decisions and now look different.
                */
                <li
                  key={r.id}
                  className={`rounded-xl border p-4 ${isQuote ? "border-sand-200 bg-white" : "border-amber-200 bg-amber-50/40"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {unreadWrIds.has(r.id) ? (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label={t("notifications.unread", locale)} />
                        ) : null}
                        <Link href={`/work/${r.id}`} className="focus-ring truncate rounded text-[1.05rem] font-semibold text-sand-900 hover:underline">
                          {nameById.get(r.machine_id) ?? "—"}
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
                      <p className="text-xs text-sand-500">{t("inbox.theyWant", locale)}</p>
                      <p className="text-xl font-bold tabular-nums text-sand-950">
                        {amount != null ? rands(amount) : "—"}
                      </p>
                      <p className="mt-0.5 text-xs text-sand-400">
                        {t("inbox.sentWhen", locale).replace("{when}", relativeDate(r.updated_at, locale))}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {/*
                      Audit bug 5: both of these commit the farm to real money and used to
                      fire straight from a `size="sm"` submit. The server action, its `id`
                      field and its redirect are unchanged — there is now a step in front
                      that names the amount and, for a bill, compares it to the quote.
                    */}
                    <ConfirmDialog
                      action={isQuote ? acceptQuote : approveInvoice}
                      tone="brand"
                      triggerVariant="primary"
                      triggerSize="lg"
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
                        { label: t("inbox.confirmMachine", locale), value: nameById.get(r.machine_id) ?? "—" },
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
                      Accept and Approve used to be the ONLY actions on the card — saying
                      no, or querying a bill that does not match its quote, had no path at
                      all, so those conversations happened on WhatsApp and the system lost
                      them. This deep-links to the request, where the note and the status
                      change already live.
                    */}
                    <Link href={`/work/${r.id}`} className={buttonVariants({ variant: "secondary" })}>
                      {isQuote ? t("inbox.tooExpensive", locale) : t("inbox.somethingWrong", locale)}
                    </Link>

                    {contactButtons(ws)}
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
        {machineGroups.length === 0 ? (
          <AllClear icon={<WorkIcon />} title={t("inbox.noActiveWork", locale)} hint={t("inbox.noActiveWorkHint", locale)} />
        ) : (
          <div className="flex flex-col gap-4">
            {machineGroups.map((g) => (
              <section key={g.machineId} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <MachinesIcon className="text-[1.1rem] text-sand-400" />
                  <Link href={`/machines/${g.machineId}`} className="focus-ring rounded text-sm font-semibold text-sand-900 hover:underline">{g.name}</Link>
                  <span className="text-xs text-sand-400">{g.list.length}</span>
                </div>
                <ul className="flex flex-col gap-1.5 pl-6">
                  {g.list.map((r) => {
                    const ws = r.workshop_id ? wsById.get(r.workshop_id) : undefined;
                    const amount = amountOf(r);
                    return (
                      <li key={r.id} className="flex items-center justify-between gap-3">
                        <Link href={`/work/${r.id}`} className="focus-ring flex min-w-0 items-center gap-2 rounded">
                          {unreadWrIds.has(r.id) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden /> : null}
                          <span className="truncate text-sm text-sand-700">
                            {workKindLabel(r.kind, locale)}{r.title ? ` · ${r.title}` : ""}
                            {ws ? ` · ${ws.name}` : ` · ${t("work.unassigned", locale)}`}
                          </span>
                        </Link>
                        <span className="flex shrink-0 items-center gap-2">
                          {r.priority !== "normal" ? <Badge tone={workPriorityTone(r.priority)}>{workPriorityLabel(r.priority, locale)}</Badge> : null}
                          {amount != null ? <span className="text-xs font-medium tabular-nums text-sand-500">{rands(amount)}</span> : null}
                          <WorkStatus value={r.status} locale={locale} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {/* Recent activity — the notification feed, surfaced richly */}
      <Card>
        <CardHeader
          action={
            <Link href="/notifications" className="focus-ring inline-flex items-center gap-0.5 rounded-md text-sm font-medium text-brand-700">
              {t("nav.notifications", locale)}
              <ChevronRightIcon className="text-[1rem]" />
            </Link>
          }
        >
          <CardTitle>{t("inbox.recentActivity", locale)}</CardTitle>
        </CardHeader>
        {notes.length === 0 ? (
          <AllClear icon={<BellIcon />} title={t("notifications.empty", locale)} hint={t("notifications.emptyHint", locale)} />
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {notes.map((n) => {
              const unread = n.read_at == null;
              const href = notificationUrl(n.template, n.payload ?? {});
              const machineName = n.payload?.machine_id ? nameById.get(String(n.payload.machine_id)) : undefined;
              return (
                <li key={n.id} className="flex items-start justify-between gap-3 py-2.5">
                  <Link href={href} className="focus-ring flex min-w-0 items-start gap-2 rounded">
                    {unread ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-hidden /> : <span className="mt-1.5 h-2 w-2 shrink-0" aria-hidden />}
                    <span className="min-w-0">
                      <span className={`block text-sm ${unread ? "font-medium text-sand-900" : "text-sand-600"}`}>
                        {formatNotification(n.template, n.payload ?? {}, locale, machineName)}
                      </span>
                      <span className="block text-xs text-sand-400">{new Date(n.created_at).toLocaleDateString("en-ZA")}</span>
                    </span>
                  </Link>
                  {unread ? (
                    <form action={markInboxRead}>
                      <input type="hidden" name="id" value={n.id} />
                      <button className="focus-ring shrink-0 rounded border border-sand-300 px-2 py-0.5 text-xs hover:bg-sand-50">{t("notifications.read", locale)}</button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
