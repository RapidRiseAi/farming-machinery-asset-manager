\set ON_ERROR_STOP on
-- The complete export (20261120110000). BRIEF scenario 20: an export lists only what the
-- requester may read (Storage's own row security, the pay gate, a restricted bucket) and never
-- staff chat, command audio or other export archives; scenario 29: the job's durable pieces
-- (one job at a time per business, idempotent start, daily limit, lease, recording copied,
-- failed and missing files once, retry of missing files, cleanup of expired, abandoned and
-- orphaned archives); scenario 11's retrieval rule: only the owner, only within the 90 days.
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
create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- == Fixtures ===================================================================================
--   A open, S unpaid in its 90 days, C cancelled and past its 90 days, O another business.
insert into public.farms (id, name, plan, status, billing_period, suspended_for) values
  ('e4500000-0000-4000-9000-00000000000a', 'Open yard',      'complete', 'active',    'monthly', null),
  ('e4500000-0000-4000-9000-00000000000b', 'Unpaid yard',    'complete', 'suspended', 'monthly', 'billing'),
  ('e4500000-0000-4000-9000-00000000000c', 'Closed yard',    'complete', 'suspended', 'monthly', 'billing'),
  ('e4500000-0000-4000-9000-00000000000d', 'Other yard',     'complete', 'active',    'monthly', null);
insert into public.billing_subscriptions (farm_id, plan, billing_period, status, current_period_start, current_period_end,
  next_billing_on, ended_on, cancelled_at, suspended_at, retrieval_ends_on) values
  ('e4500000-0000-4000-9000-00000000000a', 'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20, null, null, null, null),
  ('e4500000-0000-4000-9000-00000000000b', 'complete', 'monthly', 'suspended', current_date - 40, current_date - 11, current_date - 10, null, null, now() - interval '3 days', app.billing_today() + 80),
  ('e4500000-0000-4000-9000-00000000000c', 'complete', 'monthly', 'cancelled', current_date - 140, current_date - 111, null, current_date - 110, now() - interval '120 days', null, app.billing_today() - 20),
  ('e4500000-0000-4000-9000-00000000000d', 'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20, null, null, null, null);

insert into auth.users (id, email)
select ('e4510000-0000-4000-9000-00000000000' || n)::uuid, 'exp' || n || '@export.test' from generate_series(1, 6) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('e4510000-0000-4000-9000-000000000001', 'e4500000-0000-4000-9000-00000000000a', 'owner',   'Owner A',   'exp1@export.test', true),
  ('e4510000-0000-4000-9000-000000000002', 'e4500000-0000-4000-9000-00000000000a', 'manager', 'Manager A', 'exp2@export.test', true),
  ('e4510000-0000-4000-9000-000000000003', 'e4500000-0000-4000-9000-00000000000b', 'owner',   'Owner S',   'exp3@export.test', true),
  ('e4510000-0000-4000-9000-000000000004', 'e4500000-0000-4000-9000-00000000000b', 'manager', 'Manager S', 'exp4@export.test', true),
  ('e4510000-0000-4000-9000-000000000005', 'e4500000-0000-4000-9000-00000000000c', 'owner',   'Owner C',   'exp5@export.test', true),
  ('e4510000-0000-4000-9000-000000000006', 'e4500000-0000-4000-9000-00000000000d', 'owner',   'Owner O',   'exp6@export.test', true);

-- Storage: the real table on Supabase; a stand-in elsewhere (as pay_gate_functions.sql does),
-- with a policy shaped like the real ones (a person reads their own businesses' folders) and one
-- restricted bucket (finance documents for the owner only), so row security is what decides.
do $t$
begin
  create schema if not exists storage;
  if to_regclass('storage.objects') is null then
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
    alter table storage.objects enable row level security;
    create policy stand_in_read on storage.objects for select to authenticated
      using (case when split_part(name, '/', 1) ~ '^[0-9a-f-]{36}$' then app.has_farm_access(split_part(name, '/', 1)::uuid) else false end);
    create policy stand_in_finance on storage.objects as restrictive for select to authenticated
      using (bucket_id <> 'finance-docs'
             or app.effective_farm_role(auth.uid(), split_part(name, '/', 1)::uuid) = 'owner');
    grant usage on schema storage to authenticated;
    grant select on storage.objects to authenticated;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'pay_gate_%') then
    perform app.pay_gate_storage_apply();
  end if;
end $t$;
insert into storage.objects (bucket_id, name, metadata) values
  ('machine-photos', 'e4500000-0000-4000-9000-00000000000a/truck.jpg', '{"size": 1000}'),
  ('finance-docs',   'e4500000-0000-4000-9000-00000000000a/loan.pdf', '{"size": 2000}'),
  ('fault-voice',    'e4500000-0000-4000-9000-00000000000a/noise.webm', '{"size": 3000}'),
  ('chat-files',     'e4500000-0000-4000-9000-00000000000a/private.ogg', '{"size": 4000}'),
  ('command-audio',  'e4500000-0000-4000-9000-00000000000a/command.ogg', '{"size": 5000}'),
  ('machine-docs',   'e4500000-0000-4000-9000-00000000000b/manual.pdf', '{"size": 6000}'),
  ('machine-photos', 'e4500000-0000-4000-9000-00000000000d/other.jpg', '{"size": 7000}');

-- == [1] The file list is judged by the requester's own session ===================================
select pg_temp.as_user('e4510000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', null, null, 1000)) <> 3 then
    raise exception '[1] the owner does not list exactly their three files (photo, finance, voice)';
  end if;
  if exists (select 1 from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', null, null, 1000)
              where bucket_id in ('chat-files', 'command-audio', 'farm-exports')) then
    raise exception '[1] staff chat, command audio or an export archive was listed for export';
  end if;
  if (select count(*) from public.export_readable_files('e4500000-0000-4000-9000-00000000000d', null, null, 1000)) <> 0 then
    raise exception '[1] another business''s files were listed';
  end if;
  -- Keyset paging: one at a time, in order, nothing twice.
  if (select string_agg(x.name, ',') from (
        select f.name from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', null, null, 1) f
        union all
        select f.name from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', 'fault-voice', 'e4500000-0000-4000-9000-00000000000a/noise.webm', 1) f) x)
     <> 'e4500000-0000-4000-9000-00000000000a/noise.webm,e4500000-0000-4000-9000-00000000000a/loan.pdf' then
    raise exception '[1] paging does not walk the list in order';
  end if;
end $t$;
reset role;
select pg_temp.as_user('e4510000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if exists (select 1 from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', null, null, 1000) where bucket_id = 'finance-docs') then
    raise exception '[1] a manager''s export listed a restricted finance document';
  end if;
  if (select count(*) from public.export_readable_files('e4500000-0000-4000-9000-00000000000a', null, null, 1000)) <> 2 then
    raise exception '[1] the manager does not list the two files they may read';
  end if;
end $t$;
reset role;

-- == [2] A stopped business: the owner only ========================================================
select pg_temp.as_user('e4510000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.export_readable_files('e4500000-0000-4000-9000-00000000000b', null, null, 1000)) <> 1 then
    raise exception '[2] the owner of an unpaid business cannot list its files in the 90 days';
  end if;
end $t$;
reset role;
select pg_temp.as_user('e4510000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.export_readable_files('e4500000-0000-4000-9000-00000000000b', null, null, 1000)) <> 0 then
    raise exception '[2] a manager listed the files of a business in its 90 days';
  end if;
end $t$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == [3] Starting: idempotent, one at a time, the lifecycle, the daily limit ======================
do $t$
declare v jsonb; v2 jsonb; v3 jsonb; v_id uuid;
begin
  v := public.export_job_create('e4510000-0000-4000-9000-000000000001', 'e4500000-0000-4000-9000-00000000000a', 'e4520000-0000-4000-9000-000000000001');
  if not (v ->> 'created')::boolean then raise exception '[3] the first export was not created'; end if;
  v2 := public.export_job_create('e4510000-0000-4000-9000-000000000001', 'e4500000-0000-4000-9000-00000000000a', 'e4520000-0000-4000-9000-000000000001');
  if v2 ->> 'id' <> v ->> 'id' or (v2 ->> 'created')::boolean then raise exception '[3] a repeated start made a second job'; end if;
  v3 := public.export_job_create('e4510000-0000-4000-9000-000000000002', 'e4500000-0000-4000-9000-00000000000a', 'e4520000-0000-4000-9000-000000000002');
  if v3 ->> 'id' <> v ->> 'id' or not (v3 ->> 'running')::boolean then raise exception '[3] two exports of one business ran at once'; end if;
  if (select requester_role from public.farm_export_jobs where id = (v ->> 'id')::uuid) <> 'owner' then
    raise exception '[3] the requester''s role was not recorded';
  end if;
  if pg_temp.try($s$select public.export_job_create('e4510000-0000-4000-9000-000000000004', 'e4500000-0000-4000-9000-00000000000b', gen_random_uuid())$s$) <> 'export-not-allowed' then
    raise exception '[3] a manager started an export in the 90 days';
  end if;
  v := public.export_job_create('e4510000-0000-4000-9000-000000000003', 'e4500000-0000-4000-9000-00000000000b', 'e4520000-0000-4000-9000-000000000003');
  if not (v ->> 'created')::boolean then raise exception '[3] the owner could not export in the 90 days'; end if;
  if pg_temp.try($s$select public.export_job_create('e4510000-0000-4000-9000-000000000005', 'e4500000-0000-4000-9000-00000000000c', gen_random_uuid())$s$) <> 'export-not-allowed' then
    raise exception '[3] an export started after the 90 days had ended';
  end if;
  -- Five a day per business.
  for i in 1..5 loop
    v := public.export_job_create('e4510000-0000-4000-9000-000000000006', 'e4500000-0000-4000-9000-00000000000d', gen_random_uuid());
    update public.farm_export_jobs set status = 'cancelled' where id = (v ->> 'id')::uuid;
  end loop;
  if pg_temp.try($s$select public.export_job_create('e4510000-0000-4000-9000-000000000006', 'e4500000-0000-4000-9000-00000000000d', gen_random_uuid())$s$) <> 'export-limit' then
    raise exception '[3] a sixth export started in one day';
  end if;
end $t$;

-- == [4] One step at a time; files recorded once ===================================================
do $t$
declare
  v_job uuid := (select id from public.farm_export_jobs where request_id = 'e4520000-0000-4000-9000-000000000001');
  v_token uuid;
begin
  insert into public.farm_export_job_files (job_id, farm_id, seq, bucket, name, size) values
    (v_job, 'e4500000-0000-4000-9000-00000000000a', 1, 'machine-photos', 'e4500000-0000-4000-9000-00000000000a/truck.jpg', 1000),
    (v_job, 'e4500000-0000-4000-9000-00000000000a', 2, 'finance-docs', 'e4500000-0000-4000-9000-00000000000a/loan.pdf', 2000),
    (v_job, 'e4500000-0000-4000-9000-00000000000a', 3, 'fault-voice', 'e4500000-0000-4000-9000-00000000000a/noise.webm', 3000);
  update public.farm_export_jobs set status = 'files', inventory_done = true, files_total = 3, bytes_total = 6000 where id = v_job;

  v_token := public.export_job_claim(v_job, 60);
  if v_token is null then raise exception '[4] the first step could not take the lease'; end if;
  if public.export_job_claim(v_job, 60) is not null then raise exception '[4] two steps held the lease at once'; end if;
  if pg_temp.try(format($s$select public.export_job_record_files(%L, gen_random_uuid(), null, '[]')$s$, v_job)) <> 'export-lease-lost' then
    raise exception '[4] a step without the lease recorded files';
  end if;
  perform public.export_job_record_files(v_job, v_token,
    jsonb_build_object('n', 1, 'name', 'part-0001.zip', 'bytes', 1100, 'sha256', repeat('a', 64), 'entries', 1, 'kind', 'files'),
    jsonb_build_array(
      jsonb_build_object('seq', 1, 'status', 'copied', 'attempted', 1, 'archive_path', 'files/machine-photos/x-truck.jpg', 'sha256', repeat('b', 64), 'part', 1),
      jsonb_build_object('seq', 2, 'attempted', 1),
      jsonb_build_object('seq', 3, 'status', 'missing', 'reason', 'not_found', 'attempted', 3)));
  -- A replay of the same record changes nothing: only pending rows move.
  perform public.export_job_record_files(v_job, v_token, null,
    jsonb_build_array(jsonb_build_object('seq', 1, 'status', 'copied', 'attempted', 1, 'archive_path', 'other', 'sha256', repeat('c', 64), 'part', 9)));
  if (select archive_path || part::text || attempts::text from public.farm_export_job_files where job_id = v_job and seq = 1) <> 'files/machine-photos/x-truck.jpg11' then
    raise exception '[4] a copied file was recorded twice';
  end if;
  if (select files_done::text || files_missing::text || bytes_done::text || status || jsonb_array_length(parts)::text
        from public.farm_export_jobs where id = v_job) <> '111000files1' then
    raise exception '[4] the counters do not follow the files';
  end if;
  if (select attempts from public.farm_export_job_files where job_id = v_job and seq = 2) <> 1 then
    raise exception '[4] a failed attempt was not counted';
  end if;
  perform public.export_job_record_files(v_job, v_token, null,
    jsonb_build_array(jsonb_build_object('seq', 2, 'status', 'copied', 'attempted', 1, 'archive_path', 'files/finance-docs/y-loan.pdf', 'sha256', repeat('d', 64), 'part', 2)));
  if (select status from public.farm_export_jobs where id = v_job) <> 'finishing' then
    raise exception '[4] the job did not move on once no file was pending';
  end if;
  perform public.export_job_release(v_job, v_token);
  if public.export_job_claim(v_job, 60) is null then raise exception '[4] a released lease could not be taken again'; end if;
end $t$;

-- == [5] A worker checks the requester's rights again ==============================================
do $t$
declare v_job uuid := (select id from public.farm_export_jobs where request_id = 'e4520000-0000-4000-9000-000000000001');
begin
  if not public.export_job_allowed(v_job) then raise exception '[5] the owner''s own job was refused'; end if;
  update public.users set active = false where id = 'e4510000-0000-4000-9000-000000000001';
  if public.export_job_allowed(v_job) then raise exception '[5] a deactivated requester''s job went on'; end if;
  update public.users set active = true where id = 'e4510000-0000-4000-9000-000000000001';
  update public.users set role = 'operator' where id = 'e4510000-0000-4000-9000-000000000001';
  if public.export_job_allowed(v_job) then raise exception '[5] a requester who is no longer owner or manager went on'; end if;
  update public.users set role = 'owner' where id = 'e4510000-0000-4000-9000-000000000001';
end $t$;

-- == [6] Missing files asked for again; the requester reads only their own jobs ====================
do $t$
declare v_job uuid := (select id from public.farm_export_jobs where request_id = 'e4520000-0000-4000-9000-000000000001');
begin
  update public.farm_export_jobs set status = 'ready', ready_at = now(), expires_at = now() + interval '7 days', lease_token = null, lease_until = null where id = v_job;
  update public.farm_export_jobs set status = 'cancelled' where request_id = 'e4520000-0000-4000-9000-000000000003';
  if pg_temp.try(format($s$select public.export_job_retry_missing('e4510000-0000-4000-9000-000000000002', %L)$s$, v_job)) <> 'forbidden' then
    raise exception '[6] someone else retried the owner''s export';
  end if;
  if public.export_job_retry_missing('e4510000-0000-4000-9000-000000000001', v_job) <> 1 then
    raise exception '[6] the missing file was not put back to be tried';
  end if;
  if (select status || files_missing::text from public.farm_export_jobs where id = v_job) <> 'files0' then
    raise exception '[6] the job did not go back to copying files';
  end if;
end $t$;
select pg_temp.as_user('e4510000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if exists (select 1 from public.farm_export_jobs) then raise exception '[6] a manager reads the owner''s export'; end if;
end $t$;
do $t$ begin
  perform 1 from public.farm_export_job_files limit 1;
  raise exception '[6] a signed-in person reads an export''s file list';
exception when insufficient_privilege then null;
end $t$;
reset role;
select pg_temp.as_user('e4510000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.farm_export_jobs) <> 1 then raise exception '[6] the owner does not read their own export'; end if;
end $t$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == [7] Cleanup: expired, abandoned and orphaned archives =========================================
do $t$
declare
  v_job uuid := (select id from public.farm_export_jobs where request_id = 'e4520000-0000-4000-9000-000000000001');
  v_old uuid;
begin
  update public.farm_export_jobs set status = 'ready', expires_at = now() - interval '1 minute' where id = v_job;
  insert into public.farm_export_jobs (farm_id, requested_by, request_id, requester_role, status, updated_at)
  values ('e4500000-0000-4000-9000-00000000000d', 'e4510000-0000-4000-9000-000000000006', gen_random_uuid(), 'owner', 'cancelled', now())
  returning id into v_old;
  -- An abandoned job: nobody came back for a week.
  update public.farm_export_jobs set status = 'records', updated_at = now() - interval '8 days' where id = v_old;
  if not exists (select 1 from public.export_jobs_to_clean(20) c where c.id = v_job) then
    raise exception '[7] an expired archive was not due for cleanup';
  end if;
  if (select status from public.farm_export_jobs where id = v_old) <> 'failed' then
    raise exception '[7] an abandoned export was not stopped';
  end if;
  perform public.export_job_mark_removed(v_job);
  if (select status || (removed_at is not null)::text from public.farm_export_jobs where id = v_job) <> 'expiredtrue' then
    raise exception '[7] a removed archive is not marked expired';
  end if;
  if exists (select 1 from public.export_jobs_to_clean(20) c where c.id = v_job) then
    raise exception '[7] a removed archive is cleaned again';
  end if;
  insert into storage.objects (bucket_id, name, metadata) values
    ('farm-exports', 'exports/e4500000-0000-4000-9000-00000000000a/' || v_job || '/part-0001.zip', '{"size": 1}'),
    ('farm-exports', 'exports/e4500000-0000-4000-9000-00000000000d/ffffffff-0000-4000-9000-000000000000/part-0001.zip', '{"size": 1}'),
    ('farm-exports', 'exports/e4500000-0000-4000-9000-00000000000d/' || v_old || '/part-0001.zip', '{"size": 1}');
  if (select count(*) from public.export_orphan_objects(100)) <> 2
     or exists (select 1 from public.export_orphan_objects(100) o where o.name like '%' || v_old || '%') then
    raise exception '[7] orphaned archives (no job, or a removed job) are not exactly the ones swept';
  end if;
end $t$;

-- == [8] Grants =====================================================================================
do $t$
declare f text;
begin
  foreach f in array array['export_job_allowed', 'export_job_create', 'export_job_claim', 'export_job_release',
                           'export_job_record_files', 'export_job_retry_missing', 'export_jobs_to_clean',
                           'export_job_mark_removed', 'export_orphan_objects'] loop
    if exists (select 1 from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace
                 and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                      or not has_function_privilege('service_role', p.oid, 'EXECUTE'))) then
      raise exception '[8] public.% is reachable by a session, or not by the service role', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.export_readable_files(uuid,text,text,integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.export_readable_files(uuid,text,text,integer)', 'EXECUTE')
     or (select prosecdef from pg_proc where oid = 'public.export_readable_files(uuid,text,text,integer)'::regprocedure) then
    raise exception '[8] the file list is not a signed-in, invoker-rights read';
  end if;
end $t$;

rollback;
\echo 'complete_export.sql: all assertions passed'
