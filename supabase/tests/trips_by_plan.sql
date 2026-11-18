-- Trips and maps by plan, before and after a downgrade (task B3, 20261119090000).
-- Scenario 13: Professional trip work needs no map; Complete maps need the readiness flag.
-- Scenario 17: after a downgrade saved trips, routes and positions stay readable, while new
-- trip work, new routes and new positions are refused, whatever path writes them.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);

insert into public.farms(id,name,status,plan) values
 ('cb000000-0000-4000-9000-000000000001','Trip business','active','professional'),
 ('cb000000-0000-4000-9000-000000000002','Map business','active','complete');
insert into auth.users(id,email) select ('cb100000-0000-4000-9000-00000000000'||n)::uuid,'trip'||n||'@example.test' from generate_series(1,4) n;
insert into public.users(id,farm_id,role,name,email) values
 ('cb100000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001','owner','Owner','trip1@example.test'),
 ('cb100000-0000-4000-9000-000000000002','cb000000-0000-4000-9000-000000000001','operator','Driver','trip2@example.test'),
 ('cb100000-0000-4000-9000-000000000003','cb000000-0000-4000-9000-000000000002','owner','Map owner','trip3@example.test'),
 ('cb100000-0000-4000-9000-000000000004','cb000000-0000-4000-9000-000000000002','operator','Map driver','trip4@example.test');
insert into public.machines(id,farm_id,name,type,meter_type) values
 ('cb200000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001','Truck','truck','km'),
 ('cb200000-0000-4000-9000-000000000002','cb000000-0000-4000-9000-000000000001','Bakkie','bakkie','km'),
 ('cb200000-0000-4000-9000-000000000003','cb000000-0000-4000-9000-000000000002','Map truck','truck','km');
-- The map is in testing and released to nobody.
update public.feature_flags set released = false where key = 'map';
delete from public.farm_feature_access where key = 'map';

create function pg_temp.login(n integer) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub','cb100000-0000-4000-9000-00000000000'||n,'role','authenticated','aal','aal2')::text, true)
$$;
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'TRIPS: %', why; end if; end
$$;
-- The refusal text, or null when the statement went through.
create function public._trips_refusal(q text) returns text language plpgsql as $$
begin execute q; return null;
exception when others then return sqlerrm;
end
$$;
grant execute on function public._trips_refusal(text) to authenticated;

-- == [13] Professional: trips, loads, money and deliveries with no map at all ===============
select pg_temp.login(1); set local role authenticated;
insert into public.trips(id,farm_id,number,machine_id,driver_id,origin,destination) values
 ('cb300000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001',0,'cb200000-0000-4000-9000-000000000001','cb100000-0000-4000-9000-000000000002','Farm','Mill'),
 ('cb300000-0000-4000-9000-000000000002','cb000000-0000-4000-9000-000000000001',0,'cb200000-0000-4000-9000-000000000002',null,'Farm','Co-op'),
 ('cb300000-0000-4000-9000-000000000003','cb000000-0000-4000-9000-000000000001',0,'cb200000-0000-4000-9000-000000000002',null,'Farm','Town');
insert into public.trip_jobs(id,farm_id,trip_id,customer,dropoff) values
 ('cb400000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001','cb300000-0000-4000-9000-000000000001','Mill buyer','Mill'),
 ('cb400000-0000-4000-9000-000000000002','cb000000-0000-4000-9000-000000000001','cb300000-0000-4000-9000-000000000001','Second drop','Silo'),
 ('cb400000-0000-4000-9000-000000000003','cb000000-0000-4000-9000-000000000001','cb300000-0000-4000-9000-000000000002','Co-op','Co-op');
insert into public.trip_income(trip_id,farm_id,amount_cents) values ('cb300000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001',250000);
insert into public.trip_expenses(trip_id,farm_id,kind,amount_cents) values ('cb300000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001','toll',4500);
select public.trip_start('cb300000-0000-4000-9000-000000000001', 1000);
select pg_temp.assert((select status = 'underway' from public.trips where id = 'cb300000-0000-4000-9000-000000000001'), '[13] Professional starts a trip with no map');
-- A delivery with a location, on a plan without maps: the delivery records, the location does not.
select public.trip_job_deliver('cb400000-0000-4000-9000-000000000001','delivered','Jan','',null,null,-25.5,28.1);
select pg_temp.assert((select status = 'delivered' and pod_lat is null and pod_lng is null from public.trip_jobs where id = 'cb400000-0000-4000-9000-000000000001'),
  '[13] delivery evidence records on Professional, its reported location is not kept without maps');
-- No route on Professional, whatever the flag says.
select pg_temp.assert(public._trips_refusal($q$insert into public.trip_routes(trip_id,farm_id,waypoints,geometry,distance_m,duration_s,provider)
  values ('cb300000-0000-4000-9000-000000000002','cb000000-0000-4000-9000-000000000001','[{"lat":-25,"lng":28},{"lat":-25.1,"lng":28.1}]','[[28,-25],[28.1,-25.1]]',1000,60,'mapbox')$q$) like 'plan-feature-maps%',
  '[13] a planned route needs Complete');

-- A driver from another business cannot be named on a trip (they would read its loads).
select pg_temp.assert(public._trips_refusal($q$insert into public.trips(farm_id,number,machine_id,driver_id) values ('cb000000-0000-4000-9000-000000000001',0,'cb200000-0000-4000-9000-000000000002','cb100000-0000-4000-9000-000000000004')$q$) like 'trip-driver-not-member%',
  'a trip cannot name a driver from another business');
select pg_temp.assert(public._trips_refusal($q$update public.trips set driver_id = 'cb100000-0000-4000-9000-000000000003' where id = 'cb300000-0000-4000-9000-000000000002'$q$) like 'trip-driver-not-member%',
  'a trip cannot be moved to a driver from another business');

-- == [17] Downgrade to Essential ==========================================================
reset role; select set_config('request.jwt.claims','',true);
update public.farms set plan = 'essential' where id = 'cb000000-0000-4000-9000-000000000001';
select pg_temp.login(1); set local role authenticated;
select pg_temp.assert((select count(*) = 3 from public.trips), '[17] saved trips stay readable after the downgrade');
select pg_temp.assert((select count(*) = 3 from public.trip_jobs), '[17] saved loads stay readable');
select pg_temp.assert((select amount_cents = 250000 from public.trip_income), '[17] saved trip income stays readable');
select pg_temp.assert((select count(*) = 1 from public.trip_expenses), '[17] saved trip expenses stay readable');
-- No new trip work.
select pg_temp.assert(public._trips_refusal($q$insert into public.trips(farm_id,number,machine_id) values ('cb000000-0000-4000-9000-000000000001',0,'cb200000-0000-4000-9000-000000000002')$q$) like 'plan-feature-trips%',
  '[17] no new trip below Professional');
select pg_temp.assert(public._trips_refusal($q$select public.trip_start('cb300000-0000-4000-9000-000000000002', 5)$q$) like 'plan-feature-trips%',
  '[17] a saved planned trip cannot be started below Professional');
select pg_temp.assert(public._trips_refusal($q$update public.trips set destination = 'Elsewhere' where id = 'cb300000-0000-4000-9000-000000000002'$q$) like 'plan-feature-trips%',
  '[17] a saved trip cannot be edited below Professional');
select pg_temp.assert(public._trips_refusal($q$update public.trip_income set amount_cents = 1 where trip_id = 'cb300000-0000-4000-9000-000000000001'$q$) like 'plan-feature-trips%',
  '[17] saved income cannot be changed below Professional');
select pg_temp.assert(public._trips_refusal($q$insert into public.trip_income(trip_id,farm_id,amount_cents) values ('cb300000-0000-4000-9000-000000000001','cb000000-0000-4000-9000-000000000001',9) on conflict (trip_id) do update set amount_cents = excluded.amount_cents$q$) like 'plan-feature-trips%',
  '[17] the income upsert the screen uses is refused below Professional');
select pg_temp.assert(public._trips_refusal($q$update public.trip_expenses set amount_cents = 1$q$) like 'plan-feature-trips%',
  '[17] saved expenses cannot be changed below Professional');
select pg_temp.assert(public._trips_refusal($q$select public.trip_job_deliver('cb400000-0000-4000-9000-000000000003','delivered','Piet','',null,null,null,null)$q$) like 'plan-feature-trips%',
  '[17] no delivery sign-off on a trip that is not underway');
select pg_temp.assert(public._trips_refusal($q$update public.trips set status = 'completed', driver_id = 'cb100000-0000-4000-9000-000000000001' where id = 'cb300000-0000-4000-9000-000000000001'$q$) like 'plan-feature-trips%',
  '[17] finishing may not carry another change with it');
-- Finishing what was already in hand.
select public.trip_job_deliver('cb400000-0000-4000-9000-000000000002','failed','','Closed gate',null,null,null,null);
select pg_temp.assert((select status = 'failed' from public.trip_jobs where id = 'cb400000-0000-4000-9000-000000000002'), '[17] a delivery on the trip underway can still be closed');
select public.trip_finish('cb300000-0000-4000-9000-000000000001', 1080);
select pg_temp.assert((select status = 'completed' and closing_reading = 1080 from public.trips where id = 'cb300000-0000-4000-9000-000000000001'),
  '[17] a trip already underway can be finished, so the vehicle is not stuck');
update public.trips set status = 'cancelled' where id = 'cb300000-0000-4000-9000-000000000003';
select pg_temp.assert((select status = 'cancelled' from public.trips where id = 'cb300000-0000-4000-9000-000000000003'), '[17] a planned trip can still be cancelled');
-- And back up: the work goes on.
reset role; select set_config('request.jwt.claims','',true);
update public.farms set plan = 'professional' where id = 'cb000000-0000-4000-9000-000000000001';
select pg_temp.login(1); set local role authenticated;
select public.trip_start('cb300000-0000-4000-9000-000000000002', 5);
select pg_temp.assert((select status = 'underway' from public.trips where id = 'cb300000-0000-4000-9000-000000000002'), '[17] upgrading again restores trip work');

-- == [13] Complete: maps need the readiness flag in the database =========================
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.login(3); set local role authenticated;
insert into public.trips(id,farm_id,number,machine_id,driver_id) values
 ('cb300000-0000-4000-9000-000000000010','cb000000-0000-4000-9000-000000000002',0,'cb200000-0000-4000-9000-000000000003','cb100000-0000-4000-9000-000000000004');
select pg_temp.assert(public._trips_refusal($q$insert into public.trip_routes(trip_id,farm_id,waypoints,geometry,distance_m,duration_s,provider)
  values ('cb300000-0000-4000-9000-000000000010','cb000000-0000-4000-9000-000000000002','[{"lat":-25,"lng":28},{"lat":-25.1,"lng":28.1}]','[[28,-25],[28.1,-25.1]]',1000,60,'mapbox')$q$) like 'maps-not-ready%',
  '[13] Complete without the released map cannot save a route');
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.assert(public._trips_refusal($q$insert into public.asset_positions(farm_id,machine_id,recorded_at,lat,lng) values ('cb000000-0000-4000-9000-000000000002','cb200000-0000-4000-9000-000000000003',now(),-25,28)$q$) like 'maps-not-ready%',
  '[13] no position is written, even by the service, before the map is released to the business');
insert into public.farm_feature_access(farm_id,key) values ('cb000000-0000-4000-9000-000000000002','map');
select pg_temp.login(3); set local role authenticated;
insert into public.trip_routes(trip_id,farm_id,waypoints,geometry,distance_m,duration_s,provider)
  values ('cb300000-0000-4000-9000-000000000010','cb000000-0000-4000-9000-000000000002','[{"lat":-25,"lng":28},{"lat":-25.1,"lng":28.1}]','[[28,-25],[28.1,-25.1]]',1000,60,'mapbox');
reset role; select set_config('request.jwt.claims','',true);
insert into public.asset_positions(farm_id,machine_id,recorded_at,lat,lng) values ('cb000000-0000-4000-9000-000000000002','cb200000-0000-4000-9000-000000000003',now(),-25,28);
select pg_temp.login(3); set local role authenticated;
select pg_temp.assert((select count(*) = 1 from public.trip_routes) and (select count(*) = 1 from public.asset_positions),
  '[13] Complete with the map released saves routes and positions');
select public.trip_start('cb300000-0000-4000-9000-000000000010', 10);
insert into public.trip_jobs(id,farm_id,trip_id,customer) values ('cb400000-0000-4000-9000-000000000010','cb000000-0000-4000-9000-000000000002','cb300000-0000-4000-9000-000000000010','Buyer');
select public.trip_job_deliver('cb400000-0000-4000-9000-000000000010','delivered','Sipho','',null,null,-25.5,28.1);
select pg_temp.assert((select pod_lat = -25.5 and pod_lng = 28.1 from public.trip_jobs where id = 'cb400000-0000-4000-9000-000000000010'),
  '[13] with maps, a delivery keeps its reported location');

-- == [17] Complete down to Professional: retained tracking is readable, nothing new ======
reset role; select set_config('request.jwt.claims','',true);
update public.farms set plan = 'professional' where id = 'cb000000-0000-4000-9000-000000000002';
select pg_temp.login(3); set local role authenticated;
select pg_temp.assert((select count(*) = 1 from public.trip_routes) and (select count(*) = 1 from public.asset_positions),
  '[17] the saved route and positions stay readable after the downgrade');
select pg_temp.assert(public._trips_refusal($q$update public.trip_routes set distance_m = 5 where trip_id = 'cb300000-0000-4000-9000-000000000010'$q$) like 'plan-feature-maps%',
  '[17] a saved route cannot be redrawn below Complete');
reset role; select set_config('request.jwt.claims','',true);
select pg_temp.assert(public._trips_refusal($q$insert into public.asset_positions(farm_id,machine_id,recorded_at,lat,lng) values ('cb000000-0000-4000-9000-000000000002','cb200000-0000-4000-9000-000000000003',now(),-25,28)$q$) like 'plan-feature-maps%',
  '[17] no new position below Complete');
select pg_temp.login(3); set local role authenticated;
-- Trips are still on Professional: a delivery records, but no longer with a location.
insert into public.trip_jobs(id,farm_id,trip_id,customer) values ('cb400000-0000-4000-9000-000000000011','cb000000-0000-4000-9000-000000000002','cb300000-0000-4000-9000-000000000010','Buyer two');
select public.trip_job_deliver('cb400000-0000-4000-9000-000000000011','delivered','Sipho','',null,null,-25.6,28.2);
select pg_temp.assert((select status = 'delivered' and pod_lat is null from public.trip_jobs where id = 'cb400000-0000-4000-9000-000000000011'),
  '[17] after losing maps a delivery records without its location');
-- Clearing a planned route is the owner's own record keeping and stays allowed.
delete from public.trip_routes where trip_id = 'cb300000-0000-4000-9000-000000000010';
select pg_temp.assert((select count(*) = 0 from public.trip_routes), '[17] a saved route can still be removed');

-- == Grants =================================================================================
reset role;
select pg_temp.assert(not has_function_privilege('authenticated','app.maps_allowed(uuid)','execute')
  and not has_function_privilege('anon','app.maps_ready(uuid)','execute')
  and not has_function_privilege('authenticated','app.only_changed(jsonb,jsonb,text[])','execute'),
  'the new helpers are not callable by signed-in or anonymous callers');
drop function public._trips_refusal(text);
rollback;
