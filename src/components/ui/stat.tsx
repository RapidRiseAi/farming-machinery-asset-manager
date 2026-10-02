/**
 * KPI tiles, server-compatible.
 *
 *   <StatGrid columns={3}>
 *     <Stat label={t("fuel.spend", locale)} value={rands(spend)} href="/fuel" />
 *     <Stat label={t("fuel.litres", locale)} value={num(litres, 0)} />
 *     <Stat label={t(LABEL_KEY, locale)} value={t(WORD_KEY, locale)} valueKind="text" />
 *   </StatGrid>
 *
 * `Stat` props: `label`, `value`, `delta?`, `tone?` (default|brand|ok|due|overdue),
 * `icon?`, `href?` (whole tile becomes a link with a chevron), `size?` ("lg" default,
 * "md" for money in a tight grid), `valueKind?` ("number" default, "text" for a word
 * value such as "Nothing waiting", set at a readable size instead of KPI size),
 * `valueClassName?` (a font-size class in it replaces the built-in size).
 *
 * `StatGrid` props: `columns?` (2 | 3 | 4, default 4), `className?`. Two columns on a
 * phone, never more, and a lone last tile spans the row so it does not leave a hole.
 *
 * == Why the value may wrap ===================================================
 * `rands` joins thousands with U+00A0, so "R1 500 000,00" is ONE unbreakable token of
 * about 200px. In a hard `grid-cols-3` at 360px each tile is about 100px, and the value
 * ran off its tile and off the screen; Chrome then widened the layout viewport and
 * rendered the whole page zoomed out (/incidents measured 383px). So the tile is
 * `min-w-0`, the value may break anywhere as a last resort (`overflow-wrap:anywhere`,
 * which also lowers its min-content width, unlike `break-words`), and the value steps
 * down a size on phones. Tabular figures stay on.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { ChevronRightIcon } from "./icons";

export type StatTone = "default" | "brand" | "ok" | "due" | "overdue";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-sand-900",
  brand: "text-brand-ink",
  ok: "text-status-ok",
  due: "text-status-due",
  overdue: "text-status-overdue",
};

export type StatSize = "md" | "lg";
export type StatValueKind = "number" | "text";

const VALUE_SIZE: Record<StatValueKind, Record<StatSize, string>> = {
  number: {
    lg: "text-2xl sm:text-3xl font-bold leading-none tracking-tight",
    md: "text-xl sm:text-2xl font-bold leading-none tracking-tight",
  },
  // A phrase is read, not scanned: KPI size made "Nothing waiting" run off the tile.
  text: {
    lg: "text-lg font-semibold leading-snug",
    md: "text-base font-semibold leading-snug",
  },
};

/**
 * True when a caller's `valueClassName` already sets a font size. `cn` does not
 * de-duplicate and Tailwind orders sizes small to large, so a caller's `text-xl`
 * next to the built-in `text-3xl` always lost: every "smaller on phones" override in
 * the app was silently rendering at full size. A caller size now replaces ours.
 */
const HAS_SIZE = /(^|\s)([a-z0-9-]+:)*text-(2xs|xs|sm|base|lg|xl|[2-9]xl)(\s|$)/;

export type StatProps = {
  label: ReactNode;
  value: ReactNode;
  /** Small qualifier under the value, e.g. "vs R3,200 last month". */
  delta?: ReactNode;
  tone?: StatTone;
  icon?: ReactNode;
  /** When set, the whole tile becomes a link with a chevron affordance. */
  href?: string;
  className?: string;
  /** `md` steps the value down one size, for money in a tight grid. Default `lg`. */
  size?: StatSize;
  /** `text` for a word value ("Nothing waiting"): semibold body size, no tabular figures. */
  valueKind?: StatValueKind;
  /** Extra classes for the value. A font-size class here replaces the built-in size. */
  valueClassName?: string;
};

/**
 * KPI tile: label, big value, optional delta/icon. Colours the value by `tone`
 * (used for the traffic-light service board). Renders as a link when `href` set.
 */
export function Stat({
  label,
  value,
  delta,
  tone = "default",
  icon,
  href,
  className,
  size = "lg",
  valueKind = "number",
  valueClassName,
}: StatProps) {
  const ownSize = valueClassName && HAS_SIZE.test(valueClassName);
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-medium uppercase tracking-wide text-sand-500">
          {label}
        </span>
        {icon ? <span className="shrink-0 text-xl text-sand-400">{icon}</span> : null}
        {!icon && href ? (
          <ChevronRightIcon className="shrink-0 text-lg text-sand-400" />
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1.5 min-w-0 [overflow-wrap:anywhere]",
          ownSize ? "font-bold leading-none tracking-tight" : VALUE_SIZE[valueKind][size],
          valueKind === "number" && "tabular-nums",
          VALUE_TONE[tone],
          valueClassName,
        )}
      >
        {value}
      </div>
      {delta ? <div className="mt-1.5 break-words text-xs text-sand-500">{delta}</div> : null}
    </>
  );

  const base = "block min-w-0 rounded-xl border border-sand-200 bg-surface p-4 shadow-card";

  if (href) {
    return (
      <Link
        href={href}
        className={cn(base, "focus-ring transition-shadow hover:shadow-soft", className)}
      >
        {inner}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{inner}</div>;
}

const GRID_COLUMNS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  // A lone third tile on a phone spans the row instead of leaving a hole beside it.
  3: "grid-cols-2 sm:grid-cols-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2",
  4: "grid-cols-2 lg:grid-cols-4 max-lg:[&>*:last-child:nth-child(odd)]:col-span-2",
};

/**
 * The one grid for a row of `Stat` tiles. Twenty-one pages each wrote their own recipe
 * and three used a bare `grid-cols-3`, which is what forced /incidents, /calendar and
 * /reports wider than a 360px phone. At most two tiles side by side on a phone.
 */
export function StatGrid({
  children,
  columns = 4,
  className,
}: {
  children: ReactNode;
  /** Columns at full width. Phones always get two. */
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return <div className={cn("grid gap-3", GRID_COLUMNS[columns], className)}>{children}</div>;
}
