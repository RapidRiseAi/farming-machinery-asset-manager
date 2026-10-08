\set ON_ERROR_STOP on
-- Diesel by voice (20261009090000): a confirmed log_fuel proposal becomes a fuel draw
-- through record_fuel_issue, the eleven-key drafts of the other commands keep working,
-- and litres or a tank on anything else is refused.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('af000000-0000-4000-9000-000000000001', 'Fuel voice farm', 'complete', 'active'),
  ('af000000-0000-4000-9000-000000000002', 'Fuel voice other farm', 'complete', 'active');
insert into auth.users (id, email) values
  ('af100000-0000-4000-9000-000000000001', 'fv.owner@example.test'),
  ('af100000-0000-4000-9000-000000000002', 'fv.operator@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('af100000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'fv.owner@example.test'),
  ('af100000-0000-4000-9000-000000000002', 'af000000-0000-4000-9000-000000000001', 'operator', 'Operator', 'fv.operator@example.test');
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('af100000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'owner', true),
  ('af100000-0000-4000-9000-000000000002', 'af000000-0000-4000-9000-000000000001', 'operator', true);
insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('af200000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'Tractor', 'tractor', 'hours', 'active', 'af100000-0000-4000-9000-000000000002'),
  ('af200000-0000-4000-9000-000000000002', 'af000000-0000-4000-9000-000000000001', 'Bakkie', 'bakkie', 'km', 'active', null),
  ('af200000-0000-4000-9000-000000000003', 'af000000-0000-4000-9000-000000000001', 'Pump', 'pump_generator', 'none', 'active', null);
insert into public.fuel_tanks (id, farm_id, name) values
  ('af300000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'Main tank'),
  ('af300000-0000-4000-9000-000000000002', 'af000000-0000-4000-9000-000000000002', 'Other farm tank');

-- A draft as the app stores it: the eleven keys, plus litres and tankId when given.
create or replace function _fv_args(
  p_intent text, p_machine uuid, p_litres jsonb, p_tank text, p_reading jsonb, p_date text,
  p_description text default null, p_with_fuel_keys boolean default true
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'intent', p_intent, 'machineQuery', 'spoken', 'machineId', p_machine::text,
    'description', p_description, 'category', null, 'urgency', case when p_description is null then null else 'can_work' end,
    'reading', p_reading, 'readingDate', p_date, 'serviceDate', null, 'workPerformed', null,
    'confidence', 0.9
  ) || case when p_with_fuel_keys then jsonb_build_object('litres', p_litres, 'tankId', p_tank) else '{}'::jsonb end;
$$;

insert into public.ai_interactions (
  id, farm_id, user_id, channel, locale, route_tier, intent, tool_name, tool_args,
  confirmation_status, result_status, proposal_expires_at
)
select id::uuid, 'af000000-0000-4000-9000-000000000001', usr::uuid, 'typed', 'en-ZA', 1, intent, intent, args,
       'pending', 'proposed', now() + interval '15 minutes'
  from (values
    -- 1 the owner: 80 L into the bakkie, with its odometer
    ('af500000-0000-4000-9000-000000000001', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', '80', 'af300000-0000-4000-9000-000000000001', '52700', to_char(current_date, 'YYYY-MM-DD'))),
    -- 2 the operator: 60 L into the tractor assigned to them, no meter, no date
    ('af500000-0000-4000-9000-000000000002', 'af100000-0000-4000-9000-000000000002', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000001', '60', 'af300000-0000-4000-9000-000000000001', 'null', null)),
    -- 3 the operator: a machine not assigned to them
    ('af500000-0000-4000-9000-000000000003', 'af100000-0000-4000-9000-000000000002', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', '50', 'af300000-0000-4000-9000-000000000001', 'null', null)),
    -- 4 zero litres
    ('af500000-0000-4000-9000-000000000004', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', '0', 'af300000-0000-4000-9000-000000000001', 'null', null)),
    -- 5 another farm's tank
    ('af500000-0000-4000-9000-000000000005', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', '40', 'af300000-0000-4000-9000-000000000002', 'null', null)),
    -- 6 a dated draw in the future
    ('af500000-0000-4000-9000-000000000006', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', '40', 'af300000-0000-4000-9000-000000000001', 'null', to_char(current_date + 3, 'YYYY-MM-DD'))),
    -- 7 a meter reading on a machine with no meter
    ('af500000-0000-4000-9000-000000000007', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000003', '20', 'af300000-0000-4000-9000-000000000001', '15', null)),
    -- 8 a reading, the new thirteen-key form with empty fuel fields: still a reading
    ('af500000-0000-4000-9000-000000000008', 'af100000-0000-4000-9000-000000000001', 'log_reading',
      _fv_args('log_reading', 'af200000-0000-4000-9000-000000000001', 'null', null, '1234', to_char(current_date, 'YYYY-MM-DD'))),
    -- 9 a reading in the old eleven-key form (the build live during the release)
    ('af500000-0000-4000-9000-000000000009', 'af100000-0000-4000-9000-000000000001', 'log_reading',
      _fv_args('log_reading', 'af200000-0000-4000-9000-000000000001', null, null, '1240', to_char(current_date, 'YYYY-MM-DD'), null, false)),
    -- 10 a fault carrying litres
    ('af500000-0000-4000-9000-000000000010', 'af100000-0000-4000-9000-000000000001', 'report_fault',
      _fv_args('report_fault', 'af200000-0000-4000-9000-000000000001', '30', 'af300000-0000-4000-9000-000000000001', 'null', null, 'Leaking')),
    -- 11 a fuel draft without its fuel keys
    ('af500000-0000-4000-9000-000000000011', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', null, null, 'null', null, null, false)),
    -- 12 twelve keys: litres without a tank
    ('af500000-0000-4000-9000-000000000012', 'af100000-0000-4000-9000-000000000001', 'log_fuel',
      _fv_args('log_fuel', 'af200000-0000-4000-9000-000000000002', null, null, 'null', null, null, false) || '{"litres": 25}'::jsonb),
    -- 13 a plain fault, the old eleven keys: the control that faults apply here at all
    ('af500000-0000-4000-9000-000000000013', 'af100000-0000-4000-9000-000000000001', 'report_fault',
      _fv_args('report_fault', 'af200000-0000-4000-9000-000000000001', null, null, 'null', null, 'Leaking', false))
  ) as p(id, usr, intent, args);

create temp table _fv_results (n int primary key, result jsonb) on commit drop;
grant all on _fv_results to public;

-- == The owner ===============================================================
select set_config('request.jwt.claims', '{"sub":"af100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int;
begin
  foreach n in array array[1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] loop
    insert into _fv_results values (n, public.apply_assistant_proposal(
      ('af500000-0000-4000-9000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'confirm',
      'af000000-0000-4000-9000-000000000001'));
  end loop;
  -- Confirming the draw again answers with the same record and page, and writes nothing.
  insert into _fv_results values (101, public.apply_assistant_proposal(
    'af500000-0000-4000-9000-000000000001', 'confirm', 'af000000-0000-4000-9000-000000000001'));
end $$;
reset role;

-- == The operator ============================================================
select set_config('request.jwt.claims', '{"sub":"af100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  insert into _fv_results values (2, public.apply_assistant_proposal(
    'af500000-0000-4000-9000-000000000002', 'confirm', 'af000000-0000-4000-9000-000000000001'));
  insert into _fv_results values (3, public.apply_assistant_proposal(
    'af500000-0000-4000-9000-000000000003', 'confirm', 'af000000-0000-4000-9000-000000000001'));
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r jsonb; d record; cnt int;
begin
  -- 1: applied as a fuel draw, with its meter and its usage log, by the owner.
  r := (select result from _fv_results f where f.n = 1);
  if not coalesce((r ->> 'ok')::boolean, false) or r ->> 'linkedRecordType' is distinct from 'fuel_issue' or r ->> 'href' is distinct from '/fuel' then
    raise exception 'owner draw not applied: %', r;
  end if;
  select * into d from public.fuel_issues where id = (r ->> 'linkedRecordId')::uuid;
  if d.id is null or d.litres is distinct from 80 or d.machine_id is distinct from 'af200000-0000-4000-9000-000000000002' or d.meter_reading is distinct from 52700
     or d.tank_id is distinct from 'af300000-0000-4000-9000-000000000001' or d.by_user is distinct from 'af100000-0000-4000-9000-000000000001'
     or d.date is distinct from current_date or d.cost_cents is not null then
    raise exception 'owner draw row wrong: %', row_to_json(d);
  end if;
  if not exists (select 1 from public.usage_logs where machine_id = 'af200000-0000-4000-9000-000000000002' and meter_reading = 52700) then
    raise exception 'the draw''s meter reading was not logged as usage';
  end if;
  -- 101: the retry replays the same record.
  r := (select result from _fv_results f where f.n = 101);
  if not coalesce((r ->> 'replayed')::boolean, false) or r ->> 'href' is distinct from '/fuel'
     or r ->> 'linkedRecordId' is distinct from (select result ->> 'linkedRecordId' from _fv_results f where f.n = 1) then
    raise exception 'retry did not replay the draw: %', r;
  end if;
  select count(*) into cnt from public.fuel_issues where litres = 80;
  if cnt <> 1 then raise exception 'the retry wrote another draw (% rows)', cnt; end if;

  -- 2: the operator's own tractor, dated today.
  r := (select result from _fv_results f where f.n = 2);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'operator draw refused: %', r; end if;
  if (select date from public.fuel_issues where id = (r ->> 'linkedRecordId')::uuid) is distinct from current_date then
    raise exception 'an undated draw was not dated today';
  end if;

  -- Refused, each for its own reason, and nothing written.
  if (select result ->> 'code' from _fv_results f where f.n = 3) is distinct from 'forbidden' then
    raise exception 'operator drew for a machine not assigned to them: %', (select result from _fv_results f where f.n = 3);
  end if;
  if (select result ->> 'code' from _fv_results f where f.n = 4) is distinct from 'invalid_proposal' then raise exception 'zero litres: %', (select result from _fv_results f where f.n = 4); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 5) is distinct from 'forbidden' then raise exception 'another farm''s tank: %', (select result from _fv_results f where f.n = 5); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 6) is distinct from 'invalid_proposal' then raise exception 'future date: %', (select result from _fv_results f where f.n = 6); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 7) is distinct from 'invalid_proposal' then raise exception 'meter on a meterless machine: %', (select result from _fv_results f where f.n = 7); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 10) is distinct from 'invalid_proposal' then raise exception 'fault with litres: %', (select result from _fv_results f where f.n = 10); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 11) is distinct from 'invalid_proposal' then raise exception 'fuel draft without fuel keys: %', (select result from _fv_results f where f.n = 11); end if;
  if (select result ->> 'code' from _fv_results f where f.n = 12) is distinct from 'invalid_proposal' then raise exception 'twelve keys: %', (select result from _fv_results f where f.n = 12); end if;
  select count(*) into cnt from public.fuel_issues where farm_id = 'af000000-0000-4000-9000-000000000001';
  if cnt <> 2 then raise exception 'refused proposals still wrote draws: % rows', cnt; end if;

  if not coalesce((select (result ->> 'ok')::boolean from _fv_results f where f.n = 13), false) then
    raise exception 'the control fault did not apply: %', (select result from _fv_results f where f.n = 13);
  end if;

  -- 8 and 9: readings in both draft forms still apply.
  if not coalesce((select (result ->> 'ok')::boolean from _fv_results f where f.n = 8), false)
     or (select result ->> 'linkedRecordType' from _fv_results f where f.n = 8) is distinct from 'meter_reading' then
    raise exception 'thirteen-key reading refused: %', (select result from _fv_results f where f.n = 8);
  end if;
  if not coalesce((select (result ->> 'ok')::boolean from _fv_results f where f.n = 9), false) then
    raise exception 'eleven-key reading refused: %', (select result from _fv_results f where f.n = 9);
  end if;
end $$;

rollback;
