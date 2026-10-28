/**
 * The support desk's clock, mirrored from SQL.
 *
 * The database decides every deadline (`app.support_due_at`, `app.support_next_due`,
 * 20261028100400 and 20261028100950) and stores it on the case. This module is the same rule
 * in TypeScript for two reasons: the help page says "we answer by ..." before anything is
 * written, and the unit tests pin the rule so the two cannot drift apart unnoticed. The SQL
 * suite `support_desk.sql` (a) checks the same cases against the database.
 *
 * Founder default (2026-10-28), kept as data in `support_settings`/`support_holidays` and
 * as `DEFAULT_SUPPORT_CALENDAR` here:
 *   - received on a working day between opening and the cutoff (09:00 to 16:00): due at
 *     closing (17:00) that day;
 *   - on a working day before opening: due 12:00 that day;
 *   - anything else (after the cutoff, a weekend, a public holiday): 12:00 the next working day.
 *
 * Plain module (no "use client", no "server-only") so pages, actions and tests can import it.
 */

export type SupportCalendar = {
  timezone: string;
  /** "HH:MM" in `timezone`. */
  opensAt: string;
  closesAt: string;
  /** Received before this on a working day: due at `closesAt` the same day. */
  sameDayCutoff: string;
  /** Otherwise due at this time on the next working day. */
  nextDayDue: string;
  /** ISO weekdays, Monday 1 to Sunday 7. */
  workingDays: readonly number[];
  /** Closed days, "YYYY-MM-DD". */
  holidays: ReadonlySet<string>;
};

/** The founder's default hours. The live values are the `support_settings` row. */
export const DEFAULT_SUPPORT_CALENDAR: SupportCalendar = {
  timezone: "Africa/Johannesburg",
  opensAt: "09:00",
  closesAt: "17:00",
  sameDayCutoff: "16:00",
  nextDayDue: "12:00",
  workingDays: [1, 2, 3, 4, 5],
  holidays: new Set(),
};

/** The kinds a customer asks and sees; disputes and refunds are Rapid Rise's own. */
export const CUSTOMER_KINDS = ["help_request", "privacy_request", "export_request"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

export function isCustomerKind(kind: string): kind is CustomerKind {
  return (CUSTOMER_KINDS as readonly string[]).includes(kind);
}

type LocalParts = { y: number; m: number; d: number; minutes: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** The wall-clock date and time of `instant` in `timezone`. */
function localParts(instant: Date, timezone: string): LocalParts & { s: number } {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(instant).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    minutes: hour * 60 + Number(parts.minute),
    s: Number(parts.second),
  };
}

/** How far `timezone` is ahead of UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timezone: string): number {
  const p = localParts(instant, timezone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a wall-clock time on a day in `timezone` happens. */
function zoned(y: number, m: number, d: number, minutes: number, timezone: string): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetMs(new Date(guess), timezone);
  // Once more at the answer, in case an offset change lies between the guess and it.
  return new Date(guess - offsetMs(new Date(first), timezone));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function isoDay(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Is this calendar day one the desk works? */
export function isWorkingDay(y: number, m: number, d: number, cal: SupportCalendar): boolean {
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const iso = js === 0 ? 7 : js;
  return cal.workingDays.includes(iso) && !cal.holidays.has(isoDay(y, m, d));
}

/** When an answer is due for a request received at `from`. Mirrors `app.support_due_at`. */
export function supportDueAt(from: Date, cal: SupportCalendar = DEFAULT_SUPPORT_CALENDAR): Date {
  const local = localParts(from, cal.timezone);
  const open = toMinutes(cal.opensAt);
  const close = toMinutes(cal.closesAt);
  const cutoff = toMinutes(cal.sameDayCutoff);
  const next = toMinutes(cal.nextDayDue);

  if (isWorkingDay(local.y, local.m, local.d, cal)) {
    if (local.minutes < open) return zoned(local.y, local.m, local.d, next, cal.timezone);
    if (local.minutes < cutoff) return zoned(local.y, local.m, local.d, close, cal.timezone);
  }
  let day = { y: local.y, m: local.m, d: local.d };
  // Bounded, as in SQL, so a calendar with every day closed cannot loop.
  for (let step = 0; step < 60; step += 1) {
    day = addDays(day.y, day.m, day.d, 1);
    if (isWorkingDay(day.y, day.m, day.d, cal)) break;
  }
  return zoned(day.y, day.m, day.d, next, cal.timezone);
}

export type DueFacts = {
  kind: string;
  status: string;
  due_at: string | null;
  first_response_due_at: string | null;
  first_response_at: string | null;
  last_customer_at: string | null;
  last_staff_at: string | null;
};

/**
 * The deadline waiting on Rapid Rise, or null when nothing is. Mirrors `app.support_next_due`:
 * a dispute or billing case keeps its own deadline while open; a customer case before its
 * first answer has the same-day promise; after that only an unanswered customer reply counts.
 */
export function nextDue(t: DueFacts): string | null {
  if (t.status !== "open" && t.status !== "waiting") return null;
  if (!isCustomerKind(t.kind)) return t.due_at;
  if (t.status === "waiting") return null;
  if (!t.first_response_at) return t.first_response_due_at ?? t.due_at;
  if (t.last_customer_at && (!t.last_staff_at || Date.parse(t.last_customer_at) > Date.parse(t.last_staff_at))) {
    return t.due_at;
  }
  return null;
}

export type DueState = "none" | "overdue" | "today" | "later";

/** How a deadline reads now: past, later today (in the desk's zone), or after today. */
export function dueState(due: string | null, now: Date, timezone = DEFAULT_SUPPORT_CALENDAR.timezone): DueState {
  if (!due) return "none";
  const at = new Date(due);
  if (at.getTime() < now.getTime()) return "overdue";
  const a = localParts(at, timezone);
  const n = localParts(now, timezone);
  return a.y === n.y && a.m === n.m && a.d === n.d ? "today" : "later";
}

/** The calendar from `support_contact()` (times as "HH:MM") and an optional holiday list. */
export function calendarFrom(
  row: {
    timezone?: string | null;
    opens_at?: string | null;
    closes_at?: string | null;
    same_day_cutoff?: string | null;
    next_day_due?: string | null;
    working_days?: readonly number[] | null;
  } | null,
  holidays: readonly string[] = [],
): SupportCalendar {
  const d = DEFAULT_SUPPORT_CALENDAR;
  return {
    timezone: row?.timezone || d.timezone,
    opensAt: row?.opens_at || d.opensAt,
    closesAt: row?.closes_at || d.closesAt,
    sameDayCutoff: row?.same_day_cutoff || d.sameDayCutoff,
    nextDayDue: row?.next_day_due || d.nextDayDue,
    workingDays: row?.working_days?.length ? row.working_days.map(Number) : d.workingDays,
    holidays: new Set(holidays),
  };
}

/** True when the working days are exactly Monday to Friday, which reads as "weekdays". */
export function isWeekdays(days: readonly number[]): boolean {
  return days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
}
