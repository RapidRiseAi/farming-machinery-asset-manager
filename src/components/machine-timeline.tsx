import Link from "next/link";
import type { ReactNode } from "react";

import { t, type Lang } from "@/lib/i18n";
import { monthLabel, shortDate } from "@/lib/format";
import {
  TIMELINE_FILTER_KEYS,
  filterTimeline,
  groupByMonth,
  timelineCounts,
  type TimelineEvent,
  type TimelineFilter,
  type TimelineKind,
} from "@/lib/machine-timeline";
import { Badge, TONES, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import {
  BellIcon,
  ChecklistIcon,
  FaultsIcon,
  FuelIcon,
  PartsIcon,
  JobCardsIcon,
  MachinesIcon,
  PinIcon,
  WorkIcon,
} from "@/components/ui/icons";

/** Rows shown before "Show N older". */
const RECENT_ROWS = 15;

// The badge's own tint pairs, so a marker clears AA in both themes exactly as a badge does.
const KIND_TONE: Record<TimelineKind, BadgeTone> = {
  origin: "brand",
  jobcard: "brand",
  fault: "danger",
  watch: "warning",
  checklist: "ok",
  work: "info",
  part: "info",
  fuel: "warning",
  audit: "neutral",
};

const KIND_ICON: Record<TimelineKind, ReactNode> = {
  origin: <MachinesIcon />,
  jobcard: <JobCardsIcon />,
  fault: <FaultsIcon />,
  watch: <BellIcon />,
  checklist: <ChecklistIcon />,
  work: <WorkIcon />,
  part: <PartsIcon />,
  fuel: <FuelIcon />,
  audit: <PinIcon />,
};

/**
 * The History tab's timeline: one line down the left, a coloured marker per event, months
 * as headings, newest at the top and the day the machine was bought at the bottom.
 *
 * It replaced a bordered list that read as a table. The filter chips are links (`?tl=`),
 * not client state, so the page stays a server component and a filtered view can be
 * shared or bookmarked.
 */
export function MachineTimeline({
  events,
  filter,
  machineId,
  locale,
  compact,
}: {
  /** From `buildTimeline`: sorted and folded, not yet filtered. */
  events: TimelineEvent[];
  filter: TimelineFilter;
  machineId: string;
  locale: Lang;
  /** The newest N rows only, without chips: the overview's recent history. */
  compact?: number;
}) {
  if (events.length === 0) return <EmptyState title={t("machine.noTimeline", locale)} />;
  if (compact) return <Rail events={events.slice(0, compact)} locale={locale} />;

  const counts = timelineCounts(events);
  // A chip only where it leads somewhere, and no chip row at all for a one-kind history.
  const chips = TIMELINE_FILTER_KEYS.filter((k) => k === "all" || counts[k] > 0);
  const shown = filterTimeline(events, filter);
  const recent = shown.slice(0, RECENT_ROWS);
  const older = shown.slice(RECENT_ROWS);

  return (
    <div id="timeline" className="scroll-mt-24">
      {chips.length > 2 ? (
        <nav aria-label={t("machine.tlFilterLabel", locale)} className="-mx-1 mb-3 flex flex-wrap gap-1.5">
          {chips.map((k) => {
            const active = k === filter;
            return (
              <Link
                key={k}
                href={`/machines/${machineId}?tab=history${k === "all" ? "" : `&tl=${k}`}#timeline`}
                aria-current={active ? "true" : undefined}
                scroll={false}
                className={cn(
                  "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition",
                  active
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-sand-200 bg-surface text-sand-700 hover:bg-surface-hover",
                )}
              >
                {t(`machine.tlFilter.${k}`, locale)}
                <span className={cn("tabular-nums", active ? "text-white" : "text-sand-500")}>{counts[k]}</span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState title={t("machine.tlNoneOfKind", locale)} />
      ) : (
        <>
          <Rail events={recent} locale={locale} />
          {older.length > 0 ? (
            <Disclosure
              variant="inline"
              summary={t("machine.timelineOlder", locale).replace("{n}", String(older.length))}
              className="mt-1"
            >
              <Rail events={older} locale={locale} />
            </Disclosure>
          ) : null}
        </>
      )}
    </div>
  );
}

function Rail({ events, locale }: { events: TimelineEvent[]; locale: Lang }) {
  return (
    <ol
      className={cn(
        "relative",
        // The line itself: one stroke behind every marker, centred on them (left-4 = half of size-8).
        "before:absolute before:inset-y-2 before:left-4 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-sand-200",
      )}
    >
      {groupByMonth(events).map((g) => (
        <li key={g.month}>
          <h3 className="relative flex min-h-9 items-center pl-10 text-sm font-bold text-sand-800">
            <span aria-hidden="true" className="absolute left-4 size-2.5 -translate-x-1/2 rounded-full bg-sand-300 ring-4 ring-surface" />
            {monthLabel(`${g.month}-01`, locale)}
          </h3>
          <ol className="flex flex-col gap-2 pb-3">
            {g.events.map((e, i) => (
              <TimelineRow key={`${e.kind}-${e.date}-${i}`} event={e} locale={locale} />
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function TimelineRow({ event: e, locale }: { event: TimelineEvent; locale: Lang }) {
  const tone = KIND_TONE[e.kind];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 min-w-0 text-sm font-medium text-sand-900">{e.title}</p>
        <time dateTime={e.date} className="shrink-0 pt-0.5 text-xs tabular-nums text-sand-500">
          {shortDate(e.date, locale)}
        </time>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* "Bought" is already the title; every other row says what kind it is. */}
        {e.kind === "origin" ? null : <Badge tone={tone}>{t(`machine.tlKind.${e.kind}`, locale)}</Badge>}
        {e.sub ? <span className="min-w-0 text-sm text-sand-500">{e.sub}</span> : null}
      </div>
    </>
  );
  const card = "block rounded-lg border border-sand-200 px-3 py-2.5";

  return (
    <li className="relative pl-10">
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-4 top-2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full text-base ring-4 ring-surface",
          e.kind === "origin" ? "bg-brand-600 text-white" : TONES[tone],
          // Still needs somebody: a second ring in the marker's own colour.
          e.open && "outline outline-2 outline-offset-2 outline-current",
        )}
      >
        {KIND_ICON[e.kind]}
      </span>
      {e.href ? (
        <Link href={e.href} className={cn(card, "focus-ring transition hover:bg-surface-hover")}>
          {body}
        </Link>
      ) : (
        <div className={card}>{body}</div>
      )}
    </li>
  );
}
