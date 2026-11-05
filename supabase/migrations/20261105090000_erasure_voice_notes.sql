-- 20261105090000_erasure_voice_notes.sql
-- Erasing a person removes the voice notes they recorded (launch tracker "Voice notes and
-- POPIA erasure"). erase_personal_data already blanked their name on faults and their
-- assistant transcripts; their recorded fault voice notes were left in place. They are
-- now soft-deleted here, and the paths are returned so the team action deletes the audio
-- from the fault-voice bucket. Same signature: grants carry over.

create or replace function public.erase_personal_data(
  p_user uuid,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_farm                       uuid;
  v_subject_email              text;
  v_usage_scrub                bigint;
  v_fault_scrub                bigint;
  v_voice_scrub                bigint;
  v_ai_scrub                   bigint;
  v_report_recipient_scrub     bigint;
  v_report_delivery_scrub      bigint;
  v_permission_grants_revoked  bigint;
  v_api_tokens_revoked         bigint;
  v_audit_location_scrub       bigint;
  v_voice_note_paths           text[];
begin
  if p_user = auth.uid() then
    raise exception 'you cannot erase your own account here';
  end if;

  v_farm := app.assert_can_manage_person(p_user, 'erasure');
  perform app.assert_local_person_scope(p_user, v_farm);

  -- Capture and lock the address before the profile is anonymised. Case-folding and
  -- trimming mirror the matching used by the export and cross-farm guard.
  select pg_catalog.lower(nullif(pg_catalog.btrim(u.email), ''))
    into v_subject_email
    from public.users u
   where u.id = p_user
   for update;

  update public.users set
    name                          = '[erased]',
    email                         = null,
    phone                         = null,
    whatsapp_opt_in              = false,
    ai_processing_opt_in         = false,
    active                        = false,
    deleted_at                    = coalesce(deleted_at, pg_catalog.now()),
    deleted_by                   = auth.uid()
  where id = p_user;

  update public.usage_logs set driver_name = null
    where driver_user_id = p_user and driver_name is not null;
  get diagnostics v_usage_scrub = row_count;

  update public.faults set reporter_name = null
    where reported_by = p_user and reporter_name is not null;
  get diagnostics v_fault_scrub = row_count;

  update public.voice_captures set
    transcript = null,
    normalized_transcript = null,
    audio_storage_path = null,
    error_detail = null,
    status = 'cancelled',
    deleted_at = coalesce(deleted_at, pg_catalog.now()),
    deleted_by = auth.uid()
  where user_id = p_user;
  get diagnostics v_voice_scrub = row_count;

  -- The voice notes they recorded on fault reports (20261105090000). A recording of a
  -- person's voice is their personal information, and unlike their name on the fault it
  -- cannot be blanked in place: the attachment goes, and the action deletes the audio
  -- from storage using the paths returned below. The fault and its text stay.
  with gone as (
    update public.attachments a
       set deleted_at = coalesce(a.deleted_at, pg_catalog.now()),
           deleted_by = coalesce(a.deleted_by, auth.uid())
     where a.created_by = p_user
       and a.kind = 'voice'
       and a.deleted_at is null
     returning a.storage_path
  )
  select coalesce(pg_catalog.array_agg(g.storage_path) filter (where g.storage_path is not null), '{}')
    into v_voice_note_paths
    from gone g;

  update public.ai_interactions set
    input_text = null,
    normalized_input = null,
    response_text = null,
    tool_args = '{}'::jsonb,
    error_detail = null,
    deleted_at = coalesce(deleted_at, pg_catalog.now()),
    deleted_by = auth.uid()
  where user_id = p_user;
  get diagnostics v_ai_scrub = row_count;

  -- A recipient row must keep exactly one of user_id/email populated. Linked-user rows
  -- can retain the now-anonymised UUID; typed addresses are replaced with a unique,
  -- non-routable RFC-reserved `.invalid` address before every matching row is retired.
  update public.report_schedule_recipients x
     set email = case
           when v_subject_email is not null
            and pg_catalog.lower(pg_catalog.btrim(x.email)) = v_subject_email
           then 'erased-' || pg_catalog.replace(x.id::text, '-', '') || '@invalid.invalid'
           else x.email
         end,
         deleted_at = coalesce(x.deleted_at, pg_catalog.now()),
         deleted_by = coalesce(x.deleted_by, auth.uid())
   where x.user_id = p_user
      or (v_subject_email is not null
          and pg_catalog.lower(pg_catalog.btrim(x.email)) = v_subject_email);
  get diagnostics v_report_recipient_scrub = row_count;

  update public.report_schedule_runs x
     set recipients = (
       select coalesce(
         pg_catalog.array_agg(
           case
             when pg_catalog.lower(pg_catalog.btrim(recipient.address)) = v_subject_email
             then '[erased]'
             else recipient.address
           end
           order by recipient.ordinality
         ),
         array[]::text[]
       )
       from pg_catalog.unnest(x.recipients) with ordinality
         as recipient(address, ordinality)
     )
   where v_subject_email is not null
     and exists (
       select 1
         from pg_catalog.unnest(x.recipients) as recipient(address)
        where pg_catalog.lower(pg_catalog.btrim(recipient.address)) = v_subject_email
     );
  get diagnostics v_report_delivery_scrub = row_count;

  update public.user_permission_grants x
     set deleted_at = coalesce(x.deleted_at, pg_catalog.now()),
         deleted_by = coalesce(x.deleted_by, auth.uid())
   where x.user_id = p_user
     and x.deleted_at is null;
  get diagnostics v_permission_grants_revoked = row_count;

  update public.api_tokens x
     set revoked_at = coalesce(x.revoked_at, pg_catalog.now()),
         revoked_by = coalesce(x.revoked_by, auth.uid())
   where x.created_by = p_user
     and x.deleted_at is null
     and x.revoked_at is null;
  get diagnostics v_api_tokens_revoked = row_count;

  -- Where this person acted from, cleared on erasure (founder decision, August 2026).
  --
  -- audit_log is otherwise retained in full by the documented section 4.4 exception: the
  -- diff, the entity and the timestamp are the integrity record, and a legal-retention
  -- argument rests on them. None of that needs an IP address. An IP is simultaneously the
  -- most identifying field in the row and the least load-bearing, so on an explicit
  -- erasure request it is exactly the field that should go. The action stays correctly
  -- attributed to the (now anonymised) actor.
  --
  -- Only rows the SUBJECT wrote. An audit row recording somebody else acting against this
  -- person carries that other person location, not theirs, and is not the subject to erase.
  update public.audit_log a
     set ip          = null,
         geo_country = null,
         geo_region  = null,
         geo_city    = null,
         user_agent  = null
   where a.user_id = p_user
     and (a.ip is not null or a.user_agent is not null
          or a.geo_country is not null or a.geo_region is not null or a.geo_city is not null);
  get diagnostics v_audit_location_scrub = row_count;
  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (
    v_farm,
    auth.uid(),
    'data_subject_erasure',
    p_user,
    'erasure',
    pg_catalog.jsonb_build_object(
      'by', auth.uid(),
      'subject', p_user,
      'reason', nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
      'usage_names_cleared', v_usage_scrub,
      'fault_names_cleared', v_fault_scrub,
      'voice_records_scrubbed', v_voice_scrub,
      'voice_notes_removed', pg_catalog.cardinality(v_voice_note_paths),
      'ai_records_scrubbed', v_ai_scrub,
      'report_recipient_assignments_erased', v_report_recipient_scrub,
      'report_delivery_addresses_redacted', v_report_delivery_scrub,
      'audit_location_scrubbed', v_audit_location_scrub,
      'permission_grants_revoked', v_permission_grants_revoked,
      'api_tokens_revoked', v_api_tokens_revoked,
      'at', pg_catalog.now()
    )
  );

  return pg_catalog.jsonb_build_object(
    'erased', true,
    'subject_id', p_user,
    'usage_names_cleared', v_usage_scrub,
    'fault_names_cleared', v_fault_scrub,
    'voice_records_scrubbed', v_voice_scrub,
    'voice_notes_removed', pg_catalog.cardinality(v_voice_note_paths),
    -- For the caller to delete from the fault-voice bucket; not written to the audit log.
    'voice_note_paths', pg_catalog.to_jsonb(v_voice_note_paths),
    'ai_records_scrubbed', v_ai_scrub,
    'report_recipient_assignments_erased', v_report_recipient_scrub,
    'report_delivery_addresses_redacted', v_report_delivery_scrub,
    'audit_location_scrubbed', v_audit_location_scrub,
    'permission_grants_revoked', v_permission_grants_revoked,
    'api_tokens_revoked', v_api_tokens_revoked,
    'note', 'Identity anonymised and account deactivated. Structural history (maintenance, '
         || 'finance, scheduled-report delivery, and legally-retained AARTO driver-usage '
         || 'records) is preserved de-identified.'
  );
end;
$$;
