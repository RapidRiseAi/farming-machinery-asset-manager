import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { localeOf, t, type Lang } from "@/lib/i18n";
import { num } from "@/lib/format";
import { rands } from "@/lib/money";
import type { BreakdownData, KpiData, ListData, SeriesData, Tone, ValueFormat } from "@/lib/dashboard/compute";
import { PALETTES, STATUS, swatchOf, swatchStyle, type PaletteKey, type Swatch } from "@/lib/dashboard/palettes";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { ChevronRightIcon } from "@/components/ui/icons";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";

/**
 * The dashboard's charts. Server components, no client JavaScript: plain HTML and SVG
 * sized in percentages, so a chart fills whatever box the grid gives it and re-flows when
 * a widget is resized. Colours come from lib/dashboard/palettes (validated in both
 * themes) through `.viz-c`. Text never wears a series colour: values and labels stay in
 * the ink tokens and a coloured mark beside them carries identity.
 *
 * Every chart carries its numbers as a table for screen readers, and a hover tip on each
 * mark for a mouse. The legend of a breakdown shows every value, so nothing is colour-only.
 */

// == Values ======================================================================

function formatValue(n: number, format: ValueFormat, locale: Lang): string {
  if (format === "rands") return rands(n);
  if (format === "litres") return `${num(n, 0)} ${t("dash.unit.litres", locale)}`;
  return num(n, 0);
}

/** Short forms for axis labels: R12,5k and 1,2k L. */
function compactValue(n: number, format: ValueFormat, locale: Lang): string {
  const v = format === "rands" ? n / 100 : n;
  const short = v >= 1_000_000 ? `${num(v / 1_000_000, 1)}m` : v >= 1000 ? `${num(v / 1000, 1)}k` : num(v, 0);
  if (format === "rands") return `R${short}`;
  if (format === "litres") return `${short} ${t("dash.unit.litres", locale)}`;
  return short;
}

const TONE_SWATCH: Record<Tone, Swatch> = { ok: STATUS.ok, warn: STATUS.warn, bad: STATUS.bad, neutral: STATUS.neutral };

/** A single colour from a setting: a named hue, a picked hex, or "auto" (the state's own). */
function hueSwatch(colour: string, tone: Tone = "neutral"): Swatch {
  return swatchOf(colour) ?? TONE_SWATCH[tone];
}

const styled = (s: Swatch, extra?: CSSProperties) => ({ ...swatchStyle(s), ...extra }) as CSSProperties;

/** The chart's numbers for a screen reader: the kit's table, visually hidden. */
function DataTable({ caption, rows, format, locale }: { caption: string; rows: { label: string; value: number }[]; format: ValueFormat; locale: Lang }) {
  return (
    <div className="sr-only">
      <Table>
        <caption>{caption}</caption>
        <Thead>
          <Tr>
            <Th>{t("dash.dataTable", locale)}</Th>
            <Th>{t("dash.total", locale)}</Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((r, i) => (
            <Tr key={i}>
              <Td>{r.label}</Td>
              <Td>{formatValue(r.value, format, locale)}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  );
}

function Empty({ locale }: { locale: Lang }) {
  return <p className="flex h-full items-center justify-center px-2 text-center text-sm text-sand-600">{t("dash.empty.chart", locale)}</p>;
}

/** A hover tip above a mark. Shown on hover and on keyboard focus within. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <span
      role="presentation"
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-surface opacity-0 shadow-soft transition-opacity group-hover:opacity-100"
    >
      {children}
    </span>
  );
}

// == A number ====================================================================

/**
 * A big number with what it means: the figure in ink (text never wears a series colour),
 * a coloured dot for its state beside the line under it, a pill for the change against
 * last month, and a sparkline of the same measure over earlier periods when there is one.
 * The widget's colour setting paints the dot and the sparkline; "auto" uses the state.
 */
export function KpiTile({
  data, colour, locale, large = false, showTrend = true,
}: { data: KpiData; colour: string; locale: Lang; large?: boolean; showTrend?: boolean }) {
  const sw = hueSwatch(colour, data.tone);
  const deltaText = data.delta
    ? t(data.delta.more ? "dash.deltaMore" : "dash.deltaLess", locale)
        .replace("{amount}", formatValue(data.delta.amount, data.format, locale))
        .replace("{month}", data.delta.month)
    : null;
  const trend = showTrend && data.trend && data.trend.some((v) => v > 0) ? data.trend : null;
  return (
    // The sparkline sits beside the figure: under it, a two-row tile clipped the line.
    <div className="flex h-full min-h-0 items-center gap-3">
      <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <p className={cn("truncate font-bold tabular-nums tracking-tight text-sand-950", large ? "text-4xl xl:text-5xl" : "text-3xl xl:text-4xl")}>
          {formatValue(data.value, data.format, locale)}
        </p>
        {data.delta && deltaText ? (
          <span
            title={deltaText}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
              data.delta.tone === "bad" ? "bg-callout-danger-bg text-callout-danger-ink" : "bg-callout-ok-bg text-callout-ok-ink",
            )}
          >
            <span aria-hidden="true">{data.delta.more ? "↑" : "↓"}</span>
            {compactValue(data.delta.amount, data.format, locale)}
            <span className="sr-only">{deltaText}</span>
          </span>
        ) : null}
      </div>
      {data.sub ? (
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-sand-600">
          <span aria-hidden="true" className="viz-c viz-bg size-2 shrink-0 rounded-full" style={styled(sw)} />
          {/* Two lines before it gives up: in half a phone, "2 standing still" read "2 stan…". */}
          <span className="line-clamp-2">{data.sub}</span>
        </p>
      ) : null}
      </div>
      {trend ? <Sparkline values={trend} sw={sw} className="h-12 w-2/5 max-w-44 shrink-0" /> : null}
    </div>
  );
}

/** A small line of the same measure over time, filled underneath, the latest point marked. */
export function Sparkline({ values, sw, className }: { values: number[]; sw: Swatch; className?: string }) {
  const max = Math.max(...values, 1);
  const x = (i: number) => (values.length === 1 ? 50 : (i / (values.length - 1)) * 100);
  const y = (v: number) => 92 - (v / max) * 84;
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = values.length - 1;
  return (
    <div className={cn("relative max-h-14", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <polygon points={`0,100 ${line} 100,100`} className="viz-c viz-fill" style={styled(sw, { opacity: 0.14 })} />
        <polyline points={line} fill="none" className="viz-c viz-stroke" strokeWidth={2} vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round" style={styled(sw)} />
      </svg>
      <span className="viz-c viz-bg absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
        style={styled(sw, { left: `${x(last)}%`, top: `${y(values[last])}%` })} />
    </div>
  );
}

// == Over time ===================================================================

export function SeriesChart({
  data, chart, colour, title, locale, labels = true,
}: { data: SeriesData; chart: string; colour: string; title: string; locale: Lang; labels?: boolean }) {
  const pts = data.points;
  const max = Math.max(0, ...pts.map((p) => p.value));
  if (max === 0) return <Empty locale={locale} />;
  const sw = hueSwatch(colour);
  const top = niceCeiling(max);
  const pct = (v: number) => (v / top) * 100;
  // Selective labels: the latest value and the highest, never a number on every mark.
  const peak = pts.reduce((best, p, i) => (p.value > pts[best].value ? i : best), 0);
  const labelled = new Set(labels ? [peak, pts.length - 1] : []);

  return (
    <figure className="flex h-full min-h-0 flex-col" aria-label={title}>
      <div className="relative flex min-h-0 flex-1">
        {/* Recessive scale: the top gridline and the baseline, labelled once. */}
        <span className="absolute left-0 top-0 text-2xs tabular-nums text-sand-600">{compactValue(top, data.format, locale)}</span>
        <div aria-hidden="true" className="absolute inset-x-0 top-2 border-t border-dashed border-sand-200" />
        <div className="relative ml-0 mt-2 flex min-h-0 flex-1 items-stretch gap-[2px] border-b border-sand-300">
          {chart === "bar"
            ? pts.map((p, i) => (
                <div key={p.key} className="group relative flex min-w-0 flex-1 flex-col justify-end">
                  {labelled.has(i) && p.value > 0 ? (
                    <span className="mb-0.5 truncate text-center text-2xs font-medium tabular-nums text-sand-700">{compactValue(p.value, data.format, locale)}</span>
                  ) : null}
                  <div
                    className="viz-c viz-bg mx-auto w-full max-w-12 rounded-t-[4px]"
                    style={styled(sw, { height: `${Math.max(pct(p.value), p.value > 0 ? 1.5 : 0)}%` })}
                  />
                  <Tip>{p.label}: {formatValue(p.value, data.format, locale)}</Tip>
                </div>
              ))
            : <LineArea pts={pts} pct={pct} sw={sw} area={chart === "area"} format={data.format} locale={locale} labelled={labelled} />}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px]" aria-hidden="true">
        {pts.map((p, i) => (
          <span key={p.key} className={cn("min-w-0 flex-1 truncate text-center text-2xs text-sand-600", pts.length > 8 && i % 2 === 1 && "max-sm:invisible")}>
            {p.label}
          </span>
        ))}
      </div>
      <DataTable caption={title} rows={pts} format={data.format} locale={locale} />
    </figure>
  );
}

function LineArea({
  pts, pct, sw, area, format, locale, labelled,
}: {
  pts: SeriesData["points"]; pct: (v: number) => number; sw: Swatch; area: boolean;
  format: ValueFormat; locale: Lang; labelled: Set<number>;
}) {
  // Points sit in the middle of equal columns, so the line lines up with the month labels.
  const x = (i: number) => ((i + 0.5) / pts.length) * 100;
  const y = (v: number) => 100 - pct(v);
  const line = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  return (
    <>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 h-full w-full overflow-visible">
        {area ? (
          <polygon points={`${x(0)},100 ${line} ${x(pts.length - 1)},100`} className="viz-c viz-fill" style={styled(sw, { opacity: 0.18 })} />
        ) : null}
        <polyline points={line} fill="none" className="viz-c viz-stroke" strokeWidth={2} vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round" style={styled(sw)} />
      </svg>
      {/* Markers and hover columns in HTML, so dots stay round at any width. */}
      {pts.map((p, i) => (
        <div key={p.key} className="group relative min-w-0 flex-1">
          <span
            className="viz-c viz-bg absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-surface"
            style={styled(sw, { bottom: `${pct(p.value)}%` })}
          />
          {labelled.has(i) && p.value > 0 ? (
            <span className="absolute left-1/2 -translate-x-1/2 truncate text-2xs font-medium tabular-nums text-sand-700" style={{ bottom: `calc(${pct(p.value)}% + 8px)` }}>
              {compactValue(p.value, format, locale)}
            </span>
          ) : null}
          <span className="absolute inset-x-0 bottom-0" style={{ height: `${pct(p.value)}%` }}>
            <Tip>{p.label}: {formatValue(p.value, format, locale)}</Tip>
          </span>
        </div>
      ))}
    </>
  );
}

/** A round number just above the maximum, so the scale reads 0 to 40, not 0 to 37. */
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * exp >= max) ?? 10;
  return step * exp;
}

// == Shares ======================================================================

export function BreakdownChart({
  data: given, chart, colours, title, locale, sort = "value", overrides = {},
}: {
  data: BreakdownData; chart: string; colours: string; title: string; locale: Lang; sort?: "value" | "name";
  /** Colours picked per slice (settings `c.<key>`): by the slice's key, or by rank (`r1`, `r2` ...). */
  overrides?: Record<string, string>;
}) {
  // "A to Z" reorders the slices; colours follow the slice's place, never its rank.
  const data = sort === "name"
    ? { ...given, items: [...given.items].sort((a, b) => a.label.localeCompare(b.label, localeOf(locale))) }
    : given;
  const total = data.items.reduce((a, i) => a + i.value, 0);
  if (total === 0) return <Empty locale={locale} />;
  const palette = (colours in PALETTES ? colours : "fleetwise") as PaletteKey;
  const swatch = (i: number) => {
    const item = data.items[i];
    const picked = swatchOf(overrides[item.key] ?? overrides[`r${i + 1}`]);
    if (picked) return picked;
    if (data.statusColoured && colours === "status" && item.status) return STATUS[item.status];
    const set = PALETTES[palette];
    return set[Math.min(i, set.length - 1)];
  };
  const shown = data.items.map((it, i) => ({ ...it, sw: swatch(i) }));

  if (chart === "bars" || chart === "list") {
    const max = Math.max(...shown.map((i) => i.value));
    return (
      <figure className="flex h-full min-h-0 flex-col" aria-label={title}>
        {/* Top-aligned, not centred: a centred column taller than its box pushes its first
            rows above the scroll origin, where they cannot be scrolled to. */}
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {shown.map((it) => (
            <li key={it.key}>
              <RowLink href={it.href}>
                <span className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2 text-sand-800">
                    {chart === "list" ? <span aria-hidden="true" className="viz-c viz-bg size-2.5 shrink-0 rounded-sm" style={styled(it.sw)} /> : null}
                    <span className="truncate" title={it.label}>{it.label}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-sand-900">{formatValue(it.value, data.format, locale)}</span>
                </span>
                {chart === "bars" ? (
                  <span className="mt-1 block h-2 rounded-full bg-surface-sunken">
                    <span className="viz-c viz-bg block h-2 rounded-full" style={styled(it.sw, { width: `${Math.max((it.value / max) * 100, it.value > 0 ? 2 : 0)}%` })} />
                  </span>
                ) : null}
              </RowLink>
            </li>
          ))}
        </ul>
        <DataTable caption={title} rows={shown} format={data.format} locale={locale} />
      </figure>
    );
  }

  // Ring or pie: one arc path per slice, a surface-coloured stroke as the gap between them.
  const pie = chart === "pie";
  let start = -Math.PI / 2;
  const slices = shown.filter((s) => s.value > 0).map((s) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const slice = { ...s, d: arcPath(50, 50, pie ? 0 : 30, 46, start, start + sweep) };
    start += sweep;
    return slice;
  });
  return (
    // Ring and legend side by side at every width: stacked, a phone-height widget cut the
    // legend (the values) off. The ring is a share of the width, capped.
    <figure className="flex h-full min-h-0 flex-row items-center gap-3 sm:gap-4" aria-label={title}>
      <div className="relative aspect-square w-[42%] max-w-44 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true">
          {slices.map((s) => (
            <path key={s.key} d={s.d} className="viz-c viz-fill stroke-surface" strokeWidth={slices.length > 1 ? 1.5 : 0} style={styled(s.sw)}>
              <title>{`${s.label}: ${formatValue(s.value, data.format, locale)}`}</title>
            </path>
          ))}
        </svg>
        {pie ? null : (
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-bold tabular-nums text-sand-950">{compactValue(total, data.format, locale)}</span>
            <span className="text-2xs text-sand-600">{t("dash.total", locale)}</span>
          </span>
        )}
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto">
        {shown.map((it) => (
          <li key={it.key}>
            <RowLink href={it.href}>
              <span className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2 text-sand-800">
                  <span aria-hidden="true" className="viz-c viz-bg size-2.5 shrink-0 rounded-sm" style={styled(it.sw)} />
                  <span className="truncate" title={it.label}>{it.label}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-sand-900">{formatValue(it.value, data.format, locale)}</span>
              </span>
            </RowLink>
          </li>
        ))}
      </ul>
      <DataTable caption={title} rows={shown} format={data.format} locale={locale} />
    </figure>
  );
}

/**
 * A ring slice (inner radius > 0) or a pie wedge (inner radius 0), angles in radians
 * from 12 o'clock clockwise. A slice of the whole circle stops just short of closing,
 * because an arc that ends where it starts draws nothing.
 */
function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const end = Math.min(a1, a0 + Math.PI * 2 - 0.0001);
  const large = end - a0 > Math.PI ? 1 : 0;
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  if (r0 <= 0) return `M ${cx} ${cy} L ${pt(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${pt(r1, end)} Z`;
  return `M ${pt(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${pt(r1, end)} L ${pt(r0, end)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
}

function RowLink({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <Link href={href} className="focus-ring -mx-1.5 block rounded-md px-1.5 py-1 hover:bg-surface-hover">{children}</Link>
  ) : (
    <span className="-mx-1.5 block px-1.5 py-1">{children}</span>
  );
}

// == Lists =======================================================================

export function ListWidget({ data, locale }: { data: ListData; locale: Lang }) {
  if (data.rows.length === 0) return <p className="flex h-full items-center justify-center text-sm text-sand-600">{data.empty}</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul className="-mx-1.5 flex min-h-0 flex-1 flex-col divide-y divide-sand-100 overflow-y-auto">
        {data.rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="focus-ring flex items-center gap-3 rounded-md px-1.5 py-2 hover:bg-surface-hover">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-sand-900">{r.title}</span>
                  {r.badge ? <Badge tone={r.badge.tone}>{r.badge.label}</Badge> : null}
                </span>
                <span className="block truncate text-sm text-sand-600">{r.sub}</span>
              </span>
              <ChevronRightIcon className="shrink-0 text-base text-sand-400" />
            </Link>
          </li>
        ))}
      </ul>
      {data.more > 0 ? <p className="pt-1.5 text-xs text-sand-600">{t("dash.more", locale).replace("{n}", String(data.more))}</p> : null}
    </div>
  );
}
