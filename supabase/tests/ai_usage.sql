-- AI and voice usage: the ledger, the holds, the limits and the notice.
--
-- What this proves: no signed-in user can spend, read another farm's usage, or read money
-- at all unless they are the farm's billing admin, and even they never read Rapid Rise's
-- cost, rate or margin; nothing leaves the country before the person has seen the notice,
-- and dismissing it never overrides a no; a farm's limit holds across people and across an
-- unsettled hold of any age; the owners (by membership too) are told at 80% and at the
-- limit by the database itself; the margin is really applied; settling is idempotent,
-- clamped to the hold, and bills only calls that answered; voice reports only rise and are
-- clamped, sessions shrink to the budget left; Rapid Rise support use is never billed to
-- the farm; only money received ends the trial; and the ledger cannot be edited or deleted.
\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

do $bootstrap$
begin
  if to_regprocedure('public._t_login(uuid)') is null then
    execute $f$
      create function public._t_login(uid uuid) returns void language sql as $b$
        select set_config('request.jwt.claims',
                          json_build_object('sub', uid, 'role', 'authenticated')::text, false);
      $b$;
    $f$;
    execute 'grant execute on function public._t_login(uuid) to public';
  end if;
end $bootstrap$;

insert into farms (id, name, plan, status, billing_period) values
  ('a1000000-0000-4000-9000-000000000001', 'AI Farm One', 'complete', 'active', 'monthly'),
  ('a1000000-0000-4000-9000-000000000002', 'AI Farm Two', 'complete', 'active', 'monthly');

insert into auth.users (id, email) values
  ('a1a00000-0000-4000-9000-000000000001', 'ai.owner1@example.invalid'),
  ('a1a00000-0000-4000-9000-000000000002', 'ai.manager1@example.invalid'),
  ('a1a00000-0000-4000-9000-000000000003', 'ai.operator1@example.invalid'),
  ('a1a00000-0000-4000-9000-000000000004', 'ai.owner2@example.invalid'),
  ('a1a00000-0000-4000-9000-000000000005', 'ai.admin@example.invalid'),
  ('a1a00000-0000-4000-9000-000000000006', 'ai.partner@example.invalid');

insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('a1a00000-0000-4000-9000-000000000001', 'a1000000-0000-4000-9000-000000000001', null, 'owner',    'AI Owner One',    'ai.owner1@example.invalid',    true),
  ('a1a00000-0000-4000-9000-000000000002', 'a1000000-0000-4000-9000-000000000001', null, 'manager',  'AI Manager One',  'ai.manager1@example.invalid',  true),
  ('a1a00000-0000-4000-9000-000000000003', 'a1000000-0000-4000-9000-000000000001', null, 'operator', 'AI Operator One', 'ai.operator1@example.invalid', true),
  ('a1a00000-0000-4000-9000-000000000004', 'a1000000-0000-4000-9000-000000000002', null, 'owner',    'AI Owner Two',    'ai.owner2@example.invalid',    true),
  ('a1a00000-0000-4000-9000-000000000005', null,                                   null, 'rr_admin', 'AI Admin',        'ai.admin@example.invalid',     true),
  -- A partner who owns farm one by membership only (their home farm is farm two).
  ('a1a00000-0000-4000-9000-000000000006', 'a1000000-0000-4000-9000-000000000002', null, 'owner',    'AI Partner',      'ai.partner@example.invalid',   true);
insert into user_farm_memberships (user_id, farm_id, role) values
  ('a1a00000-0000-4000-9000-000000000006', 'a1000000-0000-4000-9000-000000000001', 'owner');

-- [1] Arithmetic: the margin is applied, and the month is Johannesburg's.
do $$
begin
  if app.ai_billed_cents(1, 10, 3000) <> 1300.0000 then
    raise exception 'AI USAGE FAIL [1]: $1 at R10 with 30%% bills % cents, expected 1300', app.ai_billed_cents(1, 10, 3000);
  end if;
  if app.ai_month('2026-10-31 23:30:00+00') <> date '2026-11-01' then
    raise exception 'AI USAGE FAIL [1]: 01:30 on 1 November in Johannesburg counted against %', app.ai_month('2026-10-31 23:30:00+00');
  end if;
  if app.ai_month('2026-10-31 21:59:00+00') <> date '2026-10-01' then
    raise exception 'AI USAGE FAIL [1]: 23:59 on 31 October in Johannesburg counted against %', app.ai_month('2026-10-31 21:59:00+00');
  end if;
  if app.ai_effective_limit('a1000000-0000-4000-9000-000000000001') <> 5000 then
    raise exception 'AI USAGE FAIL [1]: a farm that has never paid has limit %, expected the trial 5000',
      app.ai_effective_limit('a1000000-0000-4000-9000-000000000001');
  end if;
end $$;

-- [2] The notice is personal: only the person sets it, the database stamps it, it stays.
set role authenticated;
select public._t_login('a1a00000-0000-4000-9000-000000000002');
do $$
begin
  begin
    update public.users set ai_notice_seen_at = now() where id = 'a1a00000-0000-4000-9000-000000000003';
    if found then
      raise exception 'AI USAGE FAIL [2]: a manager marked an operator as told';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
select public._t_login('a1a00000-0000-4000-9000-000000000003');
do $$
declare v jsonb;
begin
  v := public.ai_notice_ack(true);
  if not (v->>'ai_on')::boolean or v->>'notice_seen_at' is null or v->>'consent_version' <> 'ai-on-default-v1' then
    raise exception 'AI USAGE FAIL [2]: Got it did not leave AI on with the new evidence: %', v;
  end if;
  update public.users set ai_notice_seen_at = null where id = auth.uid();
  if (select ai_notice_seen_at from public.users where id = auth.uid()) is null then
    raise exception 'AI USAGE FAIL [2]: a seen notice was unset';
  end if;
end $$;
-- A no stands: someone who switched AI off and then dismisses the notice with "Got it" is
-- told, and stays off. Switching on without the notice (the previous build's consent card)
-- is evidence of that card's text, not the notice's.
select public._t_login('a1a00000-0000-4000-9000-000000000004');
do $$
declare v jsonb;
begin
  update public.users set ai_processing_opt_in = true where id = auth.uid();
  if (select ai_processing_consent_version from public.users where id = auth.uid()) is distinct from 'voice-ai-v1' then
    raise exception 'AI USAGE FAIL [2]: a switch-on without the notice was stamped %',
      (select ai_processing_consent_version from public.users where id = auth.uid());
  end if;
  update public.users set ai_processing_opt_in = false where id = auth.uid();
  v := public.ai_notice_ack(true);
  if (v->>'ai_on')::boolean or not (v->>'withdrawn')::boolean or v->>'notice_seen_at' is null then
    raise exception 'AI USAGE FAIL [2]: Got it switched AI back on for someone who had switched it off: %', v;
  end if;
  update public.users set ai_processing_opt_in = true where id = auth.uid();
  if (select ai_processing_consent_version from public.users where id = auth.uid()) is distinct from 'ai-on-default-v1' then
    raise exception 'AI USAGE FAIL [2]: switching on after the notice was not stamped ai-on-default-v1';
  end if;
  update public.users set ai_processing_opt_in = false where id = auth.uid();
end $$;
-- Someone already on under the earlier text who now sees the notice is from then on
-- recorded under the notice's text; the old build's v2 upgrade cannot overwrite that; a
-- second "Got it" (another device still showing the notice) changes nothing, while
-- "Switch off" is always honoured.
select public._t_login('a1a00000-0000-4000-9000-000000000006');
do $$
declare v jsonb;
begin
  update public.users set ai_processing_opt_in = true where id = auth.uid();
  v := public.ai_notice_ack(true);
  if not (v->>'ai_on')::boolean or v->>'consent_version' is distinct from 'ai-on-default-v1' then
    raise exception 'AI USAGE FAIL [2]: an earlier opt-in kept its old evidence after the notice: %', v;
  end if;
  update public.users set ai_processing_consent_version = 'voice-ai-v2' where id = auth.uid();
  if (select ai_processing_consent_version from public.users where id = auth.uid()) is distinct from 'ai-on-default-v1' then
    raise exception 'AI USAGE FAIL [2]: the old v2 upgrade replaced the notice''s evidence';
  end if;
  v := public.ai_notice_ack(false);
  if (v->>'ai_on')::boolean then
    raise exception 'AI USAGE FAIL [2]: Switch off on a notice seen before was not honoured: %', v;
  end if;
  v := public.ai_notice_ack(true);
  if (v->>'ai_on')::boolean then
    raise exception 'AI USAGE FAIL [2]: a second Got it switched AI back on: %', v;
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- [3] Grants: no signed-in user can spend, write the ledger, or read holds, sessions or keys.
set role authenticated;
select public._t_login('a1a00000-0000-4000-9000-000000000001');
do $$
declare v_denied integer := 0;
begin
  begin perform 1 from public.ai_reservations limit 1; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform 1 from public.ai_voice_sessions limit 1; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform 1 from public.farm_ai_keys limit 1; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin
    insert into public.ai_usage (farm_id, user_id, month, feature, provider, model, credential, measured, usd_zar, margin_bps, outcome, reservation_id)
    values ('a1000000-0000-4000-9000-000000000001', auth.uid(), date '2026-10-01', 'voice', 'azure_speech', 'x', 'platform', 'server', 1, 0, 'ok', gen_random_uuid());
  exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin
    perform public.ai_reserve('a1000000-0000-4000-9000-000000000001', auth.uid(), 'voice', 'azure-voice', '{"audio_ms": 1000}', 'platform');
  exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.ai_settle(gen_random_uuid(), '[]'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  -- Rapid Rise's own numbers: the provider cost, the rate and the margin behind a bill.
  begin perform provider_cost_usd from public.ai_usage limit 1; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform margin_bps from public.ai_usage limit 1; exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.ai_admin_month(date '2026-10-01'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.ai_notify_owners('a1000000-0000-4000-9000-000000000001', 'ai_limit_reached', '{}'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.ai_ops_window(now()); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  begin perform public.ai_open_voice_session('a1000000-0000-4000-9000-000000000001', auth.uid(), 1000, 0, 'x', 'meter'); exception when insufficient_privilege then v_denied := v_denied + 1; end;
  if v_denied <> 12 then
    raise exception 'AI USAGE FAIL [3]: an owner reached % of 12 server-only surfaces', 12 - v_denied;
  end if;
  -- What they were billed stays readable.
  perform billed_cents, outcome from public.ai_usage limit 1;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- [4] Holds refuse what is not allowed, and Rapid Rise support is never billed.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v jsonb;
  v_spent numeric;
begin
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000002', 'ai_hearing', 'openai/gpt-4o-transcribe', '{"audio_ms": 4000}');
  if v->>'reason' is distinct from 'notice_required' then
    raise exception 'AI USAGE FAIL [4]: AI ran for someone never told: %', v;
  end if;
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000002', 'voice', 'azure-voice', '{"audio_ms": 4000}');
  if not (v->>'ok')::boolean then
    raise exception 'AI USAGE FAIL [4]: voice, which stays in South Africa, needed the AI notice: %', v;
  end if;
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000003', 'ai_hearing', 'openai/gpt-4o-transcribe', '{"audio_ms": 4000}');
  if not (v->>'ok')::boolean or (v->>'estimate_cents')::numeric <= 0 or v->>'credential' <> 'platform' then
    raise exception 'AI USAGE FAIL [4]: a told, opted-in operator could not hold for a hearing: %', v;
  end if;
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000004', 'voice', 'azure-voice', '{"audio_ms": 4000}');
  if v->>'reason' is distinct from 'not_member' then
    raise exception 'AI USAGE FAIL [4]: another farm''s owner held budget here: %', v;
  end if;
  v_spent := app.ai_month_spend(v_farm, app.ai_month(now()));
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000005', 'voice', 'azure-voice', '{"audio_ms": 600000}');
  -- Costed (so a hold left unsettled can still be priced by the sweep), never counted.
  if v->>'credential' is distinct from 'internal' or (v->>'estimate_cents')::numeric <= 0
     or app.ai_month_spend(v_farm, app.ai_month(now())) <> v_spent then
    raise exception 'AI USAGE FAIL [4]: Rapid Rise support on a customer farm was not internal, costed and uncounted: %', v;
  end if;
  update public.farm_ai_settings set ai_enabled = false, voice_enabled = false where farm_id = v_farm;
  if app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000003', 'ai_answer', 'openai/gpt-5-mini', '{"output_tokens": 900}')->>'reason' <> 'ai_off'
     or app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000003', 'voice', 'azure-voice', '{"audio_ms": 1000}')->>'reason' <> 'voice_off' then
    raise exception 'AI USAGE FAIL [4]: the farm switches did not stop AI and voice';
  end if;
  update public.farm_ai_settings set ai_enabled = true, voice_enabled = true where farm_id = v_farm;
end $$;

-- [5] Settling: the margin is real, a second settle writes nothing, the farm is billed no
-- more than its hold while the true cost is kept.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v_user uuid := 'a1a00000-0000-4000-9000-000000000003';
  v jsonb;
  v_res uuid;
  v_rows integer;
  v_billed numeric;
  v_cost numeric;
  v_clamped boolean;
begin
  v := app.ai_reserve(v_farm, v_user, 'ai_hearing', 'openai/gpt-4o-transcribe', '{"audio_ms": 4000}');
  v_res := (v->>'id')::uuid;
  v := app.ai_settle(v_res, '[{"model": "openai/gpt-4o-transcribe", "outcome": "ok", "cost_usd": "0.00001", "measured": "gateway", "units": {"audio_ms": 4000}}]');
  select billed_cents into v_billed from public.ai_usage where reservation_id = v_res;
  if v_billed <> round(0.00001 * app.ai_fx(now()) * 100 * 1.3, 4) then
    raise exception 'AI USAGE FAIL [5]: billed % cents, expected cost x rate x 1.3 = %', v_billed, round(0.00001 * app.ai_fx(now()) * 100 * 1.3, 4);
  end if;
  v := app.ai_settle(v_res, '[{"model": "openai/gpt-4o-transcribe", "outcome": "ok", "cost_usd": "5"}]');
  select count(*) into v_rows from public.ai_usage where reservation_id = v_res;
  if not coalesce((v->>'already')::boolean, false) or v_rows <> 1 then
    raise exception 'AI USAGE FAIL [5]: a second settle of one hold wrote % rows', v_rows;
  end if;

  v := app.ai_reserve(v_farm, v_user, 'ai_hearing', 'openai/gpt-4o-transcribe', '{"audio_ms": 1000}');
  v_res := (v->>'id')::uuid;
  perform app.ai_settle(v_res, '[{"model": "openai/gpt-4o-transcribe", "outcome": "ok", "cost_usd": "1.5e-1"}]');
  select billed_cents, provider_cost_usd, clamped into v_billed, v_cost, v_clamped from public.ai_usage where reservation_id = v_res;
  if v_billed <> (v->>'estimate_cents')::numeric or v_cost <> 0.15 or not v_clamped then
    raise exception 'AI USAGE FAIL [5]: an overrun billed %, kept cost %, clamped %; expected the hold %, 0.15, true',
      v_billed, v_cost, v_clamped, v->>'estimate_cents';
  end if;

  -- A call cut off at the server's deadline after it was sent: the farm is not billed for
  -- an answer it never got, but what it probably cost the platform is kept.
  v := app.ai_reserve(v_farm, v_user, 'ai_answer', 'openai/gpt-5-mini', '{"input_tokens": 1000, "output_tokens": 900}');
  v_res := (v->>'id')::uuid;
  perform app.ai_settle(v_res, '[{"model": "openai/gpt-5-mini", "outcome": "timeout", "measured": "estimated", "error_code": "timeout", "units": {"input_tokens": 1000, "output_tokens": 900}}]');
  select billed_cents, provider_cost_usd into v_billed, v_cost from public.ai_usage where reservation_id = v_res;
  if v_billed <> 0 or v_cost <= 0 then
    raise exception 'AI USAGE FAIL [5]: a timed-out call billed % and recorded cost %; expected 0 and its estimate', v_billed, v_cost;
  end if;
  -- A call refused before any work: nothing billed, nothing costed.
  v := app.ai_reserve(v_farm, v_user, 'ai_answer', 'openai/gpt-5-mini', '{"input_tokens": 1000, "output_tokens": 900}');
  v_res := (v->>'id')::uuid;
  perform app.ai_settle(v_res, '[{"model": "openai/gpt-5-mini", "outcome": "failed", "error_code": "invalid_request", "units": {"input_tokens": 1000}}]');
  select billed_cents, provider_cost_usd into v_billed, v_cost from public.ai_usage where reservation_id = v_res;
  if v_billed <> 0 or v_cost <> 0 then
    raise exception 'AI USAGE FAIL [5]: a refused call billed % and cost %', v_billed, v_cost;
  end if;
end $$;

-- [6] The limit holds: an unsettled hold of any age counts, the owner is told once, and a
-- personal limit stops one person without stopping the rest.
select public._t_login('a1a00000-0000-4000-9000-000000000001');
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v jsonb;
  v_before numeric;
begin
  v := public.ai_set_farm_limit(v_farm, 900000);
  if (v->>'ok')::boolean then
    raise exception 'AI USAGE FAIL [6]: an owner who has never paid raised the limit past the trial: %', v;
  end if;
  v := public.ai_set_farm_limit(v_farm, 1500);
  if not (v->>'ok')::boolean or (v->>'limit_cents')::bigint <> 1500 then
    raise exception 'AI USAGE FAIL [6]: the owner could not lower the limit: %', v;
  end if;
end $$;
select pg_catalog.set_config('request.jwt.claims', '', false);
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v jsonb;
  v_spent numeric;
  v_first jsonb;
  v_second jsonb;
  v_old uuid;
begin
  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000002', 'voice', 'azure-voice', '{"audio_ms": 60000}');
  v_old := (v->>'id')::uuid;
  update public.ai_reservations set created_at = now() - interval '3 days' where id = v_old;
  v_spent := app.ai_month_spend(v_farm, app.ai_month(now()));
  if v_spent < (v->>'estimate_cents')::numeric then
    raise exception 'AI USAGE FAIL [6]: an old unsettled hold stopped counting (spend %)', v_spent;
  end if;
  loop
    v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000002', 'voice', 'azure-voice', '{"audio_ms": 60000, "characters": 600}');
    exit when not (v->>'ok')::boolean;
  end loop;
  v_first := v;
  v_second := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000003', 'voice', 'azure-voice', '{"audio_ms": 60000, "characters": 600}');
  if v_first->>'reason' <> 'farm_limit' or not (v_first->>'notify_owner')::boolean
     or v_second->>'reason' <> 'farm_limit' or (v_second->>'notify_owner')::boolean then
    raise exception 'AI USAGE FAIL [6]: the limit or the one-time owner notice misbehaved: % then %', v_first, v_second;
  end if;
  if app.ai_month_spend(v_farm, app.ai_month(now())) > 1500 then
    raise exception 'AI USAGE FAIL [6]: committed spend % passed the limit 1500', app.ai_month_spend(v_farm, app.ai_month(now()));
  end if;
  -- The database itself queued the notice, once, for every owner: the home-farm owner and
  -- the partner who owns the farm by membership; never the manager.
  if (select count(*) from public.notifications where farm_id = v_farm and template = 'ai_limit_reached'
        and user_id = 'a1a00000-0000-4000-9000-000000000001') <> 1
     or (select count(*) from public.notifications where farm_id = v_farm and template = 'ai_limit_reached'
           and user_id = 'a1a00000-0000-4000-9000-000000000006') <> 1
     or (select count(*) from public.notifications where farm_id = v_farm and template = 'ai_limit_reached'
           and user_id = 'a1a00000-0000-4000-9000-000000000002') <> 0 then
    raise exception 'AI USAGE FAIL [6]: the limit notice did not reach exactly the farm''s owners';
  end if;
  -- Settling a hold with the month past 80% queues the 80% notice, whoever settled it (here
  -- a voice report, the path that used to drop it).
  perform app.ai_settle(v_old, '[{"model": "azure-voice", "outcome": "ok", "measured": "client_bounded", "units": {"audio_ms": 60000}}]');
  if (select count(*) from public.notifications where farm_id = v_farm and template = 'ai_limit_80'
        and user_id = 'a1a00000-0000-4000-9000-000000000001') <> 1 then
    raise exception 'AI USAGE FAIL [6]: crossing 80%% on a voice settlement told nobody';
  end if;
end $$;
select public._t_login('a1a00000-0000-4000-9000-000000000001');
do $$
declare v jsonb;
begin
  perform public.ai_set_farm_limit('a1000000-0000-4000-9000-000000000001', 5000);
  v := public.ai_set_member_limit('a1000000-0000-4000-9000-000000000001', 'a1a00000-0000-4000-9000-000000000003', 1);
  if not (v->>'ok')::boolean then
    raise exception 'AI USAGE FAIL [6]: the owner could not set a personal limit: %', v;
  end if;
end $$;
select pg_catalog.set_config('request.jwt.claims', '', false);
do $$
begin
  if app.ai_reserve('a1000000-0000-4000-9000-000000000001', 'a1a00000-0000-4000-9000-000000000003', 'voice', 'azure-voice', '{"audio_ms": 60000}')->>'reason' <> 'member_limit' then
    raise exception 'AI USAGE FAIL [6]: a personal limit did not stop that person';
  end if;
  if not (app.ai_reserve('a1000000-0000-4000-9000-000000000001', 'a1a00000-0000-4000-9000-000000000002', 'voice', 'azure-voice', '{"audio_ms": 1000}')->>'ok')::boolean then
    raise exception 'AI USAGE FAIL [6]: one person''s limit stopped a colleague';
  end if;
end $$;
set role authenticated;
select public._t_login('a1a00000-0000-4000-9000-000000000002');
do $$
begin
  begin
    perform public.ai_set_farm_limit('a1000000-0000-4000-9000-000000000001', 1);
    raise exception 'AI USAGE FAIL [6]: a manager changed the farm''s AI limit';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- [7] Voice sessions: counters only rise and are clamped to the maximum, a final report
-- settles once, and the nightly sweep settles what was never reported at its full maximum.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v_user uuid := 'a1a00000-0000-4000-9000-000000000002';
  v jsonb;
  v_session uuid;
  v_quiet uuid;
  r jsonb;
  v_measured text;
  v_audio integer;
  v_spent numeric;
begin
  delete from public.farm_member_ai_limits where farm_id = v_farm;
  update public.farm_ai_settings set monthly_limit_cents = null where farm_id = v_farm;
  update public.ai_reservations set settled_at = now() where farm_id = v_farm and settled_at is null;
  v := app.ai_open_voice_session(v_farm, v_user, 30000, 500, 'test-1');
  v_session := (v->>'session_id')::uuid;
  update public.ai_voice_sessions set opened_at = now() - interval '10 seconds' where id = v_session;
  r := app.ai_report_voice_session(v_session, v_user, 5000, 0, 100, false);
  r := app.ai_report_voice_session(v_session, v_user, 3000, 0, 50, false);
  if (r->>'audio_ms')::integer <> 5000 or (r->>'characters')::integer <> 100 then
    raise exception 'AI USAGE FAIL [7]: a lower report lowered the counters: %', r;
  end if;
  -- Clamped to the session's maximum only: a recording made offline is recognised from a
  -- file faster than it was spoken, so the time since opening is no bound on honest use.
  r := app.ai_report_voice_session(v_session, v_user, 999999, 0, 99999, false);
  if (r->>'audio_ms')::integer <> 30000 or (r->>'characters')::integer <> 500 then
    raise exception 'AI USAGE FAIL [7]: a report was not clamped to the session maximum: %', r;
  end if;
  r := app.ai_report_voice_session(v_session, 'a1a00000-0000-4000-9000-000000000003', 1, 0, 1, true);
  if r->>'reason' is distinct from 'unknown_session' then
    raise exception 'AI USAGE FAIL [7]: someone else reported on a session: %', r;
  end if;
  perform app.ai_report_voice_session(v_session, v_user, 6000, 0, 120, true);
  r := app.ai_report_voice_session(v_session, v_user, 6000, 0, 120, true);
  if not coalesce((r->>'already')::boolean, false) or not coalesce((r->>'closed')::boolean, false)
     or (select count(*) from public.ai_usage u join public.ai_voice_sessions s on s.reservation_id = u.reservation_id where s.id = v_session) <> 1 then
    raise exception 'AI USAGE FAIL [7]: a repeated final report was not idempotent, or did not say the session is closed: %', r;
  end if;

  v := app.ai_open_voice_session(v_farm, v_user, 30000, 500, 'test-1');
  v_quiet := (v->>'session_id')::uuid;
  update public.ai_voice_sessions set opened_at = now() - interval '20 minutes' where id = v_quiet;
  perform app.ai_settle_stale();
  select u.measured, u.audio_ms into v_measured, v_audio
    from public.ai_usage u join public.ai_voice_sessions s on s.reservation_id = u.reservation_id where s.id = v_quiet;
  if v_measured is distinct from 'estimated' or v_audio is distinct from 30000 then
    raise exception 'AI USAGE FAIL [7]: a never-reported session settled as % with % ms, expected estimated at 30000', v_measured, v_audio;
  end if;

  -- A session the month cannot take whole is shrunk to what is left, not refused; below
  -- ten seconds it is refused. A token's session says so.
  v_spent := app.ai_month_spend(v_farm, app.ai_month(now()));
  update public.farm_ai_settings set monthly_limit_cents = ceil(v_spent)::bigint + 50 where farm_id = v_farm;
  v := app.ai_open_voice_session(v_farm, v_user, 120000, 1500, 'test-1', 'token');
  if not coalesce((v->>'ok')::boolean, false) or (v->>'max_audio_ms')::integer >= 120000
     or (v->>'max_audio_ms')::integer < 10000 or (v->>'estimate_cents')::numeric > 50 then
    raise exception 'AI USAGE FAIL [7]: a session was not shrunk to the R0.50 left: %', v;
  end if;
  if (select source from public.ai_voice_sessions where id = (v->>'session_id')::uuid) is distinct from 'token' then
    raise exception 'AI USAGE FAIL [7]: a token''s session was not recorded as one';
  end if;
  v_spent := app.ai_month_spend(v_farm, app.ai_month(now()));
  update public.farm_ai_settings set monthly_limit_cents = ceil(v_spent)::bigint + 1 where farm_id = v_farm;
  v := app.ai_open_voice_session(v_farm, v_user, 120000, 1500, 'test-1', 'meter');
  if v->>'reason' is distinct from 'farm_limit' then
    raise exception 'AI USAGE FAIL [7]: a session below the ten-second floor was not refused: %', v;
  end if;
  update public.farm_ai_settings set monthly_limit_cents = null where farm_id = v_farm;
end $$;

-- [8] A hold the server never settled is closed by the sweep as unknown, billed nothing.
do $$
declare
  v jsonb;
  v_res uuid;
  v_outcome text;
  v_billed numeric;
begin
  v := app.ai_reserve('a1000000-0000-4000-9000-000000000001', 'a1a00000-0000-4000-9000-000000000003', 'ai_answer', 'openai/gpt-5-mini', '{"input_tokens": 2000, "output_tokens": 900}');
  v_res := (v->>'id')::uuid;
  update public.ai_reservations set created_at = now() - interval '1 hour' where id = v_res;
  perform app.ai_settle_stale();
  select outcome, billed_cents into v_outcome, v_billed from public.ai_usage where reservation_id = v_res;
  if v_outcome is distinct from 'unknown' or v_billed <> 0 then
    raise exception 'AI USAGE FAIL [8]: an orphaned hold settled as % billing %', v_outcome, v_billed;
  end if;
end $$;

-- [9] The ledger is a money record: no edit, no delete.
do $$
declare v_blocked integer := 0;
begin
  begin update public.ai_usage set billed_cents = 0 where farm_id = 'a1000000-0000-4000-9000-000000000001';
  exception when insufficient_privilege then v_blocked := v_blocked + 1; end;
  begin delete from public.ai_usage where farm_id = 'a1000000-0000-4000-9000-000000000001';
  exception when insufficient_privilege then v_blocked := v_blocked + 1; end;
  if v_blocked <> 2 then
    raise exception 'AI USAGE FAIL [9]: the ledger allowed % of 2 changes', 2 - v_blocked;
  end if;
end $$;

-- [10] Who reads what: the owner reads money for their farm, nobody else on the farm does,
-- the neighbour reads nothing, and a member reads their own minutes without any Rand.
set role authenticated;
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  n integer;
  v jsonb;
begin
  perform public._t_login('a1a00000-0000-4000-9000-000000000001');
  select count(*) into n from public.ai_usage where farm_id = v_farm;
  if n = 0 then raise exception 'AI USAGE FAIL [10]: the owner read none of the farm''s usage'; end if;
  v := public.ai_farm_usage(v_farm);
  if jsonb_array_length(v->'people') = 0 or v ? 'cost_usd' then
    raise exception 'AI USAGE FAIL [10]: the owner page data is wrong: %', left(v::text, 300);
  end if;
  -- The partner who belongs by membership is listed (a limit can be set before their first
  -- use); Rapid Rise staff are not, though they helped on this farm; earlier months leave
  -- out this one.
  if not exists (select 1 from jsonb_array_elements(v->'people') p where p->>'user_id' = 'a1a00000-0000-4000-9000-000000000006')
     or exists (select 1 from jsonb_array_elements(v->'people') p where p->>'user_id' = 'a1a00000-0000-4000-9000-000000000005')
     or jsonb_array_length(v->'months') <> 0 then
    raise exception 'AI USAGE FAIL [10]: the owner page lists the wrong people or months: %', left(v::text, 600);
  end if;

  perform public._t_login('a1a00000-0000-4000-9000-000000000002');
  select count(*) into n from public.ai_usage where farm_id = v_farm;
  if n <> 0 then raise exception 'AI USAGE FAIL [10]: a manager read % usage rows', n; end if;
  begin
    perform public.ai_farm_usage(v_farm);
    raise exception 'AI USAGE FAIL [10]: a manager read the owner page data';
  exception when insufficient_privilege then null;
  end;
  v := public.ai_my_usage(v_farm);
  if not (v ? 'voice_seconds') or v::text ~ 'cents' then
    raise exception 'AI USAGE FAIL [10]: a member''s own usage is wrong or shows money: %', v;
  end if;

  perform public._t_login('a1a00000-0000-4000-9000-000000000004');
  select count(*) into n from public.ai_usage where farm_id = v_farm;
  if n <> 0 then raise exception 'AI USAGE FAIL [10]: the neighbouring farm read % rows', n; end if;

  perform public._t_login('a1a00000-0000-4000-9000-000000000005');
  select count(*) into n from public.ai_usage where farm_id = v_farm;
  if n = 0 then raise exception 'AI USAGE FAIL [10]: the Rapid Rise admin read no usage'; end if;
  -- Rapid Rise reads its own cost against billed through the summary, whole.
  v := public.ai_admin_month(date_trunc('month', now() at time zone 'Africa/Johannesburg')::date);
  if not exists (select 1 from jsonb_array_elements(v->'farms') f where f->>'farm_id' = v_farm::text and (f->>'cost_usd')::numeric > 0)
     or (v->>'billed_cents')::numeric <= 0 then
    raise exception 'AI USAGE FAIL [10]: the admin month summary is wrong: %', left(v::text, 400);
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- [11] No Azure token without a voice session: every token opens one, so voice off or no
-- budget left means no token; Rapid Rise support is never stopped by a customer's limit.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v_manager uuid := 'a1a00000-0000-4000-9000-000000000002';
  v jsonb;
begin
  v := app.ai_open_voice_session(v_farm, v_manager, 120000, 1500, 'legacy', 'token');
  if not coalesce((v->>'ok')::boolean, false) then
    raise exception 'AI USAGE FAIL [11]: a token''s session was refused with budget left: %', v;
  end if;
  update public.farm_ai_settings set voice_enabled = false where farm_id = v_farm;
  if app.ai_open_voice_session(v_farm, v_manager, 120000, 1500, 'legacy', 'token')->>'reason' is distinct from 'voice_off' then
    raise exception 'AI USAGE FAIL [11]: voice switched off still opened a token''s session';
  end if;
  update public.farm_ai_settings set voice_enabled = true, monthly_limit_cents = 0 where farm_id = v_farm;
  if app.ai_open_voice_session(v_farm, v_manager, 120000, 1500, 'legacy', 'token')->>'reason' is distinct from 'farm_limit' then
    raise exception 'AI USAGE FAIL [11]: a farm with no budget left still opened a token''s session';
  end if;
  if not coalesce((app.ai_open_voice_session(v_farm, 'a1a00000-0000-4000-9000-000000000005', 120000, 1500, 'x', 'token')->>'ok')::boolean, false) then
    raise exception 'AI USAGE FAIL [11]: Rapid Rise support was stopped by a customer limit';
  end if;
  update public.farm_ai_settings set monthly_limit_cents = null where farm_id = v_farm;
end $$;

-- [11b] Tokens are capped per person (each works on the whole Speech resource for about
-- ten minutes, whatever is reported); a meter session is not a token and is not capped;
-- the nightly window counts tokens against the use reported; and an answer the provider
-- produced but that could not be used records its cost without billing the farm.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000001';
  v_user uuid := 'a1a00000-0000-4000-9000-000000000002';
  v jsonb;
  v_res uuid;
  i integer;
  w jsonb;
  v_billed numeric;
  v_cost numeric;
begin
  delete from public.ai_voice_sessions where user_id = v_user and source = 'token';
  for i in 1..30 loop
    insert into public.ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at)
    values (v_farm, v_user, 'voice', 'platform', 'azure-voice', 0, app.ai_month(now()), now())
    returning id into v_res;
    insert into public.ai_voice_sessions (reservation_id, farm_id, user_id, source, max_audio_ms, max_characters, closed_at, opened_at)
    values (v_res, v_farm, v_user, 'token', 120000, 1500, now(), now() - interval '10 minutes');
  end loop;
  v := app.ai_open_voice_session(v_farm, v_user, 120000, 1500, 'voice-3', 'token');
  if v->>'reason' is distinct from 'token_rate' then
    raise exception 'AI USAGE FAIL [11b]: a 31st token in an hour was not refused: %', v;
  end if;
  v := app.ai_open_voice_session(v_farm, v_user, 30000, 300, 'voice-3', 'meter');
  if v->>'reason' = 'token_rate' then
    raise exception 'AI USAGE FAIL [11b]: a meter session was refused as a token';
  end if;
  w := app.ai_voice_token_window(now() - interval '1 day');
  if not exists (select 1 from jsonb_array_elements(w) x
                  where x->>'user_id' = v_user::text and (x->>'tokens')::integer >= 30) then
    raise exception 'AI USAGE FAIL [11b]: the nightly window did not count the tokens: %', left(w::text, 300);
  end if;

  v := app.ai_reserve(v_farm, 'a1a00000-0000-4000-9000-000000000003', 'ai_answer', 'openai/gpt-5-mini', '{"input_tokens": 1000, "output_tokens": 900}');
  v_res := (v->>'id')::uuid;
  perform app.ai_settle(v_res, '[{"model": "openai/gpt-5-mini", "outcome": "failed", "error_code": "invalid_output", "charged": true, "measured": "server", "units": {"input_tokens": 800, "output_tokens": 900}}]');
  select billed_cents, provider_cost_usd into v_billed, v_cost from public.ai_usage where reservation_id = v_res;
  if v_billed <> 0 or v_cost <= 0 then
    raise exception 'AI USAGE FAIL [11b]: an unusable answer billed % and recorded cost %; expected 0 and its real cost', v_billed, v_cost;
  end if;
end $$;

-- [12] Only money received ends the trial: an invoice with nothing to collect (a 100%
-- promotion) does not, a payment does, and a full refund puts the farm back on the trial.
-- Until then nobody, Rapid Rise included, can set a limit the trial would silently ignore.
do $$
declare
  v_farm uuid := 'a1000000-0000-4000-9000-000000000002';
begin
  if app.ai_farm_has_paid(v_farm) or app.ai_effective_limit(v_farm) <> 5000 then
    raise exception 'AI USAGE FAIL [12]: a farm that never paid is off the trial';
  end if;
  insert into public.billing_payments (farm_id, amount_incl_cents, provider, note) values (v_farm, 11500, 'manual', 'ai test');
  if not app.ai_farm_has_paid(v_farm) or app.ai_effective_limit(v_farm) <> 20000 then
    raise exception 'AI USAGE FAIL [12]: a paid farm was not given the default limit (%)', app.ai_effective_limit(v_farm);
  end if;
  insert into public.billing_payments (farm_id, amount_incl_cents, provider, note) values (v_farm, -11500, 'manual', 'ai test refund');
  if app.ai_farm_has_paid(v_farm) then
    raise exception 'AI USAGE FAIL [12]: a fully refunded farm still counts as paid';
  end if;
end $$;
set role authenticated;
select public._t_login('a1a00000-0000-4000-9000-000000000005');
do $$
declare v jsonb;
begin
  v := public.ai_set_farm_limit('a1000000-0000-4000-9000-000000000001', 900000);
  if coalesce((v->>'ok')::boolean, false) or v->>'reason' is distinct from 'trial_limit' then
    raise exception 'AI USAGE FAIL [12]: a limit above the trial was saved on an unpaid farm: %', v;
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

rollback;
