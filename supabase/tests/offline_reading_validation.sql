-- The four checks the offline meter-reading path must keep.
--
-- `atomic_offline_capture.sql` has asserted these since it was written, and it fails on
-- PGlite long before reaching them, on the stubbed `digest()` that CLAUDE.md documents. So
-- `pnpm db:check` reported a failure for an unrelated reason and the real one, four
-- validations dropped by the 20260920120000 rewrite, hid behind it until CI ran the suite
-- on real Postgres.
--
-- This suite exists to be runnable where that one is not. It sets up the minimum needed to
-- reach `apply_offline_capture` and asserts the four conditions and nothing else.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('0f000000-0000-4000-8000-000000000001', 'Offline Farm', 'complete', 'active');

insert into auth.users (id, email) values
  ('0f100000-0000-4000-8000-000000000001', 'offline-owner@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('0f100000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000001',
   'owner', 'Offline Owner', 'offline-owner@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, current_reading) values
  ('0f200000-0000-4000-8000-000000000001', '0f000000-0000-4000-8000-000000000001',
   'Hours tractor', 'tractor', 'hours', 'active', 100),
  -- A machine with NO meter. A reading against it is meaningless and must be refused.
  ('0f200000-0000-4000-8000-000000000002', '0f000000-0000-4000-8000-000000000001',
   'No meter implement', 'implement', 'none', 'active', null);

-- == (a) The four refusals ===================================================
do $$
declare
  bad     jsonb;
  denied  boolean;
  machine uuid := '0f200000-0000-4000-8000-000000000001';
  actor   uuid := '0f100000-0000-4000-8000-000000000001';
begin
  for bad in select value from jsonb_array_elements('[
    {"reading_date":"infinity"},
    {"reading_date":"1969-12-31"},
    {"name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
  ]'::jsonb) loop
    denied := false;
    begin
      perform public.apply_offline_capture(
        gen_random_uuid(), now(), 'log_reading', 'app', actor,
        jsonb_build_object('machine_id', machine::text, 'reading', '200') || bad);
    exception when invalid_parameter_value then denied := true;
    end;
    if not denied then
      raise exception 'OFFLINE READING FAIL: accepted %', bad;
    end if;
  end loop;

  -- A machine with no meter cannot have a reading logged against it.
  denied := false;
  begin
    perform public.apply_offline_capture(
      gen_random_uuid(), now(), 'log_reading', 'app', actor,
      jsonb_build_object('machine_id', '0f200000-0000-4000-8000-000000000002',
                         'reading', '200'));
  exception when invalid_parameter_value then denied := true;
  end;
  if not denied then
    raise exception 'OFFLINE READING FAIL: a reading was logged against a machine with no meter';
  end if;
end $$;

-- == (b) And a good reading still goes through ===============================
-- A validation tightened until nothing passes is not a validation, it is an outage.
do $$
declare r jsonb; n integer;
begin
  r := public.apply_offline_capture(
    gen_random_uuid(), now(), 'log_reading', 'app',
    '0f100000-0000-4000-8000-000000000001',
    jsonb_build_object('machine_id', '0f200000-0000-4000-8000-000000000001',
                       'reading', '250', 'reading_date', to_char(current_date, 'YYYY-MM-DD')));
  if coalesce(r->>'status', '') not in ('applied', 'conflict') then
    raise exception 'OFFLINE READING FAIL: a good reading was refused (%)', r;
  end if;

  select count(*) into n from public.meter_readings
   where machine_id = '0f200000-0000-4000-8000-000000000001' and reading = 250;
  if n <> 1 then
    raise exception 'OFFLINE READING FAIL: a good reading did not land (% rows)', n;
  end if;

  -- The boundary the 1970 check draws: the epoch itself is a real date and is allowed.
  r := public.apply_offline_capture(
    gen_random_uuid(), now(), 'log_reading', 'app',
    '0f100000-0000-4000-8000-000000000001',
    jsonb_build_object('machine_id', '0f200000-0000-4000-8000-000000000001',
                       'reading', '260', 'reading_date', '1970-01-01'));
  if coalesce(r->>'status', '') not in ('applied', 'conflict') then
    raise exception 'OFFLINE READING FAIL: 1970-01-01 was refused, the bound is off by one (%)', r;
  end if;
end $$;

rollback;
