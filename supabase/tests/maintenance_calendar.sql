-- The calendar: five sources, one list, and every source keeping its own RLS.
--
-- The risk a unified view carries is that it becomes a back door. `farm_calendar` reads
-- five tables whose policies disagree with each other on purpose: an operator sees only
-- their own machines, a linked workshop sees machines but not personnel, and
-- `driver_credentials` is narrower than either. If the function widened any of that, the
-- calendar would be the one screen where a driver could read a colleague's medical date.
--
-- So most of what follows is the same query asked by four different people.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _cal_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _cal_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('ca000000-0000-4000-8000-000000000001', 'Calendar Farm', 'complete', 'active'),
  ('ca000000-0000-4000-8000-000000000002', 'Neighbour Farm', 'complete', 'active');

insert into public.workshops (id, name) values
  ('caf00000-0000-4000-8000-000000000001', 'Calendar Workshop');
insert into public.workshop_links (workshop_id, farm_id, status) values
  ('caf00000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', 'active');

insert into auth.users (id, email) values
  ('ca100000-0000-4000-8000-000000000001', 'cal-owner@example.test'),
  ('ca100000-0000-4000-8000-000000000002', 'cal-operator@example.test'),
  ('ca100000-0000-4000-8000-000000000003', 'cal-workshop@example.test'),
  ('ca100000-0000-4000-8000-000000000004', 'cal-neighbour@example.test');

insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', null,
   'owner', 'Calendar Owner', 'cal-owner@example.test'),
  ('ca100000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', null,
   'operator', 'Calendar Operator', 'cal-operator@example.test'),
  ('ca100000-0000-4000-8000-000000000003', null, 'caf00000-0000-4000-8000-000000000001',
   'workshop', 'Calendar Workshop Hand', 'cal-workshop@example.test'),
  ('ca100000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000002', null,
   'owner', 'Neighbour', 'cal-neighbour@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  -- Assigned to the operator.
  ('ca200000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Theirs', 'tractor', 'hours', 'active', 'ca100000-0000-4000-8000-000000000002'),
  -- Not assigned to anybody.
  ('ca200000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001',
   'Not theirs', 'harvester', 'hours', 'active', null),
  -- Sold: nothing about it belongs on a plan for next month.
  ('ca200000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001',
   'Sold one', 'bakkie', 'km', 'sold', null),
  ('ca200000-0000-4000-8000-000000000009', 'ca000000-0000-4000-8000-000000000002',
   'Neighbour machine', 'tractor', 'hours', 'active', null);

-- Five kinds of thing, all inside one week in the middle of the range.
insert into public.service_plan_lines
  (farm_id, machine_id, task, interval_months, next_due_date, status) values
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001',
   '500-hour service', 6, date '2026-10-12', 'due_soon'),
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000002',
   'Annual service', 12, date '2026-10-13', 'overdue'),
  -- On the sold machine, and on a day inside the window: must not appear.
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000003',
   'Service on a sold machine', 12, date '2026-10-14', 'due_soon');

insert into public.job_cards
  (id, farm_id, machine_id, workshop_id, type, status, date_in) values
  ('ca300000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ca200000-0000-4000-8000-000000000001', 'caf00000-0000-4000-8000-000000000001',
   'repair', 'in_progress', date '2026-10-14'),
  -- Approved is finished and off the plan.
  ('ca300000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001',
   'ca200000-0000-4000-8000-000000000002', null,
   'scheduled_service', 'approved', date '2026-10-15');

insert into public.licences (farm_id, machine_id, type, number, expiry_date) values
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000002',
   'roadworthy', 'RW-1', date '2026-10-16');

insert into public.driver_credentials (farm_id, person_name, type, expiry_date) values
  ('ca000000-0000-4000-8000-000000000001', 'Casual Driver', 'prdp', date '2026-10-17');

insert into public.work_requests (farm_id, machine_id, kind, status, title, created_at) values
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001',
   'repair', 'quoted', 'Gearbox noise', timestamptz '2026-10-18 09:00+02');

-- Outside the window entirely, so the date filter has something to exclude.
insert into public.service_plan_lines
  (farm_id, machine_id, task, interval_months, next_due_date, status) values
  ('ca000000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001',
   'Next year', 12, date '2027-05-01', 'ok');

-- == (a) The owner sees the week, and only the week =========================
set role authenticated;
select _cal_login('ca100000-0000-4000-8000-000000000001');
do $$
declare n integer; kinds text;
begin
  select count(*) into n from public.farm_calendar(
    'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31');
  -- Two services (the sold machine's is excluded), one live job card (the approved one is
  -- not), one licence, one driver document, one work request.
  if n <> 6 then
    raise exception 'CALENDAR FAIL [a]: the owner sees % items in October, expected 6', n;
  end if;

  select string_agg(distinct kind::text, ',' order by kind::text) into kinds
    from public.farm_calendar(
      'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31');
  if kinds <> 'driver_document,job_card,licence,service_due,work_request' then
    raise exception 'CALENDAR FAIL [a]: the kinds on the calendar are %', kinds;
  end if;

  -- A sold machine is not planned around.
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where machine_name = 'Sold one') then
    raise exception 'CALENDAR FAIL [a]: a sold machine is on the plan';
  end if;

  -- An approved job card is finished.
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where kind = 'job_card' and on_date = date '2026-10-15') then
    raise exception 'CALENDAR FAIL [a]: an approved job card is still on the plan';
  end if;

  -- Next May is not this month.
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where on_date > date '2026-10-31' or on_date < date '2026-10-01') then
    raise exception 'CALENDAR FAIL [a]: something outside the window is on the calendar';
  end if;

  -- The overdue service says so, in the vocabulary the rest of the product uses.
  if not exists (select 1 from public.farm_calendar(
                   'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
                 where kind = 'service_due' and state = 'overdue') then
    raise exception 'CALENDAR FAIL [a]: the overdue service is not marked overdue';
  end if;

  -- The job card names the workshop, which is the "booked with which workshop" the gap
  -- review asked for.
  if not exists (select 1 from public.farm_calendar(
                   'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
                 where kind = 'job_card' and detail = 'Calendar Workshop') then
    raise exception 'CALENDAR FAIL [a]: the calendar does not say which workshop';
  end if;
end $$;
reset role;

-- == (b) An operator gets their own machines, and no personnel ==============
set role authenticated;
select _cal_login('ca100000-0000-4000-8000-000000000002');
do $$
declare n integer;
begin
  select count(*) into n from public.farm_calendar(
    'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31');
  -- Their own machine only: one service, one job card, one work request.
  if n <> 3 then
    raise exception 'CALENDAR FAIL [b]: an operator sees % items, expected 3 on their own machine', n;
  end if;
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where machine_name = 'Not theirs') then
    raise exception 'CALENDAR FAIL [b]: an operator sees a machine that is not theirs';
  end if;
  -- THE one that matters: a colleague's document date is personnel information, and the
  -- calendar must not be the screen where it leaks.
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where kind = 'driver_document') then
    raise exception 'CALENDAR FAIL [b]: an operator read a driver document off the calendar';
  end if;
end $$;
reset role;

-- == (c) A linked workshop gets machines, not personnel =====================
set role authenticated;
select _cal_login('ca100000-0000-4000-8000-000000000003');
do $$
begin
  if not app.has_farm_access('ca000000-0000-4000-8000-000000000001') then
    raise exception 'CALENDAR SETUP [c]: the workshop link grants no access at all';
  end if;
  if exists (select 1 from public.farm_calendar(
               'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31')
             where kind = 'driver_document') then
    raise exception 'CALENDAR FAIL [c]: a linked workshop read a driver document off the calendar';
  end if;
end $$;
reset role;

-- == (d) The fence ==========================================================
set role authenticated;
select _cal_login('ca100000-0000-4000-8000-000000000004');
do $$
declare n integer;
begin
  select count(*) into n from public.farm_calendar(
    'ca000000-0000-4000-8000-000000000001', date '2026-10-01', date '2026-10-31');
  if n <> 0 then
    raise exception 'CALENDAR FAIL [d]: a neighbouring farm read % calendar items', n;
  end if;
end $$;
reset role;

-- == (e) Grants =============================================================
do $$
begin
  if has_function_privilege('anon', 'public.farm_calendar(uuid,date,date)', 'EXECUTE') then
    raise exception 'CALENDAR FAIL [e]: anon may read a farm calendar';
  end if;
  if not has_function_privilege('authenticated', 'public.farm_calendar(uuid,date,date)', 'EXECUTE') then
    raise exception 'CALENDAR FAIL [e]: the screen cannot read the calendar';
  end if;
end $$;

rollback;
