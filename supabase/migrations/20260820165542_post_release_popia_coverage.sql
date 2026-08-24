-- 20260820165542_post_release_popia_coverage.sql
--
-- POPIA follow-up for 0506-0508. Those releases add report delivery addresses,
-- per-user permission decisions and API-token administration. This migration makes
-- those records participate in the existing data-subject access/erasure workflow.
--
-- Important boundaries:
--   * report recipient email is removed from audit diffs (including legacy diffs);
--   * a farm manager may not run an account-wide DSAR when any of these records tie
--     the subject to another farm;
--   * exports include subject-linked records, redact third-party recipients and never
--     expose an API token hash;
--   * erasure removes stored delivery addresses and revokes live grants/credentials,
--     while retaining de-identified structural history.

-- -----------------------------------------------------------------------------
-- Recipient audit: the fact that a destination changed is useful; a second,
-- append-only copy of the destination address is not.
-- -----------------------------------------------------------------------------
create or replace function app.app_report_schedule_recipient_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_diff jsonb;
begin
  begin
    v_user := auth.uid();
  exception when others then
    v_user := null;
  end;

  if tg_op = 'DELETE' then
    v_diff := pg_catalog.jsonb_build_object(
      'old', pg_catalog.to_jsonb(old) - array['email']::text[]
    );
    insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
    values (old.farm_id, v_user, tg_table_name, old.id, 'delete', v_diff);
    return old;
  elsif tg_op = 'UPDATE' then
    v_diff := pg_catalog.jsonb_build_object(
      'old', pg_catalog.to_jsonb(old) - array['email']::text[],
      'new', pg_catalog.to_jsonb(new) - array['email']::text[]
    );
  else
    v_diff := pg_catalog.jsonb_build_object(
      'new', pg_catalog.to_jsonb(new) - array['email']::text[]
    );
  end if;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (new.farm_id, v_user, tg_table_name, new.id, pg_catalog.lower(tg_op), v_diff);
  return new;
end;
$$;

revoke all on function app.app_report_schedule_recipient_audit()
  from public, anon, authenticated, service_role;

drop trigger if exists report_schedule_recipients_audit
  on public.report_schedule_recipients;
create trigger report_schedule_recipients_audit
  after insert or update or delete on public.report_schedule_recipients
  for each row execute function app.app_report_schedule_recipient_audit();

-- 0506 may already have been live before this follow-up. Remove any address copies
-- produced by its original generic app_audit() trigger without changing the audit event.
update public.audit_log
set diff = ((coalesce(diff, '{}'::jsonb) #- '{old,email}'::text[])
                                                #- '{new,email}'::text[])
where entity = 'report_schedule_recipients'
  and (diff #> '{old,email}' is not null or diff #> '{new,email}' is not null);

-- -----------------------------------------------------------------------------
-- Cross-farm guard. The account-level RPCs aggregate and erase the whole subject,
-- so a primary-farm owner/manager must hand the request to rr_admin whenever any
-- historical record below belongs to a different farm.
-- -----------------------------------------------------------------------------
create or replace function app.assert_local_person_scope(
  p_user uuid,
  p_primary_farm uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_email text;
begin
  if app.is_rr_admin() then
    return;
  end if;

  select pg_catalog.lower(nullif(pg_catalog.btrim(u.email), ''))
    into v_subject_email
    from public.users u
   where u.id = p_user;

  if p_primary_farm is null
     or exists (
       select 1 from public.user_farm_memberships m
        where m.user_id = p_user and m.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.usage_logs x
        where x.driver_user_id = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.meter_readings x
        where x.by_user = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.faults x
        where x.reported_by = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.job_cards x
        where (x.mechanic_user_id = p_user or x.approved_by = p_user)
          and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.cost_entries x
        where x.created_by = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.attachments x
        where x.created_by = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.notifications x
        where x.user_id = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.voice_captures x
        where x.user_id = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.ai_interactions x
        where x.user_id = p_user and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.report_schedules x
        where (x.created_by = p_user or x.deleted_by = p_user)
          and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.report_schedule_recipients x
        where (x.user_id = p_user
            or x.created_by = p_user
            or x.deleted_by = p_user
            or (v_subject_email is not null
                and pg_catalog.lower(pg_catalog.btrim(x.email)) = v_subject_email))
          and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.report_schedule_runs x
        where x.farm_id <> p_primary_farm
          and (x.deleted_by = p_user
            or (v_subject_email is not null and exists (
              select 1
                from pg_catalog.unnest(x.recipients) as recipient(address)
               where pg_catalog.lower(pg_catalog.btrim(recipient.address)) = v_subject_email
            )))
     )
     or exists (
       select 1 from public.user_permission_grants x
        where (x.user_id = p_user or x.granted_by = p_user or x.deleted_by = p_user)
          and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.api_tokens x
        where (x.created_by = p_user or x.revoked_by = p_user or x.deleted_by = p_user)
          and x.farm_id <> p_primary_farm
     )
     or exists (
       select 1 from public.audit_log x
        where x.user_id = p_user and x.farm_id <> p_primary_farm
     ) then
    raise exception 'Cross-farm data-subject requests require a FleetWise administrator.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function app.assert_local_person_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- ACCESS: preserve every core + voice field from the current export, then add the
-- 0506-0508 records. Third-party addresses are deliberately not disclosed in the
-- subject's bundle, even when the subject created the schedule.
-- -----------------------------------------------------------------------------
create or replace function public.export_personal_data(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_farm          uuid;
  v_out           jsonb;
  v_subject_email text;
begin
  v_farm := app.assert_can_manage_person(p_user, 'export');
  perform app.assert_local_person_scope(p_user, v_farm);

  select pg_catalog.lower(nullif(pg_catalog.btrim(u.email), ''))
    into v_subject_email
    from public.users u
   where u.id = p_user;

  select pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'subject_id',   p_user,
    'note', 'POPIA data-subject access export. Money in integer cents ex-VAT. '
         || 'Driver-usage logs are retained under a legal-obligation basis (AARTO); see docs/POPIA.md.',
    'profile', (select pg_catalog.to_jsonb(u) from public.users u where u.id = p_user),
    'usage_logs', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.occurred_on desc), '[]'::jsonb)
      from public.usage_logs x where x.driver_user_id = p_user and x.deleted_at is null),
    'meter_readings', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.meter_readings x where x.by_user = p_user and x.deleted_at is null),
    'faults_reported', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.faults x where x.reported_by = p_user and x.deleted_at is null),
    'job_cards', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.job_cards x where (x.mechanic_user_id = p_user or x.approved_by = p_user) and x.deleted_at is null),
    'cost_entries_created', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.cost_entries x where x.created_by = p_user and x.deleted_at is null),
    'attachments_created', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.attachments x where x.created_by = p_user and x.deleted_at is null),
    'notifications', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.notifications x where x.user_id = p_user and x.deleted_at is null),
    'voice_captures', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.voice_captures x where x.user_id = p_user and x.deleted_at is null),
    'ai_interactions', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.ai_interactions x where x.user_id = p_user and x.deleted_at is null),
    'report_schedules_created', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.report_schedules x where x.created_by = p_user),
    'report_schedules_deleted', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.updated_at desc), '[]'::jsonb)
      from public.report_schedules x where x.deleted_by = p_user and x.created_by is distinct from p_user),
    'report_recipient_assignments', (
      select coalesce(
        pg_catalog.jsonb_agg(
          (pg_catalog.to_jsonb(x) - 'email')
          || pg_catalog.jsonb_build_object(
               'email', case
                 when v_subject_email is not null
                  and pg_catalog.lower(pg_catalog.btrim(x.email)) = v_subject_email
                 then x.email
                 else null
               end
             )
          order by x.created_at desc
        ),
        '[]'::jsonb
      )
      from public.report_schedule_recipients x
      where x.user_id = p_user
         or x.created_by = p_user
         or x.deleted_by = p_user
         or (v_subject_email is not null
             and pg_catalog.lower(pg_catalog.btrim(x.email)) = v_subject_email)),
    'report_deliveries', (
      select coalesce(
        pg_catalog.jsonb_agg(
          (pg_catalog.to_jsonb(x) - 'recipients')
          || pg_catalog.jsonb_build_object(
               'recipients', coalesce((
                 select pg_catalog.jsonb_agg(
                   case
                     when v_subject_email is not null
                      and pg_catalog.lower(pg_catalog.btrim(recipient.address)) = v_subject_email
                     then recipient.address
                     else '[redacted]'
                   end
                   order by recipient.ordinality
                 )
                 from pg_catalog.unnest(x.recipients) with ordinality
                   as recipient(address, ordinality)
               ), '[]'::jsonb)
             )
          order by x.created_at desc
        ),
        '[]'::jsonb
      )
      from public.report_schedule_runs x
      where x.deleted_by = p_user
         or exists (
           select 1 from public.report_schedules s
            where s.id = x.schedule_id
              and (s.created_by = p_user or s.deleted_by = p_user)
         )
         or (v_subject_email is not null and exists (
           select 1
             from pg_catalog.unnest(x.recipients) as recipient(address)
            where pg_catalog.lower(pg_catalog.btrim(recipient.address)) = v_subject_email
         ))),
    'permission_grants_received', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.user_permission_grants x where x.user_id = p_user),
    'permission_grant_activity', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', x.id,
            'farm_id', x.farm_id,
            'permission', x.permission,
            'granted_by_subject', x.granted_by = p_user,
            'deleted_by_subject', x.deleted_by = p_user,
            'created_at', x.created_at,
            'deleted_at', x.deleted_at
          ) order by x.created_at desc
        ),
        '[]'::jsonb
      )
      from public.user_permission_grants x
      where (x.granted_by = p_user or x.deleted_by = p_user)
        and x.user_id is distinct from p_user),
    'api_token_activity', (
      select coalesce(
        pg_catalog.jsonb_agg((pg_catalog.to_jsonb(x) - 'token_hash') order by x.created_at desc),
        '[]'::jsonb
      )
      from public.api_tokens x
      where x.created_by = p_user or x.revoked_by = p_user or x.deleted_by = p_user),
    'audit_actions', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'entity', entity, 'entity_id', entity_id, 'action', action, 'at', at) order by at desc), '[]'::jsonb)
      from public.audit_log where user_id = p_user)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.export_personal_data(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.export_personal_data(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- ERASURE: preserve the core + voice anonymisation, then remove the live identity
-- surfaces added in 0506-0508. Historical delivery arrays retain only `[erased]`.
-- -----------------------------------------------------------------------------
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
      'ai_records_scrubbed', v_ai_scrub,
      'report_recipient_assignments_erased', v_report_recipient_scrub,
      'report_delivery_addresses_redacted', v_report_delivery_scrub,
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
    'ai_records_scrubbed', v_ai_scrub,
    'report_recipient_assignments_erased', v_report_recipient_scrub,
    'report_delivery_addresses_redacted', v_report_delivery_scrub,
    'permission_grants_revoked', v_permission_grants_revoked,
    'api_tokens_revoked', v_api_tokens_revoked,
    'note', 'Identity anonymised and account deactivated. Structural history (maintenance, '
         || 'finance, scheduled-report delivery, and legally-retained AARTO driver-usage '
         || 'records) is preserved de-identified.'
  );
end;
$$;

revoke all on function public.erase_personal_data(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.erase_personal_data(uuid, text) to authenticated;

notify pgrst, 'reload schema';
