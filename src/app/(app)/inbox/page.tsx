import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  InboxIcon, WorkIcon, BellIcon, PhoneIcon, ChatIcon, MailIcon, ChevronRightIcon, MachinesIcon,
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
      <div className="flex flex-wrap gap-1.5">
        {tel ? (
          <a href={tel} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={t("contact.call", locale)}>
            <PhoneIcon className="text-[1.05rem]" />
          </a>
        ) : null}
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={t("contact.whatsapp", locale)}>
            <ChatIcon className="text-[1.05rem]" />
          </a>
        ) : null}
        {mail ? (
          <a href={mail} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={t("contact.email", locale)}>
            <MailIcon className="text-[1.05rem]" />
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
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("inbox.title", locale)}</h1>
          <p className="mt-0.5 text-sm text-sand-500">{t("inbox.subtitle", locale)}</p>
        </div>
        {unreadCount > 0 ? (
          <form action={markAllInboxRead}>
            <Button type="submit" variant="ghost" size="sm">{t("notifications.markAllRead", locale)}</Button>
          </form>
        ) : null}
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.saved ? t(savedMsg[sp.saved] ?? "ui.saved", locale) : undefined} />

      {/* Outstanding value at a glance */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("inbox.outstandingQuotes", locale)} value={outstandingQuotes.length} tone={outstandingQuotes.length > 0 ? "due" : "default"} />
        <Stat label={t("inbox.quoteValue", locale)} value={rands(quoteValue)} />
        <Stat label={t("inbox.outstandingInvoices", locale)} value={outstandingInvoices.length} tone={outstandingInvoices.length > 0 ? "overdue" : "default"} />
        <Stat label={t("inbox.invoiceValue", locale)} value={rands(invoiceValue)} />
      </div>

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
          <EmptyState icon={<InboxIcon />} title={t("inbox.noActions", locale)} hint={t("inbox.noActionsHint", locale)} />
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {actionItems.map((r) => {
              const ws = r.workshop_id ? wsById.get(r.workshop_id) : undefined;
              const isQuote = r.status === "quoted";
              const amount = amountOf(r);
              return (
                <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {unreadWrIds.has(r.id) ? <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label={t("notifications.unread", locale)} /> : null}
                      <Link href={`/work/${r.id}`} className="focus-ring truncate rounded font-semibold text-sand-900 hover:underline">
                        {nameById.get(r.machine_id) ?? "—"}
                      </Link>
                      <Badge tone={workStatusTone(r.status)}>{workStatusLabel(r.status, locale)}</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-sand-500">
                      {workKindLabel(r.kind, locale)}
                      {r.title ? ` · ${r.title}` : ""}
                      {ws ? ` · ${ws.name}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {amount != null ? <span className="text-sm font-bold tabular-nums text-sand-900">{rands(amount)}</span> : null}
                    {contactButtons(ws)}
                    <form action={isQuote ? acceptQuote : approveInvoice}>
                      <input type="hidden" name="id" value={r.id} />
                      <SubmitButton variant="primary" size="sm">
                        {isQuote ? t("inbox.acceptQuote", locale) : t("inbox.approveInvoice", locale)}
                      </SubmitButton>
                    </form>
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
          <EmptyState icon={<WorkIcon />} title={t("inbox.noActiveWork", locale)} hint={t("inbox.noActiveWorkHint", locale)} />
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
                          <Badge tone={workStatusTone(r.status)}>{workStatusLabel(r.status, locale)}</Badge>
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
          <EmptyState icon={<BellIcon />} title={t("notifications.empty", locale)} hint={t("notifications.emptyHint", locale)} />
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
