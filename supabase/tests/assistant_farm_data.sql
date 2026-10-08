\set ON_ERROR_STOP on
-- The assistant's farm numbers: fuel per machine per month, consumption by the /fuel
-- interval method, and the cost ledger, each under the caller's own policies.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('ad000000-0000-4000-9000-000000000001', 'Assistant farm', 'complete', 'active'),
  ('ad000000-0000-4000-9000-000000000002', 'Assistant other farm', 'complete', 'active');
insert into auth.users (id, email) values
  ('ad100000-0000-4000-9000-000000000001', 'assistant.owner@example.test'),
  ('ad100000-0000-4000-9000-000000000002', 'assistant.operator@example.test'),
  ('ad100000-0000-4000-9000-000000000003', 'assistant.other@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('ad100000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'owner',    'Owner',    'assistant.owner@example.test'),
  ('ad100000-0000-4000-9000-000000000002', 'ad000000-0000-4000-9000-000000000001', 'operator', 'Operator', 'assistant.operator@example.test'),
  ('ad100000-0000-4000-9000-000000000003', 'ad000000-0000-4000-9000-000000000002', 'owner',    'Other',    'assistant.other@example.test');
insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('ad200000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'Red tractor', 'tractor', 'hours', 'active', 'ad100000-0000-4000-9000-000000000002'),
  ('ad200000-0000-4000-9000-000000000002', 'ad000000-0000-4000-9000-000000000001', 'White bakkie', 'bakkie', 'km', 'active', null),
  ('ad200000-0000-4000-9000-000000000003', 'ad000000-0000-4000-9000-000000000002', 'Other tractor', 'tractor', 'hours', 'active', null);
insert into public.fuel_tanks (id, farm_id, name) values
  ('ad300000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'Main tank'),
  ('ad300000-0000-4000-9000-000000000002', 'ad000000-0000-4000-9000-000000000002', 'Other tank');

-- Red tractor, September: meter 100 / 110 / 125 h, 50 / 60 / 75 L. Interval method:
-- (60 + 75) L over (10 + 15) h = 5.4 L/h. A deleted draw and a draw outside the period
-- must not count. White bakkie, August: 1000 -> 1500 km, 45 L over 500 km.
insert into public.fuel_issues (farm_id, tank_id, machine_id, date, litres, meter_reading, cost_cents, deleted_at) values
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', date '2026-09-02', 50, 100, 100000, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', date '2026-09-09', 60, 110, 120000, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', date '2026-09-16', 75, 125, 150000, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', date '2026-09-17', 999, 130, 999900, now()),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', date '2025-01-05', 888, 50, 888800, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000002', date '2026-08-10', 40, 1000, 80000, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000002', date '2026-08-20', 45, 1500, null, null),
  ('ad000000-0000-4000-9000-000000000001', 'ad300000-0000-4000-9000-000000000001', null,                                   date '2026-09-20', 20, null, 40000, null),
  ('ad000000-0000-4000-9000-000000000002', 'ad300000-0000-4000-9000-000000000002', 'ad200000-0000-4000-9000-000000000003', date '2026-09-05', 500, 10, 1000000, null);
insert into public.cost_entries (farm_id, machine_id, type, amount_cents, occurred_on, source_type, note) values
  ('ad000000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', 'parts', 250000, date '2026-09-12', 'manual', 'Filters'),
  ('ad000000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', 'parts', 777700, date '2024-01-01', 'manual', 'Too old for the period');

-- == The owner ===============================================================
select set_config('request.jwt.claims', '{"sub":"ad100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record; n int; c numeric;
begin
  -- By machine: one row per machine, month NULL.
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine')
   where machine_id = 'ad200000-0000-4000-9000-000000000001';
  if r.month is not null or r.litres <> 185 or r.cost_cents <> 370000 or r.draws <> 3 or r.priced_draws <> 3 then
    raise exception 'owner red tractor fuel wrong: %', row_to_json(r);
  end if;
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine')
   where machine_id = 'ad200000-0000-4000-9000-000000000002';
  if r.litres <> 85 or r.cost_cents <> 80000 or r.draws <> 2 or r.priced_draws <> 1 then
    raise exception 'owner bakkie fuel wrong (one draw has no price): %', row_to_json(r);
  end if;
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine') where machine_id is null;
  if r.litres <> 20 then raise exception 'farm-level draw missing: %', row_to_json(r); end if;
  select count(*) into n from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine');
  if n <> 3 then raise exception 'owner fuel by machine has % rows, expected 3', n; end if;

  -- By month: the farm total per month.
  select count(*) into n from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'month');
  if n <> 2 then raise exception 'owner fuel by month has % rows, expected 2', n; end if;
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'month') where month = date '2026-09-01';
  if r.machine_id is not null or r.litres <> 205 or r.cost_cents <> 410000 or r.draws <> 4 then
    raise exception 'September farm total wrong: %', row_to_json(r);
  end if;
  -- By month for one machine.
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'month', 'ad200000-0000-4000-9000-000000000002');
  if r.machine_id <> 'ad200000-0000-4000-9000-000000000002' or r.month <> date '2026-08-01' or r.litres <> 85 then
    raise exception 'bakkie by month wrong: %', row_to_json(r);
  end if;
  begin
    perform * from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'week');
    raise exception 'an unknown grouping was accepted';
  exception when invalid_parameter_value then null; end;

  -- Consumption, the /fuel interval method.
  select * into r from public.assistant_fuel_consumption('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30')
   where machine_id = 'ad200000-0000-4000-9000-000000000001';
  if r.interval_litres <> 135 or r.meter_span <> 25 or r.intervals <> 2 then
    raise exception 'red tractor consumption wrong: %', row_to_json(r);
  end if;
  select * into r from public.assistant_fuel_consumption('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30')
   where machine_id = 'ad200000-0000-4000-9000-000000000002';
  if r.interval_litres <> 45 or r.meter_span <> 500 or r.intervals <> 1 then
    raise exception 'bakkie consumption wrong: %', row_to_json(r);
  end if;
  select count(*) into n from public.assistant_fuel_consumption('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'ad200000-0000-4000-9000-000000000002');
  if n <> 1 then raise exception 'consumption for one machine returned % rows', n; end if;

  -- The cost ledger: per machine with a column per type, exactly as a direct read of it.
  select coalesce(sum(total_cents), 0) into c from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine');
  if c <> (select coalesce(sum(amount_cents), 0) from public.cost_entries
            where farm_id = 'ad000000-0000-4000-9000-000000000001' and deleted_at is null
              and occurred_on between date '2026-08-01' and date '2026-09-30') then
    raise exception 'cost summary disagrees with the ledger';
  end if;
  select * into r from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine')
   where machine_id = 'ad200000-0000-4000-9000-000000000001';
  if r.parts_cents <> 250000 or r.total_cents <> r.fuel_cents + r.parts_cents + r.labour_cents + r.invoice_cents
       + r.other_cents + r.purchase_cents + r.finance_cents then
    raise exception 'red tractor cost columns wrong: %', row_to_json(r);
  end if;
  if exists (select 1 from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine') where parts_cents = 777700) then
    raise exception 'an entry outside the period was counted';
  end if;
  select coalesce(sum(total_cents), 0) into c from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'month');
  if c <> (select coalesce(sum(total_cents), 0) from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine')) then
    raise exception 'by month and by machine disagree';
  end if;

  -- The other farm never appears, even when asked for by id.
  if exists (select 1 from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000002', date '2026-08-01', date '2026-09-30', 'machine')) then
    raise exception 'the owner read the other farm fuel';
  end if;

  -- Periods are bounded.
  begin
    perform * from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-09-30', date '2026-08-01', 'machine');
    raise exception 'a backwards period was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform * from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2020-01-01', date '2026-09-30', 'machine');
    raise exception 'a period of almost seven years was accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;

-- == The operator: their machine, litres only, no money ======================
select set_config('request.jwt.claims', '{"sub":"ad100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record; n int;
begin
  select count(*) into n from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine');
  if n <> 1 then raise exception 'operator sees % fuel rows, expected only their tractor', n; end if;
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine');
  if r.machine_id <> 'ad200000-0000-4000-9000-000000000001' or r.litres <> 185
     or r.cost_cents is not null or r.priced_draws <> 0 then
    raise exception 'operator fuel row wrong (money must be hidden): %', row_to_json(r);
  end if;
  select * into r from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'month');
  if r.litres <> 185 or r.cost_cents is not null then
    raise exception 'operator monthly total must be their own draws, without money: %', row_to_json(r);
  end if;
  select count(*) into n from public.assistant_fuel_consumption('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30');
  if n <> 1 then raise exception 'operator consumption has % rows, expected 1', n; end if;
  if exists (select 1 from public.assistant_cost_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine')) then
    raise exception 'an operator read the cost ledger';
  end if;
end $$;
reset role;

-- == Anonymous: no ===========================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform * from public.assistant_fuel_summary('ad000000-0000-4000-9000-000000000001', date '2026-08-01', date '2026-09-30', 'machine');
    raise exception 'anonymous fuel summary';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
