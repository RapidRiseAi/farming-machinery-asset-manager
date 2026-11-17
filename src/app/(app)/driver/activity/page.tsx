import Link from "next/link";
import { Fragment } from "react";
import { redirect } from "next/navigation";
import { currentFarmId, requireFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { COMPANY } from "@/lib/legal";
import { stopVisits, type DrivingEvent } from "@/lib/driving";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DialogForm } from "@/components/ui/dialog-form";
import { Disclosure } from "@/components/ui/disclosure";
import { RouteRecorder } from "@/components/map/route-recorder";
import { mapsAvailable } from "@/lib/features";
import { saveManualActivity } from "./actions";
import { ManualDriveForm } from "@/components/manual-drive-form";
import { drivingDistance, type ManualDriveContext } from "@/lib/manual-driving";
import { isUuid } from "@/lib/ids";

type Person = { id: string; name: string };
type Session = {
  id: string;
  machine_id: string;
  driver_id: string;
  started_at: string;
  ended_at: string | null;
  destination: string | null;
  planned_stops: string[];
  start_km: number | null;
  end_km: number | null;
};
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    farm?: string;
    machine?: string;
    driver?: string;
    page?: string;
    error?: string;
    saved?: string;
  }>;
}) {
  const raw = await searchParams;
  // Filters only when they are ids: a stale or hand-edited `?driver=` or `?machine=` shows
  // the unfiltered list, as it did before reads failed loudly on Postgres's refusal.
  const sp = {
    ...raw,
    driver: isUuid(raw.driver) ? raw.driver : undefined,
    machine: isUuid(raw.machine) ? raw.machine : undefined,
  };
  const profile = await requireProfile();
  const farm = sp.farm || (await currentFarmId(profile));
  if (!farm) redirect("/home");
  const { role } = await requireFarmRole(
    farm,
    ["owner", "manager", "mechanic", "operator"],
    undefined,
    profile,
  );
  const manage = role === "owner" || role === "manager";
  const locale = profile.lang;
  const mapOn = await mapsAvailable(farm, profile);
  const db = await createClient();
  const page = Math.max(
    0,
    Math.min(10000, Number.parseInt(sp.page ?? "0", 10) || 0),
  );
  let history = db
    .from("driving_sessions")
    .select("id,machine_id,driver_id,started_at,ended_at,destination,planned_stops,start_km,end_km")
    .eq("farm_id", farm)
    .not("ended_at", "is", null)
    .order("started_at", { ascending: false })
    .range(page * 30, page * 30 + 29);
  if (sp.driver) history = history.eq("driver_id", sp.driver);
  if (sp.machine) history = history.eq("machine_id", sp.machine);
  let activeQuery = db
    .from("driving_sessions")
    .select("id,machine_id,driver_id,started_at,ended_at,destination,planned_stops,start_km,end_km")
    .eq("farm_id", farm)
    .is("ended_at", null)
    .order("started_at", { ascending: false });
  if (sp.driver) activeQuery = activeQuery.eq("driver_id", sp.driver);
  if (sp.machine) activeQuery = activeQuery.eq("machine_id", sp.machine);
  const [vehicles, people, active, closed, connections] = await Promise.all([
    db.rpc("driving_vehicles", { p_farm: farm }),
    db.rpc("driving_people", { p_farm: farm }),
    activeQuery,
    history,
    manage
      ? db
          .from("driver_connections")
          .select("id,name,kind,active")
          .eq("farm_id", farm)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if ([vehicles, people, active, closed, connections].some((r) => r.error))
    throw new Error("Driver activity unavailable");
  const machines = (vehicles.data ?? []) as Person[];
  const drivers = (people.data ?? []) as Person[];
  const sessions = [
    ...(active.data ?? []),
    ...(closed.data ?? []),
  ] as Session[];
  const eventResult = sessions.length
    ? await db.rpc("driving_session_details", {
        p_sessions: sessions.map((s) => s.id),
      })
    : { data: [], error: null };
  if (eventResult.error) throw new Error("Driver history unavailable");
  // A drive started by a trip links back to it (20261111090000). Only trips this person may
  // see come back, so a driver sees links to their own trips and nobody else's.
  const linked = sessions.length
    ? await db
        .from("trips")
        .select("id, number, driving_session_id")
        .in("driving_session_id", sessions.map((s) => s.id))
    : { data: [], error: null };
  if (linked.error) throw new Error("Driver trips unavailable");
  const tripOf = new Map(
    ((linked.data ?? []) as { id: string; number: number; driving_session_id: string }[]).map((r) => [r.driving_session_id, r]),
  );
  const details = (eventResult.data ?? []) as {
    session_id: string;
    stop_events: DrivingEvent[];
    recent_events: DrivingEvent[];
    last_location: DrivingEvent | null;
  }[];
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale.startsWith("af") ? "af-ZA" : "en-ZA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Johannesburg",
    }).format(new Date(value));
  const name = (list: Person[], id: string) =>
    list.find((p) => p.id === id)?.name ?? id;
  const form = (kind: ManualDriveContext["kind"], session?: Session) => (
    <DialogForm
      key={`${kind}-${session?.id ?? "new"}`}
      trigger={t(`driving.${kind}`, locale)}
      title={t(`driving.${kind}`, locale)}
      closeLabel={t("ui.close", locale)}
    >
      <ManualDriveForm key={`${profile.id}:${farm}:${session?.id??"new"}:${kind}`}
        context={{farm,kind,session:session?.id??null}} user={profile.id} locale={locale}
        manage={manage} vehicles={machines} drivers={drivers} mapOn={mapOn} save={saveManualActivity}
        initial={{machine:session?.machine_id??sp.machine??"",driver:session?.driver_id??sp.driver??profile.id,
          destination:session?.destination??"",stops:session?.planned_stops.join("\n")??""}}/>

    </DialogForm>
  );
  return (
    <PageContainer>
      <PageHeader
        title={t("driving.title", locale)}
        lead={t("driving.lead", locale)}
        actions={form("start")}
      />
      <p className="text-sm text-ink-muted">{t("driving.timezone", locale)}</p>
      {sp.driver && (
        <p className="font-semibold">
          {t("driving.driver", locale)}: {name(drivers, sp.driver)}
        </p>
      )}
      {sp.error && (
        <p role="alert" className="rounded-xl border border-status-overdue p-4">
          {t("driving.error", locale)}
        </p>
      )}
      {sp.saved && <p role="status">{t("driving.saved", locale)}</p>}
      <h2 className="text-xl font-semibold">{t("driving.active", locale)}</h2>
      {!active.data?.length && (
        <p className="text-ink-muted">{t("driving.noActive", locale)}</p>
      )}
      {sessions.map((s, index) => {
        const detail = details.find((d) => d.session_id === s.id);
        const timeline = detail?.recent_events ?? [];
        const stopEvents = detail?.stop_events ?? [];
        const last = stopEvents
          .filter((e) => e.kind === "arrive" || e.kind === "depart")
          .at(-1);
        const visits = stopVisits(stopEvents);
        const position = detail?.last_location;
        return (
          <Fragment key={s.id}>
            {s.ended_at && index === (active.data?.length ?? 0) && (
              <h2 className="mt-4 text-xl font-semibold">
                {t("driving.past", locale)}
              </h2>
            )}
            <section className="flex flex-col gap-3 rounded-xl border border-sand-200 bg-surface p-4">
              {mapOn && !s.ended_at && s.driver_id === profile.id ? (
                <RouteRecorder
                  sessionId={s.id}
                  labels={{
                    start: t("map.recordStart", locale),
                    stop: t("map.recordStop", locale),
                    recording: t("map.recording", locale),
                    keepOpen: t("map.keepOpen", locale),
                    denied: t("map.recordDenied", locale),
                  }}
                />
              ) : null}
              <h3 className="text-lg font-semibold">
                {name(drivers, s.driver_id)} · {name(machines, s.machine_id)}
              </h3>
              {tripOf.get(s.id) ? (
                <Link href={`/trips/${tripOf.get(s.id)?.id}`} className="text-sm font-medium underline">
                  {t("routes.openTrip", locale).replace("{n}", String(tripOf.get(s.id)?.number ?? ""))}
                </Link>
              ) : null}
              <p>
                {date(s.started_at)}{" "}
                {s.ended_at
                  ? ` → ${date(s.ended_at)}`
                  : ` · ${t(last?.kind === "arrive" ? "driving.atLocation" : "driving.onJourney", locale)}`}
              </p>
              <div className="flex flex-col gap-2 text-sm">
                <p>{t("manualDrive.destination",locale)}: {s.destination||t("manualDrive.notRecorded",locale)}</p>
                {s.planned_stops.length?<ol className="list-decimal pl-5" aria-label={t("manualDrive.stops",locale)}>{s.planned_stops.map((stop,i)=><li key={i}>{stop}</li>)}</ol>:null}
                <p>{t("manualDrive.startKm",locale)}: {s.start_km??t("manualDrive.notRecorded",locale)} · {t("manualDrive.endKm",locale)}: {s.end_km??t("manualDrive.notRecorded",locale)}</p>
                <p>{t("manualDrive.distance",locale)}: {drivingDistance(s.start_km,s.end_km)??t("manualDrive.notRecorded",locale)}</p>
              </div>
              {position && (
                <p>
                  {t("driving.location", locale)}:{" "}
                  {position.location ?? `${position.lat}, ${position.lng}`} ·{" "}
                  {date(position.occurred_at)}
                </p>
              )}
              {!s.ended_at && (
                <div className="flex flex-wrap gap-2">
                  {form(last?.kind === "arrive" ? "depart" : "arrive", s)}
                  {form("end", s)}
                </div>
              )}
              {visits.map((v, i) => (
                <p key={i} className="rounded-lg bg-sand-50 p-3">
                  {v.location} · {date(v.arrived)} →{" "}
                  {v.departed
                    ? date(v.departed)
                    : t("driving.stillHere", locale)}{" "}
                  · {v.minutes} {t("driving.minutes", locale)}
                </p>
              ))}
              <Disclosure summary={t("driving.history", locale)}>
                <ol className="flex flex-col gap-3">
                  {timeline.map((e) => (
                    <li key={e.id} className="border-l-2 border-sand-200 pl-3">
                      <p className="font-medium">
                        {t(`driving.${e.kind}`, locale)} · {date(e.occurred_at)}
                        {e.location ? ` · ${e.location}` : ""}
                      </p>
                      <p className="text-sm text-ink-muted">
                        {t(`driving.source.${e.source}`, locale)}
                        {e.recorded_by
                          ? ` · ${name(drivers, e.recorded_by)}`
                          : ""}{" "}
                        · {t("driving.recorded", locale)} {date(e.recorded_at)}
                      </p>
                      {e.notes && <p>{e.notes}</p>}
                      {e.odometer_km!=null?<p>{t("manualDrive.km",locale)}: {e.odometer_km}</p>:null}
                      {e.destination?<p>{t("manualDrive.destination",locale)}: {e.destination}</p>:null}
                      {e.planned_stops?.length?<ol className="list-decimal pl-5">{e.planned_stops.map((stop,i)=><li key={i}>{stop}</li>)}</ol>:null}
                      {e.lat != null && e.lng != null && (
                        <a
                          className="underline"
                          target="_blank"
                          rel="noreferrer"
                          href={`https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lng}#map=16/${e.lat}/${e.lng}`}
                        >
                          {t("driving.map", locale)}
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              </Disclosure>
            </section>
          </Fragment>
        );
      })}
      <nav className="flex gap-4">
        {page > 0 && (
          <Link
            className="underline"
            href={`?${new URLSearchParams({ farm, page: String(page - 1), ...(sp.driver ? { driver: sp.driver } : {}), ...(sp.machine ? { machine: sp.machine } : {}) })}`}
          >
            {t("driving.previous", locale)}
          </Link>
        )}
        {closed.data?.length === 30 && (
          <Link
            className="underline"
            href={`?${new URLSearchParams({ farm, page: String(page + 1), ...(sp.driver ? { driver: sp.driver } : {}), ...(sp.machine ? { machine: sp.machine } : {}) })}`}
          >
            {t("driving.older", locale)}
          </Link>
        )}
      </nav>
      {manage && (
        <section className="rounded-xl border border-sand-200 p-4">
          <h2 className="text-xl font-semibold">
            {t("driving.integrations", locale)}
          </h2>
          <p className="mt-2 text-ink-muted">
            {t("driving.integrationHint", locale)}
          </p>
          {connections.data?.map((c) => (
            <p className="mt-3" key={c.id}>
              {c.name} ·{" "}
              {t(c.active ? "driving.enabled" : "driving.awaiting", locale)}
            </p>
          ))}
          <a
            className="mt-3 inline-block underline"
            href={`mailto:${COMPANY.email}?subject=${encodeURIComponent("Fleetwise tracking integration quote")}`}
          >
            {t("driving.requestQuote", locale)}
          </a>
        </section>
      )}
    </PageContainer>
  );
}
