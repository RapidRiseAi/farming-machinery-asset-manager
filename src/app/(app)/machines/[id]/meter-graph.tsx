// Server-rendered SVG line chart of meter readings over time. Dependency-free.
// The axis labels go through the format helpers: this printed "2026-05-06 · 3270 hours"
// under a header that says "4 000 hours", and gave the Afrikaans profile English units.
import type { Lang } from "@/lib/i18n";
import { meterReading, shortDate } from "@/lib/format";

type Reading = { reading: number; reading_date: string };

export function MeterGraph({
  readings,
  unit,
  title,
  locale,
}: {
  readings: Reading[];
  /** The machine's meter_type ("hours" | "km"), not a display word. */
  unit: string;
  title: string;
  locale: Lang;
}) {
  // Oldest → newest, left → right.
  const pts = [...readings].sort((a, b) => a.reading_date.localeCompare(b.reading_date));
  if (pts.length < 2) return null;

  const W = 640;
  const H = 160;
  const padX = 8;
  const padY = 14;
  const readings_v = pts.map((p) => p.reading);
  const minV = Math.min(...readings_v);
  const maxV = Math.max(...readings_v);
  const spanV = maxV - minV || 1;

  const x = (i: number) => padX + (i / (pts.length - 1)) * (W - 2 * padX);
  const y = (v: number) => padY + (1 - (v - minV) / spanV) * (H - 2 * padY);

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.reading).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${(H - padY).toFixed(1)} L${x(0).toFixed(1)},${(H - padY).toFixed(1)} Z`;

  return (
    <figure role="img" aria-label={title} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none">
        <path d={area} className="fill-brand-100" />
        <path d={line} className="fill-none stroke-brand-600" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.reading)} r={2.5} className="fill-brand-600" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-sand-500">
        <span>{shortDate(pts[0].reading_date, locale)} · {meterReading(minV, unit, locale)}</span>
        <span>{shortDate(pts[pts.length - 1].reading_date, locale)} · {meterReading(maxV, unit, locale)}</span>
      </figcaption>
    </figure>
  );
}
