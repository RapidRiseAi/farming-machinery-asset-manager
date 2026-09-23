/**
 * The maintenance calendar, as the screen reads it.
 *
 * Pure functions. `public.farm_calendar` does the gathering and keeps each source's RLS;
 * everything here is arithmetic about days and about what a month looks like on a phone.
 *
 * == Dates are strings, deliberately =========================================
 * `YYYY-MM-DD` throughout, never `Date`. A calendar built on `Date` objects picks up the
 * server's timezone, and this product runs on Vercel in one timezone and is read in
 * another: a service due on the 1st renders on the 30th for anybody west of the server.
 * String dates cannot drift, and the database already hands them over as strings.
 */

import type { BadgeTone } from "@/components/ui/badge";

/** `public.calendar_item_kind`. */
export const CALENDAR_KINDS = [
  "service_due",
  "job_card",
  "licence",
  "driver_document",
  "work_request",
] as const;

export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export type CalendarState = "overdue" | "due_soon" | "ok";

export type CalendarItem = {
  kind: CalendarKind;
  item_id: string;
  machine_id: string | null;
  machine_name: string | null;
  title: string | null;
  detail: string | null;
  on_date: string;
  state: CalendarState;
};

/** Monday-first, because a South African working week is not a Sunday. */
export const WEEK_STARTS_ON_MONDAY = true;

/** `YYYY-MM` for a given day, or for today. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Is this a `YYYY-MM` we can work with? Anything else falls back to the current month. */
export function isMonth(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Days in a month, without constructing a single Date in the server's timezone. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** The first and last day of a month, as `YYYY-MM-DD`. */
export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

/** The month before or after, wrapping the year. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + by;
  const year = Math.floor(total / 12);
  const mon = (total % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/**
 * Which weekday a day falls on, 0 = Monday.
 *
 * Zeller's congruence rather than `new Date(...).getDay()`: the point of this module is
 * that no server timezone can shift a date, and constructing a Date here would reintroduce
 * exactly that.
 */
export function weekdayIndex(day: string): number {
  let [y, m, d] = day.split("-").map(Number);
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  // Zeller gives 0 = Saturday. Shift so 0 = Monday.
  const h =
    (d + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  return (h + 5) % 7;
}

/** How many blank cells sit before the 1st in a Monday-first grid. */
export function leadingBlanks(month: string): number {
  return weekdayIndex(`${month}-01`);
}

/** The worst state present, so a day cell can be one colour. */
export function worstState(items: readonly CalendarItem[]): CalendarState | null {
  if (items.some((i) => i.state === "overdue")) return "overdue";
  if (items.some((i) => i.state === "due_soon")) return "due_soon";
  if (items.length > 0) return "ok";
  return null;
}

/** Items keyed by day, so both the grid and the agenda read the same grouping. */
export function byDay(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
  const out = new Map<string, CalendarItem[]>();
  for (const i of items) {
    const list = out.get(i.on_date);
    if (list) list.push(i);
    else out.set(i.on_date, [i]);
  }
  // Inside a day, the loudest first. A planner scanning a busy day should meet the overdue
  // service before the contractor request they already know about.
  for (const list of out.values()) list.sort((a, b) => stateOrder(a.state) - stateOrder(b.state));
  return out;
}

export function stateOrder(s: CalendarState): number {
  return s === "overdue" ? 0 : s === "due_soon" ? 1 : 2;
}

/** Every day of the month in order, so the agenda can skip the empty ones. */
export function monthDays(month: string): string[] {
  const n = daysInMonth(month);
  const out: string[] = [];
  for (let d = 1; d <= n; d += 1) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
}

/** Badge shape and words for a calendar state. */
export function stateLook(s: CalendarState): { tone: BadgeTone; labelKey: string } {
  switch (s) {
    case "overdue":
      return { tone: "danger", labelKey: "calendar.stateOverdue" };
    case "due_soon":
      return { tone: "warning", labelKey: "calendar.stateDueSoon" };
    default:
      return { tone: "neutral", labelKey: "calendar.stateOk" };
  }
}

/**
 * Where a calendar item links to.
 *
 * A driver document has no machine, so it goes to the personnel screen. Everything else
 * goes to the thing itself, because a planner who taps a row wants to act on it.
 */
export function itemHref(item: CalendarItem): string {
  switch (item.kind) {
    case "job_card":
      return `/jobcards/${item.item_id}`;
    case "work_request":
      return `/work/${item.item_id}`;
    case "driver_document":
      return "/team/licences";
    default:
      return item.machine_id ? `/machines/${item.machine_id}` : "/machines";
  }
}

/** How many of each state are in a month, for the three tiles above the grid. */
export function monthTotals(items: readonly CalendarItem[]): {
  overdue: number;
  dueSoon: number;
  total: number;
} {
  let overdue = 0;
  let dueSoon = 0;
  for (const i of items) {
    if (i.state === "overdue") overdue += 1;
    else if (i.state === "due_soon") dueSoon += 1;
  }
  return { overdue, dueSoon, total: items.length };
}
