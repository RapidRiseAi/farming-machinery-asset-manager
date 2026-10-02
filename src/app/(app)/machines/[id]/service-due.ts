/**
 * What a service-plan line means to a person standing next to the machine: how far
 * overdue it is, or when it falls due, in the machine's own unit and a date a person
 * reads. The Servicing tab and the machine header both say it, so it is worked out once.
 *
 * Plain module (no "use client"), so a Server Component may call it.
 */
import { t, type Lang } from "@/lib/i18n";
import { daysAgo, meterReading, shortDate } from "@/lib/format";

export type DueLine = {
  task: string;
  status: string;
  interval_hours: number | null;
  interval_months: number | null;
  next_due_reading: number | null;
  next_due_date: string | null;
};

const STATUS_RANK: Record<string, number> = { overdue: 0, due_soon: 1, ok: 2 };

/**
 * How much of its interval a line has left, as a fraction (negative once it is past
 * due). Hours and days cannot be compared directly, a share of each interval can.
 */
function headroom(line: DueLine, currentReading: number | null, now: Date): number {
  let best = Number.POSITIVE_INFINITY;
  if (line.next_due_reading != null && currentReading != null) {
    const span = line.interval_hours && line.interval_hours > 0 ? line.interval_hours : 1;
    best = Math.min(best, (line.next_due_reading - currentReading) / span);
  }
  if (line.next_due_date) {
    const days = daysAgo(line.next_due_date, now);
    if (days != null) {
      const span = line.interval_months && line.interval_months > 0 ? line.interval_months * 30 : 30;
      best = Math.min(best, -days / span);
    }
  }
  return best;
}

/** The line that needs attention first: worst status, then the least headroom left. */
export function worstServiceLine<T extends DueLine>(
  lines: T[],
  currentReading: number | null,
  now: Date = new Date(),
): T | null {
  if (lines.length === 0) return null;
  return [...lines].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (rank !== 0) return rank;
    return headroom(a, currentReading, now) - headroom(b, currentReading, now);
  })[0];
}

/**
 * One sentence for a line: "Overdue by 500 hours (due at 3 500 hours)", "Overdue since
 * 4 Jun 2026", "Due in 38 hours or by 4 Jun 2027", "Due by 4 Jun 2027". Null when the
 * line has no due point yet (nothing recorded as last done).
 */
export function serviceDueText(
  line: DueLine,
  currentReading: number | null,
  meterType: string,
  locale: Lang,
  now: Date = new Date(),
): string | null {
  const readingLeft =
    line.next_due_reading != null && currentReading != null ? line.next_due_reading - currentReading : null;
  const daysPast = line.next_due_date ? daysAgo(line.next_due_date, now) : null;
  const dueAt = line.next_due_reading != null ? meterReading(line.next_due_reading, meterType, locale) : null;
  const dueDate = line.next_due_date ? shortDate(line.next_due_date, locale) : null;

  if (readingLeft != null && readingLeft < 0 && dueAt) {
    return t("machine.dueOverdueBy", locale)
      .replace("{amount}", meterReading(-readingLeft, meterType, locale))
      .replace("{at}", dueAt);
  }
  if (daysPast != null && daysPast > 0 && dueDate) {
    return t("machine.dueOverdueSince", locale).replace("{date}", dueDate);
  }
  const amount = readingLeft != null ? meterReading(readingLeft, meterType, locale) : null;
  if (amount && dueDate) {
    return t("machine.dueInOrBy", locale).replace("{amount}", amount).replace("{date}", dueDate);
  }
  if (amount) return t("machine.dueIn", locale).replace("{amount}", amount);
  if (dueDate) return t("machine.dueBy", locale).replace("{date}", dueDate);
  if (dueAt) return t("machine.dueAt", locale).replace("{at}", dueAt);
  return null;
}
