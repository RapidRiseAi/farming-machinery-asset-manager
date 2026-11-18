-- 20261119130000_offline_capture_once.sql
-- One capture, one record, whether it went online or waited on the phone (task B3, R-123).
--
-- A capture form posts online with a request id (RequestIdInput; the action claims it in
-- request_claims). When the phone is offline the same form queues the capture for /api/sync,
-- and that capture was given a NEW id, so a save whose answer was lost online and that was
-- then queued (the page reloaded from the phone's cache without signal) was recorded twice.
-- The phone now queues it under the online attempt's own id, and this function, which
-- /api/sync calls instead of apply_offline_capture, checks that id's claim first:
--
--   * the online attempt landed: nothing is applied again (answered as applied, duplicate);
--   * the online attempt is still running: answered `retry`, and the phone keeps the
--     capture and tries again later;
--   * no online attempt: the capture claims the id (so a late online request with it is
--     answered, not run again) and is applied as before, with its claim finished.
--
-- It also asks the plan again for a diesel draw (BRIEF section 19: plan rechecked on
-- reconnect). A draw queued on Professional and replayed after a downgrade was written,
-- because only the online action and the page checked the plan. Membership, role, the
-- account and the pay gate were already rechecked inside apply_offline_capture, and the
-- equipment profile by the tables' own triggers (20261114090200).
--
-- claim_request now answers `done` for an id a queued capture already used, instead of
-- refusing it as an id used for another action, which the app treated as "no claim" and ran.
--
-- Additive: one new function (service role), claim_request replaced with its signature.

create or replace function public.apply_offline_capture_once(
  p_client uuid, p_client_ts timestamptz, p_type text, p_scope text,
  p_actor uuid, p_fields jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_claim public.request_claims%rowtype;
  v_farm uuid;
  v_result jsonb;
begin
  if p_client is null then raise exception 'bad_mutation' using errcode = '22023'; end if;
  -- The same lock apply_offline_capture takes, held for the whole of this.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_client::text, 0));

  if p_scope = 'app' and p_actor is not null then
    select * into v_claim from public.request_claims where request_id = p_client;
    if found then
      if v_claim.user_id is distinct from p_actor then
        return pg_catalog.jsonb_build_object('status', 'needs_review', 'error', 'retry_key_mismatch');
      end if;
      if v_claim.finished_at is not null
         and not exists (select 1 from public.sync_log s where s.client_id = p_client) then
        -- The online attempt saved it.
        return pg_catalog.jsonb_build_object('status', 'applied', 'duplicate', true, 'via', 'online');
      end if;
      if v_claim.finished_at is null and v_claim.claimed_at > now() - interval '5 minutes'
         and v_claim.action not like 'capture:%' then
        return pg_catalog.jsonb_build_object('status', 'retry');
      end if;
    end if;

    -- A diesel draw needs the fuel tools on the machine's plan, now, not when it was queued.
    if p_type = 'log_fuel' then
      select m.farm_id into v_farm from public.machines m
       where m.id = nullif(p_fields->>'machine_id', '')::uuid and m.deleted_at is null;
      if v_farm is not null and not app.farm_plan_allows(v_farm, 'fuel') then
        raise exception 'plan-feature-fuel' using errcode = 'P0001';
      end if;
    end if;

    insert into public.request_claims (request_id, user_id, action)
    values (p_client, p_actor, 'capture:' || p_type)
    on conflict (request_id) do nothing;
  end if;

  v_result := public.apply_offline_capture(p_client, p_client_ts, p_type, p_scope, p_actor, p_fields);

  if p_scope = 'app' and p_actor is not null then
    if v_result->>'status' in ('applied', 'conflict') then
      update public.request_claims set finished_at = coalesce(finished_at, now())
       where request_id = p_client and user_id = p_actor;
    else
      delete from public.request_claims
       where request_id = p_client and user_id = p_actor and finished_at is null and action like 'capture:%';
    end if;
  end if;
  return v_result;
end $$;
revoke all on function public.apply_offline_capture_once(uuid, timestamptz, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_offline_capture_once(uuid, timestamptz, text, text, uuid, jsonb) to service_role;

-- claim_request: an id a queued capture already used is answered as done for its owner.
create or replace function public.claim_request(p_request uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_claim public.request_claims%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_request is null or p_action is null or length(p_action) not between 1 and 80 then
    raise exception 'A request id and an action are required.' using errcode = '22023';
  end if;

  -- Old claims of this person go as new ones come; two days covers any retry.
  delete from public.request_claims
   where user_id = v_user and claimed_at < now() - interval '2 days';

  insert into public.request_claims (request_id, user_id, action)
  values (p_request, v_user, p_action)
  on conflict (request_id) do nothing;
  if found then
    return jsonb_build_object('state', 'new');
  end if;

  select * into v_claim from public.request_claims where request_id = p_request for update;
  -- Someone else's id, or one id reused for a different action: never answer across them.
  -- The one exception: the same person's queued capture of this very form (20261119130000).
  if v_claim.user_id is distinct from v_user
     or (v_claim.action is distinct from p_action and v_claim.action not like 'capture:%') then
    raise exception 'That request id is already in use.' using errcode = '23505';
  end if;
  if v_claim.finished_at is not null then
    return jsonb_build_object('state', 'done', 'outcome', v_claim.outcome);
  end if;
  -- Longer than any function may run (300 s), so the first attempt is gone: take it over.
  if v_claim.claimed_at < now() - interval '5 minutes' then
    update public.request_claims set claimed_at = now() where request_id = p_request;
    return jsonb_build_object('state', 'new');
  end if;
  return jsonb_build_object('state', 'running');
end $$;
revoke all on function public.claim_request(uuid, text) from public, anon;
grant execute on function public.claim_request(uuid, text) to authenticated;
