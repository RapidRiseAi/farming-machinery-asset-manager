\set ON_ERROR_STOP on
-- Scheduled deletion after the reading window (20261120120000). BRIEF section 16 and scenarios 11
-- (the 90-day boundary, reactivation during deletion scheduling) and 29: switched off, it only
-- schedules and previews, warns nobody and deletes nothing; switched on (the founder's typed
-- phrase), owners are warned and nothing goes sooner than 30 days after the first warning; holds,
-- a payment in flight, exemption and reactivation stop it; the deletion is the owner's closure
-- with reason 'retention', keeps billing evidence, moves a person who belongs to another business
-- and removes only who belongs nowhere else; a second run is refused, not repeated.
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

-- == Fixtures ===================================================================================
--   U unpaid, reading window ended forty days ago (so 30 days after it have passed); R unpaid, twenty days of reading left;
--   E exempt and stopped; O another, open business (where U's manager also works).
insert into public.farms (id, name, plan, status, billing_period, suspended_for, billing_exempt) values
  ('d4500000-0000-4000-9000-00000000000a', 'Unpaid yard',   'complete', 'suspended', 'monthly', 'billing', false),
  ('d4500000-0000-4000-9000-00000000000b', 'Reading yard',  'complete', 'suspended', 'monthly', 'billing', false),
  ('d4500000-0000-4000-9000-00000000000c', 'Exempt yard',   'complete', 'suspended', 'monthly', 'billing', true),
  ('d4500000-0000-4000-9000-00000000000d', 'Open yard',     'complete', 'active',    'monthly', null, false);
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, current_period_start, current_period_end,
  next_billing_on, suspended_at, retrieval_ends_on) values
  ('d4560000-0000-4000-9000-00000000000a', 'd4500000-0000-4000-9000-00000000000a', 'complete', 'monthly', 'suspended', current_date - 130, current_date - 101, current_date - 100, now() - interval '130 days', app.billing_today() - 40),
  ('d4560000-0000-4000-9000-00000000000b', 'd4500000-0000-4000-9000-00000000000b', 'complete', 'monthly', 'suspended', current_date - 100, current_date - 71, current_date - 70, now() - interval '70 days', app.billing_today() + 20),
  ('d4560000-0000-4000-9000-00000000000c', 'd4500000-0000-4000-9000-00000000000c', 'complete', 'monthly', 'suspended', current_date - 130, current_date - 101, current_date - 100, now() - interval '100 days', app.billing_today() - 10),
  ('d4560000-0000-4000-9000-00000000000d', 'd4500000-0000-4000-9000-00000000000d', 'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20, null, null);

insert into auth.users (id, email)
select ('d4510000-0000-4000-9000-00000000000' || n)::uuid, 'ret' || n || '@retention.test' from generate_series(1, 5) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('d4510000-0000-4000-9000-000000000001', 'd4500000-0000-4000-9000-00000000000a', 'owner',    'Owner U',   'ret1@retention.test', true),
  ('d4510000-0000-4000-9000-000000000002', 'd4500000-0000-4000-9000-00000000000a', 'manager',  'Manager U', 'ret2@retention.test', true),
  ('d4510000-0000-4000-9000-000000000003', 'd4500000-0000-4000-9000-00000000000b', 'owner',    'Owner R',   'ret3@retention.test', true),
  ('d4510000-0000-4000-9000-000000000004', 'd4500000-0000-4000-9000-00000000000d', 'owner',    'Owner O',   'ret4@retention.test', true),
  ('d4510000-0000-4000-9000-000000000005', null,                                   'rr_admin', 'Rapid Rise','ret5@retention.test', true);
-- U's manager also works at O: a shared login.
insert into public.user_farm_memberships (user_id, farm_id, role, active)
values ('d4510000-0000-4000-9000-000000000002', 'd4500000-0000-4000-9000-00000000000d', 'manager', true);

insert into public.machines (id, farm_id, name, type, public_token) values
  ('d4520000-0000-4000-9000-000000000001', 'd4500000-0000-4000-9000-00000000000a', 'U truck', 'truck', gen_random_uuid()),
  ('d4520000-0000-4000-9000-000000000002', 'd4500000-0000-4000-9000-00000000000d', 'O truck', 'truck', gen_random_uuid());

-- == [1] Switched off: scheduled and previewed, nobody warned, nothing deleted =====================
do $t$
declare v jsonb;
begin
  if (select deletion_enabled from public.retention_settings) then raise exception '[1] deletion ships switched on'; end if;
  v := public.retention_schedule_run();
  if (select delete_after from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a')
     <> app.billing_today() - 40 + 30 then
    raise exception '[1] the unpaid business is not scheduled 30 days after its reading window';
  end if;
  if (select delete_after from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000b')
     <> app.billing_today() + 20 + 30 then
    raise exception '[1] a business still reading is not scheduled from the end of its window';
  end if;
  if exists (select 1 from public.farm_retention_schedules where farm_id in ('d4500000-0000-4000-9000-00000000000c', 'd4500000-0000-4000-9000-00000000000d')) then
    raise exception '[1] an exempt or open business was scheduled';
  end if;
  if exists (select 1 from public.notifications where template = 'retention_deletion_scheduled') then
    raise exception '[1] a customer was told of a deletion that is switched off';
  end if;
  if not ((select preview -> 'checks' -> 'blocked_by' from public.farm_retention_schedules
            where farm_id = 'd4500000-0000-4000-9000-00000000000a') ? 'deletion-off') then
    raise exception '[1] the dry run does not say deletion is off';
  end if;
  if (select (preview ->> 'logins_removed')::int || '/' || (preview ->> 'logins_moved')::int from public.farm_retention_schedules
       where farm_id = 'd4500000-0000-4000-9000-00000000000a') <> '1/1' then
    raise exception '[1] the dry run does not separate the login removed from the shared login moved';
  end if;
  if not ((select preview -> 'tables_removed' from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a') ? 'machines')
     or not ((select preview -> 'kept_for_five_years' from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a') ? 'billing_subscriptions') then
    raise exception '[1] the dry run does not list what goes and what billing evidence stays';
  end if;
  if pg_temp.try($s$select public.retention_delete('d4500000-0000-4000-9000-00000000000a')$s$) <> 'retention-blocked' then
    raise exception '[1] a business was deleted while deletion is switched off';
  end if;
  if exists (select 1 from public.retention_due(20)) then raise exception '[1] something is due while deletion is off'; end if;
  if not exists (select 1 from public.machines where id = 'd4520000-0000-4000-9000-000000000001') then raise exception '[1] a record went'; end if;
end $t$;

-- == [2] The founder's switch, then the first warning ==============================================
do $t$
begin
  if pg_temp.try($s$select public.retention_set_enabled('d4510000-0000-4000-9000-000000000001', true, 'DELETE AFTER THE READING WINDOW')$s$) <> 'forbidden' then
    raise exception '[2] an owner switched deletion on';
  end if;
  if pg_temp.try($s$select public.retention_set_enabled('d4510000-0000-4000-9000-000000000005', true, 'yes')$s$) <> 'retention-phrase' then
    raise exception '[2] deletion was switched on without the phrase';
  end if;
  perform public.retention_set_enabled('d4510000-0000-4000-9000-000000000005', true, 'DELETE AFTER THE READING WINDOW');
  perform public.retention_schedule_run();
  if (select count(*) from public.notifications where template = 'retention_deletion_scheduled' and farm_id = 'd4500000-0000-4000-9000-00000000000a'
        and user_id = 'd4510000-0000-4000-9000-000000000001') <> 1 then
    raise exception '[2] the owner was not warned';
  end if;
  if (select delete_after from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a') < app.billing_today() + 30 then
    raise exception '[2] deletion could come sooner than 30 days after the first warning';
  end if;
  perform public.retention_schedule_run();
  if (select count(*) from public.notifications where template = 'retention_deletion_scheduled' and farm_id = 'd4500000-0000-4000-9000-00000000000a') <> 1 then
    raise exception '[2] a warning was sent twice';
  end if;
  if pg_temp.try($s$select public.retention_delete('d4500000-0000-4000-9000-00000000000a')$s$) <> 'retention-blocked' then
    raise exception '[2] a business was deleted the night it was first warned';
  end if;
  -- Even with the date forced past, a warning sent today is too recent, and says so.
  update public.farm_retention_schedules set delete_after = app.billing_today() - 1 where farm_id = 'd4500000-0000-4000-9000-00000000000a';
  if not (app.retention_checks('d4500000-0000-4000-9000-00000000000a', app.billing_today()) -> 'blocked_by' ? 'warning-too-recent') then
    raise exception '[2] a deletion was not held back by a warning sent today';
  end if;
  -- A business still in its reading window says that, whatever else is true.
  if not (app.retention_checks('d4500000-0000-4000-9000-00000000000b', app.billing_today()) -> 'blocked_by' ? 'reading-window-open') then
    raise exception '[2] the reading window was not checked';
  end if;
end $t$;

-- == [3] Holds, reactivation, exemption and a payment in flight stop it ============================
do $t$
declare v_hold uuid;
begin
  -- Thirty-one days on, due.
  update public.farm_retention_schedules set first_warned_at = now() - interval '31 days', delete_after = app.billing_today() - 1
   where farm_id = 'd4500000-0000-4000-9000-00000000000a';
  v_hold := public.retention_place_hold('d4510000-0000-4000-9000-000000000005', 'd4500000-0000-4000-9000-00000000000a', 'dispute', 'Card dispute open');
  if (select status from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a') <> 'held' then
    raise exception '[3] a hold did not stop the schedule';
  end if;
  if pg_temp.try($s$select public.retention_delete('d4500000-0000-4000-9000-00000000000a')$s$) <> 'retention-blocked' then
    raise exception '[3] a business under a hold was deleted';
  end if;
  -- The hold itself blocks, not only the schedule's status.
  update public.farm_retention_schedules set status = 'scheduled' where farm_id = 'd4500000-0000-4000-9000-00000000000a';
  if not (app.retention_checks('d4500000-0000-4000-9000-00000000000a', app.billing_today()) -> 'blocked_by' ? 'hold') then
    raise exception '[3] an active hold is not a reason to wait';
  end if;
  perform public.retention_release_hold('d4510000-0000-4000-9000-000000000005', v_hold);
  perform public.retention_schedule_run();
  if (select status from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000a') <> 'scheduled' then
    raise exception '[3] releasing the hold did not put the schedule back';
  end if;
  insert into public.billing_payment_attempts (farm_id, attempt_ref, kind, status, amount_incl_cents, requested_at)
  values ('d4500000-0000-4000-9000-00000000000a', 'ret-inflight', 'manual_retry', 'pending', 100, now());
  if pg_temp.try($s$select public.retention_delete('d4500000-0000-4000-9000-00000000000a')$s$) <> 'retention-blocked' then
    raise exception '[3] a business with a payment in flight was deleted';
  end if;
  update public.billing_payment_attempts set status = 'failed', resolved_at = now() where attempt_ref = 'ret-inflight';
  -- R pays: its schedule ends.
  update public.billing_subscriptions set status = 'active', retrieval_ends_on = null where id = 'd4560000-0000-4000-9000-00000000000b';
  update public.farms set status = 'active', suspended_for = null where id = 'd4500000-0000-4000-9000-00000000000b';
  perform public.retention_schedule_run();
  if (select status from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000b') <> 'cancelled' then
    raise exception '[3] a business that paid kept its deletion schedule';
  end if;
end $t$;

-- == [4] The deletion: the owner's closure, billing evidence kept, the shared login moved ===========
do $t$
declare v jsonb;
begin
  if not exists (select 1 from public.retention_due(20) d where d.farm_id = 'd4500000-0000-4000-9000-00000000000a') then
    raise exception '[4] the due business is not listed';
  end if;
  v := public.retention_delete('d4500000-0000-4000-9000-00000000000a');
  if (select deleted_at is null from public.farms where id = 'd4500000-0000-4000-9000-00000000000a') then
    raise exception '[4] the business was not closed';
  end if;
  if exists (select 1 from public.machines where farm_id = 'd4500000-0000-4000-9000-00000000000a') then
    raise exception '[4] an operational record survived';
  end if;
  if not exists (select 1 from public.billing_subscriptions where farm_id = 'd4500000-0000-4000-9000-00000000000a') then
    raise exception '[4] billing evidence was deleted';
  end if;
  if (select reason from public.farm_closures where farm_id = 'd4500000-0000-4000-9000-00000000000a') <> 'retention'
     or (select basis ->> 'retrieval_ends_on' from public.farm_closures where farm_id = 'd4500000-0000-4000-9000-00000000000a') <> (app.billing_today() - 40)::text then
    raise exception '[4] the closure does not record retention and its basis';
  end if;
  if not ((select pending_logins from public.farm_closures where farm_id = 'd4500000-0000-4000-9000-00000000000a') @> array['d4510000-0000-4000-9000-000000000001'::uuid])
     or (select pending_logins from public.farm_closures where farm_id = 'd4500000-0000-4000-9000-00000000000a') @> array['d4510000-0000-4000-9000-000000000002'::uuid] then
    raise exception '[4] the logins to remove are not exactly the one who belongs nowhere else';
  end if;
  if (select farm_id from public.users where id = 'd4510000-0000-4000-9000-000000000002') <> 'd4500000-0000-4000-9000-00000000000d' then
    raise exception '[4] the shared login was not moved to the other business';
  end if;
  if not exists (select 1 from public.machines where farm_id = 'd4500000-0000-4000-9000-00000000000d') then
    raise exception '[4] another business lost a record';
  end if;
  -- A second run is refused, never repeated.
  if pg_temp.try($s$select public.retention_delete('d4500000-0000-4000-9000-00000000000a')$s$) <> 'retention-blocked' then
    raise exception '[4] a second deletion ran';
  end if;
  if exists (select 1 from public.retention_due(20) d where d.farm_id = 'd4500000-0000-4000-9000-00000000000a') then
    raise exception '[4] a deleted business is still due';
  end if;
  if not (app.retention_checks('d4500000-0000-4000-9000-00000000000a', app.billing_today()) -> 'blocked_by' ? 'already-closed') then
    raise exception '[4] a closed business is not reported as already closed';
  end if;
end $t$;

-- == [5] Failures are counted and stop after five; grants ===========================================
do $t$
declare f text;
begin
  insert into public.farm_retention_schedules (farm_id, reason, retrieval_ends_on, delete_after)
  values ('d4500000-0000-4000-9000-00000000000c', 'unpaid', app.billing_today() - 40, app.billing_today() - 10);
  for i in 1..5 loop perform public.retention_mark_failed('d4500000-0000-4000-9000-00000000000c', 'storage unreachable'); end loop;
  if (select status || attempts::text from public.farm_retention_schedules where farm_id = 'd4500000-0000-4000-9000-00000000000c') <> 'failed5' then
    raise exception '[5] repeated failures did not stop the schedule for a person to look at';
  end if;
  foreach f in array array['retention_preview', 'retention_schedule_run', 'retention_due', 'retention_delete',
                           'retention_mark_failed', 'retention_place_hold', 'retention_release_hold', 'retention_set_enabled'] loop
    if exists (select 1 from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace
                 and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                      or not has_function_privilege('service_role', p.oid, 'EXECUTE'))) then
      raise exception '[5] public.% is reachable by a session, or not by the service role', f;
    end if;
  end loop;
end $t$;

rollback;
\echo 'retention_schedules.sql: all assertions passed'
