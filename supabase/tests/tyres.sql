-- Tyres: a rotation keeps one life, and hours are never added to kilometres.
--
-- The number this feature exists to produce is cost per hour or per kilometre, and there
-- are exactly two ways to get it wrong that a farm would never catch. Losing the history
-- on a rotation makes every rotated tyre look cheap; adding an hours span to a km span
-- produces a figure that reads like an answer and is not one. Both are asserted here.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _ty_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _ty_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('da000000-0000-4000-8000-000000000001', 'Tyre Farm', 'complete', 'active'),
  ('da000000-0000-4000-8000-000000000002', 'Other Tyre Farm', 'complete', 'active');

insert into auth.users (id, email) values
  ('da100000-0000-4000-8000-000000000001', 'tyre-owner@example.test'),
  ('da100000-0000-4000-8000-000000000002', 'tyre-operator@example.test'),
  ('da100000-0000-4000-8000-000000000003', 'tyre-neighbour@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('da100000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   'owner', 'Tyre Owner', 'tyre-owner@example.test'),
  ('da100000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001',
   'operator', 'Tyre Operator', 'tyre-operator@example.test'),
  ('da100000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000002',
   'owner', 'Neighbour', 'tyre-neighbour@example.test');

insert into public.machines
  (id, farm_id, name, type, meter_type, status, current_reading, assigned_operator_id) values
  ('da200000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   'Hours tractor', 'tractor', 'hours', 'active', 3000, 'da100000-0000-4000-8000-000000000002'),
  ('da200000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001',
   'Second tractor', 'tractor', 'hours', 'active', 5000, null),
  ('da200000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000001',
   'Km truck', 'truck', 'km', 'active', 200000, null),
  ('da200000-0000-4000-8000-000000000009', 'da000000-0000-4000-8000-000000000002',
   'Their truck', 'truck', 'km', 'active', 100000, null);

-- R6 000 tyre, 20mm of tread new.
insert into public.tyres
  (id, farm_id, brand, pattern, size, serial_no, purchase_date, purchase_cost_cents, new_tread_mm) values
  ('da300000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   'Michelin', 'XM108', '520/85R42', 'SN-1', date '2025-01-01', 600000, 20),
  ('da300000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001',
   'Firestone', 'Performer', '520/85R42', 'SN-2', date '2025-01-01', 400000, 18),
  -- The one that will run on two different meter types.
  ('da300000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000001',
   'Mixed', 'Mixed', '385/65R22.5', 'SN-3', date '2025-01-01', 500000, 16);

-- == (a) A rotation keeps one life ===========================================
set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000001');
do $$
declare r record; n integer;
begin
  -- Fitted at 1 000 hours on the first tractor.
  perform public.fit_tyre('da300000-0000-4000-8000-000000000001',
    'da200000-0000-4000-8000-000000000001', 'drive', 'LR', date '2025-02-01', 1000);
  -- Rotated to the second tractor at 1 800 hours: 800 hours on the first.
  perform public.fit_tyre('da300000-0000-4000-8000-000000000001',
    'da200000-0000-4000-8000-000000000002', 'drive', 'RR', date '2025-08-01', 1800);

  -- Two fitments, one of them closed by the rotation.
  select count(*) into n from public.tyre_fitments
   where tyre_id = 'da300000-0000-4000-8000-000000000001';
  if n <> 2 then
    raise exception 'TYRE FAIL [a]: a rotation produced % fitment rows, expected 2', n;
  end if;
  select count(*) into n from public.tyre_fitments
   where tyre_id = 'da300000-0000-4000-8000-000000000001' and removed_on is null;
  if n <> 1 then
    raise exception 'TYRE FAIL [a]: % fitments are open at once', n;
  end if;

  -- The second tractor reads 5 000, so the open span is 5 000 - 1 800 = 3 200, plus the
  -- 800 from the first machine: 4 000 hours on one tyre, across a rotation.
  select * into r from public.tyre_life('da000000-0000-4000-8000-000000000001')
   where tyre_id = 'da300000-0000-4000-8000-000000000001';
  if r.units_run <> 4000 then
    raise exception 'TYRE FAIL [a]: the rotated tyre shows % units, expected 4000 across both machines',
      r.units_run;
  end if;
  -- R6 000 over 4 000 hours is 150c an hour. Losing the first span would say 187,5c and a
  -- farm would never know the difference.
  if r.cost_per_unit_cents <> 150 then
    raise exception 'TYRE FAIL [a]: cost per hour came out at %, expected 150', r.cost_per_unit_cents;
  end if;
  -- And it reports where the tyre is NOW.
  if r.machine_name <> 'Second tractor' or r.position_label <> 'RR' then
    raise exception 'TYRE FAIL [a]: the tyre is reported on % at %', r.machine_name, r.position_label;
  end if;
end $$;
reset role;

-- == (b) Hours are never added to kilometres =================================
set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  perform public.fit_tyre('da300000-0000-4000-8000-000000000003',
    'da200000-0000-4000-8000-000000000001', 'drive', 'LF', date '2025-02-01', 1000);
  perform public.remove_tyre('da300000-0000-4000-8000-000000000003', 'swapped',
    date '2025-06-01', 1500);
  -- Now onto a kilometre machine.
  perform public.fit_tyre('da300000-0000-4000-8000-000000000003',
    'da200000-0000-4000-8000-000000000003', 'drive', 'RF', date '2025-07-01', 150000);

  select * into r from public.tyre_life('da000000-0000-4000-8000-000000000001')
   where tyre_id = 'da300000-0000-4000-8000-000000000003';
  -- 500 hours plus 50 000 km is not 50 500 of anything.
  if r.cost_per_unit_cents is not null then
    raise exception 'TYRE FAIL [b]: a tyre run on hours AND km was given a rate of %',
      r.cost_per_unit_cents;
  end if;
  if r.meter_type is not null then
    raise exception 'TYRE FAIL [b]: a mixed-unit tyre reports a unit of %', r.meter_type;
  end if;
end $$;
reset role;

-- == (c) One tyre is in one place ============================================
do $$
declare v_failed boolean := false;
begin
  begin
    insert into public.tyre_fitments (farm_id, tyre_id, machine_id, axle, fitted_on)
    values ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000001',
            'da200000-0000-4000-8000-000000000001', 'drive', current_date);
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'TYRE FAIL [c]: one tyre was fitted in two places at once';
  end if;
end $$;

-- == (d) A life cannot run backwards =========================================
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    insert into public.tyre_fitments
      (farm_id, tyre_id, machine_id, axle, fitted_on, fitted_reading, removed_on, removed_reading)
    values ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000002',
            'da200000-0000-4000-8000-000000000001', 'drive',
            date '2025-02-01', 2000, date '2025-01-01', 2500);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'TYRE FAIL [d]: a tyre came off before it went on';
  end if;

  v_failed := false;
  begin
    insert into public.tyre_fitments
      (farm_id, tyre_id, machine_id, axle, fitted_on, fitted_reading, removed_on, removed_reading)
    values ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000002',
            'da200000-0000-4000-8000-000000000001', 'drive',
            date '2025-02-01', 2000, date '2025-06-01', 1500);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'TYRE FAIL [d]: the meter ran backwards while the tyre was fitted';
  end if;

  -- Tread is millimetres, not a percentage and not a typo.
  v_failed := false;
  begin
    insert into public.tyre_checks (farm_id, tyre_id, tread_mm)
    values ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000002', 140);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'TYRE FAIL [d]: a 140mm tread reading was accepted';
  end if;
end $$;

-- == (e) The latest check is the one that shows ==============================
insert into public.tyre_checks (farm_id, tyre_id, checked_on, tread_mm, reading) values
  ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000001',
   date '2025-03-01', 18, 1200),
  ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000001',
   date '2026-01-01', 9, 3500),
  -- Out of order on purpose: the newest by DATE wins, not the newest row.
  ('da000000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000001',
   date '2025-09-01', 13, 2200);

set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from public.tyre_life('da000000-0000-4000-8000-000000000001')
   where tyre_id = 'da300000-0000-4000-8000-000000000001';
  if r.latest_tread_mm <> 9 or r.latest_checked_on <> date '2026-01-01' then
    raise exception 'TYRE FAIL [e]: the latest tread reads % from %',
      r.latest_tread_mm, r.latest_checked_on;
  end if;
  -- The baseline comes along, because 9mm means nothing without the 20 it started at.
  if r.new_tread_mm <> 20 then
    raise exception 'TYRE FAIL [e]: the new tread is % and a reading has nothing to measure against',
      r.new_tread_mm;
  end if;
end $$;
reset role;

-- == (f) Removing and scrapping ==============================================
set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000001');
do $$
declare s tyre_status; v_failed boolean := false;
begin
  perform public.remove_tyre('da300000-0000-4000-8000-000000000001', 'worn out',
    date '2026-02-01', 5000, true);
  select status into s from public.tyres where id = 'da300000-0000-4000-8000-000000000001';
  if s <> 'scrapped' then
    raise exception 'TYRE FAIL [f]: a scrapped tyre is marked %', s;
  end if;

  -- Taking off a tyre that is not on anything is a mistake worth a sentence.
  begin
    perform public.remove_tyre('da300000-0000-4000-8000-000000000002', 'nothing to remove');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'TYRE FAIL [f]: removing an unfitted tyre was accepted silently';
  end if;
end $$;
reset role;

-- == (g) Who sees what =======================================================
set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000002');
do $$
begin
  -- An operator sees fitments on their own machine.
  if not exists (select 1 from public.tyre_fitments
                  where machine_id = 'da200000-0000-4000-8000-000000000001') then
    raise exception 'TYRE FAIL [g]: an operator cannot see tyres on their own machine';
  end if;
  -- And not on machines that are not theirs.
  if exists (select 1 from public.tyre_fitments
              where machine_id = 'da200000-0000-4000-8000-000000000002') then
    raise exception 'TYRE FAIL [g]: an operator sees fitments on a machine that is not theirs';
  end if;
end $$;
reset role;

set role authenticated;
select _ty_login('da100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.tyres;
  if n <> 0 then
    raise exception 'TYRE FAIL [g]: a neighbouring farm sees % tyres', n;
  end if;
  select count(*) into n from public.tyre_life('da000000-0000-4000-8000-000000000001');
  if n <> 0 then
    raise exception 'TYRE FAIL [g]: a neighbouring farm read % rows of this farm''s tyre costs', n;
  end if;
end $$;
reset role;

do $$
begin
  if has_table_privilege('anon', 'public.tyres', 'SELECT')
     or has_function_privilege('anon', 'public.tyre_life(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.fit_tyre(uuid,uuid,tyre_axle,text,date,numeric)', 'EXECUTE') then
    raise exception 'TYRE FAIL [g]: anon may read or change tyres';
  end if;
end $$;

rollback;
