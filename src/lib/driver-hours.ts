/**
 * Driving time against a company's own policy. South Africa has no tachograph law, but road
 * transport standards and customers expect fatigue to be managed, so the limits are the
 * company's to set and this only reports against them. It warns; it does not stop anybody.
 */

export type WorkPeriod = { driverId: string; start: string; end: string | null };
export type HoursPolicy = { maxDay: number; maxWeek: number; minRest: number };

export type DriverHours = {
  driverId: string;
  /** Hours worked in the last 24 hours. */
  day: number;
  /** Hours worked in the last 7 days. */
  week: number;
  /** The shortest break between two periods of work in the last 7 days, in hours. */
  shortestRest: number | null;
  overDay: boolean;
  overWeek: boolean;
  shortRest: boolean;
  /** Still working now. */
  active: boolean;
};

const HOUR = 60 * 60 * 1000;

type Span = { start: number; end: number };

/** A trip and a driving session can cover the same time: count it once. */
function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

function hoursWithin(spans: Span[], from: number, to: number): number {
  let total = 0;
  for (const s of spans) total += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
  return total / HOUR;
}

export function driverHours(periods: WorkPeriod[], policy: HoursPolicy, now: Date = new Date()): DriverHours[] {
  const to = now.getTime();
  const byDriver = new Map<string, WorkPeriod[]>();
  for (const p of periods) byDriver.set(p.driverId, [...(byDriver.get(p.driverId) ?? []), p]);

  return [...byDriver.entries()].map(([driverId, list]) => {
    const spans = merged(
      list.map((p) => ({ start: new Date(p.start).getTime(), end: p.end ? new Date(p.end).getTime() : to })),
    );
    const weekStart = to - 7 * 24 * HOUR;
    const recent = spans.filter((s) => s.end >= weekStart);
    const rests = recent.slice(1).map((s, i) => (s.start - recent[i].end) / HOUR);
    const shortestRest = rests.length ? Math.min(...rests) : null;
    const day = hoursWithin(spans, to - 24 * HOUR, to);
    const week = hoursWithin(spans, weekStart, to);
    return {
      driverId,
      day,
      week,
      shortestRest,
      overDay: day > policy.maxDay,
      overWeek: week > policy.maxWeek,
      shortRest: shortestRest != null && shortestRest < policy.minRest,
      active: list.some((p) => p.end == null),
    };
  });
}
