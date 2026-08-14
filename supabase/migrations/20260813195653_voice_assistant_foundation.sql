-- Voice assistant foundation.
--
-- The assistant may propose operational changes, but it never writes them directly.
-- A later migration applies confirmed proposals through one authenticated, atomic RPC
-- that rechecks the subject, tenant, selected-farm role, entitlement and machine scope.
-- This migration stores private per-user captures/proposals, tenant-scoped aliases, and
-- explicit consent for cross-border LLM processing.

create extension if not exists pg_trgm;

-- Cross-border LLM processing is optional. Azure Speech remains in South Africa North
-- and does not depend on this consent. Timestamps/version are stamped by the database so
-- a browser cannot invent the consent record.
alter table public.users
  add column if not exists ai_processing_opt_in boolean not null default false,
  add column if not exists ai_processing_opted_in_at timestamptz,
  add column if not exists ai_processing_consent_version text,
  add column if not exists ai_processing_withdrawn_at timestamptz;

alter table public.users
  add constraint users_ai_processing_consent_ck check (
    (
      ai_processing_opt_in
      and ai_processing_opted_in_at is not null
      and nullif(btrim(ai_processing_consent_version), '') is not null
      and ai_processing_withdrawn_at is null
    )
    or (
      not ai_processing_opt_in
      and (
        -- Never opted in: there is no consent evidence to preserve.
        (ai_processing_opted_in_at is null
         and ai_processing_consent_version is null
         and ai_processing_withdrawn_at is null)
        or
        -- Withdrawn: retain when/version consent was given and when it ended.
        (ai_processing_opted_in_at is not null
         and nullif(btrim(ai_processing_consent_version), '') is not null
         and ai_processing_withdrawn_at is not null)
      )
    )
  );

create or replace function app.app_users_guard_ai_consent() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_changed boolean;
begin
  -- A profile is created before that person can consent. Discard any consent-looking
  -- values supplied by an invite/admin caller; only a later self-update may create the
  -- evidence below. This also keeps the table constraint valid for every new profile.
  if tg_op = 'INSERT' then
    new.ai_processing_opt_in := false;
    new.ai_processing_opted_in_at := null;
    new.ai_processing_consent_version := null;
    new.ai_processing_withdrawn_at := null;
    return new;
  end if;

  v_changed :=
       new.ai_processing_opt_in is distinct from old.ai_processing_opt_in
    or new.ai_processing_opted_in_at is distinct from old.ai_processing_opted_in_at
    or new.ai_processing_consent_version is distinct from old.ai_processing_consent_version
    or new.ai_processing_withdrawn_at is distinct from old.ai_processing_withdrawn_at;

  -- Account deactivation/erasure always withdraws consent. This branch deliberately
  -- permits the guarded POPIA erasure RPC to act on another person's profile.
  if not new.active or new.deleted_at is not null then
    new.ai_processing_opt_in := false;
    new.ai_processing_opted_in_at := old.ai_processing_opted_in_at;
    new.ai_processing_consent_version := old.ai_processing_consent_version;
    new.ai_processing_withdrawn_at := case
      when old.ai_processing_opt_in then now()
      else old.ai_processing_withdrawn_at
    end;
    return new;
  end if;

  if not v_changed then
    return new;
  end if;

  -- Consent is personal: even a service-role workflow may not manufacture it. The
  -- deactivation/erasure branch above may only withdraw consent, never grant it.
  if auth.uid() is null or auth.uid() <> old.id then
    raise exception 'Only this person may change their AI-processing consent.'
      using errcode = '42501';
  end if;

  if new.ai_processing_opt_in then
    if not old.ai_processing_opt_in then
      new.ai_processing_opted_in_at := now();
      new.ai_processing_consent_version := 'voice-ai-v1';
      new.ai_processing_withdrawn_at := null;
    else
      -- Consent is already active: do not let a client rewrite its evidence.
      new.ai_processing_opted_in_at := old.ai_processing_opted_in_at;
      new.ai_processing_consent_version := old.ai_processing_consent_version;
      new.ai_processing_withdrawn_at := null;
    end if;
  else
    new.ai_processing_opted_in_at := old.ai_processing_opted_in_at;
    new.ai_processing_consent_version := old.ai_processing_consent_version;
    new.ai_processing_withdrawn_at := case
      when old.ai_processing_opt_in then now()
      else old.ai_processing_withdrawn_at
    end;
  end if;

  return new;
end $$;

revoke execute on function app.app_users_guard_ai_consent()
  from public, anon, authenticated;

drop trigger if exists users_guard_ai_consent on public.users;
create trigger users_guard_ai_consent
  before insert or update on public.users
  for each row execute function app.app_users_guard_ai_consent();

-- A tenant-curated pronunciation/name dictionary. The machine's real name remains the
-- source of truth; aliases only help recognition and matching.
create table public.asset_aliases (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.farms(id),
  machine_id       uuid not null,
  alias            text not null check (char_length(btrim(alias)) between 1 and 120),
  normalized_alias text generated always as (
    regexp_replace(lower(btrim(alias)), '[[:space:]]+', ' ', 'g')
  ) stored,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  constraint asset_aliases_machine_fk foreign key (machine_id, farm_id)
    references public.machines(id, farm_id)
);

create unique index asset_aliases_live_alias_uq
  on public.asset_aliases(farm_id, normalized_alias)
  where deleted_at is null;
create index asset_aliases_machine_idx
  on public.asset_aliases(farm_id, machine_id)
  where deleted_at is null;
create index asset_aliases_trgm_idx
  on public.asset_aliases using gin (normalized_alias gin_trgm_ops)
  where deleted_at is null;

-- Raw audio is intentionally not retained by the MVP. Offline audio stays in the
-- device's IndexedDB until it is transcribed, then is removed. audio_storage_path is a
-- future private-storage seam and remains null for now.
create table public.voice_captures (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references public.farms(id),
  user_id               uuid not null references public.users(id),
  machine_id            uuid,
  locale                text not null check (locale in ('en-ZA', 'af-ZA')),
  status                text not null default 'captured' check (status in (
                           'captured', 'queued', 'transcribing', 'transcribed',
                           'parsed', 'awaiting_confirmation', 'confirmed',
                           'applied', 'completed', 'failed', 'cancelled'
                         )),
  audio_storage_path    text,
  audio_duration_ms     integer check (audio_duration_ms is null or audio_duration_ms >= 0),
  transcript            text check (transcript is null or char_length(transcript) <= 8000),
  normalized_transcript text check (normalized_transcript is null or char_length(normalized_transcript) <= 8000),
  stt_provider          text,
  stt_confidence        numeric(5,4) check (stt_confidence is null or stt_confidence between 0 and 1),
  error_code            text,
  error_detail          text check (error_detail is null or char_length(error_detail) <= 2000),
  transcribed_at        timestamptz,
  confirmed_at          timestamptz,
  applied_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid,
  constraint voice_captures_machine_fk foreign key (machine_id, farm_id)
    references public.machines(id, farm_id),
  constraint voice_captures_identity_uq unique (id, farm_id, user_id),
  constraint voice_captures_confirmed_ck check (
    status not in ('confirmed', 'applied') or confirmed_at is not null
  ),
  constraint voice_captures_applied_ck check (
    status <> 'applied' or applied_at is not null
  )
);

create index voice_captures_user_idx
  on public.voice_captures(user_id, created_at desc);
create index voice_captures_farm_status_idx
  on public.voice_captures(farm_id, status)
  where deleted_at is null;

-- Pending proposals live here server-side. Authenticated clients receive a proposal ID
-- and human-readable facts, never an authority to replace tool_args.
create table public.ai_interactions (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references public.farms(id),
  user_id               uuid not null references public.users(id),
  voice_capture_id      uuid,
  channel               text not null check (channel in ('typed', 'voice', 'whatsapp')),
  locale                text not null check (locale in ('en-ZA', 'af-ZA')),
  route_tier            smallint not null check (route_tier between 0 and 2),
  input_text            text check (input_text is null or char_length(input_text) <= 8000),
  normalized_input      text check (normalized_input is null or char_length(normalized_input) <= 8000),
  intent                text,
  tool_name             text,
  tool_args             jsonb not null default '{}'::jsonb,
  confirmation_status   text not null default 'not_required' check (confirmation_status in (
                           'not_required', 'pending', 'processing', 'confirmed',
                           'rejected', 'edited', 'failed'
                         )),
  result_status         text not null check (result_status in (
                           'proposed', 'answered', 'applied', 'rejected', 'failed'
                         )),
  response_text         text check (response_text is null or char_length(response_text) <= 8000),
  provider              text,
  model                 text,
  confidence            numeric(5,4) check (confidence is null or confidence between 0 and 1),
  consent_version       text,
  input_tokens          integer check (input_tokens is null or input_tokens >= 0),
  output_tokens         integer check (output_tokens is null or output_tokens >= 0),
  latency_ms            integer check (latency_ms is null or latency_ms >= 0),
  error_code            text,
  error_detail          text check (error_detail is null or char_length(error_detail) <= 2000),
  proposal_expires_at   timestamptz,
  linked_record_type    text,
  linked_record_id      uuid,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid,
  constraint ai_interactions_capture_fk
    foreign key (voice_capture_id, farm_id, user_id)
    references public.voice_captures(id, farm_id, user_id),
  constraint ai_interactions_llm_consent_ck check (
    (model is null and consent_version is null)
    or (
      nullif(btrim(model), '') is not null
      and nullif(btrim(consent_version), '') is not null
    )
  )
);

create index ai_interactions_user_idx
  on public.ai_interactions(user_id, created_at desc);
create index ai_interactions_farm_idx
  on public.ai_interactions(farm_id, created_at desc);
create index ai_interactions_capture_idx
  on public.ai_interactions(voice_capture_id)
  where voice_capture_id is not null;

-- `consent_version` is evidence, not client input. Stamp it from the subject's active
-- profile when a row first acquires an LLM model. Existing interactions remain writable
-- after later withdrawal so completion/error bookkeeping and POPIA erasure can finish;
-- their historical consent evidence is immutable.
create or replace function app.app_ai_stamp_consent() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_version text;
begin
  if tg_op = 'UPDATE' and new.model is not distinct from old.model then
    new.consent_version := old.consent_version;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.model is not null then
    raise exception 'The model recorded for an AI interaction cannot be changed.'
      using errcode = '42501';
  end if;

  if new.model is null then
    new.consent_version := null;
    return new;
  end if;

  select nullif(btrim(u.ai_processing_consent_version), '')
    into v_version
    from public.users u
   where u.id = new.user_id
     and u.active
     and u.deleted_at is null
     and u.ai_processing_opt_in
     and u.ai_processing_opted_in_at is not null
     and u.ai_processing_withdrawn_at is null;

  if v_version is null then
    raise exception 'Active AI-processing consent is required before using an LLM.'
      using errcode = '42501';
  end if;

  new.consent_version := v_version;
  return new;
end $$;

revoke execute on function app.app_ai_stamp_consent()
  from public, anon, authenticated;

create trigger ai_interactions_require_consent
  before insert or update on public.ai_interactions
  for each row execute function app.app_ai_stamp_consent();

-- Tenant scope and authorship are immutable after capture, including for a multi-site
-- user who may legitimately access two farms.
create or replace function app.app_voice_scope_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.farm_id is distinct from old.farm_id
     or new.user_id is distinct from old.user_id then
    raise exception 'A voice record cannot be moved to another farm or person.'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

revoke execute on function app.app_voice_scope_immutable()
  from public, anon, authenticated;

create trigger voice_captures_scope_immutable
  before update on public.voice_captures
  for each row execute function app.app_voice_scope_immutable();
create trigger ai_interactions_scope_immutable
  before update on public.ai_interactions
  for each row execute function app.app_voice_scope_immutable();

-- Standard app_audit() stores a complete old/new row forever. Transcripts, prompts,
-- replies, tool arguments, audio paths and provider error details are erasable personal
-- data, so these two tables use a deliberately redacted audit record instead.
create or replace function app.app_ai_audit_redacted() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_farm uuid;
  v_eid  uuid;
  v_old  jsonb;
  v_new  jsonb;
  v_diff jsonb;
  v_strip text[] := array[
    'audio_storage_path', 'transcript', 'normalized_transcript',
    'input_text', 'normalized_input', 'response_text', 'tool_args', 'error_detail'
  ];
begin
  if tg_op = 'DELETE' then
    v_farm := old.farm_id;
    v_eid := old.id;
    v_user := coalesce(auth.uid(), old.user_id);
    v_old := to_jsonb(old) - v_strip;
    v_diff := jsonb_build_object('old', v_old);
  elsif tg_op = 'UPDATE' then
    v_farm := new.farm_id;
    v_eid := new.id;
    v_user := coalesce(auth.uid(), new.user_id);
    v_old := to_jsonb(old) - v_strip;
    v_new := to_jsonb(new) - v_strip;
    v_diff := jsonb_build_object('old', v_old, 'new', v_new);
  else
    v_farm := new.farm_id;
    v_eid := new.id;
    v_user := coalesce(auth.uid(), new.user_id);
    v_new := to_jsonb(new) - v_strip;
    v_diff := jsonb_build_object('new', v_new);
  end if;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (v_farm, v_user, tg_table_name, v_eid, lower(tg_op), v_diff);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

revoke execute on function app.app_ai_audit_redacted()
  from public, anon, authenticated;

create trigger asset_aliases_audit
  after insert or update or delete on public.asset_aliases
  for each row execute function app_audit();
create trigger voice_captures_audit
  after insert or update or delete on public.voice_captures
  for each row execute function app.app_ai_audit_redacted();
create trigger ai_interactions_audit
  after insert or update or delete on public.ai_interactions
  for each row execute function app.app_ai_audit_redacted();

-- RLS. Aliases follow machine-level visibility (including assigned-operator and linked
-- contractor restrictions). Captures/interactions are private even from colleagues on
-- the same farm; trusted server routes are the only writers.
alter table public.asset_aliases enable row level security;
alter table public.asset_aliases force row level security;
alter table public.voice_captures enable row level security;
alter table public.voice_captures force row level security;
alter table public.ai_interactions enable row level security;
alter table public.ai_interactions force row level security;

create policy asset_aliases_sel on public.asset_aliases for select to authenticated
  using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id));
create policy asset_aliases_ins on public.asset_aliases for insert to authenticated
  with check (
    app.has_farm_access(farm_id)
    and (
      app.is_rr_admin()
      or (app.is_farm_side() and app.current_app_role() in ('owner','manager','mechanic'))
    )
  );
create policy asset_aliases_upd on public.asset_aliases for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and (
      app.is_rr_admin()
      or (app.is_farm_side() and app.current_app_role() in ('owner','manager','mechanic'))
    )
  )
  with check (
    app.has_farm_access(farm_id)
    and (
      app.is_rr_admin()
      or (app.is_farm_side() and app.current_app_role() in ('owner','manager','mechanic'))
    )
  );
create policy asset_aliases_del on public.asset_aliases for delete to authenticated
  using (
    app.has_farm_access(farm_id)
    and (
      app.is_rr_admin()
      or (app.is_farm_side() and app.current_app_role() in ('owner','manager','mechanic'))
    )
  );

create policy voice_captures_sel on public.voice_captures for select to authenticated
  using (
    deleted_at is null
    and user_id = auth.uid()
    and app.has_farm_access(farm_id)
    and (app.is_farm_side() or app.is_rr_admin())
  );
create policy ai_interactions_sel on public.ai_interactions for select to authenticated
  using (
    deleted_at is null
    and user_id = auth.uid()
    and app.has_farm_access(farm_id)
    and (app.is_farm_side() or app.is_rr_admin())
  );

grant select, insert, update, delete on public.asset_aliases to authenticated;
grant select on public.voice_captures, public.ai_interactions to authenticated;
revoke insert, update, delete on public.voice_captures, public.ai_interactions from authenticated;
revoke all on public.asset_aliases, public.voice_captures, public.ai_interactions from anon;
grant all on public.asset_aliases, public.voice_captures, public.ai_interactions to service_role;

-- A farm owner/manager may administer a genuinely single-farm person's POPIA request,
-- but a global account can carry personal information from several farms. The older
-- data-subject RPCs intentionally aggregate/de-identify the whole person, so allowing a
-- primary-farm manager to invoke them for a multi-site subject would disclose or alter
-- another farm's records. Cross-farm requests therefore require an rr_admin, whose
-- access is separately logged by app.assert_can_manage_person(). Historical/inactive
-- membership rows still count because the subject may retain records from that farm.
create or replace function app.assert_local_person_scope(
  p_user uuid,
  p_primary_farm uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.is_rr_admin() then
    return;
  end if;

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
       select 1 from public.audit_log x
        where x.user_id = p_user and x.farm_id <> p_primary_farm
     ) then
    raise exception 'Cross-farm data-subject requests require a FleetWise administrator.'
      using errcode = '42501';
  end if;
end $$;

revoke execute on function app.assert_local_person_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Extend the existing POPIA export with private voice/AI records.
create or replace function public.export_personal_data(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm uuid;
  v_out  jsonb;
begin
  v_farm := app.assert_can_manage_person(p_user, 'export');
  perform app.assert_local_person_scope(p_user, v_farm);

  select jsonb_build_object(
    'generated_at', now(),
    'subject_id',   p_user,
    'note', 'POPIA data-subject access export. Money in integer cents ex-VAT. '
         || 'Driver-usage logs are retained under a legal-obligation basis (AARTO); see docs/POPIA.md.',
    'profile', (select to_jsonb(u) from public.users u where u.id = p_user),
    'usage_logs', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_on desc), '[]'::jsonb)
      from public.usage_logs x where x.driver_user_id = p_user and x.deleted_at is null),
    'meter_readings', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.meter_readings x where x.by_user = p_user and x.deleted_at is null),
    'faults_reported', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.faults x where x.reported_by = p_user and x.deleted_at is null),
    'job_cards', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.job_cards x where (x.mechanic_user_id = p_user or x.approved_by = p_user) and x.deleted_at is null),
    'cost_entries_created', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.cost_entries x where x.created_by = p_user and x.deleted_at is null),
    'attachments_created', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.attachments x where x.created_by = p_user and x.deleted_at is null),
    'notifications', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.notifications x where x.user_id = p_user and x.deleted_at is null),
    'voice_captures', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.voice_captures x where x.user_id = p_user and x.deleted_at is null),
    'ai_interactions', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from public.ai_interactions x where x.user_id = p_user and x.deleted_at is null),
    'audit_actions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity', entity, 'entity_id', entity_id, 'action', action, 'at', at) order by at desc), '[]'::jsonb)
      from public.audit_log where user_id = p_user)
  ) into v_out;

  return v_out;
end $$;

revoke execute on function public.export_personal_data(uuid) from public, anon;
grant execute on function public.export_personal_data(uuid) to authenticated;

-- Erasure scrubs text/payloads and soft-deletes assistant records. No audio object is
-- retained by this release; if that changes, the erasure workflow must also remove the
-- corresponding private Storage objects.
create or replace function public.erase_personal_data(p_user uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm         uuid;
  v_usage_scrub  bigint;
  v_fault_scrub  bigint;
  v_voice_scrub  bigint;
  v_ai_scrub     bigint;
begin
  if p_user = auth.uid() then
    raise exception 'you cannot erase your own account here';
  end if;
  v_farm := app.assert_can_manage_person(p_user, 'erasure');
  perform app.assert_local_person_scope(p_user, v_farm);

  update public.users set
    name                         = '[erased]',
    email                        = null,
    phone                        = null,
    whatsapp_opt_in             = false,
    ai_processing_opt_in        = false,
    active                       = false,
    deleted_at                   = coalesce(deleted_at, now()),
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
    deleted_at = coalesce(deleted_at, now()),
    deleted_by = auth.uid()
  where user_id = p_user;
  get diagnostics v_voice_scrub = row_count;

  update public.ai_interactions set
    input_text = null,
    normalized_input = null,
    response_text = null,
    tool_args = '{}'::jsonb,
    error_detail = null,
    deleted_at = coalesce(deleted_at, now()),
    deleted_by = auth.uid()
  where user_id = p_user;
  get diagnostics v_ai_scrub = row_count;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (v_farm, auth.uid(), 'data_subject_erasure', p_user, 'erasure',
          jsonb_build_object('by', auth.uid(), 'subject', p_user,
                             'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                             'usage_names_cleared', v_usage_scrub,
                             'fault_names_cleared', v_fault_scrub,
                             'voice_records_scrubbed', v_voice_scrub,
                             'ai_records_scrubbed', v_ai_scrub, 'at', now()));

  return jsonb_build_object(
    'erased', true, 'subject_id', p_user,
    'usage_names_cleared', v_usage_scrub,
    'fault_names_cleared', v_fault_scrub,
    'voice_records_scrubbed', v_voice_scrub,
    'ai_records_scrubbed', v_ai_scrub,
    'note', 'Identity anonymised and account deactivated. Structural history (maintenance, '
         || 'finance, and legally-retained AARTO driver-usage records) is preserved de-identified.');
end $$;

revoke execute on function public.erase_personal_data(uuid, text) from public, anon;
grant execute on function public.erase_personal_data(uuid, text) to authenticated;
