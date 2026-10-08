-- AI and voice use on the invoice (20261010090000).
--
-- What this proves: nothing is billed until Rapid Rise sets a start date; once it is set, a
-- period invoice carries every unbilled completed month (never the running month, never
-- use from before the start, never Rapid Rise's own support use), added after the discount
-- and with VAT at the invoice's rate; the rows are stamped once and the invoice freezes
-- them, with who used it; a farm no period invoice will reach this month gets an AI-only
-- invoice once its use reaches the minimum, and only once; a trial is never sent one; and
-- the renewal notice quotes the discounted plan plus the AI use.
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

-- Months in Johannesburg, as the ledger keeps them.
create temporary table _m as
  select app.ai_month(now()) as this_month,
         (app.ai_month(now()) - interval '1 month')::date as last_month,
         (app.ai_month(now()) - interval '2 months')::date as two_ago,
         (app.ai_month(now()) - interval '3 months')::date as three_ago,
         (app.ai_month(now()) - interval '1 day')::date as last_month_end,
         (app.ai_month(now()) + interval '1 month' - interval '1 day')::date as month_end,
         (now() at time zone 'Africa/Johannesburg')::date as today;

insert into public.farms (id, name, plan, status, billing_period) values
  ('e1000000-0000-4000-9000-00000000000a', 'Monthly founding farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000b', 'Annual farm', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-00000000000c', 'Renews later farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000d', 'Trial farm', 'complete', 'trial', 'monthly'),
  ('e1000000-0000-4000-9000-00000000000e', 'Small user farm', 'complete', 'active', 'annual'),
  ('e1000000-0000-4000-9000-000000000006', 'Gate off farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-000000000007', 'VAT farm', 'complete', 'active', 'monthly'),
  ('e1000000-0000-4000-9000-000000000008', 'Notice farm', 'complete', 'active', 'monthly');

insert into auth.users (id, email)
select ('e1a00000-0000-4000-9000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'ai.invoice' || g::text || '@example.invalid'
  from generate_series(1, 10) g;

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
  ('e1a00000-0000-4000-9000-000000000009', 'e1000000-0000-4000-9000-000000000008', 'owner', 'R Owner', 'ai.invoice9@example.invalid', true);

insert into public.machines (farm_id, name, type, meter_type, status)
select f.farm_id, 'M' || g::text, 'tractor', 'hours', 'active'
  from (values ('e1000000-0000-4000-9000-00000000000a'::uuid, 10),
               ('e1000000-0000-4000-9000-000000000006'::uuid, 2),
               ('e1000000-0000-4000-9000-000000000007'::uuid, 2),
               ('e1000000-0000-4000-9000-000000000008'::uuid, 2)) f(farm_id, n),
       generate_series(1, f.n) g;

insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, next_billing_on, trial_ends_on,
  discount_percent_bps, discount_label)
select v.id, v.farm_id, 'complete', v.period::billing_period, v.status::billing_subscription_status,
       current_date, v.next_on, v.trial_end, v.discount, v.label
  from _m, (values
    ('e1600000-0000-4000-9000-00000000000a'::uuid, 'e1000000-0000-4000-9000-00000000000a'::uuid, 'monthly', 'active',
       current_date, null::date, 2000, 'Founding Farmer'),
    ('e1600000-0000-4000-9000-00000000000b'::uuid, 'e1000000-0000-4000-9000-00000000000b'::uuid, 'annual', 'active',
       current_date + 200, null::date, null::integer, null::text),
    ('e1600000-0000-4000-9000-00000000000c'::uuid, 'e1000000-0000-4000-9000-00000000000c'::uuid, 'monthly', 'active',
       null::date, null::date, null::integer, null::text),
    ('e1600000-0000-4000-9000-00000000000d'::uuid, 'e1000000-0000-4000-9000-00000000000d'::uuid, 'monthly', 'trialing',
       current_date + 10, current_date + 10, null::integer, null::text),
    ('e1600000-0000-4000-9000-00000000000e'::uuid, 'e1000000-0000-4000-9000-00000000000e'::uuid, 'annual', 'active',
       current_date + 200, null::date, null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000006'::uuid, 'e1000000-0000-4000-9000-000000000006'::uuid, 'monthly', 'active',
       current_date, null::date, null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000007'::uuid, 'e1000000-0000-4000-9000-000000000007'::uuid, 'monthly', 'active',
       current_date, null::date, null::integer, null::text),
    ('e1600000-0000-4000-9000-000000000008'::uuid, 'e1000000-0000-4000-9000-000000000008'::uuid, 'monthly', 'active',
       current_date + 3, null::date, 2000, 'Founding Farmer')
  ) v(id, farm_id, period, status, next_on, trial_end, discount, label);

-- The farm that renews later THIS month: its renewal date is the month's last day.
update public.billing_subscriptions s set next_billing_on = m.month_end
  from _m m where s.id = 'e1600000-0000-4000-9000-00000000000c';

-- One settled call in the ledger, on the 10th of the given month (or now, for this month).
create function public._ai_inv_use(p_farm uuid, p_user uuid, p_month date, p_feature text,
  p_billed numeric, p_credential text default 'platform', p_audio_ms integer default null)
returns uuid language plpgsql as $$
declare v_res uuid; v_id uuid; v_at timestamptz;
begin
  v_at := case when p_month = app.ai_month(now()) then now()
               else (p_month + interval '9 days 10 hours')::timestamp at time zone 'Africa/Johannesburg' end;
  insert into public.ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at, created_at)
  values (p_farm, p_user, p_feature, p_credential, 'm', p_billed, p_month, v_at, v_at)
  returning id into v_res;
  insert into public.ai_usage (farm_id, user_id, occurred_at, month, feature, provider, model, credential,
    measured, usd_zar, margin_bps, outcome, reservation_id, billed_cents, audio_ms, created_at)
  values (p_farm, p_user, v_at, p_month, p_feature,
    case when p_feature = 'voice' then 'azure_speech' else 'ai_gateway' end, 'm', p_credential,
    'server', 18, 3000, 'ok', v_res, p_billed, p_audio_ms, v_at)
  returning id into v_id;
  return v_id;
end $$;

-- The founding farm: Anna's voice two months ago and last month, Ben's AI help last month,
-- Ben's AI help THIS month (not billed yet), three months ago (before the start), and a
-- Rapid Rise support call last month (never billed).
create temporary table _rows (tag text primary key, id uuid);
insert into _rows
select 'a_two', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000001', two_ago, 'voice', 1234.5678, 'platform', 60000) from _m
union all
select 'a_last_voice', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000001', last_month, 'voice', 1000.0001, 'platform', 30000) from _m
union all
select 'a_last_ai', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', last_month, 'ai_answer', 2500.25) from _m
union all
select 'a_this', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', this_month, 'ai_answer', 999) from _m
union all
select 'a_before', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', three_ago, 'ai_answer', 777) from _m
union all
select 'a_internal', public._ai_inv_use('e1000000-0000-4000-9000-00000000000a', 'e1a00000-0000-4000-9000-000000000002', last_month, 'ai_answer', 0, 'internal') from _m
union all
select 'b_last', public._ai_inv_use('e1000000-0000-4000-9000-00000000000b', 'e1a00000-0000-4000-9000-000000000003', last_month, 'ai_hearing', 6000) from _m
union all
select 'c_last', public._ai_inv_use('e1000000-0000-4000-9000-00000000000c', 'e1a00000-0000-4000-9000-000000000004', last_month, 'ai_answer', 7000) from _m
union all
select 'd_last', public._ai_inv_use('e1000000-0000-4000-9000-00000000000d', 'e1a00000-0000-4000-9000-000000000005', last_month, 'ai_answer', 8000) from _m
union all
select 'e_last', public._ai_inv_use('e1000000-0000-4000-9000-00000000000e', 'e1a00000-0000-4000-9000-000000000006', last_month, 'ai_answer', 3000) from _m
union all
select 'g_last', public._ai_inv_use('e1000000-0000-4000-9000-000000000006', 'e1a00000-0000-4000-9000-000000000007', last_month, 'ai_answer', 4000) from _m
union all
select 'v_last', public._ai_inv_use('e1000000-0000-4000-9000-000000000007', 'e1a00000-0000-4000-9000-000000000008', last_month, 'ai_answer', 10000) from _m
union all
select 'r_last', public._ai_inv_use('e1000000-0000-4000-9000-000000000008', 'e1a00000-0000-4000-9000-000000000009', last_month, 'ai_answer', 2000) from _m;

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
  if (select invoice_id from public.ai_usage where id = (select id from _rows where tag = 'g_last')) is not null then
    raise exception 'AI INVOICE FAIL [a]: a ledger row was stamped while invoicing is off';
  end if;
  if app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [a]: an AI-only invoice was raised while invoicing is off';
  end if;
end $$;

-- From the first day of the month before last.
update public.billing_settings set ai_billing_starts_on = (select two_ago from _m) where singleton;

-- == (b) The period invoice carries the completed months, after the discount ===
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
  if inv.ai_usage_from is distinct from (select two_ago from _m) or inv.ai_usage_to is distinct from (select last_month_end from _m) then
    raise exception 'AI INVOICE FAIL [b]: AI months % to %, expected the two completed months',
      inv.ai_usage_from, inv.ai_usage_to;
  end if;

  -- Stamped: exactly the three billable rows.
  if exists (select 1 from public.ai_usage u join _rows r on r.id = u.id
              where r.tag in ('a_two', 'a_last_voice', 'a_last_ai') and u.invoice_id is distinct from inv.id) then
    raise exception 'AI INVOICE FAIL [b]: a billable row was not stamped with the invoice';
  end if;
  if exists (select 1 from public.ai_usage u join _rows r on r.id = u.id
              where r.tag in ('a_this', 'a_before', 'a_internal') and u.invoice_id is not null) then
    raise exception 'AI INVOICE FAIL [b]: the running month, use before the start, or support use was billed';
  end if;

  -- Who used it, biggest first, frozen with names.
  v_people := inv.ai_usage_people;
  if coalesce(jsonb_array_length(v_people), 0) <> 2
     or v_people->0->>'name' is distinct from 'Ben Manager' or (v_people->0->>'billed_cents')::numeric is distinct from 2500.25
     or (v_people->0->>'ai_requests')::integer is distinct from 1
     or v_people->1->>'name' is distinct from 'Anna Owner' or (v_people->1->>'billed_cents')::numeric is distinct from 2234.5679
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
    update public.ai_usage set invoice_id = v_other where id = (select id from _rows where tag = 'a_last_ai');
    raise exception 'AI INVOICE FAIL [c]: a stamped row was moved to another invoice';
  exception when insufficient_privilege then null; end;
end $$;

-- == (g) A VAT-registered seller adds VAT to the AI use at the invoice's rate =======
-- The plan's price is VAT-inclusive (VAT is derived FROM it); the ledger is ex VAT, which
-- is what the owner's page says, so VAT is added TO the AI use. The catalogue price this
-- suite reads carries no rate, so the invoice is written at 15% by hand, as the billing
-- suite's own VAT case does. Before the AI-only run, because the cron raises period
-- invoices first: a farm renewing today is never billed on its own.
update public.billing_settings set vat_registered = true, vat_number = '4123456789' where singleton;
do $$
declare inv public.billing_invoices%rowtype; v_inv uuid := gen_random_uuid(); v_plan bigint;
begin
  select unit * 2 into v_plan from _p;
  insert into public.billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values (v_inv, 'e1000000-0000-4000-9000-000000000007', 'e1600000-0000-4000-9000-000000000007',
    'E1-INV-VAT', 'draft', current_date, current_date + 29, current_date, current_date,
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

-- == (d) AI-only invoices: who gets one, and only once ===========================
do $$
declare n integer; inv public.billing_invoices%rowtype; v_testable boolean;
begin
  n := app.generate_ai_usage_invoices();

  -- The annual farm, over the minimum.
  select * into inv from public.billing_invoices where farm_id = 'e1000000-0000-4000-9000-00000000000b';
  if not found then
    raise exception 'AI INVOICE FAIL [d]: the annual farm got no AI-only invoice';
  end if;
  if inv.kind is distinct from 'ai_usage' or inv.status is distinct from 'open' or inv.asset_count <> 0 or inv.unit_price_incl_cents <> 0
     or inv.total_incl_cents <> 6000 or inv.subscription_id is distinct from 'e1600000-0000-4000-9000-00000000000b'
     or inv.period_start is distinct from (select last_month from _m) or inv.period_end is distinct from (select last_month_end from _m) then
    raise exception 'AI INVOICE FAIL [d]: the AI-only invoice is wrong: kind %, status %, % vehicles, total %, % to %',
      inv.kind, inv.status, inv.asset_count, inv.total_incl_cents, inv.period_start, inv.period_end;
  end if;

  -- Never a trial, and nothing under the minimum.
  if exists (select 1 from public.billing_invoices
              where farm_id in ('e1000000-0000-4000-9000-00000000000d', 'e1000000-0000-4000-9000-00000000000e')) then
    raise exception 'AI INVOICE FAIL [d]: a trial farm, or a farm under the minimum, was invoiced';
  end if;

  -- The farm whose renewal is coming later this month waits for it. Untestable on the last
  -- day of a month, when no later day exists.
  select month_end > today into v_testable from _m;
  if v_testable and exists (select 1 from public.billing_invoices where farm_id = 'e1000000-0000-4000-9000-00000000000c') then
    raise exception 'AI INVOICE FAIL [d]: a farm renewing later this month got an AI-only invoice';
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
                             (select two_ago from _m), 'ai_answer', 2500);
  perform app.generate_ai_usage_invoices();
  select * into inv from public.billing_invoices where farm_id = 'e1000000-0000-4000-9000-00000000000e';
  if not found or inv.total_incl_cents <> 5500
     or inv.period_start is distinct from (select two_ago from _m) or inv.period_end is distinct from (select last_month_end from _m)
     or inv.ai_usage_from is distinct from (select two_ago from _m) then
    raise exception 'AI INVOICE FAIL [e]: use carried forward was not billed when it reached the minimum (%, % to %)',
      inv.total_incl_cents, inv.period_start, inv.period_end;
  end if;
end $$;

-- == (f) A late row for months already billed on their own waits ====================
do $$
declare v_before bigint;
begin
  perform public._ai_inv_use('e1000000-0000-4000-9000-00000000000b', 'e1a00000-0000-4000-9000-000000000003',
                             (select last_month from _m), 'ai_answer', 9000);
  v_before := (select last_value from public.billing_invoice_ref_seq);
  if app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [f]: the same months were invoiced twice';
  end if;
  if (select last_value from public.billing_invoice_ref_seq) <> v_before then
    raise exception 'AI INVOICE FAIL [f]: an invoice number was taken and thrown away';
  end if;
end $$;

-- == (h) The renewal notice: the discounted plan, plus the AI use ===================
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
update public.billing_settings set ai_billing_starts_on = (select today + 5 from _m) where singleton;
do $$
begin
  if app.ai_billing_from() is not null or app.generate_ai_usage_invoices() <> 0 then
    raise exception 'AI INVOICE FAIL [i]: a start date in the future already bills';
  end if;
end $$;

drop function public._ai_inv_use(uuid, uuid, date, text, numeric, text, integer);

rollback;
