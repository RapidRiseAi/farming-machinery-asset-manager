-- AI and voice use on the invoice (20261010090000, billed on the farm's billing date by
-- 20261011090000).
--
-- What this proves: nothing is billed until Rapid Rise sets a start date; once it is set, a
-- period invoice carries all unbilled use up to yesterday (never today's, never use from
-- before the start, never Rapid Rise's own support use), added after the discount and with
-- VAT at the invoice's rate; the rows are stamped once and the invoice freezes them, with
-- who used it; a farm no period invoice reaches gets an AI-only invoice on its own billing
-- day once its use reaches the minimum, and a missed billing day is caught up; never two
-- invoices carrying AI in one day; a trial is never sent one; and the renewal notice quotes
-- the discounted plan plus the AI use so far.
\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

create temporary table _p as
  select per_vehicle_monthly_incl_cents as unit, months_charged as months
    from public.billing_price_versions
   where plan = 'complete' and billing_period = 'monthly' and status = 'active'
   limit 1;
do $$
begin
  if not exists (select 1 from _p where unit is not null) then
    raise exception 'AI INVOICE SETUP: no active complete/monthly price to test against';
  end if;
end $$;

-- Days in Johannesburg, as the billing window counts them. Every row below is placed on a
-- day relative to today, so the suite means the same thing on any day of any month.
create temporary table _d as
  select t as today,
         t - 70 as before_start,
         t - 60 as start_on,
         t - 50 as old_day,        -- older than 35 days: a missed billing date
         t - 20 as mid_day,
         t - 1  as yesterday,
         extract(day from t)::integer as today_dom,
         (extract(day from t)::integer % 28) + 1 as other_dom
    from (select (now() at time zone 'Africa/Johannesburg')::date as t) x;

insert into public.farms (id, name, plan, status, billing_period) values
  ('e1000000-0000-4000-9000-00000000000a', 'Monthly founding farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000b', 'Annual farm due today', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-00000000000c', 'Monthly renews later', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000d', 'Trial farm', 'complete', 'trial', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000e', 'Small user farm', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-00000000000f', 'Missed day farm', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-000000000005', 'Not its day farm', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-000000000006', 'Gate off farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-000000000007', 'VAT farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-000000000008', 'Notice farm', 'complete', 'active', 'monthly');

insert into auth.users (id, email)
select ('e1a00000-0000-4000-9000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'ai.invoice' || g::text || '@example.invalid'
  from generate_series(1, 12) g;

-- One owner per farm (the notice goes to owners), and two named people on the founding farm.
insert into public.users (id, farm_id, role, name, email, active) values
  ('e1a00000-0000-4000-9000-000000000001', 'e1000000-0000-4000-9000-00000000000a', 'owner', 'Anna Owner', 'ai.invoice1@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000002', 'e1000000-0000-4000-9000-00000000000a', 'manager', 'Ben Manager', 'ai.invoice2@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000003', 'e1000000-0000-4000-9000-00000000000b', 'owner', 'B Owner', 'ai.invoice3@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000004', 'e1000000-0000-4000-9000-00000000000c', 'owner', 'C Owner', 'ai.invoice4@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000005', 'e1000000-0000-4000-9000-00000000000d', 'owner', 'D Owner', 'ai.invoice5@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000006', 'e1000000-0000-4000-9000-00000000000e', 'owner', 'E Owner', 'ai.invoice6@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000007', 'e1000000-0000-4000-9000-000000000006', 'owner', 'G Owner', 'ai.invoice7@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000008', 'e1000000-0000-4000-9000-000000000007', 'owner', 'V Owner', 'ai.invoice8@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000009', 'e1000000-0000-4000-9000-000000000008', 'owner', 'R Owner', 'ai.invoice9@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000010', 'e1000000-0000-4000-9000-00000000000f', 'owner', 'F Owner', 'ai.invoice10@example.invalid', true),
  ('e1a00000-0000-4000-9000-000000000011', 'e1000000-0000-4000-9000-000000000005', 'owner', 'H Owner', 'ai.invoice11@example.invalid', true);

insert into public.machines (farm_id, name, type, meter_type, status)
select f.farm_id, 'M' || g::text, 'tractor', 'hours', 'active'
  from (values ('e1000000-0000-4000-9000-00000000000a'::uuid, 10),
               ('e1000000-0000-4000-9000-000000000006'::uuid, 2),
               ('e1000000-0000-4000-9000-000000000007'::uuid, 2),
               ('e1000000-0000-4000-9000-000000000008'::uuid, 2)) f(farm_id, n),
       generate_series(1, f.n) g;

-- next_billing_on and anchor_day decide each farm's billing day of the month.
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, next_billing_on, trial_ends_on, anchor_day,
  discount_percent_bps, discount_label)
select v.id, v.farm_id, 'complete', v.period::billing_period, v.status::billing_subscription_status,
       current_date, v.next_on, v.trial_end,
       case v.anchor when 'today' then today_dom when 'other' then other_dom end,
       v.discount, v.label
  from _d, (values
    -- Renews today: its period invoice carries the use.
    ('e1600000-0000-4000-9000-00000000000a'::uuid, 'e1000000-0000-4000-9000-00000000000a'::uuid, 'monthly', 'active',
       current_date, null::date, null::text, 2000, 'Founding Farmer'),
    -- Annual, billing day today: an AI-only invoice today.
    ('e1600000-0000-4000-9000-00000000000b'::uuid, 'e1000000-0000-4000-9000-00000000000b'::uuid, 'annual', 'active',
       current_date + 200, null::date, 'today', null::integer, null::text),
    -- Monthly, renewing in five days: its renewal will carry the use.
    ('e1600000-0000-4000-9000-00000000000c'::uuid, 'e1000000-0000-4000-9000-00000000000c'::uuid, 'monthly', 'active',
       current_date + 5, null::date, null::text, null::integer, null::text),
    ('e1600000-0000-4000-9000-00000000000d'::uuid, 'e1000000-0000-4000-9000-00000000000d'::uuid, 'monthly', 'trialing',
       current_date + 10, current_date + 10, 'today', null::integer, null::text),
    ('e1600000-0000-4000-9000-00000000000e'::uuid, 'e1000000-0000-4000-9000-00000000000e'::uuid, 'annual', 'active',
       current_date + 200, null::date, 'today', null::integer, null::text),
    -- Annual, billing day NOT today, with use from 50 days ago: a missed billing date.
    ('e1600000-0000-4000-9000-00000000000f'::uuid, 'e1000000-0000-4000-9000-00000000000f'::uuid, 'annual', 'active',
       current_date + 200, null::date, 'other', null::integer, null::text),
    -- Annual, billing day NOT today, fresh use: waits for its day.
    ('e1600000-0000-4000-9000-000000000005'::uuid, 'e1000000-0000-4000-9000-000000000005'::uuid, 'annual', 'active',
       current_date + 200, null::date, 'other', null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000006'::uuid, 'e1000000-0000-4000-9000-000000000006'::uuid, 'monthly', 'active',
       current_date, null::date, null::text, null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000007'::uuid, 'e1000000-0000-4000-9000-000000000007'::uuid, 'monthly', 'active',
       current_date + 10, null::date, null::text, null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000008'::uuid, 'e1000000-0000-4000-9000-000000000008'::uuid, 'monthly', 'active',
       current_date + 3, null::date, null::text, 2000, 'Founding Farmer')
  ) v(id, farm_id, period, status, next_on, trial_end, anchor, discount, label);

-- One settled call in the ledger, at noon Johannesburg on the given day (or now).
create function public._ai_inv_use(p_farm uuid, p_user uuid, p_day date, p_feature text,
  p_billed numeric, p_credential text default 'platform', p_audio_ms integer default null)
returns uuid language plpgsql as $$
declare v_res uuid; v_id uuid; v_at timestamptz;
begin
  v_at := case when p_day is null then now()
               else (p_day + time '12:00')::timestamp at time zone 'Africa/Johannesburg' end;
  insert into public.ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at, created_at)
  values (p_farm, p_user, p_feature, p_credential, 'm', p_billed, app.ai_month(v_at), v_at, v_at)
  returning id into v_res;
  insert into public.ai_usage (farm_id, user_id, occurred_at, month, feature, provider, model, credential,
    measured, usd_zar, margin_bps, outcome, reservation_id, billed_cents, audio_ms, created_at)
  values (p_farm, p_user, v_at, app.ai_month(v_at), p_feature,
    case when p_feature = 'voice' then 'azure_speech' else 'ai_gateway' end, 'm', p_credential,
    'server', 18, 3000, 'ok', v_res, p_billed, p_audio_ms, v_at)
  returning id into v_id;
  return v_id;
end $$;

-- The founding farm: Anna's voice 50 and 20 days ago, Ben's AI help yesterday, Ben's AI help
-- TODAY (billed next time), before the start (never billed), and a Rapid Rise support call.
create temporary table _rows (tag text primary key, id uuid);
insert into _rows
select 'a_old', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000001', old_day, 'voice', 1234.5678, 'platform', 60000) from _d
union all
select 'a_mid', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000001', mid_day, 'voice', 1000.0001, 'platform', 30000) from _d
union all
select 'a_yest', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', yesterday, 'ai_answer', 2500.25) from _d
union all
select 'a_today', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', null, 'ai_answer', 999) from _d
union all
select 'a_before', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', before_start, 'ai_answer', 777) from _d
union all
select 'a_internal', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', mid_day, 'ai_answer', 0, 'internal') from _d
union all
select 'b_mid', public._ai_inv_use('e1000000-0000-4000-9000-00000000000b', 'e1a00000-0000-4000-9000-000000000003', mid_day, 'ai_hearing', 6000) from _d
union all
select 'c_yest', public._ai_inv_use('e1000000-0000-4000-9000-00000000000c', 'e1a00000-0000-4000-9000-000000000004', yesterday, 'ai_answer', 7000) from _d
union all
select 'd_mid', public._ai_inv_use('e1000000-0000-4000-9000-00000000000d', 'e1a00000-0000-4000-9000-000000000005', mid_day, 'ai_answer', 8000) from _d
union all
select 'e_mid', public._ai_inv_use('e1000000-0000-4000-9000-00000000000e', 'e1a00000-0000-4000-9000-000000000006', mid_day, 'ai_answer', 3000) from _d
union all
select 'f_old', public._ai_inv_use('e1000000-0000-4000-9000-00000000000f', 'e1a00000-0000-4000-9000-000000000010', old_day, 'ai_answer', 6000) from _d
union all
select 'h_mid', public._ai_inv_use('e1000000-0000-4000-9000-000000000005', 'e1a00000-0000-4000-9000-000000000011', mid_day, 'ai_answer', 6000) from _d
union all
select 'g_mid', public._ai_inv_use('e1000000-0000-4000-9000-000000000006', 'e1a00000-0000-4000-9000-000000000007', mid_day, 'ai_answer', 4000) from _d
union all
select 'v_mid', public._ai_inv_use('e1000000-0000-4000-9000-000000000007', 'e1a00000-0000-4000-9000-000000000008', mid_day, 'ai_answer', 10000) from _d
union all
select 'r_mid', public._ai_inv_use('e1000000-0000-4000-9000-000000000008', 'e1a00000-0000-4000-9000-000000000009', mid_day, 'ai_answer', 2000) from _d;

-- == (a) Off until a date is set: the invoice is exactly what it was ==========
do $$
declare inv public.billing_invoices%rowtype; v_gross bigint;
begin
  if (select ai_billing_starts_on from public.billing_settings where singleton) is not null then
    raise exception 'AI INVOICE FAIL [a]: invoicing must ship switched off';
  end if;
  select unit * 2 * months into v_gross from _p;
  perform app.generate_billing_invoices('e1600000-0000-4000-9000-000000000006');
  select * into inv from public.billing_invoices where subscription_id = 'e1600000-0000-4000-9000-000000000006';
  if inv.total_incl_cents <> v_gross or inv.ai_usage_ex_vat_cents <> 0 or inv.ai_usage_people is not null then
    raise exception 'AI INVOICE FAIL [a]: with invoicing off the invoice changed (total %, AI %)',
      inv.total_incl_cents, inv.ai_usage_ex_vat_cents;
  end if;
  if (select invoice_id from public.ai_usage where id = (select id from _rows where tag = 'g_mid')) is not null then
    raise exception 'AI INVOICE FAIL [a]: a ledger row was stamped while invoicing is off';
  end if;
  if app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [a]: an AI-only invoice was raised while invoicing is off';
  end if;
end $$;

update public.billing_settings set ai_billing_starts_on = (select start_on from _d) where singleton;

-- == (b) The period invoice carries the use to yesterday, after the discount ===
do $$
declare
  inv public.billing_invoices%rowtype;
  v_gross bigint;
  v_people jsonb;
  v_line record;
begin
  select unit * 10 * months into v_gross from _p;
  perform app.generate_billing_invoices('e1600000-0000-4000-9000-00000000000a');
  select * into inv from public.billing_invoices where subscription_id = 'e1600000-0000-4000-9000-00000000000a';

  -- 1234.5678 + 1000.0001 + 2500.25 = 4734.8179, billed as 4735 cents.
  if inv.ai_usage_ex_vat_cents <> 4735 then
    raise exception 'AI INVOICE FAIL [b]: AI use was % cents, expected 4735', inv.ai_usage_ex_vat_cents;
  end if;
  -- The seller is not VAT registered, so nothing is added.
  if inv.ai_usage_incl_cents <> 4735 then
    raise exception 'AI INVOICE FAIL [b]: AI use incl VAT was %, expected 4735 (no VAT)', inv.ai_usage_incl_cents;
  end if;
  -- The discount is 20% of the PLAN, never of the AI use.
  if inv.discount_cents <> round(v_gross::numeric * 0.20)::bigint then
    raise exception 'AI INVOICE FAIL [b]: discount % is not 20%% of the plan (%)', inv.discount_cents, v_gross;
  end if;
  if inv.total_incl_cents <> v_gross - inv.discount_cents + 4735 then
    raise exception 'AI INVOICE FAIL [b]: total %, expected plan % less % plus 4735',
      inv.total_incl_cents, v_gross, inv.discount_cents;
  end if;
  if inv.subtotal_ex_vat_cents + inv.vat_cents <> inv.total_incl_cents then
    raise exception 'AI INVOICE FAIL [b]: the VAT split no longer adds up';
  end if;
  if inv.status is distinct from 'open' or inv.kind is distinct from 'period' then
    raise exception 'AI INVOICE FAIL [b]: invoice is % / %, expected an issued period invoice', inv.status, inv.kind;
  end if;
  -- The span: the first day with use, to yesterday.
  if inv.ai_usage_from is distinct from (select old_day from _d) or inv.ai_usage_to is distinct from (select yesterday from _d) then
    raise exception 'AI INVOICE FAIL [b]: AI span % to %, expected the first day of use to yesterday',
      inv.ai_usage_from, inv.ai_usage_to;
  end if;

  -- Stamped: exactly the three billable rows.
  if exists (select 1 from public.ai_usage u join _rows r on r.id = u.id
              where r.tag in ('a_old', 'a_mid', 'a_yest') and u.invoice_id is distinct from inv.id) then
    raise exception 'AI INVOICE FAIL [b]: a billable row was not stamped with the invoice';
  end if;
  if exists (select 1 from public.ai_usage u join _rows r on r.id = u.id
              where r.tag in ('a_today', 'a_before', 'a_internal') and u.invoice_id is not null) then
    raise exception 'AI INVOICE FAIL [b]: today''s use, use before the start, or support use was billed';
  end if;

  -- Who used it, biggest first, frozen with names.
  v_people := inv.ai_usage_people;
  if coalesce(jsonb_array_length(v_people), 0) <> 2
     or v_people->0->>'name' is distinct from 'Ben Manager'
     or (v_people->0->>'billed_cents')::numeric is distinct from 2500.25
     or (v_people->0->>'ai_requests')::integer is distinct from 1
     or v_people->1->>'name' is distinct from 'Anna Owner'
     or (v_people->1->>'billed_cents')::numeric is distinct from 2234.5679
     or (v_people->1->>'voice_seconds')::integer is distinct from 90 then
    raise exception 'AI INVOICE FAIL [b]: who used it is wrong: %', v_people;
  end if;

  select * into v_line from public.billing_invoice_lines where invoice_id = inv.id and sort_order = 10;
  if not found or v_line.line_total_incl_cents <> 4735 or v_line.line_ex_vat_cents <> 4735 then
    raise exception 'AI INVOICE FAIL [b]: no AI line on the statement, or the wrong amount';
  end if;
end $$;

-- == (c) Issued means frozen, and a row is stamped once ==========================
do $$
declare v_inv uuid; v_other uuid; v_failed integer := 0;
begin
  select id into v_inv from public.billing_invoices where subscription_id = 'e1600000-0000-4000-9000-00000000000a';
  begin
    update public.billing_invoices set ai_usage_ex_vat_cents = 1 where id = v_inv;
  exception when check_violation then v_failed := v_failed + 1; end;
  begin
    update public.billing_invoices set ai_usage_people = '[]' where id = v_inv;
  exception when check_violation then v_failed := v_failed + 1; end;
  begin
    perform app.billing_attach_ai_usage(v_inv);
  exception when check_violation then v_failed := v_failed + 1; end;
  if v_failed <> 3 then
    raise exception 'AI INVOICE FAIL [c]: an issued invoice''s AI use could be changed (% of 3 refused)', v_failed;
  end if;

  select id into v_other from public.billing_invoices where subscription_id = 'e1600000-0000-4000-9000-000000000006';
  begin
    update public.ai_usage set invoice_id = v_other where id = (select id from _rows where tag = 'a_yest');
    raise exception 'AI INVOICE FAIL [c]: a stamped row was moved to another invoice';
  exception when insufficient_privilege then null; end;
end $$;

-- == (g) A VAT-registered seller adds VAT to the AI use at the invoice's rate =======
-- The plan's price is VAT-inclusive (VAT is derived FROM it); the ledger is ex VAT, which
-- is what the owner's page says, so VAT is added TO the AI use. The catalogue price this
-- suite reads carries no rate, so the invoice is written at 15% by hand, as the billing
-- suite's own VAT case does. Before the AI-only run, as the cron raises period invoices
-- first.
update public.billing_settings set vat_registered = true, vat_number = '4123456789' where singleton;
do $$
declare inv public.billing_invoices%rowtype; v_inv uuid := gen_random_uuid(); v_plan bigint;
begin
  select unit * 2 into v_plan from _p;
  insert into public.billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values (v_inv, 'e1000000-0000-4000-9000-000000000007', 'e1600000-0000-4000-9000-000000000007',
    'E1-INV-VAT', 'draft', current_date + 40, current_date + 69, current_date, current_date,
    'complete', 'monthly', 2, (select unit from _p), 1, 'e1-synthetic', 1500);
  if app.billing_attach_ai_usage(v_inv) <> 10000 then
    raise exception 'AI INVOICE FAIL [g]: the VAT farm''s use was not attached';
  end if;
  update public.billing_invoices set status = 'open' where id = v_inv;
  select * into inv from public.billing_invoices where id = v_inv;
  if inv.vat_rate_bps <> 1500 or inv.ai_usage_ex_vat_cents <> 10000 or inv.ai_usage_incl_cents <> 11500 then
    raise exception 'AI INVOICE FAIL [g]: AI use with VAT was % (ex %), rate %, expected 11500 at 1500',
      inv.ai_usage_incl_cents, inv.ai_usage_ex_vat_cents, inv.vat_rate_bps;
  end if;
  if inv.total_incl_cents <> v_plan + 11500 then
    raise exception 'AI INVOICE FAIL [g]: total %, expected the inclusive plan % plus 11500', inv.total_incl_cents, v_plan;
  end if;
  if inv.subtotal_ex_vat_cents + inv.vat_cents <> inv.total_incl_cents then
    raise exception 'AI INVOICE FAIL [g]: the VAT split no longer adds up';
  end if;
end $$;
update public.billing_settings set vat_registered = false, vat_number = null where singleton;

-- == (d) AI-only invoices: on the farm's own billing day =========================
do $$
declare inv public.billing_invoices%rowtype;
begin
  perform app.generate_ai_usage_invoices();

  -- The annual farm whose billing day is today, over the minimum.
  select * into inv from public.billing_invoices where farm_id = 'e1000000-0000-4000-9000-00000000000b';
  if not found then
    raise exception 'AI INVOICE FAIL [d]: the annual farm got no AI-only invoice on its billing day';
  end if;
  if inv.kind is distinct from 'ai_usage' or inv.status is distinct from 'open' or inv.asset_count <> 0
     or inv.unit_price_incl_cents <> 0 or inv.total_incl_cents <> 6000
     or inv.subscription_id is distinct from 'e1600000-0000-4000-9000-00000000000b'
     or inv.period_start is distinct from (select mid_day from _d)
     or inv.period_end is distinct from (select yesterday from _d) then
    raise exception 'AI INVOICE FAIL [d]: the AI-only invoice is wrong: kind %, status %, % vehicles, total %, % to %',
      inv.kind, inv.status, inv.asset_count, inv.total_incl_cents, inv.period_start, inv.period_end;
  end if;

  -- A billing day the run missed: use 50 days old is billed on a day that is not its day.
  if not exists (select 1 from public.billing_invoices
                  where farm_id = 'e1000000-0000-4000-9000-00000000000f' and kind = 'ai_usage' and total_incl_cents = 6000) then
    raise exception 'AI INVOICE FAIL [d]: use waiting over 35 days was not caught up';
  end if;

  -- Never a trial; nothing under the minimum; nothing before the farm's own day (annual,
  -- fresh use); nothing for a monthly farm whose renewal will carry it.
  if exists (select 1 from public.billing_invoices
              where farm_id in ('e1000000-0000-4000-9000-00000000000d', 'e1000000-0000-4000-9000-00000000000e',
                                'e1000000-0000-4000-9000-000000000005', 'e1000000-0000-4000-9000-00000000000c')) then
    raise exception 'AI INVOICE FAIL [d]: a trial, a farm under the minimum, or a farm not on its billing day was invoiced';
  end if;
  -- The founding farm's period invoice took its use this morning; no second invoice today.
  if exists (select 1 from public.billing_invoices
              where farm_id = 'e1000000-0000-4000-9000-00000000000a' and kind = 'ai_usage') then
    raise exception 'AI INVOICE FAIL [d]: a farm billed on its period invoice got an AI-only invoice as well';
  end if;

  if app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [d]: a second run raised another AI-only invoice';
  end if;
end $$;

-- == (e) Under the minimum waits, and is billed once it gets there ==================
do $$
declare inv public.billing_invoices%rowtype;
begin
  perform public._ai_inv_use('e1000000-0000-4000-9000-00000000000e', 'e1a00000-0000-4000-9000-000000000006',
                             (select old_day from _d), 'ai_answer', 2500);
  perform app.generate_ai_usage_invoices();
  select * into inv from public.billing_invoices where farm_id = 'e1000000-0000-4000-9000-00000000000e';
  if not found or inv.total_incl_cents <> 5500
     or inv.period_start is distinct from (select old_day from _d)
     or inv.period_end is distinct from (select yesterday from _d)
     or inv.ai_usage_from is distinct from (select old_day from _d) then
    raise exception 'AI INVOICE FAIL [e]: use carried forward was not billed when it reached the minimum (%, % to %)',
      inv.total_incl_cents, inv.period_start, inv.period_end;
  end if;
end $$;

-- == (f) A hold settled after the morning run waits: never two in a day ==============
do $$
declare v_before bigint;
begin
  perform public._ai_inv_use('e1000000-0000-4000-9000-00000000000b', 'e1a00000-0000-4000-9000-000000000003',
                             (select yesterday from _d), 'ai_answer', 9000);
  v_before := (select last_value from public.billing_invoice_ref_seq);
  if app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [f]: a farm got a second invoice carrying AI the same day';
  end if;
  if (select last_value from public.billing_invoice_ref_seq) <> v_before then
    raise exception 'AI INVOICE FAIL [f]: an invoice number was taken and thrown away';
  end if;
end $$;

-- == (h) The renewal notice: the discounted plan, plus the AI use so far ============
do $$
declare v_payload jsonb; v_gross bigint;
begin
  select unit * 2 * months into v_gross from _p;
  perform app.enqueue_billing_renewal_notices();
  select payload into v_payload from public.notifications
   where farm_id = 'e1000000-0000-4000-9000-000000000008' and template = 'billing_renewal_due'
   limit 1;
  if v_payload is null then
    raise exception 'AI INVOICE FAIL [h]: no renewal notice was queued';
  end if;
  if (v_payload->>'amount_cents')::bigint is distinct from v_gross - round(v_gross::numeric * 0.20)::bigint then
    raise exception 'AI INVOICE FAIL [h]: the notice quoted % for the plan, expected the discounted %',
      v_payload->>'amount_cents', v_gross - round(v_gross::numeric * 0.20)::bigint;
  end if;
  if (v_payload->>'ai_billed')::boolean is distinct from true or (v_payload->>'ai_cents')::bigint is distinct from 2000 then
    raise exception 'AI INVOICE FAIL [h]: the notice does not carry the AI use: %', v_payload;
  end if;
end $$;

-- == (i) A start date still to come bills nothing yet ==============================
update public.billing_settings set ai_billing_starts_on = (select today + 5 from _d) where singleton;
do $$
begin
  if app.ai_billing_from() is not null or app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [i]: a start date in the future already bills';
  end if;
end $$;

drop function public._ai_inv_use(uuid, uuid, date, text, numeric, text, integer);

rollback;
