/**
 * Route planning without a network: the settings that choose a service, the requests sent,
 * the answers read, and the arithmetic a driver's distance is judged by (20261111090000).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { kmCheck, lineKm, offRoute, thinLine, type LngLat } from "./geometry";
import { googleMapsLink, wazeLink } from "./links";
import {
  attributionFor,
  parsePlaces,
  parseReverse,
  parseRoutes,
  routeUrl,
  routingConfig,
  RouteError,
  searchUrl,
} from "./providers";

const TOKEN = "pk.eyJ1IjoicmFwaWRyaXNlIiwiYSI6ImNsdGVzdDEyMyJ9.abcdefghijklmnop";
const DURBAN = { lat: -29.8587, lng: 31.0218 };
const JOBURG = { lat: -26.2041, lng: 28.0473 };

test("Mapbox is the default service, and needs a real token", () => {
  assert.match(routingConfig({}).problem ?? "", /MAPBOX_TOKEN is not set/);
  // What `vercel pull` writes for a secret: it once passed for a working email key for weeks.
  assert.match(routingConfig({ MAPBOX_TOKEN: "[SENSITIVE]" }).problem ?? "", /placeholder/);
  assert.match(routingConfig({ MAPBOX_TOKEN: "abc" }).problem ?? "", /does not look like/);
  const { config, problem } = routingConfig({ MAPBOX_TOKEN: TOKEN });
  assert.equal(problem, null);
  assert.equal(config?.provider, "mapbox");
  // Stops short of the 100,000 free requests unless told otherwise.
  assert.equal(config?.monthlyCap, 95_000);
  assert.equal(routingConfig({ MAPBOX_TOKEN: TOKEN, ROUTING_MONTHLY_CAP: "5000" }).config?.monthlyCap, 5000);
});

test("moving to the own route server is one setting and an address", () => {
  assert.match(routingConfig({ ROUTING_PROVIDER: "osrm" }).problem ?? "", /OSRM_URL/);
  const { config } = routingConfig({ ROUTING_PROVIDER: "osrm", OSRM_URL: "https://routes.example.co.za/" });
  assert.equal(config?.provider, "osrm");
  assert.equal(config?.osrmUrl, "https://routes.example.co.za");
  assert.equal(config?.monthlyCap, null, "our own server has no allowance to protect");
  assert.match(routingConfig({ ROUTING_PROVIDER: "google" }).problem ?? "", /not one FLEETWISE knows/);
});

test("both services are asked for alternatives, longitude first", () => {
  const mapbox = routingConfig({ MAPBOX_TOKEN: TOKEN }).config!;
  const url = new URL(routeUrl(mapbox, [DURBAN, JOBURG]));
  assert.equal(url.host, "api.mapbox.com");
  assert.ok(url.pathname.endsWith("/driving/31.021800,-29.858700;28.047300,-26.204100"));
  assert.equal(url.searchParams.get("alternatives"), "true");
  assert.equal(url.searchParams.get("geometries"), "geojson");

  const osrm = routingConfig({ ROUTING_PROVIDER: "osrm", OSRM_URL: "https://r.example" }).config!;
  const own = new URL(routeUrl(osrm, [DURBAN, JOBURG]));
  assert.equal(own.origin, "https://r.example");
  assert.ok(own.pathname.startsWith("/route/v1/driving/"));
  assert.equal(own.searchParams.get("access_token"), null, "no Mapbox key leaves for our own server");
});

test("an answer becomes routes; a refusal says why", () => {
  const ok = {
    code: "Ok",
    routes: [
      { distance: 568123.4, duration: 20400.6, geometry: { coordinates: [[31.02, -29.86], [29.5, -28], [28.05, -26.2]] } },
      { distance: 601000, duration: 21000, geometry: { coordinates: [[31.02, -29.86], [28.05, -26.2]] } },
    ],
  };
  const routes = parseRoutes(200, ok);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0], { distanceM: 568123, durationS: 20401, line: [[31.02, -29.86], [29.5, -28], [28.05, -26.2]] });

  const code = (status: number, body: unknown) => {
    try {
      parseRoutes(status, body);
      return "none";
    } catch (e) {
      assert.ok(e instanceof RouteError);
      return e.code;
    }
  };
  assert.equal(code(200, { code: "NoRoute", routes: [] }), "no_route");
  assert.equal(code(401, { message: "Not Authorized" }), "not_configured");
  assert.equal(code(429, {}), "limit");
  assert.equal(code(422, { code: "InvalidInput" }), "invalid");
  assert.equal(code(500, null), "unavailable");
  assert.equal(code(200, { code: "Ok", routes: [{ distance: 1, duration: 1, geometry: { coordinates: [[1, 1]] } }] }), "no_route");
});

test("place search covers the neighbours a truck crosses into, and reads names", () => {
  const config = routingConfig({ MAPBOX_TOKEN: TOKEN }).config!;
  const url = new URL(searchUrl(config, "Beitbridge border post"));
  assert.equal(url.host, "nominatim.openstreetmap.org", "places come from OpenStreetMap, whose results may be kept");
  assert.ok(url.searchParams.get("countrycodes")?.split(",").includes("zw"));

  const places = parsePlaces([
    { lat: "-22.2167", lon: "29.9833", name: "Beitbridge", display_name: "Beitbridge, Vhembe, Limpopo, 0900, South Africa" },
    { lat: "nonsense", lon: "1", display_name: "Nowhere" },
  ]);
  assert.equal(places.length, 1);
  assert.equal(places[0].label, "Beitbridge, Vhembe, Limpopo, 0900");
  assert.equal(parseReverse({ error: "Unable to geocode" }), null);
  assert.equal(parseReverse({ display_name: "N3, Mooi River, KwaZulu-Natal, South Africa" }), "N3, Mooi River, KwaZulu-Natal, South Africa");
  assert.match(attributionFor("mapbox"), /Mapbox/);
  assert.match(attributionFor("osrm"), /OSRM/);
});

test("the distance check prefers the odometer and honours the tolerance", () => {
  const base = { plannedKm: 500, recordedKm: 480, tolerancePct: 10 };
  assert.equal(kmCheck({ ...base, odometerKm: 540 }).verdict, "ok");
  const over = kmCheck({ ...base, odometerKm: 560 });
  assert.equal(over.verdict, "over");
  assert.equal(over.basis, "odometer");
  assert.equal(Math.round(over.diffPct ?? 0), 12);
  assert.equal(kmCheck({ ...base, odometerKm: 400 }).verdict, "under");
  // No odometer at both ends: the recorded trail is used, and said to be.
  const recorded = kmCheck({ ...base, odometerKm: null });
  assert.equal(recorded.basis, "recorded");
  assert.equal(recorded.verdict, "ok");
  assert.equal(kmCheck({ ...base, plannedKm: null, odometerKm: 500 }).verdict, "unknown");
  assert.equal(kmCheck({ plannedKm: 500, odometerKm: null, recordedKm: null, tolerancePct: 10 }).verdict, "unknown");
});

test("a line is measured, thinned and held against the plan", () => {
  const straight: LngLat[] = [[DURBAN.lng, DURBAN.lat], [JOBURG.lng, JOBURG.lat]];
  const km = lineKm(straight);
  assert.ok(km > 480 && km < 520, `Durban to Johannesburg as the crow flies, got ${km}`);

  // A dense line keeps its ends and comes under the limit.
  const dense: LngLat[] = Array.from({ length: 5000 }, (_, i) => [28 + i * 0.0006, -26 + Math.sin(i / 50) * 0.01]);
  const thin = thinLine(dense, 500);
  assert.ok(thin.length <= 500);
  assert.deepEqual(thin[0], dense[0]);
  assert.deepEqual(thin[thin.length - 1], dense[dense.length - 1]);

  // Driving the plan is on it; a detour 20 km north is off it.
  const plan: LngLat[] = Array.from({ length: 50 }, (_, i) => [28 + i * 0.02, -26]);
  const same = offRoute(plan, plan.map(([lng, lat]) => [lng, lat + 0.001]));
  assert.ok(same && same.offKm < 0.5, "a trail beside the planned road is on it");
  const detour = offRoute(plan, [[28, -26], [28.2, -26], [28.3, -25.8], [28.5, -25.8], [28.6, -26], [28.98, -26]]);
  assert.ok(detour && detour.offKm > 10, `a detour is counted, got ${detour?.offKm}`);
  assert.equal(offRoute(plan, [[28, -26]]), null, "one point is not a route");
});

test("a driver's navigation links carry every stop in order", () => {
  const link = googleMapsLink([
    { lat: -29.8587, lng: 31.0218 },
    { lat: -28.9, lng: 29.9 },
    { lat: -26.2041, lng: 28.0473 },
  ]);
  const url = new URL(link ?? "");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("origin"), "-29.858700,31.021800");
  assert.equal(url.searchParams.get("destination"), "-26.204100,28.047300");
  assert.equal(url.searchParams.get("waypoints"), "-28.900000,29.900000");
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.equal(googleMapsLink([{ lat: 1, lng: 1 }]), null);
  assert.equal(wazeLink({ lat: -26.2, lng: 28.05 }), "https://waze.com/ul?ll=-26.200000%2C28.050000&navigate=yes");
  assert.equal(wazeLink(null), null);
});
