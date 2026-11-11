import "server-only";

import { siteUrl } from "@/lib/env";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

import { thinLine } from "./geometry";
import {
  parsePlaces,
  parseReverse,
  parseRoutes,
  reverseUrl,
  RouteError,
  routeUrl,
  routingConfig,
  searchUrl,
  type Place,
  type RouteOption,
  type RoutePoint,
  type RouteProvider,
} from "./providers";

export { RouteError, routingConfig, attributionFor } from "./providers";
export type { Place, RouteOption, RoutePoint, RouteProvider } from "./providers";

/** The most stops a route may have: Mapbox's limit, so a plan never depends on the service. */
export const MAX_STOPS = 25;

/** Points that are real places, in order. Anything else is refused before a service is asked. */
export function validPoints(input: unknown): RoutePoint[] | null {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_STOPS) return null;
  const out: RoutePoint[] = [];
  for (const raw of input) {
    const p = raw as Partial<RoutePoint> | null;
    if (typeof p?.lat !== "number" || typeof p?.lng !== "number") return null;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    out.push({ lat: p.lat, lng: p.lng });
  }
  return out;
}

/**
 * Counts against the month's allowance and answers with FLEETWISE's routes this month. With
 * both counts at zero it only reads the total, so a request the cap would refuse is never
 * sent to the service.
 */
async function count(farmId: string, routes: number, searches: number): Promise<number | null> {
  const { data, error } = await createServiceClient().rpc("count_routing_use", {
    p_farm: farmId,
    p_routes: routes,
    p_searches: searches,
  });
  if (error) {
    captureError(error, { where: "routing:count", farmId });
    return null;
  }
  return Number(data);
}

/** Routes between the points in order, the first the service's choice, then alternatives. */
export async function planRoutes(
  farmId: string,
  points: RoutePoint[],
): Promise<{ provider: RouteProvider; options: RouteOption[] }> {
  const { config, problem } = routingConfig();
  if (!config) throw new RouteError("not_configured", problem ?? undefined);

  if (config.monthlyCap != null) {
    const total = await count(farmId, 0, 0);
    if (total != null && total >= config.monthlyCap) throw new RouteError("limit", "the month's route allowance is used up");
  }

  let response: Response;
  try {
    response = await fetch(routeUrl(config, points), { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  } catch (failure) {
    captureError(failure, { where: "routing:fetch", farmId });
    throw new RouteError("unavailable", "the route service did not answer");
  }
  const body = await response.json().catch(() => null);
  void count(farmId, 1, 0);
  const options = parseRoutes(response.status, body).map((o) => ({ ...o, line: thinLine(o.line) }));
  return { provider: config.provider, options };
}

// == Places (OpenStreetMap's Nominatim) ==========================================
// Its usage policy (operations.osmfoundation.org/policies/nominatim/) allows at most one
// request a second, counted for the whole application across all its users, searches a person
// asks for, and a name that says who is asking; it asks apps to cache where they can. So: a
// search happens when a person presses Search or opens a trip's planner, never while they
// type; answers are kept in the database for a month and served from there; and every server
// instance books its moment from one shared slot (20261111130000). docs/ROUTING.md has more.

/** How long to wait for a slot before telling the person the search is busy. */
const MAX_SLOT_WAIT_MS = 6_000;
const DAY_MS = 86_400_000;
/** Changes when the search's settings (countries, number of answers, language) change. */
const CACHE_VERSION = "za6en";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Used only when the shared slot cannot be read: spacing within this instance, as before.
let nextSlot = 0;
async function politelyHere(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1100;
  if (wait > 0) await sleep(wait);
}

/** Waits for this request's moment in the application's one-a-second queue. */
async function politely(): Promise<void> {
  const { data, error } = await createServiceClient().rpc("book_place_search_slot");
  if (error) {
    captureError(error, { where: "routing:slot" });
    await politelyHere();
    return;
  }
  const wait = Number(data);
  if (!Number.isFinite(wait) || wait <= 0) return;
  if (wait > MAX_SLOT_WAIT_MS) throw new RouteError("busy", "the place search queue is long");
  await sleep(wait);
}

function placeHeaders(): HeadersInit {
  return {
    "user-agent": `FLEETWISE route planner (+${siteUrl() ?? "https://app.fleet-wise.co.za"})`,
    "accept-language": "en",
  };
}

/** One spelling per search: "  Nelspruit " and "nelspruit" are the same question. */
export function placeCacheKey(query: string): string {
  return `${CACHE_VERSION}|${query.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200)}`;
}

/** Places as stored by keepPlaces; anything else is treated as not stored. */
function storedPlaces(raw: unknown): Place[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Place[] = [];
  for (const p of raw as Partial<Place>[]) {
    if (typeof p?.label !== "string" || typeof p.lat !== "number" || typeof p.lng !== "number") return null;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
    out.push({ label: p.label, lat: p.lat, lng: p.lng });
  }
  return out;
}

/** A stored answer still fresh: a month for places found, a day for a search that found none. */
async function cachedPlaces(key: string): Promise<Place[] | null> {
  const { data, error } = await createServiceClient()
    .from("place_search_cache")
    .select("places, fetched_at")
    .eq("query", key)
    .maybeSingle();
  if (error) {
    captureError(error, { where: "routing:cache-read" });
    return null;
  }
  if (!data) return null;
  const places = storedPlaces(data.places);
  if (!places) return null;
  const age = Date.now() - new Date(data.fetched_at as string).getTime();
  return age < (places.length > 0 ? 30 : 1) * DAY_MS ? places : null;
}

async function keepPlaces(key: string, places: Place[]): Promise<void> {
  const { error } = await createServiceClient()
    .from("place_search_cache")
    .upsert({ query: key, places, fetched_at: new Date().toISOString() }, { onConflict: "query" });
  if (error) captureError(error, { where: "routing:cache-write" });
}

export async function searchPlaces(farmId: string, query: string): Promise<Place[]> {
  const { config, problem } = routingConfig();
  if (!config) throw new RouteError("not_configured", problem ?? undefined);
  const key = placeCacheKey(query);
  void count(farmId, 0, 1);
  const kept = await cachedPlaces(key);
  if (kept) return kept;

  await politely();
  try {
    const response = await fetch(searchUrl(config, query), {
      headers: placeHeaders(),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (response.status === 429) throw new RouteError("busy", "the place search is busy");
    if (!response.ok) throw new RouteError("unavailable", `place search answered ${response.status}`);
    const places = parsePlaces(await response.json().catch(() => null));
    await keepPlaces(key, places);
    return places;
  } catch (failure) {
    if (failure instanceof RouteError) throw failure;
    captureError(failure, { where: "routing:search", farmId });
    throw new RouteError("unavailable", "the place search did not answer");
  }
}

/** A name for a pin dropped on the map. Nothing is lost without one: the pin still counts. */
export async function placeName(farmId: string, point: RoutePoint): Promise<string | null> {
  const { config } = routingConfig();
  if (!config) return null;
  try {
    await politely();
  } catch {
    return null;
  }
  try {
    const response = await fetch(reverseUrl(config, point), {
      headers: placeHeaders(),
      signal: AbortSignal.timeout(6_000),
      cache: "no-store",
    });
    void count(farmId, 0, 1);
    if (!response.ok) return null;
    return parseReverse(await response.json().catch(() => null));
  } catch {
    return null;
  }
}
