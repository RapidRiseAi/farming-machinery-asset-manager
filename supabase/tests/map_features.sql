\set ON_ERROR_STOP on
-- Features in testing, and who can see where a vehicle was (20261107120000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e8000000-0000-4000-9000-000000000001', 'Map farm', 'complete', 'active', 'monthly'),
  ('e8000000-0000-4000-9000-000000000002', 'Other farm', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e8100000-0000-4000-9000-000000000001', 'owner@map.test'),
  ('e8100000-0000-4000-9000-000000000002', 'driver@map.test'),
  ('e8100000-0000-4000-9000-000000000003', 'driver2@map.test'),
  ('e8100000-0000-4000-9000-000000000004', 'other@map.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('e8100000-0000-4000-9000-000000000001', 'e8000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'owner@map.test', true),
  ('e8100000-0000-4000-9000-000000000002', 'e8000000-0000-4000-9000-000000000001', 'operator', 'Driver', 'driver@map.test', true),
  ('e8100000-0000-4000-9000-000000000003', 'e8000000-0000-4000-9000-000000000001', 'operator', 'Driver 2', 'driver2@map.test', true),
  ('e8100000-0000-4000-9000-000000000004', 'e8000000-0000-4000-9000-000000000002', 'owner', 'Other', 'other@map.test', true);
insert into public.machines (id, farm_id, name, type) values
  ('e8200000-0000-4000-9000-000000000001', 'e8000000-0000-4000-9000-000000000001', 'Truck', 'truck');
insert into public.driving_sessions (id, farm_id, machine_id, driver_id, started_at, created_by) values
  ('e8300000-0000-4000-9000-000000000001', 'e8000000-0000-4000-9000-000000000001',
   'e8200000-0000-4000-9000-000000000001', 'e8100000-0000-4000-9000-000000000002', now(), 'e8100000-0000-4000-9000-000000000002');
insert into public.asset_positions (farm_id, machine_id, session_id, recorded_at, lat, lng) values
  ('e8000000-0000-4000-9000-000000000001', 'e8200000-0000-4000-9000-000000000001',
   'e8300000-0000-4000-9000-000000000001', now(), -25.7, 28.2),
  ('e8000000-0000-4000-9000-000000000001', 'e8200000-0000-4000-9000-000000000001',
   null, now() - interval '200 days', -25.8, 28.3);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- The owner sees every point.
select pg_temp.as_user('e8100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_positions) <> 2 then raise exception 'the owner cannot see the fleet'; end if;
end $t$;
reset role;

-- A driver sees their own trip, and nothing of anybody else's.
select pg_temp.as_user('e8100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_positions) <> 1 then raise exception 'a driver''s view is wrong'; end if;
end $t$;
reset role;
select pg_temp.as_user('e8100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_positions) <> 0 then raise exception 'a driver can see where a colleague was'; end if;
end $t$;
reset role;

-- Another business sees nothing, and cannot turn a feature on for itself.
select pg_temp.as_user('e8100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_positions) <> 0 then raise exception 'another business can see these vehicles'; end if;
  begin
    insert into public.farm_feature_access (farm_id, key) values ('e8000000-0000-4000-9000-000000000002', 'map');
    raise exception 'a customer turned a feature on for themselves';
  exception when insufficient_privilege then null;
  end;
  update public.feature_flags set released = true where key = 'map';
  if found then raise exception 'a customer released a feature'; end if;
end $t$;
reset role;

-- Positions are the server's to write.
do $t$ begin
  if has_table_privilege('authenticated', 'public.asset_positions', 'INSERT') then
    raise exception 'a signed-in person can write a position';
  end if;
  if (select released from public.feature_flags where key = 'map') then
    raise exception 'the map must start unreleased';
  end if;
end $t$;

-- Old trails go; recent ones stay.
do $t$ begin
  if public.cron_purge_positions() <> 1 then raise exception 'the purge removed the wrong number'; end if;
  if (select count(*) from public.asset_positions) <> 1 then raise exception 'the purge took a recent point'; end if;
end $t$;

rollback;
