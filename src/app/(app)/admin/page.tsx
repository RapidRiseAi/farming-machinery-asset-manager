import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { must, mustAll } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime, num } from "@/lib/format";
import { supportAlertAddress } from "@/lib/support/emails";
import {
  CLIENT_STATES,
  clientState,
  countClientStates,
  isQuiet,
  latestSubscriptions,
  type ClientState,
} from "@/lib/support/client-state";

import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { Stat, StatGrid } from "@/components/ui/stat";
import { AllClear } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

type SupportOverview = {
  new: number;
  due_today: number;
  overdue: number;
  waiting: number;
  disputes: number;
  dispute_next_due: string | null;
  privacy: number;
  exports: number;
  attention: {
    id: string; subject: string; kind: string; farm_name: string | null; workshop_name: string | null;
    next_due: string; overdue: boolean; unanswered: boolean; is_test: boolean;
  }[];
};
type FarmRow = { id: string; name: string; status: string; is_test: boolean; created_at: string; deleted_at: string | null };
type SubRow = { farm_id: string; status: string; created_at: string };
type CronRow = { route: string; last_ok: boolean | null; failures_7d: number; last_finished_at: string | null };
type AiEvent = { id: string; kind: string; created_at: string };
type Activity = { farm_id: string; last_activity: string | null };

type Attention = { key: string; href: string; text: string; tone: "danger" | "warning" | "info"; tag: string };

/**
 * Rapid Rise's one dashboard: what needs a person today, across support, clients and the
 * machinery behind them. Every tile links to the screen that acts on it, and the list
 * under it names each thing (a case, a client, a failing job) with a link.
 *
 *   support   new and unanswered, due today, past due, waiting on the customer, disputes
 *             (support_overview, behind app.is_rr_support())
 *   clients   by where they stand with paying, from each farm's latest subscription
 *             (lib/support/client-state.ts), plus sign-ups that never paid
 *   health    scheduled jobs that failed (cron_health), open AI health events
 *   quiet     real farms with nothing recorded for two weeks
 *
 * Real clients by default; `?test=1` adds the test farms (the click-through's) back in.
 * Billing tables are read with the admin's own RLS, as /admin/billing reads them.
 */
export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; test?: string; denied?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const withTest = sp.test === "1";
  const supabase = await createClient();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const overviewData = must(await supabase.rpc("support_overview", { p_include_test: withTest }), "admin-overview:support");
  const support = overviewData as SupportOverview;

  const results = await Promise.all([
    readAll<FarmRow>(() => supabase.from("farms").select("id, name, status, is_test, created_at, deleted_at").order("name")),
    readAll<SubRow>(() => supabase.from("billing_subscriptions").select("farm_id, status, created_at").is("deleted_at", null).order("created_at")),
    readAll<Activity>(() => supabase.rpc("admin_farm_activity", { p_month_start: monthStart }), { key: "farm_id" }),
    supabase.rpc("cron_health"),
    supabase.from("ai_health_events").select("id, kind, created_at").is("resolved_at", null).order("created_at", { ascending: false }).limit(50),
  ]);
  // A failed read would show "all clear" on the one screen meant to say what is not.
  mustAll(results, "admin-overview:reads");
  const farms = (results[0].data as FarmRow[] | null) ?? [];
  const subs = (results[1].data as SubRow[] | null) ?? [];
  const activity = new Map(((results[2].data as Activity[] | null) ?? []).map((a) => [a.farm_id, a.last_activity]));
  const cron = (results[3].data as CronRow[] | null) ?? [];
  const aiEvents = (results[4].data as AiEvent[] | null) ?? [];

  const counts = countClientStates(farms, subs, withTest);
  const latest = latestSubscriptions(subs);
  const shown = farms.filter((f) => !f.deleted_at && (withTest || !f.is_test));
  const stateOf = (f: FarmRow): ClientState => clientState(f, latest.get(f.id) ?? null);
  const inGrace = shown.filter((f) => stateOf(f) === "grace");
  const awaiting = shown.filter((f) => stateOf(f) === "awaiting_payment");
  const quiet = shown.filter((f) => f.status !== "suspended" && f.status !== "cancelled" && isQuiet(activity.get(f.id), now, f.created_at));
  const cronProblems = cron.filter((c) => c.last_ok === false || Number(c.failures_7d) > 0);

  // == Needs attention, most urgent first ==========================================
  const attention: Attention[] = [
    ...support.attention.map((a) => ({
      key: `ticket-${a.id}`,
      href: `/admin/support/${a.id}`,
      text: `${a.subject} · ${a.farm_name ?? a.workshop_name ?? "-"} · ${dateTime(a.next_due, locale)}`,
      tone: (a.overdue ? "danger" : "warning") as Attention["tone"],
      tag: t(a.overdue ? "support.due.overdue" : a.unanswered ? "adminHome.tagUnanswered" : "support.due.today", locale),
    })),
    ...cronProblems.map((c) => ({
      key: `cron-${c.route}`,
      href: "/admin/billing",
      text: t("adminHome.cronFailing", locale).replace("{route}", c.route),
      tone: "danger" as const,
      tag: t("adminHome.tagHealth", locale),
    })),
    ...(aiEvents.length
      ? [{
          key: "ai",
          href: "/admin/ai",
          text: t("adminHome.aiEventsOpen", locale).replace("{n}", num(aiEvents.length)),
          tone: "warning" as const,
          tag: t("adminHome.tagHealth", locale),
        }]
      : []),
    ...inGrace.map((f) => ({
      key: `grace-${f.id}`,
      href: `/admin/farms/${f.id}`,
      text: t("adminHome.clientInGrace", locale).replace("{farm}", f.name),
      tone: "warning" as const,
      tag: t("adminHome.tagBilling", locale),
    })),
    ...awaiting.map((f) => ({
      key: `awaiting-${f.id}`,
      href: `/admin/farms/${f.id}`,
      text: t("adminHome.clientAwaiting", locale).replace("{farm}", f.name),
      tone: "info" as const,
      tag: t("adminHome.tagSignup", locale),
    })),
    ...quiet.slice(0, 10).map((f) => ({
      key: `quiet-${f.id}`,
      href: `/admin/farms/${f.id}`,
      text: t("adminHome.clientQuiet", locale).replace("{farm}", f.name),
      tone: "info" as const,
      tag: t("adminHome.tagQuiet", locale),
    })),
  ];

  const toggle = (
    <Link href={withTest ? "/admin" : "/admin?test=1"} className={buttonVariants({ variant: "secondary" })}>
      {t(withTest ? "adminHome.hideTest" : "adminHome.showTest", locale)}
    </Link>
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("adminHome.title", locale)}
        lead={t("adminHome.lead", locale)}
        meta={withTest ? t("adminHome.withTestMeta", locale) : t("adminHome.realOnlyMeta", locale)}
        actions={toggle}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {sp.denied ? <Flash tone="warning" message={t("errors.forbidden", locale)} /> : null}
      {supportAlertAddress() ? null : <Flash tone="info" clearParams={false} message={t("adminHome.alertEmailOff", locale)} />}

      <section className="flex flex-col gap-3" aria-labelledby="overview-support">
        <h2 id="overview-support" className="text-base font-bold text-sand-900">{t("adminHome.supportTitle", locale)}</h2>
        <StatGrid columns={4}>
          <Stat label={t("adminHome.tileNew", locale)} value={num(support.new)} tone={support.new ? "brand" : "default"} href="/admin/support?status=unanswered" />
          <Stat label={t("adminHome.tileDueToday", locale)} value={num(support.due_today)} tone={support.due_today ? "due" : "default"} href="/admin/support" />
          <Stat label={t("adminHome.tileOverdue", locale)} value={num(support.overdue)} tone={support.overdue ? "overdue" : "default"} href="/admin/support?status=overdue" />
          <Stat label={t("adminHome.tileWaiting", locale)} value={num(support.waiting)} href="/admin/support?status=waiting" />
          <Stat
            label={t("adminHome.tileDisputes", locale)}
            value={num(support.disputes)}
            tone={support.disputes ? "overdue" : "default"}
            delta={support.dispute_next_due ? t("adminHome.disputeNextDue", locale).replace("{when}", dateTime(support.dispute_next_due, locale)) : undefined}
            href="/admin/support?kind=dispute"
          />
          <Stat label={t("adminHome.tilePrivacy", locale)} value={num(support.privacy)} href="/admin/support?kind=privacy_request" />
          <Stat label={t("adminHome.tileExports", locale)} value={num(support.exports)} href="/admin/support?kind=export_request" />
        </StatGrid>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="overview-clients">
        <h2 id="overview-clients" className="text-base font-bold text-sand-900">{t("adminHome.clientsTitle", locale)}</h2>
        <StatGrid columns={4}>
          {CLIENT_STATES.map((s) => (
            <Stat
              key={s}
              label={t(`adminHome.state.${s}`, locale)}
              value={num(counts[s])}
              tone={s === "grace" && counts[s] ? "due" : s === "suspended" && counts[s] ? "overdue" : "default"}
              href={s === "awaiting_payment" || s === "grace" ? "/admin/billing" : "/admin/farms"}
            />
          ))}
          <Stat label={t("adminHome.tileQuiet", locale)} value={num(quiet.length)} tone={quiet.length ? "due" : "default"} href="/admin/farms" />
          <Stat
            label={t("adminHome.tileCron", locale)}
            value={cronProblems.length ? num(cronProblems.length) : t("adminHome.allRunning", locale)}
            valueKind={cronProblems.length ? "number" : "text"}
            tone={cronProblems.length ? "overdue" : "ok"}
            href="/admin/billing"
          />
          <Stat
            label={t("adminHome.tileAi", locale)}
            value={aiEvents.length ? num(aiEvents.length) : t("adminHome.nothingOpen", locale)}
            valueKind={aiEvents.length ? "number" : "text"}
            tone={aiEvents.length ? "due" : "ok"}
            href="/admin/ai"
          />
        </StatGrid>
      </section>

      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardTitle>{t("adminHome.attentionTitle", locale)}</CardTitle>
        </div>
        {attention.length === 0 ? (
          <div className="p-4 sm:p-5">
            <AllClear title={t("adminHome.attentionEmpty", locale)} hint={t("adminHome.attentionEmptyHint", locale)} />
          </div>
        ) : (
          <ul className="divide-y divide-sand-200">
            {attention.map((a) => (
              <li key={a.key}>
                <Link href={a.href} className="focus-ring flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-surface-hover sm:px-5">
                  <span className="min-w-0 break-words text-sm text-ink">{a.text}</span>
                  <Badge tone={a.tone}>{a.tag}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
