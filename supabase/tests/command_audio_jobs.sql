\set ON_ERROR_STOP on
set client_min_messages to warning;
-- Ten-minute spoken commands (20261115100000): a job per uploaded recording, claimed with a
-- lease and a retry limit, taken over when its runner vanished, cancelled or tried again by
-- its own person; temporary audio named for removal once done, kept for the recovery
-- window when failed or unfinished, and never an attached voice note.
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

insert into public.farms (id, name, plan, status, billing_period) values
  ('c7000000-0000-4000-9000-000000000001', 'Command farm', 'complete', 'active', 'monthly');
insert into auth.users (id, email) values
  ('c7100000-0000-4000-9000-000000000001', 'command.owner@example.test'),
  ('c7100000-0000-4000-9000-000000000002', 'command.other@example.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('c7100000-0000-4000-9000-000000000001', 'c7000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'command.owner@example.test', true),
  ('c7100000-0000-4000-9000-000000000002', 'c7000000-0000-4000-9000-000000000001', 'manager', 'Other', 'command.other@example.test', true);
insert into public.machines (id, farm_id, name, type) values
  ('c7200000-0000-4000-9000-000000000001', 'c7000000-0000-4000-9000-000000000001', 'Command tractor', 'tractor');
insert into public.faults (id, farm_id, machine_id, description) values
  ('c7300000-0000-4000-9000-000000000001', 'c7000000-0000-4000-9000-000000000001', 'c7200000-0000-4000-9000-000000000001', 'Noise');

-- Three verified command recordings and one voice note attached to a fault.
insert into public.upload_intents (id, farm_id, user_id, target_kind, target_id, label, bucket, object_path,
  media_class, purpose, declared_mime, declared_bytes, counts_against_quota, status, actual_bytes, actual_mime,
  duration_ms, request_id, expires_at) values
  ('c7900000-0000-4000-9000-000000000001', 'c7000000-0000-4000-9000-000000000001', 'c7100000-0000-4000-9000-000000000001',
   'assistant_command', 'c7900000-0000-4000-9000-000000000001', 'command', 'command-audio', 'c7/a/command-1.webm',
   'command_audio', 'command_audio', 'audio/webm', 3600000, false, 'uploaded', 3600000, 'audio/webm', 600000, gen_random_uuid(), now() + interval '1 hour'),
  ('c7900000-0000-4000-9000-000000000002', 'c7000000-0000-4000-9000-000000000001', 'c7100000-0000-4000-9000-000000000001',
   'assistant_command', 'c7900000-0000-4000-9000-000000000002', 'command', 'command-audio', 'c7/a/command-2.webm',
   'command_audio', 'command_audio', 'audio/webm', 900000, false, 'uploaded', 900000, 'audio/webm', 150000, gen_random_uuid(), now() + interval '1 hour'),
  ('c7900000-0000-4000-9000-000000000003', 'c7000000-0000-4000-9000-000000000001', 'c7100000-0000-4000-9000-000000000001',
   'assistant_command', 'c7900000-0000-4000-9000-000000000003', 'command', 'command-audio', 'c7/a/command-3.webm',
   'command_audio', 'command_audio', 'audio/webm', 900000, false, 'uploaded', 900000, 'audio/webm', 150000, gen_random_uuid(), now() + interval '1 hour'),
  ('c7900000-0000-4000-9000-000000000004', 'c7000000-0000-4000-9000-000000000001', 'c7100000-0000-4000-9000-000000000001',
   'fault', 'c7300000-0000-4000-9000-000000000001', 'voice', 'fault-voice', 'c7/f/voice-4.webm',
   'voice', 'attachment', 'audio/webm', 900000, true, 'finalised', 900000, 'audio/webm', 150000, gen_random_uuid(), now() - interval '10 days');
update public.upload_intents set created_at = now() - interval '10 days' where id = 'c7900000-0000-4000-9000-000000000004';
-- A command recording uploaded a moment ago that never became a job (the page closed).
insert into public.upload_intents (id, farm_id, user_id, target_kind, target_id, label, bucket, object_path,
  media_class, purpose, declared_mime, declared_bytes, counts_against_quota, status, actual_bytes, actual_mime,
  request_id, expires_at) values
  ('c7900000-0000-4000-9000-000000000005', 'c7000000-0000-4000-9000-000000000001', 'c7100000-0000-4000-9000-000000000001',
   'assistant_command', 'c7900000-0000-4000-9000-000000000005', 'command', 'command-audio', 'c7/a/command-5.webm',
   'command_audio', 'command_audio', 'audio/webm', 1000, false, 'finalised', 1000, 'audio/webm', gen_random_uuid(), now() + interval '1 hour');

create temporary table t_jobs (name text primary key, id uuid) on commit drop;
grant all on t_jobs to authenticated;

set local role authenticated;
do $t$
declare
  v jsonb;
  v2 jsonb;
begin
  begin
    perform public.assistant_command_start('c7900000-0000-4000-9000-000000000001', 'en-ZA');
    raise exception 'an anonymous caller started a command';
  exception when insufficient_privilege then null;
  end;
  -- Someone else's recording, and an attachment, are not commands this person can start.
  perform public._t_login('c7100000-0000-4000-9000-000000000002');
  begin
    perform public.assistant_command_start('c7900000-0000-4000-9000-000000000001', 'en-ZA');
    raise exception 'another person started this command';
  exception when insufficient_privilege then null;
  end;
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  begin
    perform public.assistant_command_start('c7900000-0000-4000-9000-000000000004', 'en-ZA');
    raise exception 'a voice note attachment was taken for a command';
  exception when insufficient_privilege then null;
  end;

  v := public.assistant_command_start('c7900000-0000-4000-9000-000000000001', 'af-ZA');
  if v->>'status' <> 'queued' or (v->>'duration_ms')::integer <> 600000 then raise exception 'start: %', v; end if;
  if (v->>'recover_until')::timestamptz < now() + interval '71 hours' then raise exception 'recovery window: %', v; end if;
  v2 := public.assistant_command_start('c7900000-0000-4000-9000-000000000001', 'af-ZA');
  if v2->>'id' <> v->>'id' then raise exception 'a second start made a second job'; end if;
  insert into t_jobs values ('ten', (v->>'id')::uuid);
  insert into t_jobs values ('two', (public.assistant_command_start('c7900000-0000-4000-9000-000000000002', 'en-ZA')->>'id')::uuid);
  insert into t_jobs values ('three', (public.assistant_command_start('c7900000-0000-4000-9000-000000000003', 'en-ZA')->>'id')::uuid);

  -- Claimed once; a second runner while the lease holds gets nothing.
  v := public.assistant_command_claim((select id from t_jobs where name = 'ten'));
  if (v->>'claimed')::boolean is not true or (v->'job'->>'attempts')::integer <> 1 then raise exception 'claim: %', v; end if;
  v := public.assistant_command_claim((select id from t_jobs where name = 'ten'));
  if (v->>'claimed')::boolean then raise exception 'two runners held one job'; end if;

  -- Another person cannot claim, cancel or read it.
  perform public._t_login('c7100000-0000-4000-9000-000000000002');
  begin
    perform public.assistant_command_claim((select id from t_jobs where name = 'ten'));
    raise exception 'another person claimed the job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assistant_command_cancel((select id from t_jobs where name = 'ten'));
    raise exception 'another person cancelled the job';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.assistant_command_jobs) then raise exception 'another person read the jobs'; end if;
end $t$;

-- The runner vanished: its lease lapses and the next poll takes over (attempt two).
reset role;
update public.assistant_command_jobs set lease_until = now() - interval '1 minute' where id = (select id from t_jobs where name = 'ten');
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  v := public.assistant_command_claim((select id from t_jobs where name = 'ten'));
  if (v->>'claimed')::boolean is not true or (v->'job'->>'attempts')::integer <> 2 then raise exception 'takeover: %', v; end if;
end $t$;

-- A job already at its attempt limit is not run again by a claim.
reset role;
update public.assistant_command_jobs set attempts = 3 where id = (select id from t_jobs where name = 'three');
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  v := public.assistant_command_claim((select id from t_jobs where name = 'three'));
  if (v->>'claimed')::boolean or v->'job'->>'status' <> 'failed' or v->'job'->>'error_code' <> 'too_many_attempts' then
    raise exception 'a job past its limit was run: %', v;
  end if;
end $t$;

-- Retries stop at the limit; the person may try again within the window.
reset role;
do $t$
declare
  v jsonb;
  job uuid := (select id from t_jobs where name = 'ten');
begin
  v := app.assistant_command_record(job, 'retry', null, 'provider_timeout');
  if v->>'status' <> 'queued' then raise exception 'retry after attempt two: %', v; end if;
  update public.assistant_command_jobs set status = 'running', attempts = 3 where id = job;
  v := app.assistant_command_record(job, 'retry', null, 'provider_timeout');
  if v->>'status' <> 'failed' or v->>'error_code' <> 'provider_timeout' then raise exception 'the retry limit did not hold: %', v; end if;
end $t$;
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  v := public.assistant_command_claim((select id from t_jobs where name = 'ten'));
  if (v->>'claimed')::boolean then raise exception 'a failed job was claimed without a retry'; end if;
  v := public.assistant_command_retry((select id from t_jobs where name = 'ten'));
  if v->>'status' <> 'queued' or (v->>'attempts')::integer <> 0 then raise exception 'try again: %', v; end if;
  v := public.assistant_command_claim((select id from t_jobs where name = 'ten'));
  if (v->>'claimed')::boolean is not true then raise exception 'claim after try again: %', v; end if;
end $t$;

-- Heard and completed: the audio is named for removal at once. Failed and unfinished are
-- kept until their window passes; the attached voice note never.
reset role;
do $t$
declare
  v jsonb;
  ten uuid := (select id from t_jobs where name = 'ten');
  two uuid := (select id from t_jobs where name = 'two');
  three uuid := (select id from t_jobs where name = 'three');
  named jsonb;
  n integer;
begin
  v := app.assistant_command_record(ten, 'transcribed', repeat('Die trekker se hidroulika lek. ', 400), null);
  if v->>'status' <> 'transcribed' or char_length(v->>'transcript') < 12000 then raise exception 'a long transcript was not kept: %', v->>'status'; end if;
  v := app.assistant_command_record(ten, 'completed');
  if v->>'status' <> 'completed' then raise exception 'complete: %', v; end if;
  v := app.assistant_command_record(two, 'failed', null, 'provider_refused');

  named := app.command_audio_sweep(100);
  if not exists (select 1 from jsonb_array_elements(named) o where o->>'job' = ten::text) then
    raise exception 'completed command audio was not named for removal: %', named;
  end if;
  if exists (select 1 from jsonb_array_elements(named) o where o->>'job' in (two::text, three::text)) then
    raise exception 'a failed or unfinished command lost its audio inside the recovery window';
  end if;
  if exists (select 1 from jsonb_array_elements(named) o where o->>'intent' = 'c7900000-0000-4000-9000-000000000004') then
    raise exception 'an attached voice note was named as temporary command audio';
  end if;
  if exists (select 1 from jsonb_array_elements(named) o where o->>'intent' = 'c7900000-0000-4000-9000-000000000005') then
    raise exception 'a recording that may still become a command was removed early';
  end if;
  update public.upload_intents set created_at = now() - interval '73 hours' where id = 'c7900000-0000-4000-9000-000000000005';
  if not exists (select 1 from jsonb_array_elements(app.command_audio_sweep(100)) o where o->>'intent' = 'c7900000-0000-4000-9000-000000000005') then
    raise exception 'an abandoned command recording outlived its recovery window';
  end if;

  n := app.command_audio_removed(array[(select intent_id from public.assistant_command_jobs where id = ten)]);
  if n <> 1 then raise exception 'removed: %', n; end if;
  if (select audio_removed_at from public.assistant_command_jobs where id = ten) is null then raise exception 'not marked removed'; end if;
  if (select transcript from public.assistant_command_jobs where id = ten) is null then raise exception 'the transcript went with the audio'; end if;
  named := app.command_audio_sweep(100);
  if exists (select 1 from jsonb_array_elements(named) o where o->>'job' = ten::text) then raise exception 'removed audio named again'; end if;

  -- Past the recovery window, the failed command's audio goes too.
  update public.assistant_command_jobs set recover_until = now() - interval '1 minute' where id = two;
  named := app.command_audio_sweep(100);
  if not exists (select 1 from jsonb_array_elements(named) o where o->>'job' = two::text) then
    raise exception 'failed command audio outlived its recovery window';
  end if;
end $t$;

-- Cancelled by its person: its audio goes at once, and it does not come back.
set local role authenticated;
do $t$
declare v jsonb;
begin
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  v := public.assistant_command_cancel((select id from t_jobs where name = 'three'));
  if v->>'status' <> 'cancelled' then raise exception 'cancel: %', v; end if;
  v := public.assistant_command_retry((select id from t_jobs where name = 'three'));
  if v->>'status' <> 'cancelled' then raise exception 'a cancelled command came back: %', v; end if;
end $t$;
reset role;
do $t$
begin
  if not exists (select 1 from jsonb_array_elements(app.command_audio_sweep(100)) o
                  where o->>'job' = (select id from t_jobs where name = 'three')::text) then
    raise exception 'cancelled command audio was kept';
  end if;
  update public.assistant_command_jobs set audio_removed_at = now() where id = (select id from t_jobs where name = 'two');
end $t$;
-- A failed command whose audio is gone cannot be tried again.
set local role authenticated;
do $t$
declare failed text;
begin
  perform public._t_login('c7100000-0000-4000-9000-000000000001');
  begin
    perform public.assistant_command_retry((select id from t_jobs where name = 'two'));
  exception when sqlstate 'P0001' then failed := sqlerrm;
  end;
  if failed is distinct from 'command:expired' then raise exception 'retry after the audio went: %', failed; end if;
end $t$;

-- == Longer spoken requests are stored; people cannot write jobs or say what was heard ==
reset role;
do $t$
begin
  if exists (select 1 from pg_constraint c
              where c.conrelid in ('public.voice_captures'::regclass, 'public.ai_interactions'::regclass)
                and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%<= 8000%'
                and pg_get_constraintdef(c.oid) ~ '(transcript|input)') then
    raise exception 'a spoken request is still cut at 8,000 characters';
  end if;
  if has_function_privilege('authenticated', 'public.assistant_command_record(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cron_command_audio_sweep(integer)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.assistant_command_jobs', 'INSERT')
     or has_table_privilege('authenticated', 'public.assistant_command_jobs', 'UPDATE') then
    raise exception 'a person could write a job or state what was heard';
  end if;
  if has_function_privilege('anon', 'public.assistant_command_start(uuid,text)', 'EXECUTE') then
    raise exception 'anonymous callers can start commands';
  end if;
end $t$;

rollback;
