\set ON_ERROR_STOP on
-- Planned routes, trips that keep the driving record, tracker positions and route counting
-- (20261111090000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e7000000-0000-4000-9000-000000000001', 'Route farm', 'complete', 'active', 'monthly'),
  ('e7000000-0000-4000-9000-000000000002', 'Rival', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e7100000-0000-4000-9000-000000000001', 'owner@route.test'),
  ('e7100000-0000-4000-9000-000000000002', 'driver@route.test'),
  ('e7100000-0000-4000-9000-000000000003', 'driver2@route.test'),
  ('e7100000-0000-4000-9000-000000000004', 'rival@route.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('e7100000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'owner@route.test', true),
  ('e7100000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001', 'operator', 'Driver', 'driver@route.test', true),
  ('e7100000-0000-4000-9000-000000000003', 'e7000000-0000-4000-9000-000000000001', 'operator', 'Driver 2', 'driver2@route.test', true),
  ('e7100000-0000-4000-9000-000000000004', 'e7000000-0000-4000-9000-000000000002', 'owner', 'Rival', 'rival@route.test', true);
insert into public.machines (id, farm_id, name, type) values
  ('e7200000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'Truck 1', 'truck'),
  ('e7200000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001', 'Truck 2', 'truck');

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- == The owner plans; the trip's driver reads it; nobody else does ===========
select pg_temp.as_user('e7100000-0000-4000-9000-000000000001');
set local role authenticated;
insert into public.trips (id, farm_id, number, machine_id, driver_id, origin, destination) values
  ('e7300000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 0,
   'e7200000-0000-4000-9000-000000000001', 'e7100000-0000-4000-9000-000000000002', 'Durban', 'Johannesburg'),
  ('e7300000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001', 0,
   'e7200000-0000-4000-9000-000000000002', 'e7100000-0000-4000-9000-000000000003', 'Nelspruit', 'Pretoria');
insert into public.trip_routes (trip_id, farm_id, waypoints, geometry, distance_m, duration_s, provider, planned_by) values
  ('e7300000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001',
   '[{"lat":-29.85,"lng":31.02,"label":"Durban"},{"lat":-26.2,"lng":28.05,"label":"Johannesburg"}]',
   '[[31.02,-29.85],[29.5,-28.0],[28.05,-26.2]]', 568000, 20400, 'mapbox', 'e7100000-0000-4000-9000-000000000001');
do $t$ begin
  begin
    insert into public.trip_routes (trip_id, farm_id, waypoints, geometry, distance_m, duration_s, provider) values
      ('e7300000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001',
       '[{"lat":-25.47,"lng":30.97}]', '[[30.97,-25.47],[28.19,-25.75]]', 1, 1, 'mapbox');
    raise exception 'a route with one stop was kept';
  exception when check_violation then null;
  end;
  begin
    insert into public.trip_routes (trip_id, farm_id, waypoints, geometry, distance_m, duration_s, provider) values
      ('e7300000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001',
       '[{"lat":-25.47,"lng":30.97},{"lat":-25.75,"lng":28.19}]', '[[30.97,-25.47],[28.19,-25.75]]', 1, 1, 'google');
    raise exception 'a route from an unknown service was kept';
  exception when check_violation then null;
  end;
end $t$;
reset role;

select pg_temp.as_user('e7100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trip_routes) <> 1 then raise exception 'the driver cannot read their route'; end if;
  update public.trip_routes set distance_m = 1;
  if found then raise exception 'a driver changed the planned route'; end if;
  begin
    insert into public.trip_routes (trip_id, farm_id, waypoints, geometry, distance_m, duration_s, provider) values
      ('e7300000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001',
       '[{"lat":-25.47,"lng":30.97},{"lat":-25.75,"lng":28.19}]', '[[30.97,-25.47],[28.19,-25.75]]', 1, 1, 'mapbox');
    raise exception 'a driver planned a route';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

select pg_temp.as_user('e7100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trip_routes) <> 0 then raise exception 'a driver can read a colleague''s route'; end if;
end $t$;
reset role;

select pg_temp.as_user('e7100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trip_routes) <> 0 then raise exception 'another business can read the route'; end if;
end $t$;
reset role;

-- == A trip starts and ends the driver's driving session =====================
select pg_temp.as_user('e7100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$
declare v_session uuid;
begin
  perform public.trip_start('e7300000-0000-4000-9000-000000000001', 1000);
  select driving_session_id into v_session from public.trips where id = 'e7300000-0000-4000-9000-000000000001';
  if v_session is null then raise exception 'starting the trip did not start the driving record'; end if;
  perform public.trip_finish('e7300000-0000-4000-9000-000000000001', 1570);
end $t$;
reset role;

do $t$ begin
  if exists (select 1 from public.driving_sessions s join public.trips t on t.driving_session_id = s.id
              where t.id = 'e7300000-0000-4000-9000-000000000001' and s.ended_at is null) then
    raise exception 'finishing the trip left the driving session open';
  end if;
  if (select count(*) from public.driving_events e join public.trips t on t.driving_session_id = e.session_id
       where t.id = 'e7300000-0000-4000-9000-000000000001' and e.kind in ('start', 'end')) <> 2 then
    raise exception 'the driving record is missing its start or end';
  end if;
end $t$;

-- A driver already driving something else still gets to start the trip, unlinked.
insert into public.driving_sessions (farm_id, machine_id, driver_id, started_at) values
  ('e7000000-0000-4000-9000-000000000001', 'e7200000-0000-4000-9000-000000000001',
   'e7100000-0000-4000-9000-000000000003', now() - interval '1 hour');
select pg_temp.as_user('e7100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  perform public.trip_start('e7300000-0000-4000-9000-000000000002', 5);
  if (select status from public.trips where id = 'e7300000-0000-4000-9000-000000000002') <> 'underway' then
    raise exception 'the driving log stopped a trip from starting';
  end if;
  if (select driving_session_id from public.trips where id = 'e7300000-0000-4000-9000-000000000002') is not null then
    raise exception 'the trip was linked to a session on another vehicle';
  end if;
end $t$;
reset role;

-- == Tracker positions =======================================================
insert into public.driver_connections (id, farm_id, name, kind, active, quote_reference) values
  ('e7400000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'Tracker co', 'tracker', true, 'Q-1');
insert into public.driver_device_links (farm_id, connection_id, external_id, machine_id) values
  ('e7000000-0000-4000-9000-000000000001', 'e7400000-0000-4000-9000-000000000001', 'UNIT-7', 'e7200000-0000-4000-9000-000000000002');

do $t$
declare v_points jsonb := jsonb_build_array(
  jsonb_build_object('at', now() - interval '2 minutes', 'lat', -25.5, 'lng', 30.9, 'speed', 80),
  jsonb_build_object('at', now() - interval '1 minute', 'lat', -25.6, 'lng', 30.7),
  jsonb_build_object('at', now() - interval '30 days', 'lat', -25.7, 'lng', 30.5));
begin
  -- The map is off for this business: nothing kept.
  if public.ingest_tracker_positions('e7400000-0000-4000-9000-000000000001', 'UNIT-7', v_points) <> 0 then
    raise exception 'positions were kept while the map was off';
  end if;
  insert into public.farm_feature_access (farm_id, key) values ('e7000000-0000-4000-9000-000000000001', 'map');
  -- Two recent points kept, the month-old one refused.
  if public.ingest_tracker_positions('e7400000-0000-4000-9000-000000000001', 'UNIT-7', v_points) <> 2 then
    raise exception 'tracker positions were not kept, or an old one was';
  end if;
  if (select count(*) from public.asset_positions where source = 'tracker'
       and machine_id = 'e7200000-0000-4000-9000-000000000002') <> 2 then
    raise exception 'tracker positions landed on the wrong vehicle';
  end if;
  begin
    perform public.ingest_tracker_positions('e7400000-0000-4000-9000-000000000001', 'UNKNOWN', v_points);
    raise exception 'a position for an unknown unit was kept';
  exception when invalid_parameter_value then null;
  end;
end $t$;

-- == Counting, and who may count =============================================
do $t$ begin
  if public.count_routing_use('e7000000-0000-4000-9000-000000000001', 3, 1) <> 3 then raise exception 'the first count is wrong'; end if;
  if public.count_routing_use('e7000000-0000-4000-9000-000000000002', 2, 0) <> 5 then raise exception 'the month total is wrong'; end if;
  if (select searches from public.routing_usage where farm_id = 'e7000000-0000-4000-9000-000000000001') <> 1 then
    raise exception 'searches were not counted';
  end if;
  if has_function_privilege('authenticated', 'public.count_routing_use(uuid,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ingest_tracker_positions(uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'a signed-in person can count use or write tracker positions';
  end if;
end $t$;

select pg_temp.as_user('e7100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.routing_usage) <> 0 then raise exception 'a customer can read route use'; end if;
end $t$;
reset role;

rollback;
