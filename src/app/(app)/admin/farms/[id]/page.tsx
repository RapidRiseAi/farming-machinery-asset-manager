import Link from "next/link";
import { notFound } from "next/navigation";

import { errorMessage } from "@/lib/errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must, mustAll } from "@/lib/supabase/must";
import { readAll } from "@/lib/supabase/read-all";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { dateTime, num, roleLabel, shortDate } from "@/lib/format";
import { PLANS, BILLING_PERIODS, planNameKey } from "@/lib/entitlements";
import { isUuid } from "@/lib/ids";
import { mailtoHref, telHref, waHref } from "@/lib/contact";
import { clientState, latestSubscriptions } from "@/lib/support/client-state";
import { dueState } from "@/lib/support/sla";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { Fact, FactList } from "@/components/ui/facts";
import { Stat, StatGrid } from "@/components/ui/stat";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { StaffStatusBadge } from "@/components/support/support-parts";

import { updateFarm, impersonateFarm } from "./actions";
import { adminInviteUser, adminResendInvite, adminSetUserActive } from "./admin-actions";
import { openTicketForClient } from "@/app/(app)/admin/support/actions";

type Person = {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  home: boolean;
  last_sign_in_at: string | null;
  whatsapp_linked: boolean;
  whatsapp_alerts: boolean;
};
type Client = {
  farm: {
    id: string; name: string; is_test: boolean; plan: string; billing_period: string; status: string;
    asset_count: number; created_at: string; billing_email: string | null; deleted_at: string | null;
    settings?: Record<string, unknown> | null;
  };
  people: Person[];
  usage: {
    machines: number; open_faults: number; jobs_30d: number; last_activity: string | null;
    ai_calls_month: number; ai_failed_month: number; ai_billed_cents_month: number;
  };
  channels: {
    whatsapp_linked: number; whatsapp_alerts: number; email_failures_7d: number; whatsapp_failures_7d: number;
    recent_failures: { channel: string; at: string; template: string; error: string | null }[];
  };
  visits: { id: string; started_at: string; ended_at: string | null; reason: string; ticket_id: string | null; admin_name: string | null }[];
};
type Ticket = { id: string; kind: string; status: string; subject: string; asked_by_name: string | null; next_due: string | null; opened_at: string };
type Sub = {
  farm_id: string; status: string; plan: string; billing_period: string; next_billing_on: string | null;
  failed_attempt_count: number; grace_ends_on: string | null; discount_label: string | null; created_at: string;
};
type Invoice = { status: string; total_incl_cents: number; amount_paid_cents: number };

const STATE_TONE: Record<string, BadgeTone> = {
  paying: "ok",
  grace: "warning",
  awaiting_payment: "info",
  suspended: "danger",
  no_subscription: "neutral",
};

/**
 * One client, for Rapid Rise helping them: who to call, who is on the farm and whether they
 * ever signed in, where they stand with paying, their support cases, how much they use the
 * product, whether their alerts are reaching anyone, and every support visit with its reason.
 *
 * Read through `public.admin_client` (SECURITY DEFINER behind app.is_rr_support(), with the
 * admin's own session: sign-in times and the WhatsApp and delivery queues without the
 * service key) and the admin's own RLS for billing, as /admin/billing reads it.
 *
 * Billing is summarised and linked, not edited here: plan and status edits stay as they
 * were, minus "Trial" (decision 9) and minus switching a farm on, which comes from a
 * recorded payment (decision 3; the payments work owns it, see the hook in ./actions.ts).
 */
export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; invited?: string; exited?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const supabase = await createClient();

  // A failed read is the error screen, not "not found".
  const clientData = must(await supabase.rpc("admin_client", { p_farm: id }), "admin-client:read");
  const client = (clientData as Client | null) ?? null;
  if (!client) notFound();
  const farm = client.farm;

  const results = await Promise.all([
    supabase.rpc("support_queue", { p_status: "all", p_kind: null, p_assignee: null, p_include_test: true, p_farm: id }),
    supabase
      .from("billing_subscriptions")
      .select("farm_id, status, plan, billing_period, next_billing_on, failed_attempt_count, grace_ends_on, discount_label, created_at")
      .eq("farm_id", id)
      .is("deleted_at", null),
    readAll<Invoice>(() => supabase.from("billing_invoices").select("id, status, total_incl_cents, amount_paid_cents").eq("farm_id", id).eq("status", "open")),
    supabase.from("farms").select("settings").eq("id", id).maybeSingle(),
  ]);
  // A failed read showed "no cases" or "no subscription" about a client being helped.
  mustAll(results, "admin-client:detail");
  const tickets = ((results[0].data as Ticket[] | null) ?? []).slice(0, 20);
  const sub = latestSubscriptions((results[1].data as Sub[] | null) ?? []).get(id) ?? null;
  const unpaid = (results[2].data as Invoice[] | null) ?? [];
  const unpaidCents = unpaid.reduce((s, i) => s + Math.max(0, i.total_incl_cents - i.amount_paid_cents), 0);
  const settings = ((results[3].data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>;
  const inviteLanguage = settings.default_language === "en" ? "en" : "af";

  const state = clientState(farm, sub);
  const owners = client.people.filter((p) => p.role === "owner");
  const openTickets = tickets.filter((tk) => tk.status === "open" || tk.status === "waiting");
  const now = new Date();
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const back = `/admin/farms/${farm.id}`;
  const link = "focus-ring rounded font-medium text-brand-ink underline underline-offset-2 break-all";

  const lookInside = (
    <DialogForm
      trigger={t("adminHome.lookInside", locale)}
      title={t("adminHome.lookInsideTitle", locale)}
      description={t("adminHome.lookInsideHint", locale)}
      closeLabel={closeLabel}
      size="md"
    >
      <form action={impersonateFarm}>
        <input type="hidden" name="id" value={farm.id} />
        <DialogFields columns={1}>
          {openTickets.length ? (
            <Field label={t("adminHome.visitCase", locale)} htmlFor="visit-ticket">
              <Select id="visit-ticket" name="ticket_id" defaultValue="">
                <option value="">{t("adminHome.visitNoCase", locale)}</option>
                {openTickets.map((tk) => (
                  <option key={tk.id} value={tk.id}>{tk.subject}</option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label={t("adminHome.visitReason", locale)} htmlFor="visit-reason" hint={t("adminHome.visitReasonHint", locale)}>
            <Textarea id="visit-reason" name="reason" rows={3} maxLength={300} />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel} note={t("adminHome.visitNote", locale)}>
          <SubmitButton variant="primary">{t("adminHome.lookInsideGo", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title={farm.name}
        back={{ href: "/admin/farms", label: t("adminHome.navClients", locale) }}
        badge={<Badge tone={STATE_TONE[state]}>{t(`adminHome.state.${state}`, locale)}</Badge>}
        meta={farm.is_test ? t("adminHome.testFarmMeta", locale) : t("adminHome.clientSince", locale).replace("{when}", shortDate(farm.created_at, locale))}
        actions={lookInside}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone={sp.invited === "noemail" ? "warning" : "success"}
        message={
          sp.invited === "noemail"
            ? t("adminHome.invitedNoEmail", locale)
            : sp.invited === "resent"
              ? t("adminHome.inviteResent", locale)
              : sp.invited
                ? t("team.invited", locale)
                : sp.exited
                  ? t("admin.supportExited", locale)
                  : sp.saved
                    ? t("ui.saved", locale)
                    : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* == Who to call ================================================== */}
        <Card>
          <CardTitle>{t("adminHome.contactsTitle", locale)}</CardTitle>
          {owners.length === 0 ? (
            <p className="mt-2 text-sm text-sand-600">{t("adminHome.noOwner", locale)}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3 text-sm">
              {owners.map((o) => {
                const tel = telHref(o.phone);
                const wa = waHref(o.phone);
                const mail = mailtoHref(o.email);
                return (
                  <li key={o.id} className="flex flex-col gap-1">
                    <span className="font-medium text-ink">{o.name}</span>
                    <span className="flex flex-wrap gap-x-4 gap-y-1">
                      {mail ? <a href={mail} className={link}>{o.email}</a> : null}
                      {tel ? <a href={tel} className={link}>{o.phone}</a> : null}
                      {wa ? <a href={wa} className={link} target="_blank" rel="noopener noreferrer">{t("support.channel.whatsapp", locale)}</a> : null}
                      {!mail && !tel ? <span className="text-sand-600">{t("adminHome.noContact", locale)}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {farm.billing_email ? (
            <FactList className="mt-3">
              <Fact label={t("adminHome.billingEmail", locale)} value={<a href={mailtoHref(farm.billing_email) ?? "#"} className={link}>{farm.billing_email}</a>} />
            </FactList>
          ) : null}
        </Card>

        {/* == Paying ======================================================== */}
        <Card>
          <CardHeader
            action={
              <DialogForm
                trigger={t("common.edit", locale)}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("adminHome.planEditTitle", locale)}
                description={farm.name}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={updateFarm}>
                  <input type="hidden" name="id" value={farm.id} />
                  <DialogFields>
                    <Field label={t("adminHome.plan", locale)} htmlFor="plan">
                      <Select id="plan" name="plan" defaultValue={farm.plan}>
                        {PLANS.map((p) => (
                          <option key={p} value={p}>{t(planNameKey(p), locale)}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("adminHome.billingPeriod", locale)} htmlFor="billing_period">
                      <Select id="billing_period" name="billing_period" defaultValue={farm.billing_period}>
                        {BILLING_PERIODS.map((bp) => (
                          <option key={bp} value={bp}>{t(`billingPeriod.${bp}`, locale)}</option>
                        ))}
                      </Select>
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label={t("adminHome.farmStatus", locale)} htmlFor="status" hint={t("adminHome.activateByPayment", locale)}>
                        <Select id="status" name="status" defaultValue={farm.status}>
                          {/* What it is now (kept as is), and the two ways to switch it off. */}
                          <option value={farm.status}>{t("adminHome.keepStatus", locale).replace("{status}", t(`adminHome.farmStatusValue.${farm.status}`, locale))}</option>
                          {farm.status !== "suspended" ? <option value="suspended">{t("adminHome.farmStatusValue.suspended", locale)}</option> : null}
                          {farm.status !== "cancelled" ? <option value="cancelled">{t("adminHome.farmStatusValue.cancelled", locale)}</option> : null}
                        </Select>
                      </Field>
                    </div>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            }
          >
            <CardTitle>{t("adminHome.billingTitle", locale)}</CardTitle>
          </CardHeader>
          <FactList>
            <Fact label={t("adminHome.plan", locale)} value={t(planNameKey(farm.plan as (typeof PLANS)[number]), locale)} hint={t(`billingPeriod.${farm.billing_period}`, locale)} />
            <Fact label={t("adminHome.farmStatus", locale)} value={t(`adminHome.farmStatusValue.${farm.status}`, locale)} />
            <Fact
              label={t("adminHome.subscription", locale)}
              value={sub ? t(`adminHome.subStatus.${sub.status}`, locale) : t("adminHome.noSubscription", locale)}
              hint={sub?.discount_label ?? undefined}
            />
            {sub?.next_billing_on ? <Fact label={t("adminHome.nextCharge", locale)} value={shortDate(sub.next_billing_on, locale)} /> : null}
            {sub && sub.failed_attempt_count > 0 ? (
              <Fact label={t("adminHome.failedAttempts", locale)} value={num(sub.failed_attempt_count)} hint={sub.grace_ends_on ? t("adminHome.graceEnds", locale).replace("{when}", shortDate(sub.grace_ends_on, locale)) : undefined} />
            ) : null}
            <Fact label={t("adminHome.unpaidInvoices", locale)} value={unpaid.length ? `${num(unpaid.length)} · ${rands(unpaidCents)}` : t("adminHome.none", locale)} />
            <Fact label={t("adminHome.billableAssets", locale)} value={num(farm.asset_count)} />
          </FactList>
          <p className="mt-3 text-sm">
            <Link href={`/admin/billing?farm=${farm.id}`} className={link}>{t("adminHome.seeBilling", locale)}</Link>
          </p>
        </Card>
      </div>

      {/* == People ========================================================== */}
      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            <DialogForm
              trigger={t("adminHome.inviteAction", locale)}
              triggerIcon={<PlusIcon />}
              triggerVariant="secondary"
              triggerSize="sm"
              title={t("adminHome.inviteAction", locale)}
              description={t("adminHome.inviteHint", locale).replace("{farm}", farm.name)}
              closeLabel={closeLabel}
              size="md"
            >
              <form action={adminInviteUser}>
                <RequestIdInput action="admin:invite" />
                <input type="hidden" name="farm_id" value={farm.id} />
                <DialogFields>
                  <Field label={t("adminHome.personName", locale)} htmlFor="inv-name" required><Input id="inv-name" name="name" required /></Field>
                  <Field label={t("support.channelEmail", locale)} htmlFor="inv-email" required><Input id="inv-email" name="email" type="email" required /></Field>
                  <Field label={t("adminHome.role", locale)} htmlFor="inv-role">
                    <Select id="inv-role" name="role" defaultValue={owners.length ? "manager" : "owner"}>
                      {["owner", "manager", "mechanic", "operator"].map((r) => (
                        <option key={r} value={r}>{roleLabel(r, locale)}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("adminHome.language", locale)} htmlFor="inv-lang">
                    <Select id="inv-lang" name="language" defaultValue={inviteLanguage}>
                      <option value="af">{t("settings.afrikaans", locale)}</option>
                      <option value="en">{t("settings.english", locale)}</option>
                    </Select>
                  </Field>
                </DialogFields>
                <DialogActions cancelLabel={cancelLabel}>
                  <SubmitButton variant="primary">{t("adminHome.inviteSend", locale)}</SubmitButton>
                </DialogActions>
              </form>
            </DialogForm>
          }
        >
          <CardTitle>{t("adminHome.peopleTitle", locale)}</CardTitle>
        </CardHeader>
        {client.people.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-600">{t("adminHome.noPeople", locale)}</p>
        ) : (
          <Table stacked>
            <Thead>
              <Tr>
                <Th>{t("adminHome.personName", locale)}</Th>
                <Th>{t("adminHome.role", locale)}</Th>
                <Th>{t("adminHome.lastSignIn", locale)}</Th>
                <Th>{t("adminHome.whatsapp", locale)}</Th>
                <Th>{t("adminHome.access", locale)}</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {client.people.map((p) => (
                <Tr key={p.id}>
                  <Td label={t("adminHome.personName", locale)}>
                    <span className="block font-medium text-ink">{p.name}</span>
                    {p.email ? <span className="block break-all text-xs text-sand-600">{p.email}</span> : null}
                  </Td>
                  <Td label={t("adminHome.role", locale)}>
                    {roleLabel(p.role, locale)}
                    {!p.home ? <span className="block text-xs text-sand-600">{t("adminHome.memberElsewhere", locale)}</span> : null}
                  </Td>
                  <Td label={t("adminHome.lastSignIn", locale)}>
                    {p.last_sign_in_at ? dateTime(p.last_sign_in_at, locale) : <Badge tone="info">{t("adminHome.invitePending", locale)}</Badge>}
                  </Td>
                  <Td label={t("adminHome.whatsapp", locale)}>
                    {p.whatsapp_linked ? t(p.whatsapp_alerts ? "adminHome.waAlertsOn" : "adminHome.waLinked", locale) : t("adminHome.waNotLinked", locale)}
                  </Td>
                  <Td label={t("adminHome.access", locale)}>
                    {p.active ? <Badge tone="ok">{t("adminHome.active", locale)}</Badge> : <Badge tone="danger">{t("adminHome.switchedOff", locale)}</Badge>}
                  </Td>
                  <Td className="text-right">
                    <ActionMenu title={p.name} label={t("common.actions", locale)} closeLabel={closeLabel}>
                      {p.email && p.active ? (
                        <ConfirmDialog
                          action={adminResendInvite}
                          triggerLook="menuItem"
                          triggerLabel={t("adminHome.resendInvite", locale)}
                          title={t("adminHome.resendTitle", locale).replace("{name}", p.name)}
                          intro={t("adminHome.resendBody", locale).replace("{email}", p.email)}
                          confirmLabel={t("adminHome.resendInvite", locale)}
                          cancelLabel={cancelLabel}
                          closeLabel={closeLabel}
                          tone="brand"
                        >
                          <RequestIdInput action="admin:resend-invite" />
                          <input type="hidden" name="farm_id" value={farm.id} />
                          <input type="hidden" name="user_id" value={p.id} />
                        </ConfirmDialog>
                      ) : null}
                      <ConfirmDialog
                        action={adminSetUserActive}
                        triggerLook="menuItem"
                        triggerLabel={p.active ? t("adminHome.deactivate", locale) : t("adminHome.activate", locale)}
                        title={(p.active ? t("adminHome.deactivateTitle", locale) : t("adminHome.activateTitle", locale)).replace("{name}", p.name)}
                        intro={p.active ? t("adminHome.deactivateBody", locale) : t("adminHome.activateBody", locale)}
                        confirmLabel={p.active ? t("adminHome.deactivate", locale) : t("adminHome.activate", locale)}
                        cancelLabel={cancelLabel}
                        closeLabel={closeLabel}
                        tone={p.active ? "danger" : "brand"}
                      >
                        <input type="hidden" name="farm_id" value={farm.id} />
                        <input type="hidden" name="user_id" value={p.id} />
                        <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                      </ConfirmDialog>
                    </ActionMenu>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {/* == Support cases ===================================================== */}
      <Card flush>
        <CardHeader
          className="px-4 pt-4"
          action={
            client.people.length ? (
              <DialogForm
                trigger={t("adminHome.newTicket", locale)}
                triggerIcon={<PlusIcon />}
                triggerVariant="secondary"
                triggerSize="sm"
                title={t("adminHome.newTicket", locale)}
                description={t("adminHome.newTicketHint", locale)}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={openTicketForClient}>
                  <RequestIdInput action="support:open-for-client" />
                  <input type="hidden" name="farm_id" value={farm.id} />
                  <DialogFields>
                    <Field label={t("adminHome.newTicketPerson", locale)} htmlFor="nt-person">
                      <Select id="nt-person" name="user_id" defaultValue={owners[0]?.id ?? client.people[0]?.id}>
                        {client.people.filter((p) => p.active).map((p) => (
                          <option key={p.id} value={p.id}>{`${p.name} (${roleLabel(p.role, locale)})`}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("adminHome.newTicketChannel", locale)} htmlFor="nt-channel">
                      <Select id="nt-channel" name="channel" defaultValue="phone">
                        {["phone", "whatsapp", "email", "in_person"].map((c) => (
                          <option key={c} value={c}>{t(`support.channel.${c}`, locale)}</option>
                        ))}
                      </Select>
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label={t("support.askKind", locale)} htmlFor="nt-kind">
                        <Select id="nt-kind" name="kind" defaultValue="help_request">
                          {["help_request", "privacy_request", "export_request"].map((k) => (
                            <option key={k} value={k}>{t(`support.kind.${k}`, locale)}</option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label={t("help.subject", locale)} htmlFor="nt-subject" required>
                        <Input id="nt-subject" name="subject" required maxLength={200} />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label={t("adminHome.newTicketSummary", locale)} htmlFor="nt-message" hint={t("adminHome.newTicketSummaryHint", locale)} required>
                        <Textarea id="nt-message" name="message" required rows={5} maxLength={4000} />
                      </Field>
                    </div>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("adminHome.newTicketSave", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null
          }
        >
          <CardTitle>{t("adminHome.ticketsTitle", locale)}</CardTitle>
        </CardHeader>
        {tickets.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-sand-600">{t("adminHome.noTickets", locale)}</p>
        ) : (
          <ul className="divide-y divide-sand-200">
            {tickets.map((tk) => {
              const due = dueState(tk.next_due, now);
              return (
                <li key={tk.id}>
                  <Link href={`/admin/support/${tk.id}`} className="focus-ring flex flex-wrap items-start justify-between gap-2 px-4 py-3 hover:bg-surface-hover">
                    <span className="min-w-0">
                      <span className="block break-words font-medium text-ink">{tk.subject}</span>
                      <span className="block text-xs text-sand-600">
                        {t(`support.kind.${tk.kind}`, locale)} · {dateTime(tk.opened_at, locale)}
                        {tk.asked_by_name ? ` · ${tk.asked_by_name}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {due === "overdue" || due === "today" ? (
                        <Badge tone={due === "overdue" ? "danger" : "warning"}>{t(`support.due.${due}`, locale)}</Badge>
                      ) : null}
                      <StaffStatusBadge status={tk.status} locale={locale} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* == Use and channels ================================================= */}
      <section className="flex flex-col gap-3" aria-labelledby="client-usage">
        <h2 id="client-usage" className="text-base font-bold text-sand-900">{t("adminHome.usageTitle", locale)}</h2>
        <StatGrid columns={4}>
          <Stat label={t("adminHome.machines", locale)} value={num(client.usage.machines)} />
          <Stat label={t("adminHome.openFaults", locale)} value={num(client.usage.open_faults)} tone={client.usage.open_faults ? "due" : "default"} />
          <Stat label={t("adminHome.jobs30d", locale)} value={num(client.usage.jobs_30d)} />
          <Stat
            label={t("adminHome.lastActivity", locale)}
            value={client.usage.last_activity ? shortDate(client.usage.last_activity, locale) : t("adminHome.never", locale)}
            valueKind="text"
          />
          <Stat label={t("adminHome.aiCalls", locale)} value={num(client.usage.ai_calls_month)} />
          <Stat label={t("adminHome.aiFailed", locale)} value={num(client.usage.ai_failed_month)} tone={client.usage.ai_failed_month ? "overdue" : "default"} />
          <Stat label={t("adminHome.aiBilled", locale)} value={rands(client.usage.ai_billed_cents_month)} size="md" />
          <Stat label={t("adminHome.waLinkedPeople", locale)} value={`${num(client.channels.whatsapp_linked)} / ${num(client.channels.whatsapp_alerts)}`} delta={t("adminHome.waLinkedHint", locale)} />
        </StatGrid>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle>{t("adminHome.deliveryTitle", locale)}</CardTitle>
          <FactList className="mt-2">
            <Fact label={t("adminHome.emailFailures", locale)} value={num(client.channels.email_failures_7d)} />
            <Fact label={t("adminHome.whatsappFailures", locale)} value={num(client.channels.whatsapp_failures_7d)} />
          </FactList>
          {client.channels.recent_failures.length ? (
            <ul className="mt-3 flex flex-col divide-y divide-sand-200 text-sm">
              {client.channels.recent_failures.map((f, i) => (
                <li key={`${f.at}-${i}`} className="flex flex-wrap justify-between gap-x-3 py-1.5">
                  <span>{t(`support.channel.${f.channel === "email" ? "email" : "whatsapp"}`, locale)} · {f.template}</span>
                  <span className="break-all text-sand-600">{f.error ?? "-"} · {dateTime(f.at, locale)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-sand-600">{t("adminHome.noFailures", locale)}</p>
          )}
        </Card>

        <Card>
          <CardTitle>{t("adminHome.visitsTitle", locale)}</CardTitle>
          {client.visits.length === 0 ? (
            <p className="mt-2 text-sm text-sand-600">{t("adminHome.noVisits", locale)}</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-sand-200 text-sm">
              {client.visits.map((v) => (
                <li key={v.id} className="flex flex-col gap-0.5 py-2">
                  <span className="font-medium text-ink">{v.reason}</span>
                  <span className="text-xs text-sand-600">
                    {v.admin_name ?? t("adminHome.rapidRise", locale)} · {dateTime(v.started_at, locale)}
                    {v.ended_at ? ` · ${t("adminHome.visitEnded", locale).replace("{when}", dateTime(v.ended_at, locale))}` : ` · ${t("adminHome.visitOpen", locale)}`}
                    {v.ticket_id ? (
                      <>
                        {" · "}
                        <Link href={`/admin/support/${v.ticket_id}`} className={link}>{t("adminHome.visitCaseLink", locale)}</Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
