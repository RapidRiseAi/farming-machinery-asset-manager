\set ON_ERROR_STOP on
-- One monthly rand limit per customer for paid AI, voice and WhatsApp (20261118120200).
-- BRIEF section 23:
--   30  no budget chosen means no paid work (never unlimited, no R200 default); zero is a clear
--       "no paid help"; a positive limit works; blank is refused; a business's own key is
--       neither capped nor billed;
--   31  one budget across the customer's sites, people and channels: holds in flight count,
--       settlement frees what was not used, a person's sublimit holds on every site and never
--       lifts the customer's cap, the estimate is the customer charge with the 30% margin, the
--       month's zone and reset are stated;
--   32  a provider-free WhatsApp message settles at R0, a billable one at cost plus the margin,
--       once, whatever Meta repeats; failed and never-answered messages at R0; the event record
--       (customer, rate version, supplier currency and tax, category).
-- And: existing customers keep their limit as their choice, owners told; who may read or set it.
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
create or replace function pg_temp.nobody() returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', '', true);
$$;
-- A hold for paid work costing p_usd at the provider (voice, so no AI notice is involved).
create or replace function pg_temp.hold(p_farm uuid, p_user uuid, p_usd numeric, p_cred text default 'platform') returns jsonb
language sql as $$
  select app.ai_reserve(p_farm, p_user, 'voice', 'test/meter', jsonb_build_object('input_tokens', p_usd * 1000), p_cred);
$$;
insert into public.ai_prices (model, unit, usd_per_unit, effective_from, source) values
  ('test/meter', 'input_token', 0.001, now() - interval '1 day', 'manual');

-- == Fixtures ===============================================================================
-- C1 Main depot and C2 North depot (billed through C1), paid       N  a new customer
-- U  unrelated, never paid                     M1, M2, M3: customers from before (migration)
insert into public.farms (id, name, plan, status, billing_period) values
  ('5c000000-0000-4000-9000-0000000000c1', 'Main depot',  'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-0000000000c2', 'North depot', 'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-00000000000e', 'New yard',    'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-00000000000f', 'Other yard',  'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-0000000000a1', 'Old paid',    'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-0000000000a2', 'Old unpaid',  'complete', 'active', 'monthly'),
  ('5c000000-0000-4000-9000-0000000000a3', 'Old north',   'complete', 'active', 'monthly');
update public.farms set billed_through = '5c000000-0000-4000-9000-0000000000c1' where id = '5c000000-0000-4000-9000-0000000000c2';
update public.farms set billed_through = '5c000000-0000-4000-9000-0000000000a1' where id = '5c000000-0000-4000-9000-0000000000a3';
insert into auth.users (id, email)
select ('5c100000-0000-4000-9000-00000000000' || n)::uuid, 'assist' || n || '@cap.test' from generate_series(1, 8) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('5c100000-0000-4000-9000-000000000001', '5c000000-0000-4000-9000-0000000000c1', 'owner',    'Owner C',   'assist1@cap.test', true),
  ('5c100000-0000-4000-9000-000000000002', '5c000000-0000-4000-9000-0000000000c1', 'operator', 'Anna',      'assist2@cap.test', true),
  ('5c100000-0000-4000-9000-000000000003', '5c000000-0000-4000-9000-0000000000c2', 'operator', 'Ben',       'assist3@cap.test', true),
  ('5c100000-0000-4000-9000-000000000004', '5c000000-0000-4000-9000-0000000000c1', 'manager',  'Manager C', 'assist4@cap.test', true),
  ('5c100000-0000-4000-9000-000000000005', '5c000000-0000-4000-9000-00000000000e', 'owner',    'Owner N',   'assist5@cap.test', true),
  ('5c100000-0000-4000-9000-000000000006', '5c000000-0000-4000-9000-00000000000f', 'owner',    'Owner U',   'assist6@cap.test', true),
  ('5c100000-0000-4000-9000-000000000007', '5c000000-0000-4000-9000-0000000000a1', 'owner',    'Owner M1',  'assist7@cap.test', true),
  ('5c100000-0000-4000-9000-000000000008', '5c000000-0000-4000-9000-0000000000a2', 'owner',    'Owner M2',  'assist8@cap.test', true);
insert into public.user_farm_memberships (user_id, farm_id, role) values
  ('5c100000-0000-4000-9000-000000000001', '5c000000-0000-4000-9000-0000000000c2', 'owner');
do $fx$
declare v_today date := app.billing_today();
begin
  insert into public.billing_subscriptions (farm_id, plan, billing_period, status, asset_quota,
    current_period_start, current_period_end, next_billing_on, anchor_day)
  select f, 'complete', 'monthly', 'active', 5, v_today - 10, v_today + 19, v_today + 20, extract(day from v_today - 10)::int
    from unnest(array['5c000000-0000-4000-9000-0000000000c1', '5c000000-0000-4000-9000-00000000000e',
                      '5c000000-0000-4000-9000-00000000000f', '5c000000-0000-4000-9000-0000000000a1',
                      '5c000000-0000-4000-9000-0000000000a2']::uuid[]) f;
end $fx$;
-- C1 and the old paid customer have paid us money: the trial guard is off for them.
set local session_replication_role = replica;
insert into public.billing_payments (farm_id, amount_incl_cents, provider, note) values
  ('5c000000-0000-4000-9000-0000000000c1', 49500, 'manual', 'assistance_cap.sql'),
  ('5c000000-0000-4000-9000-0000000000a1', 49500, 'manual', 'assistance_cap.sql');
set local session_replication_role = origin;

-- == Existing customers keep their limit (the migration's own function, on fixtures) ========
-- C1 and U chose before; the old ones did not: M1 had its own R300 on the old settings, M2 was
-- on the platform default and never paid. M3 is billed through M1.
insert into public.assistance_budgets (farm_id, monthly_limit_cents, source) values
  ('5c000000-0000-4000-9000-0000000000c1', 20000, 'owner'),
  ('5c000000-0000-4000-9000-00000000000f', 20000, 'owner');
insert into public.farm_ai_settings (farm_id, monthly_limit_cents) values ('5c000000-0000-4000-9000-0000000000a1', 30000);
do $t$
declare v_n integer;
begin
  -- The new customer N must stay without a budget for [30]: give it nothing yet, but keep it
  -- out of this run by removing its row afterwards (a migration runs once, before N existed).
  v_n := app.assistance_migrate_existing();
  delete from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-00000000000e';
  delete from public.notifications where farm_id = '5c000000-0000-4000-9000-00000000000e';
  if (select monthly_limit_cents from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000a1') <> 30000
     or (select source from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000a1') <> 'migrated' then
    raise exception 'ASSIST FAIL [migrate]: an own limit was not kept as the choice';
  end if;
  if (select monthly_limit_cents from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000a2') <> 20000
     or app.ai_effective_limit('5c000000-0000-4000-9000-0000000000a2') <> 5000 then
    raise exception 'ASSIST FAIL [migrate]: an unpaid customer on the default does not keep R200 under the R50 trial guard';
  end if;
  if app.ai_effective_limit('5c000000-0000-4000-9000-0000000000a1') <> 30000
     or app.ai_effective_limit('5c000000-0000-4000-9000-0000000000a3') <> 30000 then
    raise exception 'ASSIST FAIL [migrate]: a migrated customer''s limit changed, or its other site has another';
  end if;
  if exists (select 1 from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000a3')
     or (select source from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000c1') <> 'owner' then
    raise exception 'ASSIST FAIL [migrate]: a pooled site got its own budget, or a chosen one was overwritten';
  end if;
  if not exists (select 1 from public.notifications where user_id = '5c100000-0000-4000-9000-000000000007'
                   and template = 'assistance_budget_migrated' and (payload ->> 'limit_cents')::bigint = 30000)
     or exists (select 1 from public.notifications where template = 'assistance_budget_migrated'
                  and farm_id = '5c000000-0000-4000-9000-0000000000c1') then
    raise exception 'ASSIST FAIL [migrate]: the owners were not told, or a customer that had chosen was';
  end if;
  if app.assistance_migrate_existing() <> 0 then
    raise exception 'ASSIST FAIL [migrate]: a second run changed something';
  end if;
end $t$;

-- == 30: no budget, no paid work ============================================================
do $t$
declare v jsonb; r jsonb;
begin
  v := pg_temp.hold('5c000000-0000-4000-9000-00000000000e', '5c100000-0000-4000-9000-000000000005', 0.01);
  if v ->> 'reason' is distinct from 'budget_unset' then
    raise exception 'ASSIST FAIL [30]: a customer with no limit chosen got paid work: %', v;
  end if;
  v := app.ai_open_voice_session('5c000000-0000-4000-9000-00000000000e', '5c100000-0000-4000-9000-000000000005', 30000, 500, 'test');
  if v ->> 'reason' is distinct from 'budget_unset' then
    raise exception 'ASSIST FAIL [30]: a voice session opened without a chosen limit: %', v;
  end if;
  if app.ai_effective_limit('5c000000-0000-4000-9000-00000000000e') <> 0 then
    raise exception 'ASSIST FAIL [30]: an unchosen limit is not nothing';
  end if;
  -- The business's own OpenAI key is its own money: neither capped nor billed by us.
  v := pg_temp.hold('5c000000-0000-4000-9000-00000000000e', '5c100000-0000-4000-9000-000000000005', 3, 'farm_openai');
  if not (v ->> 'ok')::boolean or v ->> 'credential' <> 'farm_openai' then
    raise exception 'ASSIST FAIL [32]: an own-key call was stopped by the budget: %', v;
  end if;
  r := app.ai_settle((v ->> 'id')::uuid, jsonb_build_array(jsonb_build_object(
         'model', 'test/meter', 'outcome', 'ok', 'units', jsonb_build_object('input_tokens', 3000))));
  if (r ->> 'billed_cents')::numeric <> 0
     or (select billed_cents from public.ai_usage where reservation_id = (v ->> 'id')::uuid) <> 0
     or (select provider_cost_usd from public.ai_usage where reservation_id = (v ->> 'id')::uuid) <> 3 then
    raise exception 'ASSIST FAIL [32]: an own-key call was billed again: %', r;
  end if;
end $t$;

select pg_temp.as_user('5c100000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.ai_farm_usage('5c000000-0000-4000-9000-00000000000e');
  if v -> 'budget' <> 'null'::jsonb or (v ->> 'limit_cents')::bigint <> 0 then
    raise exception 'ASSIST FAIL [30]: the page does not say no limit is chosen: %', v;
  end if;
  -- Blank is refused, never unlimited.
  v := public.ai_set_farm_limit('5c000000-0000-4000-9000-00000000000e', null);
  if v ->> 'reason' is distinct from 'limit_required' then
    raise exception 'ASSIST FAIL [30]: a blank limit was accepted: %', v;
  end if;
  -- Zero is a clear choice.
  v := public.ai_set_farm_limit('5c000000-0000-4000-9000-00000000000e', 0);
  if not (v ->> 'ok')::boolean or (v ->> 'limit_cents')::bigint <> 0 then
    raise exception 'ASSIST FAIL [30]: zero was not accepted as a choice: %', v;
  end if;
end $t$;
reset role;
do $t$
declare v jsonb;
begin
  v := pg_temp.hold('5c000000-0000-4000-9000-00000000000e', '5c100000-0000-4000-9000-000000000005', 0.01);
  if v ->> 'reason' is distinct from 'farm_limit' then
    raise exception 'ASSIST FAIL [30]: a zero limit allowed paid work: %', v;
  end if;
  if (select source from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-00000000000e') <> 'owner'
     or (select chosen_by from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-00000000000e') <> '5c100000-0000-4000-9000-000000000005' then
    raise exception 'ASSIST FAIL [30]: the owner''s choice was not recorded as theirs';
  end if;
end $t$;
select pg_temp.as_user('5c100000-0000-4000-9000-000000000005');
set local role authenticated;
select public.ai_set_farm_limit('5c000000-0000-4000-9000-00000000000e', 3000);
reset role;
do $t$
declare v jsonb;
begin
  v := pg_temp.hold('5c000000-0000-4000-9000-00000000000e', '5c100000-0000-4000-9000-000000000005', 0.01);
  if not (v ->> 'ok')::boolean then
    raise exception 'ASSIST FAIL [30]: a positive limit did not allow paid work: %', v;
  end if;
end $t$;

-- == 31: one budget across sites, people and channels =======================================
do $t$
declare
  a jsonb; b1 jsonb; b2 jsonb; b3 jsonb; r jsonb;
  v_one numeric := app.ai_billed_cents(1, app.ai_fx(now()), 3000);
begin
  -- The estimate is the customer's charge: provider cost at the day's rate plus 30%.
  if v_one <> round(1 * app.ai_fx(now()) * 100 * 1.3, 4) then
    raise exception 'ASSIST FAIL [31]: the margin is not 30%% on cost';
  end if;
  -- Anna at the main depot: about R108 held, not settled.
  a := pg_temp.hold('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 5);
  if not (a ->> 'ok')::boolean or (a ->> 'estimate_cents')::numeric <> 5 * v_one then
    raise exception 'ASSIST FAIL [31]: the hold is not the customer charge: % (one dollar = %)', a, v_one;
  end if;
  -- Ben at the North depot: his hold fits beside Anna's...
  b1 := pg_temp.hold('5c000000-0000-4000-9000-0000000000c2', '5c100000-0000-4000-9000-000000000003', 4);
  if not (b1 ->> 'ok')::boolean then raise exception 'ASSIST FAIL [31]: %', b1; end if;
  -- ...and the next does not: the in-flight hold at the other site counts against one R200.
  b2 := pg_temp.hold('5c000000-0000-4000-9000-0000000000c2', '5c100000-0000-4000-9000-000000000003', 1);
  if b2 ->> 'reason' is distinct from 'farm_limit' or (b2 ->> 'limit_cents')::bigint <> 20000 then
    raise exception 'ASSIST FAIL [31]: two sites spent past one customer limit: %', b2;
  end if;
  -- Anna's call came back at a dollar: settling frees the rest of her hold.
  r := app.ai_settle((a ->> 'id')::uuid, jsonb_build_array(jsonb_build_object(
         'model', 'test/meter', 'outcome', 'ok', 'units', jsonb_build_object('input_tokens', 1000))));
  if (r ->> 'billed_cents')::numeric <> v_one then
    raise exception 'ASSIST FAIL [31]: settlement did not bill what was used: %', r;
  end if;
  b3 := pg_temp.hold('5c000000-0000-4000-9000-0000000000c2', '5c100000-0000-4000-9000-000000000003', 1);
  if not (b3 ->> 'ok')::boolean then
    raise exception 'ASSIST FAIL [31]: the unused part of a settled hold was not released: %', b3;
  end if;
  -- An unrelated business never paid: its R200 choice is held at the R50 trial.
  if app.ai_effective_limit('5c000000-0000-4000-9000-00000000000f') <> 5000 then
    raise exception 'ASSIST FAIL [31]: the trial guard does not hold an unpaid customer';
  end if;
end $t$;

-- A person's limit, set from the North depot, holds for them on every site and lifts nothing.
select pg_temp.as_user('5c100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.ai_set_member_limit('5c000000-0000-4000-9000-0000000000c2', '5c100000-0000-4000-9000-000000000003', 3000);
  if not (v ->> 'ok')::boolean then raise exception 'ASSIST FAIL [31]: the sublimit was refused: %', v; end if;
end $t$;
reset role;
do $t$
declare v jsonb;
begin
  if not exists (select 1 from public.farm_member_ai_limits where farm_id = '5c000000-0000-4000-9000-0000000000c1'
                   and user_id = '5c100000-0000-4000-9000-000000000003' and monthly_limit_cents = 3000)
     or exists (select 1 from public.farm_member_ai_limits where farm_id = '5c000000-0000-4000-9000-0000000000c2') then
    raise exception 'ASSIST FAIL [31]: the sublimit was not kept once for the customer';
  end if;
  -- Ben (already past R30 at the North depot) is stopped at the MAIN depot too; Anna is not.
  insert into public.user_farm_memberships (user_id, farm_id, role) values
    ('5c100000-0000-4000-9000-000000000003', '5c000000-0000-4000-9000-0000000000c1', 'operator');
  v := pg_temp.hold('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000003', 0.01);
  if v ->> 'reason' is distinct from 'member_limit' then
    raise exception 'ASSIST FAIL [31]: a sublimit did not hold at another site: %', v;
  end if;
  v := pg_temp.hold('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 0.01);
  if not (v ->> 'ok')::boolean then
    raise exception 'ASSIST FAIL [31]: one person''s sublimit stopped another: %', v;
  end if;
  -- A sublimit above the customer's limit does not lift it.
  update public.farm_member_ai_limits set monthly_limit_cents = 500000
   where farm_id = '5c000000-0000-4000-9000-0000000000c1' and user_id = '5c100000-0000-4000-9000-000000000003';
  v := pg_temp.hold('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000003', 5);
  if v ->> 'reason' is distinct from 'farm_limit' then
    raise exception 'ASSIST FAIL [31]: a large sublimit went past the customer''s limit: %', v;
  end if;
  -- Structural: the customer's budget row is locked before anything is counted.
  if position('from public.assistance_budgets where farm_id = v_root for update'
              in (select prosrc from pg_proc where oid = 'app.ai_reserve(uuid,uuid,text,text,jsonb,text)'::regprocedure))
     > position('ai_month_spend' in (select prosrc from pg_proc where oid = 'app.ai_reserve(uuid,uuid,text,text,jsonb,text)'::regprocedure))
     or position('from public.assistance_budgets where farm_id = v_root for update'
              in (select prosrc from pg_proc where oid = 'app.ai_reserve(uuid,uuid,text,text,jsonb,text)'::regprocedure)) = 0 then
    raise exception 'ASSIST FAIL [31]: holds are not serialised per customer before counting';
  end if;
end $t$;

-- The owner's page: the customer's figures, the zone and the reset, for monthly and annual alike.
select pg_temp.as_user('5c100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.ai_farm_usage('5c000000-0000-4000-9000-0000000000c2');
  if v ->> 'time_zone' <> 'Africa/Johannesburg' or (v ->> 'sites')::int <> 2
     or (v ->> 'resets_at')::timestamptz <> ((app.ai_month(now()) + interval '1 month')::timestamp at time zone 'Africa/Johannesburg')
     or (v #>> '{budget,chosen_cents}')::bigint <> 20000 or (v ->> 'held_cents')::numeric <= 0
     or (v ->> 'billed_cents')::numeric <> app.ai_billed_cents(1, app.ai_fx(now()), 3000) then
    raise exception 'ASSIST FAIL [31]: the owner''s page is wrong: %', v;
  end if;
end $t$;
reset role;
select pg_temp.as_user('5c100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  begin
    perform public.ai_farm_usage('5c000000-0000-4000-9000-0000000000c1');
    raise exception 'ASSIST FAIL [read]: a manager read the spending';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.assistance_budgets) then
    raise exception 'ASSIST FAIL [read]: a manager read the budget';
  end if;
  begin
    perform public.assistance_accept_whatsapp('5c000000-0000-4000-9000-0000000000c1', true, 'whatsapp-charges-2026-11');
    raise exception 'ASSIST FAIL [32]: a manager accepted paid WhatsApp';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- == 32: WhatsApp on the same ledger ========================================================
do $t$
declare v jsonb;
begin
  -- Not billed yet (Rapid Rise has not switched it on): sent as today, nothing held.
  v := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  if not (v ->> 'ok')::boolean or (v ->> 'metered')::boolean
     or exists (select 1 from public.ai_reservations where feature = 'whatsapp_message') then
    raise exception 'ASSIST FAIL [32]: an unbilled message was held: %', v;
  end if;
  update public.billing_settings set whatsapp_billing_starts_on = app.billing_today() where singleton;
  v := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  if v ->> 'reason' is distinct from 'whatsapp_not_accepted' then
    raise exception 'ASSIST FAIL [32]: a paid message without the owner''s acceptance: %', v;
  end if;
end $t$;
select pg_temp.as_user('5c100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.assistance_accept_whatsapp('5c000000-0000-4000-9000-0000000000c2', true, null);
  if v ->> 'reason' is distinct from 'terms_required' then raise exception 'ASSIST FAIL [32]: acceptance without terms: %', v; end if;
  v := public.assistance_accept_whatsapp('5c000000-0000-4000-9000-0000000000c2', true, 'whatsapp-charges-2026-11');
  if not (v ->> 'ok')::boolean or (v ->> 'limit_cents')::bigint <> 20000 then
    raise exception 'ASSIST FAIL [32]: the owner could not accept: %', v;
  end if;
end $t$;
reset role;
do $t$
declare v jsonb; b public.assistance_budgets;
begin
  select * into b from public.assistance_budgets where farm_id = '5c000000-0000-4000-9000-0000000000c1';
  if b.whatsapp_accepted_by <> '5c100000-0000-4000-9000-000000000001' or b.whatsapp_accepted_at is null
     or b.whatsapp_terms_version <> 'whatsapp-charges-2026-11' or b.whatsapp_accepted_limit_cents <> 20000 then
    raise exception 'ASSIST FAIL [32]: the acceptance evidence is incomplete: %', to_jsonb(b);
  end if;
  -- No rate for the category: nothing is sent at a price we could not bill or cap.
  v := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  if v ->> 'reason' is distinct from 'whatsapp_unpriced' then
    raise exception 'ASSIST FAIL [32]: an unpriced category was held: %', v;
  end if;
  insert into public.ai_prices (model, unit, usd_per_unit, effective_from, source) values
    ('whatsapp/utility', 'message', 0.02, now() - interval '1 minute', 'manual');
end $t$;

do $t$
declare
  free jsonb; paid jsonb; quiet jsonb; lost jsonb; refused jsonb; r jsonb; u public.ai_usage;
  v_spent_before numeric;
begin
  v_spent_before := app.ai_month_spend('5c000000-0000-4000-9000-0000000000c1', app.ai_month(now()));
  free := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  if not (free ->> 'ok')::boolean or not (free ->> 'metered')::boolean then
    raise exception 'ASSIST FAIL [32]: the message was not held: %', free;
  end if;
  -- In flight, it counts against the customer's one budget like any other paid work.
  if app.ai_month_spend('5c000000-0000-4000-9000-0000000000c2', app.ai_month(now())) <= v_spent_before then
    raise exception 'ASSIST FAIL [31]: a WhatsApp hold does not count against the shared budget';
  end if;
  perform public.whatsapp_usage_sent((free ->> 'id')::uuid, 'wamid.free-1');
  -- Delivered free inside the customer service window: R0.
  r := public.whatsapp_usage_settle('wamid.free-1', 'delivered', false, 'free_customer_service', 'utility');
  select * into u from public.ai_usage where reservation_id = (free ->> 'id')::uuid;
  if u.billed_cents <> 0 or u.provider_cost_usd <> 0 or u.feature <> 'whatsapp_message' or u.provider <> 'whatsapp_cloud'
     or u.measured <> 'provider' or u.pricing_category <> 'utility' or u.generation_id <> 'wamid.free-1' then
    raise exception 'ASSIST FAIL [32]: a provider-free message was not R0: %', to_jsonb(u);
  end if;

  paid := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  perform public.whatsapp_usage_sent((paid ->> 'id')::uuid, 'wamid.paid-1');
  r := public.whatsapp_usage_settle('wamid.paid-1', 'delivered', true, 'regular', 'utility');
  select * into u from public.ai_usage where reservation_id = (paid ->> 'id')::uuid;
  if u.billed_cents <> app.ai_billed_cents(0.02, u.usd_zar, 3000) or u.provider_cost_usd <> 0.02 or u.margin_bps <> 3000
     or u.billing_root <> '5c000000-0000-4000-9000-0000000000c1' or u.rate_version is null or u.rate_version = 'provider_reported'
     or u.supplier_currency <> 'USD' or u.supplier_tax <> 'unconfirmed' then
    raise exception 'ASSIST FAIL [32]: a billable message is not cost plus 30%%, or its record is incomplete: %', to_jsonb(u);
  end if;
  -- Meta repeats the status (delivered, then read): nothing more.
  r := public.whatsapp_usage_settle('wamid.paid-1', 'read', true, 'regular', 'utility');
  if not coalesce((r ->> 'already')::boolean, false)
     or (select count(*) from public.ai_usage where reservation_id = (paid ->> 'id')::uuid) <> 1 then
    raise exception 'ASSIST FAIL [32]: a repeated status billed again: %', r;
  end if;
  -- A status without pricing (sent) settles nothing; a failed delivery settles at R0.
  quiet := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  perform public.whatsapp_usage_sent((quiet ->> 'id')::uuid, 'wamid.quiet-1');
  r := public.whatsapp_usage_settle('wamid.quiet-1', 'sent', null, null, null);
  if (select settled_at from public.ai_reservations where id = (quiet ->> 'id')::uuid) is not null then
    raise exception 'ASSIST FAIL [32]: a sent status settled the message';
  end if;
  r := public.whatsapp_usage_settle('wamid.quiet-1', 'failed', null, null, null);
  if (select billed_cents from public.ai_usage where reservation_id = (quiet ->> 'id')::uuid) <> 0
     or (select outcome from public.ai_usage where reservation_id = (quiet ->> 'id')::uuid) <> 'failed' then
    raise exception 'ASSIST FAIL [32]: a failed delivery was billed';
  end if;
  -- Refused by Meta before it was taken: released at R0.
  refused := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  perform public.whatsapp_usage_release((refused ->> 'id')::uuid, 'send_failed');
  if (select billed_cents from public.ai_usage where reservation_id = (refused ->> 'id')::uuid) <> 0 then
    raise exception 'ASSIST FAIL [32]: a message Meta never took was billed';
  end if;
  -- Never answered: still held after two hours (Meta reports on delivery), R0 after 72.
  lost := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c1', '5c100000-0000-4000-9000-000000000002', 'utility');
  perform public.whatsapp_usage_sent((lost ->> 'id')::uuid, 'wamid.lost-1');
  update public.ai_reservations set created_at = now() - interval '2 hours' where id = (lost ->> 'id')::uuid;
  perform app.ai_settle_stale();
  if (select settled_at from public.ai_reservations where id = (lost ->> 'id')::uuid) is not null then
    raise exception 'ASSIST FAIL [32]: a message was given up on before Meta could report it';
  end if;
  update public.ai_reservations set created_at = now() - interval '73 hours' where id = (lost ->> 'id')::uuid;
  perform app.ai_settle_stale();
  select * into u from public.ai_usage where reservation_id = (lost ->> 'id')::uuid;
  if u.billed_cents <> 0 or u.outcome <> 'unknown' or u.provider <> 'whatsapp_cloud' or u.provider_cost_usd <= 0 then
    raise exception 'ASSIST FAIL [32]: a never-answered message was not settled at R0 with its cost kept: %', to_jsonb(u);
  end if;
  -- A late status after that changes nothing.
  r := public.whatsapp_usage_settle('wamid.lost-1', 'delivered', true, 'regular', 'utility');
  if (select count(*) from public.ai_usage where reservation_id = (lost ->> 'id')::uuid) <> 1 then
    raise exception 'ASSIST FAIL [32]: a late status billed a settled message';
  end if;
end $t$;

-- In the grace, no paid WhatsApp.
do $t$
declare v jsonb; v_inv uuid;
begin
  insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind, period_start, period_end,
    issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values ('5c000000-0000-4000-9000-0000000000c1',
          (select id from public.billing_subscriptions where farm_id = '5c000000-0000-4000-9000-0000000000c1'),
          'ASSIST-GRACE-1', 'draft', 'period', current_date - 3, current_date + 26, current_date - 3, current_date - 3,
          'complete', 'monthly', 5, 9900, 1, 'launch-2026-11-eq', 0)
  returning id into v_inv;
  update public.billing_invoices set status = 'open' where id = v_inv;
  v := public.whatsapp_usage_reserve('5c000000-0000-4000-9000-0000000000c2', '5c100000-0000-4000-9000-000000000003', 'utility');
  if v ->> 'reason' is distinct from 'billing_paused' then
    raise exception 'ASSIST FAIL [32]: a paid message in the grace: %', v;
  end if;
end $t$;

rollback;
