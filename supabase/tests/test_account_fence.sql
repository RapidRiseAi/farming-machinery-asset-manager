\set ON_ERROR_STOP on
-- Test accounts walled off from real ones (20261014120000): a test account never holds
-- Rapid Rise's powers, test and real never mix on any row that ties them together, only
-- Rapid Rise moves a mark, and test farms keep to the trial AI amount and to test inboxes.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create function pg_temp.login(uid uuid, aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
$$;

-- One real and one test of everything.
insert into public.farms (id, name, plan, status, billing_period, is_test) values
  ('e1000000-0000-4000-9000-000000000001', 'Real farm', 'complete', 'active', 'monthly', false),
  ('e1000000-0000-4000-9000-000000000002', 'Test farm', 'complete', 'active', 'monthly', true);
insert into public.workshops (id, name, is_test) values
  ('e2000000-0000-4000-9000-000000000001', 'Real workshop', false),
  ('e2000000-0000-4000-9000-000000000002', 'Test workshop', true);
insert into auth.users (id, email) values
  ('e3000000-0000-4000-9000-000000000001', 'real.owner@farm.co.za'),
  ('e3000000-0000-4000-9000-000000000002', 'test.owner@fleetwise.test'),
  ('e3000000-0000-4000-9000-000000000003', 'admin@rapidrise.co.za'),
  ('e3000000-0000-4000-9000-000000000004', 'test.admin@fleetwise.test'),
  ('e3000000-0000-4000-9000-000000000005', 'real.fitter@workshop.co.za'),
  ('e3000000-0000-4000-9000-000000000006', 'test.fitter@fleetwise.test'),
  ('e3000000-0000-4000-9000-000000000007', 'new.person@farm.co.za'),
  ('e3000000-0000-4000-9000-000000000008', 'new.tester@fleetwise.test');
insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('e3000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000001', null, 'owner',    'Real owner',  'real.owner@farm.co.za'),
  ('e3000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000002', null, 'owner',    'Test owner',  'test.owner@fleetwise.test'),
  ('e3000000-0000-4000-9000-000000000003', null, null,                                   'rr_admin', 'Real admin',  'admin@rapidrise.co.za'),
  ('e3000000-0000-4000-9000-000000000005', null, 'e2000000-0000-4000-9000-000000000001', 'workshop', 'Real fitter', 'real.fitter@workshop.co.za'),
  ('e3000000-0000-4000-9000-000000000006', null, 'e2000000-0000-4000-9000-000000000002', 'workshop', 'Test fitter', 'test.fitter@fleetwise.test');
-- An account with no farm or workshop keeps the mark it is given: the test admin.
insert into public.users (id, farm_id, workshop_id, role, name, email, is_test) values
  ('e3000000-0000-4000-9000-000000000004', null, null, 'rr_admin', 'Test admin', 'test.admin@fleetwise.test', true);
insert into public.machines (id, farm_id, name, type, meter_type, status) values
  ('e4000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000001', 'Real tractor', 'tractor', 'hours', 'active'),
  ('e4000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000002', 'Test tractor', 'tractor', 'hours', 'active');

-- == A new account takes the mark of where it is created ==========================
do $$ begin
  if not (select is_test from public.users where id = 'e3000000-0000-4000-9000-000000000002') then
    raise exception 'inherit: an owner created in a test farm is not a test account';
  end if;
  if not (select is_test from public.users where id = 'e3000000-0000-4000-9000-000000000006') then
    raise exception 'inherit: a fitter created in a test workshop is not a test account';
  end if;
  if (select is_test from public.users where id = 'e3000000-0000-4000-9000-000000000001') then
    raise exception 'inherit: an owner created in a real farm became a test account';
  end if;
end $$;

-- == Rapid Rise's powers: the real admin with the code, never a test admin =========
select pg_temp.login('e3000000-0000-4000-9000-000000000003');
set local role authenticated;
do $$
declare n int;
begin
  if not app.is_rr_admin() then raise exception 'real admin, aal2: not Rapid Rise'; end if;
  if not public.session_is_rapid_rise() then raise exception 'real admin, aal2: session_is_rapid_rise() false'; end if;
  select count(*) into n from public.farms where id in ('e1000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000002');
  if n <> 2 then raise exception 'real admin, aal2: saw % of the two farms', n; end if;
end $$;
reset role;

select pg_temp.login('e3000000-0000-4000-9000-000000000003', 'aal1');
set local role authenticated;
do $$ begin
  if app.is_rr_admin() or public.session_is_rapid_rise() then raise exception 'real admin, aal1: Rapid Rise without the code'; end if;
end $$;
reset role;

select pg_temp.login('e3000000-0000-4000-9000-000000000004');
set local role authenticated;
do $$
declare n int;
begin
  if app.is_rr_admin() then raise exception 'test admin, aal2: is_rr_admin() true'; end if;
  if public.session_is_rapid_rise() then raise exception 'test admin, aal2: session_is_rapid_rise() true'; end if;
  if app.current_app_role() is not null then raise exception 'test admin: current_app_role() gave %', app.current_app_role(); end if;
  if app.effective_farm_role('e3000000-0000-4000-9000-000000000004', 'e1000000-0000-4000-9000-000000000001') is not null then
    raise exception 'test admin: a role on a real farm';
  end if;
  select count(*) into n from public.farms;
  if n <> 0 then raise exception 'test admin: saw % farms', n; end if;
  select count(*) into n from public.machines;
  if n <> 0 then raise exception 'test admin: saw % machines', n; end if;
end $$;
reset role;

-- == Only Rapid Rise moves a mark ===================================================
select pg_temp.login('e3000000-0000-4000-9000-000000000002');
set local role authenticated;
do $$ begin
  begin
    update public.users set is_test = false where id = 'e3000000-0000-4000-9000-000000000002';
    raise exception 'test owner unmarked themselves';
  exception when insufficient_privilege then
    if sqlerrm not like 'Only Rapid Rise can mark%' then raise; end if;
  end;
end $$;
reset role;

select pg_temp.login('e3000000-0000-4000-9000-000000000006');
set local role authenticated;
do $$ begin
  begin
    update public.workshops set is_test = false where id = 'e2000000-0000-4000-9000-000000000002';
    if (select is_test from public.workshops where id = 'e2000000-0000-4000-9000-000000000002') is not true then
      raise exception 'test fitter unmarked their workshop';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select pg_temp.login('e3000000-0000-4000-9000-000000000004');
set local role authenticated;
do $$ begin
  begin
    update public.users set is_test = false where id = 'e3000000-0000-4000-9000-000000000004';
    raise exception 'test admin unmarked themselves, which would hand back Rapid Rise''s powers';
  exception when insufficient_privilege then
    if sqlerrm not like 'Only Rapid Rise can mark%' then raise; end if;
  end;
end $$;
reset role;

-- == Test and real never mix: people ================================================
-- As the server or SQL: no signed-in user, so only the fence can refuse.
select set_config('request.jwt.claims', '', true);
do $$ begin
  -- A new account in a test farm is a test account, whatever the insert said.
  insert into public.users (id, farm_id, role, name, email, is_test) values
    ('e3000000-0000-4000-9000-000000000008', 'e1000000-0000-4000-9000-000000000002', 'operator', 'New tester', 'new.tester@fleetwise.test', false);
  if not (select is_test from public.users where id = 'e3000000-0000-4000-9000-000000000008') then
    raise exception 'inherit: an account inserted into a test farm as real stayed real';
  end if;
  -- Even the server cannot move a test account into a real farm, or a real one into a test farm.
  begin
    update public.users set farm_id = 'e1000000-0000-4000-9000-000000000001' where id = 'e3000000-0000-4000-9000-000000000002';
    raise exception 'a test account joined a real farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%test account cannot join a real farm%' then raise; end if;
  end;
  begin
    update public.users set farm_id = 'e1000000-0000-4000-9000-000000000002' where id = 'e3000000-0000-4000-9000-000000000001';
    raise exception 'a real account joined a test farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%real account cannot join a test farm%' then raise; end if;
  end;
  begin
    update public.users set workshop_id = 'e2000000-0000-4000-9000-000000000001', role = 'workshop', farm_id = null
     where id = 'e3000000-0000-4000-9000-000000000006';
    raise exception 'a test fitter joined a real workshop';
  exception when insufficient_privilege then
    if sqlerrm not like '%test account cannot join a real workshop%' then raise; end if;
  end;
  begin
    insert into public.user_farm_memberships (user_id, farm_id, role, active) values
      ('e3000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000001', 'manager', true);
    raise exception 'a test account got a membership on a real farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.user_farm_memberships (user_id, farm_id, role, active) values
      ('e3000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000002', 'manager', true);
    raise exception 'a real account got a membership on a test farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.user_permission_grants (user_id, farm_id, permission) values
      ('e3000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000001', 'manage_partners');
    raise exception 'a test account got a permission on a real farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  -- Same kind is fine.
  insert into public.user_farm_memberships (user_id, farm_id, role, active) values
    ('e3000000-0000-4000-9000-000000000008', 'e1000000-0000-4000-9000-000000000002', 'manager', true);
end $$;

-- == Test and real never mix: workshops =============================================
do $$ begin
  begin
    insert into public.workshop_links (workshop_id, farm_id, status) values
      ('e2000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000001', 'pending');
    raise exception 'a test workshop asked to link with a real farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.workshop_links (workshop_id, farm_id, status) values
      ('e2000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000002', 'active');
    raise exception 'a real workshop linked with a test farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  insert into public.workshop_links (workshop_id, farm_id, status) values
    ('e2000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000001', 'active'),
    ('e2000000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-000000000002', 'active');
  begin
    update public.workshop_links set workshop_id = 'e2000000-0000-4000-9000-000000000002'
     where farm_id = 'e1000000-0000-4000-9000-000000000001';
    raise exception 'a real farm''s link was repointed at a test workshop';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.partners (farm_id, name, workshop_id) values
      ('e1000000-0000-4000-9000-000000000001', 'Test workshop', 'e2000000-0000-4000-9000-000000000002');
    raise exception 'a real farm listed a test workshop as a partner';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.partner_clients (workshop_id, name, farm_id) values
      ('e2000000-0000-4000-9000-000000000002', 'Real farm', 'e1000000-0000-4000-9000-000000000001');
    raise exception 'a test workshop listed a real farm as a client';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.job_cards (farm_id, machine_id, type, status, workshop_id) values
      ('e1000000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'repair', 'open', 'e2000000-0000-4000-9000-000000000002');
    raise exception 'a real farm''s job card went to a test workshop';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  begin
    insert into public.work_requests (farm_id, machine_id, workshop_id, title) values
      ('e1000000-0000-4000-9000-000000000002', 'e4000000-0000-4000-9000-000000000002', 'e2000000-0000-4000-9000-000000000001', 'Fix');
    raise exception 'a test farm sent a work request to a real workshop';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
end $$;

-- Every table that ties a farm to a workshop is fenced, so a new one cannot slip past.
do $$
declare v text;
begin
  select string_agg(c.table_name, ', ' order by c.table_name) into v
    from (select c.table_name
            from information_schema.columns c
            join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
           where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name in ('farm_id', 'workshop_id')
           group by c.table_name having count(*) = 2) c
   where c.table_name <> 'users'
     and not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                      where g.tgrelid = ('public.' || c.table_name)::regclass and p.proname = 'fence_farm_workshop');
  if v is not null then raise exception 'tables tying a farm to a workshop without the fence: %', v; end if;
end $$;

-- == A farm changes sides only with everything on it, in a direct session ===========
select pg_temp.login('e3000000-0000-4000-9000-000000000003');
set local role authenticated;
do $$ begin
  begin
    update public.farms set is_test = false where id = 'e1000000-0000-4000-9000-000000000002';
    raise exception 'admin turned a test farm real with test people still on it';
  exception when check_violation then null;
  end;
end $$;
-- An API session cannot lift the fence, even when it asks.
select set_config('app.test_fence', 'off', true);
do $$ begin
  if app.test_fence_lifted() then raise exception 'an authenticated session lifted the fence'; end if;
end $$;
select set_config('app.test_fence', '', true);
reset role;

-- A direct session can, for this transaction, to move a farm and its people together.
select set_config('request.jwt.claims', '', true);
select set_config('app.test_fence', 'off', true);
update public.farms set is_test = false where id = 'e1000000-0000-4000-9000-000000000002';
update public.users set is_test = false where farm_id = 'e1000000-0000-4000-9000-000000000002';
update public.workshops set is_test = false where id = 'e2000000-0000-4000-9000-000000000002';
update public.users set is_test = false where workshop_id = 'e2000000-0000-4000-9000-000000000002';
update public.farms set is_test = true where id = 'e1000000-0000-4000-9000-000000000002';
update public.users set is_test = true where farm_id = 'e1000000-0000-4000-9000-000000000002';
update public.workshops set is_test = true where id = 'e2000000-0000-4000-9000-000000000002';
update public.users set is_test = true where workshop_id = 'e2000000-0000-4000-9000-000000000002';
select set_config('app.test_fence', '', true);

-- == Guardrail: a test farm keeps to the trial AI amount ============================
set local session_replication_role = replica;
insert into public.billing_payments (farm_id, amount_incl_cents, provider, note) values
  ('e1000000-0000-4000-9000-000000000001', 11500, 'manual', 'fence test'),
  ('e1000000-0000-4000-9000-000000000002', 11500, 'manual', 'fence test');
insert into public.farm_ai_settings (farm_id, monthly_limit_cents) values
  ('e1000000-0000-4000-9000-000000000001', 100000),
  ('e1000000-0000-4000-9000-000000000002', 100000);
set local session_replication_role = origin;
do $$
declare v_trial bigint := coalesce((select ai_trial_limit_cents from public.billing_settings where singleton), 5000);
        v_max bigint := (select ai_max_owner_limit_cents from public.billing_settings where singleton);
begin
  if app.ai_effective_limit('e1000000-0000-4000-9000-000000000002') <> v_trial then
    raise exception 'test farm AI limit %: expected the trial amount %', app.ai_effective_limit('e1000000-0000-4000-9000-000000000002'), v_trial;
  end if;
  if app.ai_effective_limit('e1000000-0000-4000-9000-000000000001') <> 100000 then
    raise exception 'real paid farm AI limit %: expected its own 100000', app.ai_effective_limit('e1000000-0000-4000-9000-000000000001');
  end if;
  if app.ai_max_owner_limit('e1000000-0000-4000-9000-000000000002') <> v_trial then
    raise exception 'test farm owner ceiling %: expected the trial amount %', app.ai_max_owner_limit('e1000000-0000-4000-9000-000000000002'), v_trial;
  end if;
  if v_max is not null and app.ai_max_owner_limit('e1000000-0000-4000-9000-000000000001') <> v_max then
    raise exception 'real paid farm owner ceiling changed';
  end if;
end $$;

-- == Guardrail: a test farm, workshop or account only emails test addresses =========
do $$ begin
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['someone@gmail.com']) then
    raise exception 'email: a test farm may email an outsider';
  end if;
  if not public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null,
       array['test.owner@fleetwise.test', 'Clerk@Example.com', 'a@b.sub.example.org', 'x@demo.test']) then
    raise exception 'email: a test farm may not email test addresses';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null,
       array['test.owner@fleetwise.test', 'someone@gmail.com']) then
    raise exception 'email: one outsider among test addresses got through';
  end if;
  if not public.email_recipients_allowed('e1000000-0000-4000-9000-000000000001', null, null, array['someone@gmail.com']) then
    raise exception 'email: a real farm was limited';
  end if;
  if public.email_recipients_allowed(null, 'e2000000-0000-4000-9000-000000000002', null, array['someone@gmail.com']) then
    raise exception 'email: a test workshop may email an outsider';
  end if;
  if public.email_recipients_allowed(null, null, 'e3000000-0000-4000-9000-000000000002', array['someone@gmail.com']) then
    raise exception 'email: a test account may email an outsider';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['someone@notexample.com']) then
    raise exception 'email: a look-alike domain passed as a test address';
  end if;
end $$;

-- Signed-in people cannot ask: only the server's sender does.
select pg_temp.login('e3000000-0000-4000-9000-000000000001');
set local role authenticated;
do $$ begin
  begin
    perform public.email_recipients_allowed(null, null, null, array['a@b.co']);
    raise exception 'email: a signed-in person called email_recipients_allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;


-- == Review fixes: what a leaked test login must still not reach =======================
select set_config('request.jwt.claims', '', true);

-- Rapid Rise's alerts about a real farm reach the real admin only.
do $$
declare v_real int; v_test int;
begin
  perform app.notify_rr_billing('e1000000-0000-4000-9000-000000000001', 'support_ticket_due', '{"subject": "a real customer''s words"}'::jsonb);
  select count(*) into v_real from public.notifications where user_id = 'e3000000-0000-4000-9000-000000000003' and template = 'support_ticket_due';
  select count(*) into v_test from public.notifications where user_id = 'e3000000-0000-4000-9000-000000000004' and template = 'support_ticket_due';
  if v_real <> 1 then raise exception 'alerts: the real admin got % alerts, expected 1', v_real; end if;
  if v_test <> 0 then raise exception 'alerts: the test admin got % of Rapid Rise''s alerts about a real farm', v_test; end if;
end $$;

-- A test account cannot make an outsider's address count as a test one by typing it into
-- its own profile; Rapid Rise's own test inboxes still count.
select pg_temp.login('e3000000-0000-4000-9000-000000000002');
set local role authenticated;
update public.users set email = 'victim@gmail.com' where id = 'e3000000-0000-4000-9000-000000000002';
reset role;
select set_config('request.jwt.claims', '', true);
do $$ begin
  if (select email from public.users where id = 'e3000000-0000-4000-9000-000000000002') <> 'victim@gmail.com' then
    raise exception 'setup: the profile email edit did not take, so this case proves nothing';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['victim@gmail.com']) then
    raise exception 'email: a test account allowed an outsider by putting the address in its own profile';
  end if;
  if not public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['therandomneon+tester@gmail.com']) then
    raise exception 'email: Rapid Rise''s own test inbox was refused';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['therandomneon.lookalike@gmail.com']) then
    raise exception 'email: a look-alike of the test inbox passed';
  end if;
end $$;

-- The service role's own Rapid Rise checks leave test accounts out.
do $$ begin
  if app.ai_member_role('e3000000-0000-4000-9000-000000000004', 'e1000000-0000-4000-9000-000000000001') is not null then
    raise exception 'AI: the test admin counted as Rapid Rise on a real farm (unbilled, unlimited use)';
  end if;
  if app.ai_member_role('e3000000-0000-4000-9000-000000000003', 'e1000000-0000-4000-9000-000000000001') is distinct from 'rr_admin' then
    raise exception 'AI: the real admin stopped counting as Rapid Rise';
  end if;
  begin
    perform public.apply_offline_capture(gen_random_uuid(), now(), 'log_reading', 'app',
      'e3000000-0000-4000-9000-000000000004', jsonb_build_object('machine_id', 'e4000000-0000-4000-9000-000000000001', 'reading', '10'));
    raise exception 'offline capture: the test admin wrote to a real farm''s machine';
  exception when insufficient_privilege then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;
end $$;

-- More person-and-farm rows: a driver's credentials, and a job card's mechanic.
do $$ begin
  begin
    insert into public.driver_credentials (farm_id, user_id, type, expiry_date)
    values ('e1000000-0000-4000-9000-000000000001', 'e3000000-0000-4000-9000-000000000002', 'drivers_licence', current_date + 30);
    raise exception 'a test account got driver credentials on a real farm';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  -- The job-card rules let any Rapid Rise account be assigned to any farm's work; the
  -- fence keeps that to the real one.
  begin
    insert into public.job_cards (farm_id, machine_id, type, status, mechanic_user_id)
    values ('e1000000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'repair', 'open', 'e3000000-0000-4000-9000-000000000004');
    raise exception 'the test admin was made the mechanic on a real farm''s job card';
  exception when insufficient_privilege then
    if sqlerrm not like '%never mix%' then raise; end if;
  end;
  insert into public.job_cards (farm_id, machine_id, type, status, mechanic_user_id)
  values ('e1000000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'repair', 'open', 'e3000000-0000-4000-9000-000000000003');
end $$;

-- Every table tying a person to a farm is fenced or is a record the server writes about the
-- acting person's own farm; a new one must be one or the other, on purpose.
do $$
declare v text;
begin
  select string_agg(c.table_name, ', ' order by c.table_name) into v
    from (select c.table_name
            from information_schema.columns c
            join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
           where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name in ('farm_id', 'user_id')
           group by c.table_name having count(*) = 2) c
   where c.table_name not in (
           -- Records of what a person did on their own farm, or alerts the server addresses.
           'ai_interactions', 'ai_reservations', 'ai_usage', 'ai_voice_sessions', 'audit_log',
           'member_qr_receipts', 'notifications', 'push_subscriptions', 'voice_captures')
     and not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                      where g.tgrelid = ('public.' || c.table_name)::regclass and p.proname = 'fence_user_farm');
  if v is not null then raise exception 'tables tying a person to a farm, neither fenced nor exempt: %', v; end if;
end $$;


-- == Second review: the last two Rapid Rise checks, and one bare address only ==========
select set_config('request.jwt.claims', '', true);
insert into public.job_cards (id, farm_id, machine_id, type, status)
values ('e5000000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-000000000001', 'e4000000-0000-4000-9000-000000000001', 'repair', 'open');

-- job_card_worker's server branch carries no session, so it must read the mark itself.
set local role service_role;
do $$ begin
  if app.job_card_worker('e3000000-0000-4000-9000-000000000004', 'e5000000-0000-4000-9000-000000000001') then
    raise exception 'job cards: the server let the test admin work a real farm''s job card';
  end if;
  if not app.job_card_worker('e3000000-0000-4000-9000-000000000003', 'e5000000-0000-4000-9000-000000000001') then
    raise exception 'job cards: the server stopped letting the real admin work a job card';
  end if;
end $$;
reset role;

-- A machine's QR code: the test admin may not re-issue it, even with the code given.
select pg_temp.login('e3000000-0000-4000-9000-000000000004');
do $$ begin
  begin
    update public.machines set public_token = gen_random_uuid() where id = 'e4000000-0000-4000-9000-000000000001';
    raise exception 'QR: the test admin re-issued a real farm''s QR code';
  exception when insufficient_privilege then
    if sqlerrm not like 'Only an owner or manager%' then raise; end if;
  end;
end $$;
select pg_temp.login('e3000000-0000-4000-9000-000000000003');
update public.machines set public_token = gen_random_uuid() where id = 'e4000000-0000-4000-9000-000000000001';
select set_config('request.jwt.claims', '', true);

do $$ begin
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['victim@gmail.com, x@example.com']) then
    raise exception 'email: a list ending in a test address passed';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['therandomneon+x@victim.org, y@gmail.com']) then
    raise exception 'email: a list made to look like the test inbox passed';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['Name <x@example.com>']) then
    raise exception 'email: a display name passed';
  end if;
  if public.email_recipients_allowed('e1000000-0000-4000-9000-000000000002', null, null, array['therandomneon+x@victim.org@gmail.com']) then
    raise exception 'email: two at signs passed';
  end if;
end $$;

rollback;
