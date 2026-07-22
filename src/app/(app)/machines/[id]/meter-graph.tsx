// Server-rendered SVG line chart of meter readings over time. Dependency-free.

type Reading = { reading: number; reading_date: string };

export function MeterGraph({ readings, unit, title }: { readings: Reading[]; unit: string; title: string }) {
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
      <figcaption className="mt-1 flex justify-between text-xs text-sand-400">
        <span>{pts[0].reading_date} · {minV} {unit}</span>
        <span>{pts[pts.length - 1].reading_date} · {maxV} {unit}</span>
      </figcaption>
    </figure>
  );
}
