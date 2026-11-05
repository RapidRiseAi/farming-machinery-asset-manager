import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { daysAgo, relativeDate } from "@/lib/format";
import { dateExpiryStatus, licenceTypeLabel, warrantyStatus } from "@/lib/compliance";
import type { DashData } from "@/lib/dashboard/data";
import { withTab } from "@/components/ui/tabs-url";
import { buttonVariants } from "@/components/ui/button";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { AllClear } from "@/components/ui/empty-state";
import { ChevronRightIcon } from "@/components/ui/icons";
import { ExpiryStatus, FineStatus, ServiceStatus, UrgencyStatus } from "@/components/ui/status";

/**
 * "Needs your attention": one ranked list, worst first, one row per machine. Each thing
 * to do carries where to do it: the exact tab or row, not just the machine page, which
 * used to leave the owner hunting for the action the button had just named.
 *
 * Moved here from the dashboard page when the dashboard became a board of widgets; the
 * ranking is unchanged. Retired and sold machines drop out, as everywhere.
 */
export type Attend = {
  key: string;
  rank: number;
  /** Tie-break inside a rank: the deadline or the date it started, oldest first. */
  sortDate: string;
  machineId: string;
  machineName: string;
  detail: string;
  /** A system fact beside the person's words (when it was reported), never run into them. */
  meta?: string;
  status: { kind: "urgency" | "service" | "expiry" | "fine"; value: string };
  ctaLabel: string;
  ctaHref: string;
};
export type AttendGroup = { machineId: string; items: Attend[] };

const URGENCY_RANK: Record<string, number> = { stopped: 0, limping: 3, can_work: 5 };
const capitalise = (s: string) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

export function buildAttention(d: DashData, locale: Lang, finesAllowed: boolean): { total: number; groups: AttendGroup[] } {
  const now = d.now;
  const active = d.machines.filter((m) => m.status !== "retired" && m.status !== "sold");
  const ids = new Set(active.map((m) => m.id));
  const name = (id: string) => d.machines.find((m) => m.id === id)?.name ?? "-";
  const machineHref = (id: string) => `/machines/${id}`;
  const out: Attend[] = [];

  for (const f of d.faults) {
    if (f.status === "resolved" || !ids.has(f.machine_id)) continue;
    out.push({
      key: `f-${f.id}`, rank: URGENCY_RANK[f.urgency ?? ""] ?? 4, sortDate: f.created_at,
      machineId: f.machine_id, machineName: name(f.machine_id),
      detail: capitalise((f.description ?? "").trim()) || t(`urgency.${f.urgency ?? "can_work"}`, locale),
      meta: t("dashboard.reportedOn", locale).replace("{when}", relativeDate(f.created_at, locale, now)),
      status: { kind: "urgency", value: f.urgency ?? "can_work" },
      ctaLabel: t("faults.makeJobCard", locale), ctaHref: `/faults#fault-${f.id}`,
    });
  }
  for (const l of d.service) {
    if (!ids.has(l.machine_id) || (l.status !== "overdue" && l.status !== "due_soon")) continue;
    out.push({
      key: `s-${l.machine_id}-${l.task}`, rank: l.status === "overdue" ? 1 : 4, sortDate: l.next_due_date ?? "9999-12-31",
      machineId: l.machine_id, machineName: name(l.machine_id),
      detail: t(l.status === "overdue" ? "dashboard.serviceOverdueDetail" : "dashboard.serviceDueDetail", locale).replace("{task}", l.task),
      status: { kind: "service", value: l.status },
      ctaLabel: t("dashboard.ctaBookService", locale), ctaHref: withTab(machineHref(l.machine_id), "servicing"),
    });
  }
  const expiry = (key: string, machineId: string, label: string, date: string, st: "expiring" | "expired") =>
    out.push({
      key: `e-${key}`, rank: st === "expired" ? 2 : 4, sortDate: date || "9999-12-31",
      machineId, machineName: name(machineId),
      detail: `${label} · ${t(st === "expired" ? "dashboard.expiredOn" : "dashboard.expiresOn", locale).replace("{when}", relativeDate(date, locale, now))}`,
      status: { kind: "expiry", value: st },
      ctaLabel: t("dashboard.ctaSeeMachine", locale), ctaHref: withTab(machineHref(machineId), "papers"),
    });
  for (const m of active) {
    const st = warrantyStatus(m);
    if (st === "expiring" || st === "expired") expiry(`w-${m.id}`, m.id, t("compliance.warranty", locale), m.warranty_expiry_date ?? "", st);
  }
  for (const l of d.licences) {
    if (!ids.has(l.machine_id)) continue;
    const st = dateExpiryStatus(l.expiry_date, l.reminder_lead_days);
    if (st === "expiring" || st === "expired") expiry(`l-${l.id}`, l.machine_id, licenceTypeLabel(l.type, locale), l.expiry_date, st);
  }
  if (finesAllowed) {
    for (const f of d.fines) {
      if (!ids.has(f.machine_id)) continue;
      // Ranked by the legal deadline, not by kind: a nomination due this week outranks a
      // service merely due soon, and an overdue one is nearly as bad as a stopped machine,
      // because the fine transfers to the owner.
      const daysLeft = f.nomination_deadline ? -(daysAgo(f.nomination_deadline, now) ?? 0) : null;
      const label = f.offence || f.notice_number || t("fines.noOffence", locale);
      out.push({
        key: `n-${f.id}`, rank: daysLeft == null ? 6 : daysLeft <= 7 ? 1 : daysLeft <= 30 ? 4 : 6,
        sortDate: f.nomination_deadline ?? "9999-12-31", machineId: f.machine_id, machineName: name(f.machine_id),
        detail: f.nomination_deadline
          ? `${label} · ${t("dashboard.nominationDue", locale).replace("{when}", relativeDate(f.nomination_deadline, locale, now))}`
          : label,
        status: { kind: "fine", value: f.status },
        ctaLabel: t("dashboard.ctaNominateDriver", locale), ctaHref: `/fines#fine-${f.id}`,
      });
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.sortDate.localeCompare(b.sortDate) || a.machineName.localeCompare(b.machineName));

  // One row per machine. The list is already worst-first, so a machine's first item is its
  // worst, and the group order follows it.
  const groups = new Map<string, Attend[]>();
  for (const a of out) {
    const list = groups.get(a.machineId);
    if (list) list.push(a);
    else groups.set(a.machineId, [a]);
  }
  return { total: out.length, groups: [...groups.entries()].map(([machineId, items]) => ({ machineId, items })) };
}

export function AttentionList({ groups, locale }: { groups: AttendGroup[]; locale: Lang }) {
  if (groups.length === 0) {
    return <AllClear title={t("dashboard.allClearTitle", locale)} hint={t("dashboard.allClearHint", locale)} />;
  }
  const badge = (s: Attend["status"]) =>
    s.kind === "urgency" ? <UrgencyStatus value={s.value} locale={locale} />
    : s.kind === "service" ? <ServiceStatus value={s.value} locale={locale} />
    : s.kind === "expiry" ? <ExpiryStatus value={s.value} locale={locale} />
    : <FineStatus value={s.value} locale={locale} />;
  return (
    <ul className="-mx-4 flex h-full min-h-0 flex-col divide-y divide-sand-100 overflow-y-auto">
      {groups.map((g) => {
        const [top, ...rest] = g.items;
        return (
          <li key={g.machineId} className="flex items-stretch">
            <Link href={top.ctaHref} className="focus-ring flex min-h-[56px] min-w-0 flex-1 items-center gap-3 px-4 py-2.5 hover:bg-surface-hover">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-words font-semibold text-sand-900">{top.machineName}</span>
                  {badge(top.status)}
                </span>
                <span className="mt-0.5 line-clamp-2 text-sm text-sand-700">
                  {top.detail}
                  {top.meta ? <span className="text-sand-600"> · {top.meta}</span> : null}
                </span>
                {rest.length > 0 ? (
                  <span className="mt-0.5 line-clamp-1 text-sm text-sand-600">{rest.map((r) => `+ ${r.detail}`).join(" · ")}</span>
                ) : null}
              </span>
              <span className={buttonVariants({ variant: "secondary", size: "sm", className: "hidden shrink-0 xl:inline-flex" })}>{top.ctaLabel}</span>
              <ChevronRightIcon className="shrink-0 text-lg text-sand-400 xl:hidden" />
            </Link>
            {rest.length > 0 ? (
              <div className="flex shrink-0 items-center pr-2">
                <ActionMenu title={top.machineName} label={`${t("common.actions", locale)}: ${top.machineName}`} closeLabel={t("ui.close", locale)}>
                  {g.items.map((i) => (
                    <Link key={i.key} href={i.ctaHref} className={menuItemClass()}>
                      <span className="min-w-0">
                        <span className="block">{i.ctaLabel}</span>
                        <span className="block truncate text-xs font-normal text-sand-600">{i.detail}</span>
                      </span>
                    </Link>
                  ))}
                  <Link href={`/machines/${g.machineId}`} className={menuItemClass()}>{t("dashboard.ctaSeeMachine", locale)}</Link>
                </ActionMenu>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
