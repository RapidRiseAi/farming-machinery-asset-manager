import Link from "next/link";

import { num } from "@/lib/format";
import { t, type Lang } from "@/lib/i18n";
import { routeLine } from "@/lib/map-data";
import { kmCheck, lineKm, offRoute, type LngLat } from "@/lib/routing/geometry";
import { googleMapsLink, wazeLink, type Stop } from "@/lib/routing/links";
import { SETTING_NUMBERS } from "@/lib/settings";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { tripDistance } from "@/lib/trips";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, FactList } from "@/components/ui/facts";
import { SubmitButton } from "@/components/ui/submit-button";
import { FleetMap, type MapLine, type MapMarker } from "@/components/map/fleet-map";
import { RouteRecorder } from "@/components/map/route-recorder";
import { clearTripRoute } from "../actions";

export type RouteCardTrip = {
  id: string;
  farm_id: string;
  status: string;
  machine_id: string;
  driver_id: string | null;
  driving_session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  opening_reading: number | null;
  closing_reading: number | null;
};

type SavedRoute = {
  waypoints: Stop[];
  geometry: LngLat[];
  distance_m: number;
  duration_s: number;
  provider: string;
};

/** "5 h 40 min", or "35 min" under an hour. */
export function durationText(seconds: number, locale: Lang): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0
    ? t("routes.hoursMinutes", locale).replace("{h}", String(h)).replace("{m}", String(m))
    : t("routes.minutes", locale).replace("{m}", String(m));
}

/**
 * A trip's route: the one planned and the one driven, and whether the distance adds up. Only
 * shown where the map is on. A driver sees their own trip's plan and what their phone
 * recorded; an owner or manager also sees what a tracker recorded (positions' own rules).
 */
export async function TripRouteCard({
  trip,
  viewerId,
  manager,
  kmMeter,
  locale,
}: {
  trip: RouteCardTrip;
  viewerId: string;
  manager: boolean;
  kmMeter: boolean;
  locale: Lang;
}) {
  const supabase = await createClient();
  const until = trip.ended_at ?? new Date().toISOString();
  const [routeRes, positionRes, farmRes] = await Promise.all([
    supabase
      .from("trip_routes")
      .select("waypoints, geometry, distance_m, duration_s, provider")
      .eq("trip_id", trip.id)
      .maybeSingle(),
    trip.started_at
      ? supabase
          .from("asset_positions")
          .select("lat, lng, recorded_at")
          .eq("machine_id", trip.machine_id)
          .gte("recorded_at", trip.started_at)
          .lte("recorded_at", until)
          .order("recorded_at")
          .limit(5000)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("farms").select("settings").eq("id", trip.farm_id).maybeSingle(),
  ]);
  const route = must(routeRes, "trip:route") as SavedRoute | null;
  const positions = (must(positionRes, "trip:positions") ?? []) as { lat: number; lng: number; recorded_at: string }[];
  const settings = ((must(farmRes, "trip:settings") as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const tolerance =
    typeof settings.route_km_tolerance_pct === "number" ? settings.route_km_tolerance_pct : SETTING_NUMBERS.route_km_tolerance_pct;

  const driven = routeLine(positions.map((p) => ({ lat: p.lat, lng: p.lng, at: p.recorded_at })));
  const recordedKm = driven.length > 1 ? lineKm(driven) : null;
  const check = kmCheck({
    plannedKm: route ? route.distance_m / 1000 : null,
    odometerKm: kmMeter ? tripDistance(trip) : null,
    recordedKm,
    tolerancePct: tolerance,
  });
  const away = route && driven.length > 1 ? offRoute(route.geometry, driven) : null;

  const open = trip.status === "planned" || trip.status === "underway";
  const isDriver = trip.driver_id === viewerId;
  const stops = route?.waypoints ?? [];
  const google = route && open ? googleMapsLink(stops) : null;
  const waze = route && open ? wazeLink(stops[stops.length - 1]) : null;

  const lines: MapLine[] = [
    ...(route ? [{ id: "planned", kind: "planned" as const, coords: route.geometry }] : []),
    ...(driven.length > 1 ? [{ id: "driven", kind: "driven" as const, coords: driven }] : []),
  ];
  const markers: MapMarker[] = stops.map((s, i) => ({
    id: `stop-${i}`,
    lat: s.lat,
    lng: s.lng,
    title: s.label || String.fromCharCode(65 + i),
    detail: i === 0 ? t("routes.start", locale) : i === stops.length - 1 ? t("routes.end", locale) : t("routes.stop", locale).replace("{n}", String(i)),
    kind: "stop",
  }));

  const pct = (n: number) => num(Math.round(Math.abs(n)));
  const verdict =
    check.verdict === "ok"
      ? { tone: "ok" as const, text: t("routes.verdict.ok", locale).replace("{pct}", String(tolerance)) }
      : check.verdict === "over" && check.diffPct != null
        ? { tone: "warning" as const, text: t("routes.verdict.over", locale).replace("{pct}", pct(check.diffPct)) }
        : check.verdict === "under" && check.diffPct != null
          ? { tone: "warning" as const, text: t("routes.verdict.under", locale).replace("{pct}", pct(check.diffPct)) }
          : null;

  return (
    <Card>
      <CardHeader
        action={
          manager && open ? (
            <Link href={`/trips/${trip.id}/route`} className={buttonVariants({ variant: route ? "secondary" : "primary", size: "sm" })}>
              {route ? t("routes.change", locale) : t("routes.plan", locale)}
            </Link>
          ) : undefined
        }
      >
        <CardTitle as="h3">{t("routes.title", locale)}</CardTitle>
      </CardHeader>

      {lines.length > 0 ? (
        <FleetMap markers={markers} lines={lines} size="card" />
      ) : (
        <p className="text-sm text-sand-500">{manager && open ? t("routes.nonePlanHint", locale) : t("routes.none", locale)}</p>
      )}

      {lines.length > 0 ? (
        <p className="mt-2 text-xs text-sand-600">{t("routes.legend", locale)}</p>
      ) : null}

      <FactList>
        {route ? (
          <Fact label={t("routes.planned", locale)} value={`${num(route.distance_m / 1000)} km · ${durationText(route.duration_s, locale)}`} />
        ) : null}
        {check.basis === "odometer" && check.actualKm != null ? (
          <Fact label={t("routes.odometer", locale)} value={`${num(check.actualKm)} km`} />
        ) : null}
        {recordedKm != null ? <Fact label={t("routes.recorded", locale)} value={`${num(recordedKm)} km`} /> : null}
        {away && away.offKm >= 1 ? (
          <Fact label={t("routes.offRoute", locale)} value={t("routes.offRouteValue", locale).replace("{km}", num(away.offKm))} />
        ) : null}
      </FactList>
      {verdict ? (
        <div className="mt-2">
          <Badge tone={verdict.tone}>{verdict.text}</Badge>
          {check.basis === "recorded" ? <p className="mt-1 text-xs text-sand-600">{t("routes.recordedBasis", locale)}</p> : null}
        </div>
      ) : null}

      {google || waze ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {google ? (
            <a href={google} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "primary" })}>
              {t("routes.google", locale)}
            </a>
          ) : null}
          {waze ? (
            <a href={waze} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary" })}>
              {t("routes.waze", locale)}
            </a>
          ) : null}
        </div>
      ) : null}
      {google && stops.length > 2 ? <p className="mt-2 text-xs text-sand-600">{t("routes.googleHint", locale)}</p> : null}

      {isDriver && trip.status === "underway" ? (
        <div className="mt-4">
          {trip.driving_session_id ? (
            <RouteRecorder
              sessionId={trip.driving_session_id}
              labels={{
                start: t("map.recordStart", locale),
                stop: t("map.recordStop", locale),
                recording: t("map.recording", locale),
                keepOpen: t("map.keepOpen", locale),
                denied: t("map.recordDenied", locale),
              }}
            />
          ) : (
            <p className="text-sm text-sand-600">{t("routes.noSession", locale)}</p>
          )}
        </div>
      ) : null}

      {manager && open && route ? (
        <form action={clearTripRoute} className="mt-3">
          <input type="hidden" name="trip_id" value={trip.id} />
          <SubmitButton variant="ghost" size="sm">{t("routes.remove", locale)}</SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}
