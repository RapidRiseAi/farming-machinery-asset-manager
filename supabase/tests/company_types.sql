\set ON_ERROR_STOP on
-- What kind of business an account is: who may change it, and what it may be (20261107090000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('e5000000-0000-4000-9000-000000000001', 'Type farm', 'complete', 'active', 'monthly'),
  ('e5000000-0000-4000-9000-000000000002', 'Other farm', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('e5100000-0000-4000-9000-000000000001', 'owner@type.test'),
  ('e5100000-0000-4000-9000-000000000002', 'driver@type.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('e5100000-0000-4000-9000-000000000001', 'e5000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'owner@type.test', true),
  ('e5100000-0000-4000-9000-000000000002', 'e5000000-0000-4000-9000-000000000001', 'operator', 'Driver', 'driver@type.test', true);

do $t$
begin
  if (select company_type from public.farms where id = 'e5000000-0000-4000-9000-000000000001') <> 'other' then
    raise exception 'an account with no answer must read as universal';
  end if;
  begin
    update public.farms set company_type = 'spaceship' where id = 'e5000000-0000-4000-9000-000000000001';
    raise exception 'an unknown company type was accepted';
  exception when check_violation then null;
  end;
end $t$;

-- The new vehicle, licence and credential types exist and can be used.
insert into public.machines (farm_id, name, type) values
  ('e5000000-0000-4000-9000-000000000001', 'Horse', 'truck_tractor'),
  ('e5000000-0000-4000-9000-000000000001', 'Viewer', 'game_viewer');

-- The owner may change their own, and nothing else on the row.
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"e5100000-0000-4000-9000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select public.set_company_type('e5000000-0000-4000-9000-000000000001', 'goods_transport');
do $t$
begin
  if (select company_type from public.farms where id = 'e5000000-0000-4000-9000-000000000001') <> 'goods_transport' then
    raise exception 'the owner could not set their company type';
  end if;
  begin
    perform public.set_company_type('e5000000-0000-4000-9000-000000000002', 'farm');
    raise exception 'an owner changed somebody else''s company type';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- A driver may not.
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"e5100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $t$
begin
  begin
    perform public.set_company_type('e5000000-0000-4000-9000-000000000001', 'farm');
    raise exception 'a driver changed the company type';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

rollback;
