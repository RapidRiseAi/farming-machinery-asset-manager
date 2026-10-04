import Link from "next/link";
import { Fragment } from "react";
import { redirect } from "next/navigation";
import { currentFarmId, requireFarmRole, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { COMPANY } from "@/lib/legal";
import { stopVisits, type DrivingEvent } from "@/lib/driving";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import {
  DialogForm,
  DialogFields,
  DialogActions,
} from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Disclosure } from "@/components/ui/disclosure";
import { DrivingLocation } from "@/components/driving-location";
import { recordActivity } from "./actions";

type Person = { id: string; name: string };
type Session = {
  id: string;
  machine_id: string;
  driver_id: string;
  started_at: string;
  ended_at: string | null;
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
  const sp = await searchParams;
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
  const db = await createClient();
  const page = Math.max(
    0,
    Math.min(10000, Number.parseInt(sp.page ?? "0", 10) || 0),
  );
  let history = db
    .from("driving_sessions")
    .select("id,machine_id,driver_id,started_at,ended_at")
    .eq("farm_id", farm)
    .not("ended_at", "is", null)
    .order("started_at", { ascending: false })
    .range(page * 30, page * 30 + 29);
  if (sp.driver) history = history.eq("driver_id", sp.driver);
  if (sp.machine) history = history.eq("machine_id", sp.machine);
  let activeQuery = db
    .from("driving_sessions")
    .select("id,machine_id,driver_id,started_at,ended_at")
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
  const form = (kind: string, session?: Session) => (
    <DialogForm
      key={`${kind}-${session?.id ?? "new"}`}
      trigger={t(`driving.${kind}`, locale)}
      title={t(`driving.${kind}`, locale)}
      closeLabel={t("ui.close", locale)}
    >
      <form action={recordActivity}>
        <DialogFields>
          <input type="hidden" name="farm" value={farm} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="session" value={session?.id ?? ""} />
          {session ? (
            <>
              <input type="hidden" name="machine" value={session.machine_id} />
              <input type="hidden" name="driver" value={session.driver_id} />
              <p>
                {name(drivers, session.driver_id)} ·{" "}
                {name(machines, session.machine_id)}
              </p>
            </>
          ) : (
            <>
              <Field
                label={t("driving.vehicle", locale)}
                htmlFor="driving-machine"
              >
                <Select
                  id="driving-machine"
                  name="machine"
                  defaultValue={sp.machine ?? ""}
                  required
                >
                  <option value="">{t("driving.choose", locale)}</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {manage ? (
                <Field
                  label={t("driving.driver", locale)}
                  htmlFor="driving-driver"
                >
                  <Select
                    id="driving-driver"
                    name="driver"
                    defaultValue={sp.driver ?? profile.id}
                    required
                  >
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <input type="hidden" name="driver" value={profile.id} />
              )}
            </>
          )}
          <Field
            label={t("driving.location", locale)}
            htmlFor={`${kind}-${session?.id ?? "new"}-location`}
          >
            <Input
              id={`${kind}-${session?.id ?? "new"}-location`}
              name="location"
              maxLength={200}
              required={kind === "arrive"}
            />
          </Field>
          {manage && (
            <Field
              label={t("driving.time", locale)}
              htmlFor={`${kind}-${session?.id ?? "new"}-time`}
              hint={t("driving.timeHint", locale)}
            >
              <Input
                id={`${kind}-${session?.id ?? "new"}-time`}
                name="at"
                type="datetime-local"
              />
            </Field>
          )}
          <Field
            label={t("driving.notes", locale)}
            htmlFor={`${kind}-${session?.id ?? "new"}-notes`}
          >
            <Input
              id={`${kind}-${session?.id ?? "new"}-notes`}
              name="notes"
              maxLength={2000}
            />
          </Field>
          {(!manage || session?.driver_id === profile.id) && (
            <DrivingLocation locale={locale} />
          )}
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton>{t("common.save", locale)}</SubmitButton>
        </DialogActions>
      </form>
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
              <h3 className="text-lg font-semibold">
                {name(drivers, s.driver_id)} · {name(machines, s.machine_id)}
              </h3>
              <p>
                {date(s.started_at)}{" "}
                {s.ended_at
                  ? ` → ${date(s.ended_at)}`
                  : ` · ${t(last?.kind === "arrive" ? "driving.atLocation" : "driving.onJourney", locale)}`}
              </p>
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
