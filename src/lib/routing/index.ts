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
// Its public service asks for at most one request a second from an application, and a name
// that says who is asking. Searches happen only when a person presses search, never while
// they type, and each server instance keeps a second between its own requests.

let nextSlot = 0;
async function politely(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1100;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function placeHeaders(): HeadersInit {
  return {
    "user-agent": `FLEETWISE route planner (+${siteUrl() ?? "https://app.fleet-wise.co.za"})`,
    "accept-language": "en",
  };
}

export async function searchPlaces(farmId: string, query: string): Promise<Place[]> {
  const { config, problem } = routingConfig();
  if (!config) throw new RouteError("not_configured", problem ?? undefined);
  await politely();
  try {
    const response = await fetch(searchUrl(config, query), {
      headers: placeHeaders(),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    void count(farmId, 0, 1);
    if (response.status === 429) throw new RouteError("limit", "the place search is busy");
    if (!response.ok) throw new RouteError("unavailable", `place search answered ${response.status}`);
    return parsePlaces(await response.json().catch(() => null));
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
  await politely();
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
