\set ON_ERROR_STOP on
-- Mid-period changes: a priced quote, accepted, paid, and only then the change
-- (20261115110000). BRIEF section 23: scenarios 6 (additions halfway through a monthly and an
-- annual period; filling a paid space costs nothing), 7 (Professional to Complete with five
-- full and fifteen equipment: R545 to R495, a credit and no charge), 8 (Complete to
-- Professional for that mix: at renewal, R495 to R545, previewed) and 10 (expired quote,
-- changed basis, repeated acceptance, two changes at once, a declined card, a payment that
-- arrives after the window closed, an out-of-order settle; no duplicate invoice, credit or
-- change). The quote functions are called directly with today's South African date.
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

-- Pays a change invoice the way a card payment does: claim, then settle as succeeded.
create or replace function pg_temp.pay(p_invoice uuid, p_ref text) returns uuid language plpgsql as $$
declare v_attempt uuid; v_owed bigint;
begin
  select total_incl_cents - amount_paid_cents into v_owed from public.billing_invoices where id = p_invoice;
  v_attempt := app.claim_billing_charge(p_invoice, p_ref, 'manual_retry', v_owed);
  perform app.settle_billing_attempt(v_attempt, 'succeeded', (floor(random() * 1e9))::bigint, p_ref, 'Approved', null, v_owed, 'card', true);
  return v_attempt;
end $$;

-- == Fixtures ===============================================================================
-- Every subscription is half way through a 30-day monthly period (15 days left, today
-- included), or through a 365-day year (183 days left).
insert into public.farms (id, name, plan, status, billing_period) values
  ('ac200000-0000-4000-9000-000000000001', 'Quote yard',       'complete',     'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000002', 'Pro to Complete',  'professional', 'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000003', 'Complete to Pro',  'complete',     'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000004', 'Annual yard',      'essential',    'active', 'annual'),
  ('ac200000-0000-4000-9000-000000000005', 'Late payer',       'essential',    'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000006', 'Main depot',       'essential',    'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000007', 'North depot',      'essential',    'active', 'monthly'),
  ('ac200000-0000-4000-9000-000000000008', 'Large fleet',      'essential',    'active', 'monthly');
update public.farms set billed_through = 'ac200000-0000-4000-9000-000000000006'
 where id = 'ac200000-0000-4000-9000-000000000007';

insert into auth.users (id, email) values
  ('ac210000-0000-4000-9000-000000000001', 'owner1@quotes.test'),
  ('ac210000-0000-4000-9000-000000000002', 'owner2@quotes.test'),
  ('ac210000-0000-4000-9000-000000000003', 'owner3@quotes.test'),
  ('ac210000-0000-4000-9000-000000000004', 'owner4@quotes.test'),
  ('ac210000-0000-4000-9000-000000000005', 'owner5@quotes.test'),
  ('ac210000-0000-4000-9000-000000000006', 'owner6@quotes.test'),
  ('ac210000-0000-4000-9000-000000000008', 'owner8@quotes.test'),
  ('ac210000-0000-4000-9000-0000000000a1', 'manager1@quotes.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('ac210000-0000-4000-9000-000000000001', 'ac200000-0000-4000-9000-000000000001', null, 'owner', 'Owner 1', 'owner1@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000002', 'ac200000-0000-4000-9000-000000000002', null, 'owner', 'Owner 2', 'owner2@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000003', 'ac200000-0000-4000-9000-000000000003', null, 'owner', 'Owner 3', 'owner3@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000004', 'ac200000-0000-4000-9000-000000000004', null, 'owner', 'Owner 4', 'owner4@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000005', 'ac200000-0000-4000-9000-000000000005', null, 'owner', 'Owner 5', 'owner5@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000006', 'ac200000-0000-4000-9000-000000000006', null, 'owner', 'Owner 6', 'owner6@quotes.test', true),
  ('ac210000-0000-4000-9000-000000000008', 'ac200000-0000-4000-9000-000000000008', null, 'owner', 'Owner 8', 'owner8@quotes.test', true),
  ('ac210000-0000-4000-9000-0000000000a1', 'ac200000-0000-4000-9000-000000000001', null, 'manager', 'Manager 1', 'manager1@quotes.test', true);

do $fx$
declare v_today date := app.billing_today();
begin
  insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
    current_period_start, current_period_end, next_billing_on, anchor_day) values
    ('ac260000-0000-4000-9000-000000000001', 'ac200000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('ac260000-0000-4000-9000-000000000002', 'ac200000-0000-4000-9000-000000000002', 'professional', 'monthly', 'active', 5, 10,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('ac260000-0000-4000-9000-000000000003', 'ac200000-0000-4000-9000-000000000003', 'complete', 'monthly', 'active', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('ac260000-0000-4000-9000-000000000004', 'ac200000-0000-4000-9000-000000000004', 'essential', 'annual', 'active', 8, 0,
     v_today - 182, v_today + 182, v_today + 183, extract(day from v_today - 182)::int),
    ('ac260000-0000-4000-9000-000000000005', 'ac200000-0000-4000-9000-000000000005', 'essential', 'monthly', 'active', 6, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('ac260000-0000-4000-9000-000000000006', 'ac200000-0000-4000-9000-000000000006', 'essential', 'monthly', 'active', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('ac260000-0000-4000-9000-000000000008', 'ac200000-0000-4000-9000-000000000008', 'essential', 'monthly', 'active', 200, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int);
end $fx$;

-- A stored card on the first, so the nightly run's shortlist could reach its invoices.
insert into public.billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('ac270000-0000-4000-9000-000000000001', 'ac200000-0000-4000-9000-000000000001',
   'AUTH_' || 'quotesynthetic', 'owner1@quotes.test', 'visa', '4242', '12', '2030', true, true, 'active');
update public.billing_subscriptions set default_payment_method_id = 'ac270000-0000-4000-9000-000000000001'
 where id = 'ac260000-0000-4000-9000-000000000001';

-- Five full assets and fifteen pieces of equipment on each of the first three.
insert into public.machines (farm_id, name, type)
select f, 'Truck ' || g, 'truck'
  from unnest(array['ac200000-0000-4000-9000-000000000001', 'ac200000-0000-4000-9000-000000000002',
                    'ac200000-0000-4000-9000-000000000003']::uuid[]) f, generate_series(1, 5) g;
insert into public.machines (farm_id, name, type, profile)
select f, 'Pump ' || g, 'pump_generator', 'equipment'
  from unnest(array['ac200000-0000-4000-9000-000000000001', 'ac200000-0000-4000-9000-000000000002',
                    'ac200000-0000-4000-9000-000000000003']::uuid[]) f, generate_series(1, 15) g;
insert into public.machines (farm_id, name, type)
select 'ac200000-0000-4000-9000-000000000004', 'Bakkie ' || g, 'truck' from generate_series(1, 3) g;
insert into public.machines (farm_id, name, type)
select 'ac200000-0000-4000-9000-000000000005', 'Tractor ' || g, 'truck' from generate_series(1, 2) g;

-- == Scenario 6: additions halfway through a period ============================================
do $t$
declare
  v jsonb;
  v_today date := app.billing_today();
begin
  -- Half a monthly R15 equipment space is R7.50; half a R99 full space is R49.50.
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000001', null, null, 5, 1, false, v_today);
  if v ->> 'kind' is distinct from 'now' or (v #>> '{money,charge_now_cents}')::bigint <> 750
     or (v #>> '{period,days_remaining}')::int <> 15 or (v #>> '{period,days_in_period}')::int <> 30 then
    raise exception 'QUOTES FAIL [6]: one equipment space for half a month is not R7.50: %', v;
  end if;
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000001', null, null, 6, 0, false, v_today);
  if (v #>> '{money,charge_now_cents}')::bigint <> 4950 then
    raise exception 'QUOTES FAIL [6]: one full space for half a month is not R49.50: %', v #> '{money}';
  end if;
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000001', null, null, 6, 1, false, v_today);
  if (v #>> '{money,charge_now_cents}')::bigint <> 5700 then
    raise exception 'QUOTES FAIL [6]: a space of each is not the sum: %', v #> '{money}';
  end if;
  -- Next renewal with the new spaces in use: 6 x R99 + (16 - 15) x R15.
  if (v #>> '{money,next_renewal_cents}')::bigint <> 6 * 9900 + 1500
     or (v #>> '{money,current_renewal_cents}')::bigint <> 49500 then
    raise exception 'QUOTES FAIL [6]: the renewal before and after is wrong: %', v #> '{money}';
  end if;
  -- The renewal date is the period's, whatever is added.
  if (v #>> '{period,renewal_on}')::date <> v_today + 15 then
    raise exception 'QUOTES FAIL [6]: the renewal date moved: %', v #> '{period}';
  end if;

  -- Annual: the stated R490 a year, for 183 of 365 days, rounded once per space.
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000004', null, null, 9, 0, false, v_today);
  if v ->> 'kind' is distinct from 'now' or (v #>> '{money,charge_now_cents}')::bigint <> round(49000::numeric * 183 / 365)
     or (v #>> '{period,days_in_period}')::int <> 365 then
    raise exception 'QUOTES FAIL [6]: an annual full space for half a year is wrong: %', v;
  end if;
end $t$;

-- Filling a space already paid for costs nothing: no quote, no invoice.
do $t$
declare v_before integer; v_after integer;
begin
  select count(*) into v_before from public.billing_invoices where farm_id = 'ac200000-0000-4000-9000-000000000004';
  insert into public.machines (farm_id, name, type)
  select 'ac200000-0000-4000-9000-000000000004', 'Filled ' || g, 'truck' from generate_series(1, 2) g;
  select count(*) into v_after from public.billing_invoices where farm_id = 'ac200000-0000-4000-9000-000000000004';
  if v_after <> v_before or exists (select 1 from public.billing_change_quotes
                                     where subscription_id = 'ac260000-0000-4000-9000-000000000004') then
    raise exception 'QUOTES FAIL [6]: filling a paid space raised an invoice or a quote';
  end if;
end $t$;

-- Accepted, then paid, and only then the space: the renewal date never moves.
do $t$
declare
  v jsonb;
  r jsonb;
  q public.billing_change_quotes%rowtype;
  i public.billing_invoices%rowtype;
  s public.billing_subscriptions%rowtype;
  s2 public.billing_subscriptions%rowtype;
  v_msg text;
begin
  select * into s from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000001';
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 5, 1, false,
                                'ac210000-0000-4000-9000-000000000001');
  select * into q from public.billing_change_quotes where id = (v ->> 'quote_id')::uuid;
  if q.status <> 'quoted' or q.charge_now_cents <> 750 or q.expires_at > now() + interval '30 minutes'
     or q.expires_at > app.billing_day_ends_at(app.billing_today()) then
    raise exception 'QUOTES FAIL [6]: the quote was not kept as priced: %', to_jsonb(q);
  end if;

  r := app.billing_accept_quote(q.id, 'ac210000-0000-4000-9000-000000000001', 750, 0, q.next_renewal_cents);
  if r ->> 'applied' is distinct from 'awaiting_payment' then
    raise exception 'QUOTES FAIL [6]: a paid addition did not wait for its payment: %', r;
  end if;
  select * into i from public.billing_invoices where id = (r ->> 'invoice_id')::uuid;
  if i.kind <> 'change' or i.status <> 'open' or i.total_incl_cents <> 750 then
    raise exception 'QUOTES FAIL [6]: the change invoice is not the accepted charge: %', to_jsonb(i);
  end if;
  -- Not yet paid: no extra capacity.
  if (select equipment_extra_quota from public.billing_subscriptions where id = s.id) <> 0 then
    raise exception 'QUOTES FAIL [6]: capacity rose before payment';
  end if;
  v_msg := pg_temp.try($s$insert into public.machines (farm_id, name, type, profile)
                         values ('ac200000-0000-4000-9000-000000000001', 'Sixteenth pump', 'pump_generator', 'equipment')$s$);
  if v_msg <> 'equipment-limit-reached' then
    raise exception 'QUOTES FAIL [6]: equipment was added on an unpaid change: %', v_msg;
  end if;
  -- Never charged by the nightly card run, never a reason to pause.
  if exists (select 1 from app.due_billing_charges(500) d where d.invoice_id = i.id) then
    raise exception 'QUOTES FAIL [6]: the nightly run would charge a change invoice';
  end if;
  if app.farm_overdue_since('ac200000-0000-4000-9000-000000000001') is not null then
    raise exception 'QUOTES FAIL [6]: an unpaid change invoice counts towards a pause';
  end if;

  perform pg_temp.pay(i.id, 'FWB-TEST-Q6-1');
  select * into s2 from public.billing_subscriptions where id = s.id;
  if s2.equipment_extra_quota <> 1 or (select status from public.billing_change_quotes where id = q.id) <> 'applied' then
    raise exception 'QUOTES FAIL [6]: paying did not make the change (extra %)', s2.equipment_extra_quota;
  end if;
  if s2.current_period_end <> s.current_period_end or s2.next_billing_on <> s.next_billing_on
     or s2.anchor_day <> s.anchor_day then
    raise exception 'QUOTES FAIL [6]: buying a space moved the renewal date';
  end if;
  insert into public.machines (farm_id, name, type, profile)
  values ('ac200000-0000-4000-9000-000000000001', 'Sixteenth pump', 'pump_generator', 'equipment');
end $t$;
-- == Scenario 7: Professional to Complete, five full and fifteen equipment ======================
-- R545 a month becomes R495: an upgrade made at once, the unused difference for the 15 days
-- left credited (R50 x 15/30 = R25), nothing charged, then spent on what comes next.
do $t$
declare
  v jsonb;
  r jsonb;
  s public.billing_subscriptions%rowtype;
begin
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000002', 'complete', 'monthly', null, null, false,
                                'ac210000-0000-4000-9000-000000000002');
  if v ->> 'kind' is distinct from 'now' or (v #>> '{money,charge_now_cents}')::bigint <> 0
     or (v #>> '{money,credit_now_cents}')::bigint <> 2500
     or (v #>> '{money,current_renewal_cents}')::bigint <> 54500
     or (v #>> '{money,next_renewal_cents}')::bigint <> 49500
     or (v #>> '{to,equipment_extra}')::int <> 0 or (v #>> '{from,equipment_capacity}')::int <> 15 then
    raise exception 'QUOTES FAIL [7]: Professional to Complete is not a R25 credit, R545 to R495: %', v;
  end if;
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000002', 0, 2500, 49500);
  if r ->> 'applied' is distinct from 'now' then
    raise exception 'QUOTES FAIL [7]: the upgrade was not made at once: %', r;
  end if;
  select * into s from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000002';
  if s.plan <> 'complete' or s.equipment_extra_quota <> 0
     or (select plan from public.farms where id = 'ac200000-0000-4000-9000-000000000002') <> 'complete' then
    raise exception 'QUOTES FAIL [7]: the plans did not move together (sub %, extra %)', s.plan, s.equipment_extra_quota;
  end if;
  if app.billing_credit_balance(s.id) <> 2500 then
    raise exception 'QUOTES FAIL [7]: the credit is %, expected R25', app.billing_credit_balance(s.id);
  end if;
  -- Never a negative payment, never an invoice for a lower total.
  if exists (select 1 from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
              where i.farm_id = s.farm_id and p.amount_incl_cents < 0)
     or exists (select 1 from public.billing_invoices i where i.farm_id = s.farm_id) then
    raise exception 'QUOTES FAIL [7]: a credit was written as an invoice or a negative payment';
  end if;
  -- The same acceptance again gives no second credit.
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000002', 0, 2500, 49500);
  if not coalesce((r ->> 'repeat')::boolean, false) or app.billing_credit_balance(s.id) <> 2500 then
    raise exception 'QUOTES FAIL [7]: a repeated acceptance credited twice (%), %', app.billing_credit_balance(s.id), r;
  end if;
end $t$;

-- Credit pays first: a space worth R7.50 is paid entirely from the R25, at once, with no card.
do $t$
declare v jsonb; r jsonb;
begin
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000002', null, null, 5, 1, false,
                                'ac210000-0000-4000-9000-000000000002');
  if (v #>> '{money,pay_now_cents}')::bigint <> 0 or (v #>> '{money,charge_now_cents}')::bigint <> 750 then
    raise exception 'QUOTES FAIL [7]: the credit was not counted in what is paid now: %', v #> '{money}';
  end if;
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000002', 750, 0,
                                (v #>> '{money,next_renewal_cents}')::bigint);
  if r ->> 'applied' is distinct from 'now' or (r ->> 'outstanding_cents')::bigint <> 0 then
    raise exception 'QUOTES FAIL [7]: a change covered by credit waited for a card: %', r;
  end if;
  if (select equipment_extra_quota from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000002') <> 1
     or app.billing_credit_balance('ac260000-0000-4000-9000-000000000002') <> 1750 then
    raise exception 'QUOTES FAIL [7]: paying from credit did not make the change or spend R7.50 of it';
  end if;
end $t$;

-- The rest is spent on the next period invoice as it is issued.
do $t$
declare i public.billing_invoices%rowtype;
begin
  update public.billing_subscriptions
     set current_period_start = current_date - 31, current_period_end = current_date - 2, next_billing_on = current_date - 1
   where id = 'ac260000-0000-4000-9000-000000000002';
  perform app.generate_billing_invoices('ac260000-0000-4000-9000-000000000002');
  select * into i from public.billing_invoices
   where subscription_id = 'ac260000-0000-4000-9000-000000000002' and kind = 'period';
  if not found or i.amount_paid_cents <> 1750 or i.status <> 'open'
     or app.billing_credit_balance('ac260000-0000-4000-9000-000000000002') <> 0 then
    raise exception 'QUOTES FAIL [7]: the credit was not spent on the next invoice (paid %, balance %)',
      i.amount_paid_cents, app.billing_credit_balance('ac260000-0000-4000-9000-000000000002');
  end if;
  if not exists (select 1 from public.billing_payments p where p.invoice_id = i.id and p.provider = 'credit' and p.amount_incl_cents = 1750) then
    raise exception 'QUOTES FAIL [7]: the credit is not a credit payment on the invoice';
  end if;
end $t$;

-- == Scenario 8: Complete to Professional for that mix ===========================================
-- A lower plan that costs more: R495 becomes R545, at the renewal, previewed; edited, cancelled,
-- and finally landed by the renewal step with the quote marked applied.
do $t$
declare
  v jsonb;
  r jsonb;
  v_first uuid;
  s public.billing_subscriptions%rowtype;
begin
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000003', 'professional', 'monthly', null, null, false,
                                'ac210000-0000-4000-9000-000000000003');
  if v ->> 'kind' is distinct from 'renewal' or (v #>> '{money,current_renewal_cents}')::bigint <> 49500
     or (v #>> '{money,next_renewal_cents}')::bigint <> 54500
     or (v #>> '{money,charge_now_cents}')::bigint <> 0 or (v #>> '{money,credit_now_cents}')::bigint <> 0
     or (v ->> 'effective_on')::date <> app.billing_today() + 15 then
    raise exception 'QUOTES FAIL [8]: Complete to Professional is not R495 to R545 at renewal: %', v;
  end if;
  v_first := (v ->> 'quote_id')::uuid;
  r := app.billing_accept_quote(v_first, 'ac210000-0000-4000-9000-000000000003', 0, 0, 54500);
  select * into s from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000003';
  if r ->> 'applied' is distinct from 'scheduled' or s.plan <> 'complete' or s.pending_plan <> 'professional'
     or s.pending_plan_on <> app.billing_today() + 15 then
    raise exception 'QUOTES FAIL [8]: the downgrade was not scheduled for the renewal: %, pending %', r, s.pending_plan;
  end if;

  -- Edited: a newer change replaces the waiting one.
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000003', 'essential', 'monthly', null, null, false,
                                'ac210000-0000-4000-9000-000000000003');
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000003', 0, 0,
                                (v #>> '{money,next_renewal_cents}')::bigint);
  if (select status from public.billing_change_quotes where id = v_first) <> 'superseded'
     or (select pending_plan from public.billing_subscriptions where id = s.id) <> 'essential' then
    raise exception 'QUOTES FAIL [8]: editing a pending change left two waiting';
  end if;
  -- Cancelled: nothing waits.
  r := app.billing_cancel_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000003');
  if (select pending_plan from public.billing_subscriptions where id = s.id) is not null then
    raise exception 'QUOTES FAIL [8]: cancelling a pending change left it pending';
  end if;

  -- Landed on the renewal: the plan moves and the quote says when.
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000003', 'professional', 'monthly', null, null, false,
                                'ac210000-0000-4000-9000-000000000003');
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000003', 0, 0, 54500);
  update public.billing_subscriptions set pending_plan_on = current_date where id = s.id;
  perform app.apply_pending_plan_changes();
  if (select plan from public.billing_subscriptions where id = s.id) <> 'professional'
     or (select plan from public.farms where id = s.farm_id) <> 'professional'
     or (select status from public.billing_change_quotes where id = (v ->> 'quote_id')::uuid) <> 'applied' then
    raise exception 'QUOTES FAIL [8]: the scheduled change did not land at renewal';
  end if;
end $t$;

-- Fewer full spaces wait for the renewal, never below the minimum or the fleet in use.
do $t$
declare v jsonb; r jsonb;
begin
  -- Annual yard: 8 bought, 5 in use (3 plus the 2 filled above).
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000004', null, null, 6, 0, false,
                                'ac210000-0000-4000-9000-000000000004');
  if v ->> 'kind' is distinct from 'renewal' or (v #>> '{money,next_renewal_cents}')::bigint <> 6 * 49000 then
    raise exception 'QUOTES FAIL [8]: a reduction is not at renewal for six spaces: %', v;
  end if;
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000004', 0, 0, 6 * 49000);
  if (select pending_quota from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000004') <> 6
     or (select asset_quota from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000004') <> 8 then
    raise exception 'QUOTES FAIL [8]: the reduction was not scheduled, or it took effect now';
  end if;
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000004', null, null, 4, 0, false, app.billing_today());
  if v ->> 'reason' is distinct from 'billing-slots-minimum' then
    raise exception 'QUOTES FAIL [8]: four spaces were allowed under the minimum of five: %', v ->> 'reason';
  end if;
  insert into public.machines (farm_id, name, type) values ('ac200000-0000-4000-9000-000000000004', 'Sixth bakkie', 'truck');
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000004', null, null, 5, 0, false, app.billing_today());
  if v ->> 'reason' is distinct from 'billing-quota-below-fleet' then
    raise exception 'QUOTES FAIL [8]: a reduction below the six in use was allowed: %', v ->> 'reason';
  end if;
end $t$;
-- == Scenario 10: stale, expired, repeated, concurrent, declined and late ========================
do $t$
declare
  v jsonb;
  v2 jsonb;
  r jsonb;
  v_msg text;
  v_quote uuid;
  v_invoice uuid;
  v_attempt uuid;
  v_n integer;
begin
  -- An expired price is never accepted, and the cron closes it.
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 6, 1, false,
                                'ac210000-0000-4000-9000-000000000001');
  v_quote := (v ->> 'quote_id')::uuid;
  update public.billing_change_quotes set expires_at = now() - interval '1 second' where id = v_quote;
  v_msg := pg_temp.try(format('select app.billing_accept_quote(%L, %L, %s, 0, %s)', v_quote,
             'ac210000-0000-4000-9000-000000000001', v #>> '{money,charge_now_cents}', v #>> '{money,next_renewal_cents}'));
  if v_msg <> 'quote-expired' then raise exception 'QUOTES FAIL [10]: an expired quote was accepted: %', v_msg; end if;
  perform app.billing_expire_quotes();
  if (select status from public.billing_change_quotes where id = v_quote) <> 'expired' then
    raise exception 'QUOTES FAIL [10]: the expiry run left an old quote open';
  end if;

  -- The amounts accepted must be the ones quoted.
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 6, 1, false,
                                'ac210000-0000-4000-9000-000000000001');
  v_msg := pg_temp.try(format('select app.billing_accept_quote(%L, %L, %s, 0, %s)', v ->> 'quote_id',
             'ac210000-0000-4000-9000-000000000001', 1, v #>> '{money,next_renewal_cents}'));
  if v_msg <> 'quote-changed' then raise exception 'QUOTES FAIL [10]: a different amount was accepted: %', v_msg; end if;

  -- The basis moved after the price (another admin changed the spaces): revalidated, refused.
  update public.billing_subscriptions set asset_quota = 7 where id = 'ac260000-0000-4000-9000-000000000001';
  v_msg := pg_temp.try(format('select app.billing_accept_quote(%L, %L, %s, 0, %s)', v ->> 'quote_id',
             'ac210000-0000-4000-9000-000000000001', v #>> '{money,charge_now_cents}', v #>> '{money,next_renewal_cents}'));
  update public.billing_subscriptions set asset_quota = 5 where id = 'ac260000-0000-4000-9000-000000000001';
  if v_msg <> 'quote-changed' then raise exception 'QUOTES FAIL [10]: a stale quote was accepted: %', v_msg; end if;

  -- The basis moved without changing the price: one more equipment space bought meanwhile.
  -- Accepting would have written the old extra back over it.
  v2 := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 6, null, false,
                                 'ac210000-0000-4000-9000-000000000001');
  update public.billing_subscriptions set equipment_extra_quota = equipment_extra_quota + 1
   where id = 'ac260000-0000-4000-9000-000000000001';
  v_msg := pg_temp.try(format('select app.billing_accept_quote(%L, %L, %s, 0, %s)', v2 ->> 'quote_id',
             'ac210000-0000-4000-9000-000000000001', v2 #>> '{money,charge_now_cents}', v2 #>> '{money,next_renewal_cents}'));
  update public.billing_subscriptions set equipment_extra_quota = equipment_extra_quota - 1
   where id = 'ac260000-0000-4000-9000-000000000001';
  if v_msg <> 'quote-changed' then
    raise exception 'QUOTES FAIL [10]: a quote was accepted on a basis that had moved: %', v_msg;
  end if;

  -- Only one price is live: quoting again supersedes the open one.
  v2 := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 6, 1, false,
                                 'ac210000-0000-4000-9000-000000000001');
  if (select status from public.billing_change_quotes where id = (v ->> 'quote_id')::uuid) <> 'superseded' then
    raise exception 'QUOTES FAIL [10]: two prices were live at once';
  end if;

  -- Accepted twice (a double press, two tabs): one invoice.
  r := app.billing_accept_quote((v2 ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000001', 4950, 0,
                                (v2 #>> '{money,next_renewal_cents}')::bigint);
  r := app.billing_accept_quote((v2 ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000001', 4950, 0,
                                (v2 #>> '{money,next_renewal_cents}')::bigint);
  select count(*) into v_n from public.billing_invoices i
   where i.subscription_id = 'ac260000-0000-4000-9000-000000000001' and i.kind = 'change' and i.status = 'open';
  if v_n <> 1 or not coalesce((r ->> 'repeat')::boolean, false) then
    raise exception 'QUOTES FAIL [10]: a repeated acceptance raised % open change invoices', v_n;
  end if;
  v_invoice := (r ->> 'invoice_id')::uuid;

  -- A second change cannot be accepted while one waits for its payment.
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 5, 2, false,
                                'ac210000-0000-4000-9000-000000000001');
  v_msg := pg_temp.try(format('select app.billing_accept_quote(%L, %L, %s, 0, %s)', v ->> 'quote_id',
             'ac210000-0000-4000-9000-000000000001', v #>> '{money,charge_now_cents}', v #>> '{money,next_renewal_cents}'));
  if v_msg <> 'quote-awaiting-payment' then
    raise exception 'QUOTES FAIL [10]: two changes waited for payment at once: %', v_msg;
  end if;

  -- A declined card on a change: the extra is not bought, and the subscription is not dunned.
  v_attempt := app.claim_billing_charge(v_invoice, 'FWB-TEST-Q10-DECLINE', 'manual_retry', 4950);
  perform app.settle_billing_attempt(v_attempt, 'failed', null, null, 'Declined', 'Declined', null, null, true);
  if (select status from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000001') <> 'active'
     or (select failed_attempt_count from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000001') <> 0
     or (select asset_quota from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000001') <> 5 then
    raise exception 'QUOTES FAIL [10]: a declined extra walked the subscription into dunning or bought the space';
  end if;

  -- Not paid in time: voided, never charged later.
  v_attempt := app.claim_billing_charge(v_invoice, 'FWB-TEST-Q10-LATE', 'manual_retry', 4950);
  update public.billing_change_quotes set payment_due_by = now() - interval '1 second'
   where invoice_id = v_invoice;
  perform app.billing_expire_quotes();
  if (select status from public.billing_invoices where id = v_invoice) <> 'open' then
    raise exception 'QUOTES FAIL [10]: an invoice with a payment in flight was voided';
  end if;
  perform app.settle_billing_attempt(v_attempt, 'failed', null, null, 'Timeout', 'Timeout', null, null, true);
  perform app.billing_expire_quotes();
  if (select status from public.billing_invoices where id = v_invoice) <> 'void'
     or (select status from public.billing_change_quotes where invoice_id = v_invoice) <> 'expired' then
    raise exception 'QUOTES FAIL [10]: an unpaid change was not closed at the end of its window';
  end if;

  -- The bank's answer arrives after all (a delayed success): the money is credit, not a space.
  perform app.settle_billing_attempt(v_attempt, 'succeeded', 77001, 'FWB-TEST-Q10-LATE', 'Approved', null, 4950, 'card', true);
  if app.billing_credit_balance('ac260000-0000-4000-9000-000000000001') <> 4950
     or (select asset_quota from public.billing_subscriptions where id = 'ac260000-0000-4000-9000-000000000001') <> 5 then
    raise exception 'QUOTES FAIL [10]: a payment after the window was lost or bought the space (credit %)',
      app.billing_credit_balance('ac260000-0000-4000-9000-000000000001');
  end if;
  -- Delivered again, and then a late "failed" for the same attempt: nothing moves.
  perform app.settle_billing_attempt(v_attempt, 'succeeded', 77001, 'FWB-TEST-Q10-LATE', 'Approved', null, 4950, 'card', true);
  perform app.settle_billing_attempt(v_attempt, 'failed', null, null, 'late', 'late', null, null, true);
  if app.billing_credit_balance('ac260000-0000-4000-9000-000000000001') <> 4950
     or (select status from public.billing_payment_attempts where id = v_attempt) <> 'succeeded'
     or (select count(*) from public.billing_payments where attempt_id = v_attempt) <> 1 then
    raise exception 'QUOTES FAIL [10]: a duplicate or out-of-order settle credited twice or undid a payment';
  end if;
end $t$;

-- == Who may change, and when ===================================================================
do $t$
declare v_msg text; v jsonb;
begin
  -- A manager sees spaces but never buys them; an owner of another business never reaches this one.
  v_msg := pg_temp.try($s$select app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 7, 0, false,
                          'ac210000-0000-4000-9000-0000000000a1')$s$);
  if v_msg <> 'forbidden' then raise exception 'QUOTES FAIL [who]: a manager priced a change: %', v_msg; end if;
  v_msg := pg_temp.try($s$select app.billing_quote_change('ac260000-0000-4000-9000-000000000001', null, null, 7, 0, false,
                          'ac210000-0000-4000-9000-000000000002')$s$);
  if v_msg <> 'forbidden' then raise exception 'QUOTES FAIL [who]: another business''s owner priced a change: %', v_msg; end if;

  -- Seven days of grace: no new paid extras, while giving back is still allowed (decision 41).
  insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind, period_start, period_end,
    issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values ('ac200000-0000-4000-9000-000000000005', 'ac260000-0000-4000-9000-000000000005', 'FW-TEST-LATE-1', 'draft', 'period',
    app.billing_today() - 20, app.billing_today() + 9, app.billing_today() - 5, app.billing_today() - 3,
    'essential', 'monthly', 6, 4900, 1, 'launch-2026-11-eq', 0);
  update public.billing_invoices set status = 'open' where invoice_ref = 'FW-TEST-LATE-1';
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000005', null, null, 7, 0, false, app.billing_today());
  if v ->> 'reason' is distinct from 'billing-grace-no-extras' then
    raise exception 'QUOTES FAIL [grace]: an extra was sold in the grace: %', v;
  end if;
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000005', null, null, 5, 0, false, app.billing_today());
  if v ->> 'kind' is distinct from 'renewal' then
    raise exception 'QUOTES FAIL [grace]: giving a space back was refused in the grace: %', v;
  end if;

  -- Above the self-service line: a capacity check and a quote, not an online purchase (decision 39).
  v := app.billing_change_state('ac260000-0000-4000-9000-000000000008', null, null, 201, 0, false, app.billing_today());
  if v ->> 'reason' is distinct from 'billing-capacity-quote' then
    raise exception 'QUOTES FAIL [39]: 201 full spaces were sold online: %', v ->> 'reason';
  end if;
end $t$;

-- == One plan across a customer's sites =========================================================
do $t$
declare v jsonb; r jsonb;
begin
  v := app.billing_quote_change('ac260000-0000-4000-9000-000000000006', 'professional', 'monthly', null, null, false,
                                'ac210000-0000-4000-9000-000000000006');
  if v ->> 'kind' is distinct from 'now' or (v #>> '{money,charge_now_cents}')::bigint <> round((39500 - 24500)::numeric * 15 / 30) then
    raise exception 'QUOTES FAIL [pool]: Essential to Professional is not the difference for the days left: %', v #> '{money}';
  end if;
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, 'ac210000-0000-4000-9000-000000000006',
                                (v #>> '{money,charge_now_cents}')::bigint, 0, (v #>> '{money,next_renewal_cents}')::bigint);
  if (select plan from public.farms where id = 'ac200000-0000-4000-9000-000000000007') <> 'essential' then
    raise exception 'QUOTES FAIL [pool]: a site took the higher plan before it was paid for';
  end if;
  perform pg_temp.pay((r ->> 'invoice_id')::uuid, 'FWB-TEST-POOL-1');
  if (select plan from public.farms where id = 'ac200000-0000-4000-9000-000000000007') <> 'professional'
     or (select plan from public.farms where id = 'ac200000-0000-4000-9000-000000000006') <> 'professional' then
    raise exception 'QUOTES FAIL [pool]: the sites billed together are on different plans';
  end if;
end $t$;

-- == Nobody's browser reaches the engine ========================================================
do $t$
declare f text;
begin
  foreach f in array array[
    'public.billing_change_preview(uuid, public.farm_plan, public.billing_period, integer, integer, boolean)',
    'public.billing_quote_change(uuid, public.farm_plan, public.billing_period, integer, integer, boolean, uuid)',
    'public.billing_accept_quote(uuid, uuid, bigint, bigint, bigint)',
    'public.billing_cancel_quote(uuid, uuid)',
    'public.billing_credit_balance(uuid)',
    'public.cron_expire_billing_quotes()'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception 'QUOTES FAIL [grants]: % is reachable by a browser or not by the server', f;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.billing_account_credits', 'INSERT')
     or has_table_privilege('authenticated', 'public.billing_change_quotes', 'UPDATE') then
    raise exception 'QUOTES FAIL [grants]: a browser can write quotes or credit';
  end if;
  -- Append-only credit.
  if pg_temp.try($s$update public.billing_account_credits set amount_cents = amount_cents + 1$s$) = 'ok' then
    raise exception 'QUOTES FAIL [grants]: account credit was edited in place';
  end if;
end $t$;

-- == The owner reads their own; a manager and another business read nothing =====================
do $t$
declare v_n integer;
begin
  perform pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', 'ac210000-0000-4000-9000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.billing_account_credits;
  if v_n = 0 then raise exception 'QUOTES FAIL [rls]: the owner cannot read their own credit'; end if;
  select count(*) into v_n from public.billing_change_quotes where farm_id <> 'ac200000-0000-4000-9000-000000000002';
  if v_n <> 0 then raise exception 'QUOTES FAIL [rls]: an owner read another business''s quotes'; end if;
  reset role;
  perform pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', 'ac210000-0000-4000-9000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.billing_change_quotes;
  if v_n <> 0 then raise exception 'QUOTES FAIL [rls]: a manager read the quotes'; end if;
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
end $t$;

rollback;