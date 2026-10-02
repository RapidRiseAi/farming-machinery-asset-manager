/**
 * Month and weekday words for headings and chart axes, in the reader's language.
 *
 * == Why this is not in format.ts ============================================
 * `format.ts` belongs to the kit and is edited by one owner at a time. These three sit
 * beside `monthLabel` in spirit and follow the same two rules: the words come from the
 * locale ("Mei", "Okt", "Des" for an Afrikaans farmer, never a hard-coded English list),
 * and the day is pinned to South African time, so 23:30 UTC on 31 March is April on the
 * farm and not March on the server.
 *
 * A bare `YYYY-MM-DD` is read as noon UTC, which is the same calendar day in
 * Johannesburg, so a date string can never slide a day either way.
 */
import { localeOf, type Lang } from "./i18n";

const SA_TIME_ZONE = "Africa/Johannesburg";

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tag(locale: Lang): string {
  return localeOf(locale) === "af" ? "af-ZA" : "en-ZA";
}

/** "May" / "Mei": a chart axis, or "{amount} more than {month}". */
export function shortMonth(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "-";
  return d.toLocaleDateString(tag(locale), { month: "short", timeZone: SA_TIME_ZONE });
}

/** "September 2026" / "September 2026": the heading above a month grid. */
export function longMonthYear(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "-";
  return d.toLocaleDateString(tag(locale), { month: "long", year: "numeric", timeZone: SA_TIME_ZONE });
}

/** "Wednesday 30 September" / "Woensdag 30 September": today, said as a person would. */
export function weekdayDayMonth(value: string | Date | null | undefined, locale: Lang): string {
  const d = toDate(value);
  if (!d) return "-";
  return d.toLocaleDateString(tag(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: SA_TIME_ZONE,
  });
}
