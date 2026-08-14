-- Atomic operational commands and proposal application for the FleetWise assistant.
--
-- The public record_* functions remain useful to ordinary signed-in forms. They are
-- SECURITY INVOKER and explicitly enforce the selected farm's effective role and
-- machine visibility before relying on the existing RLS policies.
--
-- apply_assistant_proposal is the sole voice-confirmation write boundary. It must be
-- SECURITY DEFINER because browser clients deliberately have no UPDATE grant on the
-- private ai_interactions/voice_captures tables. Every authority, ownership, plan,
-- visibility, state and payload invariant is therefore rechecked inside the function.

-- -----------------------------------------------------------------------------
-- Selected-farm role and visibility
-- -----------------------------------------------------------------------------

create or replace function app.effective_farm_role(
  p_user uuid,
  p_farm uuid
) returns user_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.users%rowtype;
  v_role user_role;
begin
  -- Do not make this helper an arbitrary-user role oracle. Every app call asks for
  -- the caller's own effective role; SECURITY DEFINER only bypasses users/membership
  -- RLS so the answer cannot be distorted by the selected farm.
  if p_user is null or p_farm is null or auth.uid() is distinct from p_user then
    return null;
  end if;

  select * into v_user
    from public.users
   where id = p_user
     and active
     and deleted_at is null;
  if not found then
    return null;
  end if;

  if v_user.role = 'rr_admin' then
    return 'rr_admin'::user_role;
  end if;
  if v_user.role = 'workshop' then
    return null;
  end if;

  -- An active membership is authoritative on every selected farm, including the
  -- primary farm. users.role is a compatibility fallback only for older primary-farm
  -- rows that predate the membership backfill.
  select m.role into v_role
    from public.user_farm_memberships m
   where m.user_id = p_user
     and m.farm_id = p_farm
     and m.active
     and m.deleted_at is null;

  if v_role is not null then
    return v_role;
  end if;

  if v_user.farm_id = p_farm
     and v_user.role in ('owner','manager','mechanic','operator') then
    return v_user.role;
  end if;

  return null;
end $$;

revoke execute on function app.effective_farm_role(uuid, uuid)
  from public, anon, service_role;
grant execute on function app.effective_farm_role(uuid, uuid)
  to authenticated;

-- Replace the primary-role implementation from 0400. Partner/workshop scoping is
-- preserved byte-for-byte; only the farm-side operator decision becomes per-farm.
create or replace function app.row_visible_to_role(
  p_farm uuid,
  p_machine uuid
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.has_farm_access(p_farm)
     and (
       app.effective_farm_role(auth.uid(), p_farm) is distinct from 'operator'
       or (
         p_machine is not null
         and exists (
           select 1
             from public.machines m
            where m.id = p_machine
              and m.farm_id = p_farm
              and m.deleted_at is null
              and m.assigned_operator_id = auth.uid()
         )
       )
     )
     and app.partner_machine_visible(p_farm, p_machine);
$$;

revoke execute on function app.row_visible_to_role(uuid, uuid)
  from public, anon;
grant execute on function app.row_visible_to_role(uuid, uuid)
  to authenticated, service_role;

drop policy if exists machines_sel on public.machines;
create policy machines_sel on public.machines for select to authenticated
  using (
    app.has_farm_access(farm_id)
    and deleted_at is null
    and (
      app.effective_farm_role(auth.uid(), farm_id) is distinct from 'operator'
      or assigned_operator_id = auth.uid()
    )
    and app.partner_machine_visible(farm_id, id)
  );

-- Alias management follows the role on the alias's farm, not users.role on the
-- person's primary farm. Workshops remain excluded because their effective role is
-- null; rr_admin retains the support bypass.
drop policy if exists asset_aliases_ins on public.asset_aliases;
create policy asset_aliases_ins on public.asset_aliases for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role(auth.uid(), farm_id)
        in ('owner','manager','mechanic','rr_admin')
  );

drop policy if exists asset_aliases_upd on public.asset_aliases;
create policy asset_aliases_upd on public.asset_aliases for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role(auth.uid(), farm_id)
        in ('owner','manager','mechanic','rr_admin')
  )
  with check (
    app.has_farm_access(farm_id)
    and app.effective_farm_role(auth.uid(), farm_id)
        in ('owner','manager','mechanic','rr_admin')
  );

drop policy if exists asset_aliases_del on public.asset_aliases;
create policy asset_aliases_del on public.asset_aliases for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and app.effective_farm_role(auth.uid(), farm_id)
        in ('owner','manager','mechanic','rr_admin')
  );

-- -----------------------------------------------------------------------------
-- Shared atomic operational commands
-- -----------------------------------------------------------------------------

create or replace function public.record_fault(
  p_farm uuid,
  p_machine uuid,
  p_description text,
  p_urgency fault_urgency default 'can_work',
  p_category text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic','operator') then
    raise exception 'This person may not report a fault.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null
     or char_length(btrim(p_description)) > 2000 then
    raise exception 'A fault description between 1 and 2000 characters is required.'
      using errcode = '22023';
  end if;
  if p_category is not null and char_length(btrim(p_category)) > 80 then
    raise exception 'A fault category may not exceed 80 characters.'
      using errcode = '22023';
  end if;
  if p_urgency is null then
    raise exception 'Fault urgency is required.' using errcode = '22023';
  end if;

  -- The row lock makes assignment/soft-delete stable through the insert. This is an
  -- explicit authorization check, not merely an existence query hidden behind RLS.
  perform 1
    from public.machines m
   where m.id = p_machine
     and m.farm_id = p_farm
     and m.deleted_at is null
     and app.row_visible_to_role(p_farm, p_machine)
   for key share;
  if not found then
    raise exception 'Machine not found or not assigned to this person.'
      using errcode = '42501';
  end if;

  insert into public.faults(
    farm_id, machine_id, reported_by, description, category, urgency, status
  ) values (
    p_farm, p_machine, auth.uid(), btrim(p_description),
    nullif(btrim(coalesce(p_category, '')), ''), p_urgency, 'open'
  ) returning id into v_id;

  return v_id;
end $$;

create or replace function public.record_meter_reading(
  p_farm uuid,
  p_machine uuid,
  p_reading numeric,
  p_reading_date date default current_date,
  p_driver_user uuid default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
  v_driver uuid := auth.uid();
  v_current_reading numeric;
  v_current_date date;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic') then
    raise exception 'This person may not record a meter reading.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if p_reading is null or p_reading < 0 or p_reading > 99999999999.9
     or p_reading_date is null then
    raise exception 'A valid non-negative reading and date are required.'
      using errcode = '22023';
  end if;
  if p_reading_date > current_date then
    raise exception 'A meter reading cannot be dated in the future.'
      using errcode = '22023';
  end if;

  select m.current_reading, m.current_reading_date
    into v_current_reading, v_current_date
    from public.machines m
   where m.id = p_machine
     and m.farm_id = p_farm
     and m.deleted_at is null
     and app.row_visible_to_role(p_farm, p_machine)
   for update;
  if not found then
    raise exception 'Machine not found or not visible to this person.'
      using errcode = '42501';
  end if;
  if v_current_reading is not null
     and v_current_date is not null
     and p_reading_date >= v_current_date
     and p_reading < v_current_reading then
    raise exception 'A current/newer meter reading cannot decrease the machine''s reading.'
      using errcode = '22023';
  end if;

  -- Preserve the manual form's optional driver selection. An unknown, inactive or
  -- cross-farm ID safely falls back to the person capturing the reading.
  if p_driver_user is not null and exists (
    select 1
      from public.users u
     where u.id = p_driver_user
       and u.active
       and u.deleted_at is null
       and (
         u.farm_id = p_farm
         or exists (
           select 1
             from public.user_farm_memberships m
            where m.user_id = u.id
              and m.farm_id = p_farm
              and m.active
              and m.deleted_at is null
         )
       )
  ) then
    v_driver := p_driver_user;
  end if;

  insert into public.meter_readings(
    farm_id, machine_id, reading, reading_date, source, by_user
  ) values (
    p_farm, p_machine, p_reading, p_reading_date, 'manual', auth.uid()
  ) returning id into v_id;

  insert into public.usage_logs(
    farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source
  ) values (
    p_farm, p_machine, v_driver, p_reading_date, p_reading, 'app'
  );

  return v_id;
end $$;

create or replace function public.record_completed_service(
  p_farm uuid,
  p_machine uuid,
  p_meter_reading numeric,
  p_service_date date default current_date,
  p_work_performed text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
  v_vat_text text;
  v_vat_rate_bps integer := 1500;
  v_current_reading numeric;
  v_current_date date;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic') then
    raise exception 'This person may not record a completed service.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  if p_meter_reading is null or p_meter_reading < 0
     or p_meter_reading > 99999999999.9 or p_service_date is null then
    raise exception 'A valid non-negative service meter reading and date are required.'
      using errcode = '22023';
  end if;
  if p_service_date > current_date then
    raise exception 'A completed service cannot be dated in the future.'
      using errcode = '22023';
  end if;
  if char_length(coalesce(p_work_performed, '')) > 2000 then
    raise exception 'Service notes may not exceed 2000 characters.' using errcode = '22023';
  end if;

  select m.current_reading, m.current_reading_date
    into v_current_reading, v_current_date
    from public.machines m
   where m.id = p_machine
     and m.farm_id = p_farm
     and m.deleted_at is null
     and app.row_visible_to_role(p_farm, p_machine)
   for update;
  if not found then
    raise exception 'Machine not found or not visible to this person.'
      using errcode = '42501';
  end if;
  if v_current_reading is not null
     and v_current_date is not null
     and p_service_date >= v_current_date
     and p_meter_reading < v_current_reading then
    raise exception 'A current/newer service reading cannot decrease the machine''s reading.'
      using errcode = '22023';
  end if;

  -- Invalid, oversized or out-of-range tenant settings fall back safely to 15%.
  select f.settings ->> 'vat_rate_bps'
    into v_vat_text
    from public.farms f
   where f.id = p_farm
     and f.deleted_at is null;
  if v_vat_text ~ '^[0-9]{1,5}$'
     and v_vat_text::numeric between 0 and 10000 then
    v_vat_rate_bps := v_vat_text::integer;
  end if;

  insert into public.job_cards(
    farm_id, machine_id, type, status, date_in, meter_reading,
    reported_problem, work_performed, mechanic_user_id, vat_rate_bps
  ) values (
    p_farm, p_machine, 'scheduled_service', 'open', p_service_date, p_meter_reading,
    'Completed service recorded by FleetWise assistant',
    nullif(btrim(coalesce(p_work_performed, '')), ''), auth.uid(), v_vat_rate_bps
  ) returning id into v_id;

  -- No service-plan line is linked implicitly. Completion therefore records the
  -- generic service and meter reading but cannot claim/reset any specific checklist
  -- task. A later feature may pass explicit, human-confirmed line IDs.
  update public.job_cards
     set status = 'completed', date_out = p_service_date
   where id = v_id
     and farm_id = p_farm;

  return v_id;
end $$;

revoke execute on function public.record_fault(uuid, uuid, text, fault_urgency, text)
  from public, anon, service_role;
revoke execute on function public.record_meter_reading(uuid, uuid, numeric, date, uuid)
  from public, anon, service_role;
revoke execute on function public.record_completed_service(uuid, uuid, numeric, date, text)
  from public, anon, service_role;

grant execute on function public.record_fault(uuid, uuid, text, fault_urgency, text)
  to authenticated;
grant execute on function public.record_meter_reading(uuid, uuid, numeric, date, uuid)
  to authenticated;
grant execute on function public.record_completed_service(uuid, uuid, numeric, date, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- Atomic per-user assistant turn limiter
-- -----------------------------------------------------------------------------

create table app.assistant_turn_buckets (
  user_id       uuid        not null references public.users(id) on delete cascade,
  bucket_start  timestamptz not null,
  request_count smallint    not null check (request_count between 1 and 20),
  updated_at    timestamptz not null default now(),
  primary key (user_id, bucket_start)
);

create index assistant_turn_buckets_expiry_idx
  on app.assistant_turn_buckets(bucket_start);

alter table app.assistant_turn_buckets enable row level security;
alter table app.assistant_turn_buckets force row level security;
revoke all on table app.assistant_turn_buckets
  from public, anon, authenticated, service_role;

create or replace function public.consume_assistant_turn() returns boolean
language plpgsql
volatile
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_bucket timestamptz := date_trunc('minute', now());
  v_count smallint;
begin
  if v_user is null or not exists (
    select 1 from public.users u
     where u.id = v_user and u.active and u.deleted_at is null
  ) then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  -- Bounded housekeeping uses the expiry index and can remove at most 100 rows per
  -- request, so cleanup work cannot grow without limit on a foreground call.
  with expired as (
    select b.ctid
      from app.assistant_turn_buckets b
     where b.bucket_start < v_bucket - interval '10 minutes'
     order by b.bucket_start
     limit 100
  )
  delete from app.assistant_turn_buckets b
   using expired e
   where b.ctid = e.ctid;

  insert into app.assistant_turn_buckets as bucket(user_id, bucket_start, request_count)
  values (v_user, v_bucket, 1)
  on conflict (user_id, bucket_start) do update
     set request_count = bucket.request_count + 1,
         updated_at = now()
   where bucket.request_count < 20
  returning request_count into v_count;

  -- The ON CONFLICT row lock serializes competing increments. Once the stored count
  -- reaches 20, the conditional update returns no row and the request is denied.
  return v_count is not null;
end $$;

revoke execute on function public.consume_assistant_turn()
  from public, anon, service_role;
grant execute on function public.consume_assistant_turn()
  to authenticated;

-- -----------------------------------------------------------------------------
-- Atomic assistant proposal confirmation/rejection
-- -----------------------------------------------------------------------------

create or replace function public.apply_assistant_proposal(
  p_proposal_id uuid,
  p_action text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_interaction public.ai_interactions%rowtype;
  v_role user_role;
  v_args jsonb;
  v_intent text;
  v_machine uuid;
  v_confidence numeric;
  v_reading numeric;
  v_reading_date date;
  v_service_date date;
  v_linked_id uuid;
  v_linked_type text;
  v_message text;
  v_href text;
  v_capture_status text;
  v_error_code text;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_proposal_id is null or p_action is null
     or p_action not in ('confirm', 'reject') then
    return jsonb_build_object(
      'ok', false, 'code', 'bad_request',
      'message', 'A proposal ID and confirm/reject action are required.'
    );
  end if;

  -- A generic denial prevents an authenticated caller from probing another person's
  -- private proposal IDs. The lock serializes confirm/reject and makes retries exact.
  select * into v_interaction
    from public.ai_interactions i
   where i.id = p_proposal_id
     and i.user_id = v_user
     and i.deleted_at is null
   for update;
  if not found then
    raise exception 'Proposal not found.' using errcode = '42501';
  end if;

  -- Terminal retries are idempotent. Return the stored record/result without checking
  -- the requested action again and without performing another operational write.
  if v_interaction.result_status = 'applied'
     and v_interaction.confirmation_status = 'confirmed' then
    v_href := case v_interaction.linked_record_type
      when 'fault' then '/faults'
      when 'meter_reading' then
        case when jsonb_typeof(v_interaction.tool_args -> 'machineId') = 'string'
             then '/machines/' || (v_interaction.tool_args ->> 'machineId')
             else '/assistant' end
      when 'job_card' then '/jobcards/' || v_interaction.linked_record_id::text
      else '/assistant'
    end;
    return jsonb_build_object(
      'ok', true, 'action', 'confirm', 'status', 'applied',
      'message', coalesce(v_interaction.response_text, 'The change was already saved.'),
      'linkedRecordType', v_interaction.linked_record_type,
      'linkedRecordId', v_interaction.linked_record_id,
      'href', v_href, 'replayed', true
    );
  elsif v_interaction.result_status = 'rejected'
        and v_interaction.confirmation_status = 'rejected' then
    return jsonb_build_object(
      'ok', true, 'action', 'reject', 'status', 'rejected',
      'message', coalesce(v_interaction.response_text, 'Nothing was saved.'),
      'linkedRecordType', 'none', 'linkedRecordId', v_interaction.id,
      'href', '/assistant', 'replayed', true
    );
  elsif v_interaction.result_status = 'failed'
        or v_interaction.confirmation_status = 'failed' then
    return jsonb_build_object(
      'ok', false, 'code', coalesce(v_interaction.error_code, 'proposal_failed'),
      'message', coalesce(v_interaction.response_text, 'This proposal previously failed.'),
      'replayed', true
    );
  end if;

  if v_interaction.result_status <> 'proposed'
     or v_interaction.confirmation_status <> 'pending' then
    return jsonb_build_object(
      'ok', false, 'code', 'proposal_unavailable',
      'message', 'This proposal is not pending.'
    );
  end if;
  if v_interaction.proposal_expires_at is null
     or v_interaction.proposal_expires_at <= now() then
    update public.ai_interactions
       set result_status = 'failed',
           confirmation_status = 'failed',
           response_text = 'This proposal expired before it was applied.',
           error_code = 'proposal_expired',
           completed_at = now()
     where id = v_interaction.id;
    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'failed', error_code = 'proposal_expired'
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;
    return jsonb_build_object(
      'ok', false, 'code', 'proposal_expired',
      'message', 'This proposal has expired. Please start again.'
    );
  end if;

  -- Stabilise account, membership and plan authorization until this transaction ends.
  -- FOR UPDATE blocks the non-key UPDATEs used to deactivate an account/membership,
  -- change a selected-farm role, or downgrade the farm plan while confirmation runs.
  perform 1 from public.users u
   where u.id = v_user and u.active and u.deleted_at is null
   for update;
  if not found then
    raise exception 'Active account required.' using errcode = '42501';
  end if;
  perform 1 from public.user_farm_memberships m
   where m.user_id = v_user
     and m.farm_id = v_interaction.farm_id
     and m.active
     and m.deleted_at is null
   for update;
  perform 1 from public.farms f
   where f.id = v_interaction.farm_id and f.deleted_at is null
   for update;
  if not found then
    raise exception 'Farm not found.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(v_user, v_interaction.farm_id);
  if v_role is null or not app.has_farm_access(v_interaction.farm_id) then
    return jsonb_build_object(
      'ok', false, 'code', 'forbidden',
      'message', 'This farm is no longer available to your account.'
    );
  end if;
  if v_role <> 'rr_admin'
     and not app.has_entitlement(v_interaction.farm_id, 'voice_ai') then
    return jsonb_build_object(
      'ok', false, 'code', 'feature_unavailable',
      'message', 'Voice assistant access is no longer enabled for this farm.'
    );
  end if;

  if v_interaction.voice_capture_id is not null then
    select c.status into v_capture_status
      from public.voice_captures c
     where c.id = v_interaction.voice_capture_id
       and c.farm_id = v_interaction.farm_id
       and c.user_id = v_user
       and c.deleted_at is null
     for update;
    if not found or v_capture_status <> 'awaiting_confirmation' then
      return jsonb_build_object(
        'ok', false, 'code', 'invalid_capture',
        'message', 'The linked voice capture is not awaiting confirmation.'
      );
    end if;
  end if;

  if p_action = 'reject' then
    v_message := case v_interaction.locale
      when 'af-ZA' then 'Niks is gestoor nie.'
      else 'Nothing was saved.'
    end;

    update public.ai_interactions
       set result_status = 'rejected',
           confirmation_status = 'rejected',
           response_text = v_message,
           linked_record_type = null,
           linked_record_id = null,
           error_code = null,
           completed_at = now()
     where id = v_interaction.id;

    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'cancelled'
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;

    return jsonb_build_object(
      'ok', true, 'action', 'reject', 'status', 'rejected',
      'message', v_message, 'linkedRecordType', 'none',
      'linkedRecordId', v_interaction.id, 'href', '/assistant',
      'replayed', false
    );
  end if;

  -- Strict server-held proposal schema. jsonb has unique object keys, so exactly the
  -- eleven known keys plus no unknown key proves presence and excludes smuggled data.
  begin
    v_args := v_interaction.tool_args;
    if jsonb_typeof(v_args) <> 'object' then
      raise exception 'The proposal payload must be an object.' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(v_args)) <> 11
       or exists (
         select 1 from jsonb_object_keys(v_args) as k(key)
          where k.key <> all (array[
            'intent','machineQuery','machineId','description','category','urgency',
            'reading','readingDate','serviceDate','workPerformed','confidence'
          ])
       ) then
      raise exception 'The proposal payload has an invalid shape.' using errcode = '22023';
    end if;

    if coalesce(jsonb_typeof(v_args -> 'intent'), 'missing') <> 'string'
       or coalesce(jsonb_typeof(v_args -> 'machineId'), 'missing') <> 'string'
       or coalesce(jsonb_typeof(v_args -> 'confidence'), 'missing') <> 'number'
       or coalesce(jsonb_typeof(v_args -> 'machineQuery'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'description'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'category'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'urgency'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'reading'), 'missing') not in ('number','null')
       or coalesce(jsonb_typeof(v_args -> 'readingDate'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'serviceDate'), 'missing') not in ('string','null')
       or coalesce(jsonb_typeof(v_args -> 'workPerformed'), 'missing') not in ('string','null')
       or char_length(coalesce(v_args ->> 'machineQuery', '')) > 8000
       or char_length(coalesce(v_args ->> 'description', '')) > 2000
       or char_length(coalesce(v_args ->> 'category', '')) > 80
       or char_length(coalesce(v_args ->> 'urgency', '')) > 20
       or char_length(coalesce(v_args ->> 'reading', '')) > 32
       or char_length(coalesce(v_args ->> 'readingDate', '')) > 10
       or char_length(coalesce(v_args ->> 'serviceDate', '')) > 10
       or char_length(coalesce(v_args ->> 'workPerformed', '')) > 2000
       or char_length(v_args ->> 'machineId') <> 36
       or char_length(v_args ->> 'confidence') > 32 then
      raise exception 'The proposal payload contains invalid values.' using errcode = '22023';
    end if;

    v_confidence := (v_args ->> 'confidence')::numeric;
    if v_confidence is null or v_confidence not between 0 and 1
       or (v_args ->> 'machineId') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'The proposal confidence or machine ID is invalid.' using errcode = '22023';
    end if;

    v_intent := v_args ->> 'intent';
    v_machine := (v_args ->> 'machineId')::uuid;
    if v_intent is null or v_intent not in ('report_fault','log_reading','log_service')
       or v_interaction.intent is distinct from v_intent
       or v_interaction.tool_name is distinct from v_intent then
      raise exception 'The proposal intent is invalid or inconsistent.' using errcode = '22023';
    end if;
    if v_intent in ('log_reading','log_service')
       and v_role not in ('rr_admin','owner','manager','mechanic') then
      raise exception 'This farm role cannot record readings or completed services.'
        using errcode = '42501';
    end if;

    -- Stabilise visibility/assignment and meter state through the command. FOR UPDATE
    -- also prevents two concurrent reading/service proposals validating stale values.
    perform 1 from public.machines m
     where m.id = v_machine
       and m.farm_id = v_interaction.farm_id
       and m.deleted_at is null
       and app.row_visible_to_role(v_interaction.farm_id, v_machine)
     for update;
    if not found then
      raise exception 'The selected machine is no longer visible to this person.'
        using errcode = '42501';
    end if;

    if v_intent = 'report_fault' then
      if jsonb_typeof(v_args -> 'description') <> 'string'
       or nullif(btrim(v_args ->> 'description'), '') is null
       or jsonb_typeof(v_args -> 'urgency') <> 'string'
       or (v_args ->> 'urgency') not in ('can_work','limping','stopped')
       or jsonb_typeof(v_args -> 'category') not in ('string','null')
       or jsonb_typeof(v_args -> 'reading') <> 'null'
       or jsonb_typeof(v_args -> 'readingDate') <> 'null'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'null'
       or jsonb_typeof(v_args -> 'workPerformed') <> 'null' then
      raise exception 'The fault proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;

      v_linked_id := public.record_fault(
      v_interaction.farm_id,
      v_machine,
      v_args ->> 'description',
      (v_args ->> 'urgency')::fault_urgency,
      v_args ->> 'category'
    );
      v_linked_type := 'fault';
      v_href := '/faults';
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die fout is aangemeld.'
        else 'The fault was reported.'
      end;
    elsif v_intent = 'log_reading' then
      if jsonb_typeof(v_args -> 'reading') <> 'number'
       or jsonb_typeof(v_args -> 'readingDate') <> 'string'
       or (v_args ->> 'readingDate') !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(v_args -> 'description') <> 'null'
       or jsonb_typeof(v_args -> 'category') <> 'null'
       or jsonb_typeof(v_args -> 'urgency') <> 'null'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'null'
       or jsonb_typeof(v_args -> 'workPerformed') <> 'null' then
      raise exception 'The reading proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;
      begin
        v_reading := (v_args ->> 'reading')::numeric;
        v_reading_date := (v_args ->> 'readingDate')::date;
      exception when others then
        raise exception 'The reading value or date is invalid.' using errcode = '22023';
      end;
      if v_reading < 0 or v_reading > 99999999999.9
         or to_char(v_reading_date, 'YYYY-MM-DD') <> (v_args ->> 'readingDate')
         or v_reading_date > current_date then
        raise exception 'The reading date is invalid or in the future.' using errcode = '22023';
      end if;

      v_linked_id := public.record_meter_reading(
        v_interaction.farm_id, v_machine, v_reading, v_reading_date, null
      );
      v_linked_type := 'meter_reading';
      v_href := '/machines/' || v_machine::text;
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die lesing is aangeteken.'
        else 'The reading was saved.'
      end;
    else
      if jsonb_typeof(v_args -> 'reading') <> 'number'
       or jsonb_typeof(v_args -> 'serviceDate') <> 'string'
       or (v_args ->> 'serviceDate') !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(v_args -> 'workPerformed') not in ('string','null')
       or jsonb_typeof(v_args -> 'description') <> 'null'
       or jsonb_typeof(v_args -> 'category') <> 'null'
       or jsonb_typeof(v_args -> 'urgency') <> 'null'
       or jsonb_typeof(v_args -> 'readingDate') <> 'null' then
      raise exception 'The service proposal is incomplete or contains unrelated fields.'
        using errcode = '22023';
      end if;
      begin
        v_reading := (v_args ->> 'reading')::numeric;
        v_service_date := (v_args ->> 'serviceDate')::date;
      exception when others then
        raise exception 'The service reading or date is invalid.' using errcode = '22023';
      end;
      if v_reading < 0 or v_reading > 99999999999.9
         or to_char(v_service_date, 'YYYY-MM-DD') <> (v_args ->> 'serviceDate')
         or v_service_date > current_date then
        raise exception 'The service date is invalid or in the future.' using errcode = '22023';
      end if;

      v_linked_id := public.record_completed_service(
        v_interaction.farm_id,
        v_machine,
        v_reading,
        v_service_date,
        v_args ->> 'workPerformed'
      );
      v_linked_type := 'job_card';
      v_href := '/jobcards/' || v_linked_id::text;
      v_message := case v_interaction.locale
        when 'af-ZA' then 'Die voltooide diens is aangeteken.'
        else 'The completed service was saved.'
      end;
    end if;
  exception when others then
    v_error_code := case sqlstate
      when '42501' then 'forbidden'
      when '22023' then 'invalid_proposal'
      else 'command_failed'
    end;
    v_message := case v_error_code
      when 'forbidden' then 'FleetWise permissions no longer allow this proposal.'
      when 'invalid_proposal' then 'The proposal details are no longer valid.'
      else 'FleetWise could not save the confirmed change.'
    end;

    update public.ai_interactions
       set result_status = 'failed',
           confirmation_status = 'failed',
           response_text = v_message,
           error_code = v_error_code,
           completed_at = now()
     where id = v_interaction.id;
    if v_interaction.voice_capture_id is not null then
      update public.voice_captures
         set status = 'failed', error_code = v_error_code
       where id = v_interaction.voice_capture_id
         and farm_id = v_interaction.farm_id
         and user_id = v_user;
    end if;
    return jsonb_build_object(
      'ok', false, 'code', v_error_code, 'message', v_message,
      'replayed', false
    );
  end;

  update public.ai_interactions
     set result_status = 'applied',
         confirmation_status = 'confirmed',
         response_text = v_message,
         linked_record_type = v_linked_type,
         linked_record_id = v_linked_id,
         error_code = null,
         completed_at = now()
   where id = v_interaction.id;

  if v_interaction.voice_capture_id is not null then
    update public.voice_captures
       set status = 'applied',
           machine_id = v_machine,
           confirmed_at = now(),
           applied_at = now()
     where id = v_interaction.voice_capture_id
       and farm_id = v_interaction.farm_id
       and user_id = v_user;
  end if;

  return jsonb_build_object(
    'ok', true, 'action', 'confirm', 'status', 'applied',
    'message', v_message, 'linkedRecordType', v_linked_type,
    'linkedRecordId', v_linked_id, 'href', v_href,
    'replayed', false
  );
end $$;

revoke execute on function public.apply_assistant_proposal(uuid, text)
  from public, anon, service_role;
grant execute on function public.apply_assistant_proposal(uuid, text)
  to authenticated;
