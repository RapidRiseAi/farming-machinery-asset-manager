-- Voice AI consent v2: the recording and the farm's machine names, not only transcript text.
--
-- `voice-ai-v1` covers sending difficult transcript TEXT to the optional AI provider.
-- The mixed Afrikaans/English work (2026-10-03) adds an AI transcription pass that sends
-- the recording and the farm's machine names to speech models through the Vercel AI
-- Gateway. That is a wider disclosure, so it needs its own, explicit consent.
--
-- Opting in still stamps `voice-ai-v1`, exactly as before. Releases apply migrations
-- BEFORE the new build is live, so for a while the old build, which shows the v1 text,
-- runs against this function: if opting in stamped v2, a person could be recorded as
-- agreeing to audio processing they were never told about. v2 is reached only by the one
-- change a client may now make to ACTIVE consent: extending it from v1 to v2, which only
-- the new build asks for, after showing the v2 text. The database stamps the time.
--
-- Withdrawal, deactivation and erasure behave exactly as before and keep the version as
-- evidence. Everything else in this function is unchanged from 20260813195653.

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
    elsif old.ai_processing_consent_version = 'voice-ai-v1'
      and new.ai_processing_consent_version = 'voice-ai-v2' then
      -- The one permitted change to active consent: extending it to the recording and
      -- machine names, after the person was shown the v2 text. Fresh evidence.
      new.ai_processing_opted_in_at := now();
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
