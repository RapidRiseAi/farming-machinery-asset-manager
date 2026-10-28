import Link from "next/link";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { dateTime } from "@/lib/format";
import { dueState } from "@/lib/support/sla";
import { supportAlertAddress } from "@/lib/support/emails";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { AllClear, FilteredEmpty } from "@/components/ui/empty-state";
import { Disclosure } from "@/components/ui/disclosure";
import { FilterBar } from "@/components/ui/filter-bar";
import { filterState, type FilterGroup } from "@/components/ui/filter-state";
import { buttonVariants } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { StaffStatusBadge } from "@/components/support/support-parts";

/**
 * The support queue: every case Rapid Rise has, worked here.
 *
 * Founder default (2026-10-28): the Fleet Wise admin is the system of record. A customer's
 * question, a privacy or export request, a case logged from a phone call, and the card
 * disputes and refunds the billing engine opens all land in one list, ordered by what is
 * due first. Opening one shows the conversation and the client, with reply, note, assign
 * and resolve (`/admin/support/[id]`).
 *
 * Real clients only unless the test switch is on: the click-through opens a test case on
 * every run, and a test case never alerts anyone.
 *
 * Read through `public.support_queue` with the admin's own session: SECURITY DEFINER
 * behind `app.is_rr_support()` (two-step, never a test account).
 */
export const dynamic = "force-dynamic";

type QueueRow = {
  id: string;
  kind: string;
  status: string;
  subject: string;
  farm_id: string | null;
  farm_name: string | null;
  workshop_name: string | null;
  asked_by_name: string | null;
  channel: string;
  assigned_name: string | null;
  opened_at: string;
  next_due: string | null;
  first_response_at: string | null;
  needs_reply: boolean;
  is_test: boolean;
};

const STATUS_FILTERS = ["unanswered", "overdue", "waiting", "resolved", "all"] as const;
const KINDS = ["help_request", "privacy_request", "export_request", "dispute", "refund_request", "billing_anomaly", "manual"] as const;

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string; kind?: string; who?: string; test?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;

  const status = (STATUS_FILTERS as readonly string[]).includes(sp.status ?? "") ? sp.status! : "";
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? sp.kind! : "";
  const who = sp.who === "me" || sp.who === "none" ? sp.who : "";
  const showTest = sp.test === "1";

  const supabase = await createClient();
  const data = must(
    await supabase.rpc("support_queue", {
      p_status: status || "active",
      p_kind: kind || null,
      p_assignee: who || null,
      p_include_test: showTest,
    }),
    "admin-support:queue",
  );
  const rows = (data as QueueRow[] | null) ?? [];
  const now = new Date();

  const search = new URLSearchParams(
    Object.entries({ status, kind, who, test: showTest ? "1" : "" }).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const groups: FilterGroup[] = [
    {
      paramName: "status",
      label: t("support.filterStatus", locale),
      current: status,
      options: [
        { value: "", label: t("support.filter.active", locale) },
        ...STATUS_FILTERS.map((s) => ({ value: s, label: t(`support.filter.${s}`, locale) })),
      ],
    },
    {
      paramName: "kind",
      label: t("support.filterKind", locale),
      current: kind,
      options: [{ value: "", label: t("filters.all", locale) }, ...KINDS.map((k) => ({ value: k, label: t(`support.kind.${k}`, locale) }))],
    },
    {
      paramName: "who",
      label: t("support.filterAssignee", locale),
      current: who,
      options: [
        { value: "", label: t("filters.all", locale) },
        { value: "me", label: t("support.assigneeMe", locale) },
        { value: "none", label: t("support.assigneeNone", locale) },
      ],
    },
    {
      paramName: "test",
      label: t("adminHome.testFilter", locale),
      current: showTest ? "1" : "",
      options: [
        { value: "", label: t("adminHome.realOnly", locale) },
        { value: "1", label: t("adminHome.withTest", locale) },
      ],
    },
  ];
  const filtered = filterState("/admin/support", search, groups);
  const alertEmail = supportAlertAddress();

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("support.queueTitle", locale)}
        lead={t("support.queueLead", locale)}
        infoKey="adminSupport"
        locale={locale}
        actions={
          <Link href="/admin/support/settings" className={buttonVariants({ variant: "secondary" })}>
            {t("support.settingsLink", locale)}
          </Link>
        }
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      {alertEmail ? null : <Flash tone="info" clearParams={false} message={t("adminHome.alertEmailOff", locale)} />}

      <FilterBar
        path="/admin/support"
        search={search}
        groups={groups}
        filtersLabel={t("filters.filters", locale)}
        clearLabel={t("filters.clear", locale)}
        rememberKey="admin-support"
      />

      {rows.length === 0 ? (
        <FilteredEmpty
          filtered={filtered.active}
          clearHref={filtered.clearHref}
          title={t("empty.noMatchTitle", locale)}
          hint={t("empty.noMatchHint", locale)}
          clearLabel={t("empty.clearFilters", locale)}
        >
          <AllClear title={t("support.queueEmptyTitle", locale)} hint={t("support.queueEmptyHint", locale)} />
        </FilteredEmpty>
      ) : (
        <Card flush>
          <Table stacked>
            <Thead>
              <Tr>
                <Th>{t("support.colCase", locale)}</Th>
                <Th>{t("support.colWho", locale)}</Th>
                <Th>{t("support.colDue", locale)}</Th>
                <Th>{t("support.colAssignee", locale)}</Th>
                <Th>{t("support.colStatus", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((r) => {
                const due = dueState(r.next_due, now);
                return (
                  <Tr key={r.id}>
                    <Td label={t("support.colCase", locale)}>
                      <Link href={`/admin/support/${r.id}`} className="focus-ring rounded font-medium text-brand-ink hover:underline">
                        {r.subject}
                      </Link>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge tone="neutral">{t(`support.kind.${r.kind}`, locale)}</Badge>
                        {r.channel !== "in_app" && r.channel !== "system" ? (
                          <Badge tone="info">{t(`support.channel.${r.channel}`, locale)}</Badge>
                        ) : null}
                        {r.is_test ? <Badge tone="warning">{t("adminHome.testBadge", locale)}</Badge> : null}
                      </span>
                    </Td>
                    <Td label={t("support.colWho", locale)}>
                      <span className="block">{r.farm_name ?? r.workshop_name ?? "-"}</span>
                      {r.asked_by_name ? <span className="block text-xs text-sand-600">{r.asked_by_name}</span> : null}
                    </Td>
                    <Td label={t("support.colDue", locale)}>
                      {due === "none" ? (
                        <span className="text-sand-600">{t("support.dueNothing", locale)}</span>
                      ) : (
                        <span className={due === "overdue" ? "font-medium text-status-overdue" : due === "today" ? "font-medium text-status-due" : ""}>
                          {t(`support.due.${due}`, locale)}
                          <span className="block text-xs font-normal text-sand-600">{dateTime(r.next_due, locale)}</span>
                        </span>
                      )}
                    </Td>
                    <Td label={t("support.colAssignee", locale)}>{r.assigned_name ?? <span className="text-sand-600">{t("support.assigneeNone", locale)}</span>}</Td>
                    <Td label={t("support.colStatus", locale)}>
                      <StaffStatusBadge status={r.status} locale={locale} />
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Card>
      )}

      {/* The answers disputes and refunds usually get, kept from the read-only page. */}
      <Disclosure summary={t("adminSupport.policyTitle", locale)}>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-sand-700">
          <li>{t("adminSupport.policyDowngrade", locale)}</li>
          <li>{t("adminSupport.policyCancel", locale)}</li>
          <li>{t("adminSupport.policyRefund", locale)}</li>
          <li>{t("adminSupport.policyDispute", locale)}</li>
        </ul>
      </Disclosure>
    </PageContainer>
  );
}
