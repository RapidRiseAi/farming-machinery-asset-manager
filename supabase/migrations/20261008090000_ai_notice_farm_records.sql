-- The AI notice now says what the smart assistant sends: the farm records an answer needs.
--
-- Until 2026-10-08 the assistant's AI read only the words of a hard request, and the notice
-- said exactly that: "the words, your language and today's date to an AI model". From this
-- release a question that needs the farm's records (fuel, costs, services, faults) is
-- answered by an AI that reads them on the person's own session (src/lib/assistant/agent.ts):
-- only what they can already see in FleetWise. The notice text changes with it (en.json /
-- af.json assistant.notice*, consent*), and so does the evidence: an acknowledgement from
-- now on is stamped 'ai-on-default-v2', the text that mentions the records.
--
-- == Who sees the notice again ================================================
-- Everybody who acknowledged the v1 text and kept AI on. They agreed to the words being
-- sent, not the records, so AI stays off for them until they have seen the new text once:
-- their ai_notice_seen_at is cleared, which is the state ai_reserve already refuses and
-- the app already answers with the notice. Nobody else changes: a person who switched AI
-- off stays off (switching on later shows the current consent text and stamps v2), and a
-- person who never saw a notice sees the new one.
--
-- The consent trigger makes ai_notice_seen_at personal and unclearable, rightly, for every
-- caller including the service role. This one statement is the deliberate exception, made
-- by the schema owner with that trigger disabled for its duration only, inside this
-- migration's transaction.

create or replace function app.app_users_guard_ai_consent() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_changed boolean;
begin
  -- A profile is created before that person can consent or be told. Discard any
  -- consent-looking values an invite or admin caller supplies.
  if tg_op = 'INSERT' then
    new.ai_processing_opt_in := false;
    new.ai_processing_opted_in_at := null;
    new.ai_processing_consent_version := null;
    new.ai_processing_withdrawn_at := null;
    new.ai_notice_seen_at := null;
    return new;
  end if;
  v_changed :=
       new.ai_processing_opt_in is distinct from old.ai_processing_opt_in
    or new.ai_processing_opted_in_at is distinct from old.ai_processing_opted_in_at
    or new.ai_processing_consent_version is distinct from old.ai_processing_consent_version
    or new.ai_processing_withdrawn_at is distinct from old.ai_processing_withdrawn_at
    or new.ai_notice_seen_at is distinct from old.ai_notice_seen_at;
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
    new.ai_notice_seen_at := old.ai_notice_seen_at;
    return new;
  end if;
  if not v_changed then
    return new;
  end if;
  -- Consent, and having been told, are personal: even a service-role workflow may not
  -- manufacture them.
  if auth.uid() is null or auth.uid() <> old.id then
    raise exception 'Only this person may change their AI-processing choice.'
      using errcode = '42501';
  end if;
  -- Seen once, seen for good, at the database's time.
  new.ai_notice_seen_at := case
    when old.ai_notice_seen_at is not null then old.ai_notice_seen_at
    when new.ai_notice_seen_at is not null then now()
    else null
  end;
  if new.ai_processing_opt_in then
    if not old.ai_processing_opt_in then
      new.ai_processing_opted_in_at := now();
      -- The version of the text actually shown: the notice when it has been seen, the
      -- previous build's consent card when it has not.
      new.ai_processing_consent_version := case
        when new.ai_notice_seen_at is not null then 'ai-on-default-v2'
        else 'voice-ai-v1'
      end;
      new.ai_processing_withdrawn_at := null;
    elsif old.ai_notice_seen_at is null and new.ai_notice_seen_at is not null then
      -- Already on under an earlier text, and now shown the notice: from here the
      -- recording leaves under the notice's terms, so the evidence names the notice.
      new.ai_processing_opted_in_at := now();
      new.ai_processing_consent_version := 'ai-on-default-v2';
      new.ai_processing_withdrawn_at := null;
    elsif old.ai_processing_consent_version = 'voice-ai-v1'
      and new.ai_processing_consent_version = 'voice-ai-v2' then
      -- The previous build's extension to the recording and machine names, still accepted
      -- while that build is live during a release. Never from the notice's version: that
      -- would replace the notice's evidence with an older text.
      new.ai_processing_opted_in_at := now();
      new.ai_processing_withdrawn_at := null;
    else
      -- Already on: a client may not rewrite the evidence.
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
revoke execute on function app.app_users_guard_ai_consent() from public, anon, authenticated;

alter table public.users disable trigger users_guard_ai_consent;
update public.users
   set ai_notice_seen_at = null
 where ai_processing_consent_version = 'ai-on-default-v1'
   and ai_processing_opt_in
   and ai_processing_withdrawn_at is null
   and ai_notice_seen_at is not null;
alter table public.users enable trigger users_guard_ai_consent;
