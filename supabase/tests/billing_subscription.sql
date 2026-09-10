-- billing_subscription.sql
-- Standalone, transactional isolation suite for FleetWise SaaS subscription billing
-- (migrations 20260903160000 / …160100 / …160200).
--
-- WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- The orchestrator's own smoke test already proves the SHAPE of the ledger: the empty
-- catalogue, one-active-price, the VAT guard both ways, invoice and price immutability,
-- exclusive claim, the payment rollup and refund, the dunning ladder, downgrade, restore,
-- the column privilege, reusable=false, anon and cron lockdown. Repeating any of that
-- here would buy nothing.
--
-- This suite is about the thing the smoke test cannot reach, because it runs entirely as
-- a superuser in one DO block: WHO CAN SEE THE MONEY. Every section below either runs
-- under `set role authenticated` with a real signed-in identity, or interrogates the
-- privilege system directly. The load-bearing case is the contractor: a workshop with an
-- ACTIVE workshop_link has legitimate access to a farm's vehicles, and must not be able
-- to read what that farm pays Rapid Rise for its software.
--
-- THE ZERO-BASELINE TRAP, WHICH THIS PROJECT HAS FALLEN INTO TWICE
-- ─────────────────────────────────────────────────────────────────────────────
-- "Person X sees 0 billing rows" proves nothing if X sees 0 of everything, or if there
-- are 0 rows to see. Every "must see nothing" assertion below is paired with a POSITIVE
-- CONTROL in the same session: the same person, in the same login, reading a non-zero
-- count of something they ARE entitled to. The workshop's control is deliberately the
-- strongest one available — its link carries all four F16 grants, including
-- see_all_vehicles and see_costs — so the result reads "even the widest contractor
-- access stops at the subscription", not "this contractor could not see anything".
--
-- Everything lives in ONE rolled-back transaction on the `b1……` uuid prefix, which is
-- used by no other suite, so this file can run after the larger ones without disturbing
-- their fixtures or leaving its own behind.

\set ON_ERROR_STOP on
\timing off
-- NOT `warning`. The section banners below are raise notice, and a suite whose banners
-- are suppressed is indistinguishable from a suite that did not run — which is the exact
-- failure mode recorded three times in this project's history.
set client_min_messages to notice;

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- rls_isolation.sql commits its `_t_login`, so when run.sh runs this file after it the
-- existing one is used unchanged. Run standalone (or by a runner that applies only the
-- migrations) it does not exist, so create an identical one. Either way it is the house
-- login helper, and the create rolls back with everything else.
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

-- Run a statement and report what the database said about it. SECURITY INVOKER (the
-- default) so the privilege and RLS decisions are made for whoever is logged in.
create or replace function _b1_denied(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ALLOWED';
exception
  when insufficient_privilege then return '42501';
  when others then return sqlstate;
end $$;
grant execute on function _b1_denied(text) to public;

-- How many rows a write actually touched. A write that is filtered out by RLS reports
-- success and zero rows; a write with no grant raises. Both are denials, and they are
-- different denials, so they are measured differently.
create or replace function _b1_rows(p_sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function _b1_rows(text) to public;

reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);


-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures
-- ─────────────────────────────────────────────────────────────────────────────
-- Farm One is the subject: a real subscription, invoice, card, attempt, payment and
-- snapshot, plus the full cast of farm roles and one linked contractor.
-- Farm Two is the neighbour, used for cross-tenant work and for the non-reusable card.
-- Farm Zero has no billable vehicle at all.

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000001', 'Billing Farm One',  'complete',     'active', 'monthly', 'one@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000002', 'Billing Farm Two',  'professional', 'active', 'annual',  'two@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000003', 'Billing Farm Zero', 'complete',     'active', 'monthly', 'zero@billing.invalid');

insert into workshops (id, name, kind) values
  ('b1900000-0000-0000-0000-000000000001', 'Billing Contractor', 'mechanic');

-- The WIDEST link the F16 model allows. If billing leaked through any partner grant,
-- this is the row that would prove it.
insert into workshop_links (workshop_id, farm_id, status,
                            see_all_vehicles, see_service_history, see_costs, see_team)
values ('b1900000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
        'active', true, true, true, true);

insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000001', 'billing.owner1@example.invalid'),
  ('b1a00000-0000-0000-0000-000000000002', 'billing.manager@example.invalid'),
  ('b1a00000-0000-0000-0000-000000000003', 'billing.mechanic@example.invalid'),
  ('b1a00000-0000-0000-0000-000000000004', 'billing.operator@example.invalid'),
  ('b1a00000-0000-0000-0000-000000000005', 'billing.contractor@example.invalid'),
  ('b1a00000-0000-0000-0000-000000000006', 'billing.owner2@example.invalid');

insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('b1a00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', null, 'owner',    'Billing Owner One',  'billing.owner1@example.invalid',     true),
  ('b1a00000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', null, 'manager',  'Billing Manager',    'billing.manager@example.invalid',    true),
  ('b1a00000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', null, 'mechanic', 'Billing Mechanic',   'billing.mechanic@example.invalid',   true),
  ('b1a00000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', null, 'operator', 'Billing Operator',   'billing.operator@example.invalid',   true),
  ('b1a00000-0000-0000-0000-000000000005', null,                                   'b1900000-0000-0000-0000-000000000001', 'workshop', 'Billing Contractor User', 'billing.contractor@example.invalid', true),
  ('b1a00000-0000-0000-0000-000000000006', 'b1000000-0000-0000-0000-000000000002', null, 'owner',    'Billing Owner Two',  'billing.owner2@example.invalid',     true);

-- Farm One: five machines, three billable. `out_of_service` is in the fixture on purpose
-- — the contract says a broken tractor is still a tractor we host, and that is the one
-- part of the billable rule a later reader is most likely to "tidy up".
insert into machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('b1300000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'One Active',   'tractor',   'hours', 'active',         'b1a00000-0000-0000-0000-000000000004'),
  ('b1300000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'One Workshop', 'tractor',   'hours', 'in_workshop',    null),
  ('b1300000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 'One Down',     'bakkie',    'km',    'out_of_service', null),
  ('b1300000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', 'One Retired',  'harvester', 'hours', 'retired',        null),
  ('b1300000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000001', 'One Sold',     'truck',     'km',    'sold',           null),
  ('b1300000-0000-0000-0000-000000000021', 'b1000000-0000-0000-0000-000000000002', 'Two Active A', 'tractor',   'hours', 'active',         null),
  ('b1300000-0000-0000-0000-000000000022', 'b1000000-0000-0000-0000-000000000002', 'Two Active B', 'tractor',   'hours', 'active',         null),
  ('b1300000-0000-0000-0000-000000000031', 'b1000000-0000-0000-0000-000000000003', 'Zero Retired', 'truck',     'km',    'retired',        null);

-- Partner-side rows with a NON-ZERO baseline, so section (k)'s "billing changed nothing
-- on the other ledger" is a real comparison rather than 0 = 0.
insert into cost_entries (id, farm_id, machine_id, type, amount_cents, occurred_on) values
  ('b1c00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   'b1300000-0000-0000-0000-000000000001', 'parts', 45000, current_date);

insert into job_cards (id, farm_id, machine_id, type, status, date_in) values
  ('b1400000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   'b1300000-0000-0000-0000-000000000001', 'repair', 'open', current_date);

insert into partner_expenses (id, workshop_id, supplier_name, amount_cents, expense_date) values
  ('b1e00000-0000-0000-0000-000000000001', 'b1900000-0000-0000-0000-000000000001',
   'Billing Probe Supplier', 90000, current_date);

-- A work request, so the contractor has something of its own to read and the "sees
-- nothing" assertions in section (b) cannot pass because the contractor sees nothing at all.
insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title) values
  ('b1b00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   'b1300000-0000-0000-0000-000000000001', 'b1900000-0000-0000-0000-000000000001',
   'repair', 'requested', 'normal', 'Billing suite fixture request');


-- ═════════════════════════════════════════════════════════════════════════════
-- (0) The confirmed price list is exactly what the founder signed off
-- ═════════════════════════════════════════════════════════════════════════════
-- This section used to assert the catalogue was EMPTY, which was the right property while
-- two sources disagreed about the price. The founder confirmed the founder document on
-- 4 September 2026 and `20260904120000` seeded it, so the property to defend is now
-- stronger: the catalogue holds EXACTLY the confirmed figures, and the display table in
-- `src/lib/entitlements.ts` agrees with it.
--
-- That second half is the one worth having. `PLAN_PRICING` is what a farmer is quoted on
-- screen; `billing_price_versions` is what they are actually invoiced. They have drifted
-- apart once already (R39/R69/R99 against R44/R73/R89), and a quote that does not match
-- the bill is how a customer stops trusting the bill. If somebody edits one without the
-- other, this fails and names both numbers.
do $$
declare
  v_expected constant jsonb := jsonb_build_object(
    'essential', 4400, 'professional', 7300, 'complete', 8900, 'done_for_you', 25000
  );
  k text; v_cents bigint; n integer;
begin
  raise notice '── BILLING (0): the confirmed launch price list ─────────────────';

  for k in select jsonb_object_keys(v_expected) loop
    -- Monthly: the headline figure, charged once per month.
    select per_vehicle_monthly_incl_cents into v_cents
      from billing_price_versions
     where version_label = 'launch-2026' and plan = k::farm_plan
       and billing_period = 'monthly' and status = 'active' and deleted_at is null;
    if v_cents is distinct from (v_expected ->> k)::bigint then
      raise exception 'BILLING FAIL [0]: % monthly is % cents, expected % (founder decision #1, '
        'confirmed 2026-09-04). src/lib/entitlements.ts PLAN_PRICING must carry the same figure.',
        k, coalesce(v_cents::text, 'MISSING'), v_expected ->> k;
    end if;

    -- Annual: the SAME per-vehicle price, charged for ten months. Two months free is
    -- expressed as months_charged, never as a discounted unit price — a discounted unit
    -- price would make "what do we charge per vehicle" have two answers.
    select per_vehicle_monthly_incl_cents, months_charged into v_cents, n
      from billing_price_versions
     where version_label = 'launch-2026' and plan = k::farm_plan
       and billing_period = 'annual' and status = 'active' and deleted_at is null;
    if v_cents is distinct from (v_expected ->> k)::bigint then
      raise exception 'BILLING FAIL [0]: % annual unit price is %, expected % — annual must '
        'carry the same per-vehicle price as monthly', k, coalesce(v_cents::text, 'MISSING'), v_expected ->> k;
    end if;
    if n is distinct from 10 then
      raise exception 'BILLING FAIL [0]: % annual charges % months, expected 10 (two months free)',
        k, coalesce(n::text, 'MISSING');
    end if;
  end loop;

  -- Rapid Rise is not VAT-registered (decision #8), so every seeded row is 0%. If this
  -- ever fails it means somebody registered for VAT by editing the catalogue instead of
  -- retiring a generation, and the frozen-money-columns rule has been worked around.
  select count(*) into n from billing_price_versions
   where version_label = 'launch-2026' and vat_rate_bps <> 0 and deleted_at is null;
  if n <> 0 then
    raise exception 'BILLING FAIL [0]: % launch price row(s) carry a non-zero VAT rate while '
      'Rapid Rise is not registered. Registering means RETIRING this generation and adding a '
      'new one, not editing these.', n;
  end if;

  -- The second lock is still on. Seeding a price releases the first lock only.
  select count(*) into n from billing_invoices;
  if n <> 0 then
    raise exception 'BILLING FAIL [0]: % invoice(s) exist before the suite raises one', n;
  end if;
end $$;

-- The suite's own fixtures now step over the real catalogue. `billing_price_versions_active_uq`
-- allows exactly ONE active row per (plan, period) — which is the point of it — so the
-- launch generation is retired inside this rolled-back transaction before synthetic prices
-- are inserted. Nothing outside this transaction sees it, and section (0) above has already
-- checked the real figures.
update billing_price_versions set status = 'retired' where version_label = 'launch-2026';

-- Two obviously-synthetic prices. 1234 and 4444 cents could not be mistaken for a real
-- FleetWise price by anybody reading a database dump.
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 'complete',     'monthly', 1234, 1,  0, 'active'),
  ('b1500000-0000-0000-0000-000000000002', 'b1-synthetic', 'professional', 'annual',  4444, 10, 0, 'active');

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   'complete', 'monthly', 'active', current_date, current_date + 29, current_date),
  ('b1600000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002',
   'professional', 'annual', 'active', current_date, current_date + 364, current_date),
  ('b1600000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000003',
   'complete', 'monthly', 'active', current_date, current_date + 29, current_date);

-- Farm One's card: reusable, with a credential, exactly as a verified Paystack
-- authorization would arrive. Farm Two's is the one Paystack marked non-reusable, so it
-- carries no code at all (the table's own check constraint refuses that combination).
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   'AUTH_b1synthetic', 'billing.owner1@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_payment_methods (id, farm_id, card_brand, last4, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002',
   'mastercard', '5151', false, true, 'active');

update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000001'
 where id = 'b1600000-0000-0000-0000-000000000001';
update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000002'
 where id = 'b1600000-0000-0000-0000-000000000002';

-- Farm One's issued invoice. Written draft → lines → open, which is the order the freeze
-- trigger requires (see section (f), which measures what the generator does about it).
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('b1800000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
  'b1600000-0000-0000-0000-000000000001', 'B1-INV-0001', 'draft',
  current_date, current_date + 29, current_date, current_date,
  'complete', 'monthly', 3, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('b1800000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 0,
  'FleetWise complete — 3 vehicle(s)', 3, 1, 1234, 3702, 3702, 0);

update billing_invoices set status = 'open' where id = 'b1800000-0000-0000-0000-000000000001';

insert into billing_payment_attempts (id, farm_id, invoice_id, subscription_id,
  payment_method_id, attempt_ref, kind, status, amount_incl_cents)
values ('b1a10000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
  'b1800000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001',
  'b1700000-0000-0000-0000-000000000001', 'B1-REF-SEEDED', 'charge_authorization', 'failed', 3702);

insert into billing_payments (id, farm_id, invoice_id, amount_incl_cents,
  provider, provider_reference, provider_transaction_id, channel)
values ('b1a20000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
  'b1800000-0000-0000-0000-000000000001', 1000, 'paystack', 'B1-PART-PAY', 811000001, 'card');

insert into billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, source)
values ('b1000000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001',
        current_date, 3, 'manual');

insert into billing_webhook_events (provider, dedupe_key, event_type, signature_verified, payload)
values ('paystack', 'charge.success:811000001', 'charge.success', true,
        '{"data":{"id":811000001,"customer":{"email":"billing.owner1@example.invalid"}}}'::jsonb);


-- ═════════════════════════════════════════════════════════════════════════════
-- (a) anon reaches nothing, anywhere
-- ═════════════════════════════════════════════════════════════════════════════
-- Two independent statements of the same property, because they fail differently: the
-- privilege catalogue (what the database would allow) and an actual query as `anon`
-- (what it does allow). Neither on its own is proof.
do $$
declare
  t text;
  p text;
  v_tables text[] := array[
    'billing_settings','billing_price_versions','billing_subscriptions',
    'billing_asset_snapshots','billing_invoices','billing_invoice_lines',
    'billing_payment_methods','billing_payment_attempts','billing_payments',
    'billing_webhook_events'];
begin
  raise notice '── BILLING (a): anon has no reach into billing ──────────────────';
  if array_length(v_tables, 1) <> 10 then
    raise exception 'BILLING FAIL [a]: the billing table list is % long, expected 10',
      array_length(v_tables, 1);
  end if;

  foreach t in array v_tables loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', 'public.' || t, p) then
        raise exception 'BILLING FAIL [a]: anon holds % on %', p, t;
      end if;
    end loop;
    if has_any_column_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'BILLING FAIL [a]: anon holds a COLUMN select on % — a column grant '
        'does not show up in has_table_privilege, which is how this would be missed', t;
    end if;
  end loop;

  -- And nothing in the grant catalogue either, table or column.
  if exists (select 1 from information_schema.role_table_grants
              where grantee = 'anon' and table_schema = 'public' and table_name like 'billing%') then
    raise exception 'BILLING FAIL [a]: anon appears in role_table_grants for a billing table';
  end if;
  if exists (select 1 from information_schema.column_privileges
              where grantee = 'anon' and table_schema = 'public' and table_name like 'billing%') then
    raise exception 'BILLING FAIL [a]: anon appears in column_privileges for a billing table';
  end if;
end $$;

set role anon;
do $$
declare t text; v text;
begin
  foreach t in array array[
    'billing_settings','billing_price_versions','billing_subscriptions',
    'billing_asset_snapshots','billing_invoices','billing_invoice_lines',
    'billing_payment_methods','billing_payment_attempts','billing_payments',
    'billing_webhook_events'] loop
    v := _b1_denied('select count(*) from public.' || quote_ident(t));
    if v <> '42501' then
      raise exception 'BILLING FAIL [a]: anon selecting from % returned %, expected 42501 '
        '(insufficient_privilege)', t, v;
    end if;
  end loop;
end $$;
reset role;


-- ═════════════════════════════════════════════════════════════════════════════
-- (b) Role restrictions — billing is the owner's business and Rapid Rise's
-- ═════════════════════════════════════════════════════════════════════════════
-- The owner reads everything about their own subscription. The manager, the mechanic,
-- the operator and the linked contractor read NONE of it — each of them proved, in the
-- same login, still to be reading the farm's fleet, so the zero is about billing and not
-- about access.
set role authenticated;

do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000001';
  v_sub bigint; v_inv bigint; v_lin bigint; v_pay bigint; v_att bigint;
  v_pm bigint; v_snap bigint; v_mach bigint; v_settings bigint; v_price bigint;
begin
  raise notice '── BILLING (b1): the OWNER sees their own subscription ──────────';
  perform _t_login('b1a00000-0000-0000-0000-000000000001');

  if not app.is_farm_billing_admin(v_farm) then
    raise exception 'BILLING FAIL [b1]: the farm owner is not a billing admin of their own farm';
  end if;

  select count(*) into v_sub  from billing_subscriptions      where farm_id = v_farm;
  select count(*) into v_inv  from billing_invoices           where farm_id = v_farm;
  select count(*) into v_lin  from billing_invoice_lines      where farm_id = v_farm;
  select count(*) into v_pay  from billing_payments           where farm_id = v_farm;
  select count(*) into v_att  from billing_payment_attempts   where farm_id = v_farm;
  select count(*) into v_pm   from billing_payment_methods    where farm_id = v_farm;
  select count(*) into v_snap from billing_asset_snapshots    where farm_id = v_farm;
  if v_sub <> 1 or v_inv <> 1 or v_lin <> 1 or v_pay <> 1 or v_att <> 1 or v_pm <> 1 or v_snap <> 1 then
    raise exception 'BILLING FAIL [b1]: owner sees sub=% inv=% line=% pay=% attempt=% card=% snap=%, '
      'expected 1 of each. Every "must see 0" assertion below depends on this being non-zero.',
      v_sub, v_inv, v_lin, v_pay, v_att, v_pm, v_snap;
  end if;

  -- The seller's own identity and the price list are not farm-scoped: they are what the
  -- customer's own invoice is made of, and every signed-in user may read them.
  select count(*) into v_settings from billing_settings;
  select count(*) into v_price from billing_price_versions where version_label = 'b1-synthetic';
  if v_settings <> 1 or v_price <> 2 then
    raise exception 'BILLING FAIL [b1]: owner sees settings=% prices=%, expected 1 and 2',
      v_settings, v_price;
  end if;

  select count(*) into v_mach from machines where farm_id = v_farm;
  if v_mach <> 5 then
    raise exception 'BILLING FAIL [b1]: owner sees % machines, expected 5', v_mach;
  end if;
end $$;

do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000001';
  r record;
  v_sub bigint; v_inv bigint; v_lin bigint; v_pay bigint; v_att bigint;
  v_pm bigint; v_snap bigint; v_mach bigint;
begin
  raise notice '── BILLING (b2): manager / mechanic / operator / contractor ─────';
  for r in
    select * from (values
      ('b1a00000-0000-0000-0000-000000000002'::uuid, 'manager',    5::bigint),
      ('b1a00000-0000-0000-0000-000000000003'::uuid, 'mechanic',   5::bigint),
      -- F7: an operator sees only the machine assigned to them.
      ('b1a00000-0000-0000-0000-000000000004'::uuid, 'operator',   1::bigint),
      -- F16: this contractor's link carries every grant there is, including
      -- see_all_vehicles, so it reads the whole fleet.
      ('b1a00000-0000-0000-0000-000000000005'::uuid, 'contractor', 5::bigint)
    ) as t(uid, who, machines_expected)
  loop
    perform _t_login(r.uid);

    -- POSITIVE CONTROL FIRST. If this person cannot see the farm's fleet, the zeros
    -- below are meaningless and this suite must say so rather than pass.
    select count(*) into v_mach from machines where farm_id = v_farm;
    if v_mach <> r.machines_expected then
      raise exception 'BILLING FAIL [b2/%]: positive control failed — sees % machines, '
        'expected %. Without it, "sees no billing rows" proves nothing.',
        r.who, v_mach, r.machines_expected;
    end if;

    if app.is_farm_billing_admin(v_farm) then
      raise exception 'BILLING FAIL [b2/%]: app.is_farm_billing_admin said TRUE. Billing is '
        'the owner''s business and Rapid Rise''s — nobody else''s.', r.who;
    end if;

    select count(*) into v_sub  from billing_subscriptions    where farm_id = v_farm;
    select count(*) into v_inv  from billing_invoices         where farm_id = v_farm;
    select count(*) into v_lin  from billing_invoice_lines    where farm_id = v_farm;
    select count(*) into v_pay  from billing_payments         where farm_id = v_farm;
    select count(*) into v_att  from billing_payment_attempts where farm_id = v_farm;
    select count(*) into v_pm   from billing_payment_methods  where farm_id = v_farm;
    select count(*) into v_snap from billing_asset_snapshots  where farm_id = v_farm;

    if v_sub <> 0 or v_inv <> 0 or v_lin <> 0 or v_pay <> 0 or v_att <> 0 or v_pm <> 0 or v_snap <> 0 then
      raise exception 'BILLING FAIL [b2/%]: reads sub=% inv=% line=% pay=% attempt=% card=% snap=% '
        'of a farm they are not the owner of. Expected 0 of each.',
        r.who, v_sub, v_inv, v_lin, v_pay, v_att, v_pm, v_snap;
    end if;
  end loop;
end $$;

do $$
declare v_wr bigint; v_cost bigint;
begin
  raise notice '── BILLING (b3): the contractor keeps everything it is entitled to ─';
  perform _t_login('b1a00000-0000-0000-0000-000000000005');
  -- Its own work request, and — because see_costs is granted on this link — the farm's
  -- job costs. Both non-zero. So the contractor is demonstrably NOT locked out of the
  -- farm; it is locked out of exactly one thing: what the farm pays Rapid Rise.
  select count(*) into v_wr from work_requests
   where farm_id = 'b1000000-0000-0000-0000-000000000001';
  if v_wr <> 1 then
    raise exception 'BILLING FAIL [b3]: the contractor sees % of its own work requests, expected 1', v_wr;
  end if;
  select count(*) into v_cost from cost_entries
   where farm_id = 'b1000000-0000-0000-0000-000000000001';
  if v_cost < 1 then
    raise exception 'BILLING FAIL [b3]: with see_costs granted the contractor reads % cost entries, '
      'expected at least 1 — the positive control for "billing is the ONLY thing withheld"', v_cost;
  end if;
end $$;
reset role;


-- ═════════════════════════════════════════════════════════════════════════════
-- (c) Cross-tenant: a neighbour's owner is still only their own farm's owner
-- ═════════════════════════════════════════════════════════════════════════════
set role authenticated;
do $$
declare
  v_one uuid := 'b1000000-0000-0000-0000-000000000001';
  v_two uuid := 'b1000000-0000-0000-0000-000000000002';
  n bigint; v text;
begin
  raise notice '── BILLING (c): cross-tenant reads and writes ───────────────────';
  perform _t_login('b1a00000-0000-0000-0000-000000000006');

  -- Positive control: owner two is a billing admin of their OWN farm and reads their own
  -- subscription and card. The zeros that follow are therefore about tenancy.
  if not app.is_farm_billing_admin(v_two) then
    raise exception 'BILLING FAIL [c]: owner two is not a billing admin of their own farm';
  end if;
  select count(*) into n from billing_subscriptions where farm_id = v_two;
  if n <> 1 then
    raise exception 'BILLING FAIL [c]: owner two sees % of their own subscriptions, expected 1', n;
  end if;
  select count(*) into n from billing_payment_methods where farm_id = v_two;
  if n <> 1 then
    raise exception 'BILLING FAIL [c]: owner two sees % of their own cards, expected 1', n;
  end if;

  if app.is_farm_billing_admin(v_one) then
    raise exception 'BILLING FAIL [c]: owner two is a billing admin of ANOTHER farm';
  end if;
  select count(*) into n from billing_subscriptions    where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant subscriptions visible: %', n; end if;
  select count(*) into n from billing_invoices         where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant invoices visible: %', n; end if;
  select count(*) into n from billing_invoice_lines    where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant invoice lines visible: %', n; end if;
  select count(*) into n from billing_payments         where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant payments visible: %', n; end if;
  select count(*) into n from billing_payment_attempts where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant attempts visible: %', n; end if;
  select count(*) into n from billing_payment_methods  where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant cards visible: %', n; end if;
  select count(*) into n from billing_asset_snapshots  where farm_id = v_one; if n <> 0 then raise exception 'BILLING FAIL [c]: cross-tenant snapshots visible: %', n; end if;

  -- A cross-tenant WRITE. billing_price_versions is the one billing table a browser role
  -- holds INSERT/UPDATE on at all (RR admin curates the catalogue through it), so it is
  -- the only place where an RLS write check can be exercised rather than a missing grant.
  v := _b1_denied($q$insert into billing_price_versions
        (version_label, plan, billing_period, per_vehicle_monthly_incl_cents,
         months_charged, vat_rate_bps, status)
        values ('b1-forged', 'complete', 'monthly', 1, 1, 0, 'draft')$q$);
  if v = 'ALLOWED' then
    raise exception 'BILLING FAIL [c]: a farm owner inserted a row into the PRICE CATALOGUE';
  end if;
  if v <> '42501' then
    raise exception 'BILLING FAIL [c]: price insert by a farm owner returned %, expected 42501', v;
  end if;

  -- The seller's own settings are readable by everyone and writable by RR admin alone.
  -- No grant is missing here, so a denial shows up as zero rows rather than an error —
  -- which is why this one is measured with a row count.
  if _b1_rows($q$update billing_settings set support_email = 'forged@example.invalid'
               where singleton$q$) <> 0 then
    raise exception 'BILLING FAIL [c]: a farm owner edited Rapid Rise''s own billing settings';
  end if;
end $$;
reset role;


-- ═════════════════════════════════════════════════════════════════════════════
-- (d) No browser writes anywhere in the ledger — proved on BOTH locks
-- ═════════════════════════════════════════════════════════════════════════════
-- The migrations are explicit that this is defended twice: the grant that 0102's ALTER
-- DEFAULT PRIVILEGES handed out is revoked, AND no permissive policy exists for a write
-- command. Testing only the runtime denial would not distinguish the two, and the whole
-- point of the second lock is that the first one is easy to undo by accident.
do $$
declare
  t text; c text; n integer;
begin
  raise notice '── BILLING (d): browser writes denied, on both locks ────────────';
  foreach t in array array['billing_invoices','billing_payments',
                           'billing_payment_methods','billing_subscriptions'] loop
    -- Lock 1: the privilege is not there.
    foreach c in array array['INSERT','UPDATE','DELETE'] loop
      if has_table_privilege('authenticated', 'public.' || t, c) then
        raise exception 'BILLING FAIL [d]: authenticated holds % on % — 0102''s ALTER DEFAULT '
          'PRIVILEGES grants full CRUD on every new table in public, so a missing revoke '
          'reads as "we never granted it" and is not', c, t;
      end if;
      -- DELETE is deliberately skipped here, and not out of laziness: Postgres has no
      -- column-level DELETE privilege (a delete removes a whole row, so there is no
      -- column to qualify), and `has_any_column_privilege(..., 'DELETE')` raises
      -- "unrecognized privilege type" rather than returning false. The table-level check
      -- immediately above is the one that covers DELETE, and it is sufficient.
      if c <> 'DELETE' and has_any_column_privilege('authenticated', 'public.' || t, c) then
        raise exception 'BILLING FAIL [d]: authenticated holds a COLUMN-level % on %', c, t;
      end if;
    end loop;

    -- Lock 2: even with a grant, no permissive policy would admit the row.
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = t
       and cmd in ('INSERT','UPDATE','DELETE','ALL')
       and 'authenticated' = any (roles);
    if n <> 0 then
      raise exception 'BILLING FAIL [d]: % has % permissive write polic(ies) for authenticated. '
        'Every row in these tables is written by the billing engine or a verified provider '
        'event; there is no legitimate browser path that mints an invoice.', t, n;
    end if;

    -- And both tables are FORCE RLS, so not even the table owner slips past.
    if not exists (select 1 from pg_class where oid = ('public.'||t)::regclass
                     and relrowsecurity and relforcerowsecurity) then
      raise exception 'BILLING FAIL [d]: % is not ENABLE + FORCE row level security', t;
    end if;
  end loop;
end $$;

set role authenticated;
do $$
declare v text;
begin
  perform _t_login('b1a00000-0000-0000-0000-000000000001');

  v := _b1_denied($q$insert into billing_invoices
        (farm_id, subscription_id, invoice_ref, status, period_start, period_end,
         plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
         price_version_label, vat_rate_bps)
        values ('b1000000-0000-0000-0000-000000000001', null, 'B1-FORGED', 'open',
                current_date, current_date, 'complete', 'monthly', 1, 1, 1, 'x', 0)$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner INSERT on billing_invoices returned %', v; end if;

  v := _b1_denied($q$update billing_invoices set amount_paid_cents = 999999
                      where id = 'b1800000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner UPDATE on billing_invoices returned %', v; end if;

  v := _b1_denied($q$delete from billing_invoices where id = 'b1800000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner DELETE on billing_invoices returned %', v; end if;

  v := _b1_denied($q$insert into billing_payments (farm_id, invoice_id, amount_incl_cents)
        values ('b1000000-0000-0000-0000-000000000001',
                'b1800000-0000-0000-0000-000000000001', 999999)$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner INSERT on billing_payments returned %', v; end if;

  v := _b1_denied($q$delete from billing_payments where id = 'b1a20000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner DELETE on billing_payments returned %', v; end if;

  v := _b1_denied($q$update billing_payment_methods set is_default = false
                      where id = 'b1700000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner UPDATE on billing_payment_methods returned %', v; end if;

  v := _b1_denied($q$delete from billing_payment_methods where id = 'b1700000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner DELETE on billing_payment_methods returned %', v; end if;

  v := _b1_denied($q$update billing_subscriptions set plan = 'done_for_you'
                      where id = 'b1600000-0000-0000-0000-000000000001'$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner UPDATE on billing_subscriptions returned %', v; end if;

  v := _b1_denied($q$insert into billing_subscriptions (farm_id, plan, billing_period)
        values ('b1000000-0000-0000-0000-000000000001', 'done_for_you', 'monthly')$q$);
  if v <> '42501' then raise exception 'BILLING FAIL [d]: owner INSERT on billing_subscriptions returned %', v; end if;
end $$;
reset role;


-- ═════════════════════════════════════════════════════════════════════════════
-- (e) The charging credential is not readable, and RLS is not what stops it
-- ═════════════════════════════════════════════════════════════════════════════
-- RLS filters ROWS. The owner is entitled to their own card row; the leak would be a
-- COLUMN of it. Only a column-level grant answers that, and only has_column_privilege
-- makes it machine-checkable.
do $$
declare c text;
begin
  raise notice '── BILLING (e): authorization_code is a credential, not a field ─';

  foreach c in array array['authorization_code','authorization_email'] loop
    if has_column_privilege('authenticated', 'public.billing_payment_methods', c, 'SELECT') then
      raise exception 'BILLING FAIL [e]: authenticated can SELECT %. Together with our secret '
        'key that column can take money from a customer''s card; it belongs in the same '
        'category as a password.', c;
    end if;
    foreach c in array array[c] loop null; end loop;   -- keep the loop variable honest
  end loop;

  -- Everything the owner's own screen genuinely needs is still readable.
  foreach c in array array['id','farm_id','card_brand','last4','exp_month','exp_year',
                           'card_type','bank','bin','reusable','is_default','status'] loop
    if not has_column_privilege('authenticated', 'public.billing_payment_methods', c, 'SELECT') then
      raise exception 'BILLING FAIL [e]: authenticated cannot read % — the owner''s card panel '
        'cannot render, and somebody will "fix" it by granting the whole table', c;
    end if;
  end loop;

  -- The precise shape of the grant: no whole-table SELECT, but some columns. These two
  -- answers differ, and asserting only one of them would miss a widened grant.
  if has_table_privilege('authenticated', 'public.billing_payment_methods', 'SELECT') then
    raise exception 'BILLING FAIL [e]: authenticated holds WHOLE-TABLE select on '
      'billing_payment_methods — every column, including the credential';
  end if;
  if not has_any_column_privilege('authenticated', 'public.billing_payment_methods', 'SELECT') then
    raise exception 'BILLING FAIL [e]: authenticated holds no column select at all on '
      'billing_payment_methods';
  end if;

  -- The webhook table: not one privilege of any kind, table or column. A payload holds
  -- the customer email and the full authorization object.
  foreach c in array array['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER','TRUNCATE'] loop
    if has_table_privilege('authenticated', 'public.billing_webhook_events', c) then
      raise exception 'BILLING FAIL [e]: authenticated holds % on billing_webhook_events', c;
    end if;
  end loop;
  foreach c in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
    if has_any_column_privilege('authenticated', 'public.billing_webhook_events', c) then
      raise exception 'BILLING FAIL [e]: authenticated holds a column-level % on '
        'billing_webhook_events', c;
    end if;
  end loop;
end $$;

set role authenticated;
do $$
declare v text; v_last4 text;
begin
  perform _t_login('b1a00000-0000-0000-0000-000000000001');

  -- The documented consequence, measured: `select *` ERRORS rather than quietly
  -- returning a partial row. An error is a bug report; a silently omitted column is a
  -- leak nobody notices.
  v := _b1_denied('select * from billing_payment_methods where farm_id = ''b1000000-0000-0000-0000-000000000001''');
  if v <> '42501' then
    raise exception 'BILLING FAIL [e]: `select *` on billing_payment_methods returned % for the '
      'card''s own owner, expected 42501', v;
  end if;
  v := _b1_denied('select authorization_code from billing_payment_methods');
  if v <> '42501' then
    raise exception 'BILLING FAIL [e]: selecting authorization_code directly returned %', v;
  end if;

  -- …while the display columns work, which is what makes the above a scoping decision
  -- rather than a broken table.
  select last4 into v_last4 from billing_payment_methods
   where id = 'b1700000-0000-0000-0000-000000000001';
  if v_last4 <> '4242' then
    raise exception 'BILLING FAIL [e]: the owner cannot read their own card''s last4 (got %)', v_last4;
  end if;
end $$;
reset role;


-- ═════════════════════════════════════════════════════════════════════════════
-- (f) One invoice per farm per period, however many times you ask
-- ═════════════════════════════════════════════════════════════════════════════
-- Two independent mechanisms, because one is a race and the other is a repeat. Both are
-- asserted: the unique index (two workers at the same instant) and the generator's own
-- idempotency (a cron that fires twice, a retry, a human pressing "raise it now").
do $$
declare v_state text;
begin
  raise notice '── BILLING (f): invoice/period idempotency ──────────────────────';

  -- The constraint. A second invoice for the same farm and period is a duplicate key,
  -- not a second bill.
  begin
    insert into billing_invoices (farm_id, subscription_id, invoice_ref, status,
      period_start, period_end, plan, billing_period, asset_count,
      unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
    values ('b1000000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001',
      'B1-INV-DUP', 'open', current_date, current_date + 29,
      'complete', 'monthly', 3, 1234, 1, 'b1-synthetic', 0);
    raise exception 'BILLING FAIL [f]: a SECOND invoice was accepted for the same farm and period';
  exception when unique_violation then null;
  end;

  -- A VOID invoice is excluded from that index on purpose (an invoice raised in error is
  -- kept, and the period must remain billable), so the same period may be re-raised once
  -- the mistake has been voided. Stated here so nobody "tightens" the index later.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'billing_invoices_farm_period_uq'
       and indexdef like '%status <> ''void''%') then
    raise exception 'BILLING FAIL [f]: billing_invoices_farm_period_uq no longer excludes voided '
      'invoices — an invoice raised in error would permanently consume its period';
  end if;
end $$;

do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000003';   -- Farm Zero's, reused below
  v_gen uuid := 'b1600000-0000-0000-0000-000000000004';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000004';
  n1 integer; n2 integer; v_count bigint; v_err text;
begin
  -- A farm of its own so the generator is exercised on a clean subscription rather than
  -- on one this suite has already invoiced by hand.
  insert into farms (id, name, plan, status, billing_period)
  values (v_farm, 'Billing Farm Gen', 'complete', 'active', 'monthly');
  insert into machines (farm_id, name, type, meter_type, status) values
    (v_farm, 'Gen A', 'tractor', 'hours', 'active'),
    (v_farm, 'Gen B', 'tractor', 'hours', 'active');
  insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
    current_period_start, next_billing_on)
  values (v_gen, v_farm, 'complete', 'monthly', 'active', current_date, current_date);

  begin
    n1 := app.generate_billing_invoices(v_gen);
  exception when others then
    raise exception 'BILLING FAIL [f]: app.generate_billing_invoices RAISED (%): %. '
      'The generator inserts the invoice with status ''open'' and then inserts its lines, '
      'but app.billing_freeze_invoice_line() refuses any line whose invoice is not a '
      'draft — so the nightly billing run creates nothing at all. Fix: insert the invoice '
      'as ''draft'', write the lines, then UPDATE it to ''open'' (the freeze trigger '
      'permits a draft to be issued).', sqlstate, sqlerrm;
  end;

  if n1 <> 1 then
    raise exception 'BILLING FAIL [f]: the first generator run made % invoice(s), expected 1', n1;
  end if;

  n2 := app.generate_billing_invoices(v_gen);
  select count(*) into v_count from billing_invoices
   where farm_id = v_farm and period_start = current_date and deleted_at is null;
  if v_count <> 1 then
    raise exception 'BILLING FAIL [f]: after running the generator twice there are % invoice(s) '
      'for the period, expected exactly 1 (second run reported %)', v_count, n2;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (g) A charge is claimed exactly once, and an unresolved one blocks the queue
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-000000000001';
  v_a1 uuid; v_a2 uuid; n bigint;
begin
  raise notice '── BILLING (g): charge exclusivity and the unknown attempt ──────';

  -- POSITIVE CONTROL. The queue must offer this invoice BEFORE anything is in flight,
  -- otherwise "it is not offered afterwards" is a statement about an empty queue.
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [g]: due_billing_charges does not offer a payable invoice '
      '(got % rows). Everything below would then pass for the wrong reason.', n;
  end if;

  v_a1 := app.claim_billing_charge(v_inv, 'B1-REF-G1', 'charge_authorization', 2702);
  if v_a1 is null then
    raise exception 'BILLING FAIL [g]: the first claim returned NULL';
  end if;
  v_a2 := app.claim_billing_charge(v_inv, 'B1-REF-G2', 'charge_authorization', 2702);
  if v_a2 is not null then
    raise exception 'BILLING FAIL [g]: a second worker claimed the same invoice. Two workers '
      'both checking first and both finding nothing in flight is exactly how money is '
      'taken twice; the inflight unique index is what must stop it.';
  end if;

  -- A pending attempt removes the invoice from the queue.
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [g]: an invoice with a PENDING attempt is still offered for '
      'charging (% rows)', n;
  end if;

  -- The network died. We do not know whether the customer was charged, so the attempt
  -- becomes `unknown` and must block everything until a human reconciles that exact
  -- reference against Paystack.
  update billing_payment_attempts set status = 'unknown' where id = v_a1;
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [g]: an invoice with an UNKNOWN attempt is offered for '
      'charging again (% rows). That is the double-charge path: recovery is '
      'transaction/verify on the reference we already minted, never a fresh charge.', n;
  end if;
  if app.claim_billing_charge(v_inv, 'B1-REF-G3', 'charge_authorization', 2702) is not null then
    raise exception 'BILLING FAIL [g]: an invoice with an UNKNOWN attempt was claimed again';
  end if;

  -- Resolve it and the invoice returns to the queue — proving the block was the attempt
  -- status and not something incidental about the fixture.
  update billing_payment_attempts set status = 'failed', resolved_at = now() where id = v_a1;
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [g]: after the unknown attempt was reconciled the invoice is '
      'still not offered (% rows) — the earlier zeros may have had another cause', n;
  end if;
end $$;

do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-000000000002';
  n bigint;
begin
  -- Farm Two's stored card is the one Paystack marked non-reusable. Paystack's own
  -- instruction is to use an authorization_code only when `reusable` is true, so such a
  -- card must never reach the charging queue: it would fail every renewal on a farm that
  -- looks, on screen, perfectly set up.
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values (v_inv, 'b1000000-0000-0000-0000-000000000002', 'b1600000-0000-0000-0000-000000000002',
    'B1-INV-0002', 'open', current_date, current_date + 364, current_date, current_date,
    'professional', 'annual', 2, 4444, 10, 'b1500000-0000-0000-0000-000000000002', 'b1-synthetic', 0);

  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [g]: an invoice backed by a NON-reusable authorization was '
      'offered for charging (% rows)', n;
  end if;

  -- POSITIVE CONTROL for the same invoice: make the card reusable and it appears. So the
  -- zero above was about `reusable`, not about the invoice being unpayable for some
  -- other reason the fixture happened to create.
  update billing_payment_methods
     set reusable = true, authorization_code = 'AUTH_b1two',
         authorization_email = 'billing.owner2@example.invalid'
   where id = 'b1700000-0000-0000-0000-000000000002';
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [g]: the same invoice is still not offered once its card is '
      'reusable and carries an authorization (% rows) — the previous assertion proved nothing', n;
  end if;

  -- Put it back, so nothing downstream inherits a card this suite quietly upgraded.
  update billing_payment_methods
     set authorization_code = null, authorization_email = null, reusable = false
   where id = 'b1700000-0000-0000-0000-000000000002';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (h) The arithmetic: annual terms, and SQL agreeing with TypeScript
-- ═════════════════════════════════════════════════════════════════════════════
-- The screen, the invoice row and the charge amount are read by the same person in the
-- same minute. If `app.ex_vat_cents` and `exVatCents` in src/lib/money.ts round
-- differently, all three are useless — so the expected values below are the output of
-- the TypeScript function, transcribed, not a second SQL implementation of the same idea.
do $$
declare
  r record; v_ex bigint; v_vat bigint;
begin
  raise notice '── BILLING (h): VAT arithmetic matches src/lib/money.ts ─────────';
  for r in
    select * from (values
      -- (inclusive cents, rate bps, expected ex-VAT from Math.round(incl*10000/(10000+rate)))
      (1::bigint,        1500, 1::bigint),
      (2::bigint,        1500, 2::bigint),
      (3::bigint,        1500, 3::bigint),
      -- 4 → 3.478 rounds DOWN and 19 → 16.52 rounds UP. At 15% these are the two values
      -- closest to a tie that exist, so they pin the rounding boundary in both languages.
      (4::bigint,        1500, 3::bigint),
      (19::bigint,       1500, 17::bigint),
      (7::bigint,        1500, 6::bigint),
      (1234::bigint,     1500, 1073::bigint),
      (3702::bigint,     1500, 3219::bigint),
      (11499::bigint,    1500, 9999::bigint),
      (11500::bigint,    1500, 10000::bigint),
      (11501::bigint,    1500, 10001::bigint),
      (99999::bigint,    1500, 86956::bigint),
      (1000000::bigint,  1500, 869565::bigint),
      (12345678::bigint, 1500, 10735372::bigint),
      (3702::bigint,        0, 3702::bigint),
      (12345::bigint,    1400, 10829::bigint),
      (12345::bigint,    2000, 10288::bigint),
      (999::bigint,         1, 999::bigint),
      -- An EXACT .5. JavaScript's Math.round is half-up and Postgres's round(numeric) is
      -- half-away-from-zero; for the non-negative amounts money is made of they agree,
      -- and this is the only case in the table that actually exercises that.
      (1::bigint,       10000, 1::bigint)
    ) as t(incl, rate, expect_ex)
  loop
    v_ex  := app.ex_vat_cents(r.incl, r.rate);
    v_vat := app.vat_of_incl_cents(r.incl, r.rate);
    if v_ex <> r.expect_ex then
      raise exception 'BILLING FAIL [h]: app.ex_vat_cents(%, %) = %, but src/lib/money.ts '
        'exVatCents gives %', r.incl, r.rate, v_ex, r.expect_ex;
    end if;
    if v_ex + v_vat <> r.incl then
      raise exception 'BILLING FAIL [h]: % + % <> % at rate % — the split does not reconcile',
        v_ex, v_vat, r.incl, r.rate;
    end if;
  end loop;
end $$;

do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-000000000003';
  v_total bigint; v_ex bigint; v_vat bigint; v_months integer; v_rate integer;
begin
  raise notice '── BILLING (h2): annual = unit x vehicles x months_charged ──────';

  -- Farm Two is on an annual price with two months free: months_charged = 10.
  select months_charged into v_months from billing_invoices
   where id = 'b1800000-0000-0000-0000-000000000002';
  if v_months <> 10 then
    raise exception 'BILLING FAIL [h2]: the annual invoice charges % months, expected 10 '
      '(annual pre-pay is two months free)', v_months;
  end if;
  select total_incl_cents, subtotal_ex_vat_cents, vat_cents
    into v_total, v_ex, v_vat
    from billing_invoices where id = 'b1800000-0000-0000-0000-000000000002';
  if v_total <> 4444 * 2 * 10 then
    raise exception 'BILLING FAIL [h2]: annual total is %, expected % (4444 x 2 vehicles x 10 months)',
      v_total, 4444 * 2 * 10;
  end if;
  -- Unregistered today: the whole inclusive amount is the ex-VAT subtotal.
  if v_ex <> v_total or v_vat <> 0 then
    raise exception 'BILLING FAIL [h2]: at a zero rate ex=% vat=% for a total of %; expected % and 0',
      v_ex, v_vat, v_total, v_total;
  end if;

  -- Now the same shape once Rapid Rise IS registered. The point of building the machinery
  -- in full is that registering later is a flag flip which restates no historical invoice.
  update billing_settings set vat_registered = true, vat_number = 'B1-VAT-4999999999',
                              vat_rate_bps = 1500 where singleton;

  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values (v_inv, 'b1000000-0000-0000-0000-000000000002', 'b1600000-0000-0000-0000-000000000002',
    'B1-INV-0003', 'open', current_date + 365, current_date + 729, current_date, current_date,
    'professional', 'annual', 2, 4444, 10, 'b1500000-0000-0000-0000-000000000002', 'b1-synthetic', 1500);

  select total_incl_cents, subtotal_ex_vat_cents, vat_cents, vat_rate_bps
    into v_total, v_ex, v_vat, v_rate from billing_invoices where id = v_inv;
  if v_rate <> 1500 then
    raise exception 'BILLING FAIL [h2]: a registered vendor''s invoice carries rate %, expected 1500', v_rate;
  end if;
  if v_total <> 88880 then
    raise exception 'BILLING FAIL [h2]: annual total moved to % when VAT was switched on. The '
      'inclusive price is the price paid; VAT is derived FROM it, never added TO it.', v_total;
  end if;
  -- 88880 inclusive at 15%: ex = round(88880 * 10000 / 11500) = 77287, vat = 11593.
  if v_ex <> 77287 or v_vat <> 11593 then
    raise exception 'BILLING FAIL [h2]: expected ex 77287 / vat 11593, got ex % / vat %', v_ex, v_vat;
  end if;
  if v_ex + v_vat <> v_total then
    raise exception 'BILLING FAIL [h2]: % + % <> %', v_ex, v_vat, v_total;
  end if;

  -- And the monthly side reconciles at the same rate, so the two periods do not disagree.
  select total_incl_cents, subtotal_ex_vat_cents, vat_cents into v_total, v_ex, v_vat
    from billing_invoices where id = 'b1800000-0000-0000-0000-000000000001';
  if v_ex + v_vat <> v_total then
    raise exception 'BILLING FAIL [h2]: the monthly invoice split does not reconcile: % + % <> %',
      v_ex, v_vat, v_total;
  end if;

  -- The historical, unregistered invoice must not have been restated by the flag flip.
  select vat_rate_bps, vat_cents into v_rate, v_vat
    from billing_invoices where id = 'b1800000-0000-0000-0000-000000000002';
  if v_rate <> 0 or v_vat <> 0 then
    raise exception 'BILLING FAIL [h2]: registering for VAT RESTATED an invoice issued while '
      'unregistered (rate now %, vat %)', v_rate, v_vat;
  end if;

  update billing_settings set vat_registered = false, vat_number = null where singleton;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (h3) The VAT GUARD, not just the VAT arithmetic
-- ═════════════════════════════════════════════════════════════════════════════
-- Added because a mutation survived. Sections (h) and (h2) prove `app.ex_vat_cents`
-- computes the right split and that registering does not restate history — but both
-- feed the function a rate. Neither noticed when `app.billing_force_vat_rate` was
-- replaced with a body that simply returns NEW, which is to say: neither noticed an
-- unregistered vendor being able to issue VAT it cannot legally collect and has no
-- number to print (VAT Act s20(4)).
--
-- The distinction matters because the guard is the ONLY thing standing between a stale
-- form, an import or a bug and a document that claims tax. It is asserted the way it
-- actually gets attacked: by a caller passing 1500 anyway.
do $$
declare
  v_farm  uuid := 'b1000000-0000-0000-0000-000000000001';
  v_sub   uuid := 'b1600000-0000-0000-0000-000000000001';
  v_inv   uuid;
  v_rate  integer; v_vat bigint; v_ex bigint; v_total bigint; v_no text;
begin
  raise notice '── BILLING (h3): the VAT guard overrules the caller ─────────────';

  if (select vat_registered from billing_settings where singleton) then
    raise exception 'BILLING FAIL [h3]: the fixture is not in the shipped state '
      '(vat_registered must be false here, or this section proves nothing)';
  end if;

  -- A caller doing the wrong thing on purpose: a 15% rate and a VAT number, from a
  -- vendor that is not registered for VAT.
  insert into billing_invoices (
    farm_id, subscription_id, invoice_ref, status, period_start, period_end,
    plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
    price_version_label, vat_rate_bps, seller_vat_number
  ) values (
    v_farm, v_sub, 'B1-VATGUARD-1', 'draft', date '2027-01-01', date '2027-01-31',
    'complete', 'monthly', 3, 1234, 1,
    'b1-synthetic', 1500, '4123456789'
  ) returning id into v_inv;

  select vat_rate_bps, vat_cents, subtotal_ex_vat_cents, total_incl_cents, seller_vat_number
    into v_rate, v_vat, v_ex, v_total, v_no
    from billing_invoices where id = v_inv;

  if v_rate <> 0 then
    raise exception 'BILLING FAIL [h3]: the guard let a rate of % through for a vendor that '
      'is NOT VAT-registered. app.billing_force_vat_rate must overrule the caller, because '
      'the caller is exactly what goes wrong.', v_rate;
  end if;
  if v_vat <> 0 then
    raise exception 'BILLING FAIL [h3]: an unregistered vendor issued % cents of VAT', v_vat;
  end if;
  if v_no is not null then
    raise exception 'BILLING FAIL [h3]: a seller VAT number (%) survived onto an '
      'unregistered vendor''s invoice', v_no;
  end if;
  if v_ex <> v_total then
    raise exception 'BILLING FAIL [h3]: at a zero rate the ex-VAT subtotal (%) must equal '
      'the inclusive total (%)', v_ex, v_total;
  end if;

  -- And the ORDER: the split must be computed from the CORRECTED rate. If the guard ran
  -- after the totals trigger, the rate column would read 0 while the money still carried
  -- a 15% split — which is the bug 0403 had to go back and fix on the partner side.
  if v_total <> 1234 * 3 then
    raise exception 'BILLING FAIL [h3]: total is %, expected % — the totals were derived '
      'before the guard corrected the rate', v_total, 1234 * 3;
  end if;

  delete from billing_invoices where id = v_inv;   -- still a draft, so this is allowed
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (i) Zero vehicles, and a fleet that changes between periods
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000003';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000003';
  v_before date; v_after date; n integer; c bigint;
begin
  raise notice '── BILLING (i): zero vehicles, and a changing fleet ─────────────';

  if app.billable_asset_count(v_farm) <> 0 then
    raise exception 'BILLING FAIL [i]: the zero-vehicle farm counts % billable vehicles',
      app.billable_asset_count(v_farm);
  end if;
  -- …and the billable rule itself, which is the number every bill is built on.
  if app.billable_asset_count('b1000000-0000-0000-0000-000000000001') <> 3 then
    raise exception 'BILLING FAIL [i]: Farm One counts % billable vehicles, expected 3 '
      '(active + in_workshop + out_of_service; retired and sold excluded)',
      app.billable_asset_count('b1000000-0000-0000-0000-000000000001');
  end if;
  -- A broken tractor is still a tractor we host. Prove the rule turns on retired/sold and
  -- not on "is it working", by moving one machine into and out of out_of_service.
  update machines set status = 'active' where id = 'b1300000-0000-0000-0000-000000000003';
  if app.billable_asset_count('b1000000-0000-0000-0000-000000000001') <> 3 then
    raise exception 'BILLING FAIL [i]: out_of_service changed the billable count; it must not';
  end if;
  update machines set status = 'out_of_service' where id = 'b1300000-0000-0000-0000-000000000003';
  -- The denormalised farms.asset_count must agree with the live count the bill uses.
  if (select asset_count from farms where id = 'b1000000-0000-0000-0000-000000000001') <> 3 then
    raise exception 'BILLING FAIL [i]: farms.asset_count (%) disagrees with app.billable_asset_count',
      (select asset_count from farms where id = 'b1000000-0000-0000-0000-000000000001');
  end if;

  select next_billing_on into v_before from billing_subscriptions where id = v_sub;
  n := app.generate_billing_invoices(v_sub);
  select next_billing_on into v_after from billing_subscriptions where id = v_sub;
  select count(*) into c from billing_invoices where farm_id = v_farm;

  if c <> 0 or n <> 0 then
    raise exception 'BILLING FAIL [i]: a farm with no billable vehicle was invoiced (% invoice(s), '
      'generator reported %). Paystack will not process a zero charge and the row would sit '
      'open for ever.', c, n;
  end if;
  if v_after <= v_before then
    raise exception 'BILLING FAIL [i]: the zero-vehicle subscription''s next_billing_on stayed at % '
      '— it would be reconsidered every night for ever', v_before;
  end if;
end $$;

do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000004';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000004';
  v_first_count integer; v_first_total bigint; v_first_ref text;
  v_second_count integer; v_second_total bigint; n integer; c bigint;
  v_pend date;
begin
  -- Two vehicles were billed a moment ago in section (f). Buy two more and roll the
  -- period forward: the NEXT invoice must say four, and the FIRST must still say two.
  select asset_count, total_incl_cents, invoice_ref, period_end
    into v_first_count, v_first_total, v_first_ref, v_pend
    from billing_invoices where farm_id = v_farm order by period_start limit 1;
  if v_first_count <> 2 then
    raise exception 'BILLING FAIL [i2]: the first invoice says % vehicles, expected 2', v_first_count;
  end if;

  insert into machines (farm_id, name, type, meter_type, status) values
    (v_farm, 'Gen C', 'tractor', 'hours', 'active'),
    (v_farm, 'Gen D', 'bakkie',  'km',    'out_of_service');

  -- Both period columns move together. `billing_subscriptions_period_ck` requires
  -- end >= start, so advancing only the start is an invalid intermediate state the
  -- database refuses — correctly: a subscription whose period ends before it begins is
  -- not a state any real code path produces.
  update billing_subscriptions
     set current_period_start = v_pend + 1,
         current_period_end   = v_pend + 31,
         next_billing_on      = v_pend + 1
   where id = v_sub;
  -- The generator only looks at subscriptions whose next_billing_on has arrived, so put
  -- the clock where the cron would find it.
  update billing_subscriptions set next_billing_on = current_date where id = v_sub;

  n := app.generate_billing_invoices(v_sub);
  if n <> 1 then
    raise exception 'BILLING FAIL [i2]: the second period produced % invoice(s), expected 1. '
      'NOTE: app.generate_billing_invoices writes current_period_start back UNCHANGED '
      '(current_period_start = v_pstart), so on its own it recomputes the SAME period next '
      'time, loses to billing_invoices_farm_period_uq and `continue`s WITHOUT advancing '
      'next_billing_on — a farm is invoiced once and then silently never again.', n;
  end if;

  select count(*) into c from billing_invoices where farm_id = v_farm and deleted_at is null;
  if c <> 2 then
    raise exception 'BILLING FAIL [i2]: expected 2 invoices for the two periods, found %', c;
  end if;

  select asset_count, total_incl_cents into v_second_count, v_second_total
    from billing_invoices where farm_id = v_farm order by period_start desc limit 1;
  if v_second_count <> 4 then
    raise exception 'BILLING FAIL [i2]: the second invoice says % vehicles, expected 4', v_second_count;
  end if;
  if v_second_total <> 1234 * 4 then
    raise exception 'BILLING FAIL [i2]: the second invoice totals %, expected %',
      v_second_total, 1234 * 4;
  end if;

  -- The first bill is a statement about a period that has been billed. Nothing that
  -- happened afterwards may restate it.
  select asset_count, total_incl_cents into v_first_count, v_first_total
    from billing_invoices where invoice_ref = v_first_ref;
  if v_first_count <> 2 or v_first_total <> 1234 * 2 then
    raise exception 'BILLING FAIL [i2]: buying two vehicles RESTATED the previous invoice '
      '(now % vehicles, %)', v_first_count, v_first_total;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (j) Function lockdown, enumerated rather than spot-checked
-- ═════════════════════════════════════════════════════════════════════════════
-- This codebase has been bitten twice by a function shipping with the PostgreSQL default
-- of EXECUTE TO PUBLIC: `public._f14_probe` on production, and `app.stock_needs_reorder`
-- caught by the G11 section the first time it ran. So every billing function is listed
-- and every one is checked, and the list length is asserted so a rename fails loudly
-- instead of quietly dropping a function out of the sweep.
do $$
declare
  v_app_fns text[] := array[
    'ex_vat_cents','vat_of_incl_cents','billing_force_vat_rate','billing_derive_invoice_totals',
    'billing_freeze_invoice','billing_freeze_invoice_line','billing_freeze_price_version',
    'is_farm_billing_admin','billable_asset_count','capture_billing_asset_snapshots',
    'next_billing_invoice_ref','billing_active_price','generate_billing_invoices',
    'billing_advance_period','due_billing_charges','claim_billing_charge',
    'settle_billing_attempt','billing_register_failure','billing_apply_downgrades',
    'billing_restore_after_payment','enqueue_billing_reminders','billing_close_cancellations',
    'billing_rollup_invoice_payments','start_billing_subscription',
    'claim_billing_receipt','release_billing_receipt','claim_billing_failure_notice',
    'billing_receipts_due','billing_failure_notices_due',
    'billing_card_expiry_on','billing_cards_expiring','enqueue_billing_card_expiry',
    'release_billing_failure_notice'];
  v_cron_fns text[] := array[
    'cron_capture_billing_snapshots','cron_generate_billing_invoices',
    'cron_apply_billing_downgrades','cron_enqueue_billing_reminders',
    'cron_close_billing_cancellations','cron_enqueue_billing_card_expiry'];
  -- The wrappers service.ts calls by name. Separate from the cron list because they
  -- exist for a different reason: PostgREST exposes `public` only, so without these the
  -- charging path is unreachable no matter how the `app` functions are granted.
  v_rpc_fns text[] := array[
    'billing_due_charges','billing_claim_charge','billing_settle_attempt',
    'billing_generate_invoices','billing_start_subscription',
    'billing_claim_receipt','billing_release_receipt','billing_claim_failure_notice',
    'billing_receipts_due','billing_failure_notices_due','billing_cards_expiring',
    'billing_release_failure_notice'];
  -- Deliberately executable by a browser session: pure arithmetic, the read-only price
  -- lookup, the date helper, and the predicate the UI needs to decide whether to render
  -- a billing screen at all. None of them can move money or read a credential.
  v_auth_ok text[] := array[
    'ex_vat_cents','vat_of_incl_cents','is_farm_billing_admin','billing_active_price',
    'billing_advance_period','billing_card_expiry_on'];
  -- Reachable by the service role directly. Everything else in `app` is reached ONLY
  -- through a public.cron_* wrapper — PostgREST exposes `public` alone, so an app schema
  -- function is not callable over REST regardless of its grants.
  v_svc_ok text[] := array[
    'ex_vat_cents','vat_of_incl_cents','is_farm_billing_admin','billing_active_price',
    'billing_advance_period','billable_asset_count','billing_card_expiry_on'];
  r record; n integer := 0;
begin
  raise notice '── BILLING (j): every billing function locked down ──────────────';

  for r in
    select p.oid, n2.nspname, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where (n2.nspname = 'app'    and p.proname = any (v_app_fns))
        or (n2.nspname = 'public' and p.proname = any (v_cron_fns))
        or (n2.nspname = 'public' and p.proname = any (v_rpc_fns))
  loop
    n := n + 1;

    -- The trap this project has hit twice: a function with no grant statement at all is
    -- born EXECUTE TO PUBLIC.
    if has_function_privilege('public', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [j]: %.% is executable by PUBLIC — the PostgreSQL default '
        'that put app.stock_needs_reorder and public._f14_probe on the wrong side of the '
        'fence', r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [j]: %.% is executable by anon', r.nspname, r.proname;
    end if;

    if has_function_privilege('authenticated', r.oid, 'EXECUTE')
       and not (r.nspname = 'app' and r.proname = any (v_auth_ok)) then
      raise exception 'BILLING FAIL [j]: %.% is executable by `authenticated`. Only the five '
        'read-only helpers are, and a new one must be argued for here first.',
        r.nspname, r.proname;
    end if;
    if r.nspname = 'app' and r.proname = any (v_auth_ok)
       and not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [j]: app.% lost its `authenticated` grant — the billing '
        'screen cannot render its own prices', r.proname;
    end if;

    if r.nspname = 'public' and not has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [j]: the cron wrapper public.% is not executable by '
        'service_role — the nightly route cannot run it', r.proname;
    end if;
    if r.nspname = 'app'
       and has_function_privilege('service_role', r.oid, 'EXECUTE')
       and not (r.proname = any (v_svc_ok)) then
      raise exception 'BILLING FAIL [j]: app.% became directly executable by service_role. The '
        'engine is meant to be reached through its public.* wrappers; if this is a new, '
        'deliberate entry point, add it to v_svc_ok here so the decision is recorded.', r.proname;
    end if;

    -- Every engine function pins its search_path. A SECURITY DEFINER function that does
    -- not is a privilege-escalation waiting for somebody to create a shadowing object.
    if r.prosecdef and (r.proconfig is null
        or not exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%')) then
      raise exception 'BILLING FAIL [j]: %.% is SECURITY DEFINER with no pinned search_path',
        r.nspname, r.proname;
    end if;
  end loop;

  if n <> array_length(v_app_fns, 1) + array_length(v_cron_fns, 1) + array_length(v_rpc_fns, 1) then
    raise exception 'BILLING FAIL [j]: found % of the % billing functions this suite knows about. '
      'A rename or a drop must fail here rather than silently shrinking the sweep.',
      n, array_length(v_app_fns, 1) + array_length(v_cron_fns, 1) + array_length(v_rpc_fns, 1);
  end if;

  -- Completeness the other way round: nothing may touch a billing table from outside the
  -- enumerated set. This is what catches a function ADDED later under a name the list
  -- above does not know.
  for r in
    select n2.nspname, p.proname
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where n2.nspname in ('app','public')
       and p.prosrc ~ 'billing_(invoices|invoice_lines|subscriptions|payments|payment_methods|payment_attempts|settings|price_versions|asset_snapshots|webhook_events|invoice_ref_seq)'
       and not (n2.nspname = 'app'    and p.proname = any (v_app_fns))
       and not (n2.nspname = 'public' and p.proname = any (v_cron_fns))
       and not (n2.nspname = 'public' and p.proname = any (v_rpc_fns))
  loop
    raise exception 'BILLING FAIL [j]: %.% reads or writes a billing table but is not in this '
      'suite''s lockdown sweep', r.nspname, r.proname;
  end loop;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (k) The scope boundary: this ledger and the partner ledger never meet
-- ═════════════════════════════════════════════════════════════════════════════
-- FleetWise deliberately does not sit between a farm and its contractors. The dormant
-- PayFast seam stays inert, and nothing here may reach into partner_documents /
-- partner_payments / partner_expenses. Asserted structurally (no billing function even
-- MENTIONS them) and behaviourally (running the engine moves not one partner row).
do $$
declare r record; v_cost bigint; v_pe bigint; v_pd bigint; v_pp bigint;
begin
  raise notice '── BILLING (k): no PayFast / partner-ledger regression ──────────';

  for r in
    select n2.nspname, p.proname, p.prosrc
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where n2.nspname in ('app','public')
       and (p.proname like '%billing%'
            or p.proname in ('ex_vat_cents','vat_of_incl_cents','billable_asset_count'))
       -- app.quote_billing is the PARTNER side's progress-billing helper (0432). It
       -- matches on the word "billing" and has nothing to do with this ledger; excluding
       -- it by name, with this reason, is safer than narrowing the pattern until it
       -- happens to miss something else.
       and not (n2.nspname = 'app' and p.proname = 'quote_billing')
  loop
    if r.prosrc ~* '(partner_documents|partner_payments|partner_expenses|payfast)' then
      raise exception 'BILLING FAIL [k]: %.% references the partner ledger or PayFast. This is '
        'farms paying Rapid Rise for software — one direction, one relationship — and it '
        'must never become the money moving between a farm and its contractors.',
        r.nspname, r.proname;
    end if;
  end loop;

  select count(*) into v_cost from cost_entries      where farm_id = 'b1000000-0000-0000-0000-000000000001';
  select count(*) into v_pe   from partner_expenses  where workshop_id = 'b1900000-0000-0000-0000-000000000001';
  select count(*) into v_pd   from partner_documents where workshop_id = 'b1900000-0000-0000-0000-000000000001';
  select count(*) into v_pp   from partner_payments;

  if v_cost < 1 or v_pe < 1 then
    raise exception 'BILLING FAIL [k]: the partner-side baseline is empty (costs=%, expenses=%), '
      'so "unchanged" would be 0 = 0 and would prove nothing', v_cost, v_pe;
  end if;

  perform app.capture_billing_asset_snapshots('manual-k');
  perform app.generate_billing_invoices(null);
  perform app.enqueue_billing_reminders();
  perform app.billing_close_cancellations();

  if (select count(*) from cost_entries where farm_id = 'b1000000-0000-0000-0000-000000000001') <> v_cost
     or (select count(*) from partner_expenses where workshop_id = 'b1900000-0000-0000-0000-000000000001') <> v_pe
     or (select count(*) from partner_documents where workshop_id = 'b1900000-0000-0000-0000-000000000001') <> v_pd
     or (select count(*) from partner_payments) <> v_pp then
    raise exception 'BILLING FAIL [k]: running the billing engine changed the partner ledger';
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (l) A downgrade closes gates. It does not delete anything.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000001';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000001';
  m0 bigint; j0 bigint; c0 bigint; i0 bigint; s0 bigint;
  m1 bigint; j1 bigint; c1 bigint; i1 bigint; s1 bigint;
  v_plan farm_plan; v_prev farm_plan; v_status billing_subscription_status; n integer;
begin
  raise notice '── BILLING (l): downgrade preserves every record ────────────────';

  select count(*) into m0 from machines     where farm_id = v_farm and deleted_at is null;
  select count(*) into j0 from job_cards    where farm_id = v_farm and deleted_at is null;
  select count(*) into c0 from cost_entries where farm_id = v_farm and deleted_at is null;
  select count(*) into i0 from billing_invoices where farm_id = v_farm and deleted_at is null;
  select count(*) into s0 from billing_asset_snapshots where farm_id = v_farm;
  if m0 < 1 or j0 < 1 or c0 < 1 or i0 < 1 then
    raise exception 'BILLING FAIL [l]: the baseline is empty (machines=% jobs=% costs=% invoices=%), '
      'so "nothing was deleted" would prove nothing', m0, j0, c0, i0;
  end if;

  update billing_subscriptions
     set status = 'grace', grace_ends_on = current_date - 1, failed_attempt_count = 4
   where id = v_sub;

  n := app.billing_apply_downgrades();
  if n <> 1 then
    raise exception 'BILLING FAIL [l]: billing_apply_downgrades processed % subscription(s), expected 1', n;
  end if;

  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'essential' then
    raise exception 'BILLING FAIL [l]: the EFFECTIVE plan is % after a downgrade, expected essential', v_plan;
  end if;
  select plan, plan_before_downgrade, status into v_plan, v_prev, v_status
    from billing_subscriptions where id = v_sub;
  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [l]: the COMMERCIAL plan moved to %. billing_subscriptions.plan is '
      'what the farm BOUGHT; collapsing it into farms.plan loses the record of what recovery '
      'owes them.', v_plan;
  end if;
  if v_prev <> 'complete' then
    raise exception 'BILLING FAIL [l]: plan_before_downgrade is %, expected complete', v_prev;
  end if;
  if v_status <> 'downgraded' then
    raise exception 'BILLING FAIL [l]: subscription status is % after a downgrade', v_status;
  end if;

  select count(*) into m1 from machines     where farm_id = v_farm and deleted_at is null;
  select count(*) into j1 from job_cards    where farm_id = v_farm and deleted_at is null;
  select count(*) into c1 from cost_entries where farm_id = v_farm and deleted_at is null;
  select count(*) into i1 from billing_invoices where farm_id = v_farm and deleted_at is null;
  select count(*) into s1 from billing_asset_snapshots where farm_id = v_farm;
  if m1 <> m0 or j1 <> j0 or c1 <> c0 or i1 <> i0 or s1 <> s0 then
    raise exception 'BILLING FAIL [l]: a downgrade DELETED data — machines %→%, job cards %→%, '
      'cost entries %→%, invoices %→%, snapshots %→%. Never delete a customer''s records for '
      'non-payment.', m0, m1, j0, j1, c0, c1, i0, i1, s0, s1;
  end if;

  -- Recovery hands back exactly what was taken.
  perform app.billing_restore_after_payment(v_sub);
  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [l]: after payment the effective plan is %, expected complete restored',
      v_plan;
  end if;
  select plan_before_downgrade, status, failed_attempt_count
    into v_prev, v_status, n from billing_subscriptions where id = v_sub;
  if v_prev is not null or v_status <> 'active' or n <> 0 then
    raise exception 'BILLING FAIL [l]: after recovery prev=% status=% failures=%, expected null/active/0',
      v_prev, v_status, n;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (m) The RPC surface the application actually calls.
--
-- This section exists because its absence cost the entire feature. Every engine
-- function lives in schema `app` and is revoked from everyone — correct, they move
-- money — but PostgREST exposes `public` and `graphql_public` ONLY. So each
-- `supabase.rpc("billing_…")` in src/lib/billing/service.ts resolved to no function
-- at all, and the charging path failed at its first statement: raising an invoice,
-- claiming a charge, settling an attempt, listing what was due.
--
-- Nothing caught it. The TypeScript tests mock the Supabase client, so they assert
-- the ARGUMENTS are right and never that the function is reachable; this suite built
-- a database from the migrations and never called it the way the app does; the build
-- compiles a string. It was found by inventorying every rpc() name against pg_proc.
--
-- The names AND the parameter names below are copied from `BILLING_RPC` and its call
-- sites. Parameter names matter as much as the function name: PostgREST resolves by
-- the named arguments in the JSON body, so a rename breaks the call as completely as
-- a deletion. If you change either, change src/lib/billing/service.ts in the same
-- commit — that is the whole point of this section.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  r         record;
  v_oid     oid;
  v_missing text := '';
  v_leaked  text := '';
begin
  raise notice '── BILLING (m): the rpc surface service.ts calls ─────────────────';

  for r in
    select * from (values
      ('billing_due_charges',        'p_limit integer'),
      ('billing_claim_charge',       'p_invoice uuid, p_ref text, p_kind billing_attempt_kind, p_amount bigint'),
      ('billing_settle_attempt',     'p_attempt uuid, p_status billing_attempt_status, p_transaction_id bigint, p_provider_ref text, p_gateway_response text, p_failure_reason text, p_paid_cents bigint, p_channel text'),
      ('billing_generate_invoices',  'p_only uuid'),
      ('billing_start_subscription', 'p_farm uuid, p_plan farm_plan, p_period billing_period, p_trial_days integer'),
      ('billing_receipts_due',         'p_limit integer'),
      ('billing_claim_receipt',        'p_invoice uuid'),
      ('billing_release_receipt',      'p_invoice uuid, p_error text'),
      ('billing_failure_notices_due',  'p_limit integer'),
      ('billing_claim_failure_notice', 'p_attempt uuid')
    ) as t(fn, args)
  loop
    select p.oid into v_oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn
       and pg_get_function_identity_arguments(p.oid) = r.args;

    if v_oid is null then
      v_missing := v_missing || ' public.' || r.fn || '(' || r.args || ')';
    else
      -- Reachable is not the same as open. These raise invoices and record payments;
      -- a farmer's browser holds an `authenticated` JWT and must never call them.
      if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
        v_missing := v_missing || ' service_role EXECUTE on public.' || r.fn;
      end if;
      if has_function_privilege('authenticated', v_oid, 'EXECUTE')
         or has_function_privilege('anon', v_oid, 'EXECUTE') then
        v_leaked := v_leaked || ' ' || r.fn;
      end if;
    end if;
    v_oid := null;
  end loop;

  if v_missing <> '' then
    raise exception 'BILLING FAIL [m]: service.ts calls these and they do not exist:%', v_missing;
  end if;
  if v_leaked <> '' then
    raise exception 'BILLING FAIL [m]: money-moving rpc executable by anon/authenticated:%', v_leaked;
  end if;

  raise notice '   every wrapper service.ts names is present, correctly named, service_role only';
end $$;

-- One live subscription per farm, refused with a sentence rather than a duplicate key.
do $$
declare v_farm uuid := 'b1000000-0000-0000-0000-000000000001'; v_id uuid; v_before bigint;
begin
  select count(*) into v_before from billing_subscriptions where farm_id = v_farm and deleted_at is null;
  if v_before < 1 then
    raise exception 'BILLING FAIL [m]: fixture expected a subscription on farm %, found %', v_farm, v_before;
  end if;

  begin
    v_id := public.billing_start_subscription(v_farm, 'professional', 'monthly', 0);
    raise exception 'BILLING FAIL [m]: a SECOND subscription was created (%) for farm %', v_id, v_farm;
  exception when unique_violation then
    null;   -- the refusal we want
  end;

  if (select count(*) from billing_subscriptions where farm_id = v_farm and deleted_at is null) <> v_before then
    raise exception 'BILLING FAIL [m]: the refused start still changed the subscription count';
  end if;

  raise notice '   a second subscription for the same farm is refused';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (n) The dunning ladder, driven rather than hand-set
--
-- Section (l) proves a downgrade deletes nothing, but it gets there by WRITING
-- `status = 'grace', grace_ends_on = current_date - 1` straight onto the row. So it tests
-- the two ends of the ladder and never the ladder: `app.billing_register_failure` was
-- never called, the retry offsets were never exercised, and no subscription had ever
-- travelled active → past_due → grace under its own power.
--
-- That matters more than the arithmetic sections, because this is the half where the
-- product takes something away from a paying customer. A ladder that fires a rung early
-- narrows a farm's access while their money is still in flight; one that never reaches
-- grace lets a non-payer run for ever. Neither shows up in a total.
--
-- Its own fixture (farm 9), because farms One, Two and Zero are already carrying the
-- arithmetic, the zero-vehicle case and section (l)'s restore.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000009', 'Billing Farm Dunning', 'complete', 'active',
   'monthly', 'dunning@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('b1300000-0000-0000-0000-000000000091', 'b1000000-0000-0000-0000-000000000009',
   'Dunning Tractor', 'tractor', 'hours', 'active', null);

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000009',
   'complete', 'monthly', 'active', current_date, current_date + 29, current_date);

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000009',
   'AUTH_b9synthetic', 'dunning@billing.invalid', 'visa', '9999', '12', '2030',
   true, true, 'active');

update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000009'
 where id = 'b1600000-0000-0000-0000-000000000009';

insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('b1800000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000009',
  'b1600000-0000-0000-0000-000000000009', 'B9-INV-0001', 'draft',
  current_date, current_date + 29, current_date, current_date,
  'complete', 'monthly', 1, 8900, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('b1800000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000009', 0,
  'FleetWise complete — 1 vehicle(s)', 1, 1, 8900, 8900, 8900, 0);

update billing_invoices set status = 'open' where id = 'b1800000-0000-0000-0000-000000000009';

-- ── The four rungs, each measured against the SETTING that produced it ───────
do $$
declare
  v_sub   uuid := 'b1600000-0000-0000-0000-000000000009';
  v_farm  uuid := 'b1000000-0000-0000-0000-000000000009';
  s       public.billing_subscriptions%rowtype;
  v_off   integer[];
  v_grace integer;
  i       integer;
begin
  raise notice '── BILLING (n): the dunning ladder, driven ──────────────────────';

  select retry_offsets_days, grace_days into v_off, v_grace
    from billing_settings where singleton;
  if array_length(v_off, 1) is null or array_length(v_off, 1) < 1 then
    raise exception 'BILLING FAIL [n]: no retry ladder is configured, so this section proves nothing';
  end if;

  -- Each failure inside the ladder must land past_due, count up by exactly one, and set
  -- the retry date from the SETTING at that rung — not from a constant in the function.
  for i in 1 .. array_length(v_off, 1) loop
    perform app.billing_register_failure(v_sub, 'test decline ' || i);
    select * into s from billing_subscriptions where id = v_sub;

    if s.status <> 'past_due' then
      raise exception 'BILLING FAIL [n]: failure % left status %, expected past_due', i, s.status;
    end if;
    if s.failed_attempt_count <> i then
      raise exception 'BILLING FAIL [n]: failure % counted %, expected %',
        i, s.failed_attempt_count, i;
    end if;
    if s.next_retry_on is distinct from (current_date + v_off[i]) then
      raise exception 'BILLING FAIL [n]: failure % set next_retry_on to %, expected % (offset % from settings)',
        i, s.next_retry_on, current_date + v_off[i], v_off[i];
    end if;
    if s.grace_ends_on is not null then
      raise exception 'BILLING FAIL [n]: failure % started the grace clock while retries remain', i;
    end if;

    -- The rung a customer feels: while the retry date is in the future, this invoice must
    -- NOT be offered to a worker. A ladder that keeps charging every night is not a ladder.
    if v_off[i] > 0 and exists (
      select 1 from app.due_billing_charges(50) d
       where d.subscription_id = v_sub
    ) then
      raise exception 'BILLING FAIL [n]: invoice still chargeable at rung % though next_retry_on is %',
        i, s.next_retry_on;
    end if;
  end loop;

  -- One more failure than the ladder has rungs: retries are exhausted, so access continues
  -- on the grace clock rather than being cut the moment a card stops working.
  perform app.billing_register_failure(v_sub, 'test decline final');
  select * into s from billing_subscriptions where id = v_sub;

  if s.status <> 'grace' then
    raise exception 'BILLING FAIL [n]: exhausting the ladder left status %, expected grace', s.status;
  end if;
  if s.next_retry_on is not null then
    raise exception 'BILLING FAIL [n]: grace still carries a retry date (%)', s.next_retry_on;
  end if;
  if s.grace_ends_on is distinct from (current_date + v_grace) then
    raise exception 'BILLING FAIL [n]: grace ends %, expected % (grace_days = % from settings)',
      s.grace_ends_on, current_date + v_grace, v_grace;
  end if;

  -- Grace has NOT expired, so nothing may be taken away yet.
  perform app.billing_apply_downgrades();
  select plan into s.plan from farms where id = v_farm;
  if s.plan <> 'complete' then
    raise exception 'BILLING FAIL [n]: downgraded a farm whose grace has not run out (plan is now %)', s.plan;
  end if;

  raise notice '   % rungs + grace, each date from billing_settings', array_length(v_off, 1);
end $$;

-- ── The ladder follows the POLICY, not a constant ────────────────────────────
-- The offsets and the grace period are configuration (founder decision #9, still
-- PROPOSED). If the engine had them baked in, every assertion above would still pass
-- while the setting on the screen did nothing — the "captured, stored, then ignored"
-- failure this project has already found twice on the partner side.
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000009';
  v_old_off integer[]; v_old_grace integer;
  s public.billing_subscriptions%rowtype;
begin
  select retry_offsets_days, grace_days into v_old_off, v_old_grace
    from billing_settings where singleton;

  update billing_settings set retry_offsets_days = '{1,2}', grace_days = 3 where singleton;
  update billing_subscriptions
     set status = 'active', failed_attempt_count = 0, next_retry_on = null,
         grace_ends_on = null, plan_before_downgrade = null, downgraded_at = null
   where id = v_sub;

  perform app.billing_register_failure(v_sub, 'policy rung 1');
  select * into s from billing_subscriptions where id = v_sub;
  if s.next_retry_on is distinct from (current_date + 1) then
    raise exception 'BILLING FAIL [n]: changed the policy to {1,2} and rung 1 still landed on % (expected %)',
      s.next_retry_on, current_date + 1;
  end if;

  perform app.billing_register_failure(v_sub, 'policy rung 2');
  select * into s from billing_subscriptions where id = v_sub;
  if s.next_retry_on is distinct from (current_date + 2) then
    raise exception 'BILLING FAIL [n]: rung 2 landed on % under policy {1,2} (expected %)',
      s.next_retry_on, current_date + 2;
  end if;

  perform app.billing_register_failure(v_sub, 'policy exhausted');
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'grace' or s.grace_ends_on is distinct from (current_date + 3) then
    raise exception 'BILLING FAIL [n]: a two-rung policy did not reach grace on day 3 (status %, ends %)',
      s.status, s.grace_ends_on;
  end if;

  update billing_settings
     set retry_offsets_days = v_old_off, grace_days = v_old_grace where singleton;

  raise notice '   the ladder reads billing_settings — a shorter policy shortens it';
end $$;

-- ── Grace expiring, and the whole way back ───────────────────────────────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000009';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000009';
  s public.billing_subscriptions%rowtype;
  v_plan farm_plan; v_target farm_plan; n integer;
begin
  select downgrade_to_plan into v_target from billing_settings where singleton;

  update billing_subscriptions
     set status = 'grace', grace_ends_on = current_date - 1, failed_attempt_count = 9
   where id = v_sub;

  n := app.billing_apply_downgrades();
  if n < 1 then
    raise exception 'BILLING FAIL [n]: grace expired and apply_downgrades touched nothing';
  end if;

  select * into s from billing_subscriptions where id = v_sub;
  select plan into v_plan from farms where id = v_farm;

  if v_plan <> v_target then
    raise exception 'BILLING FAIL [n]: effective plan is % after downgrade, expected %', v_plan, v_target;
  end if;
  if s.status <> 'downgraded' then
    raise exception 'BILLING FAIL [n]: subscription status is % after downgrade', s.status;
  end if;
  -- The COMMERCIAL plan must be remembered, or recovery cannot give back what they bought.
  if s.plan <> 'complete' then
    raise exception 'BILLING FAIL [n]: the bought plan was rewritten to % by a downgrade', s.plan;
  end if;
  if s.plan_before_downgrade <> 'complete' then
    raise exception 'BILLING FAIL [n]: plan_before_downgrade is %, so recovery has nothing to restore',
      s.plan_before_downgrade;
  end if;

  -- Paying puts it all back, in one call, with no memory of the failures.
  perform app.billing_restore_after_payment(v_sub);
  select * into s from billing_subscriptions where id = v_sub;
  select plan into v_plan from farms where id = v_farm;

  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [n]: payment did not restore the plan (still %)', v_plan;
  end if;
  if s.status <> 'active' or s.failed_attempt_count <> 0
     or s.next_retry_on is not null or s.grace_ends_on is not null
     or s.plan_before_downgrade is not null then
    raise exception 'BILLING FAIL [n]: after payment status=% failures=% retry=% grace=% prev=%',
      s.status, s.failed_attempt_count, s.next_retry_on, s.grace_ends_on, s.plan_before_downgrade;
  end if;

  raise notice '   grace expired → downgraded → paid → restored, nothing forgotten';
end $$;

-- ── Recovering from the MIDDLE of the ladder, not only from the bottom ───────
-- The likely case: a farmer notices the email at rung two and pays. If restore only
-- worked from `downgraded`, they would keep being chased after settling.
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000009';
  s public.billing_subscriptions%rowtype;
begin
  update billing_subscriptions
     set status = 'active', failed_attempt_count = 0, next_retry_on = null, grace_ends_on = null
   where id = v_sub;

  perform app.billing_register_failure(v_sub, 'mid-ladder');
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'past_due' or s.next_retry_on is null then
    raise exception 'BILLING FAIL [n]: mid-ladder setup did not reach past_due';
  end if;

  perform app.billing_restore_after_payment(v_sub);
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'active' or s.failed_attempt_count <> 0 or s.next_retry_on is not null then
    raise exception 'BILLING FAIL [n]: paying at rung 1 left status=% failures=% retry=%',
      s.status, s.failed_attempt_count, s.next_retry_on;
  end if;

  raise notice '   paying mid-ladder clears the chase, not just the downgrade';
end $$;

-- ── A cancelling subscription comes back non_renewing, not active ────────────
-- Someone who cancelled and then paid an outstanding invoice has settled a debt, not
-- changed their mind. Restoring them to `active` would silently re-subscribe them.
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000009';
  s public.billing_subscriptions%rowtype;
begin
  update billing_subscriptions
     set status = 'past_due', cancel_at_period_end = true, failed_attempt_count = 1
   where id = v_sub;

  perform app.billing_restore_after_payment(v_sub);
  select * into s from billing_subscriptions where id = v_sub;

  if s.status <> 'non_renewing' then
    raise exception 'BILLING FAIL [n]: a cancelling farm that paid came back as %, expected non_renewing',
      s.status;
  end if;

  update billing_subscriptions set cancel_at_period_end = false where id = v_sub;
  raise notice '   paying while cancelling settles the debt without re-subscribing';
end $$;

-- ── Telling them: the failure notice is claimed exactly once ─────────────────
do $$
declare
  v_att uuid := 'b1a10000-0000-0000-0000-000000000009';
  v_first boolean; v_second boolean; n integer;
begin
  insert into billing_payment_attempts (id, farm_id, invoice_id, subscription_id,
    payment_method_id, attempt_ref, kind, status, amount_incl_cents, failure_reason)
  values (v_att, 'b1000000-0000-0000-0000-000000000009',
    'b1800000-0000-0000-0000-000000000009', 'b1600000-0000-0000-0000-000000000009',
    'b1700000-0000-0000-0000-000000000009', 'B9-REF-FAILED', 'charge_authorization',
    'failed', 8900, 'Insufficient funds');

  select count(*) into n from app.billing_failure_notices_due(50) d where d.attempt_id = v_att;
  if n <> 1 then
    raise exception 'BILLING FAIL [n]: a failed attempt is not queued for a notice (found %)', n;
  end if;

  v_first  := app.claim_billing_failure_notice(v_att);
  v_second := app.claim_billing_failure_notice(v_att);
  if not v_first then
    raise exception 'BILLING FAIL [n]: the first claim on a failure notice was refused';
  end if;
  if v_second then
    raise exception 'BILLING FAIL [n]: the SAME failure notice was claimed twice — the farm '
      'would be emailed about one decline more than once';
  end if;

  select count(*) into n from app.billing_failure_notices_due(50) d where d.attempt_id = v_att;
  if n <> 0 then
    raise exception 'BILLING FAIL [n]: a claimed notice is still queued (found %)', n;
  end if;

  raise notice '   one decline, one notice, however many passes run';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (o) The card expires, and somebody is told before it does
--
-- `exp_month`/`exp_year` had been stored since the table was created and read by
-- NOTHING. A card lasts about three years; on the day it stops, the stored authorization
-- fails and the farm is walked down the entire dunning ladder as though they had refused
-- to pay. They did not refuse — nobody told them.
--
-- The arithmetic is the part most likely to be quietly wrong, and wrong by exactly one
-- month: "12/28" on a card means the END of December 2028, not the 1st. A month early and
-- the product nags farmers about cards that are fine; a month late and the warning arrives
-- after the decline it existed to prevent.
-- ═════════════════════════════════════════════════════════════════════════════

-- An owner to notify. Without one `app.notify_farm` writes nothing, and the dedupe
-- assertion below would pass by counting zero against zero.
insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000009', 'billing.owner9@example.invalid');

insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('b1a00000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000009', null,
   'owner', 'Billing Owner Dunning', 'billing.owner9@example.invalid', true);

do $$
declare
  v_d date;
begin
  raise notice '── BILLING (o): card expiry, told before it stops ───────────────';

  -- The LAST day of the printed month, in every shape a provider sends.
  v_d := app.billing_card_expiry_on('12', '2028');
  if v_d is distinct from date '2028-12-31' then
    raise exception 'BILLING FAIL [o]: 12/2028 resolved to %, expected 2028-12-31 (the END of the month)', v_d;
  end if;

  v_d := app.billing_card_expiry_on('02', '2028');
  if v_d is distinct from date '2028-02-29' then
    raise exception 'BILLING FAIL [o]: 02/2028 resolved to % — a leap February is 29 days', v_d;
  end if;

  v_d := app.billing_card_expiry_on('02', '2027');
  if v_d is distinct from date '2027-02-28' then
    raise exception 'BILLING FAIL [o]: 02/2027 resolved to %, expected 2027-02-28', v_d;
  end if;

  -- A two-digit year is the shape printed on the card itself.
  v_d := app.billing_card_expiry_on('12', '28');
  if v_d is distinct from date '2028-12-31' then
    raise exception 'BILLING FAIL [o]: two-digit 12/28 resolved to %, expected 2028-12-31', v_d;
  end if;

  -- A single-digit month, which some providers send unpadded.
  v_d := app.billing_card_expiry_on('3', '2029');
  if v_d is distinct from date '2029-03-31' then
    raise exception 'BILLING FAIL [o]: unpadded 3/2029 resolved to %, expected 2029-03-31', v_d;
  end if;

  -- Provider data is text and may be anything. Unreadable is NULL — a card this engine
  -- says nothing about — never an exception raised inside a 3am cron.
  if app.billing_card_expiry_on('ab', '2028') is not null then
    raise exception 'BILLING FAIL [o]: a non-numeric month produced a date';
  end if;
  if app.billing_card_expiry_on('13', '2028') is not null then
    raise exception 'BILLING FAIL [o]: month 13 produced a date';
  end if;
  if app.billing_card_expiry_on('00', '2028') is not null then
    raise exception 'BILLING FAIL [o]: month 00 produced a date';
  end if;
  if app.billing_card_expiry_on(null, '2028') is not null
     or app.billing_card_expiry_on('12', null) is not null then
    raise exception 'BILLING FAIL [o]: a null part produced a date';
  end if;

  raise notice '   expiry is the last day of the printed month, leap years included';
end $$;

-- ── Who is listed, and who deliberately is not ──────────────────────────────
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000009';
  v_card uuid := 'b1700000-0000-0000-0000-000000000009';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000009';
  v_soon date := (current_date + 20);
  n integer;
begin
  update billing_subscriptions
     set status = 'active', cancel_at_period_end = false, failed_attempt_count = 0,
         next_retry_on = null, grace_ends_on = null
   where id = v_sub;

  -- Far future: nothing to say.
  update billing_payment_methods set exp_month = '12', exp_year = '2099' where id = v_card;
  select count(*) into n from app.billing_cards_expiring(45) c where c.payment_method_id = v_card;
  if n <> 0 then
    raise exception 'BILLING FAIL [o]: warned about a card expiring in 2099';
  end if;

  -- Inside the window.
  update billing_payment_methods
     set exp_month = to_char(v_soon, 'MM'), exp_year = to_char(v_soon, 'YYYY')
   where id = v_card;
  select count(*) into n from app.billing_cards_expiring(45) c where c.payment_method_id = v_card;
  if n <> 1 then
    raise exception 'BILLING FAIL [o]: a card expiring this month is not listed (found %)', n;
  end if;

  -- ALREADY expired still counts. The renewal is going to fail and the farmer needs the
  -- sentence more than ever; a window that only looks forward goes quiet at the worst moment.
  update billing_payment_methods set exp_month = '01', exp_year = '2020' where id = v_card;
  select count(*) into n from app.billing_cards_expiring(45) c where c.payment_method_id = v_card;
  if n <> 1 then
    raise exception 'BILLING FAIL [o]: an ALREADY EXPIRED card dropped out of the list';
  end if;

  -- A cancelled subscription is never charged again, so its card expiring is not news.
  update billing_subscriptions set status = 'cancelled' where id = v_sub;
  select count(*) into n from app.billing_cards_expiring(45) c where c.payment_method_id = v_card;
  if n <> 0 then
    raise exception 'BILLING FAIL [o]: warned a CANCELLED farm about a card nothing will charge';
  end if;
  update billing_subscriptions set status = 'active' where id = v_sub;

  -- A card on file that is not the one that will be charged is not news either.
  update billing_subscriptions set default_payment_method_id = null where id = v_sub;
  select count(*) into n from app.billing_cards_expiring(45) c where c.payment_method_id = v_card;
  if n <> 0 then
    raise exception 'BILLING FAIL [o]: warned about a card that is not the default';
  end if;
  update billing_subscriptions set default_payment_method_id = v_card where id = v_sub;

  raise notice '   expiring and expired listed; cancelled and non-default are not';
end $$;

-- ── Told once, not every night ──────────────────────────────────────────────
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000009';
  n0 bigint; n1 bigint; n2 bigint; v_sent integer;
begin
  select count(*) into n0 from notifications
   where farm_id = v_farm and template = 'billing_card_expiring';

  v_sent := app.enqueue_billing_card_expiry(45);
  select count(*) into n1 from notifications
   where farm_id = v_farm and template = 'billing_card_expiring';

  if n1 <= n0 then
    raise exception 'BILLING FAIL [o]: the engine reported % sent and wrote nothing (% → %)',
      v_sent, n0, n1;
  end if;

  -- The nightly pass runs every night. It must not tell them every night.
  perform app.enqueue_billing_card_expiry(45);
  perform app.enqueue_billing_card_expiry(45);
  select count(*) into n2 from notifications
   where farm_id = v_farm and template = 'billing_card_expiring';

  if n2 <> n1 then
    raise exception 'BILLING FAIL [o]: three passes produced % alerts, expected % — a farmer '
      'told nightly for six weeks stops reading them', n2 - n0, n1 - n0;
  end if;

  raise notice '   one alert per card, however many nights the cron runs';
end $$;

-- ── The renderer knows every template this database emits ──────────────────
-- Four billing templates were being WRITTEN by the dunning engine and rendered by
-- nothing: `formatNotification` ends `default: return template`, so a farmer whose card
-- was declined read the literal string "billing_payment_failed" in their alert centre —
-- the same failure wave 4b found on /reports/schedules, on the one message that most has
-- to be legible.
--
-- SQL cannot call the TypeScript renderer, so this asserts the other half of the contract
-- against real rows rather than by reading function source: every billing notification
-- this database actually PRODUCES must be one of the four the renderer was taught. A
-- fifth template added to an engine without touching format.ts fails right here.
do $$
declare
  v_known text[] := array[
    'billing_payment_failed', 'billing_grace_ending',
    'billing_downgraded', 'billing_card_expiring'
  ];
  v_sub uuid := 'b1600000-0000-0000-0000-000000000009';
  r record; n integer;
begin
  -- Drive the dunning reminder engine too, so this is judged on what BOTH engines emit
  -- rather than only on the card one this section added.
  update billing_subscriptions set status = 'past_due', next_retry_on = current_date + 3
   where id = v_sub;
  perform app.enqueue_billing_reminders();
  update billing_subscriptions set status = 'grace', grace_ends_on = current_date + 7
   where id = v_sub;
  perform app.enqueue_billing_reminders();

  select count(*) into n from notifications where template like 'billing%';
  if n < 2 then
    raise exception 'BILLING FAIL [o]: only % billing notifications exist, so this assertion '
      'would pass without proving anything', n;
  end if;

  for r in select distinct template from notifications where template like 'billing%' loop
    if not (r.template = any (v_known)) then
      raise exception 'BILLING FAIL [o]: this database emits notification template "%" and '
        'src/lib/notifications/format.ts has no case for it — it renders as its own '
        'template name in the farmer''s alert centre', r.template;
    end if;
  end loop;

  update billing_subscriptions
     set status = 'active', grace_ends_on = null, next_retry_on = null where id = v_sub;

  raise notice '   all % billing alerts use a template the renderer knows', n;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (p) A SECOND month. And a third. Driven by the generator alone.
--
-- Every other section in this file, and every staging script used to drive production,
-- hand-wrote `current_period_start` before calling the generator. That is the exact
-- column the defect failed to advance, so priming it made a broken generator look
-- correct: the function read back the value the TEST had supplied instead of the value
-- IT had written, and produced the right answer for the wrong reason.
--
-- What the defect actually did (measured, not reasoned about — three consecutive billing
-- dates, moving only `next_billing_on`):
--
--     run 1  ->  1 invoice   10 Sep .. 09 Oct, next_billing_on 10 Oct
--     run 2  ->  0 invoices  period UNCHANGED, next_billing_on dragged back to today
--     run 3  ->  0 invoices  identical
--
-- Every farm was invoiced ONCE, ever. There is no error and no alert — the function
-- returns 0, which the cron reports as `generate_invoices: ok` — so the only symptom is
-- money that stops arriving, months later, for a customer who is still using the product.
--
-- The clock is advanced here by moving `next_billing_on` and NOTHING else, because that
-- is the only field that really changes when a month passes. The period the generator
-- then chooses must follow `current_period_end + 1`, not the date the cron happened to
-- fire — which is also why the third run below is deliberately three days LATE.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000011', 'Billing Farm Consecutive', 'complete', 'active',
   'monthly', 'consecutive@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000012', 'Billing Farm Consecutive Annual', 'professional',
   'active', 'annual', 'consecutive.annual@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000111', 'b1000000-0000-0000-0000-000000000011',
   'Consecutive Tractor A', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000112', 'b1000000-0000-0000-0000-000000000011',
   'Consecutive Tractor B', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000121', 'b1000000-0000-0000-0000-000000000012',
   'Consecutive Harvester', 'harvester', 'hours', 'active');

-- Exactly the row `app.start_billing_subscription` leaves behind: both period columns
-- NULL, so the first BILLED period begins when billing begins and not on the day somebody
-- pressed a button. Nothing else in this suite starts a subscription from that state.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000011', 'b1000000-0000-0000-0000-000000000011',
   'complete', 'monthly', 'active', null, null, current_date),
  ('b1600000-0000-0000-0000-000000000012', 'b1000000-0000-0000-0000-000000000012',
   'professional', 'annual', 'active', null, null, current_date);

do $$
declare
  v_sub   uuid := 'b1600000-0000-0000-0000-000000000011';
  v_farm  uuid := 'b1000000-0000-0000-0000-000000000011';
  s       public.billing_subscriptions%rowtype;
  inv     public.billing_invoices%rowtype;
  prev    public.billing_invoices%rowtype;
  v_made  integer;
  n       bigint;
  seq0    bigint;
  seq1    bigint;
  i       integer;
begin
  raise notice '── BILLING (p): consecutive periods, generator only ─────────────';

  -- POSITIVE CONTROL. Nothing exists yet, so "a second invoice appeared" cannot be an
  -- artifact of a fixture that already had one.
  select count(*) into n from billing_invoices where farm_id = v_farm;
  if n <> 0 then
    raise exception 'BILLING FAIL [p]: the fixture already carries % invoices', n;
  end if;
  select last_value into seq0 from billing_invoice_ref_seq;

  for i in 1 .. 3 loop
    -- "A month passed." The ONLY faithful change. On run 3 the cron is three days late,
    -- which must shift nothing: a late pass bills the period that was owed, not a
    -- shorter one starting today.
    if i > 1 then
      update billing_subscriptions
         set next_billing_on = current_date - case when i = 3 then 3 else 0 end
       where id = v_sub;
    end if;

    v_made := app.generate_billing_invoices(v_sub);

    if v_made <> 1 then
      raise exception 'BILLING FAIL [p]: billing date % produced % invoices, expected 1. '
        'A generator that recomputes the period from a column it wrote itself bills a farm '
        'once and then silently returns 0 for ever, which the cron reports as healthy.',
        i, v_made;
    end if;

    select count(*) into n from billing_invoices where farm_id = v_farm;
    if n <> i then
      raise exception 'BILLING FAIL [p]: after % billing dates the farm has % invoices', i, n;
    end if;

    select * into inv from billing_invoices
     where farm_id = v_farm order by period_start desc limit 1;
    select * into s from billing_subscriptions where id = v_sub;

    if inv.period_end < inv.period_start then
      raise exception 'BILLING FAIL [p]: invoice % covers a period that ends before it starts (% .. %)',
        inv.invoice_ref, inv.period_start, inv.period_end;
    end if;

    -- The symptom a human would eventually see: the row stuck on "due today" for ever.
    if s.next_billing_on <= current_date then
      raise exception 'BILLING FAIL [p]: after billing date % the subscription is still due on % '
        '(today is %) — it will be reconsidered every night and produce nothing',
        i, s.next_billing_on, current_date;
    end if;
    if s.next_billing_on is distinct from (inv.period_end + 1) then
      raise exception 'BILLING FAIL [p]: next_billing_on is % but the period just billed ends % '
        '— the next charge would not line up with the period it pays for',
        s.next_billing_on, inv.period_end;
    end if;
    if s.current_period_start is distinct from inv.period_start
       or s.current_period_end is distinct from inv.period_end then
      raise exception 'BILLING FAIL [p]: the subscription says % .. % while the invoice it just '
        'raised says % .. %', s.current_period_start, s.current_period_end,
        inv.period_start, inv.period_end;
    end if;

    -- CONTIGUITY. Not merely "a second invoice exists" — the second period must begin the
    -- day after the first ended. A gap is a month nobody is billed for; an overlap is a
    -- month billed twice, and the customer notices that one.
    if prev.id is not null then
      if inv.period_start <> prev.period_end + 1 then
        raise exception 'BILLING FAIL [p]: period % starts % but the previous one ended % — '
          'that is a % day %', i, inv.period_start, prev.period_end,
          abs(inv.period_start - (prev.period_end + 1)),
          case when inv.period_start > prev.period_end + 1 then 'gap' else 'overlap' end;
      end if;
      if inv.invoice_ref = prev.invoice_ref then
        raise exception 'BILLING FAIL [p]: two periods share the invoice number %', inv.invoice_ref;
      end if;
    end if;
    prev := inv;
  end loop;

  -- Same day, asked again: still three. Fixing the advance must not have cost the
  -- idempotence section (f) proves, and the two properties pull in opposite directions.
  if app.generate_billing_invoices(v_sub) <> 0 then
    raise exception 'BILLING FAIL [p]: the generator raised a second invoice for a period '
      'that is not due yet';
  end if;
  select count(*) into n from billing_invoices where farm_id = v_farm;
  if n <> 3 then
    raise exception 'BILLING FAIL [p]: % invoices after a repeat run, expected 3', n;
  end if;

  -- Invoice numbering. Every failed insert inside the generator still burns a value off
  -- the sequence, so the broken version left permanent gaps in the numbers a customer and
  -- an auditor both read — the sequence had reached 3 while exactly one invoice existed.
  select last_value into seq1 from billing_invoice_ref_seq;
  if seq1 - seq0 <> 3 then
    raise exception 'BILLING FAIL [p]: 3 invoices consumed % invoice numbers — the numbering '
      'now has permanent gaps in it', seq1 - seq0;
  end if;

  raise notice '   3 consecutive monthly periods, no gap, no overlap, 3 numbers used';
end $$;

-- ── The same thing on an ANNUAL term, where a lost period costs a year ───────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000012';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000012';
  a      public.billing_invoices%rowtype;
  b      public.billing_invoices%rowtype;
begin
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [p]: the annual subscription raised no first invoice';
  end if;
  select * into a from billing_invoices where farm_id = v_farm;

  update billing_subscriptions set next_billing_on = current_date where id = v_sub;

  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [p]: an annual customer was invoiced once and never again. '
      'On a monthly term that is a month of revenue; here it is a YEAR, and the farm keeps '
      'the product throughout because nothing marks them unpaid.';
  end if;
  select * into b from billing_invoices
   where farm_id = v_farm and id <> a.id;

  if b.period_start <> a.period_end + 1 then
    raise exception 'BILLING FAIL [p]: annual year two starts % but year one ended %',
      b.period_start, a.period_end;
  end if;
  -- Ten months charged for twelve is the annual discount (founder decision, §(0)/(h)).
  -- It has to survive into the SECOND year too, or year two is quietly repriced.
  if b.months_charged <> a.months_charged then
    raise exception 'BILLING FAIL [p]: annual year one charged % months and year two charged % '
      '— the discount does not survive a renewal', a.months_charged, b.months_charged;
  end if;
  if b.unit_price_incl_cents <> a.unit_price_incl_cents then
    raise exception 'BILLING FAIL [p]: year two repriced from % to % without anybody deciding to',
      a.unit_price_incl_cents, b.unit_price_incl_cents;
  end if;

  raise notice '   two consecutive annual terms, contiguous, priced the same';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (q) The other end of the `unknown` guard: something has to let go
--
-- Section (g) proves an `unknown` attempt BLOCKS its invoice, which is exactly right —
-- charging again to find out what happened is how a farm gets billed twice. But nothing
-- in this file proved anything ever UNBLOCKS it, and until this week nothing did: a
-- charge whose request never reached Paystack sat in `unknown` for ever. The reconciler
-- asked, Paystack answered "no such transaction", and the code fell through to
-- "still open" on every pass. The farm was never charged again, never went `past_due`,
-- never got a reminder or a failure email, and looked on every screen like a customer who
-- was paid up. Clearing it needed hand-written SQL against production.
--
-- `src/lib/billing/worker.ts` now settles such an attempt `abandoned`. That is a claim
-- about SQL as much as about TypeScript, and this section is the SQL half: `abandoned`
-- must free the invoice, and — the part that is easy to get wrong — must NOT dun a farm
-- whose card is perfectly good and who has done nothing at all.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000013', 'Billing Farm Ghost', 'complete', 'active',
   'monthly', 'ghost@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000131', 'b1000000-0000-0000-0000-000000000013',
   'Ghost Tractor', 'tractor', 'hours', 'active');

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013',
   'complete', 'monthly', 'active', current_date, current_date + 29, current_date + 30);

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013',
   'AUTH_b13synthetic', 'ghost@billing.invalid', 'visa', '1313', '12', '2030',
   true, true, 'active');

update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000013'
 where id = 'b1600000-0000-0000-0000-000000000013';

insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('b1800000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013',
  'b1600000-0000-0000-0000-000000000013', 'B13-INV-0001', 'draft',
  current_date, current_date + 29, current_date, current_date,
  'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('b1800000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013', 0,
  'FleetWise complete — 1 vehicle(s)', 1, 1, 1234, 1234, 1234, 0);

update billing_invoices set status = 'open' where id = 'b1800000-0000-0000-0000-000000000013';

do $$
declare
  v_inv  uuid := 'b1800000-0000-0000-0000-000000000013';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000013';
  v_att  uuid;
  a      public.billing_payment_attempts%rowtype;
  s0     public.billing_subscriptions%rowtype;
  s1     public.billing_subscriptions%rowtype;
  n      bigint;
begin
  raise notice '── BILLING (q): a jammed unknown can be let go, without dunning ─';

  select * into s0 from billing_subscriptions where id = v_sub;

  -- POSITIVE CONTROL, the same discipline (g) uses: prove the invoice is offered BEFORE
  -- anything blocks it, or every zero below is a statement about an empty queue.
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [q]: the invoice is not chargeable to begin with (% rows)', n;
  end if;

  -- The lost response. We charged, we never heard back, so we do not know whether the
  -- farmer's card was debited.
  v_att := app.claim_billing_charge(v_inv, 'B13-REF-GHOST', 'charge_authorization', 1234);
  if v_att is null then
    raise exception 'BILLING FAIL [q]: the charge could not be claimed';
  end if;
  perform app.settle_billing_attempt(v_att, 'unknown', null, null, null, 'connection reset');

  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [q]: an unknown attempt did not block its invoice (% rows)', n;
  end if;

  -- The reconciler asked Paystack about THAT reference and Paystack answered that it has
  -- never heard of it. No money moved. `abandoned`, deliberately not `failed`.
  perform app.settle_billing_attempt(v_att, 'abandoned', null, null, null,
                                     'Transaction reference not found');

  select * into a from billing_payment_attempts where id = v_att;
  if a.status <> 'abandoned' then
    raise exception 'BILLING FAIL [q]: the attempt is % rather than abandoned', a.status;
  end if;
  if a.resolved_at is null then
    raise exception 'BILLING FAIL [q]: an abandoned attempt has no resolved_at, so it still '
      'reads as in flight to anybody querying the ledger';
  end if;

  -- The farm was not punished for our lost packet. `failed` would have called
  -- `app.billing_register_failure` and started them down the ladder towards a downgrade.
  --
  -- Asserted BEFORE the queue check below, deliberately. `billing_register_failure` also
  -- sets `next_retry_on`, which takes the invoice off the queue as a side effect — so in
  -- the other order a mutant that duns on `abandoned` is caught by the queue assertion
  -- and this one, the one that actually states the property, never fires at all.
  select * into s1 from billing_subscriptions where id = v_sub;
  if s1.status <> s0.status
     or s1.failed_attempt_count <> s0.failed_attempt_count
     or s1.next_retry_on is distinct from s0.next_retry_on
     or s1.grace_ends_on is distinct from s0.grace_ends_on then
    raise exception 'BILLING FAIL [q]: a request that never reached the provider moved the farm '
      'from %/% to %/% — their card is fine and they have done nothing',
      s0.status, s0.failed_attempt_count, s1.status, s1.failed_attempt_count;
  end if;

  -- No money was recorded, because none moved.
  select count(*) into n from billing_payments where invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [q]: closing an attempt invented % payment row(s)', n;
  end if;

  -- THE POINT: the invoice is chargeable again. Without this the farm is never billed
  -- again and nothing anywhere says so.
  select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [q]: after the attempt was closed the invoice is still not '
      'offered for charging (% rows) — it is jammed for ever and the farm silently stops '
      'being billed', n;
  end if;

  -- NEGATIVE CONTROL. The four fields above must be capable of moving, or "unchanged"
  -- was a statement about dunning being broken rather than about `abandoned` being safe.
  v_att := app.claim_billing_charge(v_inv, 'B13-REF-DECLINE', 'charge_authorization', 1234);
  perform app.settle_billing_attempt(v_att, 'failed', null, null, null, 'Insufficient funds');
  select * into s1 from billing_subscriptions where id = v_sub;
  if s1.status <> 'past_due' or s1.failed_attempt_count <> s0.failed_attempt_count + 1 then
    raise exception 'BILLING FAIL [q]: a real decline left the subscription at %/% — the '
      '"abandoned changes nothing" assertion above therefore proves nothing',
      s1.status, s1.failed_attempt_count;
  end if;

  raise notice '   abandoned frees the invoice and leaves the farm alone; failed still duns';
end $$;

do $$ begin raise notice ''; raise notice '════════ BILLING: all sections passed ════════'; end $$;
select 'ALL BILLING SUBSCRIPTION TESTS PASSED' as result;

rollback;
