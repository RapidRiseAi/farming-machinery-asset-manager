\set ON_ERROR_STOP on
-- The pay gate inside owner-run functions, on notifications and on files (20261112100000).
-- A SECURITY DEFINER function runs past row security, so each one that writes a business's
-- records refuses a stopped business itself, and each one that reads them refuses a pending
-- one; notifications are addressed by the system only; the farm buckets follow the tables.
--
--   P paid -> ok      N never paid -> pending      S overdue -> suspended      C cancelled -> closed
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == Fixtures =================================================================
insert into public.farms (id, name, plan, status, billing_period, suspended_for) values
  ('c8000000-0000-4000-9000-000000000001', 'Paid fn farm',      'complete', 'active',    'monthly', null),
  ('c8000000-0000-4000-9000-000000000002', 'Pending fn farm',   'complete', 'active',    'monthly', null),
  ('c8000000-0000-4000-9000-000000000003', 'Suspended fn farm', 'complete', 'suspended', 'monthly', 'billing'),
  ('c8000000-0000-4000-9000-000000000004', 'Closed fn farm',    'complete', 'active',    'monthly', null);
insert into public.billing_subscriptions (farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, ended_on, cancelled_at) values
  ('c8000000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20, null, null),
  ('c8000000-0000-4000-9000-000000000002', 'complete', 'monthly', 'pending', null, null, null, null, null),
  ('c8000000-0000-4000-9000-000000000003', 'complete', 'monthly', 'suspended', current_date - 40, current_date - 11, current_date - 10, null, null),
  ('c8000000-0000-4000-9000-000000000004', 'complete', 'monthly', 'cancelled', current_date - 40, current_date - 11, null, current_date - 1, now() - interval '20 days');

insert into auth.users (id, email)
select ('c8100000-0000-4000-9000-00000000000' || n)::uuid, 'fn' || n || '@gate.test' from generate_series(1, 7) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('c8100000-0000-4000-9000-000000000001', 'c8000000-0000-4000-9000-000000000001', 'owner', 'Paid Owner', 'fn1@gate.test', true),
  ('c8100000-0000-4000-9000-000000000002', 'c8000000-0000-4000-9000-000000000002', 'owner', 'Pending Owner', 'fn2@gate.test', true),
  ('c8100000-0000-4000-9000-000000000003', 'c8000000-0000-4000-9000-000000000003', 'owner', 'Suspended Owner', 'fn3@gate.test', true),
  ('c8100000-0000-4000-9000-000000000004', 'c8000000-0000-4000-9000-000000000004', 'owner', 'Closed Owner', 'fn4@gate.test', true),
  ('c8100000-0000-4000-9000-000000000005', 'c8000000-0000-4000-9000-000000000001', 'manager', 'Paid Manager', 'fn5@gate.test', true),
  ('c8100000-0000-4000-9000-000000000007', null, 'rr_admin', 'Rapid Rise', 'fn7@gate.test', true);

insert into public.machines (id, farm_id, name, type, public_token)
select ('c8200000-0000-4000-9000-00000000000' || n)::uuid, ('c8000000-0000-4000-9000-00000000000' || n)::uuid,
       'Truck ' || n, 'truck', ('c8600000-0000-4000-9000-00000000000' || n)::uuid
  from generate_series(1, 4) n;
insert into public.fuel_tanks (farm_id, name)
select ('c8000000-0000-4000-9000-00000000000' || n)::uuid, 'Tank ' || n from generate_series(1, 4) n;
insert into public.trips (id, farm_id, number, machine_id, origin, destination)
select ('c8400000-0000-4000-9000-00000000000' || n)::uuid, ('c8000000-0000-4000-9000-00000000000' || n)::uuid, 0,
       ('c8200000-0000-4000-9000-00000000000' || n)::uuid, 'Here', 'There'
  from generate_series(1, 4) n;

create or replace function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;

-- Runs a statement as whoever is acting: 'ok', or the message of a 42501 refusal. Created in
-- this transaction and rolled back with it.
create function public._pg_try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when insufficient_privilege then
  return sqlerrm;
end $$;
grant execute on function public._pg_try(text) to public;

-- == Each family of changed functions, in each state ==========================
-- The owner of each farm calls the same functions on their own farm. Writing works only on
-- the paid farm; reading works everywhere but the pending farm.
do $t$
declare
  r record;
  v_writes text[] := array[
    'select public.asset_contract_save(null, %L, jsonb_build_object(''party'', ''Lease Co'', ''start_date'', current_date))',
    'select public.ai_set_farm_switches(%L, true, null, null)',
    'select public.set_machine_depreciation(%2$L, ''none'')',
    'select public.trip_start(%3$L, 100)',
    'select public.update_farm_settings(%L, ''{"pay_gate_test": true}''::jsonb)'];
  v_reads text[] := array[
    'select count(*) from public.fuel_tank_balances(%L)',
    'select count(*) from public.machine_financials(%2$L)',
    'select count(*) from public.driving_vehicles(%L)',
    'select public.ai_farm_usage(%L)'];
  v_sql text;
  v_got text;
  v_want text;
  v_machine uuid;
  v_trip uuid;
begin
  for r in select * from (values
      ('c8100000-0000-4000-9000-000000000001'::uuid, 'c8000000-0000-4000-9000-000000000001'::uuid, 'ok'),
      ('c8100000-0000-4000-9000-000000000002', 'c8000000-0000-4000-9000-000000000002', 'pending'),
      ('c8100000-0000-4000-9000-000000000003', 'c8000000-0000-4000-9000-000000000003', 'suspended'),
      ('c8100000-0000-4000-9000-000000000004', 'c8000000-0000-4000-9000-000000000004', 'closed')) v(u, f, gate)
  loop
    if app.farm_billing_gate(r.f) <> r.gate then raise exception 'fixture % is not %', r.f, r.gate; end if;
    -- Each farm's own truck and trip, by id: a pending owner cannot even look them up.
    v_machine := replace(r.f::text, 'c8000000', 'c8200000')::uuid;
    v_trip := replace(r.f::text, 'c8000000', 'c8400000')::uuid;
    perform pg_temp.as_user(r.u);
    execute 'set local role authenticated';
    foreach v_sql in array v_writes loop
      v_got := public._pg_try(format(v_sql, r.f, v_machine, v_trip));
      v_want := case when r.gate = 'ok' then 'ok' else 'farm-not-active' end;
      if v_got <> v_want then
        execute 'reset role';
        raise exception 'a % farm writing through "%": %', r.gate, left(v_sql, 60), v_got;
      end if;
    end loop;
    foreach v_sql in array v_reads loop
      v_got := public._pg_try(format(v_sql, r.f, v_machine, v_trip));
      v_want := case when r.gate = 'pending' then 'farm-not-active' else 'ok' end;
      if v_got <> v_want then
        execute 'reset role';
        raise exception 'a % farm reading through "%": %', r.gate, left(v_sql, 60), v_got;
      end if;
    end loop;
    execute 'reset role';
  end loop;
end $t$;

-- The QR lookup finds a machine only where its capture would be taken: the paid farm.
do $t$
declare r record; v_found integer;
begin
  for r in select * from (values
      ('c8100000-0000-4000-9000-000000000001'::uuid, 'c8600000-0000-4000-9000-000000000001'::uuid, 1),
      ('c8100000-0000-4000-9000-000000000002', 'c8600000-0000-4000-9000-000000000002', 0),
      ('c8100000-0000-4000-9000-000000000004', 'c8600000-0000-4000-9000-000000000004', 0)) v(u, token, want)
  loop
    perform pg_temp.as_user(r.u);
    execute 'set local role authenticated';
    select count(*) into v_found from public.resolve_member_qr(r.token);
    execute 'reset role';
    if v_found <> r.want then raise exception 'resolve_member_qr found % for token %', v_found, r.token; end if;
  end loop;
end $t$;

-- WhatsApp linking: the paid farm may link a phone, the pending one may not.
select pg_temp.as_user('c8100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if public._pg_try($s$select public.whatsapp_begin_link('c8000000-0000-4000-9000-000000000001', '27820000001', repeat('a', 64), true, false)$s$) <> 'ok' then
    raise exception 'the paid farm cannot link WhatsApp';
  end if;
end $t$;
reset role;
select pg_temp.as_user('c8100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if public._pg_try($s$select public.whatsapp_begin_link('c8000000-0000-4000-9000-000000000002', '27820000002', repeat('b', 64), true, false)$s$) <> 'farm-not-active' then
    raise exception 'a business that never paid linked WhatsApp';
  end if;
end $t$;
reset role;

-- == Rapid Rise, the service role and other people's businesses ===============
select pg_temp.as_user('c8100000-0000-4000-9000-000000000007', 'aal2');
set local role authenticated;
do $t$ begin
  if public._pg_try($s$select public.update_farm_settings('c8000000-0000-4000-9000-000000000003', '{"checked": true}'::jsonb)$s$) <> 'ok'
     or public._pg_try($s$select public.set_machine_depreciation('c8200000-0000-4000-9000-000000000003', 'none')$s$) <> 'ok'
     or public._pg_try($s$select count(*) from public.fuel_tank_balances('c8000000-0000-4000-9000-000000000002')$s$) <> 'ok' then
    raise exception 'Rapid Rise was stopped by a function';
  end if;
end $t$;
reset role;
do $t$ begin
  -- No user (the crons, the service role): never stopped.
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  if not app.require_open_farm('c8000000-0000-4000-9000-000000000003', true) then raise exception 'the service role was stopped'; end if;
  -- Somebody else's business: not stopped by this check (and nothing learned about it); the
  -- function's own access check is what refuses them.
  perform pg_temp.as_user('c8100000-0000-4000-9000-000000000001');
  if not app.require_open_farm('c8000000-0000-4000-9000-000000000003', true) then raise exception 'a stranger was told'; end if;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  if has_function_privilege('authenticated', 'app.require_open_farm(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'app.require_open_farm(uuid,boolean)', 'EXECUTE') then
    raise exception 'a session can call app.require_open_farm directly';
  end if;
end $t$;

-- == Every owner-run function a person can call is gated, or open on purpose ===
do $t$
declare
  v_open text[] := array[
    -- paying and the gate
    'farm_billing_gate', 'farm_vehicle_allowance', 'update_farm_billing', 'has_entitlement',
    -- the person's own account and rights
    'ai_notice_ack', 'set_notification_prefs', 'erase_personal_data', 'export_personal_data',
    'whatsapp_manage_link', 'whatsapp_link_status',
    -- help
    'open_help_request', 'reply_to_help_request', 'my_help_request', 'my_help_requests',
    'my_farm_support_visits', 'support_contact',
    -- Rapid Rise staff
    'admin_client', 'admin_set_user_active', 'ai_admin_month', 'configure_driver_connection',
    'link_driver_device', 'log_admin_farm_access', 'support_add_note', 'support_assign',
    'support_badge', 'support_holiday_remove', 'support_holiday_set', 'support_mark_emailed',
    'support_open_for_customer', 'support_overview', 'support_queue', 'support_reply',
    'support_set_status', 'support_staff', 'support_ticket', 'support_update_settings',
    'support_visit_end', 'support_visit_start',
    -- a contractor's own books
    'next_document_number', 'revise_document', 'write_off_document', 'run_recurring_invoice',
    'run_recurring_expense', 'update_document_layout',
    -- plumbing
    'claim_request', 'finish_request', 'release_request', 'rate_limit_take', 'consume_assistant_turn',
    -- already refuses through record_public_qr_*
    'record_member_qr'];
  r record;
  v_gated integer := 0;
begin
  for r in
    select p.proname, p.prosrc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  loop
    if r.proname = any (v_open) then
      if r.prosrc like '%require_open_farm(%' then
        raise exception 'public.% is listed open but calls the check', r.proname;
      end if;
    elsif r.prosrc like '%require_open_farm(%' or r.prosrc like '%farm_billing_gate(%' then
      v_gated := v_gated + 1;
    else
      raise exception 'public.% runs as its owner and a person can call it, but it neither checks the pay gate '
        '(app.require_open_farm) nor is listed open here with a reason', r.proname;
    end if;
  end loop;
  if v_gated < 34 then raise exception 'only % functions check the pay gate', v_gated; end if;
  if exists (select 1 from unnest(v_open) o(name)
              where not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = o.name)) then
    raise exception 'the open list names a function that is not there';
  end if;
end $t$;

-- == Notifications are addressed by the system, not by members ================
insert into public.notifications (id, user_id, farm_id, channel, template) values
  ('c8500000-0000-4000-9000-000000000001', 'c8100000-0000-4000-9000-000000000001', 'c8000000-0000-4000-9000-000000000001', 'inapp', 'pay_gate_own'),
  ('c8500000-0000-4000-9000-000000000005', 'c8100000-0000-4000-9000-000000000005', 'c8000000-0000-4000-9000-000000000001', 'inapp', 'pay_gate_colleague');
select pg_temp.as_user('c8100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if public._pg_try($s$insert into public.notifications (user_id, farm_id, channel, template)
       values ('c8100000-0000-4000-9000-000000000005', 'c8000000-0000-4000-9000-000000000001', 'inapp', 'spoofed')$s$) = 'ok' then
    raise exception 'a member addressed a notification to a colleague';
  end if;
  if public._pg_try($s$insert into public.notifications (user_id, farm_id, channel, template)
       values ('c8100000-0000-4000-9000-000000000001', 'c8000000-0000-4000-9000-000000000001', 'inapp', 'to self')$s$) = 'ok' then
    raise exception 'a member wrote a notification at all';
  end if;
  -- No WHERE on purpose: without one, Postgres applies only the DELETE policy, not the SELECT one.
  delete from public.notifications;
  -- A fault is still announced: the owner-run trigger writes the notifications.
  insert into public.faults (farm_id, machine_id, description)
    values ('c8000000-0000-4000-9000-000000000001', 'c8200000-0000-4000-9000-000000000001', 'Oil leak');
end $t$;
reset role;
do $t$ begin
  if exists (select 1 from public.notifications where id = 'c8500000-0000-4000-9000-000000000001') then
    raise exception 'a member could not delete their own notification';
  end if;
  if not exists (select 1 from public.notifications where id = 'c8500000-0000-4000-9000-000000000005') then
    raise exception 'a member deleted a colleague''s notification';
  end if;
  if not exists (select 1 from public.notifications where farm_id = 'c8000000-0000-4000-9000-000000000001'
                   and template = 'fault_reported') then
    raise exception 'the fault-reported notification was not written';
  end if;
end $t$;

-- == Files in the farm buckets =================================================
-- Three places this runs, and only the first has storage.objects when the migrations apply:
--   a Supabase database: storage.objects is real, and 20261112100000 made the policies;
--   CI (run.sh on Postgres): rls_isolation.sql leaves a storage schema behind but no
--     storage.objects, after the migrations ran, so they made no policies;
--   PGlite (migrate_check --suite): no storage schema at all.
-- So the schema and a stand-in table only where missing (a permissive policy lets everything
-- through, so only the pay gate decides), and the policies from the migration's own function
-- only where the migration found nothing to put them on. Then they are exercised everywhere.
do $t$
begin
  create schema if not exists storage;
  if to_regclass('storage.objects') is null then
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create policy stand_in_all on storage.objects for all to authenticated using (true) with check (true);
    grant usage on schema storage to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname like 'pay_gate_%') then
    if app.pay_gate_storage_apply() <> 4 then raise exception 'the storage policies were not made'; end if;
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'pay_gate_%' and permissive = 'RESTRICTIVE') <> 4 then
    raise exception 'storage.objects lacks its pay_gate policies';
  end if;
  insert into storage.objects (bucket_id, name) values
    ('machine-photos', 'c8000000-0000-4000-9000-000000000002/c8200000-0000-4000-9000-000000000002/a.jpg'),
    ('machine-photos', 'c8000000-0000-4000-9000-000000000003/c8200000-0000-4000-9000-000000000003/a.jpg');
end $t$;

do $t$
declare r record; v_got text;
begin
  for r in select * from (values
      ('c8100000-0000-4000-9000-000000000001'::uuid, 'c8000000-0000-4000-9000-000000000001', 'machine-photos', 'ok'),
      ('c8100000-0000-4000-9000-000000000002', 'c8000000-0000-4000-9000-000000000002', 'machine-photos', 'refused'),
      ('c8100000-0000-4000-9000-000000000003', 'c8000000-0000-4000-9000-000000000003', 'checklist-photos', 'refused'),
      ('c8100000-0000-4000-9000-000000000004', 'c8000000-0000-4000-9000-000000000004', 'finance-docs', 'refused'),
      -- A contractor's documents are its own books: not gated.
      ('c8100000-0000-4000-9000-000000000003', 'c8000000-0000-4000-9000-000000000003', 'partner-docs', 'ok')) v(u, f, bucket, want)
  loop
    perform pg_temp.as_user(r.u);
    execute 'set local role authenticated';
    v_got := public._pg_try(format('insert into storage.objects (bucket_id, name) values (%L, %L)',
                                   r.bucket, r.f || '/c8700000-0000-4000-9000-000000000001/file.jpg'));
    execute 'reset role';
    if (v_got = 'ok') <> (r.want = 'ok') then
      raise exception 'uploading to % for farm %: % (wanted %)', r.bucket, r.f, v_got, r.want;
    end if;
  end loop;

  -- Reading: a suspended business still sees its files, a pending one does not.
  perform pg_temp.as_user('c8100000-0000-4000-9000-000000000003');
  execute 'set local role authenticated';
  if (select count(*) from storage.objects where name like 'c8000000-0000-4000-9000-000000000003/%' and bucket_id = 'machine-photos') <> 1 then
    execute 'reset role';
    raise exception 'a suspended business cannot read its own files';
  end if;
  execute 'reset role';
  perform pg_temp.as_user('c8100000-0000-4000-9000-000000000002');
  execute 'set local role authenticated';
  if (select count(*) from storage.objects where name like 'c8000000-0000-4000-9000-000000000002/%') <> 0 then
    execute 'reset role';
    raise exception 'a business that never paid reads its files';
  end if;
  execute 'reset role';
end $t$;

rollback;
