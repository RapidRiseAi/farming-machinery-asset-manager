\set ON_ERROR_STOP on
-- Rapid Rise's powers need the second factor (20261014100000): the same Rapid Rise account,
-- with the code given (aal2) and with only the password (aal1), against a farm owner whose
-- access must not change either way.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('c0000000-0000-4000-9000-000000000001', 'Two-step farm', 'complete', 'active');
insert into auth.users (id, email) values
  ('c0100000-0000-4000-9000-000000000001', 'twostep.owner@example.test'),
  ('c0100000-0000-4000-9000-000000000002', 'twostep.admin@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('c0100000-0000-4000-9000-000000000001', 'c0000000-0000-4000-9000-000000000001', 'owner',    'Owner', 'twostep.owner@example.test'),
  ('c0100000-0000-4000-9000-000000000002', null,                                   'rr_admin', 'Admin', 'twostep.admin@example.test');
insert into public.machines (id, farm_id, name, type, meter_type, status) values
  ('c0200000-0000-4000-9000-000000000001', 'c0000000-0000-4000-9000-000000000001', 'Two-step tractor', 'tractor', 'hours', 'active');
insert into public.job_cards (id, farm_id, machine_id, type, status) values
  ('c0300000-0000-4000-9000-000000000001', 'c0000000-0000-4000-9000-000000000001', 'c0200000-0000-4000-9000-000000000001', 'repair', 'open');

-- == Rapid Rise with only the password: no powers at all =========================
select set_config('request.jwt.claims', '{"sub":"c0100000-0000-4000-9000-000000000002","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
do $$
declare n int;
begin
  if app.is_rr_admin() then raise exception 'aal1: is_rr_admin() was true without the code'; end if;
  if app.current_app_role() is not null then raise exception 'aal1: current_app_role() gave %', app.current_app_role(); end if;
  if app.effective_farm_role('c0100000-0000-4000-9000-000000000002', 'c0000000-0000-4000-9000-000000000001') is not null then
    raise exception 'aal1: effective_farm_role() gave a role on a farm';
  end if;
  if app.has_farm_access('c0000000-0000-4000-9000-000000000001') then raise exception 'aal1: has_farm_access() was true'; end if;
  if app.job_card_worker('c0100000-0000-4000-9000-000000000002', 'c0300000-0000-4000-9000-000000000001') then
    raise exception 'aal1: job_card_worker() let Rapid Rise work a farm''s job card';
  end if;
  select count(*) into n from public.machines where farm_id = 'c0000000-0000-4000-9000-000000000001';
  if n <> 0 then raise exception 'aal1: Rapid Rise read % of a farm''s machines without the code', n; end if;
  select count(*) into n from public.farms where id = 'c0000000-0000-4000-9000-000000000001';
  if n <> 0 then raise exception 'aal1: Rapid Rise read a farm row without the code'; end if;
  -- Still able to read its own profile, which the code setup screen needs.
  select count(*) into n from public.users where id = 'c0100000-0000-4000-9000-000000000002';
  if n <> 1 then raise exception 'aal1: Rapid Rise could not read its own profile (% rows)', n; end if;
end $$;
reset role;

-- No aal claim at all counts as aal1.
select set_config('request.jwt.claims', '{"sub":"c0100000-0000-4000-9000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if app.is_rr_admin() then raise exception 'no aal claim: is_rr_admin() was true'; end if;
end $$;
reset role;

-- == Rapid Rise with the code given: everything, as before =======================
select set_config('request.jwt.claims', '{"sub":"c0100000-0000-4000-9000-000000000002","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
do $$
declare n int;
begin
  if not app.is_rr_admin() then raise exception 'aal2: is_rr_admin() was false with the code'; end if;
  if app.current_app_role() is distinct from 'rr_admin' then raise exception 'aal2: current_app_role() gave %', app.current_app_role(); end if;
  if app.effective_farm_role('c0100000-0000-4000-9000-000000000002', 'c0000000-0000-4000-9000-000000000001') is distinct from 'rr_admin' then
    raise exception 'aal2: effective_farm_role() did not give rr_admin';
  end if;
  if not app.job_card_worker('c0100000-0000-4000-9000-000000000002', 'c0300000-0000-4000-9000-000000000001') then
    raise exception 'aal2: job_card_worker() refused Rapid Rise';
  end if;
  select count(*) into n from public.machines where farm_id = 'c0000000-0000-4000-9000-000000000001';
  if n <> 1 then raise exception 'aal2: Rapid Rise read % machines, expected 1', n; end if;
end $$;
reset role;

-- == A farm owner is judged as before, code or no code ===========================
select set_config('request.jwt.claims', '{"sub":"c0100000-0000-4000-9000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
do $$
declare n int;
begin
  if app.current_app_role() is distinct from 'owner' then raise exception 'owner aal1: role %', app.current_app_role(); end if;
  if app.effective_farm_role('c0100000-0000-4000-9000-000000000001', 'c0000000-0000-4000-9000-000000000001') is distinct from 'owner' then
    raise exception 'owner aal1: effective role changed';
  end if;
  select count(*) into n from public.machines where farm_id = 'c0000000-0000-4000-9000-000000000001';
  if n <> 1 then raise exception 'owner aal1: read % machines, expected 1', n; end if;
end $$;
reset role;

rollback;
