import Link from "next/link";
import { notFound } from "next/navigation";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { dateTime, num, relativeDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/ids";
import { lastSeen, routeKm, routeLine, type TrackedPoint } from "@/lib/map-data";
import { createClient } from "@/lib/supabase/server";
import { mustAll } from "@/lib/supabase/must";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FleetMap, type MapMarker } from "@/components/map/fleet-map";
import { PageContainer, PageHeader } from "@/components/ui/page-header";

/**
 * Where the fleet is, as far as anything has recorded. In testing: see /admin/features.
 *
 * Reads go through the person's own client, so RLS decides what appears: an owner or manager
 * sees the fleet, a driver only their own trips.
 */
export const dynamic = "force-dynamic";

type Position = { machine_id: string; lat: number; lng: number; recorded_at: string; session_id: string | null };
type Fault = { id: string; title: string; lat: number; lng: number; created_at: string; machine_id: string };
type Machine = { id: string; name: string };
type Session = { id: string; machine_id: string; started_at: string; ended_at: string | null };
type Stop = { id: string; session_id: string; lat: number | null; lng: number | null; location: string | null; occurred_at: string; kind: string };

export default async function MapPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!(await featureOn("map", farmId))) notFound();
  const sp = await searchParams;
  const locale = profile.lang;
  const chosen = isUuid(sp.session) ? sp.session : null;

  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const results = await Promise.all([
    supabase
      .from("asset_positions")
      .select("machine_id, lat, lng, recorded_at, session_id")
      .eq("farm_id", farmId ?? "")
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: false })
      .limit(2000),
    supabase
      .from("faults")
      .select("id, title, lat, lng, created_at, machine_id")
      .eq("farm_id", farmId ?? "")
      .not("lat", "is", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("machines").select("id, name").eq("farm_id", farmId ?? "").is("deleted_at", null).limit(2000),
    supabase
      .from("driving_sessions")
      .select("id, machine_id, started_at, ended_at")
      .eq("farm_id", farmId ?? "")
      .order("started_at", { ascending: false })
      .limit(30),
    supabase
      .from("driving_events")
      .select("id, session_id, lat, lng, location, occurred_at, kind")
      .eq("farm_id", farmId ?? "")
      .not("lat", "is", null)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(500),
  ]);
  mustAll(results, "map:page");
  const [{ data: positionData }, { data: faultData }, { data: machineData }, { data: sessionData }, { data: stopData }] = results;

  const positions = (positionData ?? []) as Position[];
  const faults = (faultData ?? []) as Fault[];
  const sessions = (sessionData ?? []) as Session[];
  const stops = (stopData ?? []) as Stop[];
  const nameOf = new Map(((machineData ?? []) as Machine[]).map((m) => [m.id, m.name]));
  const machineOfSession = new Map(sessions.map((s) => [s.id, s.machine_id]));

  // A stop a driver saved counts as a sighting too, so this is useful before any trail exists.
  const sightings: TrackedPoint[] = [
    ...positions.map((p) => ({ machineId: p.machine_id, lat: p.lat, lng: p.lng, at: p.recorded_at })),
    ...stops.flatMap((s) => {
      const machineId = machineOfSession.get(s.session_id);
      return machineId && s.lat != null && s.lng != null ? [{ machineId, lat: s.lat, lng: s.lng, at: s.occurred_at }] : [];
    }),
  ];

  const seen = lastSeen(sightings);
  const markers: MapMarker[] = chosen
    ? stops
        .filter((s) => s.session_id === chosen && s.lat != null && s.lng != null)
        .map((s) => ({
          id: s.id,
          lat: s.lat as number,
          lng: s.lng as number,
          title: s.location ?? t("map.stop", locale),
          detail: dateTime(s.occurred_at, locale),
          kind: "stop" as const,
        }))
    : [
        ...seen.map((p) => ({
          id: p.machineId,
          lat: p.lat,
          lng: p.lng,
          title: nameOf.get(p.machineId) ?? "",
          detail: dateTime(p.at, locale),
          kind: "vehicle" as const,
        })),
        ...faults.map((f) => ({
          id: f.id,
          lat: f.lat,
          lng: f.lng,
          title: f.title,
          detail: `${nameOf.get(f.machine_id) ?? ""} · ${dateTime(f.created_at, locale)}`,
          kind: "fault" as const,
        })),
      ];

  const route = chosen
    ? routeLine(positions.filter((p) => p.session_id === chosen).map((p) => ({ lat: p.lat, lng: p.lng, at: p.recorded_at })))
    : [];

  return (
    <PageContainer size="wide">
      <PageHeader title={t("map.title", locale)} lead={t("map.lead", locale)} actions={<Badge tone="warning">{t("map.testing", locale)}</Badge>} />

      {markers.length === 0 && route.length === 0 ? (
        <EmptyState title={t("map.emptyTitle", locale)} hint={t("map.emptyHint", locale)} />
      ) : null}

      <FleetMap markers={markers} route={route} />

      {chosen ? (
        <p className="text-sm text-sand-600">
          {route.length > 1 ? t("map.routeKm", locale).replace("{km}", () => num(routeKm(route))) : t("map.noRoute", locale)}{" "}
          <Link href="/map" className="underline">{t("map.backToFleet", locale)}</Link>
        </p>
      ) : null}

      <Card>
        <CardHeader><CardTitle as="h3">{t("map.recentTrips", locale)}</CardTitle></CardHeader>
        {sessions.length === 0 ? (
          <p className="text-sm text-sand-500">{t("map.noTrips", locale)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-sand-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-sand-900">{nameOf.get(s.machine_id) ?? ""}</span>
                  <span className="block text-sm text-sand-500">{relativeDate(s.started_at, locale)}</span>
                </span>
                <Link href={`/map?session=${s.id}`} className="shrink-0 text-sm font-medium underline">{t("map.seeRoute", locale)}</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
