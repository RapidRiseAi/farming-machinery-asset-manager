// Dependency-free, server-rendered consumption sparkline (no client JS). Renders a row of
// vertical bars from interval consumption values; the final bar is tinted by tone so an
// anomalous latest interval stands out. Shared by the fuel page and machine detail.
import type { FuelInterval } from "@/lib/fuel";

export function FuelTrend({ trend, unit, title }: { trend: FuelInterval[]; unit: string; title: string }) {
  if (trend.length === 0) return null;
  const max = Math.max(1, ...trend.map((d) => d.value));
  const last = trend[trend.length - 1];
  const baseline =
    trend.length > 1 ? trend.slice(0, -1).reduce((a, d) => a + d.value, 0) / (trend.length - 1) : null;
  const lastHigh = baseline != null && last.value > baseline * 1.5;

  return (
    <figure role="img" aria-label={title} className="flex h-16 items-end gap-1">
      {trend.slice(-16).map((d, i, arr) => {
        const pct = Math.round((d.value / max) * 100);
        const isLast = i === arr.length - 1;
        return (
          <div
            key={`${d.date}-${i}`}
            className={`min-w-[3px] flex-1 rounded-t-sm ${isLast && lastHigh ? "bg-status-overdue" : "bg-brand-400"}`}
            style={{ height: `${Math.max(pct, 4)}%` }}
            title={`${d.date}: ${d.value.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} ${unit}`}
          />
        );
      })}
    </figure>
  );
}
