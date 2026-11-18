-- 20261120110000_complete_export.sql
-- The complete export: a business's records AND its photos, PDFs and kept voice notes, prepared
-- as a durable job, delivered through private expiring links (BRIEF section 16; decision 35;
-- scenarios 20 and 29). Built on B3's streamed record export (the same table list) and on
-- e36b9bd's rules: chat and command audio are never exported, archive paths are hashed and
-- portable, and the lifecycle decides who may export (only the owner during the 90 days).
--
-- == How a job runs ==============================================================================
--   1. START (the requester's own session): the route checks the role and the lifecycle, then
--      public.export_job_create (service role, actor passed) makes the job with its cutoff. The
--      file list is read with the REQUESTER'S session through public.export_readable_files, a
--      SECURITY INVOKER function, so Storage's own row security decides which objects are
--      listed; the list is the authorised inventory at the cutoff (farm_export_job_files).
--   2. RECORDS, in bounded steps driven by the requester's page with their session (row
--      security decides every row, as in the streamed export), written as numbered ZIP parts.
--   3. FILES, in bounded steps: the bytes of the inventoried objects, through the requester's
--      session when their page drives it, or by the nightly worker with the service role, which
--      may copy only what the inventory lists and checks public.export_job_allowed first (the
--      requester still active, still owner or manager, and the lifecycle still allows them).
--      A file that cannot be read is retried, then reported missing with its reason.
--   4. FINISH: a manifest with table row counts, every file's size and SHA-256 and its part,
--      each part's size and SHA-256, the missing files and the omissions.
-- Steps hold a lease (export_job_claim), so two tabs or a tab and the worker never copy twice;
-- a part is named by its number and uploaded with upsert, so a step that dies after its upload
-- and before its record is repeated onto the same object, never a duplicate.
--
-- == Where archives live =========================================================================
-- Bucket farm-exports, private, with no policy for any signed-in person: links are signed by the
-- server after it checks the requester and the window. Paths are exports/<farm>/<job>/..., not
-- under the business's own folder, so they are never counted in its storage pool
-- (app.storage_untracked) and never offered by the per-bucket file download or listed by
-- public.farm_file_objects. Archives are kept seven days at most and never past the owner's last
-- reading day, then removed by the nightly cleanup in bounded batches; objects whose job no longer
-- exists (a closed account) are swept too.
--
-- == Safe on live data ===========================================================================
-- Two new tables, one new private bucket, new functions. Nothing existing changes.
set lock_timeout = '3s';

do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('farm-exports', 'farm-exports', false)
    on conflict (id) do update set public = false;
  end if;
end
$storage$;

create table if not exists public.farm_export_jobs (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.farms(id),
  requested_by     uuid not null references public.users(id) on delete cascade,
  request_id       uuid not null unique,
  requester_role   text not null check (requester_role in ('owner', 'manager', 'rr_admin')),
  status           text not null default 'records'
                     check (status in ('records', 'files', 'finishing', 'ready', 'failed', 'expired', 'cancelled')),
  cutoff_at        timestamptz not null default now(),
  inventory_done   boolean not null default false,
  files_capped     boolean not null default false,
  records_cursor   jsonb not null default '{}'::jsonb,
  tables           jsonb not null default '[]'::jsonb,
  parts            jsonb not null default '[]'::jsonb,
  files_total      integer not null default 0 check (files_total >= 0),
  files_done       integer not null default 0 check (files_done >= 0),
  files_missing    integer not null default 0 check (files_missing >= 0),
  bytes_total      bigint not null default 0 check (bytes_total >= 0),
  bytes_done       bigint not null default 0 check (bytes_done >= 0),
  manifest_sha256  text,
  last_error       text check (last_error is null or length(last_error) <= 300),
  lease_token      uuid,
  lease_until      timestamptz,
  ready_at         timestamptz,
  expires_at       timestamptz,
  removed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- One job in progress per business at a time.
create unique index if not exists farm_export_jobs_active_uq on public.farm_export_jobs (farm_id)
  where status in ('records', 'files', 'finishing');
create index if not exists farm_export_jobs_requester_idx on public.farm_export_jobs (requested_by, created_at desc);
create index if not exists farm_export_jobs_cleanup_idx on public.farm_export_jobs (expires_at) where removed_at is null;
comment on table public.farm_export_jobs is
  'A complete export (records and files) of one business for one requester, prepared in bounded '
  'steps, with its cutoff, progress, parts and expiry (20261120110000).';

create table if not exists public.farm_export_job_files (
  job_id        uuid not null references public.farm_export_jobs(id) on delete cascade,
  farm_id       uuid not null references public.farms(id),
  seq           integer not null check (seq >= 1),
  bucket        text not null,
  name          text not null,
  size          bigint not null default 0 check (size >= 0),
  status        text not null default 'pending' check (status in ('pending', 'copied', 'missing')),
  reason        text check (reason is null or reason in ('not_found', 'refused', 'error')),
  attempts      integer not null default 0 check (attempts between 0 and 100),
  archive_path  text,
  sha256        text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  part          integer check (part is null or part >= 1),
  primary key (job_id, seq),
  constraint farm_export_job_files_copied_ck check (status <> 'copied' or (archive_path is not null and sha256 is not null and part is not null))
);
create index if not exists farm_export_job_files_pending_idx on public.farm_export_job_files (job_id, seq) where status = 'pending';
comment on table public.farm_export_job_files is
  'The authorised file inventory of an export at its cutoff, listed with the requester''s session, '
  'and what became of each file (20261120110000).';

alter table public.farm_export_jobs enable row level security;
alter table public.farm_export_jobs force row level security;
alter table public.farm_export_job_files enable row level security;
alter table public.farm_export_job_files force row level security;
revoke all on public.farm_export_jobs, public.farm_export_job_files from public, anon, authenticated;
grant select on public.farm_export_jobs to authenticated;
grant all on public.farm_export_jobs, public.farm_export_job_files to service_role;
-- The requester reads their own jobs; the file inventory is the server's (service role only).
drop policy if exists farm_export_jobs_sel on public.farm_export_jobs;
create policy farm_export_jobs_sel on public.farm_export_jobs for select to authenticated
  using (requested_by = (select auth.uid()));
drop trigger if exists farm_export_jobs_audit on public.farm_export_jobs;
create trigger farm_export_jobs_audit after insert or delete on public.farm_export_jobs
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('farm_export_jobs', 'rapid_rise', 'who exported a business and when')
on conflict (table_name) do nothing;
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('farm_export_jobs', 'open', 'taking the records away must never depend on paying first'),
  ('farm_export_job_files', 'open', 'the export''s file list (service only)')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('farm_export_jobs');
select app.pay_gate_apply('farm_export_job_files');

-- == The file list, judged by the requester's own session ========================================
-- SECURITY INVOKER: run as the signed-in person, Storage's row security on storage.objects decides
-- which of the business's objects they may read (the pay gate included, 20261112100000). Never
-- chat files, command audio or export archives. Keyset paging on (bucket, name).
create or replace function public.export_readable_files(p_farm uuid, p_after_bucket text, p_after_name text, p_limit integer)
returns table (bucket_id text, name text, size bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if p_farm is null or to_regclass('storage.objects') is null then return; end if;
  return query execute
    $q$ select o.bucket_id::text, o.name::text, coalesce((o.metadata ->> 'size')::bigint, 0)
          from storage.objects o
         where split_part(o.name, '/', 1) = $1::text
           and o.bucket_id not in ('chat-files', 'command-audio', 'farm-exports', 'billing-proofs',
                                   'partner-docs', 'partner-receipts', 'partner-branding', 'menu-media')
           and (o.bucket_id::text, o.name::text) > (coalesce($2, ''), coalesce($3, ''))
         order by o.bucket_id, o.name
         limit least(greatest(coalesce($4, 1000), 1), 1000) $q$
    using p_farm, p_after_bucket, p_after_name, p_limit;
end $$;
revoke all on function public.export_readable_files(uuid, text, text, integer) from public, anon;
grant execute on function public.export_readable_files(uuid, text, text, integer) to authenticated;

-- == May this requester still export this business? ==============================================
-- The server-side mirror of exportRefusal (src/lib/farm-export-policy.ts), for a worker acting
-- without the person's session: still active, still the owner or a manager of it (or Rapid Rise
-- staff, never a test account), and the lifecycle still lets them: an open business for owner and
-- manager, the owner alone while the 90 days of reading run.
create or replace function app.export_member_role(p_user uuid, p_farm uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when u.role = 'rr_admin' and not u.is_test then 'rr_admin'
    when u.farm_id = p_farm and u.role in ('owner', 'manager') then u.role::text
    else (select m.role::text from public.user_farm_memberships m
           where m.user_id = u.id and m.farm_id = p_farm and m.active and m.deleted_at is null
             and m.role in ('owner', 'manager')
           order by case m.role when 'owner' then 0 else 1 end limit 1)
  end
  from public.users u
  where u.id = p_user and u.active and u.deleted_at is null;
$$;
revoke all on function app.export_member_role(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.export_allowed(p_user uuid, p_farm uuid, p_today date) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role text := app.export_member_role(p_user, p_farm);
  v_life jsonb;
begin
  if v_role is null then return false; end if;
  if v_role = 'rr_admin' then return true; end if;
  v_life := app.farm_lifecycle(p_farm, p_today);
  if v_life ->> 'gate' = 'ok' then return true; end if;
  if v_life ->> 'gate' not in ('suspended', 'closed') or v_role <> 'owner' then return false; end if;
  if v_life ->> 'state' = 'closed' and v_life ->> 'reason' is distinct from 'rapid_rise' then return false; end if;
  return true;
end $$;
revoke all on function app.export_allowed(uuid, uuid, date) from public, anon, authenticated, service_role;

create or replace function public.export_job_allowed(p_job uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select app.export_allowed(j.requested_by, j.farm_id, app.billing_today())
                     from public.farm_export_jobs j where j.id = p_job), false);
$$;

-- == Start ======================================================================================
-- Idempotent by the screen's request id; one job in progress per business (the one running is
-- returned); at most five started per business per South African day, since each copies every file.
create or replace function public.export_job_create(p_by uuid, p_farm uuid, p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.farm_export_jobs%rowtype;
  v_role text := app.export_member_role(p_by, p_farm);
  v_today date := app.billing_today();
begin
  if p_request is null or p_farm is null then raise exception 'export-invalid' using errcode = '22023'; end if;
  select * into j from public.farm_export_jobs where request_id = p_request;
  if found then
    if j.farm_id <> p_farm or j.requested_by <> p_by then raise exception 'export-invalid' using errcode = '22023'; end if;
    return jsonb_build_object('id', j.id, 'created', false);
  end if;
  if not app.export_allowed(p_by, p_farm, v_today) then raise exception 'export-not-allowed' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('export:' || p_farm::text, 0));
  select * into j from public.farm_export_jobs where farm_id = p_farm and status in ('records', 'files', 'finishing');
  if found then return jsonb_build_object('id', j.id, 'created', false, 'running', true); end if;
  if (select count(*) from public.farm_export_jobs
       where farm_id = p_farm and app.billing_date_of(created_at) = v_today) >= 5 then
    raise exception 'export-limit' using errcode = '22023';
  end if;
  insert into public.farm_export_jobs (farm_id, requested_by, request_id, requester_role)
  values (p_farm, p_by, p_request, v_role)
  returning * into j;
  return jsonb_build_object('id', j.id, 'created', true);
end $$;

-- == One step at a time ==========================================================================
create or replace function public.export_job_claim(p_job uuid, p_seconds integer)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid := gen_random_uuid();
begin
  update public.farm_export_jobs
     set lease_token = v_token, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 600)),
         updated_at = now()
   where id = p_job and status in ('records', 'files', 'finishing')
     and (lease_until is null or lease_until < now());
  if not found then return null; end if;
  return v_token;
end $$;

create or replace function public.export_job_release(p_job uuid, p_token uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.farm_export_jobs set lease_token = null, lease_until = null, updated_at = now()
   where id = p_job and lease_token = p_token;
$$;

-- What a files step did, recorded together under the lease: copied files with their part and
-- checksum, failed attempts, files given up as missing; the counters follow from the rows.
create or replace function public.export_job_record_files(p_job uuid, p_token uuid, p_part jsonb, p_rows jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not exists (select 1 from public.farm_export_jobs where id = p_job and lease_token = p_token and lease_until > now()) then
    raise exception 'export-lease-lost' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    update public.farm_export_job_files f
       set status = coalesce(r ->> 'status', f.status),
           reason = case when r ->> 'status' = 'missing' then r ->> 'reason' else null end,
           attempts = f.attempts + coalesce((r ->> 'attempted')::integer, 0),
           archive_path = case when r ->> 'status' = 'copied' then r ->> 'archive_path' else f.archive_path end,
           sha256 = case when r ->> 'status' = 'copied' then r ->> 'sha256' else f.sha256 end,
           part = case when r ->> 'status' = 'copied' then (r ->> 'part')::integer else f.part end
     where f.job_id = p_job and f.seq = (r ->> 'seq')::integer and f.status = 'pending';
  end loop;
  update public.farm_export_jobs j
     set parts = case when p_part is null then j.parts else j.parts || jsonb_build_array(p_part) end,
         files_done = (select count(*) from public.farm_export_job_files f where f.job_id = p_job and f.status = 'copied'),
         files_missing = (select count(*) from public.farm_export_job_files f where f.job_id = p_job and f.status = 'missing'),
         bytes_done = (select coalesce(sum(f.size), 0) from public.farm_export_job_files f where f.job_id = p_job and f.status = 'copied'),
         status = case when not exists (select 1 from public.farm_export_job_files f where f.job_id = p_job and f.status = 'pending')
                       then 'finishing' else j.status end,
         updated_at = now()
   where j.id = p_job;
end $$;

-- The manifest is stored: ready, and kept seven days at most, never past the end of the owner's
-- last reading day (South African midnight) when the business is in its 90 days.
create or replace function public.export_job_finish(p_job uuid, p_token uuid, p_manifest_sha256 text)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.farm_export_jobs%rowtype;
  v_end date;
  v_expires timestamptz := now() + interval '7 days';
begin
  select * into j from public.farm_export_jobs where id = p_job and lease_token = p_token and lease_until > now() for update;
  if not found then raise exception 'export-lease-lost' using errcode = '22023'; end if;
  if j.status <> 'finishing' or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'export-invalid' using errcode = '22023'; end if;
  v_end := nullif(app.farm_lifecycle(j.farm_id, app.billing_today()) ->> 'retrieval_ends_on', '')::date;
  if v_end is not null then v_expires := least(v_expires, app.billing_day_ends_at(v_end)); end if;
  update public.farm_export_jobs
     set status = 'ready', ready_at = now(), expires_at = v_expires, manifest_sha256 = p_manifest_sha256,
         last_error = null, updated_at = now()
   where id = p_job;
  return v_expires;
end $$;

-- The owner asks again for the files that were missing: back to pending, a new attempt count.
create or replace function public.export_job_retry_missing(p_by uuid, p_job uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.farm_export_jobs%rowtype; v_n integer;
begin
  select * into j from public.farm_export_jobs where id = p_job for update;
  if not found or j.requested_by <> p_by then raise exception 'forbidden' using errcode = '42501'; end if;
  if j.status <> 'ready' or j.removed_at is not null or j.files_missing = 0 then raise exception 'export-nothing-to-retry' using errcode = '22023'; end if;
  if not app.export_allowed(p_by, j.farm_id, app.billing_today()) then raise exception 'export-not-allowed' using errcode = '22023'; end if;
  if exists (select 1 from public.farm_export_jobs x where x.farm_id = j.farm_id and x.status in ('records', 'files', 'finishing')) then
    raise exception 'export-running' using errcode = '22023';
  end if;
  update public.farm_export_job_files set status = 'pending', reason = null, attempts = 0
   where job_id = p_job and status = 'missing';
  get diagnostics v_n = row_count;
  update public.farm_export_jobs
     set status = 'files', files_missing = 0, ready_at = null, manifest_sha256 = null, updated_at = now()
   where id = p_job;
  return v_n;
end $$;

-- == Cleanup =====================================================================================
-- Jobs whose archive is due to go: finished and past their keeping time, failed or cancelled a
-- day ago, or left in the records phase for a week by a requester who never came back (marked
-- failed first). Bounded per run; the nightly step removes their objects and then marks them.
create or replace function public.export_jobs_to_clean(p_limit integer)
returns table (id uuid, farm_id uuid, parts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.farm_export_jobs j
     set status = 'failed', last_error = 'abandoned: the export was not continued for seven days', updated_at = now()
   where j.status in ('records', 'files', 'finishing') and j.updated_at < now() - interval '7 days';
  -- Past the owner's reading window, an unfinished job stops too: nobody may take it any more.
  update public.farm_export_jobs j
     set status = 'failed', last_error = 'access ended', updated_at = now()
   where j.status in ('records', 'files', 'finishing') and not app.export_allowed(j.requested_by, j.farm_id, app.billing_today());
  return query
    select j.id, j.farm_id, jsonb_array_length(j.parts)
      from public.farm_export_jobs j
     where j.removed_at is null
       and ((j.status = 'ready' and j.expires_at < now())
            or (j.status in ('failed', 'cancelled', 'expired') and j.updated_at < now() - interval '1 day'))
     order by j.updated_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;

create or replace function public.export_job_mark_removed(p_job uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.farm_export_jobs
     set removed_at = now(), status = case when status = 'ready' then 'expired' else status end, updated_at = now()
   where id = p_job and removed_at is null;
$$;

-- Archive objects whose job is gone (a permanent closure deletes the rows) or already removed.
create or replace function public.export_orphan_objects(p_limit integer)
returns table (name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  return query execute
    $q$ select o.name::text from storage.objects o
         where o.bucket_id = 'farm-exports'
           and not exists (select 1 from public.farm_export_jobs j
                            where j.id::text = split_part(o.name, '/', 3) and j.removed_at is null)
         order by o.name
         limit least(greatest(coalesce($1, 200), 1), 1000) $q$
    using p_limit;
end $$;

do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.export_job_allowed(uuid)'::regprocedure,
    'public.export_job_create(uuid,uuid,uuid)'::regprocedure,
    'public.export_job_claim(uuid,integer)'::regprocedure,
    'public.export_job_release(uuid,uuid)'::regprocedure,
    'public.export_job_record_files(uuid,uuid,jsonb,jsonb)'::regprocedure,
    'public.export_job_retry_missing(uuid,uuid)'::regprocedure,
    'public.export_job_finish(uuid,uuid,text)'::regprocedure,
    'public.export_jobs_to_clean(integer)'::regprocedure,
    'public.export_job_mark_removed(uuid)'::regprocedure,
    'public.export_orphan_objects(integer)'::regprocedure]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
reset lock_timeout;
