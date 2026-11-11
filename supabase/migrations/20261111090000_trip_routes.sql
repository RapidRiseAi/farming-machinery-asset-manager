-- 20261111090000_trip_routes.sql
-- Planned routes on trips, trips that keep the driving record, and positions from trackers
-- (founder decisions, 11 November 2026).
--
-- == The planned route =========================================================
-- A manager drops pins or searches for places, adds stops, and picks one of the routes the
-- route service offers, as in a navigation app. Kept: the stops, the line picked, and its
-- length and time. The line is what the driven route is held against afterwards, and the
-- length is what the odometer is held against. Which service drew it is kept too, so the
-- record shows when the business moved from Mapbox to its own route server.
--
-- Only an owner or manager plans. A driver reads the route of their own trip and nobody else's.
--
-- == A trip keeps the driving record ===========================================
-- A trip and a driving session were two records of the same drive: a driver had to start both,
-- and the route recorder lived on the session. Starting a trip now starts the driver's session
-- on that vehicle (or joins the one already open), and finishing it ends that session. If the
-- driver is already driving something else, the trip still starts, unlinked: a trip must never
-- be refused because of the driving log.
--
-- == Positions from trackers ===================================================
-- A phone stops reporting when its screen locks, so a vehicle tracker can send positions
-- through the tracker connection a business already has. They land with the phone's points,
-- marked as the tracker's, and only while the map is on for that business: positions nobody
-- may look at are not kept (docs/POPIA.md).
--
-- == Counting route requests ===================================================
-- Mapbox's free allowance is per month for the whole of FLEETWISE. Every route and search is
-- counted per business per month, so Rapid Rise sees when to move to its own route server, and
-- the server can stop asking Mapbox before the allowance runs out.

alter table public.trips add column if not exists driving_session_id uuid;

do $c$ begin
  alter table public.trips
    add constraint trips_driving_session_fk foreign key (driving_session_id, farm_id)
    references public.driving_sessions(id, farm_id);
exception when duplicate_object then null;
end $c$;

create index if not exists trips_driving_session_idx on public.trips (driving_session_id) where driving_session_id is not null;

create table if not exists public.trip_routes (
  trip_id     uuid primary key,
  farm_id     uuid not null,
  waypoints   jsonb not null,
  geometry    jsonb not null,
  distance_m  integer not null check (distance_m >= 0),
  duration_s  integer not null check (duration_s >= 0),
  provider    text not null check (provider in ('mapbox', 'osrm')),
  planned_by  uuid references public.users(id) on delete set null,
  planned_at  timestamptz not null default now(),
  foreign key (trip_id, farm_id) references public.trips(id, farm_id) on delete cascade,
  constraint trip_routes_waypoints_ck check (
    jsonb_typeof(waypoints) = 'array' and jsonb_array_length(waypoints) between 2 and 25),
  constraint trip_routes_geometry_ck check (
    jsonb_typeof(geometry) = 'array' and jsonb_array_length(geometry) between 2 and 5000)
);

create index if not exists trip_routes_farm_idx on public.trip_routes (farm_id);

alter table public.trip_routes enable row level security;
alter table public.trip_routes force row level security;

create policy trip_routes_sel on public.trip_routes for select to authenticated using (
  app.trips_office(farm_id)
  or exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = auth.uid())
);
create policy trip_routes_ins on public.trip_routes for insert to authenticated with check (app.trips_manager(farm_id));
create policy trip_routes_upd on public.trip_routes for update to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));
create policy trip_routes_del on public.trip_routes for delete to authenticated using (app.trips_manager(farm_id));

-- SECURITY.md 2b.
revoke all on public.trip_routes from public, anon, authenticated;
grant select, insert, update, delete on public.trip_routes to authenticated;
grant all on public.trip_routes to service_role;

create trigger trip_routes_audit after insert or update or delete on public.trip_routes
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('trip_routes', 'farm', 'the route a trip was planned to take, and who planned it')
on conflict (table_name) do nothing;

create table if not exists public.routing_usage (
  farm_id  uuid not null references public.farms(id) on delete cascade,
  month    date not null,
  routes   integer not null default 0 check (routes >= 0),
  searches integer not null default 0 check (searches >= 0),
  primary key (farm_id, month)
);

alter table public.routing_usage enable row level security;
alter table public.routing_usage force row level security;

create policy routing_usage_sel on public.routing_usage for select to authenticated using (app.is_rr_admin());

revoke all on public.routing_usage from public, anon, authenticated;
grant select on public.routing_usage to authenticated;
grant all on public.routing_usage to service_role;

-- Counts one business's use, and answers with all of FLEETWISE's routes this month, which is
-- what the free allowance is measured against. Months run on South African time.
create or replace function public.count_routing_use(p_farm uuid, p_routes integer, p_searches integer)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Africa/Johannesburg')::date;
  v_total bigint;
begin
  if p_routes < 0 or p_searches < 0 then raise exception 'counts go up' using errcode = '22023'; end if;
  insert into public.routing_usage (farm_id, month, routes, searches)
  values (p_farm, v_month, p_routes, p_searches)
  on conflict (farm_id, month) do update
    set routes = public.routing_usage.routes + excluded.routes,
        searches = public.routing_usage.searches + excluded.searches;
  select coalesce(sum(routes), 0) into v_total from public.routing_usage where month = v_month;
  return v_total;
end $$;

revoke all on function public.count_routing_use(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.count_routing_use(uuid, integer, integer) to service_role;

-- Positions a tracker sent, already checked by the server for shape and time. The vehicle is
-- found from the tracker's own id for it; a driver is not needed, because a tracker knows the
-- vehicle and seldom who is in it.
create or replace function public.ingest_tracker_positions(p_connection uuid, p_machine_external text, p_points jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm    uuid;
  v_machine uuid;
  v_session uuid;
  v_n       integer;
begin
  select farm_id into v_farm from public.driver_connections where id = p_connection and active;
  if v_farm is null then raise exception 'invalid_connection' using errcode = '22023'; end if;
  if not exists (select 1 from public.farms where id = v_farm and deleted_at is null and status in ('active', 'trial')) then
    raise exception 'farm_unavailable' using errcode = '42501';
  end if;
  select l.machine_id into v_machine
    from public.driver_device_links l
   where l.connection_id = p_connection and l.external_id = p_machine_external and l.machine_id is not null;
  if v_machine is null then raise exception 'unmapped_device_or_driver' using errcode = '22023'; end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) > 500 then
    raise exception 'invalid_event' using errcode = '22023';
  end if;

  if not (exists (select 1 from public.feature_flags where key = 'map' and released)
          or exists (select 1 from public.farm_feature_access where key = 'map' and farm_id = v_farm)) then
    return 0;
  end if;

  select id into v_session from public.driving_sessions where machine_id = v_machine and ended_at is null;

  insert into public.asset_positions (farm_id, machine_id, session_id, recorded_at, lat, lng, speed_kmh, source)
  select v_farm, v_machine, v_session, (p ->> 'at')::timestamptz, (p ->> 'lat')::double precision,
         (p ->> 'lng')::double precision, nullif(p ->> 'speed', '')::real, 'tracker'
    from jsonb_array_elements(p_points) p
   where (p ->> 'lat')::double precision between -90 and 90
     and (p ->> 'lng')::double precision between -180 and 180
     and (p ->> 'at')::timestamptz between now() - interval '7 days' and now() + interval '5 minutes';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.ingest_tracker_positions(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tracker_positions(uuid, text, jsonb) to service_role;

-- Starting a trip starts the driving record; see the header.
create or replace function public.trip_start(p_trip uuid, p_reading numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v public.trips%rowtype;
  v_session uuid;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  if v.status <> 'planned' then raise exception 'this trip has already started' using errcode = '22023'; end if;
  update public.trips set status = 'underway', started_at = now(), opening_reading = p_reading where id = p_trip;

  if v.driver_id is not null then
    select id into v_session from public.driving_sessions
     where machine_id = v.machine_id and driver_id = v.driver_id and ended_at is null;
    if v_session is null then
      begin
        perform app.write_driving_event(v.farm_id, v.machine_id, v.driver_id, 'start', now(),
                                        left(v.origin, 200), null, null, null, auth.uid(), null, null);
        select id into v_session from public.driving_sessions
         where machine_id = v.machine_id and driver_id = v.driver_id and ended_at is null;
      exception when sqlstate '22023' or sqlstate '42501' then
        -- Driving something else, or the vehicle is with somebody else: the trip goes ahead.
        v_session := null;
      end;
    end if;
    update public.trips set driving_session_id = v_session where id = p_trip;
  end if;
end $$;

create or replace function public.trip_finish(p_trip uuid, p_reading numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.trips%rowtype;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  if v.status <> 'underway' then raise exception 'this trip is not underway' using errcode = '22023'; end if;
  if p_reading is not null and v.opening_reading is not null and p_reading < v.opening_reading then
    raise exception 'the closing reading is below the opening reading' using errcode = '22023';
  end if;
  update public.trips set status = 'completed', ended_at = now(), closing_reading = p_reading where id = p_trip;

  if v.driving_session_id is not null
     and exists (select 1 from public.driving_sessions where id = v.driving_session_id and ended_at is null) then
    begin
      perform app.write_driving_event(v.farm_id, v.machine_id, v.driver_id, 'end', now(),
                                      left(v.destination, 200), null, null, null, auth.uid(), null, null);
    exception when sqlstate '22023' or sqlstate '42501' then
      null;
    end;
  end if;
end $$;

revoke all on function public.trip_start(uuid, numeric) from public, anon;
revoke all on function public.trip_finish(uuid, numeric) from public, anon;
grant execute on function public.trip_start(uuid, numeric) to authenticated, service_role;
grant execute on function public.trip_finish(uuid, numeric) to authenticated, service_role;

comment on table public.trip_routes is
  'The route a trip was planned to take: stops, the line chosen, its length and time (20261111090000).';
comment on table public.routing_usage is
  'Route and place searches per business per month, against the route service''s allowance (20261111090000).';
