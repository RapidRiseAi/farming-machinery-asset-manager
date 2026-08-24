-- post_release_popia.sql
-- Standalone, transactional verification for 20260820165542.
-- Run after all migrations; every fixture and helper is rolled back.

\set ON_ERROR_STOP on
\timing off
set client_min_messages to warning;

begin;

create or replace function _popia_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _popia_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

-- Two farms, one Farm A owner/caller and one Farm A data subject.
insert into public.farms (id, name) values
  ('9c000000-0000-0000-0000-000000000001', 'POPIA Farm A'),
  ('9c000000-0000-0000-0000-000000000002', 'POPIA Farm B');

insert into auth.users (id, email) values
  ('9c100000-0000-0000-0000-000000000001', 'popia.owner@example.test'),
  ('9c100000-0000-0000-0000-000000000002', 'subject.address@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('9c100000-0000-0000-0000-000000000001',
   '9c000000-0000-0000-0000-000000000001', 'owner', 'POPIA Owner',
   'popia.owner@example.test'),
  ('9c100000-0000-0000-0000-000000000002',
   '9c000000-0000-0000-0000-000000000001', 'operator', 'POPIA Subject',
   'subject.address@example.test');

insert into public.report_schedules (
  id, farm_id, name, report_key, output_format, cadence, next_run_date, created_by
) values (
  '9c200000-0000-0000-0000-000000000001',
  '9c000000-0000-0000-0000-000000000001',
  'Subject-created monthly report', 'cost', 'csv', 'monthly', current_date,
  '9c100000-0000-0000-0000-000000000002'
);

-- One address belongs to the subject; the other is a third party. The subject created
-- both assignments, so both are relevant activity, but only their own address may be
-- disclosed in a DSAR export.
insert into public.report_schedule_recipients (
  id, schedule_id, farm_id, email, created_by
) values
  ('9c300000-0000-0000-0000-000000000001',
   '9c200000-0000-0000-0000-000000000001',
   '9c000000-0000-0000-0000-000000000001',
   'Subject.Address@Example.Test',
   '9c100000-0000-0000-0000-000000000002'),
  ('9c300000-0000-0000-0000-000000000002',
   '9c200000-0000-0000-0000-000000000001',
   '9c000000-0000-0000-0000-000000000001',
   'third.party@example.test',
   '9c100000-0000-0000-0000-000000000002');

insert into public.report_schedule_runs (
  id, schedule_id, farm_id, period_start, period_end, report_key,
  output_format, recipients, status
) values (
  '9c400000-0000-0000-0000-000000000001',
  '9c200000-0000-0000-0000-000000000001',
  '9c000000-0000-0000-0000-000000000001',
  current_date - 31, current_date - 1, 'cost', 'csv',
  array['subject.address@example.test', 'third.party@example.test']::text[],
  'sent'
);

insert into public.user_permission_grants (
  id, user_id, farm_id, permission, granted_by
) values (
  '9c500000-0000-0000-0000-000000000001',
  '9c100000-0000-0000-0000-000000000002',
  '9c000000-0000-0000-0000-000000000001',
  'see_all_vehicles',
  '9c100000-0000-0000-0000-000000000001'
);

insert into public.api_tokens (
  id, farm_id, name, token_hash, prefix, scopes, created_by
) values (
  '9c600000-0000-0000-0000-000000000001',
  '9c000000-0000-0000-0000-000000000001',
  'Subject-created integration',
  pg_catalog.repeat('a', 64),
  'fwk_POPIA1',
  array['read']::text[],
  '9c100000-0000-0000-0000-000000000002'
);

-- Function hardening and the complete new-table scope are structural invariants.
do $$
declare
  v_definition text;
  v_required text;
begin
  if pg_catalog.has_function_privilege(
       'anon', 'public.export_personal_data(uuid)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role', 'public.export_personal_data(uuid)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.erase_personal_data(uuid,text)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role', 'public.erase_personal_data(uuid,text)', 'execute'
     ) then
    raise exception 'POPIA PRIVILEGE FAIL: a non-interactive role can execute a DSAR RPC';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated', 'public.export_personal_data(uuid)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.erase_personal_data(uuid,text)', 'execute'
     ) then
    raise exception 'POPIA PRIVILEGE FAIL: authenticated cannot execute a DSAR RPC';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated', 'app.app_report_schedule_recipient_audit()', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role', 'app.app_report_schedule_recipient_audit()', 'execute'
     ) then
    raise exception 'POPIA PRIVILEGE FAIL: recipient trigger function is directly callable';
  end if;

  select pg_catalog.pg_get_functiondef(
           'app.assert_local_person_scope(uuid,uuid)'::regprocedure
         ) into v_definition;
  foreach v_required in array array[
    'report_schedules',
    'report_schedule_recipients',
    'report_schedule_runs',
    'user_permission_grants',
    'api_tokens'
  ] loop
    if pg_catalog.strpos(v_definition, v_required) = 0 then
      raise exception 'POPIA SCOPE FAIL: assert_local_person_scope omits %', v_required;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname in ('assert_local_person_scope', 'app_report_schedule_recipient_audit')
       and (
         not p.prosecdef
         or p.proconfig is null
         or not exists (
           select 1
             from pg_catalog.unnest(p.proconfig) as config(setting)
            where config.setting like 'search_path=%'
         )
       )
  ) then
    raise exception 'POPIA FUNCTION FAIL: an internal definer lacks an empty pinned search_path';
  end if;
end;
$$;

-- The recipient audit captures the event and identifiers, never the destination.
do $$
declare
  v_rows bigint;
  v_leaks bigint;
begin
  select pg_catalog.count(*) into v_rows
    from public.audit_log
   where entity = 'report_schedule_recipients'
     and entity_id in (
       '9c300000-0000-0000-0000-000000000001',
       '9c300000-0000-0000-0000-000000000002'
     );
  if v_rows <> 2 then
    raise exception 'POPIA AUDIT FAIL: expected 2 recipient audit rows, got %', v_rows;
  end if;

  select pg_catalog.count(*) into v_leaks
    from public.audit_log
   where entity = 'report_schedule_recipients'
     and (diff::text like '%"email"%'
       or pg_catalog.strpos(pg_catalog.lower(diff::text), 'subject.address@example.test') > 0
       or pg_catalog.strpos(pg_catalog.lower(diff::text), 'third.party@example.test') > 0);
  if v_leaks <> 0 then
    raise exception 'POPIA AUDIT FAIL: % recipient audit rows retain an address', v_leaks;
  end if;
end;
$$;

-- Same-farm export: all new subject activity is present; third-party addresses and
-- credential comparison hashes are absent.
set role authenticated;
do $$
declare
  v_export jsonb;
  v_count bigint;
begin
  perform _popia_login('9c100000-0000-0000-0000-000000000001');
  v_export := public.export_personal_data(
    '9c100000-0000-0000-0000-000000000002'
  );

  if pg_catalog.jsonb_array_length(v_export -> 'report_schedules_created') <> 1
     or pg_catalog.jsonb_array_length(v_export -> 'report_recipient_assignments') <> 2
     or pg_catalog.jsonb_array_length(v_export -> 'report_deliveries') <> 1
     or pg_catalog.jsonb_array_length(v_export -> 'permission_grants_received') <> 1
     or pg_catalog.jsonb_array_length(v_export -> 'api_token_activity') <> 1 then
    raise exception 'POPIA EXPORT FAIL: one or more 0506-0508 collections are incomplete';
  end if;

  select pg_catalog.count(*) into v_count
    from pg_catalog.jsonb_array_elements(
           v_export -> 'report_recipient_assignments'
         ) as assignment(item)
   where pg_catalog.lower(assignment.item ->> 'email') = 'subject.address@example.test';
  if v_count <> 1 then
    raise exception 'POPIA EXPORT FAIL: subject recipient address is missing';
  end if;

  select pg_catalog.count(*) into v_count
    from pg_catalog.jsonb_array_elements(
           v_export -> 'report_recipient_assignments'
         ) as assignment(item)
   where pg_catalog.lower(assignment.item ->> 'email') = 'third.party@example.test';
  if v_count <> 0 then
    raise exception 'POPIA EXPORT FAIL: third-party assignment address was disclosed';
  end if;

  select pg_catalog.count(*) into v_count
    from pg_catalog.jsonb_array_elements(v_export -> 'report_deliveries') as delivery(item)
    cross join lateral pg_catalog.jsonb_array_elements_text(
      delivery.item -> 'recipients'
    ) as recipient(address)
   where pg_catalog.lower(recipient.address) = 'third.party@example.test';
  if v_count <> 0 then
    raise exception 'POPIA EXPORT FAIL: third-party delivery address was disclosed';
  end if;

  if pg_catalog.strpos(v_export::text, '[redacted]') = 0 then
    raise exception 'POPIA EXPORT FAIL: third-party recipients were not visibly redacted';
  end if;
  if pg_catalog.strpos(v_export::text, '"token_hash"') <> 0
     or pg_catalog.strpos(v_export::text, pg_catalog.repeat('a', 64)) <> 0 then
    raise exception 'POPIA EXPORT FAIL: API token hash was exported';
  end if;
end;
$$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- A newly added cross-farm credential relationship must escalate the account-wide
-- request to rr_admin, even though the subject's primary farm is still Farm A.
insert into public.api_tokens (
  id, farm_id, name, token_hash, prefix, scopes, created_by
) values (
  '9c600000-0000-0000-0000-000000000002',
  '9c000000-0000-0000-0000-000000000002',
  'Cross-farm subject activity',
  pg_catalog.repeat('b', 64),
  'fwk_POPIA2',
  array['read']::text[],
  '9c100000-0000-0000-0000-000000000002'
);

set role authenticated;
do $$
declare
  v_blocked boolean := false;
begin
  perform _popia_login('9c100000-0000-0000-0000-000000000001');
  begin
    perform public.export_personal_data(
      '9c100000-0000-0000-0000-000000000002'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'POPIA SCOPE FAIL: farm owner exported a cross-farm subject';
  end if;
end;
$$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);
delete from public.api_tokens
 where id = '9c600000-0000-0000-0000-000000000002';

-- Erasure removes the subject's live addresses and access while preserving unrelated
-- recipients and de-identified delivery history.
set role authenticated;
do $$
declare
  v_result jsonb;
begin
  perform _popia_login('9c100000-0000-0000-0000-000000000001');
  v_result := public.erase_personal_data(
    '9c100000-0000-0000-0000-000000000002',
    'standalone POPIA coverage test'
  );

  if (v_result ->> 'report_recipient_assignments_erased')::bigint <> 1
     or (v_result ->> 'report_delivery_addresses_redacted')::bigint <> 1
     or (v_result ->> 'permission_grants_revoked')::bigint <> 1
     or (v_result ->> 'api_tokens_revoked')::bigint <> 1 then
    raise exception 'POPIA ERASE FAIL: new-record result counts are wrong: %', v_result;
  end if;
end;
$$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

do $$
declare
  v_count bigint;
  v_addresses text[];
begin
  select pg_catalog.count(*) into v_count
    from public.users
   where id = '9c100000-0000-0000-0000-000000000002'
     and email is null
     and name = '[erased]'
     and not active
     and deleted_at is not null;
  if v_count <> 1 then
    raise exception 'POPIA ERASE FAIL: core profile anonymisation regressed';
  end if;

  select pg_catalog.count(*) into v_count
    from public.report_schedule_recipients
   where id = '9c300000-0000-0000-0000-000000000001'
     and deleted_at is not null
     and email like 'erased-%@invalid.invalid';
  if v_count <> 1 then
    raise exception 'POPIA ERASE FAIL: stored recipient address survived';
  end if;

  select pg_catalog.count(*) into v_count
    from public.report_schedule_recipients
   where id = '9c300000-0000-0000-0000-000000000002'
     and deleted_at is null
     and email = 'third.party@example.test';
  if v_count <> 1 then
    raise exception 'POPIA ERASE FAIL: unrelated third-party assignment was changed';
  end if;

  select recipients into v_addresses
    from public.report_schedule_runs
   where id = '9c400000-0000-0000-0000-000000000001';
  if v_addresses is distinct from array['[erased]', 'third.party@example.test']::text[] then
    raise exception 'POPIA ERASE FAIL: delivery history was not selectively redacted: %', v_addresses;
  end if;

  select pg_catalog.count(*) into v_count
    from public.user_permission_grants
   where id = '9c500000-0000-0000-0000-000000000001'
     and deleted_at is not null;
  if v_count <> 1 then
    raise exception 'POPIA ERASE FAIL: subject permission grant is still live';
  end if;

  select pg_catalog.count(*) into v_count
    from public.api_tokens
   where id = '9c600000-0000-0000-0000-000000000001'
     and revoked_at is not null;
  if v_count <> 1 then
    raise exception 'POPIA ERASE FAIL: subject-created API token is still live';
  end if;

  select pg_catalog.count(*) into v_count
    from public.audit_log
   where entity = 'report_schedule_recipients'
     and (diff::text like '%"email"%'
       or pg_catalog.strpos(pg_catalog.lower(diff::text), 'subject.address@example.test') > 0);
  if v_count <> 0 then
    raise exception 'POPIA ERASE FAIL: recipient audit retained the erased address';
  end if;
end;
$$;

select 'ALL POST-RELEASE POPIA COVERAGE TESTS PASSED' as result;

rollback;
