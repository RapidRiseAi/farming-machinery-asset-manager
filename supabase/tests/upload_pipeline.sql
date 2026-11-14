\set ON_ERROR_STOP on
set client_min_messages to warning;
-- The direct upload pipeline (20261115090000): intents, reservations against a test quota,
-- class limits at, below and above each boundary, spoofed types refused on the real bytes,
-- idempotent begin and commit, membership revoked between begin and commit, the pay gate,
-- the expiry sweep, and who may read an intent.
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

insert into public.farms (id, name, plan, status, billing_period, suspended_for) values
  ('d1000000-0000-4000-9000-000000000001', 'Upload farm', 'complete', 'active', 'monthly', null),
  ('d1000000-0000-4000-9000-000000000002', 'Other farm', 'complete', 'active', 'monthly', null),
  ('d1000000-0000-4000-9000-000000000003', 'Stopped farm', 'complete', 'suspended', 'monthly', 'billing');
insert into auth.users (id, email) values
  ('d1100000-0000-4000-9000-000000000001', 'upload.owner@example.test'),
  ('d1100000-0000-4000-9000-000000000002', 'upload.driver@example.test'),
  ('d1100000-0000-4000-9000-000000000003', 'other.owner@example.test'),
  ('d1100000-0000-4000-9000-000000000004', 'stopped.owner@example.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('d1100000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'upload.owner@example.test', true),
  ('d1100000-0000-4000-9000-000000000002', 'd1000000-0000-4000-9000-000000000001', 'operator', 'Driver', 'upload.driver@example.test', true),
  ('d1100000-0000-4000-9000-000000000003', 'd1000000-0000-4000-9000-000000000002', 'owner', 'Other', 'other.owner@example.test', true),
  ('d1100000-0000-4000-9000-000000000004', 'd1000000-0000-4000-9000-000000000003', 'owner', 'Stopped', 'stopped.owner@example.test', true);
insert into public.machines (id, farm_id, name, type) values
  ('d1200000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000001', 'Upload tractor', 'tractor'),
  ('d1200000-0000-4000-9000-000000000002', 'd1000000-0000-4000-9000-000000000002', 'Other bakkie', 'bakkie'),
  ('d1200000-0000-4000-9000-000000000003', 'd1000000-0000-4000-9000-000000000003', 'Stopped truck', 'truck');
insert into public.faults (id, farm_id, machine_id, description, status) values
  ('d1300000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000001',
   'd1200000-0000-4000-9000-000000000001', 'Hydraulic leak', 'open');

-- A test quota of 30 MB for the upload farm (the hook task A3 replaces).
insert into app.storage_quota_overrides (farm_id, quota_bytes, reason)
values ('d1000000-0000-4000-9000-000000000001', 30000000, 'upload_pipeline.sql');

create temporary table t_ids (name text primary key, id uuid) on commit drop;
grant all on t_ids to authenticated;

set local role authenticated;

-- == Begin: who, which record, which limits =====================================
do $t$
declare
  farm constant uuid := 'd1000000-0000-4000-9000-000000000001';
  machine constant uuid := 'd1200000-0000-4000-9000-000000000001';
  v jsonb;
  v2 jsonb;
  failed text;
begin
  -- Nobody signed in.
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 1000, gen_random_uuid(), 'jpg');
    raise exception 'an anonymous caller began an upload';
  exception when insufficient_privilege then null;
  end;

  perform public._t_login('d1100000-0000-4000-9000-000000000001');
  v := public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 5000000,
         'd1900000-0000-4000-9000-000000000001', 'jpg');
  if v->>'bucket' <> 'machine-photos'
     or v->>'object_path' <> farm::text || '/' || machine::text || '/photo-' || (v->>'id') || '.jpg' then
    raise exception 'the server chose the wrong place: %', v;
  end if;
  insert into t_ids values ('first', (v->>'id')::uuid);

  -- The same request again is the same intent and the same reservation.
  v2 := public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 5000000,
          'd1900000-0000-4000-9000-000000000001', 'jpg');
  if v2->>'id' <> v->>'id' or (v2->>'reused')::boolean is not true then
    raise exception 'a repeated begin made a second intent: % then %', v, v2;
  end if;
  -- The same request id for a different file is refused.
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 5000001,
              'd1900000-0000-4000-9000-000000000001', 'jpg');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:request_reused' then raise exception 'reused request id: %', failed; end if;

  -- Class boundaries: just below, exactly at and above (decimal bytes).
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 20000001, gen_random_uuid(), 'jpg');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:too_large' then raise exception 'a 20,000,001-byte photo: %', failed; end if;
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'fault', 'd1300000-0000-4000-9000-000000000001', 'voice', 'voice', 'audio/webm', 20000001, gen_random_uuid(), 'webm');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:too_large' then raise exception 'a 20,000,001-byte voice note: %', failed; end if;
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'video', 'voice', 'video/mp4', 1000, gen_random_uuid(), 'mp4');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:wrong_type' then raise exception 'video was not refused: %', failed; end if;
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'doc', 'pdf', 'application/x-msdownload', 1000, gen_random_uuid(), 'exe');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:wrong_type' then raise exception 'an executable type was not refused: %', failed; end if;

  -- Another business's record, named under this business, is refused.
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', 'd1200000-0000-4000-9000-000000000002', 'photo', 'photo', 'image/jpeg', 1000, gen_random_uuid(), 'jpg');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:target' then raise exception 'another farm''s machine: %', failed; end if;

  -- Rapid Rise only: payment proofs.
  begin
    perform public.upload_begin(farm, null, 'billing_payment', gen_random_uuid(), 'proof', 'pdf', 'application/pdf', 1000, gen_random_uuid(), 'pdf');
    raise exception 'an owner began a billing proof upload';
  exception when insufficient_privilege then null;
  end;
end $t$;

-- A business the caller does not belong to, and one the pay gate stops.
do $t$
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000003');
  begin
    perform public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'machine',
      'd1200000-0000-4000-9000-000000000001', 'photo', 'photo', 'image/jpeg', 1000, gen_random_uuid(), 'jpg');
    raise exception 'an outsider began an upload on another business';
  exception when insufficient_privilege then null;
  end;
  perform public._t_login('d1100000-0000-4000-9000-000000000004');
  begin
    perform public.upload_begin('d1000000-0000-4000-9000-000000000003', null, 'machine',
      'd1200000-0000-4000-9000-000000000003', 'photo', 'photo', 'image/jpeg', 1000, gen_random_uuid(), 'jpg');
    raise exception 'a suspended business began an upload';
  exception when insufficient_privilege then
    if sqlerrm <> 'farm-not-active' then raise; end if;
  end;
end $t$;

-- == The quota: reservations count, the last bytes go to one upload only ===========
do $t$
declare
  farm constant uuid := 'd1000000-0000-4000-9000-000000000001';
  machine constant uuid := 'd1200000-0000-4000-9000-000000000001';
  v jsonb;
  failed text;
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000001');
  -- 5 MB reserved by 'first'; 20 MB more fits under 30 MB exactly at 25 MB.
  v := public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 20000000,
         'd1900000-0000-4000-9000-000000000002', 'jpg');
  insert into t_ids values ('big', (v->>'id')::uuid);
  -- 5,000,000 more reaches exactly 30 MB: allowed. One byte more is not.
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 5000001, gen_random_uuid(), 'jpg');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:storage_full' then raise exception 'past the quota by one byte: %', failed; end if;
  v := public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/png', 5000000,
         'd1900000-0000-4000-9000-000000000003', 'png');
  insert into t_ids values ('exact', (v->>'id')::uuid);
  failed := null;
  begin
    perform public.upload_begin(farm, null, 'machine', machine, 'photo', 'photo', 'image/jpeg', 1, gen_random_uuid(), 'jpg');
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:storage_full' then raise exception 'a full pool took another byte: %', failed; end if;
end $t$;

-- == Verification on the real bytes (the service role) ============================
reset role;
do $t$
declare
  first uuid := (select id from t_ids where name = 'first');
  big uuid := (select id from t_ids where name = 'big');
  exact uuid := (select id from t_ids where name = 'exact');
  farms uuid[] := array['d1000000-0000-4000-9000-000000000001']::uuid[];
  r text;
begin
  -- A PDF named and declared as a JPEG: refused on what its bytes are; its bytes freed.
  r := app.upload_mark_verified(big, 1000000, 'application/pdf');
  if r <> 'failed:wrong_type' then raise exception 'a spoofed type passed: %', r; end if;
  if app.storage_pool_usage(farms) <> 10000000 then
    raise exception 'a failed upload still holds its reservation: %', app.storage_pool_usage(farms);
  end if;
  -- Bigger than declared but still within the class and the quota: charged at its real size.
  r := app.upload_mark_verified(first, 6000000, 'image/jpeg', null, 4000, 3000);
  if r <> 'uploaded' then raise exception 'a good photo was refused: %', r; end if;
  if app.storage_pool_usage(farms) <> 11000000 then
    raise exception 'growth not charged: %', app.storage_pool_usage(farms);
  end if;
  -- Calling it again changes nothing.
  r := app.upload_mark_verified(first, 6000000, 'image/jpeg', null, 4000, 3000);
  if r <> 'uploaded' then raise exception 'verify again: %', r; end if;
  -- Over its class on the real bytes.
  r := app.upload_mark_verified(exact, 20000001, 'image/png');
  if r <> 'failed:too_large' then raise exception 'real bytes over the class: %', r; end if;
end $t$;

-- == Commit: only the owner of the intent, once, after verification ================
set local role authenticated;
do $t$
declare
  first uuid := (select id from t_ids where name = 'first');
  v jsonb;
  failed text;
begin
  -- Another member of the same business cannot finish someone else's upload.
  perform public._t_login('d1100000-0000-4000-9000-000000000002');
  begin
    perform public.upload_commit(first);
    raise exception 'another person committed this upload';
  exception when insufficient_privilege then null;
  end;

  perform public._t_login('d1100000-0000-4000-9000-000000000001');
  v := public.upload_commit(first);
  if v->>'status' <> 'finalised' or (v->>'record_id')::uuid <> first then raise exception 'commit: %', v; end if;
  -- A retry after a lost response: the same answer, and still one attachment.
  v := public.upload_commit(first);
  if (v->>'reused')::boolean is not true then raise exception 'second commit: %', v; end if;
  if (select count(*) from public.attachments a where a.id = first and a.parent_type = 'machine'
        and a.kind = 'photo' and a.storage_path like 'd1000000-0000-4000-9000-000000000001/%') <> 1 then
    raise exception 'one commit, one attachment';
  end if;

  -- A failed intent cannot be committed.
  failed := null;
  begin
    perform public.upload_commit((select id from t_ids where name = 'big'));
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'upload:wrong_type' then raise exception 'a failed upload committed: %', failed; end if;
end $t$;

-- == Membership revoked between begin and commit ====================================
do $t$
declare
  v jsonb;
  intent uuid;
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000002');
  v := public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'fault',
         'd1300000-0000-4000-9000-000000000001', 'voice', 'voice', 'audio/webm', 1000000,
         'd1900000-0000-4000-9000-000000000004', 'webm');
  intent := (v->>'id')::uuid;
  insert into t_ids values ('revoked', intent);
  -- A person reads their own intents and nobody else's.
  if (select count(*) from public.upload_intents) <> 1 then
    raise exception 'the driver sees % intents, not only their own', (select count(*) from public.upload_intents);
  end if;
  begin
    insert into public.upload_intents (farm_id, user_id, target_kind, target_id, label, bucket, object_path,
      media_class, purpose, declared_mime, declared_bytes, counts_against_quota, request_id, expires_at)
    values ('d1000000-0000-4000-9000-000000000001', 'd1100000-0000-4000-9000-000000000002', 'machine',
      'd1200000-0000-4000-9000-000000000001', 'photo', 'machine-photos', 'x/y', 'photo', 'attachment',
      'image/jpeg', 1, false, gen_random_uuid(), now() + interval '1 hour');
    raise exception 'a person wrote an intent directly';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;
select app.upload_mark_verified((select id from t_ids where name = 'revoked'), 900000, 'audio/webm', 30000);
-- The owner removes the driver (as the system would, outside the driver's own session).
select pg_catalog.set_config('request.jwt.claims', '', false);
update public.users set active = false where id = 'd1100000-0000-4000-9000-000000000002';
set local role authenticated;
do $t$
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000002');
  begin
    perform public.upload_commit((select id from t_ids where name = 'revoked'));
    raise exception 'a removed member committed an upload';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;
do $t$
declare r text;
begin
  r := app.upload_fail((select id from t_ids where name = 'revoked'), 'forbidden');
  if r <> 'failed' then raise exception 'fail: %', r; end if;
  if exists (select 1 from public.attachments where id = (select id from t_ids where name = 'revoked')) then
    raise exception 'a refused upload left an attachment';
  end if;
  -- A finalised upload cannot be failed afterwards.
  if app.upload_fail((select id from t_ids where name = 'first'), 'late') <> 'finalised' then
    raise exception 'a finalised upload was failed';
  end if;
  -- Recorded length over ten minutes is refused even when the size fits.
end $t$;

-- == Durations: ten minutes exactly passes, one millisecond more does not ============
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000001');
  v := public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'fault',
         'd1300000-0000-4000-9000-000000000001', 'voice', 'voice', 'audio/ogg', 4000000, gen_random_uuid(), 'ogg');
  insert into t_ids values ('ten', (v->>'id')::uuid);
  v := public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'fault',
         'd1300000-0000-4000-9000-000000000001', 'voice', 'voice', 'audio/ogg', 4000000, gen_random_uuid(), 'ogg');
  insert into t_ids values ('eleven', (v->>'id')::uuid);
  v := public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'fault',
         'd1300000-0000-4000-9000-000000000001', 'voice', 'voice', 'audio/webm', 1000000, gen_random_uuid(), 'webm');
  insert into t_ids values ('mismatch', (v->>'id')::uuid);
end $t$;
reset role;
do $t$
begin
  if app.upload_mark_verified((select id from t_ids where name = 'ten'), 3600000, 'audio/ogg', 600000) <> 'uploaded' then
    raise exception 'a ten-minute note was refused';
  end if;
  if app.upload_mark_verified((select id from t_ids where name = 'eleven'), 3600000, 'audio/ogg', 600001) <> 'failed:too_long' then
    raise exception 'a note over ten minutes passed';
  end if;
  -- Declared one recording format, really another: refused, though both are voice.
  if app.upload_mark_verified((select id from t_ids where name = 'mismatch'), 900000, 'audio/ogg', 30000) <> 'failed:wrong_type' then
    raise exception 'a file that is not what it was declared to be passed';
  end if;
end $t$;

-- == The sweep: lapsed intents expire, their objects are named once ===================
do $t$
declare
  v jsonb;
  farms uuid[] := array['d1000000-0000-4000-9000-000000000001']::uuid[];
  before bigint := app.storage_pool_usage(farms);
  ten uuid := (select id from t_ids where name = 'ten');
  n integer;
begin
  update public.upload_intents set expires_at = now() - interval '1 hour' where id = ten;
  v := app.upload_expire_sweep(100);
  if (v->>'expired')::integer < 1 then raise exception 'nothing expired: %', v; end if;
  if (select status from public.upload_intents where id = ten) <> 'expired' then raise exception 'not expired'; end if;
  if app.storage_pool_usage(farms) >= before then raise exception 'an expired reservation still counts'; end if;
  if not exists (select 1 from jsonb_array_elements(v->'objects') o where (o->>'id')::uuid = ten) then
    raise exception 'the sweep did not name the expired object';
  end if;
  n := app.upload_mark_removed(array[ten]);
  if n <> 1 then raise exception 'mark removed: %', n; end if;
  v := app.upload_expire_sweep(100);
  if exists (select 1 from jsonb_array_elements(v->'objects') o where (o->>'id')::uuid = ten) then
    raise exception 'a removed object was named again';
  end if;
  -- An uploaded file a record already uses (its commit answer lost) is finished, never swept.
  update public.upload_intents set status = 'uploaded', expires_at = now() - interval '1 hour', actual_bytes = 1000,
    actual_mime = 'audio/webm' where id = (select id from t_ids where name = 'mismatch');
  insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path)
  select gen_random_uuid(), farm_id, 'fault', target_id, 'voice', object_path
    from public.upload_intents where id = (select id from t_ids where name = 'mismatch');
  v := app.upload_expire_sweep(100);
  if (select status from public.upload_intents where id = (select id from t_ids where name = 'mismatch')) <> 'finalised' then
    raise exception 'a file in use was expired';
  end if;
  if exists (select 1 from jsonb_array_elements(v->'objects') o where (o->>'id')::uuid = (select id from t_ids where name = 'mismatch')) then
    raise exception 'the sweep named a file a record uses';
  end if;
  -- Nor is a refused or lapsed upload's object once a record names that path.
  insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path)
  select gen_random_uuid(), farm_id, 'fault', target_id, 'voice', object_path
    from public.upload_intents where id = (select id from t_ids where name = 'eleven');
  v := app.upload_expire_sweep(100);
  if exists (select 1 from jsonb_array_elements(v->'objects') o where (o->>'id')::uuid = (select id from t_ids where name = 'eleven')) then
    raise exception 'the sweep named a refused upload''s object that a record uses';
  end if;
  -- A finalised file is never swept.
  if exists (select 1 from jsonb_array_elements(v->'objects') o where (o->>'id')::uuid = (select id from t_ids where name = 'first')) then
    raise exception 'the sweep named a finalised attachment';
  end if;
end $t$;

-- == Grants: what people and anonymous callers can reach ==========================
do $t$
begin
  if has_function_privilege('anon', 'public.upload_begin(uuid,uuid,text,uuid,text,text,text,bigint,uuid,text,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.upload_commit(uuid,text,uuid)', 'EXECUTE') then
    raise exception 'anonymous callers can reach the upload functions';
  end if;
  if has_function_privilege('authenticated', 'public.upload_mark_verified(uuid,bigint,text,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.upload_fail(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cron_upload_expire_sweep(integer)', 'EXECUTE') then
    raise exception 'a person could state what the server read back, or sweep';
  end if;
  if has_table_privilege('authenticated', 'public.upload_intents', 'INSERT')
     or has_table_privilege('authenticated', 'public.upload_intents', 'UPDATE') then
    raise exception 'people can write intents directly';
  end if;
  -- The direct-write guard is inert until switched on, and refuses an unreserved path then.
  if app.upload_reserved_paths_enforced() then raise exception 'enforcement must start off'; end if;
end $t$;

set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('d1100000-0000-4000-9000-000000000001');
  v := public.upload_begin('d1000000-0000-4000-9000-000000000001', null, 'fault',
         'd1300000-0000-4000-9000-000000000001', 'photo', 'photo', 'image/webp', 1000, gen_random_uuid(), 'webp');
  if not app.upload_path_reserved('fault-photos', v->>'object_path') then
    raise exception 'a reserved path did not read as reserved';
  end if;
  if app.upload_path_reserved('fault-photos', 'd1000000-0000-4000-9000-000000000001/anything.jpg') then
    raise exception 'an unreserved path read as reserved';
  end if;
  perform public._t_login('d1100000-0000-4000-9000-000000000003');
  if app.upload_path_reserved('fault-photos', v->>'object_path') then
    raise exception 'someone else''s reservation counted for another person';
  end if;
end $t$;

rollback;
