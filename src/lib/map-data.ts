/**
 * Turning stored points into what the map draws. Plain data in, plain data out, so it can be
 * tested without a browser.
 */

export type Point = { lat: number; lng: number; at: string };
export type TrackedPoint = Point & { machineId: string };

/** The newest point for each vehicle: where it was last seen. */
export function lastSeen<T extends TrackedPoint>(points: T[]): T[] {
  const latest = new Map<string, T>();
  for (const p of points) {
    const held = latest.get(p.machineId);
    if (!held || held.at < p.at) latest.set(p.machineId, p);
  }
  return [...latest.values()];
}

/** A route as map coordinates, oldest first. A point with no real position is left out. */
export function routeLine(points: Point[]): [number, number][] {
  return [...points]
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((p) => [p.lng, p.lat]);
}

/** The box around some points, for fitting the map to them. Null with nothing to show. */
export function boundsOf(points: { lat: number; lng: number }[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

const EARTH_KM = 6371;
const radians = (d: number) => (d * Math.PI) / 180;

/** How far a route went, in kilometres, along the points recorded. */
export function routeKm(line: [number, number][]): number {
  let km = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [lng1, lat1] = line[i - 1];
    const [lng2, lat2] = line[i];
    const a =
      Math.sin(radians(lat2 - lat1) / 2) ** 2
      + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
    km += 2 * EARTH_KM * Math.asin(Math.sqrt(a));
  }
  return km;
}

export type IncomingPoint = { lat: number; lng: number; at: string; speed?: number | null; accuracy?: number | null };

/**
 * What a phone may send. Only real coordinates, no time from the future, and nothing older
 * than a day: a phone with a wrong clock must not rewrite where a vehicle was.
 */
export function cleanPoints(input: unknown, now: Date = new Date()): IncomingPoint[] {
  if (!Array.isArray(input)) return [];
  const newest = now.getTime() + 5 * 60 * 1000;
  const oldest = now.getTime() - 24 * 60 * 60 * 1000;
  const out: IncomingPoint[] = [];
  for (const raw of input.slice(0, 200)) {
    const p = raw as Partial<IncomingPoint> | null;
    const at = typeof p?.at === "string" ? Date.parse(p.at) : Number.NaN;
    const { lat, lng } = p ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isFinite(at) || at > newest || at < oldest) continue;
    out.push({
      lat,
      lng,
      at: new Date(at).toISOString(),
      speed: typeof p?.speed === "number" && p.speed >= 0 ? p.speed : null,
      accuracy: typeof p?.accuracy === "number" && p.accuracy >= 0 ? p.accuracy : null,
    });
  }
  return out;
}
