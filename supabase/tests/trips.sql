\set ON_ERROR_STOP on
-- Trips: who can see and do what, and the rules a trip keeps (20261107130000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e9000000-0000-4000-9000-000000000001', 'Haulage', 'complete', 'active', 'monthly'),
  ('e9000000-0000-4000-9000-000000000002', 'Rival', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e9100000-0000-4000-9000-000000000001', 'owner@trips.test'),
  ('e9100000-0000-4000-9000-000000000002', 'driver@trips.test'),
  ('e9100000-0000-4000-9000-000000000003', 'driver2@trips.test'),
  ('e9100000-0000-4000-9000-000000000004', 'rival@trips.test'),
  ('e9100000-0000-4000-9000-000000000005', 'workshop@trips.test');
insert into public.workshops (id, name) values ('e9400000-0000-4000-9000-000000000001', 'Linked workshop');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('e9100000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001', null, 'owner', 'Owner', 'owner@trips.test', true),
  ('e9100000-0000-4000-9000-000000000002', 'e9000000-0000-4000-9000-000000000001', null, 'operator', 'Driver', 'driver@trips.test', true),
  ('e9100000-0000-4000-9000-000000000003', 'e9000000-0000-4000-9000-000000000001', null, 'operator', 'Driver 2', 'driver2@trips.test', true),
  ('e9100000-0000-4000-9000-000000000004', 'e9000000-0000-4000-9000-000000000002', null, 'owner', 'Rival', 'rival@trips.test', true),
  ('e9100000-0000-4000-9000-000000000005', null, 'e9400000-0000-4000-9000-000000000001', 'workshop', 'Workshop', 'workshop@trips.test', true);
insert into public.workshop_links (workshop_id, farm_id, status, see_all_vehicles) values
  ('e9400000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001', 'active', true);
insert into public.machines (id, farm_id, name, type) values
  ('e9200000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001', 'Horse 1', 'truck_tractor'),
  ('e9200000-0000-4000-9000-000000000002', 'e9000000-0000-4000-9000-000000000001', 'Trailer 1', 'trailer'),
  ('e9200000-0000-4000-9000-000000000003', 'e9000000-0000-4000-9000-000000000002', 'Rival truck', 'truck');

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

select pg_temp.as_user('e9100000-0000-4000-9000-000000000001');
set local role authenticated;

insert into public.trips (id, farm_id, number, machine_id, trailer_id, driver_id, origin, destination) values
  ('e9300000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001', 0,
   'e9200000-0000-4000-9000-000000000001', 'e9200000-0000-4000-9000-000000000002',
   'e9100000-0000-4000-9000-000000000002', 'Durban', 'Johannesburg');
insert into public.trips (id, farm_id, number, machine_id, driver_id) values
  ('e9300000-0000-4000-9000-000000000002', 'e9000000-0000-4000-9000-000000000001', 0,
   'e9200000-0000-4000-9000-000000000002', 'e9100000-0000-4000-9000-000000000003');
insert into public.trip_jobs (id, farm_id, trip_id, customer, weight_kg, seal_no) values
  ('e9500000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001',
   'e9300000-0000-4000-9000-000000000001', 'Acme', 12000, 'SEAL-1');
insert into public.trip_income (trip_id, farm_id, amount_cents) values
  ('e9300000-0000-4000-9000-000000000001', 'e9000000-0000-4000-9000-000000000001', 1500000);
insert into public.trip_expenses (farm_id, trip_id, kind, amount_cents) values
  ('e9000000-0000-4000-9000-000000000001', 'e9300000-0000-4000-9000-000000000001', 'toll', 45000);

do $t$ begin
  if (select array_agg(number order by number) from public.trips) <> array[1, 2] then
    raise exception 'trips did not number themselves';
  end if;
end $t$;

-- A trip cannot use somebody else's vehicle.
do $t$ begin
  begin
    insert into public.trips (farm_id, number, machine_id) values
      ('e9000000-0000-4000-9000-000000000001', 0, 'e9200000-0000-4000-9000-000000000003');
    raise exception 'a trip used another business''s vehicle';
  exception when foreign_key_violation then null;
  end;
end $t$;
reset role;

-- The driver sees their own trip and load, not a colleague's, and no money.
select pg_temp.as_user('e9100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trips) <> 1 then raise exception 'a driver sees the wrong trips'; end if;
  if (select count(*) from public.trip_jobs) <> 1 then raise exception 'a driver cannot see their load'; end if;
  if (select count(*) from public.trip_income) <> 0 then raise exception 'a driver can see what a trip earned'; end if;
  if (select count(*) from public.trip_expenses) <> 0 then raise exception 'a driver can see trip expenses'; end if;

  update public.trips set destination = 'Cape Town';
  if found then raise exception 'a driver changed a trip directly'; end if;

  perform public.trip_start('e9300000-0000-4000-9000-000000000001', 1000);
  begin
    perform public.trip_start('e9300000-0000-4000-9000-000000000002', 1);
    raise exception 'a driver started a colleague''s trip';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.trip_start('e9300000-0000-4000-9000-000000000001', 1000);
    raise exception 'a trip started twice';
  exception when invalid_parameter_value then null;
  end;

  -- A delivery needs a name.
  begin
    perform public.trip_job_deliver('e9500000-0000-4000-9000-000000000001', 'delivered', '  ', null, null, null, null, null);
    raise exception 'a delivery was signed for by nobody';
  exception when invalid_parameter_value then null;
  end;
  perform public.trip_job_deliver('e9500000-0000-4000-9000-000000000001', 'delivered', 'Sipho', 'All good', 'a/b.jpg', 'a/c.png', -26.2, 28.05);
  begin
    perform public.trip_job_deliver('e9500000-0000-4000-9000-000000000001', 'failed', null, null, null, null, null, null);
    raise exception 'a closed job was changed';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform public.trip_finish('e9300000-0000-4000-9000-000000000001', 900);
    raise exception 'a closing reading went backwards';
  exception when invalid_parameter_value then null;
  end;
  perform public.trip_finish('e9300000-0000-4000-9000-000000000001', 1600);
  if (select status from public.trips where id = 'e9300000-0000-4000-9000-000000000001') <> 'completed' then
    raise exception 'the trip did not finish';
  end if;
end $t$;
reset role;

-- One trip at a time for a vehicle and for a driver.
do $t$ begin
  update public.trips set status = 'underway', started_at = now() where id = 'e9300000-0000-4000-9000-000000000001';
  begin
    update public.trips set status = 'underway', started_at = now(), machine_id = 'e9200000-0000-4000-9000-000000000001'
     where id = 'e9300000-0000-4000-9000-000000000002';
    raise exception 'one vehicle was on two trips';
  exception when unique_violation then null;
  end;
  update public.trips set status = 'completed' where id = 'e9300000-0000-4000-9000-000000000001';
end $t$;

-- Another business and a linked contractor see nothing.
select pg_temp.as_user('e9100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trips) <> 0 then raise exception 'another business can see these trips'; end if;
  begin
    perform public.trip_start('e9300000-0000-4000-9000-000000000002', 1);
    raise exception 'another business started a trip';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

select pg_temp.as_user('e9100000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.trips) <> 0 then raise exception 'a contractor can see trips'; end if;
  if (select count(*) from public.trip_jobs) <> 0 then raise exception 'a contractor can see loads'; end if;
end $t$;
reset role;

rollback;
