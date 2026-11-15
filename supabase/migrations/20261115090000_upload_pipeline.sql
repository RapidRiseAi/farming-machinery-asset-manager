-- 20261115090000_upload_pipeline.sql
-- Files go straight from the browser to private Storage (BRIEF section 10, decisions 8 to 13).
--
-- Until now every photo, PDF and voice note travelled through a Vercel function, whose
-- request body stops at 4.5 MB, so the founder's 20 MB photos and 50 MB PDFs could never
-- arrive. The pipeline is: intent -> quota reservation -> signed direct upload -> server
-- verification of the real bytes -> attachment record.
--
--   public.upload_begin   (a person's session) checks the business, the pay gate, the
--                         record, the class limits and the quota, reserves the bytes under
--                         a per-pool lock and records an intent with a path the SERVER
--                         chooses, the business (or a contractor's workshop) first.
--   (Next.js)             signs an upload for exactly that path with the service key
--                         (Supabase signed upload URL, 2 hours, no overwrite) and the
--                         browser sends the file to Storage: one PUT up to 6 MB, TUS above.
--   app.upload_mark_verified (service only) records what the server read back from Storage:
--                         the real size, the real type from the first bytes, the image's
--                         dimensions or the recording's length. It refuses what is too big
--                         or not what was declared, and charges any growth to the quota.
--   public.upload_commit  (the person's session again) rechecks membership, the pay gate
--                         and the record, writes the attachment (id = the intent's id, so a
--                         retry cannot make a second one) and marks the intent finalised.
--   app.upload_fail, app.upload_expire_sweep (service only) release reservations and name
--                         the objects the nightly job removes.
--
-- The quota is not set yet: app.storage_quota_bytes answers null (no limit) unless
-- app.storage_quota_overrides holds a figure. Task A3 replaces that function, and
-- app.storage_pool_farm_ids (which businesses share one allowance), with the pooled
-- customer allowance and paid blocks; the reservation arithmetic here does not change.
--
-- Additive and safe on the live database: two new tables, new functions, the buckets' size
-- and type limits RAISED to the catalogue (src/lib/limits.ts; objects already stored are
-- untouched), one new private bucket for temporary command audio, and two restrictive
-- Storage policies that stay inert until app.upload_settings says to enforce them (the
-- older upload paths write straight to Storage with a person's session and must keep
-- working until their replacements are proven in production).

-- == Settings ===================================================================
create table if not exists app.upload_settings (
  id boolean primary key default true check (id),
  -- When true, a person's session may only write a farm-bucket object at a path an open
  -- intent of theirs reserved, and may not overwrite one. Off until every upload path in
  -- production uses the pipeline (docs/final-dev/PROGRESS-lane-b.md says when).
  enforce_reserved_paths boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into app.upload_settings (id) values (true) on conflict (id) do nothing;
alter table app.upload_settings enable row level security;
alter table app.upload_settings force row level security;
revoke all on app.upload_settings from public, anon, authenticated, service_role;
comment on table app.upload_settings is
  'One row: whether Storage refuses a person''s direct writes outside reserved upload paths (20261115090000).';

-- == The quota hooks (task A3 replaces these two functions) ====================
create table if not exists app.storage_quota_overrides (
  farm_id uuid primary key references public.farms(id) on delete cascade,
  quota_bytes bigint not null check (quota_bytes >= 0),
  reason text not null,
  updated_at timestamptz not null default now()
);
alter table app.storage_quota_overrides enable row level security;
alter table app.storage_quota_overrides force row level security;
revoke all on app.storage_quota_overrides from public, anon, authenticated, service_role;
comment on table app.storage_quota_overrides is
  'A storage limit set by hand for one business (tests, or Rapid Rise before the pooled allowance '
  'of task A3 exists). No row means no limit.';

create or replace function app.storage_pool_farm_ids(p_farm uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select array[p_farm];
$$;
revoke all on function app.storage_pool_farm_ids(uuid) from public, anon, authenticated, service_role;
comment on function app.storage_pool_farm_ids(uuid) is
  'The businesses sharing one storage allowance with this one. Today just itself; task A3 '
  'answers the whole customer subscription (decision 22).';

create or replace function app.storage_quota_bytes(p_farm uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select o.quota_bytes from app.storage_quota_overrides o where o.farm_id = p_farm;
$$;
revoke all on function app.storage_quota_bytes(uuid) from public, anon, authenticated, service_role;
comment on function app.storage_quota_bytes(uuid) is
  'The pool''s attachment allowance in bytes, or null for no limit. The single hook task A3 '
  'replaces with max(2 GB, full spaces x 100 MB + equipment x 25 MB) plus paid blocks.';

-- == The intents ================================================================
create table if not exists public.upload_intents (
  id                   uuid primary key default gen_random_uuid(),
  farm_id              uuid references public.farms(id),
  -- A contractor's own books (receipts) belong to their workshop, not to a farm.
  workshop_id          uuid references public.workshops(id),
  user_id              uuid not null references public.users(id),
  target_kind          text not null check (target_kind in (
                         'machine', 'fault', 'checklist_instance', 'job_card', 'work_request',
                         'trip_job', 'finance_agreement', 'asset_contract', 'partner_document',
                         'partner_expense', 'billing_payment', 'assistant_command')),
  target_id            uuid not null,
  label                text not null check (label ~ '^[a-z]{2,16}$'),
  bucket               text not null,
  object_path          text not null unique,
  media_class          text not null check (media_class in ('photo', 'pdf', 'voice', 'command_audio')),
  purpose              text not null check (purpose in ('attachment', 'command_audio')),
  declared_mime        text not null,
  declared_bytes       bigint not null check (declared_bytes > 0),
  reserved_bytes       bigint not null default 0 check (reserved_bytes >= 0),
  counts_against_quota boolean not null,
  actual_mime          text,
  actual_bytes         bigint check (actual_bytes is null or actual_bytes > 0),
  duration_ms          integer check (duration_ms is null or duration_ms >= 0),
  width                integer check (width is null or width > 0),
  height               integer check (height is null or height > 0),
  status               text not null default 'reserved'
                         check (status in ('reserved', 'uploaded', 'finalised', 'failed', 'expired')),
  failure              text,
  request_id           uuid not null,
  record_id            uuid,
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now(),
  verified_at          timestamptz,
  finalised_at         timestamptz,
  object_removed_at    timestamptz,
  constraint upload_intents_one_owner check ((farm_id is null) <> (workshop_id is null)),
  constraint upload_intents_one_request unique (user_id, request_id),
  constraint upload_intents_purpose_ck check ((purpose = 'command_audio') = (media_class = 'command_audio'))
);
create index if not exists upload_intents_open_idx on public.upload_intents (farm_id)
  where status in ('reserved', 'uploaded');
create index if not exists upload_intents_finalised_idx on public.upload_intents (farm_id)
  where status = 'finalised' and counts_against_quota and object_removed_at is null;
create index if not exists upload_intents_sweep_idx on public.upload_intents (status, expires_at);
create index if not exists upload_intents_user_idx on public.upload_intents (user_id, status);

alter table public.upload_intents enable row level security;
alter table public.upload_intents force row level security;
revoke all on public.upload_intents from public, anon, authenticated;
grant select on public.upload_intents to authenticated;
grant all on public.upload_intents to service_role;
drop policy if exists upload_intents_own on public.upload_intents;
create policy upload_intents_own on public.upload_intents for select to authenticated
  using (user_id = (select auth.uid()));
select app.pay_gate_apply('upload_intents');
-- Test and real never mix (20261014120000). An intent has one owner, so this never fires
-- today; it is here so the fence holds if that ever changes.
drop trigger if exists upload_intents_test_fence on public.upload_intents;
create trigger upload_intents_test_fence before insert or update on public.upload_intents
  for each row execute function app.fence_farm_workshop();
comment on table public.upload_intents is
  'One direct upload: who, which business and record, the server-chosen object path, what was '
  'declared, what the server read back, the reserved bytes and where it got to. Written only by '
  'the upload functions; a person reads their own (20261115090000).';

-- == The media classes (mirrors MEDIA_CLASSES in src/lib/limits.ts; limits.test.ts checks) ==
create or replace function app.upload_class_max_bytes(p_class text)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case p_class
    when 'photo' then 20000000
    when 'pdf' then 50000000
    when 'voice' then 20000000
    when 'command_audio' then 20000000
  end::bigint;
$$;

create or replace function app.upload_class_max_ms(p_class text)
returns integer
language sql immutable set search_path = public, pg_temp as $$
  select case p_class when 'voice' then 600000 when 'command_audio' then 600000 end;
$$;

create or replace function app.upload_class_mimes(p_class text)
returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select case p_class
    when 'photo' then array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
    when 'pdf' then array['application/pdf']
    when 'voice' then array['audio/webm', 'audio/ogg', 'audio/mp4']
    when 'command_audio' then array['audio/webm', 'audio/ogg', 'audio/mp4']
  end;
$$;

-- HEIC and HEIF are one family; everything else must be exactly what was declared.
create or replace function app.upload_same_type(p_declared text, p_actual text)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_declared = p_actual
      or (p_declared in ('image/heic', 'image/heif') and p_actual in ('image/heic', 'image/heif'));
$$;

-- Which bucket a record's file of a class goes to; null for a combination we never store.
create or replace function app.upload_bucket_for(p_kind text, p_class text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_kind = 'machine' and p_class = 'photo' then 'machine-photos'
    when p_kind = 'machine' and p_class = 'pdf' then 'machine-docs'
    when p_kind = 'fault' and p_class = 'photo' then 'fault-photos'
    when p_kind = 'fault' and p_class = 'voice' then 'fault-voice'
    when p_kind = 'checklist_instance' and p_class = 'photo' then 'checklist-photos'
    when p_kind in ('job_card', 'work_request') and p_class in ('photo', 'pdf') then 'jobcard-photos'
    when p_kind = 'trip_job' and p_class = 'photo' then 'jobcard-photos'
    when p_kind in ('finance_agreement', 'asset_contract') and p_class in ('photo', 'pdf') then 'finance-docs'
    when p_kind = 'partner_document' and p_class in ('photo', 'pdf') then 'partner-docs'
    when p_kind = 'partner_expense' and p_class in ('photo', 'pdf') then 'partner-receipts'
    when p_kind = 'billing_payment' and p_class in ('photo', 'pdf') then 'billing-proofs'
    when p_kind = 'assistant_command' and p_class = 'command_audio' then 'command-audio'
  end;
$$;

revoke all on function app.upload_class_max_bytes(text), app.upload_class_max_ms(text),
  app.upload_class_mimes(text), app.upload_same_type(text, text), app.upload_bucket_for(text, text)
  from public, anon;

-- Is this record one a file can be attached to, in this business (or workshop)? Null when
-- it is; otherwise a reason. p_pending_ok allows a record the same request is about to
-- create (a new vehicle's first photo, a contractor's own document), never one that exists
-- in another business.
create or replace function app.upload_target_problem(
  p_kind text, p_target uuid, p_farm uuid, p_workshop uuid, p_pending_ok boolean
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_farm uuid;
  v_found boolean := false;
begin
  if p_target is null then return 'target'; end if;
  case p_kind
    when 'machine' then
      select m.farm_id, true into v_farm, v_found from public.machines m where m.id = p_target and m.deleted_at is null;
    when 'fault' then
      select f.farm_id, true into v_farm, v_found from public.faults f where f.id = p_target and f.deleted_at is null;
    when 'checklist_instance' then
      select c.farm_id, true into v_farm, v_found from public.checklist_instances c where c.id = p_target;
    when 'job_card' then
      select j.farm_id, true into v_farm, v_found from public.job_cards j where j.id = p_target and j.deleted_at is null;
    when 'work_request' then
      select w.farm_id, true into v_farm, v_found from public.work_requests w where w.id = p_target and w.deleted_at is null;
    when 'trip_job' then
      select t.farm_id, true into v_farm, v_found from public.trip_jobs t where t.id = p_target;
    when 'finance_agreement', 'asset_contract' then
      -- Owners and managers only (the finance-docs rule), before a byte is reserved.
      if not app.can_view_farm_finance(p_farm) or not app.finance_parent_ok(p_kind, p_target, p_farm) then
        return 'target';
      end if;
      return null;
    when 'partner_document' then
      select d.farm_id, true into v_farm, v_found from public.partner_documents d where d.id = p_target;
    when 'partner_expense' then
      if exists (select 1 from public.partner_expenses e where e.id = p_target and e.workshop_id is distinct from p_workshop) then
        return 'target';
      end if;
      return null;  -- a receipt may be chosen before its expense is saved
    when 'billing_payment' then
      return null;  -- Rapid Rise only (checked by the caller); the invoice is checked by the action
    when 'assistant_command' then
      return null;  -- the command's job is created when its audio is committed
    else
      return 'target';
  end case;
  if v_found then
    return case when v_farm = p_farm then null else 'target' end;
  end if;
  if p_pending_ok and p_kind in ('machine', 'checklist_instance', 'partner_document') then
    -- Not created yet: the id must not be in use anywhere, deleted rows included.
    if p_kind = 'machine' and exists (select 1 from public.machines m where m.id = p_target) then return 'target'; end if;
    return null;
  end if;
  return 'target';
end $$;
revoke all on function app.upload_target_problem(text, uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- May the signed-in person attach a file to this record? Farm side and Rapid Rise: farm
-- access is the whole rule (checked by the caller). A contractor: only records on machines
-- shared with them, as app.storage_object_visible decides for reads (0403).
create or replace function app.upload_record_visible(p_kind text, p_target uuid, p_farm uuid)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if app.is_rr_admin() or app.current_app_role() is distinct from 'workshop' then
    return true;
  end if;
  return case p_kind
    when 'machine' then app.partner_machine_visible(p_farm, p_target)
    when 'fault' then exists (select 1 from public.faults f
                               where f.id = p_target and app.partner_machine_visible(f.farm_id, f.machine_id))
    when 'checklist_instance' then exists (select 1 from public.checklist_instances c
                               where c.id = p_target and app.partner_machine_visible(c.farm_id, c.machine_id))
    when 'work_request' then app.work_request_visible(p_target)
    else false
  end;
end $$;
revoke all on function app.upload_record_visible(text, uuid, uuid) from public, anon, authenticated, service_role;

-- == Quota arithmetic ===========================================================
-- Bytes the pool holds (finalised files not yet removed) plus bytes reserved by uploads in
-- flight, optionally leaving one intent out (its own growth is being judged).
create or replace function app.storage_pool_usage(p_farms uuid[], p_except uuid default null)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(case
           when i.status = 'finalised' then coalesce(i.actual_bytes, i.reserved_bytes)
           else i.reserved_bytes end), 0)::bigint
    from public.upload_intents i
   where i.farm_id = any (p_farms)
     and i.counts_against_quota
     and (p_except is null or i.id <> p_except)
     and ((i.status = 'finalised' and i.object_removed_at is null)
          or (i.status in ('reserved', 'uploaded') and i.expires_at > now()));
$$;
revoke all on function app.storage_pool_usage(uuid[], uuid) from public, anon, authenticated, service_role;

-- Takes the pool's lock (held to the end of the transaction, so two uploads cannot both see
-- the last free bytes) and raises upload:storage_full when p_bytes more would pass the quota.
create or replace function app.storage_pool_reserve(p_farm uuid, p_bytes bigint, p_except uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farms uuid[] := app.storage_pool_farm_ids(p_farm);
  v_quota bigint := app.storage_quota_bytes(p_farm);
  v_key uuid;
begin
  -- One lock per pool, whichever of its businesses the upload is for.
  select f into v_key from unnest(v_farms) f order by f::text limit 1;
  perform pg_advisory_xact_lock(hashtext('fleetwise:storage-pool:' || v_key::text));
  if v_quota is null then return; end if;
  if app.storage_pool_usage(v_farms, p_except) + p_bytes > v_quota then
    raise exception 'upload:storage_full' using errcode = 'P0001',
      detail = 'This business''s attachment storage is full.';
  end if;
end $$;
revoke all on function app.storage_pool_reserve(uuid, bigint, uuid) from public, anon, authenticated, service_role;

-- == Begin ======================================================================
create or replace function public.upload_begin(
  p_farm uuid, p_workshop uuid, p_target_kind text, p_target_id uuid, p_label text,
  p_media_class text, p_mime text, p_bytes bigint, p_request uuid, p_ext text,
  p_ttl_seconds integer default 7200
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_mime text := lower(split_part(coalesce(p_mime, ''), ';', 1));
  v_bucket text;
  v_counts boolean;
  v_problem text;
  i public.upload_intents;
  v_id uuid := gen_random_uuid();
  v_ttl interval := make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 7200), 60), 7200));
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (p_farm is null) = (p_workshop is null) then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;
  if p_farm is not null then
    if not app.has_farm_access(p_farm) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    perform app.require_open_farm(p_farm, true);
  elsif app.user_workshop_id() is distinct from p_workshop then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_target_kind = 'billing_payment' and not app.is_rr_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if app.upload_class_max_bytes(p_media_class) is null or not (v_mime = any (app.upload_class_mimes(p_media_class))) then
    raise exception 'upload:wrong_type' using errcode = 'P0001';
  end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > app.upload_class_max_bytes(p_media_class) then
    raise exception 'upload:too_large' using errcode = 'P0001';
  end if;
  if p_label is null or p_label !~ '^[a-z]{2,16}$' or p_ext is null or p_ext !~ '^[a-z0-9]{2,5}$' or p_request is null then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;
  v_bucket := app.upload_bucket_for(p_target_kind, p_media_class);
  if v_bucket is null or (p_workshop is not null) <> (p_target_kind = 'partner_expense') then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;
  v_problem := app.upload_target_problem(p_target_kind, p_target_id, p_farm, p_workshop, true);
  if v_problem is not null then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;
  v_counts := p_farm is not null and p_target_kind <> 'billing_payment' and p_media_class <> 'command_audio';

  -- The same request again: the same intent, never a second reservation.
  select * into i from public.upload_intents x where x.user_id = v_uid and x.request_id = p_request for update;
  if found then
    if i.farm_id is distinct from p_farm or i.workshop_id is distinct from p_workshop
       or i.target_kind <> p_target_kind or i.target_id <> p_target_id or i.media_class <> p_media_class
       or i.declared_mime <> v_mime or i.declared_bytes <> p_bytes then
      raise exception 'upload:request_reused' using errcode = 'P0001';
    end if;
    if i.status in ('finalised', 'failed', 'uploaded') or (i.status = 'reserved' and i.expires_at > now()) then
      return jsonb_build_object('id', i.id, 'bucket', i.bucket, 'object_path', i.object_path,
        'expires_at', i.expires_at, 'status', i.status, 'failure', i.failure, 'reused', true);
    end if;
    -- Lapsed before the file landed: reserve again and give it a fresh window.
    if i.counts_against_quota then
      perform app.storage_pool_reserve(p_farm, i.declared_bytes, i.id);
    end if;
    update public.upload_intents
       set status = 'reserved', reserved_bytes = case when counts_against_quota then declared_bytes else 0 end,
           expires_at = now() + v_ttl, failure = null
     where id = i.id
     returning * into i;
    return jsonb_build_object('id', i.id, 'bucket', i.bucket, 'object_path', i.object_path,
      'expires_at', i.expires_at, 'status', i.status, 'failure', null, 'reused', true);
  end if;

  if (select count(*) from public.upload_intents x
       where x.user_id = v_uid and x.status in ('reserved', 'uploaded') and x.expires_at > now()) >= 40 then
    raise exception 'upload:too_many' using errcode = 'P0001';
  end if;

  if v_counts then
    perform app.storage_pool_reserve(p_farm, p_bytes);
  end if;

  insert into public.upload_intents (
    id, farm_id, workshop_id, user_id, target_kind, target_id, label, bucket, object_path,
    media_class, purpose, declared_mime, declared_bytes, reserved_bytes, counts_against_quota,
    request_id, expires_at)
  values (
    v_id, p_farm, p_workshop, v_uid, p_target_kind, p_target_id, p_label, v_bucket,
    coalesce(p_farm, p_workshop)::text || '/' || p_target_id::text || '/' || p_label || '-' || v_id::text || '.' || p_ext,
    p_media_class, case when p_media_class = 'command_audio' then 'command_audio' else 'attachment' end,
    v_mime, p_bytes, case when v_counts then p_bytes else 0 end, v_counts, p_request, now() + v_ttl)
  returning * into i;

  return jsonb_build_object('id', i.id, 'bucket', i.bucket, 'object_path', i.object_path,
    'expires_at', i.expires_at, 'status', i.status, 'failure', null, 'reused', false);
end $$;
revoke all on function public.upload_begin(uuid, uuid, text, uuid, text, text, text, bigint, uuid, text, integer) from public, anon;
grant execute on function public.upload_begin(uuid, uuid, text, uuid, text, text, text, bigint, uuid, text, integer) to authenticated;
comment on function public.upload_begin(uuid, uuid, text, uuid, text, text, text, bigint, uuid, text, integer) is
  'Reserves one direct upload for the signed-in person: checks the business and pay gate, the '
  'record, the class limits and the quota (under the pool lock), and returns the server-chosen '
  'path. Idempotent per request id (20261115090000).';

-- == Verified (service only: these facts come from reading the stored object) ========
create or replace function app.upload_mark_verified(
  p_intent uuid, p_actual_bytes bigint, p_actual_mime text,
  p_duration_ms integer default null, p_width integer default null, p_height integer default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.upload_intents;
  v_mime text := lower(coalesce(p_actual_mime, ''));
  v_failure text;
begin
  select * into i from public.upload_intents where id = p_intent for update;
  if not found then return 'missing'; end if;
  if i.status in ('finalised', 'uploaded') then return i.status; end if;
  if i.status in ('failed', 'expired') then return i.status; end if;

  v_failure := case
    when p_actual_bytes is null or p_actual_bytes <= 0 then 'empty'
    when p_actual_bytes > app.upload_class_max_bytes(i.media_class) then 'too_large'
    when not (v_mime = any (app.upload_class_mimes(i.media_class))) then 'wrong_type'
    when not app.upload_same_type(i.declared_mime, v_mime) then 'wrong_type'
    when app.upload_class_max_ms(i.media_class) is not null and p_duration_ms is not null
         and p_duration_ms > app.upload_class_max_ms(i.media_class) then 'too_long'
  end;
  if v_failure is null and i.counts_against_quota and p_actual_bytes > i.reserved_bytes then
    begin
      perform app.storage_pool_reserve(i.farm_id, p_actual_bytes, i.id);
    exception when sqlstate 'P0001' then
      v_failure := 'storage_full';
    end;
  end if;
  if v_failure is not null then
    update public.upload_intents set status = 'failed', failure = v_failure where id = i.id;
    return 'failed:' || v_failure;
  end if;
  update public.upload_intents
     set status = 'uploaded', actual_bytes = p_actual_bytes, actual_mime = v_mime,
         reserved_bytes = case when counts_against_quota then greatest(reserved_bytes, p_actual_bytes) else 0 end,
         duration_ms = p_duration_ms, width = p_width, height = p_height, verified_at = now()
   where id = i.id;
  return 'uploaded';
end $$;
revoke all on function app.upload_mark_verified(uuid, bigint, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function app.upload_mark_verified(uuid, bigint, text, integer, integer, integer) to service_role;

create or replace function app.upload_fail(p_intent uuid, p_reason text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.upload_intents;
begin
  select * into i from public.upload_intents where id = p_intent for update;
  if not found then return 'missing'; end if;
  if i.status = 'finalised' then return 'finalised'; end if;
  update public.upload_intents
     set status = 'failed', failure = left(coalesce(p_reason, 'failed'), 40)
   where id = i.id;
  return 'failed';
end $$;
revoke all on function app.upload_fail(uuid, text) from public, anon, authenticated;
grant execute on function app.upload_fail(uuid, text) to service_role;

-- Public wrappers for the service role (PostgREST serves public only); refused to people.
create or replace function public.upload_mark_verified(
  p_intent uuid, p_actual_bytes bigint, p_actual_mime text,
  p_duration_ms integer default null, p_width integer default null, p_height integer default null
) returns text
language sql security definer set search_path = public, pg_temp as $$
  select app.upload_mark_verified(p_intent, p_actual_bytes, p_actual_mime, p_duration_ms, p_width, p_height);
$$;
revoke all on function public.upload_mark_verified(uuid, bigint, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.upload_mark_verified(uuid, bigint, text, integer, integer, integer) to service_role;

create or replace function public.upload_fail(p_intent uuid, p_reason text)
returns text
language sql security definer set search_path = public, pg_temp as $$
  select app.upload_fail(p_intent, p_reason);
$$;
revoke all on function public.upload_fail(uuid, text) from public, anon, authenticated;
grant execute on function public.upload_fail(uuid, text) to service_role;

-- == Commit (the person's session: membership, pay gate and record are rechecked) ====
create or replace function public.upload_commit(p_intent uuid, p_attachment_kind text default null, p_record uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.upload_intents;
  v_kind text;
  v_parent text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into i from public.upload_intents where id = p_intent for update;
  if not found or i.user_id <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if i.status = 'finalised' then
    return jsonb_build_object('status', 'finalised', 'record_id', i.record_id, 'reused', true);
  end if;
  if i.status <> 'uploaded' then
    raise exception 'upload:%', case i.status when 'failed' then coalesce(i.failure, 'failed') when 'expired' then 'expired' else 'not_uploaded' end
      using errcode = 'P0001';
  end if;

  if i.farm_id is not null then
    if not app.has_farm_access(i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    perform app.require_open_farm(i.farm_id, true);
  elsif app.user_workshop_id() is distinct from i.workshop_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if i.target_kind = 'billing_payment' and not app.is_rr_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if app.upload_target_problem(i.target_kind, i.target_id, i.farm_id, i.workshop_id,
       i.target_kind in ('partner_expense', 'partner_document', 'billing_payment', 'assistant_command')) is not null then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;

  -- Records whose file is an ordinary attachment are written here, with the intent's id.
  if i.target_kind in ('machine', 'fault', 'checklist_instance', 'work_request', 'finance_agreement', 'asset_contract') then
    -- The same per-record rule Storage applies to reads (app.storage_object_visible: a
    -- contractor reaches only the files of records shared with them), judged on the
    -- intent's own record rather than by parsing the path, and the finance rule.
    if not app.upload_record_visible(i.target_kind, i.target_id, i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if i.target_kind in ('finance_agreement', 'asset_contract') and not app.can_view_farm_finance(i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_kind := coalesce(p_attachment_kind, case i.media_class when 'photo' then 'photo' when 'voice' then 'voice' else 'doc' end);
    if v_kind not in ('photo', 'voice', 'doc', 'invoice')
       or (i.media_class = 'voice') <> (v_kind = 'voice')
       or (i.media_class = 'pdf' and v_kind = 'photo') then
      raise exception 'upload:target' using errcode = 'P0001';
    end if;
    v_parent := i.target_kind;
    insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path, created_by)
    values (i.id, i.farm_id, v_parent, i.target_id, v_kind::attachment_kind, i.object_path, i.user_id)
    on conflict (id) do nothing;
    p_record := i.id;
  end if;

  update public.upload_intents
     set status = 'finalised', finalised_at = now(), record_id = coalesce(p_record, record_id)
   where id = i.id;
  return jsonb_build_object('status', 'finalised', 'record_id', coalesce(p_record, i.record_id), 'reused', false);
end $$;
revoke all on function public.upload_commit(uuid, text, uuid) from public, anon;
grant execute on function public.upload_commit(uuid, text, uuid) to authenticated;
comment on function public.upload_commit(uuid, text, uuid) is
  'Finishes a verified upload for its own person: rechecks membership, the pay gate and the '
  'record, writes the attachment (id = intent id) for ordinary attachments, marks it finalised. '
  'Calling it again answers the first result (20261115090000).';

-- == The nightly sweep (service only) ============================================
-- Marks lapsed intents expired (their reservation stops counting at once) and names every
-- object of an expired or failed intent not yet removed, oldest first. The caller removes
-- them from Storage and then calls app.upload_mark_removed with the ids it removed.
create or replace function app.upload_expire_sweep(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_expired integer;
  v_objects jsonb;
begin
  -- A file a record already uses is never swept, whatever its intent says: an upload whose
  -- commit answer was lost after its attachment was written is finished, not abandoned.
  update public.upload_intents i
     set status = 'finalised', finalised_at = now()
   where i.status = 'uploaded'
     and exists (select 1 from public.attachments a where a.storage_path = i.object_path and a.deleted_at is null);

  with lapsed as (
    update public.upload_intents
       set status = 'expired'
     where status in ('reserved', 'uploaded') and expires_at <= now() - interval '10 minutes'
    returning 1)
  select count(*) into v_expired from lapsed;

  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'bucket', x.bucket, 'path', x.object_path)), '[]'::jsonb)
    into v_objects
    from (select i.id, i.bucket, i.object_path from public.upload_intents i
           where i.status in ('expired', 'failed') and i.object_removed_at is null
             and not exists (select 1 from public.attachments a where a.storage_path = i.object_path)
           order by i.created_at
           limit greatest(1, least(coalesce(p_limit, 500), 1000))) x;
  return jsonb_build_object('expired', v_expired, 'objects', v_objects);
end $$;
revoke all on function app.upload_expire_sweep(integer) from public, anon, authenticated;
grant execute on function app.upload_expire_sweep(integer) to service_role;

create or replace function app.upload_mark_removed(p_ids uuid[])
returns integer
language sql security definer set search_path = public, pg_temp as $$
  with done as (
    update public.upload_intents set object_removed_at = now()
     where id = any (p_ids) and status in ('expired', 'failed') and object_removed_at is null
    returning 1)
  select count(*)::integer from done;
$$;
revoke all on function app.upload_mark_removed(uuid[]) from public, anon, authenticated;
grant execute on function app.upload_mark_removed(uuid[]) to service_role;

create or replace function public.cron_upload_expire_sweep(p_limit integer default 500)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.upload_expire_sweep(p_limit);
$$;
create or replace function public.cron_upload_mark_removed(p_ids uuid[])
returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.upload_mark_removed(p_ids);
$$;
revoke all on function public.cron_upload_expire_sweep(integer), public.cron_upload_mark_removed(uuid[]) from public, anon, authenticated;
grant execute on function public.cron_upload_expire_sweep(integer), public.cron_upload_mark_removed(uuid[]) to service_role;

-- == Storage: direct writes only to a reserved path, once enforced ================
create or replace function app.upload_reserved_paths_enforced()
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.enforce_reserved_paths from app.upload_settings s where s.id), false);
$$;
revoke all on function app.upload_reserved_paths_enforced() from public, anon;
grant execute on function app.upload_reserved_paths_enforced() to authenticated, service_role;

create or replace function app.upload_path_reserved(p_bucket text, p_name text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.upload_intents i
     where i.user_id = (select auth.uid()) and i.bucket = p_bucket and i.object_path = p_name
       and i.status = 'reserved' and i.expires_at > now());
$$;
revoke all on function app.upload_path_reserved(text, text) from public, anon;
grant execute on function app.upload_path_reserved(text, text) to authenticated, service_role;

do $storage$
declare
  b record;
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;  -- a local test Postgres has no storage schema
  end if;

  -- The temporary area for spoken-command audio: service only, no policy for people.
  insert into storage.buckets (id, name, public) values ('command-audio', 'command-audio', false)
  on conflict (id) do nothing;

  -- Sizes and types from BUCKETS in src/lib/limits.ts (limits.test.ts reads this block).
  for b in
    select * from (values
      ('machine-photos',   20000000::bigint, array['image/*']),
      ('fault-photos',     20000000::bigint, array['image/*']),
      ('checklist-photos', 20000000::bigint, array['image/*']),
      ('fault-voice',      20000000::bigint, array['audio/*', 'video/webm']),
      ('jobcard-photos',   50000000::bigint, array['image/*', 'application/pdf']),
      ('machine-docs',     50000000::bigint, array['image/*', 'application/pdf']),
      ('partner-docs',     50000000::bigint, array['image/*', 'application/pdf']),
      ('partner-receipts', 50000000::bigint, array['image/*', 'application/pdf']),
      ('finance-docs',     50000000::bigint, array['image/*', 'application/pdf']),
      ('billing-proofs',   50000000::bigint, array['image/*', 'application/pdf']),
      ('command-audio',    20000000::bigint, array['audio/*', 'video/webm'])
    ) as t(id, size_limit, mimes)
  loop
    update storage.buckets
       set file_size_limit = b.size_limit, allowed_mime_types = b.mimes, public = false
     where id = b.id;
  end loop;

  -- Restrictive, so they narrow the farm-bucket policies and widen nothing; inert while
  -- app.upload_settings.enforce_reserved_paths is false. Signed uploads (the pipeline) are
  -- checked by Storage against their token, not by these.
  execute 'drop policy if exists upload_reserved_insert on storage.objects';
  execute 'drop policy if exists upload_reserved_update on storage.objects';
  execute $p$
    create policy upload_reserved_insert on storage.objects as restrictive for insert to authenticated
    with check (
      bucket_id <> all (array['machine-photos', 'machine-docs', 'fault-photos', 'fault-voice',
                              'jobcard-photos', 'checklist-photos', 'partner-docs', 'finance-docs',
                              'partner-receipts'])
      or not app.upload_reserved_paths_enforced()
      or app.upload_path_reserved(bucket_id, name))
  $p$;
  execute $p$
    create policy upload_reserved_update on storage.objects as restrictive for update to authenticated
    using (
      bucket_id <> all (array['machine-photos', 'machine-docs', 'fault-photos', 'fault-voice',
                              'jobcard-photos', 'checklist-photos', 'partner-docs', 'finance-docs',
                              'partner-receipts'])
      or not app.upload_reserved_paths_enforced())
  $p$;
end
$storage$;
