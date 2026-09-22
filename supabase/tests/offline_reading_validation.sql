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

  -- ONE IN THE MORNING ON A FARM.
  --
  -- The reading's date is decided in SAST. The "not in the future" bound used to be
  -- `current_date`, which is the SERVER's date, and Supabase runs UTC. Between 00:00 and
  -- 02:00 SAST those are different days, so a reading captured at one in the morning was
  -- refused as being in the future.
  --
  -- Today in the farm's own timezone must always be allowed, whatever the server thinks
  -- the date is. This expectation is right at every hour; it only CATCHES the bug during
  -- the two-hour window, which is precisely how it survived until CI happened to run at
  -- 23:59 UTC. Section (c) is the part that catches it at any hour.
  r := public.apply_offline_capture(
    gen_random_uuid(), now(), 'log_reading', 'app',
    '0f100000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'machine_id', '0f200000-0000-4000-8000-000000000001', 'reading', '270',
      'reading_date', to_char((now() at time zone 'Africa/Johannesburg')::date, 'YYYY-MM-DD')));
  if coalesce(r->>'status', '') not in ('applied', 'conflict') then
    raise exception
      'OFFLINE READING FAIL: today in SAST was refused as being in the future (%)', r;
  end if;

  -- And tomorrow in SAST is still refused, so the fix widened the bound by exactly the
  -- timezone offset and not by a day.
  declare denied boolean := false;
  begin
    begin
      perform public.apply_offline_capture(
        gen_random_uuid(), now(), 'log_reading', 'app',
        '0f100000-0000-4000-8000-000000000001',
        jsonb_build_object(
          'machine_id', '0f200000-0000-4000-8000-000000000001', 'reading', '280',
          'reading_date',
          to_char(((now() at time zone 'Africa/Johannesburg')::date + 1), 'YYYY-MM-DD')));
    exception when invalid_parameter_value then denied := true;
    end;
    if not denied then
      raise exception 'OFFLINE READING FAIL: a reading dated tomorrow was accepted';
    end if;
  end;

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

-- == (c) The bound is in the farm's timezone, at any hour =====================
--
-- Section (b) states the right expectation but can only FAIL during the two hours a day
-- when the server's date and the farm's disagree. That is how the bug survived: every
-- green CI run happened in the morning.
--
-- So this reads the function itself. `v_date` is derived with an explicit
-- `at time zone 'Africa/Johannesburg'`, and the future bound has to be a value in that
-- same timezone. Comparing a date decided in one timezone against `current_date`, decided
-- in another, is the defect, whatever the offset happens to be.
--
-- White-box on purpose, and narrow: it asserts one thing about one function, and it is the
-- only assertion here that is true at three in the afternoon.
do $$
declare v_src text;
begin
  v_src := pg_get_functiondef(
    'public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)'::regprocedure);

  if v_src ~ 'v_date\s*>\s*current_date' then
    raise exception
      'OFFLINE READING FAIL: the future bound compares a SAST date against current_date, which is the SERVER timezone. Between 00:00 and 02:00 SAST that refuses a reading taken today.';
  end if;

  -- And the replacement really is in the farm's timezone rather than a renamed variable
  -- holding the same server date.
  if v_src !~ 'v_today\s+date\s*:=\s*\(now\(\) at time zone ''Africa/Johannesburg''\)::date' then
    raise exception
      'OFFLINE READING FAIL: v_today is not derived in the farm timezone, so the bound is back where it started.';
  end if;
end $$;

rollback;
