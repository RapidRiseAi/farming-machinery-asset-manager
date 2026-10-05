\set ON_ERROR_STOP on
-- public.fuel_tank_balances: every delivery and every draw, for anybody who can see the
-- tank, in litres only. The rows outnumber the old page caps (400 deliveries, 600
-- draws), and most draws are on a machine the operator cannot see.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('fb000000-0000-4000-9000-000000000001', 'Balance farm', 'professional', 'active'),
  ('fb000000-0000-4000-9000-000000000002', 'Balance other farm', 'professional', 'active');

insert into auth.users (id, email) values
  ('fb100000-0000-4000-9000-000000000001', 'balance.owner@example.test'),
  ('fb100000-0000-4000-9000-000000000002', 'balance.operator@example.test'),
  ('fb100000-0000-4000-9000-000000000003', 'balance.other@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('fb100000-0000-4000-9000-000000000001', 'fb000000-0000-4000-9000-000000000001', 'owner',    'Owner',    'balance.owner@example.test'),
  ('fb100000-0000-4000-9000-000000000002', 'fb000000-0000-4000-9000-000000000001', 'operator', 'Operator', 'balance.operator@example.test'),
  ('fb100000-0000-4000-9000-000000000003', 'fb000000-0000-4000-9000-000000000002', 'owner',    'Other',    'balance.other@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('fb200000-0000-4000-9000-000000000001', 'fb000000-0000-4000-9000-000000000001', 'Their tractor', 'tractor', 'hours', 'active', 'fb100000-0000-4000-9000-000000000002'),
  ('fb200000-0000-4000-9000-000000000002', 'fb000000-0000-4000-9000-000000000001', 'Not theirs',    'tractor', 'hours', 'active', null);

insert into public.fuel_tanks (id, farm_id, name, capacity_l) values
  ('fb300000-0000-4000-9000-000000000001', 'fb000000-0000-4000-9000-000000000001', 'A main tank',  10000),
  ('fb300000-0000-4000-9000-000000000002', 'fb000000-0000-4000-9000-000000000001', 'B empty tank', 2000),
  ('fb300000-0000-4000-9000-000000000003', 'fb000000-0000-4000-9000-000000000002', 'Other tank',   5000);

-- 450 deliveries of 10 L before the dip, one of 1000 L after it, one deleted.
insert into public.fuel_deliveries (farm_id, tank_id, date, litres)
select 'fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', date '2026-01-01', 10
  from generate_series(1, 450);
insert into public.fuel_deliveries (farm_id, tank_id, date, litres, deleted_at) values
  ('fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', date '2026-03-01', 1000, null),
  ('fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', date '2026-01-02', 777, now());
-- 650 draws of 2 L: 50 on the operator's tractor, 550 on another, 50 on no machine; one deleted.
insert into public.fuel_issues (farm_id, tank_id, machine_id, date, litres)
select 'fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001',
       case when n <= 50 then 'fb200000-0000-4000-9000-000000000001'::uuid
            when n <= 600 then 'fb200000-0000-4000-9000-000000000002'::uuid
            else null end,
       date '2026-01-15', 2
  from generate_series(1, 650) n;
insert into public.fuel_issues (farm_id, tank_id, machine_id, date, litres, deleted_at) values
  ('fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', null, date '2026-01-16', 555, now());
-- Two dips; the later one is the one shown. Book on 1 Feb: 4500 - 1300 = 3200.
insert into public.fuel_dips (farm_id, tank_id, dipped_on, litres) values
  ('fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', date '2026-01-10', 4400),
  ('fb000000-0000-4000-9000-000000000001', 'fb300000-0000-4000-9000-000000000001', date '2026-02-01', 3100);
insert into public.fuel_deliveries (farm_id, tank_id, date, litres) values
  ('fb000000-0000-4000-9000-000000000002', 'fb300000-0000-4000-9000-000000000003', date '2026-01-01', 900);

-- == Owner and operator see the same, true, numbers ==========================
select set_config('request.jwt.claims', '{"sub":"fb100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record; n int;
begin
  select count(*) into n from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001');
  if n <> 2 then raise exception 'owner sees % tanks, expected 2', n; end if;
  select * into r from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001')
   where tank_id = 'fb300000-0000-4000-9000-000000000001';
  if r.delivered_litres <> 5500 or r.issued_litres <> 1300 or r.balance_litres <> 4200 then
    raise exception 'owner main tank totals wrong: %', row_to_json(r);
  end if;
  if r.dipped_on <> date '2026-02-01' or r.dip_litres <> 3100 or r.book_at_dip_litres <> 3200 then
    raise exception 'owner main tank dip wrong: %', row_to_json(r);
  end if;
  select * into r from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001')
   where tank_id = 'fb300000-0000-4000-9000-000000000002';
  if r.delivered_litres <> 0 or r.issued_litres <> 0 or r.balance_litres <> 0
     or r.dipped_on is not null or r.dip_litres is not null or r.book_at_dip_litres is not null then
    raise exception 'owner empty tank wrong: %', row_to_json(r);
  end if;
  -- No farm named: every tank this person can see, and only those.
  select count(*) into n from public.fuel_tank_balances(null);
  if n <> 2 then raise exception 'owner sees % tanks across farms, expected 2', n; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"fb100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r record; n int;
begin
  select count(*) into n from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001');
  if n <> 2 then raise exception 'operator sees % tanks, expected 2', n; end if;
  select * into r from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001')
   where tank_id = 'fb300000-0000-4000-9000-000000000001';
  if r.delivered_litres <> 5500 or r.issued_litres <> 1300 or r.balance_litres <> 4200 then
    raise exception 'operator main tank totals wrong: %', row_to_json(r);
  end if;
  if r.dipped_on <> date '2026-02-01' or r.dip_litres <> 3100 or r.book_at_dip_litres <> 3200 then
    raise exception 'operator main tank dip wrong: %', row_to_json(r);
  end if;
  select * into r from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001')
   where tank_id = 'fb300000-0000-4000-9000-000000000002';
  if r.delivered_litres <> 0 or r.issued_litres <> 0 or r.balance_litres <> 0
     or r.dipped_on is not null or r.dip_litres is not null or r.book_at_dip_litres is not null then
    raise exception 'operator empty tank wrong: %', row_to_json(r);
  end if;
  -- No farm named: every tank this person can see, and only those.
  select count(*) into n from public.fuel_tank_balances(null);
  if n <> 2 then raise exception 'operator sees % tanks across farms, expected 2', n; end if;
end $$;
reset role;

-- The operator's own view of the draws IS filtered, which is why the page could not sum it.
select set_config('request.jwt.claims', '{"sub":"fb100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if (select coalesce(sum(litres), 0) from public.fuel_issues) <> 100 then
    raise exception 'the operator fixture no longer filters draws, so this suite proves nothing';
  end if;
end $$;
reset role;

-- == Another farm sees nothing; nobody signed in may not call it =============
select set_config('request.jwt.claims', '{"sub":"fb100000-0000-4000-9000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if exists (select 1 from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001')) then
    raise exception 'another farm read this farm''s tank balances';
  end if;
  if (select count(*) from public.fuel_tank_balances(null)) <> 1 then
    raise exception 'the other farm should see its own one tank';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform * from public.fuel_tank_balances('fb000000-0000-4000-9000-000000000001');
    raise exception 'anonymous tank balances';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
