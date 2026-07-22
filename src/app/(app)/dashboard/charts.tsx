// Lightweight, dependency-free, server-rendered charts for the dashboard.
// Pure HTML/CSS (flex + width/height %) — no SVG runtime, no client JS, themed
// with the design tokens. Each chart is labelled for assistive tech.

type Datum = { key: string; label: string; value: number; href?: string };

/** Format a cents value as compact Rands for chart labels (e.g. R12.5k). */
function compactRands(cents: number): string {
  const r = cents / 100;
  if (r >= 1000) return "R" + (r / 1000).toLocaleString("en-ZA", { maximumFractionDigits: 1 }) + "k";
  return "R" + r.toLocaleString("en-ZA", { maximumFractionDigits: 0 });
}

/** Vertical bar chart — used for the 6-month spend trend. Values are cents. */
export function SpendTrend({ data, title }: { data: Datum[]; title: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure role="img" aria-label={title} className="flex flex-col gap-2">
      <div className="flex h-40 items-end gap-2">
        {data.map((d) => {
          const pct = Math.round((d.value / max) * 100);
          return (
            <div key={d.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[0.65rem] font-medium tabular-nums text-sand-500">
                {d.value > 0 ? compactRands(d.value) : ""}
              </span>
              <div
                className="w-full rounded-t-md bg-brand-500"
                style={{ height: `${Math.max(pct, d.value > 0 ? 4 : 0)}%` }}
                title={`${d.label}: ${compactRands(d.value)}`}
              />
              <span className="w-full truncate text-center text-[0.65rem] text-sand-400">{d.label}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** Horizontal labelled bars — used for spend-by-type and cost-per-machine. */
export function HBars({
  data,
  title,
  emptyLabel,
}: {
  data: Datum[];
  title: string;
  emptyLabel: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) {
    return <p className="text-sm text-sand-500">{emptyLabel}</p>;
  }
  return (
    <ul role="img" aria-label={title} className="flex flex-col gap-2.5">
      {data.map((d) => {
        const pct = Math.round((d.value / max) * 100);
        const row = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-sand-700">{d.label}</span>
              <span className="shrink-0 text-sm font-medium tabular-nums text-sand-900">
                {compactRands(d.value)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-sand-100">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </>
        );
        return (
          <li key={d.key}>
            {d.href ? (
              <a href={d.href} className="focus-ring block rounded-md">
                {row}
              </a>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
