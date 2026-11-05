-- Erasing a person removes the voice notes they recorded (20261105090000).
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name) values ('9d000000-0000-4000-9000-000000000001', 'Erasure Voice Farm');
insert into auth.users (id, email) values
  ('9d100000-0000-4000-9000-000000000001', 'ev.owner@example.test'),
  ('9d100000-0000-4000-9000-000000000002', 'ev.subject@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('9d100000-0000-4000-9000-000000000001', '9d000000-0000-4000-9000-000000000001', 'owner', 'EV Owner', 'ev.owner@example.test'),
  ('9d100000-0000-4000-9000-000000000002', '9d000000-0000-4000-9000-000000000001', 'operator', 'EV Subject', 'ev.subject@example.test');
insert into public.machines (id, farm_id, name, type, meter_type) values
  ('9d200000-0000-4000-9000-000000000001', '9d000000-0000-4000-9000-000000000001', 'EV Tractor', 'tractor', 'hours');
insert into public.faults (id, farm_id, machine_id, reported_by, reporter_name, description) values
  ('9d300000-0000-4000-9000-000000000001', '9d000000-0000-4000-9000-000000000001', '9d200000-0000-4000-9000-000000000001',
   '9d100000-0000-4000-9000-000000000002', 'EV Subject', 'Leaking under the cab');
insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path, created_by) values
  -- The subject's own voice note and photo on the fault.
  ('9d400000-0000-4000-9000-000000000001', '9d000000-0000-4000-9000-000000000001', 'fault', '9d300000-0000-4000-9000-000000000001',
   'voice', '9d000000-0000-4000-9000-000000000001/9d300000/voice-a.webm', '9d100000-0000-4000-9000-000000000002'),
  ('9d400000-0000-4000-9000-000000000002', '9d000000-0000-4000-9000-000000000001', 'fault', '9d300000-0000-4000-9000-000000000001',
   'photo', '9d000000-0000-4000-9000-000000000001/9d300000/photo-a.jpg', '9d100000-0000-4000-9000-000000000002'),
  -- The owner's voice note on the same fault: not the subject's to erase.
  ('9d400000-0000-4000-9000-000000000003', '9d000000-0000-4000-9000-000000000001', 'fault', '9d300000-0000-4000-9000-000000000001',
   'voice', '9d000000-0000-4000-9000-000000000001/9d300000/voice-b.webm', '9d100000-0000-4000-9000-000000000001');

set role authenticated;
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"9d100000-0000-4000-9000-000000000001","role":"authenticated"}', false);
do $$
declare v_result jsonb;
begin
  v_result := public.erase_personal_data('9d100000-0000-4000-9000-000000000002', 'erasure voice test');
  if (v_result ->> 'voice_notes_removed')::int <> 1 then
    raise exception 'ERASE VOICE FAIL: % voice note(s) removed, expected the subject''s one: %',
      v_result ->> 'voice_notes_removed', v_result;
  end if;
  if v_result -> 'voice_note_paths' <> '["9d000000-0000-4000-9000-000000000001/9d300000/voice-a.webm"]'::jsonb then
    raise exception 'ERASE VOICE FAIL: the paths to delete are %', v_result -> 'voice_note_paths';
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

do $$
declare v_audit jsonb;
begin
  if (select deleted_at from public.attachments where id = '9d400000-0000-4000-9000-000000000001') is null then
    raise exception 'ERASE VOICE FAIL: the subject''s voice note is still live';
  end if;
  if (select deleted_at from public.attachments where id = '9d400000-0000-4000-9000-000000000002') is not null then
    raise exception 'ERASE VOICE FAIL: the subject''s photo of the machine was removed; only their voice is personal';
  end if;
  if (select deleted_at from public.attachments where id = '9d400000-0000-4000-9000-000000000003') is not null then
    raise exception 'ERASE VOICE FAIL: another person''s voice note was removed';
  end if;
  if (select description from public.faults where id = '9d300000-0000-4000-9000-000000000001') is distinct from 'Leaking under the cab'
     or (select reporter_name from public.faults where id = '9d300000-0000-4000-9000-000000000001') is not null then
    raise exception 'ERASE VOICE FAIL: the fault should keep its text and lose the reporter''s name';
  end if;
  -- The audit row counts what went; it does not carry the storage paths.
  select diff into v_audit from public.audit_log
   where entity = 'data_subject_erasure' and entity_id = '9d100000-0000-4000-9000-000000000002'
   order by id desc limit 1;
  if (v_audit ->> 'voice_notes_removed')::int is distinct from 1 or v_audit ? 'voice_note_paths' then
    raise exception 'ERASE VOICE FAIL: audit diff is %', v_audit;
  end if;
end $$;

rollback;
