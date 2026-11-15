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
