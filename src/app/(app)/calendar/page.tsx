import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { enumLabel, shortDate } from "@/lib/format";
import {
  byDay,
  isMonth,
  itemHref,
  leadingBlanks,
  monthDays,
  monthRange,
  monthTotals,
  shiftMonth,
  stateLook,
  worstState,
  type CalendarItem,
} from "@/lib/calendar";

import { Card, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

const WEEKDAY_KEYS = [
  "calendar.weekMon",
  "calendar.weekTue",
  "calendar.weekWed",
  "calendar.weekThu",
  "calendar.weekFri",
  "calendar.weekSat",
  "calendar.weekSun",
] as const;

/** The dot colour for a day cell. One scale, matching the badges below it. */
const DOT: Record<string, string> = {
  overdue: "bg-status-overdue",
  due_soon: "bg-status-due",
  ok: "bg-status-ok",
};

/**
 * What is due and what is booked, a month at a time.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Everything here already existed, one screen at a time. Services carry a next-due date,
 * job cards carry a date in, licences and driver documents carry expiry dates. What nobody
 * could see is the WEEK: that the annual service, the roadworthy and a PrDP all land in
 * the fortnight the wheat has to come off. That is the whole point of a calendar on a farm.
 *
 * ── Grid and agenda, not grid or agenda ──────────────────────────────────────
 * A seven-column month grid at 360px gives each day about 44px, which is enough for a
 * number and a dot and nothing else. So the grid is the OVERVIEW, showing where the
 * pressure is, and the agenda beneath it is the detail, in reading order, skipping empty
 * days. Both come from the same grouping, so they cannot disagree.
 *
 * ── Every row is a link ──────────────────────────────────────────────────────
 * A planner who taps a day wants to act on it, and the thing to act on is the job card,
 * the machine or the personnel screen.
 *
 * ── No money on it ───────────────────────────────────────────────────────────
 * `farm_calendar` returns none. A job card's total is behind `app.can_view_farm_costs`,
 * and a calendar carrying amounts would be a second door onto it.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);

  const today = new Date().toISOString().slice(0, 10);
  // Validated before it is trusted: `?m=` is a query parameter and reaches a SQL date.
  const month = isMonth(sp.m) ? sp.m : today.slice(0, 7);
  const { from, to } = monthRange(month);

  const supabase = await createClient();
  const { data } = farmId
    ? await supabase.rpc("farm_calendar", { p_farm: farmId, p_from: from, p_to: to })
    : { data: [] };
  const items = (data as CalendarItem[] | null) ?? [];

  const grouped = byDay(items);
  const totals = monthTotals(items);
  const blanks = leadingBlanks(month);
  const days = monthDays(month);
  const monthLabel = shortDate(`${month}-01`, locale);

  const navLink = (target: string, label: string, icon: React.ReactNode) => (
    <Link
      href={`/calendar?m=${target}`}
      aria-label={label}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      {icon}
    </Link>
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
            {t("calendar.title", locale)}
          </h1>
          <PageInfoButton infoKey="calendar" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-600">{t("calendar.lead", locale)}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label={t("calendar.statOverdue", locale)}
          value={String(totals.overdue)}
          tone={totals.overdue > 0 ? "overdue" : "default"}
        />
        <Stat
          label={t("calendar.statDueSoon", locale)}
          value={String(totals.dueSoon)}
          tone={totals.dueSoon > 0 ? "due" : "default"}
        />
        <Stat label={t("calendar.statTotal", locale)} value={String(totals.total)} />
      </div>

      {/* The month, and the way through it. The label is the month itself rather than a
          heading above it, so the control and the thing it controls are one row. */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          {navLink(shiftMonth(month, -1), t("calendar.prevMonth", locale), <ChevronLeftIcon />)}
          <div className="min-w-0 text-center">
            <p className="truncate text-base font-semibold text-ink">{monthLabel}</p>
            {month !== today.slice(0, 7) ? (
              <Link
                href="/calendar"
                className="text-xs font-medium text-brand-ink underline underline-offset-2"
              >
                {t("calendar.thisMonth", locale)}
              </Link>
            ) : null}
          </div>
          {navLink(shiftMonth(month, 1), t("calendar.nextMonth", locale), <ChevronRightIcon />)}
        </div>

        {/* The overview. Seven columns at any width: at 360px each day gets about 44px,
            which is a number and a dot, and that is exactly what an overview is for. */}
        <div className="mt-4 grid grid-cols-7 gap-1 text-center">
          {WEEKDAY_KEYS.map((k) => (
            <div key={k} className="pb-1 text-xs font-medium uppercase tracking-wide text-sand-500">
              {t(k, locale)}
            </div>
          ))}
          {Array.from({ length: blanks }).map((_, i) => (
            <div key={`blank-${i}`} aria-hidden />
          ))}
          {days.map((day) => {
            const onDay = grouped.get(day) ?? [];
            const worst = worstState(onDay);
            const isToday = day === today;
            return (
              <div
                key={day}
                className={`flex min-h-11 flex-col items-center justify-center rounded-lg py-1 ${
                  isToday ? "bg-sand-100 ring-1 ring-brand-600" : ""
                }`}
              >
                <span
                  className={`text-sm tabular-nums ${
                    onDay.length ? "font-semibold text-ink" : "text-sand-400"
                  }`}
                >
                  {Number(day.slice(8))}
                </span>
                {/* One dot for the day, coloured by the worst thing on it, plus a count
                    when there is more than one. Three dots at this size is a smudge. */}
                {worst ? (
                  <span className="mt-0.5 flex items-center gap-0.5">
                    <span className={`size-1.5 rounded-full ${DOT[worst]}`} aria-hidden />
                    {onDay.length > 1 ? (
                      <span className="text-xs leading-none text-sand-500">{onDay.length}</span>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      {items.length === 0 ? (
        <GetStarted
          title={t("calendar.emptyTitle", locale)}
          hint={t("calendar.emptyBody", locale)}
        />
      ) : (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("calendar.agendaTitle", locale)}</CardTitle>
          </div>
          <ul className="divide-y divide-sand-200">
            {days
              .filter((d) => grouped.has(d))
              .map((day) => (
                <li key={day} className="p-4 sm:p-5">
                  <p className="text-sm font-semibold text-ink">
                    {shortDate(day, locale)}
                    {day === today ? (
                      <span className="ml-2 text-xs font-medium text-brand-ink">
                        {t("calendar.today", locale)}
                      </span>
                    ) : null}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {(grouped.get(day) ?? []).map((i) => {
                      const look = stateLook(i.state);
                      return (
                        <li key={`${i.kind}-${i.item_id}`}>
                          <Link
                            href={itemHref(i)}
                            className="focus-ring flex flex-wrap items-start justify-between gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-ink">
                                {i.title ?? enumLabel("calendarKind", i.kind, locale)}
                              </span>
                              <span className="mt-0.5 block text-xs text-sand-600">
                                {enumLabel("calendarKind", i.kind, locale)}
                                {i.machine_name ? ` · ${i.machine_name}` : ""}
                                {i.kind === "job_card" && i.detail
                                  ? ` · ${t("calendar.atWorkshop", locale).replace("{name}", i.detail)}`
                                  : i.detail
                                    ? ` · ${i.detail}`
                                    : ""}
                              </span>
                            </span>
                            <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
