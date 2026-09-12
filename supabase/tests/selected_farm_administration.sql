-- Standalone, transactional verification for 20260820180000.
-- A role on the row's farm must win over the caller's primary-farm role.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _selected_farm_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _selected_farm_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('9d000000-0000-0000-0000-000000000001', 'Selected Role Farm A', 'professional', 'active'),
  ('9d000000-0000-0000-0000-000000000002', 'Selected Role Farm B', 'done_for_you', 'active');

insert into auth.users (id, email) values
  ('9d100000-0000-0000-0000-000000000001', 'primary.owner@example.test'),
  ('9d100000-0000-0000-0000-000000000002', 'secondary.owner@example.test'),
  ('9d100000-0000-0000-0000-000000000003', 'permission.target@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('9d100000-0000-0000-0000-000000000001', '9d000000-0000-0000-0000-000000000001',
   'owner', 'Primary owner, secondary operator', 'primary.owner@example.test'),
  ('9d100000-0000-0000-0000-000000000002', '9d000000-0000-0000-0000-000000000001',
   'operator', 'Primary operator, secondary owner', 'secondary.owner@example.test'),
  ('9d100000-0000-0000-0000-000000000003', '9d000000-0000-0000-0000-000000000002',
   'mechanic', 'Permission target', 'permission.target@example.test');

insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('9d100000-0000-0000-0000-000000000001', '9d000000-0000-0000-0000-000000000002', 'operator', true),
  ('9d100000-0000-0000-0000-000000000002', '9d000000-0000-0000-0000-000000000002', 'owner', true)
on conflict (user_id, farm_id) do update
  set role = excluded.role, active = excluded.active, deleted_at = null;

insert into public.user_permission_grants
  (id, user_id, farm_id, permission, granted_by)
values
  ('9d200000-0000-0000-0000-000000000001',
   '9d100000-0000-0000-0000-000000000003',
   '9d000000-0000-0000-0000-000000000002',
   'manage_stock',
   '9d100000-0000-0000-0000-000000000002');

insert into public.api_tokens
  (id, farm_id, name, token_hash, prefix, scopes, created_by)
values
  ('9d300000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   'Selected-farm test token',
   pg_catalog.repeat('d', 64),
   'fwk_ROLETEST',
   array['read']::text[],
   '9d100000-0000-0000-0000-000000000002');

insert into public.parts_catalogue (id, farm_id, part_no, description) values
  ('9d400000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   'ROLE-TEST-PART',
   'Selected-farm catalogue policy fixture');

-- Core fleet fixtures on Farm B. They are assigned to the primary-owner/secondary-
-- operator so SELECT visibility cannot hide an overly broad UPDATE policy from the test.
insert into public.machines
  (id, farm_id, name, type, meter_type, status, assigned_operator_id)
values
  ('9d500000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   'Selected-role tractor', 'tractor', 'hours', 'active',
   '9d100000-0000-0000-0000-000000000001');

insert into public.fuel_tanks (id, farm_id, name, capacity_l) values
  ('9d600000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002', 'Farm B diesel', 1000);

insert into public.job_cards
  (id, farm_id, machine_id, type, status, date_in)
values
  ('9d700000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   '9d500000-0000-0000-0000-000000000001', 'repair', 'open', current_date);

insert into public.faults
  (id, farm_id, machine_id, description, urgency, status)
values
  ('9d800000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   '9d500000-0000-0000-0000-000000000001',
   'Selected-role fault', 'limping', 'open');

insert into public.work_requests (id, farm_id, machine_id, description) values
  ('9d900000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   '9d500000-0000-0000-0000-000000000001', 'Selected-role contractor request');

insert into public.work_request_events (id, farm_id, work_request_id, to_status, note) values
  ('9d910000-0000-0000-0000-000000000001',
   '9d000000-0000-0000-0000-000000000002',
   '9d900000-0000-0000-0000-000000000001', 'requested', 'Opening fixture');

set role authenticated;

-- A primary owner is only an operator on Farm B. The primary role must not leak into
-- Farm B's permission or credential administration.
do $$
declare
  v_count integer;
  v_rows integer;
  v_denied boolean := false;
  v_member boolean;
  v_command_id uuid;
begin
  perform _selected_farm_login('9d100000-0000-0000-0000-000000000001');

  select pg_catalog.count(*) into v_count
    from public.user_permission_grants
   where id = '9d200000-0000-0000-0000-000000000001';
  if v_count <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator read another user''s permission grant';
  end if;

  select pg_catalog.count(*) into v_count
    from public.api_tokens
   where id = '9d300000-0000-0000-0000-000000000001';
  if v_count <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator read Farm B API credentials';
  end if;

  update public.user_permission_grants
     set deleted_at = pg_catalog.now()
   where id = '9d200000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator revoked a Farm B permission';
  end if;

  update public.api_tokens
     set name = 'unauthorised change'
   where id = '9d300000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator edited a Farm B API token';
  end if;

  update public.parts_catalogue
     set description = 'unauthorised change'
   where id = '9d400000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator edited the Farm B parts catalogue';
  end if;

  begin
    insert into public.api_tokens
      (id, farm_id, name, token_hash, prefix, scopes, created_by)
    values
      ('9d300000-0000-0000-0000-000000000002',
       '9d000000-0000-0000-0000-000000000002',
       'Unauthorised token', pg_catalog.repeat('e', 64), 'fwk_DENIED01',
       array['read']::text[], '9d100000-0000-0000-0000-000000000001');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'SELECTED FARM FAIL: a secondary operator created a Farm B API token';
  end if;

  v_denied := false;
  begin
    insert into public.parts_catalogue (id, farm_id, part_no)
    values (
      '9d400000-0000-0000-0000-000000000002',
      '9d000000-0000-0000-0000-000000000002',
      'DENIED-PART'
    );
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'SELECTED FARM FAIL: a secondary operator created a Farm B catalogue part';
  end if;

  update public.users
     set active = false
   where id = '9d100000-0000-0000-0000-000000000003';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator deactivated a Farm B user';
  end if;

  -- Secondary-farm memberships are intentionally hidden from an operator, but action
  -- validation still needs an authoritative yes/no answer for a chosen teammate.
  select public.is_active_farm_member(
    '9d000000-0000-0000-0000-000000000002',
    '9d100000-0000-0000-0000-000000000002'
  ) into v_member;
  if not v_member then
    raise exception 'SELECTED FARM FAIL: secondary teammate validation was RLS-distorted';
  end if;

  update public.user_farm_memberships
     set role = 'owner'
   where user_id = '9d100000-0000-0000-0000-000000000001'
     and farm_id = '9d000000-0000-0000-0000-000000000002';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: secondary operator escalated their own membership';
  end if;

  v_denied := false;
  v_rows := 0;
  begin
    update public.machines
       set name = 'operator changed a machine'
     where id = '9d500000-0000-0000-0000-000000000001';
    get diagnostics v_rows = row_count;
  exception when others then
    v_denied := true;
  end;
  if not v_denied and v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator administered a Farm B machine';
  end if;

  update public.job_cards
     set status = 'approved', locked = true,
         approved_by = '9d100000-0000-0000-0000-000000000001',
         approved_at = pg_catalog.now()
   where id = '9d700000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator approved a Farm B job card';
  end if;

  update public.faults
     set status = 'resolved', resolved_at = pg_catalog.now()
   where id = '9d800000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator resolved a Farm B fault';
  end if;

  update public.work_requests
     set status = 'invoiced', invoice_amount_cents = 999999
   where id = '9d900000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator changed a contractor request';
  end if;

  v_denied := false;
  begin
    insert into public.work_requests (farm_id, machine_id, status, invoice_amount_cents)
    values ('9d000000-0000-0000-0000-000000000002',
            '9d500000-0000-0000-0000-000000000001', 'invoiced', 999999);
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then
    raise exception 'SELECTED FARM FAIL: a secondary operator created an invoiced contractor request';
  end if;

  delete from public.work_requests where id = '9d900000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator deleted a contractor request';
  end if;

  v_denied := false;
  begin
    insert into public.work_request_events (farm_id, work_request_id, to_status, note)
    values ('9d000000-0000-0000-0000-000000000002',
            '9d900000-0000-0000-0000-000000000001', 'invoiced', 'Forged operator event');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then
    raise exception 'SELECTED FARM FAIL: a secondary operator appended a contractor event';
  end if;

  update public.work_request_events set note = 'Forged history'
   where id = '9d910000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator rewrote a contractor event';
  end if;
  delete from public.work_request_events where id = '9d910000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a secondary operator deleted a contractor event';
  end if;

  v_denied := false;
  begin
    insert into public.fuel_tanks (farm_id, name)
    values ('9d000000-0000-0000-0000-000000000002', 'Operator tank');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'SELECTED FARM FAIL: a secondary operator administered Farm B fuel storage';
  end if;

  -- Operational capture remains useful for the assigned operator while administrative
  -- mutations stay closed.
  insert into public.meter_readings
    (farm_id, machine_id, reading, reading_date, source, by_user)
  values
    ('9d000000-0000-0000-0000-000000000002',
     '9d500000-0000-0000-0000-000000000001', 42, current_date, 'manual',
     '9d100000-0000-0000-0000-000000000001');

  insert into public.fuel_issues
    (farm_id, tank_id, machine_id, date, litres, by_user)
  values
    ('9d000000-0000-0000-0000-000000000002',
     '9d600000-0000-0000-0000-000000000001',
     '9d500000-0000-0000-0000-000000000001', current_date, 10,
     '9d100000-0000-0000-0000-000000000001');

  -- Operational RPCs take row locks. The lock-only machine policy must make the
  -- assigned machine visible without granting this operator an administrative update.
  v_command_id := public.record_meter_reading(
    '9d000000-0000-0000-0000-000000000002',
    '9d500000-0000-0000-0000-000000000001', 43, current_date,
    '9d100000-0000-0000-0000-000000000001'
  );
  if v_command_id is null then
    raise exception 'SELECTED FARM FAIL: assigned operator meter command returned no row';
  end if;

  v_command_id := public.record_fault(
    '9d000000-0000-0000-0000-000000000002',
    '9d500000-0000-0000-0000-000000000001',
    'Operator lock-policy test', 'can_work', null
  );
  if v_command_id is null then
    raise exception 'SELECTED FARM FAIL: assigned operator fault command returned no row';
  end if;
end;
$$;

-- The reverse role arrangement must work: this caller is only an operator on their
-- primary farm, but is the owner on Farm B.
do $$
declare
  v_count integer;
  v_rows integer;
begin
  perform _selected_farm_login('9d100000-0000-0000-0000-000000000002');

  select pg_catalog.count(*) into v_count
    from public.user_permission_grants
   where id = '9d200000-0000-0000-0000-000000000001';
  if v_count <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not read permission grants';
  end if;

  select pg_catalog.count(*) into v_count
    from public.api_tokens
   where id = '9d300000-0000-0000-0000-000000000001';
  if v_count <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not read API credentials';
  end if;

  update public.user_permission_grants
     set deleted_at = pg_catalog.now()
   where id = '9d200000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not revoke a permission';
  end if;

  update public.api_tokens
     set name = 'authorised change', revoked_at = pg_catalog.now()
   where id = '9d300000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not edit an API token';
  end if;

  insert into public.api_tokens
    (id, farm_id, name, token_hash, prefix, scopes, created_by)
  values
    ('9d300000-0000-0000-0000-000000000003',
     '9d000000-0000-0000-0000-000000000002',
     'Authorised token', pg_catalog.repeat('f', 64), 'fwk_ALLOWED1',
     array['read']::text[], '9d100000-0000-0000-0000-000000000002');

  update public.parts_catalogue
     set description = 'authorised change'
   where id = '9d400000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not edit its parts catalogue';
  end if;

  insert into public.parts_catalogue (id, farm_id, part_no)
  values (
    '9d400000-0000-0000-0000-000000000003',
    '9d000000-0000-0000-0000-000000000002',
    'ALLOWED-PART'
  );

  update public.users
     set active = false
   where id = '9d100000-0000-0000-0000-000000000003';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not administer a Farm B user';
  end if;
  update public.users
     set active = true
   where id = '9d100000-0000-0000-0000-000000000003';

  update public.machines
     set name = 'authorised Farm B machine change'
   where id = '9d500000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not administer its machine';
  end if;

  update public.job_cards
     set status = 'approved', locked = true,
         approved_by = '9d100000-0000-0000-0000-000000000002',
         approved_at = pg_catalog.now()
   where id = '9d700000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not approve its job card';
  end if;

  update public.faults
     set status = 'resolved', resolved_at = pg_catalog.now()
   where id = '9d800000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not resolve its fault';
  end if;

  update public.work_requests
     set status = 'viewed'
   where id = '9d900000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not update its contractor request';
  end if;

  insert into public.fuel_tanks (farm_id, name)
  values ('9d000000-0000-0000-0000-000000000002', 'Owner-created tank');

  update public.user_farm_memberships
     set role = 'manager'
   where user_id = '9d100000-0000-0000-0000-000000000002'
     and farm_id = '9d000000-0000-0000-0000-000000000002';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'SELECTED FARM FAIL: a user changed their own selected-farm role';
  end if;

  update public.user_farm_memberships
     set role = role
   where user_id = '9d100000-0000-0000-0000-000000000001'
     and farm_id = '9d000000-0000-0000-0000-000000000002';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: Farm B owner could not administer another member';
  end if;
end;
$$;

-- Farm mechanics can still initiate and progress contractor work and append a timeline.
do $$
declare v_id uuid; v_rows integer;
begin
  perform _selected_farm_login('9d100000-0000-0000-0000-000000000003');
  insert into public.work_requests (farm_id, machine_id, description)
  values ('9d000000-0000-0000-0000-000000000002',
          '9d500000-0000-0000-0000-000000000001', 'Mechanic-initiated work')
  returning id into v_id;
  update public.work_requests set status = 'viewed' where id = v_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'SELECTED FARM FAIL: mechanic could not progress its contractor request';
  end if;
  insert into public.work_request_events (farm_id, work_request_id, to_status, note, by_user)
  values ('9d000000-0000-0000-0000-000000000002', v_id, 'viewed',
          'Mechanic timeline', '9d100000-0000-0000-0000-000000000003');
end $$;

reset role;

-- Prevent future policy restatements from silently reintroducing the primary-role helper.
do $$
declare
  v_policy record;
  v_count integer;
begin
  select pg_catalog.count(*)
    into v_count
    from pg_catalog.pg_policies
   where schemaname = 'public'
     and policyname in (
       'report_schedules_sel', 'report_schedules_ins', 'report_schedules_upd', 'report_schedules_del',
       'report_schedule_recipients_sel', 'report_schedule_recipients_ins',
       'report_schedule_recipients_upd', 'report_schedule_recipients_del',
       'report_schedule_runs_sel', 'report_schedule_runs_ins',
       'report_schedule_runs_upd', 'report_schedule_runs_del',
       'users_ins', 'users_upd',
       'ufm_sel', 'ufm_ins', 'ufm_upd', 'ufm_del',
       'upg_sel', 'upg_ins', 'upg_upd', 'upg_del',
       'stock_items_ins', 'stock_items_upd', 'stock_items_del',
       'stock_movements_ins', 'stock_movements_upd', 'stock_movements_del',
       'partners_ins', 'partners_upd', 'partners_del',
       'parts_catalogue_ins', 'parts_catalogue_upd', 'parts_catalogue_del',
       'api_tokens_sel', 'api_tokens_ins', 'api_tokens_upd', 'api_tokens_del',
       'machines_ins', 'machines_upd', 'machines_del',
       'meter_readings_ins', 'meter_readings_upd', 'meter_readings_del',
       'faults_ins', 'faults_upd', 'faults_del',
       'job_cards_ins', 'job_cards_upd', 'job_cards_del',
       'job_card_lines_ins', 'job_card_lines_upd', 'job_card_lines_del',
       'fuel_tanks_ins', 'fuel_tanks_upd', 'fuel_tanks_del',
       'fuel_deliveries_ins', 'fuel_deliveries_upd', 'fuel_deliveries_del',
       'fuel_issues_ins', 'fuel_issues_upd', 'fuel_issues_del',
       'usage_logs_ins', 'usage_logs_upd', 'usage_logs_del'
     );
  if v_count <> 65 then
    raise exception 'SELECTED FARM FAIL: found % of 65 selected-farm policies', v_count;
  end if;

  for v_policy in
    select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as definition
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and policyname in (
         'report_schedules_sel', 'report_schedules_ins', 'report_schedules_upd', 'report_schedules_del',
         'report_schedule_recipients_sel', 'report_schedule_recipients_ins',
         'report_schedule_recipients_upd', 'report_schedule_recipients_del',
         'report_schedule_runs_sel', 'report_schedule_runs_ins',
         'report_schedule_runs_upd', 'report_schedule_runs_del',
         'users_ins', 'users_upd',
         'ufm_sel', 'ufm_ins', 'ufm_upd', 'ufm_del',
         'upg_sel', 'upg_ins', 'upg_upd', 'upg_del',
         'stock_items_ins', 'stock_items_upd', 'stock_items_del',
         'stock_movements_ins', 'stock_movements_upd', 'stock_movements_del',
         'partners_ins', 'partners_upd', 'partners_del',
         'parts_catalogue_ins', 'parts_catalogue_upd', 'parts_catalogue_del',
         'api_tokens_sel', 'api_tokens_ins', 'api_tokens_upd', 'api_tokens_del',
         'machines_ins', 'machines_upd', 'machines_del',
         'meter_readings_ins', 'meter_readings_upd', 'meter_readings_del',
         'faults_ins', 'faults_upd', 'faults_del',
         'job_cards_ins', 'job_cards_upd', 'job_cards_del',
         'job_card_lines_ins', 'job_card_lines_upd', 'job_card_lines_del',
         'fuel_tanks_ins', 'fuel_tanks_upd', 'fuel_tanks_del',
         'fuel_deliveries_ins', 'fuel_deliveries_upd', 'fuel_deliveries_del',
         'fuel_issues_ins', 'fuel_issues_upd', 'fuel_issues_del',
         'usage_logs_ins', 'usage_logs_upd', 'usage_logs_del'
       )
  loop
    if pg_catalog.strpos(v_policy.definition, 'effective_farm_role') = 0 then
      raise exception 'SELECTED FARM FAIL: policy % does not use selected-farm authority',
        v_policy.policyname;
    end if;
    if pg_catalog.strpos(v_policy.definition, 'current_app_role') > 0
       and v_policy.policyname in (
         'report_schedules_sel', 'report_schedules_ins', 'report_schedules_upd', 'report_schedules_del',
         'report_schedule_recipients_sel', 'report_schedule_recipients_ins',
         'report_schedule_recipients_upd', 'report_schedule_recipients_del',
         'report_schedule_runs_sel', 'report_schedule_runs_ins',
         'report_schedule_runs_upd', 'report_schedule_runs_del',
         'users_ins', 'users_upd',
         'ufm_sel', 'ufm_ins', 'ufm_upd', 'ufm_del',
         'upg_sel', 'upg_ins', 'upg_upd', 'upg_del',
         'stock_items_ins', 'stock_items_upd', 'stock_items_del',
         'stock_movements_ins', 'stock_movements_upd', 'stock_movements_del',
         'partners_ins', 'partners_upd', 'partners_del',
         'parts_catalogue_ins', 'parts_catalogue_upd', 'parts_catalogue_del',
         'api_tokens_sel', 'api_tokens_ins', 'api_tokens_upd', 'api_tokens_del'
       ) then
      raise exception 'SELECTED FARM FAIL: policy % regressed to the primary-farm role',
        v_policy.policyname;
    end if;
  end loop;
end;
$$;

select 'ALL SELECTED-FARM ADMINISTRATION TESTS PASSED' as result;

rollback;
