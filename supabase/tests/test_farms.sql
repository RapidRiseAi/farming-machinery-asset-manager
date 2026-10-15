\set ON_ERROR_STOP on
-- Test farms stay out of Rapid Rise's totals (20261014110000): a new farm is a customer, only
-- Rapid Rise can mark a test farm (a farm marking itself would drop out of the totals), and
-- the AI month leaves test farms out of what was billed but keeps their cost.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

do $bootstrap$
begin
  if to_regprocedure('public._t_login(uuid)') is null then
    execute $f$
      create function public._t_login(uid uuid) returns void language sql as $b$
        select set_config('request.jwt.claims',
                          json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, false);
      $b$;
    $f$;
    execute 'grant execute on function public._t_login(uuid) to public';
  end if;
end $bootstrap$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('d1000000-0000-4000-9000-000000000001', 'Customer farm', 'complete', 'active', 'monthly'),
  ('d1000000-0000-4000-9000-000000000002', 'Demo farm',     'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('d1100000-0000-4000-9000-000000000001', 'testfarm.owner@example.test'),
  ('d1100000-0000-4000-9000-000000000002', 'testfarm.admin@example.test'),
  ('d1100000-0000-4000-9000-000000000003', 'testfarm.customer@example.test');
-- The demo farm's owner joins after Rapid Rise marks it (20261014120000: a farm cannot
-- change sides with people of the other kind on it).
insert into public.users (id, farm_id, role, name, email) values
  ('d1100000-0000-4000-9000-000000000002', null,                                   'rr_admin', 'Admin',          'testfarm.admin@example.test'),
  ('d1100000-0000-4000-9000-000000000003', 'd1000000-0000-4000-9000-000000000001', 'owner',    'Customer owner', 'testfarm.customer@example.test');

-- == A new farm is a customer ======================================================
do $$ begin
  if (select is_test from public.farms where id = 'd1000000-0000-4000-9000-000000000002') then
    raise exception 'default: a new farm started as a test farm';
  end if;
end $$;

-- == An owner cannot mark their own farm as a test farm =============================
select public._t_login('d1100000-0000-4000-9000-000000000003');
set local role authenticated;
update public.farms set is_test = true where id = 'd1000000-0000-4000-9000-000000000001';
reset role;
do $$ begin
  if (select is_test from public.farms where id = 'd1000000-0000-4000-9000-000000000001') then
    raise exception 'owner: marked their own farm as a test farm, dropping it out of the totals';
  end if;
end $$;

-- == Rapid Rise can ================================================================
select public._t_login('d1100000-0000-4000-9000-000000000002');
set local role authenticated;
update public.farms set is_test = true where id = 'd1000000-0000-4000-9000-000000000002';
reset role;
do $$ begin
  if not (select is_test from public.farms where id = 'd1000000-0000-4000-9000-000000000002') then
    raise exception 'admin: Rapid Rise could not mark a test farm';
  end if;
end $$;

insert into public.users (id, farm_id, role, name, email) values
  ('d1100000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000002', 'owner', 'Demo owner', 'testfarm.owner@example.test');

-- == The AI month: billed leaves the test farm out, cost keeps it ==================
-- Fixture rows only; the reservations they point at are not under test.
set local session_replication_role = replica;
insert into public.ai_usage (farm_id, user_id, month, feature, provider, model, credential, measured,
                             provider_cost_usd, usd_zar, margin_bps, billed_cents, outcome, reservation_id) values
  ('d1000000-0000-4000-9000-000000000001', 'd1100000-0000-4000-9000-000000000003', date '2026-10-01',
   'ai_answer', 'ai_gateway', 'openai/test-model', 'platform', 'gateway', 0.5,  18, 3000, 1000, 'ok', gen_random_uuid()),
  ('d1000000-0000-4000-9000-000000000002', 'd1100000-0000-4000-9000-000000000001', date '2026-10-01',
   'ai_answer', 'ai_gateway', 'openai/test-model', 'platform', 'gateway', 0.25, 18, 3000, 700,  'ok', gen_random_uuid());
set local session_replication_role = origin;

select public._t_login('d1100000-0000-4000-9000-000000000002');
set local role authenticated;
do $$
declare
  s jsonb := public.ai_admin_month(date '2026-10-01');
  v_test_rows int;
begin
  if (s ->> 'billed_cents')::numeric is distinct from 1000 then
    raise exception 'billed total %: expected 1000, the test farm''s 700 left out', s ->> 'billed_cents';
  end if;
  if (s ->> 'platform_cost_usd')::numeric is distinct from 0.75 then
    raise exception 'cost total %: expected 0.75, the test farm''s cost kept', s ->> 'platform_cost_usd';
  end if;
  select count(*) into v_test_rows from jsonb_array_elements(s -> 'farms') e where (e ->> 'is_test')::boolean;
  if v_test_rows <> 1 or jsonb_array_length(s -> 'farms') <> 2 then
    raise exception 'farms list: % rows with % marked test, expected 2 with 1', jsonb_array_length(s -> 'farms'), v_test_rows;
  end if;
end $$;
reset role;

rollback;
