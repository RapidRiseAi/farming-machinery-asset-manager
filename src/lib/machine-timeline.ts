/**
 * A machine's life on one line: everything that happened to it, newest first, in months.
 *
 * The page gathers the events (job cards, faults, watch items, checklists, contractor
 * work, record edits, the day it was bought); this file only orders, folds, filters and
 * groups them, so the rules can be tested without rendering anything.
 */

export type TimelineKind = "origin" | "jobcard" | "fault" | "watch" | "checklist" | "work" | "part" | "fuel" | "audit";

export type TimelineEvent = {
  /** YYYY-MM-DD. */
  date: string;
  kind: TimelineKind;
  title: string;
  sub: string;
  href?: string;
  /** How many record edits this row stands for, once folded. */
  count?: number;
  /** Still needs somebody (an open fault, an unfinished job card): the marker is ringed. */
  open?: boolean;
};

/** The chips above the line. "origin" shows under All only: it is where the line starts. */
export const TIMELINE_FILTERS = {
  problems: ["fault", "watch"],
  service: ["jobcard"],
  parts: ["part"],
  fuel: ["fuel"],
  checks: ["checklist"],
  work: ["work"],
  changes: ["audit"],
} as const satisfies Record<string, readonly TimelineKind[]>;

export type TimelineFilter = "all" | keyof typeof TIMELINE_FILTERS;

export const TIMELINE_FILTER_KEYS = ["all", ...Object.keys(TIMELINE_FILTERS)] as TimelineFilter[];

/** `?tl=` from the address bar; anything unknown is All. */
export function readTimelineFilter(raw: string | undefined | null): TimelineFilter {
  return raw && Object.hasOwn(TIMELINE_FILTERS, raw) ? (raw as TimelineFilter) : "all";
}

/**
 * Newest first. Several record edits on one day are one thing to a reader ("changed 3
 * times"), not three identical rows, so neighbouring audit rows on the same day fold.
 * Equal dates keep the order they were added in (the sort is stable), which is how the
 * page puts "Bought" below everything else on its day.
 */
export function buildTimeline(events: TimelineEvent[], manyEdits: (n: number) => string): TimelineEvent[] {
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
  const out: TimelineEvent[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (e.kind === "audit" && prev?.kind === "audit" && prev.date === e.date) {
      prev.count = (prev.count ?? 1) + 1;
      prev.title = manyEdits(prev.count);
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

export function filterTimeline(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  if (filter === "all") return events;
  const kinds: readonly TimelineKind[] = TIMELINE_FILTERS[filter];
  return events.filter((e) => kinds.includes(e.kind));
}

/** Rows per chip, so an empty chip can be left off rather than leading nowhere. */
export function timelineCounts(events: TimelineEvent[]): Record<TimelineFilter, number> {
  const counts = Object.fromEntries(TIMELINE_FILTER_KEYS.map((k) => [k, 0])) as Record<TimelineFilter, number>;
  counts.all = events.length;
  for (const [filter, kinds] of Object.entries(TIMELINE_FILTERS) as [Exclude<TimelineFilter, "all">, readonly TimelineKind[]][]) {
    counts[filter] = events.filter((e) => kinds.includes(e.kind)).length;
  }
  return counts;
}

/** Runs of the same calendar month, in the order given (newest first from `buildTimeline`). */
export function groupByMonth(events: TimelineEvent[]): { month: string; events: TimelineEvent[] }[] {
  const groups: { month: string; events: TimelineEvent[] }[] = [];
  for (const e of events) {
    const month = e.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.month === month) last.events.push(e);
    else groups.push({ month, events: [e] });
  }
  return groups;
}
