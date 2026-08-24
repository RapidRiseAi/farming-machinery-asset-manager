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

set role authenticated;

-- A primary owner is only an operator on Farm B. The primary role must not leak into
-- Farm B's permission or credential administration.
do $$
declare
  v_count integer;
  v_rows integer;
  v_denied boolean := false;
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
       'api_tokens_sel', 'api_tokens_ins', 'api_tokens_upd', 'api_tokens_del'
     );
  if v_count <> 38 then
    raise exception 'SELECTED FARM FAIL: found % of 38 selected-farm policies', v_count;
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
         'api_tokens_sel', 'api_tokens_ins', 'api_tokens_upd', 'api_tokens_del'
       )
  loop
    if pg_catalog.strpos(v_policy.definition, 'current_app_role') > 0
       or pg_catalog.strpos(v_policy.definition, 'effective_farm_role') = 0 then
      raise exception 'SELECTED FARM FAIL: policy % does not use selected-farm authority',
        v_policy.policyname;
    end if;
  end loop;
end;
$$;

select 'ALL SELECTED-FARM ADMINISTRATION TESTS PASSED' as result;

rollback;
