/**
 * A date as a person reads it, inside a real `<time>` element. Server-compatible.
 *
 *   <DateText value={card.date_in} locale={locale} />                  // "3 days ago" / "3 Aug 2026"
 *   <DateText value={r.updated_at} locale={locale} format="day" />      // "3 Aug 2026"
 *   <DateText value={row.created_at} locale={locale} format="dayTime" /> // "3 Aug 2026, 14:30"
 *
 * Props: `value` (ISO string, date-only string or Date; empty renders "-"), `locale`,
 * `format?`: "auto" (default: relative wording inside a week either way, a plain date
 * beyond it), "relative" (relative out to a month, as `relativeDate`), "day", "dayTime",
 * "month"; `className?`.
 *
 * == Why ======================================================================
 * `/jobcards` printed `date_in` as "2026-08-03" and `/work` printed
 * `updated_at.slice(0, 10)`, beside a dashboard that says "29 Jul 2026" and "4 weeks
 * ago": the product formatted dates two ways. Every format here goes through the
 * `lib/format` helpers, pinned to Africa/Johannesburg, so server and browser agree and
 * 01:30 on the farm is not yesterday. The exact date sits in `title` and `dateTime`, so
 * "3 days ago" never hides when it actually was.
 */
import { dateTime, daysAgo, monthLabel, relativeDate, shortDate } from "@/lib/format";
import type { Lang } from "@/lib/i18n";

export type DateTextFormat = "auto" | "relative" | "day" | "dayTime" | "month";

export function DateText({
  value,
  locale,
  format = "auto",
  className,
}: {
  value: string | Date | null | undefined;
  locale: Lang;
  format?: DateTextFormat;
  className?: string;
}) {
  if (!value) return <span className={className}>-</span>;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return <span className={className}>-</span>;

  let text: string;
  switch (format) {
    case "day":
      text = shortDate(value, locale);
      break;
    case "dayTime":
      text = dateTime(value, locale);
      break;
    case "month":
      text = monthLabel(value, locale);
      break;
    case "relative":
      text = relativeDate(value, locale);
      break;
    case "auto":
    default: {
      const days = daysAgo(value);
      text = days != null && Math.abs(days) < 7 ? relativeDate(value, locale) : shortDate(value, locale);
    }
  }

  const iso = typeof value === "string" ? value : value.toISOString();
  // A date-only value has no meaningful time; show the time only when there is one.
  const full = /T\d/.test(iso) ? dateTime(value, locale) : shortDate(value, locale);
  return (
    <time dateTime={iso} title={full === text ? undefined : full} className={className}>
      {text}
    </time>
  );
}
