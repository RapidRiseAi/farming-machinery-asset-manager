// Dependency-free, server-rendered consumption sparkline (no client JS). Renders a row of
// vertical bars from interval consumption values. A latest interval well above the usual
// is marked by SHAPE as well as colour: the bar turns status-overdue and carries a small
// triangle on top, and the figure's accessible name says the numbers. Callers put the
// word ("Last fill high") beside it, from the same `latestInterval` rule in lib/fuel.
// Shared by the fuel page and machine detail.
import { latestInterval, type FuelInterval } from "@/lib/fuel";
import { num, shortDate } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";

export function FuelTrend({
  trend,
  unit,
  title,
  locale,
}: {
  trend: FuelInterval[];
  unit: string;
  title: string;
  /** With a locale, dates are formatted and the accessible name states the numbers. */
  locale?: Lang;
}) {
  if (trend.length === 0) return null;
  const max = Math.max(1, ...trend.map((d) => d.value));
  const latest = latestInterval(trend);
  const lastHigh = latest?.high ?? false;
  const fmt = (v: number) => `${num(v, 2)} ${unit}`;
  const label =
    locale && latest
      ? `${title}. ${
          latest.usual != null
            ? t(lastHigh ? "fuel.trendAriaHigh" : "fuel.trendAria", locale)
                .replace("{last}", fmt(latest.last))
                .replace("{usual}", fmt(latest.usual))
            : t("fuel.trendAriaOne", locale).replace("{last}", fmt(latest.last))
        }`
      : title;

  return (
    <figure role="img" aria-label={label} className="flex h-16 items-end gap-1 pt-3">
      {trend.slice(-16).map((d, i, arr) => {
        const pct = Math.round((d.value / max) * 100);
        const flag = i === arr.length - 1 && lastHigh;
        return (
          <div
            key={`${d.date}-${i}`}
            className={`relative min-w-[3px] flex-1 rounded-t-sm ${flag ? "bg-status-overdue" : "bg-brand-400"}`}
            style={{ height: `${Math.max(pct, 4)}%` }}
            title={`${locale ? shortDate(d.date, locale) : d.date}: ${fmt(d.value)}`}
          >
            {flag ? (
              <svg
                viewBox="0 0 10 10"
                aria-hidden
                className="absolute -top-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 text-status-overdue"
                fill="currentColor"
              >
                <path d="M5 1 9.3 8.6H0.7z" />
              </svg>
            ) : null}
          </div>
        );
      })}
    </figure>
  );
}
