import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { enumLabel, meterReading, shortDate, todayLocal } from "@/lib/format";
import { longMonthYear } from "@/lib/month-names";
import {
  byDay,
  firstUpcoming,
  isMonth,
  itemHref,
  leadingBlanks,
  lookaheadRange,
  lookbackRange,
  monthDays,
  monthRange,
  monthTotals,
  shiftMonth,
  stateLook,
  worstState,
  type CalendarItem,
  type CalendarState,
} from "@/lib/calendar";

import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { withTab } from "@/components/ui/tabs-url";
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

/** A service line that is due by the meter and has no date to put on the grid. */
type HoursLine = {
  id: string;
  machine_id: string;
  task: string;
  status: string;
  next_due_reading: number | null;
};

/**
 * What is due and what is booked, a month at a time.
 *
 * == The gap this closes ======================================================
 * Everything here already existed, one screen at a time. Services carry a next-due date,
 * job cards carry a date in, licences and driver documents carry expiry dates. What nobody
 * could see is the WEEK: that the annual service, the roadworthy and a PrDP all land in
 * the fortnight the wheat has to come off. That is the whole point of a calendar on a farm.
 *
 * == Grid and agenda, not grid or agenda ======================================
 * A seven-column month grid at 360px gives each day about 44px, which is enough for a
 * number and a dot and nothing else. So the grid is the OVERVIEW, showing where the
 * pressure is, and the agenda beneath it is the detail, in reading order, skipping empty
 * days. Both come from the same grouping, so they cannot disagree. From `sm` up a busy day
 * is a link to its agenda rows; on a phone a 44px cell is under the 48px tap floor, so it
 * stays a picture and the agenda is right below it.
 *
 * == The current month carries what is late ==================================
 * `farm_calendar` answers for one range, so a service that fell overdue in July vanished
 * in September and the page said "Overdue 0" beside a dashboard listing two. The current
 * month now opens with the overdue work carried over from the year before, and with the
 * services due by the meter that have no date at all.
 *
 * == No money on it ===========================================================
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

  const today = todayLocal();
  const thisMonth = today.slice(0, 7);
  // Validated before it is trusted: `?m=` is a query parameter and reaches a SQL date.
  const month = isMonth(sp.m) ? sp.m : thisMonth;
  const isCurrent = month === thisMonth;
  const { from, to } = monthRange(month);

  const supabase = await createClient();
  const calendar = async (range: { from: string; to: string }) => {
    if (!farmId) return [] as CalendarItem[];
    const { data } = await supabase.rpc("farm_calendar", { p_farm: farmId, p_from: range.from, p_to: range.to });
    return (data as CalendarItem[] | null) ?? [];
  };

  const [items, lookback, hoursRes, machinesRes] = await Promise.all([
    calendar({ from, to }),
    isCurrent ? calendar(lookbackRange(month)) : Promise.resolve([] as CalendarItem[]),
    isCurrent && farmId
      ? supabase
          .from("service_plan_lines")
          .select("id, machine_id, task, status, next_due_reading")
          .eq("farm_id", farmId)
          .is("deleted_at", null)
          .is("next_due_date", null)
          .in("status", ["overdue", "due_soon"])
      : Promise.resolve({ data: [] }),
    isCurrent && farmId
      ? supabase.from("machines").select("id, name, meter_type, status").eq("farm_id", farmId).is("deleted_at", null)
      : Promise.resolve({ data: [] }),
  ]);

  const carried = lookback
    .filter((i) => i.state === "overdue")
    .sort((a, b) => a.on_date.localeCompare(b.on_date));
  const machineRows = (machinesRes.data as { id: string; name: string; meter_type: string; status: string }[] | null) ?? [];
  const machineById = new Map(machineRows.map((m) => [m.id, m]));
  const byHours = ((hoursRes.data as HoursLine[] | null) ?? [])
    .filter((l) => {
      const m = machineById.get(l.machine_id);
      return m && m.status !== "retired" && m.status !== "sold";
    })
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));

  // An empty month looks ahead, so it can say when the next thing IS.
  const next = items.length === 0 && carried.length === 0 && byHours.length === 0
    ? firstUpcoming(await calendar(lookaheadRange(month)))
    : null;

  const grouped = byDay(items);
  const totals = monthTotals(items);
  const overdueCount = totals.overdue + carried.length + byHours.filter((l) => l.status === "overdue").length;
  const dueSoonCount = totals.dueSoon + byHours.filter((l) => l.status === "due_soon").length;
  const summary = [
    overdueCount > 0 ? t("calendar.countOverdue", locale).replace("{n}", String(overdueCount)) : null,
    dueSoonCount > 0 ? t("calendar.countDueSoon", locale).replace("{n}", String(dueSoonCount)) : null,
  ].filter(Boolean).join(" · ");

  const blanks = leadingBlanks(month);
  const days = monthDays(month);

  const navLink = (target: string, label: string, icon: React.ReactNode) => (
    <Link
      href={`/calendar?m=${target}`}
      aria-label={label}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      {icon}
    </Link>
  );

  const itemRow = (i: CalendarItem, showDate = false) => {
    const look = stateLook(i.state);
    return (
      <li key={`${i.kind}-${i.item_id}`}>
        <Link
          href={itemHref(i)}
          className="focus-ring flex min-h-[48px] flex-wrap items-start justify-between gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">
              {i.title ?? enumLabel("calendarKind", i.kind, locale)}
            </span>
            <span className="mt-0.5 block text-xs text-sand-600">
              {showDate ? `${shortDate(i.on_date, locale)} · ` : ""}
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
  };

  /** "26 September: 2 items, 1 overdue", for a screen reader, since the dot is colour. */
  const daySr = (day: string, onDay: CalendarItem[]) => {
    const late = onDay.filter((i) => i.state === "overdue").length;
    const base = (onDay.length === 1 ? t("calendar.dayOne", locale) : t("calendar.dayMany", locale))
      .replace("{date}", shortDate(day, locale))
      .replace("{n}", String(onDay.length));
    return late > 0 ? `${base}${t("calendar.dayOverdue", locale).replace("{n}", String(late))}` : base;
  };

  const cellBody = (day: string, onDay: CalendarItem[], worst: CalendarState | null) => (
    <>
      <span
        className={`text-sm tabular-nums ${onDay.length ? "font-semibold text-ink" : "text-sand-500"}`}
        aria-hidden={onDay.length > 0 ? true : undefined}
      >
        {Number(day.slice(8))}
      </span>
      {/* One dot for the day, coloured by the worst thing on it, plus a count when there
          is more than one. Three dots at this size is a smudge. */}
      {worst ? (
        <span className="mt-0.5 flex items-center gap-0.5" aria-hidden>
          <span className={`size-1.5 rounded-full ${DOT[worst]}`} />
          {onDay.length > 1 ? <span className="text-xs leading-none text-sand-500">{onDay.length}</span> : null}
        </span>
      ) : null}
      {onDay.length > 0 ? <span className="sr-only">{daySr(day, onDay)}</span> : null}
    </>
  );

  const hasAgenda = items.length > 0 || carried.length > 0 || byHours.length > 0;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("calendar.title", locale)}
        lead={t("calendar.lead", locale)}
        infoKey="calendar"
        locale={locale}
      />

      {/* The month, and the way through it. The label is the month itself rather than a
          heading above it, so the control and the thing it controls are one row. */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          {navLink(shiftMonth(month, -1), t("calendar.prevMonth", locale), <ChevronLeftIcon />)}
          <div className="min-w-0 text-center">
            <h2 className="truncate text-base font-semibold capitalize text-ink">{longMonthYear(`${month}-01`, locale)}</h2>
            {/* The three tiles this replaces spent 110px saying 0 / 0 / 0 on a quiet month. */}
            {summary ? <p className="text-sm text-sand-600">{summary}</p> : null}
            {!isCurrent ? (
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
            <div key={k} className="pb-1 text-xs font-medium uppercase tracking-wide text-sand-500" aria-hidden>
              {t(k, locale)}
            </div>
          ))}
          {Array.from({ length: blanks }).map((_, i) => (
            <div key={`blank-${i}`} aria-hidden />
          ))}
          {days.map((day) => {
            const onDay = grouped.get(day) ?? [];
            const worst = worstState(onDay);
            const ring = day === today ? "bg-sand-100 ring-1 ring-brand-600" : "";
            const cell = `min-h-11 flex-col items-center justify-center rounded-lg py-1 ${ring}`;
            if (onDay.length === 0) {
              return (
                <div key={day} className={`flex ${cell}`}>
                  {cellBody(day, onDay, worst)}
                </div>
              );
            }
            return (
              <div key={day} className="contents">
                <div className={`flex sm:hidden ${cell}`}>{cellBody(day, onDay, worst)}</div>
                <a href={`#day-${day}`} className={`focus-ring hidden hover:bg-sand-50 sm:flex sm:min-h-12 ${cell}`}>
                  {cellBody(day, onDay, worst)}
                </a>
              </div>
            );
          })}
        </div>
      </Card>

      {!hasAgenda ? (
        <GetStarted
          title={
            next
              ? t("calendar.emptyNext", locale)
                  .replace("{title}", next.title ?? enumLabel("calendarKind", next.kind, locale))
                  .replace("{date}", shortDate(next.on_date, locale))
              : t("calendar.emptyTitle", locale)
          }
          hint={t("calendar.emptyBody", locale)}
          action={
            next ? (
              <Link href={`/calendar?m=${next.on_date.slice(0, 7)}`} className={buttonVariants({ variant: "secondary" })}>
                {longMonthYear(next.on_date, locale)}
                <ChevronRightIcon />
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("calendar.agendaTitle", locale)}</CardTitle>
          </div>
          <ul className="divide-y divide-sand-200">
            {carried.length > 0 ? (
              <li className="p-4 sm:p-5">
                <p className="text-sm font-semibold text-status-overdue">{t("calendar.carriedOver", locale)}</p>
                <ul className="mt-2 space-y-2">{carried.map((i) => itemRow(i, true))}</ul>
              </li>
            ) : null}
            {byHours.length > 0 ? (
              <li className="p-4 sm:p-5">
                <p className="text-sm font-semibold text-ink">{t("calendar.dueByHours", locale)}</p>
                <ul className="mt-2 space-y-2">
                  {byHours.map((l) => {
                    const m = machineById.get(l.machine_id);
                    const look = stateLook(l.status === "overdue" ? "overdue" : "due_soon");
                    return (
                      <li key={l.id}>
                        <Link
                          href={withTab(`/machines/${l.machine_id}`, "servicing")}
                          className="focus-ring flex min-h-[48px] flex-wrap items-start justify-between gap-2 rounded-lg border border-sand-200 px-3 py-2.5 hover:bg-sand-50"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-ink">{l.task}</span>
                            <span className="mt-0.5 block text-xs text-sand-600">
                              {m?.name ?? t("calendar.noMachine", locale)}
                              {l.next_due_reading != null
                                ? ` · ${t("calendar.dueAtReading", locale).replace("{reading}", meterReading(l.next_due_reading, m?.meter_type, locale))}`
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
            ) : null}
            {days
              .filter((d) => grouped.has(d))
              .map((day) => (
                <li key={day} id={`day-${day}`} className="scroll-mt-20 p-4 sm:p-5">
                  <p className="text-sm font-semibold text-ink">
                    {shortDate(day, locale)}
                    {day === today ? (
                      <span className="ml-2 text-xs font-medium text-brand-ink">
                        {t("calendar.today", locale)}
                      </span>
                    ) : null}
                  </p>
                  <ul className="mt-2 space-y-2">{(grouped.get(day) ?? []).map((i) => itemRow(i))}</ul>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
