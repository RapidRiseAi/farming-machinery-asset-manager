-- 20261115100000_command_audio_jobs.sql
-- Ten-minute spoken commands (decision 11): the recording is heard by a durable job, and its
-- temporary audio is removed when the command is done (decision 13).
--
-- A spoken command longer than the instant hearing's one minute is recorded in the browser
-- (WebM/Opus, MP4/AAC or Ogg/Opus at a set bitrate), sent straight to Storage through the
-- upload pipeline as purpose `command_audio` into the private, service-only bucket
-- `command-audio` (20261115090000), and handed to a job here:
--
--   queued -> running (claimed with a lease, attempt counted) -> transcribed -> completed
--                  \-> failed (retryable until max_attempts) ; cancelled by its person
--
-- The job runs inside a request the browser makes and polls (POST .../run, within Vercel's
-- 300 s), never in a promise left behind after a response. A job whose runner vanished is
-- taken over once its lease lapses. The transcript becomes the person's spoken request,
-- which keeps the assistant's confirmation before any change; the audio is removed once the
-- command is completed or cancelled. A failed or unfinished command keeps its audio for a
-- recovery window (72 hours, an engineering default, not a contractual term) so the person
-- can try again; the nightly job removes it after that. Audio attached to a fault as a voice
-- note is a different thing (an attachment) and nothing here touches it.
--
-- Also: a spoken request may now hold 16,000 characters (ten minutes of fast speech), so the
-- 8,000-character checks on voice_captures and ai_interactions are widened. NOT VALID then
-- VALIDATE, so no table is locked against writes while existing rows are checked.

-- == Longer spoken requests ======================================================
do $widen$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as rel, c.conname, a.attname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'c'
       and c.conrelid in ('public.voice_captures'::regclass, 'public.ai_interactions'::regclass)
       and a.attname in ('transcript', 'normalized_transcript', 'input_text', 'normalized_input')
       and pg_get_constraintdef(c.oid) like '%<= 8000%'
  loop
    execute format('alter table %s drop constraint %I', r.rel, r.conname);
    execute format('alter table %s add constraint %I check (%I is null or char_length(%I) <= 16000) not valid',
      r.rel, r.conname, r.attname, r.attname);
    execute format('alter table %s validate constraint %I', r.rel, r.conname);
  end loop;
end
$widen$;

-- == The jobs ======================================================================
create table if not exists public.assistant_command_jobs (
  id             uuid primary key default gen_random_uuid(),
  farm_id        uuid not null references public.farms(id),
  user_id        uuid not null references public.users(id),
  intent_id      uuid not null unique references public.upload_intents(id),
  locale         text not null check (locale in ('en-ZA', 'af-ZA')),
  status         text not null default 'queued'
                   check (status in ('queued', 'running', 'transcribed', 'completed', 'failed', 'cancelled')),
  attempts       integer not null default 0 check (attempts >= 0),
  max_attempts   integer not null default 3 check (max_attempts between 1 and 10),
  lease_until    timestamptz,
  duration_ms    integer check (duration_ms is null or duration_ms >= 0),
  transcript     text check (transcript is null or char_length(transcript) <= 16000),
  error_code     text check (error_code is null or error_code ~ '^[a-z_]{2,40}$'),
  recover_until  timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  audio_removed_at timestamptz
);
create index if not exists assistant_command_jobs_user_idx on public.assistant_command_jobs (user_id, created_at desc);
create index if not exists assistant_command_jobs_sweep_idx on public.assistant_command_jobs (status, recover_until)
  where audio_removed_at is null;

alter table public.assistant_command_jobs enable row level security;
alter table public.assistant_command_jobs force row level security;
revoke all on public.assistant_command_jobs from public, anon, authenticated;
grant select on public.assistant_command_jobs to authenticated;
grant all on public.assistant_command_jobs to service_role;
drop policy if exists assistant_command_jobs_own on public.assistant_command_jobs;
create policy assistant_command_jobs_own on public.assistant_command_jobs for select to authenticated
  using (user_id = (select auth.uid()));
select app.pay_gate_apply('assistant_command_jobs');
comment on table public.assistant_command_jobs is
  'One spoken command being heard: its uploaded audio, status, attempts, lease and transcript. '
  'Written by the command functions only; a person reads their own (20261115100000).';

-- == Start (the person's session): the audio was uploaded and verified ==============
create or replace function public.assistant_command_start(p_intent uuid, p_locale text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.upload_intents;
  j public.assistant_command_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into i from public.upload_intents where id = p_intent;
  if not found or i.user_id <> auth.uid() or i.purpose <> 'command_audio' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not app.has_farm_access(i.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(i.farm_id, true);
  if i.status not in ('uploaded', 'finalised') then
    raise exception 'command:not_uploaded' using errcode = 'P0001';
  end if;
  if p_locale not in ('en-ZA', 'af-ZA') then
    raise exception 'command:locale' using errcode = 'P0001';
  end if;

  insert into public.assistant_command_jobs (farm_id, user_id, intent_id, locale, duration_ms, recover_until)
  values (i.farm_id, i.user_id, i.id, p_locale, i.duration_ms, now() + interval '72 hours')
  on conflict (intent_id) do nothing;
  select * into j from public.assistant_command_jobs where intent_id = i.id;
  return to_jsonb(j);
end $$;
revoke all on function public.assistant_command_start(uuid, text) from public, anon;
grant execute on function public.assistant_command_start(uuid, text) to authenticated;

-- Claim the job to run it (the person's session). Answers whether this caller now holds it.
create or replace function public.assistant_command_claim(p_job uuid, p_lease_seconds integer default 360)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.assistant_command_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into j from public.assistant_command_jobs where id = p_job for update;
  if not found or j.user_id <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(j.farm_id, true);
  if j.status = 'queued' or (j.status = 'running' and j.lease_until < now()) then
    if j.attempts >= j.max_attempts then
      update public.assistant_command_jobs
         set status = 'failed', error_code = coalesce(error_code, 'too_many_attempts'), lease_until = null, updated_at = now()
       where id = j.id returning * into j;
      return jsonb_build_object('claimed', false, 'job', to_jsonb(j));
    end if;
    update public.assistant_command_jobs
       set status = 'running', attempts = attempts + 1,
           lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 360), 60), 900)),
           error_code = null, updated_at = now()
     where id = j.id returning * into j;
    return jsonb_build_object('claimed', true, 'job', to_jsonb(j));
  end if;
  return jsonb_build_object('claimed', false, 'job', to_jsonb(j));
end $$;
revoke all on function public.assistant_command_claim(uuid, integer) from public, anon;
grant execute on function public.assistant_command_claim(uuid, integer) to authenticated;

-- The person cancels, or tries a failed command again within its recovery window.
create or replace function public.assistant_command_cancel(p_job uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.assistant_command_jobs;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.assistant_command_jobs
     set status = 'cancelled', lease_until = null, updated_at = now()
   where id = p_job and user_id = auth.uid() and status in ('queued', 'running', 'failed', 'transcribed')
  returning * into j;
  if not found then
    select * into j from public.assistant_command_jobs where id = p_job and user_id = auth.uid();
    if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;
  return to_jsonb(j);
end $$;
revoke all on function public.assistant_command_cancel(uuid) from public, anon;
grant execute on function public.assistant_command_cancel(uuid) to authenticated;

create or replace function public.assistant_command_retry(p_job uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.assistant_command_jobs;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into j from public.assistant_command_jobs where id = p_job and user_id = auth.uid() for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(j.farm_id, true);
  if j.status <> 'failed' then return to_jsonb(j); end if;
  if j.audio_removed_at is not null or j.recover_until < now() then
    raise exception 'command:expired' using errcode = 'P0001';
  end if;
  update public.assistant_command_jobs
     set status = 'queued', attempts = 0, error_code = null, lease_until = null, updated_at = now()
   where id = j.id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.assistant_command_retry(uuid) from public, anon;
grant execute on function public.assistant_command_retry(uuid) to authenticated;

-- == What the server heard (service only: a transcript comes from the provider) ====
create or replace function app.assistant_command_record(
  p_job uuid, p_outcome text, p_transcript text default null, p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.assistant_command_jobs;
begin
  select * into j from public.assistant_command_jobs where id = p_job for update;
  if not found then return null; end if;
  if j.status in ('completed', 'cancelled') then return to_jsonb(j); end if;
  if p_outcome = 'transcribed' then
    update public.assistant_command_jobs
       set status = 'transcribed', transcript = left(coalesce(p_transcript, ''), 16000), lease_until = null,
           error_code = null, updated_at = now()
     where id = j.id returning * into j;
  elsif p_outcome = 'completed' then
    update public.assistant_command_jobs
       set status = 'completed', completed_at = now(), lease_until = null, updated_at = now()
     where id = j.id and status = 'transcribed' returning * into j;
    if not found then select * into j from public.assistant_command_jobs where id = p_job; end if;
  elsif p_outcome = 'retry' then
    update public.assistant_command_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           error_code = left(coalesce(p_error, 'failed'), 40), lease_until = null, updated_at = now()
     where id = j.id returning * into j;
  elsif p_outcome = 'failed' then
    update public.assistant_command_jobs
       set status = 'failed', error_code = left(coalesce(p_error, 'failed'), 40), lease_until = null, updated_at = now()
     where id = j.id returning * into j;
  else
    raise exception 'command: unknown outcome %', p_outcome;
  end if;
  return to_jsonb(j);
end $$;
revoke all on function app.assistant_command_record(uuid, text, text, text) from public, anon, authenticated;
grant execute on function app.assistant_command_record(uuid, text, text, text) to service_role;

create or replace function public.assistant_command_record(
  p_job uuid, p_outcome text, p_transcript text default null, p_error text default null
) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.assistant_command_record(p_job, p_outcome, p_transcript, p_error);
$$;
revoke all on function public.assistant_command_record(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.assistant_command_record(uuid, text, text, text) to service_role;

-- == Temporary audio: removed when done, kept for the recovery window when not ======
-- Names the audio to remove, oldest first: completed and cancelled commands at once,
-- failed and unfinished ones once their recovery window has passed, and command uploads
-- that never became a job (abandoned) once theirs has. Never an attachment.
create or replace function app.command_audio_sweep(p_limit integer default 500)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('job', x.job_id, 'intent', x.intent_id, 'bucket', x.bucket, 'path', x.object_path)), '[]'::jsonb)
    from (
      select j.id as job_id, i.id as intent_id, i.bucket, i.object_path
        from public.assistant_command_jobs j
        join public.upload_intents i on i.id = j.intent_id
       where j.audio_removed_at is null and i.purpose = 'command_audio'
         and (j.status in ('completed', 'cancelled') or j.recover_until < now())
      union all
      select null, i.id, i.bucket, i.object_path
        from public.upload_intents i
       where i.purpose = 'command_audio' and i.object_removed_at is null
         and i.status in ('uploaded', 'finalised') and i.created_at < now() - interval '72 hours'
         and not exists (select 1 from public.assistant_command_jobs j where j.intent_id = i.id)
       order by 1 nulls last
       limit greatest(1, least(coalesce(p_limit, 500), 1000))
    ) x;
$$;
revoke all on function app.command_audio_sweep(integer) from public, anon, authenticated;
grant execute on function app.command_audio_sweep(integer) to service_role;

create or replace function app.command_audio_removed(p_intents uuid[])
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.assistant_command_jobs set audio_removed_at = now(), updated_at = now()
   where intent_id = any (p_intents) and audio_removed_at is null;
  update public.upload_intents set object_removed_at = now()
   where id = any (p_intents) and purpose = 'command_audio' and object_removed_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.command_audio_removed(uuid[]) from public, anon, authenticated;
grant execute on function app.command_audio_removed(uuid[]) to service_role;

create or replace function public.cron_command_audio_sweep(p_limit integer default 500)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app.command_audio_sweep(p_limit);
$$;
create or replace function public.cron_command_audio_removed(p_intents uuid[])
returns integer language sql security definer set search_path = public, pg_temp as $$
  select app.command_audio_removed(p_intents);
$$;
revoke all on function public.cron_command_audio_sweep(integer), public.cron_command_audio_removed(uuid[]) from public, anon, authenticated;
grant execute on function public.cron_command_audio_sweep(integer), public.cron_command_audio_removed(uuid[]) to service_role;
