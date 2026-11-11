/**
 * Lines on the map as plain numbers, so they can be tested without a browser or a route
 * service: thinning a long line, measuring it, and holding the route driven against the
 * route planned. Coordinates are [lng, lat], the order map libraries and GeoJSON use.
 */

export type LngLat = [number, number];

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Metres between two points, along the earth's surface. */
export function metresBetween(a: LngLat, b: LngLat): number {
  const h =
    Math.sin(rad(b[1] - a[1]) / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How long a line is, in kilometres. */
export function lineKm(line: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i += 1) m += metresBetween(line[i - 1], line[i]);
  return m / 1000;
}

/**
 * Flat metres around a latitude. Good to well under a percent over the few kilometres that
 * matter when asking whether a point is near a road, and far cheaper than spherical sums.
 */
function projector(lat0: number) {
  const k = Math.cos(rad(lat0));
  return (p: LngLat): [number, number] => [rad(p[0]) * EARTH_M * k, rad(p[1]) * EARTH_M];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker at a tolerance in metres. Keeps the first and last point. */
function thinAt(line: LngLat[], toleranceM: number): LngLat[] {
  if (line.length <= 2) return line;
  const flat = line.map(projector(line[0][1]));
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let worst = 0;
    let at = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistance(flat[i], flat[first], flat[last]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at !== -1 && worst > toleranceM) {
      keep[at] = 1;
      stack.push([first, at], [at, last]);
    }
  }
  return line.filter((_, i) => keep[i] === 1);
}

/**
 * A line with at most `max` points, as close to the original as that allows. A route service
 * returns a point every few metres; a few hundred keep the shape on screen and in storage.
 */
export function thinLine(line: LngLat[], max = 1500): LngLat[] {
  if (line.length <= max) return line;
  let tolerance = 5;
  let out = thinAt(line, tolerance);
  while (out.length > max && tolerance < 50_000) {
    tolerance *= 2;
    out = thinAt(line, tolerance);
  }
  return out;
}

/** Every nth point, keeping the last, so a long driven trail can be checked quickly. */
function sample(line: LngLat[], max: number): LngLat[] {
  if (line.length <= max) return line;
  const step = line.length / max;
  const out: LngLat[] = [];
  for (let i = 0; i < max; i += 1) out.push(line[Math.floor(i * step)]);
  out.push(line[line.length - 1]);
  return out;
}

export type OffRoute = {
  /** Kilometres driven more than `thresholdM` from the planned line. */
  offKm: number;
  /** That, as a share of everything driven (0 to 1). */
  share: number;
};

/**
 * How much of what was driven was away from the planned line. A road a few hundred metres
 * off is the same road drawn differently by two services, so the threshold is generous.
 */
export function offRoute(planned: LngLat[], driven: LngLat[], thresholdM = 1000): OffRoute | null {
  if (planned.length < 2 || driven.length < 2) return null;
  const project = projector(planned[0][1]);
  const flatPlan = planned.map(project);
  const trail = sample(driven, 2000);
  const near = (p: LngLat) => {
    const q = project(p);
    for (let i = 1; i < flatPlan.length; i += 1) {
      if (segmentDistance(q, flatPlan[i - 1], flatPlan[i]) <= thresholdM) return true;
    }
    return false;
  };
  let total = 0;
  let off = 0;
  let previousNear = near(trail[0]);
  for (let i = 1; i < trail.length; i += 1) {
    const m = metresBetween(trail[i - 1], trail[i]);
    const nowNear = near(trail[i]);
    total += m;
    if (!nowNear && !previousNear) off += m;
    previousNear = nowNear;
  }
  return { offKm: off / 1000, share: total === 0 ? 0 : off / total };
}

export type KmVerdict = "ok" | "over" | "under" | "unknown";

export type KmCheck = {
  plannedKm: number | null;
  /** The distance the planned route is held against: the odometer when there is one. */
  actualKm: number | null;
  basis: "odometer" | "recorded" | null;
  diffKm: number | null;
  diffPct: number | null;
  verdict: KmVerdict;
};

/**
 * The planned distance against what was driven. The odometer is the record when the vehicle
 * has one and both readings were given; a recorded trail is used only without it, because a
 * phone that lost signal records less than was driven.
 */
export function kmCheck(input: {
  plannedKm: number | null;
  odometerKm: number | null;
  recordedKm: number | null;
  tolerancePct: number;
}): KmCheck {
  const { plannedKm, odometerKm, recordedKm, tolerancePct } = input;
  const basis = odometerKm != null && odometerKm > 0 ? "odometer" : recordedKm != null && recordedKm > 0 ? "recorded" : null;
  const actualKm = basis === "odometer" ? odometerKm : basis === "recorded" ? recordedKm : null;
  if (plannedKm == null || plannedKm <= 0 || actualKm == null) {
    return { plannedKm, actualKm, basis, diffKm: null, diffPct: null, verdict: "unknown" };
  }
  const diffKm = actualKm - plannedKm;
  const diffPct = (diffKm / plannedKm) * 100;
  const verdict: KmVerdict = Math.abs(diffPct) <= tolerancePct ? "ok" : diffPct > 0 ? "over" : "under";
  return { plannedKm, actualKm, basis, diffKm, diffPct, verdict };
}
