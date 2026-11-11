/**
 * The route services FLEETWISE can use, behind one shape. Mapbox now; Rapid Rise's own route
 * server (OSRM, the open-source engine) once trips pass about a thousand a month. Both answer
 * in the same form, so moving is a change of setting, not of code: see docs/ROUTING.md.
 *
 * Places are found with Nominatim (OpenStreetMap's search) whichever service draws the
 * routes. Mapbox's temporary search results may not be stored, and a trip stores its stops,
 * so searching there would put every saved route in breach of its terms.
 *
 * No server-only import here, so the parsing can be tested on its own.
 */

import type { LngLat } from "./geometry";

export type RoutePoint = { lat: number; lng: number };
export type RouteOption = { distanceM: number; durationS: number; line: LngLat[] };
export type Place = { label: string; lat: number; lng: number };
export type RouteProvider = "mapbox" | "osrm";

export type RouteErrorCode = "not_configured" | "no_route" | "invalid" | "limit" | "unavailable";

export class RouteError extends Error {
  constructor(public readonly code: RouteErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RouteError";
  }
}

export type RoutingConfig = {
  provider: RouteProvider;
  mapboxToken: string | null;
  osrmUrl: string | null;
  nominatimUrl: string;
  /** Route requests a month across FLEETWISE before the server stops asking. Null: no cap. */
  monthlyCap: number | null;
};

const MAPBOX_FREE_MONTHLY = 100_000;

/**
 * The settings, or what is wrong with them. A placeholder is treated as missing: `vercel pull`
 * writes `[SENSITIVE]` for a secret, and that once passed for a working email key for weeks
 * (src/lib/email/resend.test.ts).
 */
export function routingConfig(env: Record<string, string | undefined> = process.env): {
  config: RoutingConfig | null;
  problem: string | null;
} {
  const provider = (env.ROUTING_PROVIDER ?? "mapbox").trim().toLowerCase();
  const nominatimUrl = (env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").trim().replace(/\/+$/, "");
  const capRaw = (env.ROUTING_MONTHLY_CAP ?? "").trim();
  const capSet = capRaw !== "" && Number.isFinite(Number(capRaw)) && Number(capRaw) >= 0;

  if (provider === "mapbox") {
    const token = (env.MAPBOX_TOKEN ?? "").trim();
    if (!token) return { config: null, problem: "MAPBOX_TOKEN is not set" };
    if (/^\[.*\]$/.test(token)) return { config: null, problem: "MAPBOX_TOKEN is a placeholder, not a token" };
    if (!/^(pk|sk)\.[A-Za-z0-9._-]{20,}$/.test(token)) return { config: null, problem: "MAPBOX_TOKEN does not look like a Mapbox token" };
    return {
      config: {
        provider: "mapbox",
        mapboxToken: token,
        osrmUrl: null,
        nominatimUrl,
        // Stop short of the free allowance unless told otherwise.
        monthlyCap: capSet ? Number(capRaw) : Math.round(MAPBOX_FREE_MONTHLY * 0.95),
      },
      problem: null,
    };
  }
  if (provider === "osrm") {
    const url = (env.OSRM_URL ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(url)) return { config: null, problem: "OSRM_URL is not set to the route server's address" };
    return {
      config: { provider: "osrm", mapboxToken: null, osrmUrl: url, nominatimUrl, monthlyCap: capSet ? Number(capRaw) : null },
      problem: null,
    };
  }
  return { config: null, problem: `ROUTING_PROVIDER "${provider}" is not one FLEETWISE knows (mapbox or osrm)` };
}

const coordList = (points: RoutePoint[]) => points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

/** The request each service is sent. Kept apart so a test can read it without a network. */
export function routeUrl(config: RoutingConfig, points: RoutePoint[]): string {
  const coords = coordList(points);
  if (config.provider === "mapbox") {
    const params = new URLSearchParams({
      alternatives: "true",
      geometries: "geojson",
      overview: "full",
      steps: "false",
      access_token: config.mapboxToken ?? "",
    });
    return `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?${params.toString()}`;
  }
  const params = new URLSearchParams({ alternatives: "3", geometries: "geojson", overview: "full", steps: "false" });
  return `${config.osrmUrl}/route/v1/driving/${coords}?${params.toString()}`;
}

type RawRoute = { distance?: unknown; duration?: unknown; geometry?: { coordinates?: unknown } };

/** Mapbox and OSRM answer in the same shape (Mapbox's directions grew out of OSRM). */
export function parseRoutes(status: number, body: unknown): RouteOption[] {
  const json = (body ?? {}) as { code?: string; routes?: RawRoute[]; message?: string };
  if (status === 401 || status === 403) throw new RouteError("not_configured", "the route service refused the key");
  if (status === 429) throw new RouteError("limit", "the route service's rate limit");
  if (json.code === "NoRoute" || json.code === "NoSegment") throw new RouteError("no_route");
  if (status === 422 || json.code === "InvalidInput" || json.code === "InvalidValue" || json.code === "TooBig") {
    throw new RouteError("invalid", json.message ?? json.code);
  }
  if (status >= 400 || json.code !== "Ok" || !Array.isArray(json.routes)) {
    throw new RouteError("unavailable", `route service answered ${status} ${json.code ?? ""}`.trim());
  }
  const out: RouteOption[] = [];
  for (const r of json.routes) {
    const coords = r.geometry?.coordinates;
    if (typeof r.distance !== "number" || typeof r.duration !== "number" || !Array.isArray(coords)) continue;
    const line = coords.filter(
      (c): c is LngLat => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number",
    );
    if (line.length >= 2) out.push({ distanceM: Math.round(r.distance), durationS: Math.round(r.duration), line });
  }
  if (out.length === 0) throw new RouteError("no_route");
  return out;
}

/** Neighbours a truck from here may cross into, so a search can find a place over a border. */
const SEARCH_COUNTRIES = "za,bw,ls,mz,na,sz,zw,zm";

export function searchUrl(config: RoutingConfig, query: string): string {
  const params = new URLSearchParams({ q: query, format: "jsonv2", countrycodes: SEARCH_COUNTRIES, limit: "6" });
  return `${config.nominatimUrl}/search?${params.toString()}`;
}

export function reverseUrl(config: RoutingConfig, p: RoutePoint): string {
  const params = new URLSearchParams({ lat: p.lat.toFixed(6), lon: p.lng.toFixed(6), format: "jsonv2", zoom: "16" });
  return `${config.nominatimUrl}/reverse?${params.toString()}`;
}

type RawPlace = { lat?: unknown; lon?: unknown; display_name?: unknown; name?: unknown };

/** A short name first ("Engen N3 Mooi River"), then enough of the address to tell two apart. */
function placeLabel(raw: RawPlace): string {
  const full = typeof raw.display_name === "string" ? raw.display_name : "";
  const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : parts[0] ?? "";
  const rest = parts.filter((p) => p !== name).slice(0, 3);
  return [name, ...rest].join(", ").slice(0, 160);
}

export function parsePlaces(body: unknown): Place[] {
  if (!Array.isArray(body)) return [];
  const out: Place[] = [];
  for (const raw of body as RawPlace[]) {
    const lat = Number(raw.lat);
    const lng = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const label = placeLabel(raw);
    if (label) out.push({ label, lat, lng });
  }
  return out;
}

export function parseReverse(body: unknown): string | null {
  const raw = (body ?? {}) as RawPlace & { error?: unknown };
  if (raw.error) return null;
  const label = placeLabel(raw);
  return label || null;
}

/** Who to credit under the map, by service. Both draw on OpenStreetMap. */
export function attributionFor(provider: RouteProvider | null): string {
  const places = "Places © OpenStreetMap contributors";
  if (provider === "mapbox") return `Routes © Mapbox © OpenStreetMap · ${places}`;
  if (provider === "osrm") return `Routes: OSRM © OpenStreetMap contributors · ${places}`;
  return places;
}
