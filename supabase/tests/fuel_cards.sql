\set ON_ERROR_STOP on
-- Fuel card fills: who sees them, the cost they book, and importing twice (20261107140000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('ea000000-0000-4000-9000-000000000001', 'Cards', 'complete', 'active', 'monthly'),
  ('ea000000-0000-4000-9000-000000000002', 'Other', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('ea100000-0000-4000-9000-000000000001', 'owner@cards.test'),
  ('ea100000-0000-4000-9000-000000000002', 'driver@cards.test'),
  ('ea100000-0000-4000-9000-000000000003', 'other@cards.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('ea100000-0000-4000-9000-000000000001', 'ea000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'owner@cards.test', true),
  ('ea100000-0000-4000-9000-000000000002', 'ea000000-0000-4000-9000-000000000001', 'operator', 'Driver', 'driver@cards.test', true),
  ('ea100000-0000-4000-9000-000000000003', 'ea000000-0000-4000-9000-000000000002', 'owner', 'Other', 'other@cards.test', true);
insert into public.machines (id, farm_id, name, type, reg_no, fuel_tank_litres) values
  ('ea200000-0000-4000-9000-000000000001', 'ea000000-0000-4000-9000-000000000001', 'Truck', 'truck', 'ABC 123 GP', 400);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

select pg_temp.as_user('ea100000-0000-4000-9000-000000000001');
set local role authenticated;
insert into public.fuel_card_statements (id, farm_id, file_name) values
  ('ea300000-0000-4000-9000-000000000001', 'ea000000-0000-4000-9000-000000000001', 'october.csv');
insert into public.fuel_card_transactions (farm_id, statement_id, occurred_at, card_ref, vehicle_ref, machine_id, litres, amount_cents) values
  ('ea000000-0000-4000-9000-000000000001', 'ea300000-0000-4000-9000-000000000001', '2026-10-05T08:00:00+02', '1234', 'ABC123GP',
   'ea200000-0000-4000-9000-000000000001', 300, 660000),
  ('ea000000-0000-4000-9000-000000000001', 'ea300000-0000-4000-9000-000000000001', '2026-10-06T08:00:00+02', '1234', 'ZZZ999GP',
   null, 50, 110000);

do $t$ begin
  -- Importing the same fill again is refused by the table itself.
  begin
    insert into public.fuel_card_transactions (farm_id, statement_id, occurred_at, card_ref, litres, amount_cents) values
      ('ea000000-0000-4000-9000-000000000001', 'ea300000-0000-4000-9000-000000000001', '2026-10-05T08:00:00+02', '1234', 300, 660000);
    raise exception 'the same fill was imported twice';
  exception when unique_violation then null;
  end;
end $t$;
reset role;

do $t$ begin
  if (select count(*) from public.cost_entries where source_type = 'fuel_card') <> 1 then
    raise exception 'only a matched fill should book a cost';
  end if;
  if (select amount_cents from public.cost_entries where source_type = 'fuel_card') <> 660000
     or (select type::text from public.cost_entries where source_type = 'fuel_card') <> 'fuel'
     or (select occurred_on from public.cost_entries where source_type = 'fuel_card') <> date '2026-10-05' then
    raise exception 'the cost is wrong';
  end if;
end $t$;

-- A driver sees no card spending, and another business nothing.
select pg_temp.as_user('ea100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.fuel_card_transactions) <> 0 then raise exception 'a driver can see card spending'; end if;
end $t$;
reset role;
select pg_temp.as_user('ea100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.fuel_card_transactions) <> 0 then raise exception 'another business can see these fills'; end if;
  begin
    insert into public.fuel_card_statements (farm_id) values ('ea000000-0000-4000-9000-000000000001');
    raise exception 'another business added a statement here';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

rollback;
