-- AI help on by default, behind a notice the person has actually seen.
--
-- Founder decision 10 (2026-10-03) supersedes decision 2: AI help (the AI hearing of a
-- hard voice request, AI answers for a hard request) is on by default, the person is told,
-- and can switch it off. The legal basis is service necessity, and the recording leaves
-- South Africa, so POPIA s18 still requires telling the person at or before collection.
--
-- So the default is not a value written at insert: a new profile still starts with AI
-- processing off, exactly as before. What changes is the first thing the assistant does:
-- it shows the notice, and its main button ("Got it") keeps AI on; the other switches it
-- off. ai_reserve (the next migration) refuses any AI call until ai_notice_seen_at is set,
-- so nothing leaves the country before the person has been told, whatever a client does.
-- The same holds for anyone who agreed only to voice-ai-v1 (transcript text): they see the
-- notice once, because it is the first to mention the recording.
--
-- The evidence names the text the person actually saw. Switching on stamps
-- 'ai-on-default-v1' only when the person has seen the notice (before, or in the same
-- update); a switch-on without it is the previous build's consent card, still serving
-- during the release or cached in an installed app, and is stamped 'voice-ai-v1' as that
-- build always did. Its follow-up extension to 'voice-ai-v2' is still accepted, so that
-- build keeps working, and its users meet the notice once the new build loads, because
-- every AI call is refused until the notice is seen.
--
-- Someone who switched AI off has said no, and the notice does not change that: "Got it"
-- records that they were told and leaves AI off. Switching back on is its own explicit
-- action (the consent route), never the side effect of dismissing a notice.
--
-- ai_notice_seen_at is personal, like consent: only the person can set it (an owner or
-- manager who can update the users row cannot fake that an employee was told), the
-- database stamps the time, and it cannot be unset.

alter table public.users add column if not exists ai_notice_seen_at timestamptz;

comment on column public.users.ai_notice_seen_at is
  'When this person dismissed the AI notice (Got it or Switch off). AI calls are refused until it is set.';

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
        when new.ai_notice_seen_at is not null then 'ai-on-default-v1'
        else 'voice-ai-v1'
      end;
      new.ai_processing_withdrawn_at := null;
    elsif old.ai_notice_seen_at is null and new.ai_notice_seen_at is not null then
      -- Already on under an earlier text, and now shown the notice: from here the
      -- recording leaves under the notice's terms, so the evidence names the notice.
      new.ai_processing_opted_in_at := now();
      new.ai_processing_consent_version := 'ai-on-default-v1';
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

-- The notice's two buttons. "Got it" keeps AI on (the default); "Switch off" turns it off.
-- Either way the person has now been told. "Got it" counts once, the first time: for
-- someone who had switched AI off it only records that they were told, and a notice
-- dismissed again later (a second device still showing it) switches nothing on. "Switch
-- off" is always honoured. After the first time, AI help is switched on only by its own
-- explicit switch (the consent route).
create or replace function public.ai_notice_ack(p_keep_on boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before public.users;
  v_row public.users;
  v_withdrawn boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into v_before from public.users where id = auth.uid();
  if not found then
    raise exception 'No profile for this person.' using errcode = '42501';
  end if;
  v_withdrawn := not v_before.ai_processing_opt_in and v_before.ai_processing_withdrawn_at is not null;
  if v_before.ai_notice_seen_at is not null and coalesce(p_keep_on, true) then
    -- Seen before: a second "Got it" changes nothing.
    v_row := v_before;
  elsif v_before.ai_notice_seen_at is not null then
    -- Seen before, and now "Switch off": a no is always honoured.
    update public.users set ai_processing_opt_in = false where id = auth.uid()
    returning * into v_row;
  else
    update public.users
       set ai_notice_seen_at = now(),
           ai_processing_opt_in = case
             when v_withdrawn then false
             else coalesce(p_keep_on, true)
           end
     where id = auth.uid()
    returning * into v_row;
  end if;
  return jsonb_build_object(
    'ai_on', v_row.ai_processing_opt_in and v_row.ai_processing_withdrawn_at is null,
    'withdrawn', v_withdrawn,
    'notice_seen_at', v_row.ai_notice_seen_at,
    'consent_version', v_row.ai_processing_consent_version);
end $$;
revoke execute on function public.ai_notice_ack(boolean) from public, anon;
grant execute on function public.ai_notice_ack(boolean) to authenticated;
