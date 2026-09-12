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
    'release_billing_failure_notice','invoice_chargeable_now',
    'billing_price_for_subscription','billing_plan_change_quote','change_billing_plan',
    'apply_pending_plan_changes','billing_guard_farm_plan','notify_rr_billing',
    'billing_billable_units','farm_vehicle_allowance','billing_enforce_vehicle_quota',
    'farm_billing_gate','create_pending_signup',
    'billing_quota_change_quote','change_billing_quota','sweep_dormant_signups',
    'billing_reopen_subscription','billing_record_refund'];
  v_cron_fns text[] := array[
    'cron_capture_billing_snapshots','cron_generate_billing_invoices',
    'cron_apply_billing_downgrades','cron_enqueue_billing_reminders',
    'cron_close_billing_cancellations','cron_enqueue_billing_card_expiry',
    'cron_apply_pending_plan_changes','cron_sweep_dormant_signups'];
  -- The wrappers service.ts calls by name. Separate from the cron list because they
  -- exist for a different reason: PostgREST exposes `public` only, so without these the
  -- charging path is unreachable no matter how the `app` functions are granted.
  v_rpc_fns text[] := array[
    'billing_due_charges','billing_claim_charge','billing_settle_attempt',
    'billing_generate_invoices','billing_start_subscription',
    'billing_claim_receipt','billing_release_receipt','billing_claim_failure_notice',
    'billing_receipts_due','billing_failure_notices_due','billing_cards_expiring',
    'billing_release_failure_notice','billing_invoice_chargeable_now',
    'billing_plan_quote','billing_change_plan','billing_notify_rr',
    'farm_vehicle_allowance','farm_billing_gate','billing_create_pending_signup',
    'billing_quota_quote','billing_change_quota','billing_reopen_subscription',
    'billing_record_refund'];
  -- Deliberately executable by a browser session: pure arithmetic, the read-only price
  -- lookup, the date helper, and the predicate the UI needs to decide whether to render
  -- a billing screen at all. None of them can move money or read a credential.
  v_auth_ok text[] := array[
    'ex_vat_cents','vat_of_incl_cents','is_farm_billing_admin','billing_active_price',
    'billing_advance_period','billing_card_expiry_on','billing_price_for_subscription',
    'farm_vehicle_allowance'];
  -- The unscoped app.farm_billing_gate helper is service-only; browser sessions
  -- reach the public wrapper, which checks access to the requested farm first.
  -- Reachable by the service role directly. Everything else in `app` is reached ONLY
  -- through a public.cron_* wrapper — PostgREST exposes `public` alone, so an app schema
  -- function is not callable over REST regardless of its grants.
  v_svc_ok text[] := array[
    'ex_vat_cents','vat_of_incl_cents','is_farm_billing_admin','billing_active_price',
    'billing_advance_period','billable_asset_count','billing_card_expiry_on',
    'billing_price_for_subscription','billing_plan_change_quote',
    'farm_vehicle_allowance','billing_billable_units','farm_billing_gate',
    'billing_reopen_subscription'];
  -- PUBLIC wrappers a signed-in user may call. Until 20260910230000 this list was empty
  -- and did not exist, because every public.billing_* wrapper raises an invoice, settles a
  -- payment or reads a charging credential — a blanket refusal was the whole rule.
  --
  -- A member of this list has to pass all four: it only READS; it is scoped to a farm the
  -- caller can already reach (public.farm_vehicle_allowance filters on app.has_farm_access,
  -- so it cannot be used as a fleet-size oracle for an arbitrary farm id); it returns no
  -- money and no credential; and the screen genuinely needs it, because the alternative is
  -- the UI and the database guard computing the same limit separately and eventually
  -- disagreeing about whether a farmer may add a bakkie.
  v_pub_auth_ok text[] := array['farm_vehicle_allowance', 'farm_billing_gate'];
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
       and not (r.nspname = 'app' and r.proname = any (v_auth_ok))
       and not (r.nspname = 'public' and r.proname = any (v_pub_auth_ok)) then
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
      ('billing_due_charges',        'p_limit integer', false),
      ('billing_claim_charge',       'p_invoice uuid, p_ref text, p_kind billing_attempt_kind, p_amount bigint', false),
      ('billing_settle_attempt',     'p_attempt uuid, p_status billing_attempt_status, p_transaction_id bigint, p_provider_ref text, p_gateway_response text, p_failure_reason text, p_paid_cents bigint, p_channel text, p_dun boolean', false),
      ('billing_generate_invoices',  'p_only uuid', false),
      ('billing_start_subscription', 'p_farm uuid, p_plan farm_plan, p_period billing_period, p_trial_days integer', false),
      ('billing_receipts_due',         'p_limit integer', false),
      ('billing_claim_receipt',        'p_invoice uuid', false),
      ('billing_release_receipt',      'p_invoice uuid, p_error text', false),
      ('billing_failure_notices_due',  'p_limit integer', false),
      ('billing_claim_failure_notice', 'p_attempt uuid', false),
      -- The manual path added by 20260910140000. A SEPARATE function, not a flag on
      -- the automatic one, so the nightly cadence cannot be relaxed by accident.
      ('billing_invoice_chargeable_now', 'p_invoice uuid', false),
      ('billing_plan_quote',  'p_sub uuid, p_plan farm_plan, p_period billing_period', false),
      ('billing_change_plan', 'p_sub uuid, p_plan farm_plan, p_period billing_period', false),
      ('billing_notify_rr',   'p_farm uuid, p_template text, p_payload jsonb', false),
      ('farm_vehicle_allowance', 'p_farm uuid', true),
      ('farm_billing_gate', 'p_farm uuid', true),
      -- The sign-up route runs with the service key: an anonymous visitor has no database
      -- access at all in this product, and a wrapper a browser could call would let anybody
      -- mint farms and owners.
      ('billing_create_pending_signup',
       'p_user uuid, p_email text, p_name text, p_farm_name text, p_plan farm_plan, p_period billing_period, p_quota integer',
       false),
      ('billing_quota_quote',  'p_sub uuid, p_quota integer', false),
      ('billing_change_quota', 'p_sub uuid, p_quota integer', false),
      ('billing_reopen_subscription', 'p_farm uuid, p_by uuid', false),
      -- Recording money we gave back (20260911210000). Service-role only: it writes a
      -- payment row, and a browser that could call it could forge a refund against its
      -- own invoice and make the debt disappear.
      ('billing_record_refund',
       'p_txn_reference text, p_refund_reference text, p_amount_cents bigint, p_at timestamp with time zone',
       false)
    ) as t(fn, args, browser_ok)
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
      -- `anon` is refused for everything, without exception. `authenticated` is refused
      -- for everything that moves money — which is all of these but one. See the
      -- v_pub_auth_ok note in section (j) for the four tests that one had to pass.
      if has_function_privilege('anon', v_oid, 'EXECUTE')
         or (has_function_privilege('authenticated', v_oid, 'EXECUTE') and not r.browser_ok) then
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
  v_gretry integer;
  i       integer;
begin
  raise notice '── BILLING (n): the dunning ladder, driven ──────────────────────';

  select retry_offsets_days, grace_days, grace_retry_days into v_off, v_grace, v_gretry
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
  -- Grace is RETRIED now (founder decision, 2026-09-10; migration 20260910160000). It
  -- used to clear this date and never present the card again, so a farm whose money
  -- simply arrived late was downgraded without ever being asked twice.
  --
  -- Asserted against the SETTING, both ways: 0 means the weekly retry is switched off
  -- and the date must be null, which is the old behaviour exactly. A test that only
  -- knew one of those would pass for a policy nobody chose.
  if v_gretry > 0 then
    if s.next_retry_on is distinct from (current_date + v_gretry) then
      raise exception 'BILLING FAIL [n]: grace set next_retry_on to %, expected % '
        '(grace_retry_days = % from settings) — a card that failed on the 1st very often '
        'works on the 25th, and nothing would ask', s.next_retry_on,
        current_date + v_gretry, v_gretry;
    end if;
  elsif s.next_retry_on is not null then
    raise exception 'BILLING FAIL [n]: grace_retry_days is 0 but grace still carries a retry date (%)', s.next_retry_on;
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
  -- THIS month, not `current_date + 20`. A card expires at the END of its printed month,
  -- so "+20 days" silently means "the end of next month" for most of any given month: run
  -- on the 10th of September it resolved to 30 September (20 days, inside the 45-day
  -- window); run on the 11th it resolved to 31 October (50 days, outside it). The
  -- assertion passed for the first third of the month and failed for the rest, with
  -- nothing about the engine having changed.
  --
  -- The end of the current month is at most 31 days away, so it is always inside the
  -- window whatever day this runs.
  v_soon date := current_date;
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
    'billing_downgraded', 'billing_card_expiring',
    -- Addressed to Rapid Rise rather than the farm (20260910200000).
    'billing_dispute', 'billing_refund'
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


-- ═════════════════════════════════════════════════════════════════════════════
-- (r) Who may be charged, and when — the three ways this ledger got it wrong
--
-- S7  Nothing on the charging path ever looked at the FARM. Every condition in the
--     generator and in the charging shortlist is about the SUBSCRIPTION row, so a farm
--     that had been soft-deleted, suspended or cancelled went on being invoiced every
--     month and charged against its stored card.
--
-- S11 `retryInvoiceCharge` rebuilds the AUTOMATIC shortlist, which carries the retry
--     timer. So after a decline the owner's "Try again" answered "nothing is due" for
--     three days, while the invoice was unpaid and the farm was walking towards a
--     downgrade. And once retries are exhausted the subscription is `grace` and then
--     `downgraded` — neither is in that shortlist, so from that moment the stored card
--     was never presented again by anything at all.
--
-- S5  `app.billing_restore_after_payment` read only `cancel_at_period_end`, so a payment
--     landing after an IMMEDIATE cancellation set the subscription back to `active` with
--     `ended_on` sitting in the past. Exactly what happens when somebody cancels while a
--     charge is in flight — which is the entire premise of the `unknown` state.
--
-- Its own fixture: four farms in four different conditions, because the whole point is
-- that the condition of the FARM is what these functions were not reading.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000014', 'Billing Farm Live',      'complete', 'active',    'monthly', 'live@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000015', 'Billing Farm Suspended', 'complete', 'suspended', 'monthly', 'suspended@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000016', 'Billing Farm Deleted',   'complete', 'active',    'monthly', 'deleted@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000017', 'Billing Farm Ended',     'complete', 'cancelled', 'monthly', 'ended@billing.invalid');

update farms set deleted_at = now() where id = 'b1000000-0000-0000-0000-000000000016';

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000141', 'b1000000-0000-0000-0000-000000000014', 'Live Tractor',      'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000151', 'b1000000-0000-0000-0000-000000000015', 'Suspended Tractor', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000161', 'b1000000-0000-0000-0000-000000000016', 'Deleted Tractor',   'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000171', 'b1000000-0000-0000-0000-000000000017', 'Ended Tractor',     'tractor', 'hours', 'active');

-- All four due today, all four with both period columns NULL — the state
-- `app.start_billing_subscription` leaves and the state the generator selects on.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000014', 'b1000000-0000-0000-0000-000000000014', 'complete', 'monthly', 'active', null, null, current_date),
  ('b1600000-0000-0000-0000-000000000015', 'b1000000-0000-0000-0000-000000000015', 'complete', 'monthly', 'active', null, null, current_date),
  ('b1600000-0000-0000-0000-000000000016', 'b1000000-0000-0000-0000-000000000016', 'complete', 'monthly', 'active', null, null, current_date),
  ('b1600000-0000-0000-0000-000000000017', 'b1000000-0000-0000-0000-000000000017', 'complete', 'monthly', 'active', null, null, current_date);

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000014', 'b1000000-0000-0000-0000-000000000014', 'AUTH_b14', 'live@billing.invalid',      'visa', '1414', '12', '2030', true, true, 'active'),
  ('b1700000-0000-0000-0000-000000000015', 'b1000000-0000-0000-0000-000000000015', 'AUTH_b15', 'suspended@billing.invalid', 'visa', '1515', '12', '2030', true, true, 'active'),
  ('b1700000-0000-0000-0000-000000000016', 'b1000000-0000-0000-0000-000000000016', 'AUTH_b16', 'deleted@billing.invalid',   'visa', '1616', '12', '2030', true, true, 'active'),
  ('b1700000-0000-0000-0000-000000000017', 'b1000000-0000-0000-0000-000000000017', 'AUTH_b17', 'ended@billing.invalid',     'visa', '1717', '12', '2030', true, true, 'active');

update billing_subscriptions s set default_payment_method_id = pm.id
  from billing_payment_methods pm
 where pm.farm_id = s.farm_id
   and s.id in ('b1600000-0000-0000-0000-000000000014','b1600000-0000-0000-0000-000000000015',
                'b1600000-0000-0000-0000-000000000016','b1600000-0000-0000-0000-000000000017');

-- ── S7(a): a farm that has left is not sold another month ───────────────────
do $$
declare
  v_live uuid := 'b1600000-0000-0000-0000-000000000014';
  r record; n bigint;
begin
  raise notice '── BILLING (r): who may be charged, and when ────────────────────';

  -- POSITIVE CONTROL FIRST. If the live farm is not invoiced, every zero below is a
  -- statement about a broken fixture rather than about the gate.
  if app.generate_billing_invoices(v_live) <> 1 then
    raise exception 'BILLING FAIL [r]: the ACTIVE farm was not invoiced, so nothing below proves anything';
  end if;

  for r in
    select * from (values
      ('b1600000-0000-0000-0000-000000000015'::uuid, 'suspended', 'a farm Rapid Rise has suspended'),
      ('b1600000-0000-0000-0000-000000000016'::uuid, 'deleted',   'a farm that has been deleted'),
      ('b1600000-0000-0000-0000-000000000017'::uuid, 'cancelled', 'a farm that has been cancelled')
    ) as t(sub, label, human)
  loop
    n := app.generate_billing_invoices(r.sub);
    if n <> 0 then
      raise exception 'BILLING FAIL [r]: % was invoiced (% raised). Selling another month to '
        'somebody who has left is the one billing mistake a customer certainly notices.',
        r.human, n;
    end if;
  end loop;

  raise notice '   generation: active invoiced, suspended/deleted/cancelled not';
end $$;

-- ── S7(b): and is not charged — with one deliberate exception ───────────────
-- Invoices raised by hand rather than by the generator, because the generator's own
-- invoice falls due `payment_terms_days` from now (7 by default) and so is not yet
-- chargeable. These are dated in the past, which is the state that matters here.
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values
  ('b1800000-0000-0000-0000-000000000014', 'b1000000-0000-0000-0000-000000000014', 'b1600000-0000-0000-0000-000000000014', 'B14-INV-0001', 'draft', current_date - 60, current_date - 31, current_date - 60, current_date, 'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0),
  ('b1800000-0000-0000-0000-000000000015', 'b1000000-0000-0000-0000-000000000015', 'b1600000-0000-0000-0000-000000000015', 'B15-INV-0001', 'draft', current_date - 60, current_date - 31, current_date - 60, current_date, 'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0),
  ('b1800000-0000-0000-0000-000000000016', 'b1000000-0000-0000-0000-000000000016', 'b1600000-0000-0000-0000-000000000016', 'B16-INV-0001', 'draft', current_date - 60, current_date - 31, current_date - 60, current_date, 'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0),
  ('b1800000-0000-0000-0000-000000000017', 'b1000000-0000-0000-0000-000000000017', 'b1600000-0000-0000-0000-000000000017', 'B17-INV-0001', 'draft', current_date - 60, current_date - 31, current_date - 60, current_date, 'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
select i.id, i.farm_id, 0, 'FleetWise complete — 1 vehicle(s)', 1, 1, 1234, 1234, 1234, 0
  from billing_invoices i where i.invoice_ref in ('B14-INV-0001','B15-INV-0001','B16-INV-0001','B17-INV-0001');

update billing_invoices set status = 'open'
 where invoice_ref in ('B14-INV-0001','B15-INV-0001','B16-INV-0001','B17-INV-0001');

do $$
declare r record; n bigint;
begin
  for r in
    select * from (values
      ('b1800000-0000-0000-0000-000000000014'::uuid, 1::bigint, 'an ACTIVE farm must be charged'),
      -- The asymmetry, and it is deliberate. Suspension WITHHOLDS the service; it does
      -- not forgive what has already been supplied and invoiced. A later reader who
      -- "tidies" this into one rule will break one half of it, so both are pinned.
      ('b1800000-0000-0000-0000-000000000015'::uuid, 1::bigint, 'a SUSPENDED farm still owes for the months it had'),
      ('b1800000-0000-0000-0000-000000000016'::uuid, 0::bigint, 'a DELETED farm must never be charged'),
      ('b1800000-0000-0000-0000-000000000017'::uuid, 0::bigint, 'a CANCELLED farm must never be charged')
    ) as t(inv, want, human)
  loop
    select count(*) into n from app.due_billing_charges(50) d where d.invoice_id = r.inv;
    if n <> r.want then
      raise exception 'BILLING FAIL [r]: %; the shortlist returned % row(s), expected %',
        r.human, n, r.want;
    end if;
  end loop;

  raise notice '   charging: active + suspended offered, deleted + cancelled not';
end $$;

-- ── S11: the retry timer paces the MACHINE. It must not refuse a person. ────
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000014';
  v_inv uuid := 'b1800000-0000-0000-0000-000000000014';
  s     public.billing_subscriptions%rowtype;
  v_off integer[];
  auto  bigint; manual bigint;
  i     integer;
begin
  select retry_offsets_days into v_off from billing_settings where singleton;

  -- CONTROL: before any decline, both paths agree. So a later difference is the retry
  -- window and not something incidental about this invoice.
  select count(*) into auto   from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  select count(*) into manual from app.invoice_chargeable_now(v_inv);
  if auto <> 1 or manual <> 1 then
    raise exception 'BILLING FAIL [r]: before any decline the two paths disagree (auto %, manual %)',
      auto, manual;
  end if;

  -- One decline. The machine now waits; the person must not have to.
  perform app.billing_register_failure(v_sub, 'test decline');
  select * into s from billing_subscriptions where id = v_sub;
  if s.next_retry_on is distinct from (current_date + v_off[1]) then
    raise exception 'BILLING FAIL [r]: the decline did not set a retry date, so this proves nothing';
  end if;

  select count(*) into auto   from app.due_billing_charges(50) d where d.invoice_id = v_inv;
  select count(*) into manual from app.invoice_chargeable_now(v_inv);
  if auto <> 0 then
    raise exception 'BILLING FAIL [r]: the nightly pass ignored its own retry window (% rows) — '
      'a ladder that charges every night is not a ladder', auto;
  end if;
  if manual <> 1 then
    raise exception 'BILLING FAIL [r]: after a decline the owner pressing "Try again" is told '
      'nothing is due, for % days, while the invoice is unpaid and the farm is walking '
      'towards a downgrade', v_off[1];
  end if;

  -- Exhaust the ladder into GRACE. This is where the automatic path stops for ever:
  -- `billing_register_failure` sets next_retry_on = null and status = 'grace', and
  -- neither `grace` nor `downgraded` is in the automatic shortlist at all.
  for i in 1 .. array_length(v_off, 1) loop
    perform app.billing_register_failure(v_sub, 'test decline ' || i);
  end loop;
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'grace' then
    raise exception 'BILLING FAIL [r]: the ladder did not reach grace (status %)', s.status;
  end if;

  select count(*) into manual from app.invoice_chargeable_now(v_inv);
  if manual <> 1 then
    raise exception 'BILLING FAIL [r]: a farm in GRACE cannot pay with the card already on '
      'file. That is the most valuable button in this product and it does nothing.';
  end if;

  -- And after the downgrade, which is the state the whole "nothing is deleted, pay and
  -- you get it back" promise is made about. If the card cannot be presented here, that
  -- promise has no mechanism behind it.
  update billing_subscriptions set status = 'downgraded' where id = v_sub;
  select count(*) into manual from app.invoice_chargeable_now(v_inv);
  if manual <> 1 then
    raise exception 'BILLING FAIL [r]: a DOWNGRADED farm cannot pay their way back with the '
      'card on file, so the recovery the downgrade design promises cannot happen';
  end if;

  raise notice '   the person can pay at every rung; the machine still waits its turn';
end $$;

-- ── S11: and the manual path relaxes NOTHING else ───────────────────────────
do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-000000000014';
  v_att uuid;
  n bigint;
begin
  -- "Just try it again" is the perfect way to charge somebody twice. The in-flight
  -- block is the guard, and the manual path must be subject to it exactly as the
  -- nightly pass is.
  v_att := app.claim_billing_charge(v_inv, 'B14-REF-INFLIGHT', 'manual_retry', 1234);
  if v_att is null then
    raise exception 'BILLING FAIL [r]: the manual path could not claim a charge at all';
  end if;

  select count(*) into n from app.invoice_chargeable_now(v_inv);
  if n <> 0 then
    raise exception 'BILLING FAIL [r]: an invoice with an attempt IN FLIGHT is still offered to '
      'the manual path (% rows) — pressing the button twice would charge twice', n;
  end if;

  perform app.settle_billing_attempt(v_att, 'unknown', null, null, null, 'connection reset');
  select count(*) into n from app.invoice_chargeable_now(v_inv);
  if n <> 0 then
    raise exception 'BILLING FAIL [r]: an UNKNOWN attempt no longer blocks the manual path '
      '(% rows). Recovery is verifying that reference, never a fresh charge.', n;
  end if;

  -- A cancelled farm cannot be charged by hand either — the gate is about the farm, not
  -- about which button was pressed.
  select count(*) into n from app.invoice_chargeable_now('b1800000-0000-0000-0000-000000000017');
  if n <> 0 then
    raise exception 'BILLING FAIL [r]: a CANCELLED farm can be charged through the manual path';
  end if;

  perform app.settle_billing_attempt(v_att, 'abandoned', null, null, null, 'reference not found');

  raise notice '   the manual path relaxes the timer and nothing else';
end $$;

-- ── S5: a payment never brings a cancelled subscription back to life ────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000017';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000017';
  s      public.billing_subscriptions%rowtype;
  v_plan farm_plan;
  v_end  date;
begin
  -- The state `setCancellation({immediate:true})` writes, plus a farm mid-ladder and a
  -- plan already taken down by a downgrade — the worst case, and a realistic one: a
  -- farm cancels precisely because they have been downgraded.
  update farms set plan = 'essential' where id = v_farm;
  update billing_subscriptions
     set status = 'cancelled', cancel_at_period_end = false, cancelled_at = now(),
         ended_on = current_date, failed_attempt_count = 3, next_retry_on = current_date + 3,
         grace_ends_on = current_date + 7, plan_before_downgrade = 'complete'
   where id = v_sub;
  select ended_on into v_end from billing_subscriptions where id = v_sub;

  perform app.billing_restore_after_payment(v_sub);

  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'cancelled' then
    raise exception 'BILLING FAIL [r]: a payment resubscribed a farm that had CANCELLED '
      '(status is now %). They would be billed again next month having done nothing — and '
      'this is exactly what happens when somebody cancels while a charge is in flight.',
      s.status;
  end if;
  if s.ended_on is distinct from v_end then
    raise exception 'BILLING FAIL [r]: the cancellation date moved from % to %', v_end, s.ended_on;
  end if;
  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'essential' then
    raise exception 'BILLING FAIL [r]: a cancelled farm was given its old plan back (%)', v_plan;
  end if;
  -- Still tidied up: the row must not sit there claiming a farm that has left is three
  -- payments behind and due a retry next week.
  if s.failed_attempt_count <> 0 or s.next_retry_on is not null or s.grace_ends_on is not null then
    raise exception 'BILLING FAIL [r]: the dunning state was left on a cancelled subscription '
      '(% failures, retry %, grace %)', s.failed_attempt_count, s.next_retry_on, s.grace_ends_on;
  end if;

  -- NEGATIVE CONTROL. The status must be CAPABLE of moving, or the assertion above is a
  -- statement about a function that does nothing.
  update billing_subscriptions
     set status = 'past_due', cancel_at_period_end = false, ended_on = null,
         cancelled_at = null, failed_attempt_count = 2, next_retry_on = current_date + 3,
         plan_before_downgrade = 'complete'
   where id = v_sub;
  perform app.billing_restore_after_payment(v_sub);
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'active' then
    raise exception 'BILLING FAIL [r]: a live past_due subscription was not restored to active '
      '(got %) — the cancelled assertion above therefore proves nothing', s.status;
  end if;
  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [r]: a live farm did not get its plan back on payment (%)', v_plan;
  end if;

  -- And the pre-existing period-end case is untouched: paying while you are cancelling
  -- at period end keeps you cancelling at period end.
  update billing_subscriptions
     set status = 'past_due', cancel_at_period_end = true, ended_on = null
   where id = v_sub;
  perform app.billing_restore_after_payment(v_sub);
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'non_renewing' then
    raise exception 'BILLING FAIL [r]: paying while cancelling at period end gave status %, '
      'expected non_renewing', s.status;
  end if;

  raise notice '   a payment settles the debt; it does not resurrect the subscription';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (s) Two founder decisions, and the code that assumed the opposite of both
--
-- GRACE IS RETRIED. Until 20260910160000, exhausting the retry ladder set
-- `next_retry_on = null` and `app.due_billing_charges` never looked at `grace` at all,
-- so from that moment nothing presented the card again. A farm whose money simply
-- arrived the following week was downgraded without ever being asked twice.
--
-- A PRICE RISE DOES NOT REPRICE EXISTING CUSTOMERS. The generator resolved its price
-- with `app.billing_active_price`, and `billing_price_versions_active_uq` permits one
-- active row per (plan, period) — so publishing a new price necessarily retired the old
-- one and moved EVERY existing farm onto the new figure at their next invoice. Silently:
-- a farmer's debit order would just go up.
--
-- Both are settings-or-data decisions rather than constants, so both are asserted against
-- the thing that produced them. An engine with the policy baked in passes every other
-- assertion in this file while the screen that configures it does nothing.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000020', 'Billing Farm Grace Retry', 'complete', 'active', 'monthly', 'graceretry@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000021', 'Billing Farm Grandfathered', 'complete', 'active', 'monthly', 'grandfathered@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000022', 'Billing Farm New Customer', 'complete', 'active', 'monthly', 'newcustomer@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000201', 'b1000000-0000-0000-0000-000000000020', 'Grace Tractor', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000211', 'b1000000-0000-0000-0000-000000000021', 'Old Price Tractor', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000221', 'b1000000-0000-0000-0000-000000000022', 'New Price Tractor', 'tractor', 'hours', 'active');

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000020', 'b1000000-0000-0000-0000-000000000020', 'complete', 'monthly', 'active', current_date, current_date + 29, current_date + 30),
  ('b1600000-0000-0000-0000-000000000021', 'b1000000-0000-0000-0000-000000000021', 'complete', 'monthly', 'active', null, null, current_date);

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000020', 'b1000000-0000-0000-0000-000000000020', 'AUTH_b20', 'graceretry@billing.invalid', 'visa', '2020', '12', '2030', true, true, 'active');

update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000020'
 where id = 'b1600000-0000-0000-0000-000000000020';

insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('b1800000-0000-0000-0000-000000000020', 'b1000000-0000-0000-0000-000000000020',
  'b1600000-0000-0000-0000-000000000020', 'B20-INV-0001', 'draft',
  current_date - 30, current_date - 1, current_date - 30, current_date - 1,
  'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('b1800000-0000-0000-0000-000000000020', 'b1000000-0000-0000-0000-000000000020', 0,
  'FleetWise complete — 1 vehicle(s)', 1, 1, 1234, 1234, 1234, 0);

update billing_invoices set status = 'open' where id = 'b1800000-0000-0000-0000-000000000020';

-- ── The card is presented again while the farm is in grace ──────────────────
do $$
declare
  v_sub    uuid := 'b1600000-0000-0000-0000-000000000020';
  v_inv    uuid := 'b1800000-0000-0000-0000-000000000020';
  s        public.billing_subscriptions%rowtype;
  v_off    integer[];
  v_gretry integer;
  v_ends   date;
  i        integer;
  n        bigint;
begin
  raise notice '── BILLING (s): grace retries, and a price nobody agreed to ─────';

  select retry_offsets_days, grace_retry_days into v_off, v_gretry
    from billing_settings where singleton;
  if v_gretry <= 0 then
    raise exception 'BILLING FAIL [s]: grace_retry_days is %, so this whole section is a '
      'statement about a switched-off feature', v_gretry;
  end if;

  -- POSITIVE CONTROL: chargeable before anything fails.
  select count(*) into n from app.due_billing_charges(200) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [s]: the invoice is not chargeable to begin with (%)', n;
  end if;

  -- Down the whole ladder, into grace, under its own power.
  for i in 1 .. array_length(v_off, 1) + 1 loop
    perform app.billing_register_failure(v_sub, 'test decline ' || i);
  end loop;
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'grace' then
    raise exception 'BILLING FAIL [s]: the ladder did not reach grace (status %)', s.status;
  end if;
  v_ends := s.grace_ends_on;

  -- Armed, from the setting.
  if s.next_retry_on is distinct from (current_date + v_gretry) then
    raise exception 'BILLING FAIL [s]: grace set next_retry_on to %, expected % (grace_retry_days = %)',
      s.next_retry_on, current_date + v_gretry, v_gretry;
  end if;

  -- But not yet. A ladder that charges every night is not a ladder, and that is as true
  -- in grace as it is on the rungs above it.
  select count(*) into n from app.due_billing_charges(200) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [s]: a farm in grace is chargeable % days early (% rows)',
      v_gretry, n;
  end if;

  -- The retry date arrives. THIS is the assertion the whole change exists for: before
  -- 20260910160000 `grace` was not in the shortlist at all, so this was 0 for ever.
  update billing_subscriptions set next_retry_on = current_date where id = v_sub;
  select count(*) into n from app.due_billing_charges(200) d where d.invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [s]: a farm in GRACE whose retry date has arrived is still '
      'not offered to the charging worker (% rows). Their card is never presented again and '
      'they are downgraded without ever being asked twice.', n;
  end if;

  -- That retry fails too. The date must re-arm, and grace must NOT be extended by it —
  -- three failed retries would otherwise buy three extra weeks of full access.
  --
  -- Grace is AGED five days first, and that is load-bearing. Without it the assertion
  -- cannot fail: a mutant that recomputes `current_date + grace_days` instead of
  -- coalescing produces the identical date, because everything here happens on one day.
  -- Ageing the row is the same move section (p) uses to simulate a month passing — the
  -- only way a test can move a clock it does not control.
  update billing_subscriptions set grace_ends_on = grace_ends_on - 5 where id = v_sub;
  v_ends := (select grace_ends_on from billing_subscriptions where id = v_sub);

  perform app.billing_register_failure(v_sub, 'grace retry declined');
  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'grace' then
    raise exception 'BILLING FAIL [s]: a failed grace retry moved the status to %', s.status;
  end if;
  if s.next_retry_on is distinct from (current_date + v_gretry) then
    raise exception 'BILLING FAIL [s]: a failed grace retry did not re-arm the date (%)',
      s.next_retry_on;
  end if;
  if s.grace_ends_on is distinct from v_ends then
    raise exception 'BILLING FAIL [s]: a failed grace retry pushed grace from % to % — '
      'failing to pay would then buy more time to not pay', v_ends, s.grace_ends_on;
  end if;

  -- Switched OFF, which is what grace_retry_days = 0 means. A null date here must read as
  -- "do not retry", never as "no reason to wait" — the opposite of what it means on a
  -- live subscription, and the reason the two arms of that clause are written separately.
  update billing_subscriptions set next_retry_on = null where id = v_sub;
  select count(*) into n from app.due_billing_charges(200) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [s]: a grace subscription with NO retry date was charged '
      '(% rows) — with grace_retry_days = 0 that is every night, for the whole grace period', n;
  end if;

  -- And a DOWNGRADED farm is still never charged automatically. The ladder has to end
  -- somewhere; from here it is the customer's move, through app.invoice_chargeable_now.
  update billing_subscriptions set status = 'downgraded', next_retry_on = current_date where id = v_sub;
  select count(*) into n from app.due_billing_charges(200) d where d.invoice_id = v_inv;
  if n <> 0 then
    raise exception 'BILLING FAIL [s]: a DOWNGRADED farm is being charged by the nightly pass '
      '(% rows) — the ladder never ends', n;
  end if;
  select count(*) into n from app.invoice_chargeable_now(v_inv);
  if n <> 1 then
    raise exception 'BILLING FAIL [s]: and they cannot pay by hand either (% rows)', n;
  end if;

  raise notice '   grace is retried on its date, not before, and buys no extra time';
end $$;

-- ── A price rise does not reach a farm that already signed up ───────────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000021';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000021';
  v_new  uuid := 'b1500000-0000-0000-0000-000000000009';
  s      public.billing_subscriptions%rowtype;
  inv    public.billing_invoices%rowtype;
  n      bigint;
begin
  -- Invoice one, at today's price.
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [s]: the grandfathering fixture raised no first invoice';
  end if;
  select * into inv from billing_invoices where farm_id = v_farm;
  if inv.unit_price_incl_cents <> 1234 then
    raise exception 'BILLING FAIL [s]: the first invoice was raised at %, expected 1234',
      inv.unit_price_incl_cents;
  end if;

  -- The first invoice PINS the version. `price_version_label` was already being written
  -- and read by nothing; the id is what makes it load-bearing.
  select * into s from billing_subscriptions where id = v_sub;
  if s.price_version_id is distinct from 'b1500000-0000-0000-0000-000000000001'::uuid then
    raise exception 'BILLING FAIL [s]: the first invoice did not pin the price version (%)',
      s.price_version_id;
  end if;

  -- RAPID RISE RAISES ITS PRICES. `billing_price_versions_active_uq` allows one active row
  -- per (plan, period), so publishing a new price necessarily retires the old one — which
  -- is precisely why the old lookup moved every existing customer without being asked to.
  update billing_price_versions set status = 'retired'
   where id = 'b1500000-0000-0000-0000-000000000001';
  insert into billing_price_versions (id, version_label, plan, billing_period,
    per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status)
  values (v_new, 'b1-raised', 'complete', 'monthly', 9999, 1, 0, 'active');

  -- Next month.
  update billing_subscriptions set next_billing_on = current_date where id = v_sub;
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [s]: no second invoice after the price rise';
  end if;
  select * into inv from billing_invoices
   where farm_id = v_farm order by period_start desc limit 1;

  if inv.unit_price_incl_cents <> 1234 then
    raise exception 'BILLING FAIL [s]: an existing farm was repriced from 1234 to % without '
      'anybody deciding to. Their debit order goes up with no notice and no record of a '
      'decision.', inv.unit_price_incl_cents;
  end if;
  if inv.price_version_label <> 'b1-synthetic' then
    raise exception 'BILLING FAIL [s]: the invoice says it was priced at version "%" while '
      'charging the old figure — one of the two is a lie', inv.price_version_label;
  end if;

  -- NEGATIVE CONTROL. The new price must genuinely be live, or "unchanged" above is a
  -- statement about a version nobody activated. A brand-new customer pays 9999.
  insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on)
  values ('b1600000-0000-0000-0000-000000000022', 'b1000000-0000-0000-0000-000000000022',
    'complete', 'monthly', 'active', null, null, current_date);
  if app.generate_billing_invoices('b1600000-0000-0000-0000-000000000022') <> 1 then
    raise exception 'BILLING FAIL [s]: the new customer was not invoiced';
  end if;
  select * into inv from billing_invoices where farm_id = 'b1000000-0000-0000-0000-000000000022';
  if inv.unit_price_incl_cents <> 9999 then
    raise exception 'BILLING FAIL [s]: a NEW customer was charged % rather than the new price '
      '9999 — the grandfathering assertion above therefore proves nothing',
      inv.unit_price_incl_cents;
  end if;

  -- CLEARING the pin must NOT reprice them. This is the case that protects every farm
  -- that existed before pinning did — Rooikoppies on production has a null pin right
  -- now — because the price they have been paying is already recorded on their own
  -- invoices. Pinning them at their next invoice instead would grandfather them onto
  -- whatever is active THEN, so a price rise published tomorrow would still reach every
  -- existing customer exactly once, which is the entire thing this is meant to prevent.
  update billing_subscriptions set price_version_id = null, next_billing_on = current_date
   where id = v_sub;
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [s]: no invoice after the pin was cleared';
  end if;
  select * into inv from billing_invoices
   where farm_id = v_farm order by period_start desc limit 1;
  if inv.unit_price_incl_cents <> 1234 then
    raise exception 'BILLING FAIL [s]: a farm with NO pin was charged % rather than the '
      '1234 its own invoices show it has been paying. Every customer who predates this migration would be moved onto the new price exactly once.', inv.unit_price_incl_cents;
  end if;
  -- And it re-pins from what it charged, so the fallback is needed once and then not.
  select * into s from billing_subscriptions where id = v_sub;
  if s.price_version_id is distinct from 'b1500000-0000-0000-0000-000000000001'::uuid then
    raise exception 'BILLING FAIL [s]: the invoice did not re-pin from the price it actually charged (%)', s.price_version_id;
  end if;

  -- THE DELIBERATE MOVE. A repricing NAMES the version the farm is going onto, because
  -- an absence is not a decision — clearing a field is a strange way to say "put them on
  -- the new price", and it is the shape most likely to happen by accident.
  update billing_subscriptions set price_version_id = v_new, next_billing_on = current_date
   where id = v_sub;
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [s]: no invoice after the farm was repriced';
  end if;
  select * into inv from billing_invoices
   where farm_id = v_farm order by period_start desc limit 1;
  if inv.unit_price_incl_cents <> 9999 then
    raise exception 'BILLING FAIL [s]: naming the new version did not move the farm onto '
      'it (charged %) — so there is no way to reprice anybody at all',
      inv.unit_price_incl_cents;
  end if;

  raise notice '   an existing farm keeps its price; a new one pays the new one';
end $$;

-- ── A pin that no longer fits is not honoured ───────────────────────────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000021';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000021';
  inv    public.billing_invoices%rowtype;
  s      public.billing_subscriptions%rowtype;
begin
  -- The farm moves to professional/annual, whose active synthetic price is 4444 charged
  -- over 10 months. The pin it is carrying is a complete/monthly version: honouring it
  -- would charge a price for a plan the farm is not on, which is worse than repricing.
  update billing_subscriptions
     set plan = 'professional', billing_period = 'annual', next_billing_on = current_date
   where id = v_sub;

  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [s]: no invoice after the plan change';
  end if;
  select * into inv from billing_invoices
   where farm_id = v_farm order by created_at desc, period_start desc limit 1;

  if inv.unit_price_incl_cents <> 4444 or inv.months_charged <> 10 then
    raise exception 'BILLING FAIL [s]: after moving to professional/annual the farm was '
      'charged %c over % months, expected 4444 over 10 — a pin for a plan they are no '
      'longer on was honoured', inv.unit_price_incl_cents, inv.months_charged;
  end if;

  select * into s from billing_subscriptions where id = v_sub;
  if s.price_version_id is distinct from 'b1500000-0000-0000-0000-000000000002'::uuid then
    raise exception 'BILLING FAIL [s]: the subscription was not re-pinned onto the version it '
      'was actually charged (%)', s.price_version_id;
  end if;

  raise notice '   a plan change re-pins rather than charging a price for a plan they left';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (t) Changing plan — two half-controls made into one whole one
--
-- There are two plans on a farm and that is correct: `farms.plan` is EFFECTIVE (every
-- entitlement gate resolves from it) and `billing_subscriptions.plan` is COMMERCIAL (what
-- they bought). Before 20260910180000 there was a screen for each and nothing that moved
-- both, so:
--
--   upgrade through /admin/billing  -> billed Complete, still gated at Professional
--   upgrade through /admin/farms    -> Complete features, still billed Professional
--   downgrade through /admin/billing -> smaller bill, every feature still open
--
-- and no self-serve path at all. The founder's decisions: an upgrade charges the pro-rata
-- difference NOW and switches features on immediately; a downgrade takes effect at period
-- end with no refund and nothing to reverse.
--
-- The fixture uses its own price versions with obviously synthetic round figures, because
-- section (s) leaves the catalogue mid-price-rise and arithmetic that depended on that
-- would be asserting something about another section.
-- ═════════════════════════════════════════════════════════════════════════════

-- Retire what (s) left active for complete/monthly, then seed a clean pair.
update billing_price_versions set status = 'retired'
 where plan = 'complete' and billing_period = 'monthly' and status = 'active';

insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('b1500000-0000-0000-0000-000000000011', 'b1-t', 'professional', 'monthly', 2000, 1, 0, 'active'),
  ('b1500000-0000-0000-0000-000000000012', 'b1-t', 'complete',     'monthly', 4000, 1, 0, 'active'),
  ('b1500000-0000-0000-0000-000000000013', 'b1-t', 'essential',    'monthly', 1000, 1, 0, 'active'),
  ('b1500000-0000-0000-0000-000000000014', 'b1-t', 'done_for_you', 'monthly', 8000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000024', 'Billing Farm Upgrade', 'professional', 'active', 'monthly', 'upgrade@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000025', 'Billing Farm Guarded', 'professional', 'active', 'monthly', 'guarded@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000026', 'Billing Farm Unbilled', 'professional', 'active', 'monthly', 'unbilled@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000241', 'b1000000-0000-0000-0000-000000000024', 'Up A', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000242', 'b1000000-0000-0000-0000-000000000024', 'Up B', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000243', 'b1000000-0000-0000-0000-000000000024', 'Up C', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000251', 'b1000000-0000-0000-0000-000000000025', 'Guard A', 'tractor', 'hours', 'active');

-- Nine days into a thirty-day period: 21 days remain, including today.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, price_version_id) values
  ('b1600000-0000-0000-0000-000000000024', 'b1000000-0000-0000-0000-000000000024',
   'professional', 'monthly', 'active', current_date - 9, current_date + 20, current_date + 21,
   'b1500000-0000-0000-0000-000000000011'),
  ('b1600000-0000-0000-0000-000000000025', 'b1000000-0000-0000-0000-000000000025',
   'professional', 'monthly', 'active', current_date - 9, current_date + 20, current_date + 21,
   'b1500000-0000-0000-0000-000000000011');

-- ── The half that was missing: BOTH plans move, and the money is real ───────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000024';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000024';
  q      record;
  r      jsonb;
  s      public.billing_subscriptions%rowtype;
  inv    public.billing_invoices%rowtype;
  v_plan farm_plan;
  n      bigint;
begin
  raise notice '── BILLING (t): a plan change moves the bill AND the features ───';

  -- The quote, before anything is committed. The screen shows this; the engine must
  -- charge exactly it, or the customer was told one number and billed another.
  select * into q from app.billing_plan_change_quote(v_sub, 'complete', 'monthly');
  if q.kind <> 'upgrade_now' then
    raise exception 'BILLING FAIL [t]: a rank increase on the same term quoted as "%"', q.kind;
  end if;
  if q.days_in_period <> 30 or q.days_remaining <> 21 then
    raise exception 'BILLING FAIL [t]: the quote counted % of % days, expected 21 of 30 '
      '(today counts — somebody upgrading this morning has the whole of today)',
      q.days_remaining, q.days_in_period;
  end if;
  -- (4000 - 2000) x 21/30 = 1400 per vehicle, x 3 vehicles = 4200.
  if q.charge_now_cents <> 4200 then
    raise exception 'BILLING FAIL [t]: the quote is % cents, expected 4200 '
      '((4000-2000) x 21/30 x 3 vehicles)', q.charge_now_cents;
  end if;

  r := app.change_billing_plan(v_sub, 'complete', 'monthly');
  if r->>'applied' <> 'now' then
    raise exception 'BILLING FAIL [t]: an upgrade was not applied immediately (%)', r->>'applied';
  end if;

  -- THE DEFECT. Both of these were half-true before, and which half depended on which
  -- screen the administrator happened to open.
  select * into s from billing_subscriptions where id = v_sub;
  select plan into v_plan from farms where id = v_farm;
  if s.plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: the COMMERCIAL plan is still % — they are not being '
      'billed for what they bought', s.plan;
  end if;
  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: the EFFECTIVE plan is still % — they paid more and '
      'got nothing. Every entitlement gate in the product resolves from farms.plan.', v_plan;
  end if;

  -- The money, and the invoice saying what it is for.
  if (r->>'charged_cents')::bigint <> q.charge_now_cents then
    raise exception 'BILLING FAIL [t]: quoted % and charged % — the screen and the engine '
      'must not disagree', q.charge_now_cents, (r->>'charged_cents')::bigint;
  end if;
  select * into inv from billing_invoices where id = (r->>'invoice_id')::uuid;
  if inv.status <> 'open' then
    raise exception 'BILLING FAIL [t]: the pro-rata invoice is % rather than open', inv.status;
  end if;
  if inv.period_start <> current_date or inv.period_end <> s.current_period_end then
    raise exception 'BILLING FAIL [t]: the pro-rata invoice covers % .. %, expected today .. % '
      '— they have already paid for the earlier part of this period at the old rate',
      inv.period_start, inv.period_end, s.current_period_end;
  end if;
  -- The invoice's own arithmetic. `app.billing_derive_invoice_totals` computes
  -- total = unit x count x months, so a unit price is the only place the rounding can sit
  -- without the document disagreeing with itself.
  if inv.total_incl_cents <> inv.unit_price_incl_cents * inv.asset_count * inv.months_charged then
    raise exception 'BILLING FAIL [t]: the invoice total % is not % x % x %',
      inv.total_incl_cents, inv.unit_price_incl_cents, inv.asset_count, inv.months_charged;
  end if;
  if inv.plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: the pro-rata invoice names plan %', inv.plan;
  end if;

  -- Grandfathering follows them onto the new plan, or their next full invoice would be
  -- priced by a lookup that no longer has an answer.
  if s.price_version_id is distinct from 'b1500000-0000-0000-0000-000000000012'::uuid then
    raise exception 'BILLING FAIL [t]: the upgrade did not re-pin the price version (%)',
      s.price_version_id;
  end if;

  -- Exactly one invoice. An upgrade is not a billing date.
  select count(*) into n from billing_invoices where farm_id = v_farm;
  if n <> 1 then
    raise exception 'BILLING FAIL [t]: an upgrade produced % invoices', n;
  end if;

  raise notice '   upgrade: both plans moved, R42,00 charged for 21 of 30 days';
end $$;

-- ── A downgrade takes nothing away from a period they have paid for ─────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000024';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000024';
  r      jsonb;
  s      public.billing_subscriptions%rowtype;
  v_plan farm_plan;
  n0     bigint; n1 bigint;
begin
  select count(*) into n0 from billing_invoices where farm_id = v_farm;
  select * into s from billing_subscriptions where id = v_sub;

  r := app.change_billing_plan(v_sub, 'professional', 'monthly');
  if r->>'applied' <> 'scheduled' then
    raise exception 'BILLING FAIL [t]: a downgrade was applied immediately (%) — they paid '
      'for this period at the higher plan', r->>'applied';
  end if;
  if (r->>'effective_on')::date <> s.current_period_end + 1 then
    raise exception 'BILLING FAIL [t]: the downgrade lands on %, expected % (the day after '
      'the period they paid for ends)', r->>'effective_on', s.current_period_end + 1;
  end if;

  -- NOTHING moved today.
  select * into s from billing_subscriptions where id = v_sub;
  select plan into v_plan from farms where id = v_farm;
  if s.plan <> 'complete' or v_plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: a scheduled downgrade changed a plan today (% / %)',
      s.plan, v_plan;
  end if;
  if s.pending_plan <> 'professional' or s.pending_plan_on is null then
    raise exception 'BILLING FAIL [t]: the downgrade was not recorded (% on %)',
      s.pending_plan, s.pending_plan_on;
  end if;
  select count(*) into n1 from billing_invoices where farm_id = v_farm;
  if n1 <> n0 then
    raise exception 'BILLING FAIL [t]: a downgrade raised % invoice(s). There is no refund '
      'and no credit note, which is the whole reason it waits for period end.', n1 - n0;
  end if;

  -- The date has not arrived: the cron step must leave it alone.
  if app.apply_pending_plan_changes() <> 0 then
    raise exception 'BILLING FAIL [t]: a scheduled change was applied before its date';
  end if;
  select * into s from billing_subscriptions where id = v_sub;
  if s.plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: the plan moved early';
  end if;

  -- The date arrives.
  update billing_subscriptions set pending_plan_on = current_date where id = v_sub;
  if app.apply_pending_plan_changes() <> 1 then
    raise exception 'BILLING FAIL [t]: the scheduled change did not land on its date — the '
      'farm goes on being billed for a plan they asked to leave';
  end if;
  select * into s from billing_subscriptions where id = v_sub;
  select plan into v_plan from farms where id = v_farm;
  if s.plan <> 'professional' or v_plan <> 'professional' then
    raise exception 'BILLING FAIL [t]: after the scheduled date the plans are % / %',
      s.plan, v_plan;
  end if;
  if s.pending_plan is not null or s.pending_plan_on is not null then
    raise exception 'BILLING FAIL [t]: the pending change was not cleared, so it will be '
      'applied again every night';
  end if;
  -- Re-priced onto the plan they moved to. The version they were grandfathered on belongs
  -- to the plan they left.
  if s.price_version_id is distinct from 'b1500000-0000-0000-0000-000000000011'::uuid then
    raise exception 'BILLING FAIL [t]: the scheduled change did not re-price (%)',
      s.price_version_id;
  end if;

  raise notice '   downgrade: scheduled, nothing taken away, lands on its date';
end $$;

-- ── A term change is scheduled too, in either direction ─────────────────────
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000024';
  r     jsonb;
  s     public.billing_subscriptions%rowtype;
begin
  -- professional/monthly -> professional/annual: the SAME rank. Not a downgrade, and not
  -- something to charge for today either — a term is a commitment, and charging ten months
  -- mid-period would bill for time they have not agreed to yet.
  r := app.change_billing_plan(v_sub, 'professional', 'annual');
  if r->>'applied' <> 'scheduled' then
    raise exception 'BILLING FAIL [t]: a term change was applied immediately (%)', r->>'applied';
  end if;

  -- An UPGRADE supersedes it: asking for more than the thing you asked to give up is
  -- unambiguous about which you meant.
  select * into s from billing_subscriptions where id = v_sub;
  if s.pending_plan is null then
    raise exception 'BILLING FAIL [t]: the term change was not recorded';
  end if;
  -- A DIFFERENT plan on purpose. A second proration for the same farm, window and plan
  -- on the same day is the duplicate charge billing_invoices_proration_uq refuses, and
  -- refusing it is right; this block is about superseding, not about that.
  r := app.change_billing_plan(v_sub, 'done_for_you', 'monthly');
  if r->>'applied' <> 'now' then
    raise exception 'BILLING FAIL [t]: the upgrade did not apply (%)', r->>'applied';
  end if;
  select * into s from billing_subscriptions where id = v_sub;
  if s.pending_plan is not null then
    raise exception 'BILLING FAIL [t]: an upgrade left a pending % change queued behind it, '
      'so the farm would silently drop back later', s.pending_plan;
  end if;

  raise notice '   a term change waits; an upgrade supersedes a queued change';
end $$;

-- ── A farm downgraded for NON-PAYMENT does not buy its features back ────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000025';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000025';
  r      jsonb;
  s      public.billing_subscriptions%rowtype;
  v_plan farm_plan;
begin
  -- The state the dunning engine leaves: the EFFECTIVE plan reduced, and what it held
  -- remembered so payment can restore it exactly.
  update farms set plan = 'essential' where id = v_farm;
  update billing_subscriptions
     set status = 'downgraded', plan_before_downgrade = 'professional', downgraded_at = now()
   where id = v_sub;

  r := app.change_billing_plan(v_sub, 'complete', 'monthly');
  if r->>'applied' <> 'now' then
    raise exception 'BILLING FAIL [t]: the upgrade was refused (%)', r->>'applied';
  end if;

  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'essential' then
    raise exception 'BILLING FAIL [t]: buying an upgrade handed the features back to a farm '
      'that has not paid (plan is now %). This is the one thing adminSetSubscriptionPlan '
      'was right to protect, and it must survive the fix.', v_plan;
  end if;

  select * into s from billing_subscriptions where id = v_sub;
  if s.plan_before_downgrade <> 'complete' then
    raise exception 'BILLING FAIL [t]: the upgrade was not recorded as what they will be '
      'restored to (%) — paying would put them back on the plan they just left', s.plan_before_downgrade;
  end if;

  -- And paying gives them the plan they actually bought, not the one they had before.
  perform app.billing_restore_after_payment(v_sub);
  select plan into v_plan from farms where id = v_farm;
  if v_plan <> 'complete' then
    raise exception 'BILLING FAIL [t]: after paying, the farm is on % rather than the '
      'complete plan it upgraded to', v_plan;
  end if;

  raise notice '   an upgrade while downgraded is remembered, not granted, until they pay';
end $$;

-- ── The second writer is closed ────────────────────────────────────────────
do $$
declare
  v_farm     uuid := 'b1000000-0000-0000-0000-000000000025';
  v_unbilled uuid := 'b1000000-0000-0000-0000-000000000026';
  v_plan     farm_plan;
  v_raised   boolean := false;
begin
  -- /admin/farms/[id] wrote farms.plan straight past billing. Fixing the function is not
  -- enough while that door is open.
  begin
    update farms set plan = 'done_for_you' where id = v_farm;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    select plan into v_plan from farms where id = v_farm;
    raise exception 'BILLING FAIL [t]: a farm with a live subscription had its EFFECTIVE plan '
      'set to % directly, so the bill and the features are now out of step — which is '
      'exactly the defect', v_plan;
  end if;

  -- A farm nobody is billing is untouched. That is Weltevrede, and setting a plan on a
  -- comped or demo account is normal.
  update farms set plan = 'done_for_you' where id = v_unbilled;
  select plan into v_plan from farms where id = v_unbilled;
  if v_plan <> 'done_for_you' then
    raise exception 'BILLING FAIL [t]: the guard blocked a farm with no subscription';
  end if;

  raise notice '   farms.plan cannot be moved past billing, and unbilled farms are free';
end $$;

-- ── Two changes that deliberately charge nothing, and one that is refused ───
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000024';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000024';
  q      record;
  r      jsonb;
  n0     bigint; n1 bigint;
  v_ok   boolean := false;
begin
  -- Put the farm back on professional, one day before the period ends. The remaining
  -- fraction is then 1/30 of R20,00 x 3 = 200 cents... still chargeable. Shrink the fleet
  -- to one vehicle so the prorated delta lands under Paystack's R1,00 floor.
  update billing_subscriptions
     set plan = 'professional', price_version_id = 'b1500000-0000-0000-0000-000000000011',
         current_period_start = current_date - 29, current_period_end = current_date,
         pending_plan = null, pending_billing_period = null, pending_plan_on = null,
         pending_plan_set_at = null
   where id = v_sub;
  update farms set plan = 'professional' where id = v_farm;
  update machines set status = 'sold'
   where id in ('b1300000-0000-0000-0000-000000000242', 'b1300000-0000-0000-0000-000000000243');

  select * into q from app.billing_plan_change_quote(v_sub, 'complete', 'monthly');
  -- (4000-2000) x 1/30 = 67 cents for the single remaining vehicle.
  if q.charge_now_cents >= 100 then
    raise exception 'BILLING FAIL [t]: the fixture does not produce a sub-R1,00 delta (% cents)',
      q.charge_now_cents;
  end if;

  select count(*) into n0 from billing_invoices where farm_id = v_farm;
  r := app.change_billing_plan(v_sub, 'complete', 'monthly');
  select count(*) into n1 from billing_invoices where farm_id = v_farm;

  if r->>'applied' <> 'now' then
    raise exception 'BILLING FAIL [t]: a sub-minimum upgrade was refused rather than applied';
  end if;
  if n1 <> n0 then
    raise exception 'BILLING FAIL [t]: an invoice for % cents was raised. Paystack will not '
      'process it, so it would sit OPEN for ever — and an open invoice blocks the farm''s '
      'next real charge through the in-flight guard. Losing under a rand is cheaper than '
      'jamming somebody''s account.', q.charge_now_cents;
  end if;
  if (r->>'charged_cents')::bigint <> 0 then
    raise exception 'BILLING FAIL [t]: reported charging % with no invoice', r->>'charged_cents';
  end if;

  -- Asking for the plan you are already on is not an error and not a charge.
  r := app.change_billing_plan(v_sub, 'complete', 'monthly');
  if r->>'applied' <> 'no_change' then
    raise exception 'BILLING FAIL [t]: re-selecting the current plan did something (%)',
      r->>'applied';
  end if;

  -- A cancelled subscription is replaced, not changed. Letting a plan change revive one
  -- would reintroduce the S5 resurrection defect by another door.
  update billing_subscriptions set status = 'cancelled', ended_on = current_date where id = v_sub;
  begin
    r := app.change_billing_plan(v_sub, 'done_for_you', 'monthly');
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'BILLING FAIL [t]: a CANCELLED subscription accepted a plan change';
  end if;

  raise notice '   nothing unpayable is ever raised, and an ended subscription is not revived';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (u) Registering for VAT, and a reversal that is not a decline
--
-- S4. `app.billing_force_vat_rate` runs BEFORE INSERT OR UPDATE on billing_invoices and
-- stamps the seller's VAT number onto any row that has none. On an insert that is right.
-- On an UPDATE to an invoice raised BEFORE Rapid Rise registered — every one of which has
-- `seller_vat_number` null by design — it changes a field inside the frozen pricing
-- snapshot, and `c_billing_invoices_freeze` (which sorts after the `a_` guard) raises.
--
-- The cost is not cosmetic. `app.billing_rollup_invoice_payments` updates the invoice when
-- a payment is recorded, so the first payment against any pre-registration invoice after
-- registering aborted the whole transaction — the one that inserted the payment row and
-- settled the attempt. Paystack had the money and FleetWise had nothing.
--
-- §(h2) already asserted that registering restates no historical invoice. It asserted the
-- VALUES and never that a later write to such an invoice survives, which is the gap this
-- section closes.
--
-- And: `mapStatus` folds Paystack's `reversed` into `failed`, correctly — the money came
-- back, so the invoice is not paid. But `failed` is also what starts the dunning ladder,
-- and a reversal is our refund or a chargeback: the customer's card worked perfectly.
-- ═════════════════════════════════════════════════════════════════════════════

-- The first fixture user in this suite who is not attached to a farm. Nothing in
-- billing had ever addressed Rapid Rise before; every alert went to a farm's owners.
insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-00000000000a', 'billing.rr@example.invalid');

insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('b1a00000-0000-0000-0000-00000000000a', null, null, 'rr_admin',
   'Billing Rapid Rise', 'billing.rr@example.invalid', true);

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000030', 'Billing Farm VAT', 'complete', 'active', 'monthly', 'vat@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000301', 'b1000000-0000-0000-0000-000000000030', 'VAT Tractor', 'tractor', 'hours', 'active');

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('b1600000-0000-0000-0000-000000000030', 'b1000000-0000-0000-0000-000000000030',
   'complete', 'monthly', 'active', current_date, current_date + 29, current_date + 30);

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('b1700000-0000-0000-0000-000000000030', 'b1000000-0000-0000-0000-000000000030',
   'AUTH_b30', 'vat@billing.invalid', 'visa', '3030', '12', '2030', true, true, 'active');

update billing_subscriptions set default_payment_method_id = 'b1700000-0000-0000-0000-000000000030'
 where id = 'b1600000-0000-0000-0000-000000000030';

-- Raised while NOT registered: vat_rate_bps 0, seller_vat_number null. That null is the
-- whole problem — it is what the guard reaches for on every later update.
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('b1800000-0000-0000-0000-000000000030', 'b1000000-0000-0000-0000-000000000030',
  'b1600000-0000-0000-0000-000000000030', 'B30-INV-0001', 'draft',
  current_date, current_date + 29, current_date, current_date,
  'complete', 'monthly', 1, 5000, 1, 'b1500000-0000-0000-0000-000000000012', 'b1-t', 0);

insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('b1800000-0000-0000-0000-000000000030', 'b1000000-0000-0000-0000-000000000030', 0,
  'FleetWise complete — 1 vehicle(s)', 1, 1, 5000, 5000, 5000, 0);

update billing_invoices set status = 'open' where id = 'b1800000-0000-0000-0000-000000000030';

do $$
declare
  v_inv  uuid := 'b1800000-0000-0000-0000-000000000030';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000030';
  inv    public.billing_invoices%rowtype;
  v_was_registered boolean;
  v_was_number     text;
  n      bigint;
  v_raised boolean := false;
begin
  raise notice '── BILLING (u): registering for VAT, and a reversal ─────────────';

  select vat_registered, vat_number into v_was_registered, v_was_number
    from billing_settings where singleton;

  select * into inv from billing_invoices where id = v_inv;
  if inv.seller_vat_number is not null or inv.vat_rate_bps <> 0 then
    raise exception 'BILLING FAIL [u]: the fixture is not a pre-registration invoice (% / %)',
      inv.seller_vat_number, inv.vat_rate_bps;
  end if;

  -- RAPID RISE REGISTERS FOR VAT.
  update billing_settings set vat_registered = true, vat_number = '4991234567' where singleton;

  -- The moment that used to abort: recording a payment against that old invoice. The
  -- rollup updates the invoice, the guard stamps the VAT number onto it, and the freeze
  -- raises — taking the payment row and the attempt settlement down with it.
  begin
    insert into billing_payments (farm_id, invoice_id, amount_incl_cents,
      provider, provider_reference, provider_transaction_id, channel)
    values (v_farm, v_inv, 5000, 'paystack', 'B30-PAY-0001', 830000001, 'card');
  exception when others then
    raise exception 'BILLING FAIL [u]: recording a payment against a pre-registration '
      'invoice failed after registering for VAT (%). Paystack has the money; FleetWise '
      'records nothing, and the attempt stays in flight.', sqlerrm;
  end;

  select count(*) into n from billing_payments where invoice_id = v_inv;
  if n <> 1 then
    raise exception 'BILLING FAIL [u]: the payment was not recorded (% rows)', n;
  end if;

  -- And registering restated nothing. §(h2) asserts this for values that are never
  -- written again; this asserts it survives a write.
  select * into inv from billing_invoices where id = v_inv;
  if inv.seller_vat_number is not null then
    raise exception 'BILLING FAIL [u]: an invoice issued before registration now carries the '
      'VAT number % — a customer''s copy from last year would restate itself', inv.seller_vat_number;
  end if;
  if inv.vat_rate_bps <> 0 then
    raise exception 'BILLING FAIL [u]: a pre-registration invoice now charges VAT at %', inv.vat_rate_bps;
  end if;
  if inv.status <> 'paid' then
    raise exception 'BILLING FAIL [u]: the invoice is % rather than paid', inv.status;
  end if;

  -- NEGATIVE CONTROL. The freeze must still bite: skipping the stamp must not have turned
  -- into "the VAT fields on an issued invoice are editable". Making tampering LOUD is that
  -- trigger's entire job.
  begin
    update billing_invoices set vat_rate_bps = 1500 where id = v_inv;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [u]: the VAT rate on an ISSUED invoice was editable — the '
      'guard stopped stamping and took the freeze with it';
  end if;

  -- And the guard still does its job on an INSERT: a new invoice raised now DOES carry
  -- the number. Otherwise "it stopped stamping" would be the whole story.
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values ('b1800000-0000-0000-0000-000000000031', v_farm,
    'b1600000-0000-0000-0000-000000000030', 'B30-INV-0002', 'draft',
    current_date + 30, current_date + 59, current_date + 30, current_date + 30,
    'complete', 'monthly', 1, 5000, 1, 'b1500000-0000-0000-0000-000000000012', 'b1-t', 1500);
  select * into inv from billing_invoices where id = 'b1800000-0000-0000-0000-000000000031';
  if inv.seller_vat_number is distinct from '4991234567' then
    raise exception 'BILLING FAIL [u]: a NEW invoice raised after registering does not carry '
      'the VAT number (%) — the guard has stopped working entirely', inv.seller_vat_number;
  end if;

  -- Put the settings back, so nothing after this inherits a registration this section
  -- invented.
  update billing_settings set vat_registered = v_was_registered, vat_number = v_was_number
   where singleton;

  raise notice '   a payment lands on a pre-registration invoice, and nothing is restated';
end $$;

-- ── A reversal settles the attempt without dunning the customer ─────────────
do $$
declare
  v_inv  uuid := 'b1800000-0000-0000-0000-000000000031';
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000030';
  v_att  uuid;
  s0     public.billing_subscriptions%rowtype;
  s1     public.billing_subscriptions%rowtype;
begin
  update billing_invoices set status = 'open' where id = v_inv;
  select * into s0 from billing_subscriptions where id = v_sub;

  -- The provider says this transaction was REVERSED. The invoice is not paid — that part
  -- is unchanged — but their card worked, and walking them towards a downgrade for a
  -- refund we issued is both wrong and the kind of thing that gets talked about.
  v_att := app.claim_billing_charge(v_inv, 'B30-REF-REVERSED', 'charge_authorization', 5000);
  if v_att is null then
    raise exception 'BILLING FAIL [u]: could not claim a charge to reverse';
  end if;
  perform app.settle_billing_attempt(v_att, 'failed', null, null, null,
                                     'reversed at the provider', null, null, false);

  select * into s1 from billing_subscriptions where id = v_sub;
  if s1.status <> s0.status or s1.failed_attempt_count <> s0.failed_attempt_count
     or s1.next_retry_on is distinct from s0.next_retry_on then
    raise exception 'BILLING FAIL [u]: a REVERSAL walked the farm from %/% to %/% down the '
      'dunning ladder. Their card worked; we sent the money back.',
      s0.status, s0.failed_attempt_count, s1.status, s1.failed_attempt_count;
  end if;

  -- NEGATIVE CONTROL. A real decline must still dun, or the assertion above is a statement
  -- about dunning being broken rather than about the reversal being handled.
  v_att := app.claim_billing_charge(v_inv, 'B30-REF-DECLINE', 'charge_authorization', 5000);
  perform app.settle_billing_attempt(v_att, 'failed', null, null, null, 'Insufficient funds');
  select * into s1 from billing_subscriptions where id = v_sub;
  if s1.status <> 'past_due' or s1.failed_attempt_count <> s0.failed_attempt_count + 1 then
    raise exception 'BILLING FAIL [u]: a real decline left the subscription at %/% — the '
      'reversal assertion above therefore proves nothing',
      s1.status, s1.failed_attempt_count;
  end if;

  raise notice '   a reversal settles the attempt and leaves the customer alone';
end $$;

-- ── Rapid Rise is told when money goes back, or is being taken back ─────────
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000030';
  n0 bigint; n1 bigint; v_sent integer;
begin
  -- A dispute and a refund were `outcome: "ignored"` — recorded in billing_webhook_events,
  -- because every signed delivery is, and then nothing. South Africa gives roughly 48
  -- BUSINESS HOURS to answer a dispute before Paystack accepts it for us and takes the
  -- money out of a payout, so silence is expensive.
  select count(*) into n0 from notifications where template like 'billing_dispute%';

  v_sent := app.notify_rr_billing(v_farm, 'billing_dispute',
    jsonb_build_object('event', 'charge.dispute.create', 'amount_incl_cents', 5000));

  select count(*) into n1 from notifications where template like 'billing_dispute%';
  if v_sent < 1 or n1 <= n0 then
    raise exception 'BILLING FAIL [u]: a dispute alerted % administrator(s) and wrote % rows. '
      'A clock nobody can see is a clock that always runs out.', v_sent, n1 - n0;
  end if;

  -- Addressed to RAPID RISE, not to the farm. A dispute is our problem, and telling the
  -- farmer their payment is disputed is both useless to them and alarming.
  if exists (
    select 1 from notifications n
      join users u on u.id = n.user_id
     where n.template = 'billing_dispute' and u.role <> 'rr_admin'
  ) then
    raise exception 'BILLING FAIL [u]: a dispute alert was addressed to somebody who is not '
      'a Rapid Rise administrator';
  end if;

  -- An event we cannot place against a farm is not an alert: notifications.farm_id is NOT
  -- NULL, so a null farm would raise rather than warn anybody.
  if app.notify_rr_billing(null, 'billing_dispute', '{}'::jsonb) <> 0 then
    raise exception 'BILLING FAIL [u]: an unplaceable event claimed to have alerted somebody';
  end if;

  raise notice '   a dispute reaches Rapid Rise, and only Rapid Rise';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (v) A quota of vehicle slots, and the ceiling that makes it mean something
--
-- Until 20260910230000 billing was purely METERED: count the machines that are not
-- deleted, retired or sold, and charge that many. So the bill moved on its own — add a
-- bakkie in March and March costs R73 more, with nobody having agreed to it and no screen
-- having offered the choice.
--
-- The founder's model is a QUOTA: "how many vehicles?" is answered at sign-up, the price
-- is quoted against that number, and that number is billed until they change it.
--
-- THE RISK IN THIS CHANGE IS NOT THE NEW BEHAVIOUR, IT IS THE OLD ONE. Every subscription
-- that exists when this ships has no quota, and so does every farm an administrator
-- creates. If "no quota" meant "quota of zero" they would all be repriced, or locked out
-- of adding a vehicle, on the night it landed. Half of this section is about that.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000040', 'Billing Farm Quota',    'complete', 'active', 'monthly', 'quota@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000041', 'Billing Farm Metered',  'complete', 'active', 'monthly', 'metered@billing.invalid'),
  ('b1000000-0000-0000-0000-000000000042', 'Billing Farm No Sub',   'complete', 'active', 'monthly', 'nosub@billing.invalid');

-- Farm 40 buys THREE slots and uses two of them.
insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000401', 'b1000000-0000-0000-0000-000000000040', 'Quota Tractor A', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000402', 'b1000000-0000-0000-0000-000000000040', 'Quota Tractor B', 'tractor', 'hours', 'active');

-- Farm 41 is METERED — the shape every pre-existing subscription has — with four vehicles.
insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000411', 'b1000000-0000-0000-0000-000000000041', 'Metered A', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000412', 'b1000000-0000-0000-0000-000000000041', 'Metered B', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000413', 'b1000000-0000-0000-0000-000000000041', 'Metered C', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000414', 'b1000000-0000-0000-0000-000000000041', 'Metered D', 'tractor', 'hours', 'active');

-- Farm 42 has NO subscription row at all — a demo farm, or anyone onboarded before billing.
insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000421', 'b1000000-0000-0000-0000-000000000042', 'No-Sub A', 'tractor', 'hours', 'active');

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, asset_quota) values
  ('b1600000-0000-0000-0000-000000000040', 'b1000000-0000-0000-0000-000000000040',
   'complete', 'monthly', 'active', null, null, current_date, 3),
  ('b1600000-0000-0000-0000-000000000041', 'b1000000-0000-0000-0000-000000000041',
   'complete', 'monthly', 'active', null, null, current_date, null);

-- ── What is billed: the slots bought, not the vehicles counted ──────────────
do $$
declare
  inv   public.billing_invoices%rowtype;
  v_qty integer;
begin
  raise notice '── BILLING (v): a quota of slots, and its ceiling ───────────────';

  -- Farm 40: three slots bought, two vehicles on file. The invoice is for THREE.
  if app.generate_billing_invoices('b1600000-0000-0000-0000-000000000040') <> 1 then
    raise exception 'BILLING FAIL [v]: the quota farm was not invoiced';
  end if;
  select * into inv from billing_invoices where farm_id = 'b1000000-0000-0000-0000-000000000040';
  select app.billable_asset_count('b1000000-0000-0000-0000-000000000040') into v_qty;
  if v_qty <> 2 then
    raise exception 'BILLING FAIL [v]: the fixture has % vehicles, expected 2 — the point is '
      'that the invoice does NOT match this number', v_qty;
  end if;
  if inv.asset_count <> 3 then
    raise exception 'BILLING FAIL [v]: a farm that bought 3 slots and uses 2 was invoiced for % '
      '— they are paying for what they bought, and the invoice has to say so', inv.asset_count;
  end if;
  if inv.total_incl_cents <> 3 * inv.unit_price_incl_cents then
    raise exception 'BILLING FAIL [v]: the total % does not equal 3 x %',
      inv.total_incl_cents, inv.unit_price_incl_cents;
  end if;

  -- Farm 41: NO quota. Metered, exactly as before this migration existed.
  if app.generate_billing_invoices('b1600000-0000-0000-0000-000000000041') <> 1 then
    raise exception 'BILLING FAIL [v]: the metered farm was not invoiced';
  end if;
  select * into inv from billing_invoices where farm_id = 'b1000000-0000-0000-0000-000000000041';
  if inv.asset_count <> 4 then
    raise exception 'BILLING FAIL [v]: a subscription with NO quota was invoiced for % rather '
      'than its 4 counted vehicles. Every subscription that existed before this migration '
      'has a null quota, so this is the assertion that stops the whole customer base being '
      'repriced on the night it ships.', inv.asset_count;
  end if;

  raise notice '   the quota farm is billed 3 of 3; the metered farm is billed its 4';
end $$;

-- ── The ceiling, and everything it must NOT refuse ──────────────────────────
do $$
declare
  v_farm  uuid := 'b1000000-0000-0000-0000-000000000040';
  v_raised boolean;
  n       bigint;
begin
  -- One slot left of three. Filling it must work — a ceiling that refuses the last slot
  -- somebody paid for is worse than no ceiling, because they can see the number.
  begin
    insert into machines (id, farm_id, name, type, meter_type, status) values
      ('b1300000-0000-0000-0000-000000000403', v_farm, 'Quota Tractor C', 'tractor', 'hours', 'active');
  exception when check_violation then
    raise exception 'BILLING FAIL [v]: a farm with 3 slots and 2 vehicles was refused its THIRD. '
      'They are paying for a slot the product will not let them use.';
  end;

  -- And the fourth must not.
  v_raised := false;
  begin
    insert into machines (id, farm_id, name, type, meter_type, status) values
      ('b1300000-0000-0000-0000-000000000404', v_farm, 'One Too Many', 'tractor', 'hours', 'active');
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [v]: a farm with 3 slots took a 4th vehicle. The ceiling is '
      'the only thing making a quota mean anything.';
  end if;

  -- The refusal is in the DATABASE, not in three server actions. That is the whole design
  -- decision: a fourth creation path added later inherits it, and two tabs adding the
  -- fourth vehicle at the same moment cannot race past a check-then-insert.
  select count(*) into n from machines where farm_id = v_farm and deleted_at is null;
  if n <> 3 then
    raise exception 'BILLING FAIL [v]: the farm has % machines after a refused insert', n;
  end if;

  -- A RETIRED machine is not billed, so filing one at the ceiling must be allowed. This is
  -- the direction a naive `count(*) >= quota` gets wrong.
  begin
    insert into machines (id, farm_id, name, type, meter_type, status) values
      ('b1300000-0000-0000-0000-000000000405', v_farm, 'Already Retired', 'tractor', 'hours', 'retired');
  exception when check_violation then
    raise exception 'BILLING FAIL [v]: a farm at its ceiling could not file a RETIRED machine. '
      'It is not billed and does not count, so refusing it charges them for history.';
  end;

  -- But bringing it BACK is an addition, and must be refused like any other.
  v_raised := false;
  begin
    update machines set status = 'active' where id = 'b1300000-0000-0000-0000-000000000405';
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [v]: a retired machine was returned to service on a farm at '
      'its ceiling — the fleet grew by one with nobody paying for it';
  end if;

  -- And an ordinary edit on a full farm must not fail. A ceiling that stops somebody
  -- correcting a registration number is a bug wearing a policy''s clothes.
  begin
    update machines set name = 'Quota Tractor C (renamed)'
     where id = 'b1300000-0000-0000-0000-000000000403';
  exception when check_violation then
    raise exception 'BILLING FAIL [v]: a farm at its ceiling could not EDIT a machine it '
      'already owns. Only the transition into the billable set is an addition.';
  end;

  raise notice '   the 4th is refused, a retired one is not, and editing still works';
end $$;

-- ── All-or-nothing, which is what a CSV import needs ────────────────────────
do $$
declare
  v_farm uuid := 'b1000000-0000-0000-0000-000000000042';
  n0 bigint; n1 bigint; v_raised boolean := false;
begin
  -- Give farm 42 a subscription with two slots and one vehicle already on file, then try
  -- to import three at once. A partial import that stopped at the limit would leave a
  -- farmer believing their fleet was loaded when it was not — worse than a clean refusal.
  insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on, asset_quota)
  values ('b1600000-0000-0000-0000-000000000042', v_farm, 'complete', 'monthly', 'active',
          null, null, current_date + 30, 2);

  select count(*) into n0 from machines where farm_id = v_farm and deleted_at is null;

  begin
    insert into machines (id, farm_id, name, type, meter_type, status) values
      ('b1300000-0000-0000-0000-000000000422', v_farm, 'Import 1', 'tractor', 'hours', 'active'),
      ('b1300000-0000-0000-0000-000000000423', v_farm, 'Import 2', 'tractor', 'hours', 'active'),
      ('b1300000-0000-0000-0000-000000000424', v_farm, 'Import 3', 'tractor', 'hours', 'active');
  exception when check_violation then
    v_raised := true;
  end;

  if not v_raised then
    raise exception 'BILLING FAIL [v]: three vehicles went into one free slot';
  end if;
  select count(*) into n1 from machines where farm_id = v_farm and deleted_at is null;
  if n1 <> n0 then
    raise exception 'BILLING FAIL [v]: a refused import still wrote % row(s). A half-loaded '
      'fleet the farmer believes is complete is worse than a clean refusal.', n1 - n0;
  end if;

  raise notice '   an over-quota import writes nothing at all';
end $$;

-- ── Nobody who was here before is locked out ────────────────────────────────
do $$
declare
  a record;
begin
  -- Farm 41: a subscription with NO quota. It has four vehicles and must be able to add a
  -- fifth, because it never bought a number and nobody ever offered it one.
  begin
    insert into machines (id, farm_id, name, type, meter_type, status) values
      ('b1300000-0000-0000-0000-000000000415', 'b1000000-0000-0000-0000-000000000041',
       'Metered E', 'tractor', 'hours', 'active');
  exception when check_violation then
    raise exception 'BILLING FAIL [v]: a subscription with NO quota was refused a new vehicle. '
      'Every subscription that predates this migration has one, so this is the whole '
      'customer base losing the ability to add a bakkie on the night it ships.';
  end;

  select * into a from app.farm_vehicle_allowance('b1000000-0000-0000-0000-000000000041');
  if a.enforced then
    raise exception 'BILLING FAIL [v]: a subscription with no quota reports an enforced ceiling';
  end if;
  if a.used <> 5 then
    raise exception 'BILLING FAIL [v]: the metered farm reports % vehicles, expected 5', a.used;
  end if;
  -- `remaining` is NULL, deliberately. A caller that read `remaining <= 0` as "blocked"
  -- without checking `enforced` would lock out every grandfathered farm, so the value it
  -- reads must not be a number that happens to look like a limit.
  if a.remaining is not null then
    raise exception 'BILLING FAIL [v]: an unenforced allowance reports remaining = %, which a '
      'caller could read as a limit', a.remaining;
  end if;

  -- And a farm with NO SUBSCRIPTION ROW AT ALL — a demo farm, and every farm an
  -- administrator creates by hand today.
  insert into farms (id, name, plan, status, billing_period, billing_email) values
    ('b1000000-0000-0000-0000-000000000043', 'Billing Farm Bare', 'complete', 'active', 'monthly', 'bare@billing.invalid');
  insert into machines (id, farm_id, name, type, meter_type, status) values
    ('b1300000-0000-0000-0000-000000000431', 'b1000000-0000-0000-0000-000000000043', 'Bare A', 'tractor', 'hours', 'active');

  select * into a from app.farm_vehicle_allowance('b1000000-0000-0000-0000-000000000043');
  if a.enforced or a.quota is not null then
    raise exception 'BILLING FAIL [v]: a farm with no subscription reports an enforced ceiling '
      'of % — every farm onboarded before billing existed would stop being able to add a '
      'vehicle on the day this shipped', a.quota;
  end if;
  if a.used <> 1 then
    raise exception 'BILLING FAIL [v]: the bare farm reports % vehicles, expected 1', a.used;
  end if;

  raise notice '   no quota means no ceiling, for a metered sub and for no sub at all';
end $$;

-- ── The allowance is not a fleet-size oracle ────────────────────────────────
do $$
declare n bigint;
begin
  -- The wrapper is deliberately callable by a signed-in user, so it has to answer only
  -- about farms that user can already reach. Otherwise anybody holding a farm id learns
  -- how many vehicles a competitor runs.
  perform public._t_login('b1a00000-0000-0000-0000-000000000006');   -- Farm Two's owner
  set local role authenticated;

  select count(*) into n from public.farm_vehicle_allowance('b1000000-0000-0000-0000-000000000040');
  if n <> 0 then
    raise exception 'BILLING FAIL [v]: another farm''s owner read the quota farm''s allowance '
      '(% row(s)) — that is a fleet-size oracle for anybody with a farm id', n;
  end if;

  -- POSITIVE CONTROL, and it has to be the SAME caller so that the only thing that differs
  -- is which farm was asked about. Their own farm answers.
  select count(*) into n from public.farm_vehicle_allowance('b1000000-0000-0000-0000-000000000002');
  if n <> 1 then
    raise exception 'BILLING FAIL [v]: the same owner reading their OWN farm got % row(s) — so '
      'the zero above was the function refusing everybody, not isolation working', n;
  end if;

  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', false);

  raise notice '   the allowance answers about your own farm and no other';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (w) A farm that has not paid gets no access. Everybody else is untouched.
--
-- The rule is "a subscription EXISTS and it is pending" — never "there is no active
-- subscription". Weltevrede Boerdery is on production with twelve vehicles and no
-- subscription row at all, and so is every farm onboarded before billing existed, so the
-- second reading would lock out the whole customer base on the day it shipped.
--
-- The other way to get this wrong is subtler and is why `app.farm_billing_gate` is
-- SECURITY DEFINER. The SELECT policy on every billing table is
-- `using (app.is_farm_billing_admin(farm_id))`, so a layout reading the subscription
-- through the CALLER'S client gets a row for an owner and nothing for an operator — and
-- "nothing" reads as "no subscription, therefore fine". A gate that holds for owners and
-- fails open for drivers is worse than no gate, because it looks like it works.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000050', 'Billing Farm Pending', 'professional', 'active', 'monthly', 'pending@billing.invalid');

insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000050', 'pending.owner@billing.invalid'),
  ('b1a00000-0000-0000-0000-000000000051', 'pending.driver@billing.invalid');

insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('b1a00000-0000-0000-0000-000000000050', 'b1000000-0000-0000-0000-000000000050', null,
   'owner', 'Pending Owner', 'pending.owner@billing.invalid', true),
  ('b1a00000-0000-0000-0000-000000000051', 'b1000000-0000-0000-0000-000000000050', null,
   'operator', 'Pending Driver', 'pending.driver@billing.invalid', true);

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, asset_quota) values
  ('b1600000-0000-0000-0000-000000000050', 'b1000000-0000-0000-0000-000000000050',
   'professional', 'monthly', 'pending', null, null, current_date, 5);

do $$
declare v_gate text;
begin
  raise notice '── BILLING (w): no access until somebody has paid ───────────────';

  -- The farm that signed up and has not paid.
  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_gate;
  if v_gate <> 'pending' then
    raise exception 'BILLING FAIL [w]: a farm whose subscription is PENDING reports "%" — it '
      'has paid nothing and would have full access', v_gate;
  end if;

  -- Farm One: a live subscription. Unchanged.
  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000001') into v_gate;
  if v_gate <> 'ok' then
    raise exception 'BILLING FAIL [w]: a farm with a LIVE subscription reports "%"', v_gate;
  end if;

  -- THE ONE THAT MATTERS: no subscription row at all. Every farm that predates billing,
  -- and every farm an administrator creates by hand today.
  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000043') into v_gate;
  if v_gate <> 'ok' then
    raise exception 'BILLING FAIL [w]: a farm with NO subscription row reports "%". That is '
      'Weltevrede and every farm onboarded before billing existed — the entire customer '
      'base locked out on the day this shipped.', v_gate;
  end if;

  raise notice '   pending blocks; live and no-subscription do not';
end $$;

-- ── It answers the same for a driver as for the owner ───────────────────────
do $$
declare v_owner text; v_driver text; v_sub_rows integer;
begin
  -- The layout was going to read `billing_subscriptions` directly. Prove why it must not:
  -- the same query returns a row to the owner and nothing to the operator.
  perform public._t_login('b1a00000-0000-0000-0000-000000000050');
  set local role authenticated;
  select count(*)::integer into v_sub_rows from billing_subscriptions
   where farm_id = 'b1000000-0000-0000-0000-000000000050';
  select public.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_owner;
  reset role;

  if v_sub_rows <> 1 then
    raise exception 'BILLING FAIL [w]: the OWNER cannot read their own subscription (% rows), '
      'so the comparison below proves nothing', v_sub_rows;
  end if;

  perform public._t_login('b1a00000-0000-0000-0000-000000000051');
  set local role authenticated;
  select count(*)::integer into v_sub_rows from billing_subscriptions
   where farm_id = 'b1000000-0000-0000-0000-000000000050';
  select public.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_driver;
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', false);

  -- This is the trap, stated as an assertion rather than a comment: the operator genuinely
  -- cannot see the subscription row.
  if v_sub_rows <> 0 then
    raise exception 'BILLING FAIL [w]: an OPERATOR can read the subscription row (% rows). If '
      'that is now allowed, the SECURITY DEFINER argument in 20260911100000 needs revisiting '
      '— not deleting', v_sub_rows;
  end if;

  -- And yet the gate must answer identically for both, because the farm has not paid and
  -- it is the FARM that is gated, not the person.
  if v_owner <> 'pending' or v_driver <> 'pending' then
    raise exception 'BILLING FAIL [w]: the gate says "%" to the owner and "%" to the driver. '
      'The one that reads "ok" walks straight into a farm that has paid nothing.',
      v_owner, v_driver;
  end if;

  raise notice '   the driver is gated exactly as the owner is, despite seeing no billing row';
end $$;

-- ── And it is not an oracle about farms you cannot reach ────────────────────
do $$
declare v_gate text;
begin
  perform public._t_login('b1a00000-0000-0000-0000-000000000006');   -- Farm Two's owner
  set local role authenticated;

  select public.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_gate;
  if v_gate is not null then
    raise exception 'BILLING FAIL [w]: another farm''s owner learned that farm 50 is "%"', v_gate;
  end if;

  -- POSITIVE CONTROL, same caller, their own farm.
  select public.farm_billing_gate('b1000000-0000-0000-0000-000000000002') into v_gate;
  if v_gate is null then
    raise exception 'BILLING FAIL [w]: the same owner got null for their OWN farm, so the '
      'null above was the function refusing everybody rather than isolation working';
  end if;

  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', false);

  raise notice '   the gate answers about your own farm and no other';
end $$;

-- ── Paying is what opens the door ───────────────────────────────────────────
do $$
declare v_gate text;
begin
  -- The whole point of `pending`: it is a state somebody LEAVES by paying. The activation
  -- path is `app.settle_billing_attempt` marking an invoice paid, which is exercised
  -- end-to-end elsewhere; here it is enough that the gate follows the status.
  update billing_subscriptions set status = 'active'
   where id = 'b1600000-0000-0000-0000-000000000050';

  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_gate;
  if v_gate <> 'ok' then
    raise exception 'BILLING FAIL [w]: a farm that has paid still reports "%" — they would be '
      'charged and then shut out, which is the worst outcome available', v_gate;
  end if;

  raise notice '   activating the subscription opens the farm';
end $$;

-- ── A subscription that was soft-deleted does not gate for ever ─────────────
do $$
declare v_gate text;
begin
  -- Put it back to pending so the block below is measuring the soft-delete and not the
  -- status.
  update billing_subscriptions set status = 'pending'
   where id = 'b1600000-0000-0000-0000-000000000050';
  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_gate;
  if v_gate <> 'pending' then
    raise exception 'BILLING FAIL [w]: the fixture is not pending again (%), so the '
      'soft-delete assertion below would prove nothing', v_gate;
  end if;

  -- Soft-delete is how everything in this product is removed. A gate that ignored
  -- `deleted_at` would leave a farm locked out by a subscription row that no longer counts
  -- for anything else — invoicing, charging and dunning all skip it — with no way to
  -- clear it short of hand-written SQL.
  update billing_subscriptions set deleted_at = now()
   where id = 'b1600000-0000-0000-0000-000000000050';

  select app.farm_billing_gate('b1000000-0000-0000-0000-000000000050') into v_gate;
  if v_gate <> 'ok' then
    raise exception 'BILLING FAIL [w]: a SOFT-DELETED pending subscription still reports "%". '
      'Every other engine skips a deleted row; this one would lock the farm out for ever.',
      v_gate;
  end if;

  update billing_subscriptions set deleted_at = null, status = 'active'
   where id = 'b1600000-0000-0000-0000-000000000050';

  raise notice '   a deleted subscription row stops gating, like every other engine';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (x) Signing up: one transaction, one invoice, and no access until it is paid
--
-- A sign-up writes a farm, an owner, a subscription and its first invoice. Done as four
-- round trips, any failure after the second leaves a farm with no owner or an owner who
-- cannot be invoiced, and nothing to roll back. So it is one function and one transaction.
--
-- The narrow part is the generator. It did not consider `pending` at all, so a new sign-up
-- had nothing to pay. Adding `pending` to the status list on its own would have been worse
-- than leaving it out: the nightly pass would raise an invoice a month, for ever, against
-- every abandoned sign-up. A pending subscription is invoiced ONCE.
-- ═════════════════════════════════════════════════════════════════════════════

insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000060', 'signup.owner@billing.invalid'),
  ('b1a00000-0000-0000-0000-000000000061', 'signup.second@billing.invalid');

do $$
declare
  v_sub   uuid;
  v_farm  uuid;
  inv     public.billing_invoices%rowtype;
  s       public.billing_subscriptions%rowtype;
  u       public.users%rowtype;
  f       public.farms%rowtype;
  v_gate  text;
  n       bigint;
begin
  raise notice '── BILLING (x): the front door ──────────────────────────────────';

  v_sub := app.create_pending_signup(
    'b1a00000-0000-0000-0000-000000000060', 'Signup.Owner@Billing.Invalid ',
    ' Danie Kruger ', '  Kruger Boerdery  ', 'complete', 'monthly', 4);

  select * into s from billing_subscriptions where id = v_sub;
  v_farm := s.farm_id;
  select * into f from farms where id = v_farm;
  select * into u from users where id = 'b1a00000-0000-0000-0000-000000000060';

  -- The farm, the owner and the subscription all exist, and the whitespace a person
  -- actually types has been dealt with rather than stored.
  if f.name <> 'Kruger Boerdery' then
    raise exception 'BILLING FAIL [x]: the farm is named "%" — untrimmed input was stored', f.name;
  end if;
  if u.role <> 'owner' or u.farm_id <> v_farm then
    raise exception 'BILLING FAIL [x]: the signer-up is % on farm %, expected owner on %',
      u.role, u.farm_id, v_farm;
  end if;
  if u.email <> 'signup.owner@billing.invalid' then
    raise exception 'BILLING FAIL [x]: the email was stored as "%" rather than lower-cased', u.email;
  end if;

  -- PENDING, and therefore shut. This is the assertion that stops a farm being usable
  -- before anybody has paid for it.
  if s.status <> 'pending' then
    raise exception 'BILLING FAIL [x]: a brand-new sign-up is "%" — they have paid nothing', s.status;
  end if;
  select app.farm_billing_gate(v_farm) into v_gate;
  if v_gate <> 'pending' then
    raise exception 'BILLING FAIL [x]: the gate says "%" to a farm that has not paid', v_gate;
  end if;

  -- The quota they chose is what they are billed for, not the zero vehicles they have.
  if s.asset_quota <> 4 then
    raise exception 'BILLING FAIL [x]: the subscription bought % slots, expected 4', s.asset_quota;
  end if;
  select count(*) into n from billing_invoices where farm_id = v_farm;
  if n <> 1 then
    raise exception 'BILLING FAIL [x]: a sign-up produced % invoices, expected exactly 1. '
      'With none, beginCheckout refuses and they can never pay.', n;
  end if;
  select * into inv from billing_invoices where farm_id = v_farm;
  if inv.asset_count <> 4 then
    raise exception 'BILLING FAIL [x]: the first invoice is for % vehicles, expected the 4 '
      'they chose — they have no machines yet, so a metered reading would bill them nothing',
      inv.asset_count;
  end if;
  if inv.status <> 'open' or inv.total_incl_cents <= 0 then
    raise exception 'BILLING FAIL [x]: the first invoice is % for %c', inv.status, inv.total_incl_cents;
  end if;

  -- And the price is the CATALOGUE price, not anything the sign-up screen passed in. A
  -- screen quoting one figure while the invoice says another is what makes people stop
  -- trusting a bill.
  declare v_catalogue bigint;
  begin
    select per_vehicle_monthly_incl_cents into v_catalogue
      from app.billing_active_price('complete', 'monthly');
    -- Read from the CATALOGUE rather than hardcoded: earlier sections deliberately retire
    -- and republish this price to test grandfathering, so a literal here would assert the
    -- order sections happen to run in. The property is that the sign-up screen cannot
    -- influence what is charged.
    if v_catalogue is null then
      raise exception 'BILLING FAIL [x]: there is no active complete/monthly price, so the '
        'assertion below would pass for the wrong reason';
    end if;
    if inv.unit_price_incl_cents <> v_catalogue then
      raise exception 'BILLING FAIL [x]: billed %c per vehicle; the active complete/monthly '
        'price is %c. The sign-up screen does not get to decide what is charged.',
        inv.unit_price_incl_cents, v_catalogue;
    end if;
  end;

  raise notice '   farm + owner + pending subscription + one invoice, all or nothing';
end $$;

-- ── A pending sign-up is invoiced ONCE, however many nights pass ────────────
do $$
declare
  v_sub uuid;
  n bigint;
  i integer;
begin
  select id into v_sub from billing_subscriptions
   where farm_id = (select farm_id from users where id = 'b1a00000-0000-0000-0000-000000000060');

  -- Three billing dates arrive and nobody has paid. Without the "only if it has no
  -- invoice" clause, an abandoned sign-up accrues paper for ever against a farm that
  -- cannot even be logged into.
  for i in 1 .. 3 loop
    update billing_subscriptions set next_billing_on = current_date where id = v_sub;
    perform app.generate_billing_invoices(v_sub);
  end loop;

  select count(*) into n from billing_invoices where subscription_id = v_sub;
  if n <> 1 then
    raise exception 'BILLING FAIL [x]: an abandoned sign-up has accrued % invoices. Nobody '
      'can log into that farm to see them, and nothing will ever collect them.', n;
  end if;

  raise notice '   three billing dates, still one invoice';
end $$;

-- ── Paying is what opens it, and then it bills like everybody else ──────────
do $$
declare
  v_sub  uuid;
  v_farm uuid;
  v_inv  uuid;
  v_att  uuid;
  s      public.billing_subscriptions%rowtype;
  v_gate text;
  n      bigint;
begin
  select id, farm_id into v_sub, v_farm from billing_subscriptions
   where farm_id = (select farm_id from users where id = 'b1a00000-0000-0000-0000-000000000060');
  select id into v_inv from billing_invoices where subscription_id = v_sub;

  -- A card, and the payment. Exactly the path hosted checkout takes.
  insert into billing_payment_methods (farm_id, authorization_code, authorization_email,
    card_brand, last4, exp_month, exp_year, reusable, is_default, status)
  values (v_farm, 'AUTH_signup', 'signup.owner@billing.invalid', 'visa', '6060',
          '12', '2030', true, true, 'active');
  update billing_subscriptions s2 set default_payment_method_id = pm.id
    from billing_payment_methods pm where pm.farm_id = v_farm and s2.id = v_sub;

  v_att := app.claim_billing_charge(v_inv, 'SIGNUP-REF-0001', 'initial_checkout',
                                    (select total_incl_cents from billing_invoices where id = v_inv));
  if v_att is null then
    raise exception 'BILLING FAIL [x]: the first payment could not even be claimed';
  end if;
  perform app.settle_billing_attempt(v_att, 'succeeded', 990001, 'SIGNUP-REF-0001',
                                     'Approved', null,
                                     (select total_incl_cents from billing_invoices where id = v_inv),
                                     'card');

  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'active' then
    raise exception 'BILLING FAIL [x]: they paid and the subscription is still "%". They '
      'would be charged and then shut out, which is the worst outcome available.', s.status;
  end if;
  select app.farm_billing_gate(v_farm) into v_gate;
  if v_gate <> 'ok' then
    raise exception 'BILLING FAIL [x]: the farm is still gated after payment ("%")', v_gate;
  end if;

  -- And from here it is an ordinary subscription: the next billing date produces the next
  -- invoice, exactly as section (p) proves for everybody else.
  update billing_subscriptions set next_billing_on = current_date where id = v_sub;
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING FAIL [x]: an activated sign-up did not bill on its next date — '
      'the "invoice a pending subscription once" rule has leaked into the paid state';
  end if;
  select count(*) into n from billing_invoices where subscription_id = v_sub;
  if n <> 2 then
    raise exception 'BILLING FAIL [x]: % invoices after activation and one renewal, expected 2', n;
  end if;

  raise notice '   paying opens the farm, and then it renews like any other';
end $$;

-- ── What it refuses, and what it leaves behind when it does ─────────────────
do $$
declare
  v_farms0 bigint; v_users0 bigint; v_subs0 bigint;
  v_farms1 bigint; v_users1 bigint; v_subs1 bigint;
  v_raised boolean;
begin
  select count(*) into v_farms0 from farms;
  select count(*) into v_users0 from users;
  select count(*) into v_subs0 from billing_subscriptions;

  -- A plan nobody has priced — either bespoke (price on application) or simply not
  -- published yet. Signing somebody up for one produces a farm that can never be invoiced
  -- and therefore never opened: a customer who has paid and cannot get in.
  --
  -- The combination is UNPRICED here on purpose rather than by hoping: earlier sections
  -- seed and retire prices to test grandfathering, so picking a plan and assuming nobody
  -- priced it would make this assertion depend on the order sections happen to run in.
  update billing_price_versions set status = 'retired'
   where plan = 'done_for_you' and billing_period = 'monthly' and status = 'active';
  v_raised := false;
  begin
    perform app.create_pending_signup('b1a00000-0000-0000-0000-000000000061',
      'signup.second@billing.invalid', 'Second', 'Second Farm', 'done_for_you', 'monthly', 2);
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [x]: signed somebody up to a plan with no price';
  end if;

  -- Zero vehicles is not a subscription.
  --
  -- Three independent things refuse this: the guard at the top of create_pending_signup,
  -- `billing_subscriptions_quota_ck`, and — because a zero-vehicle subscription bills
  -- nothing — the generator skipping it and the invoice count failing. That is a good
  -- state to be in, but the three are NOT interchangeable from where the customer sits, so
  -- the message is asserted and not just the refusal: the guard says "choose at least one
  -- vehicle", the fallback says "could not raise the first invoice", and the second is a
  -- sentence about our plumbing offered to somebody who left a field on 0.
  v_raised := false;
  declare v_msg text;
  begin
    begin
      perform app.create_pending_signup('b1a00000-0000-0000-0000-000000000061',
        'signup.second@billing.invalid', 'Second', 'Second Farm', 'complete', 'monthly', 0);
    exception when check_violation then
      v_raised := true;
      v_msg := sqlerrm;
    end;
    if not v_raised then
      raise exception 'BILLING FAIL [x]: signed somebody up for zero vehicles';
    end if;
    if v_msg not like '%at least one vehicle%' then
      raise exception 'BILLING FAIL [x]: zero vehicles was refused with "%" — correct, but by '
        'a later lock. The person picked a number; tell them about the number.', v_msg;
    end if;
  end;

  -- A farm with no name.
  v_raised := false;
  begin
    perform app.create_pending_signup('b1a00000-0000-0000-0000-000000000061',
      'signup.second@billing.invalid', 'Second', '   ', 'complete', 'monthly', 2);
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [x]: signed up a farm with no name';
  end if;

  -- NOTHING was left behind by any of them. This is the whole reason it is one function:
  -- a refusal halfway through must not leave a farm with no owner, or an owner who can
  -- never be invoiced, with no transaction to undo it.
  select count(*) into v_farms1 from farms;
  select count(*) into v_users1 from users;
  select count(*) into v_subs1 from billing_subscriptions;
  if v_farms1 <> v_farms0 or v_users1 <> v_users0 or v_subs1 <> v_subs0 then
    raise exception 'BILLING FAIL [x]: three refused sign-ups left % farm(s), % user(s) and '
      '% subscription(s) behind',
      v_farms1 - v_farms0, v_users1 - v_users0, v_subs1 - v_subs0;
  end if;

  raise notice '   a refused sign-up writes nothing at all';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (y) Buying more slots, giving some back, and clearing up after the ones who never paid
--
-- Buying slots is a plan upgrade with a different noun, so it takes the same answer the
-- founder gave for plans: charge the pro-rata difference immediately. Giving them back is
-- a downgrade and waits for the period they paid for.
--
-- The assertion that matters most is the refusal: a quota BELOW what the farm is actually
-- running cannot be allowed, because the only way to honour it would be to delete three
-- real vehicles, and nothing in this product destroys a farmer's records to make a billing
-- change fit.
-- ═════════════════════════════════════════════════════════════════════════════

insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('b1000000-0000-0000-0000-000000000070', 'Billing Farm Slots', 'complete', 'active', 'monthly', 'slots@billing.invalid');

insert into machines (id, farm_id, name, type, meter_type, status) values
  ('b1300000-0000-0000-0000-000000000701', 'b1000000-0000-0000-0000-000000000070', 'Slot A', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000702', 'b1000000-0000-0000-0000-000000000070', 'Slot B', 'tractor', 'hours', 'active'),
  ('b1300000-0000-0000-0000-000000000703', 'b1000000-0000-0000-0000-000000000070', 'Slot C', 'tractor', 'hours', 'active');

-- A 30-day period, ten days in. Enough remaining for the pro-rata to be a real fraction
-- rather than a rounding accident.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, asset_quota) values
  ('b1600000-0000-0000-0000-000000000070', 'b1000000-0000-0000-0000-000000000070',
   'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20, 5);

do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000070';
  q     record;
  v_unit bigint;
  v_expected bigint;
begin
  raise notice '── BILLING (y): slots bought, slots given back, rows swept ──────';

  -- Five bought, three in use. Going to eight is an increase and is charged now.
  select * into q from app.billing_quota_change_quote(v_sub, 8);
  if q.kind <> 'increase_now' then
    raise exception 'BILLING FAIL [y]: buying more slots reported "%", expected increase_now', q.kind;
  end if;
  if q.current_quota <> 5 or q.new_quota <> 8 or q.in_use <> 3 then
    raise exception 'BILLING FAIL [y]: quote says % -> % with % in use; expected 5 -> 8 with 3',
      q.current_quota, q.new_quota, q.in_use;
  end if;

  -- 30-day period, 10 days gone, so 20 remaining INCLUSIVE of today. The same convention
  -- the plan quote uses, and the reason it is asserted here is that an off-by-one gives
  -- away or overcharges a day on every single upgrade.
  if q.days_in_period <> 30 or q.days_remaining <> 20 then
    raise exception 'BILLING FAIL [y]: % of % days remaining, expected 20 of 30',
      q.days_remaining, q.days_in_period;
  end if;

  select per_vehicle_monthly_incl_cents into v_unit
    from app.billing_price_for_subscription(v_sub);
  v_expected := round(v_unit::numeric * 20 / 30)::bigint * 3;
  if q.charge_now_cents <> v_expected then
    raise exception 'BILLING FAIL [y]: charging %c for 3 extra slots; 20/30 of %c each is %c',
      q.charge_now_cents, v_unit, v_expected;
  end if;

  raise notice '   3 more slots, 20 of 30 days, charged %c', q.charge_now_cents;
end $$;

-- ── It actually happens, and it produces a payable invoice ──────────────────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000070';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000070';
  r      jsonb;
  s      public.billing_subscriptions%rowtype;
  inv    public.billing_invoices%rowtype;
  a      record;
begin
  r := app.change_billing_quota(v_sub, 8);
  if r->>'applied' <> 'now' then
    raise exception 'BILLING FAIL [y]: buying slots was applied as "%"', r->>'applied';
  end if;

  select * into s from billing_subscriptions where id = v_sub;
  if s.asset_quota <> 8 then
    raise exception 'BILLING FAIL [y]: the subscription still has % slots', s.asset_quota;
  end if;

  -- The pro-rata invoice is for the SLOTS ADDED, not the new total: the first five are
  -- already paid for to the end of this period.
  select * into inv from billing_invoices
   where subscription_id = v_sub and kind = 'slots';
  if inv.asset_count <> 3 then
    raise exception 'BILLING FAIL [y]: the pro-rata invoice is for % vehicles, expected the 3 '
      'added — billing all 8 would charge twice for the five already paid', inv.asset_count;
  end if;
  if inv.status <> 'open' then
    raise exception 'BILLING FAIL [y]: the pro-rata invoice is "%" — a draft can never be '
      'paid, and the customer has already been given the slots', inv.status;
  end if;
  if inv.total_incl_cents <> (r->>'charged_cents')::bigint then
    raise exception 'BILLING FAIL [y]: quoted %c and invoiced %c — the screen and the bill '
      'must not disagree', (r->>'charged_cents')::bigint, inv.total_incl_cents;
  end if;

  -- And the ceiling moved with it: the farm can now actually add the vehicles it paid for.
  select * into a from app.farm_vehicle_allowance(v_farm);
  if a.quota <> 8 or a.remaining <> 5 then
    raise exception 'BILLING FAIL [y]: after buying 3 slots the allowance says %/% — they '
      'paid for room they still cannot use', a.remaining, a.quota;
  end if;

  raise notice '   the slots are theirs, the invoice matches the quote, the ceiling moved';
end $$;

-- ── Giving slots back waits, and never goes below the fleet ─────────────────
do $$
declare
  v_sub uuid := 'b1600000-0000-0000-0000-000000000070';
  q     record;
  r     jsonb;
  s     public.billing_subscriptions%rowtype;
  v_raised boolean := false;
begin
  -- Eight bought, three in use. Down to four is allowed, and waits.
  select * into q from app.billing_quota_change_quote(v_sub, 4);
  if q.kind <> 'scheduled' then
    raise exception 'BILLING FAIL [y]: giving slots back reported "%" — they bought this '
      'period and must keep what they paid for', q.kind;
  end if;
  if q.charge_now_cents <> 0 then
    raise exception 'BILLING FAIL [y]: giving slots back charged %c', q.charge_now_cents;
  end if;

  r := app.change_billing_quota(v_sub, 4);
  select * into s from billing_subscriptions where id = v_sub;
  if s.asset_quota <> 8 then
    raise exception 'BILLING FAIL [y]: a reduction took effect immediately (quota is now %) — '
      'they paid for 8 slots to the end of this period', s.asset_quota;
  end if;
  if s.pending_quota <> 4 then
    raise exception 'BILLING FAIL [y]: the reduction was not recorded (pending_quota %)',
      s.pending_quota;
  end if;

  -- BELOW the fleet: refused, and told what to do. Honouring it would need three real
  -- vehicles deleted.
  select * into q from app.billing_quota_change_quote(v_sub, 2);
  if q.kind <> 'unavailable' or q.reason not like '%retire%' then
    raise exception 'BILLING FAIL [y]: asking for fewer slots than vehicles reported "%" (%)',
      q.kind, q.reason;
  end if;
  begin
    perform app.change_billing_quota(v_sub, 2);
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [y]: a farm running 3 vehicles was put on a 2-slot plan';
  end if;

  -- Asking for MORE cancels a reduction they had scheduled: wanting more than the number
  -- you asked to give up is unambiguous about which you meant.
  perform app.change_billing_quota(v_sub, 9);
  select * into s from billing_subscriptions where id = v_sub;
  if s.pending_quota is not null then
    raise exception 'BILLING FAIL [y]: buying more left a reduction to % still scheduled',
      s.pending_quota;
  end if;

  raise notice '   a reduction waits, is refused below the fleet, and is cancelled by an increase';
end $$;

-- ── The scheduled reduction lands, and is re-checked against the fleet ──────
do $$
declare
  v_sub  uuid := 'b1600000-0000-0000-0000-000000000070';
  v_farm uuid := 'b1000000-0000-0000-0000-000000000070';
  s      public.billing_subscriptions%rowtype;
begin
  -- Schedule a drop to 4, then let the farm grow to 6 vehicles before it lands — which is
  -- exactly what a month is for. Applying the scheduled number blind would put the
  -- subscription below its own fleet and make the ceiling refuse vehicles that are
  -- already there.
  update billing_subscriptions
     set pending_quota = 4, pending_quota_on = current_date, pending_quota_set_at = now()
   where id = v_sub;
  insert into machines (id, farm_id, name, type, meter_type, status) values
    ('b1300000-0000-0000-0000-000000000704', v_farm, 'Slot D', 'tractor', 'hours', 'active'),
    ('b1300000-0000-0000-0000-000000000705', v_farm, 'Slot E', 'tractor', 'hours', 'active'),
    ('b1300000-0000-0000-0000-000000000706', v_farm, 'Slot F', 'tractor', 'hours', 'active');

  perform app.apply_pending_plan_changes();

  select * into s from billing_subscriptions where id = v_sub;
  if s.pending_quota is not null then
    raise exception 'BILLING FAIL [y]: the scheduled reduction did not land';
  end if;
  if s.asset_quota <> 6 then
    raise exception 'BILLING FAIL [y]: the reduction landed at % with 6 vehicles on the farm. '
      'Below the fleet means the ceiling now refuses vehicles that already exist.',
      s.asset_quota;
  end if;

  raise notice '   the reduction lands at the fleet size, not below it';
end $$;

-- ── Sweeping a sign-up nobody finished ──────────────────────────────────────
insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000080', 'dormant@billing.invalid'),
  ('b1a00000-0000-0000-0000-000000000081', 'paid.up@billing.invalid');

do $$
declare
  v_dormant uuid;
  v_paid    uuid;
  v_farm_d  uuid;
  v_inv     uuid;
  s         public.billing_subscriptions%rowtype;
  f         public.farms%rowtype;
  u         public.users%rowtype;
  i         public.billing_invoices%rowtype;
  n         integer;
begin
  v_dormant := app.create_pending_signup('b1a00000-0000-0000-0000-000000000080',
    'dormant@billing.invalid', 'Never Paid', 'Dormant Boerdery', 'complete', 'monthly', 3);
  v_paid := app.create_pending_signup('b1a00000-0000-0000-0000-000000000081',
    'paid.up@billing.invalid', 'Part Paid', 'Part Paid Boerdery', 'complete', 'monthly', 2);

  -- Too new to sweep. A sign-up abandoned this morning may well be somebody finishing
  -- their coffee.
  n := app.sweep_dormant_signups(7);
  if n <> 0 then
    raise exception 'BILLING FAIL [y]: swept % sign-up(s) that are minutes old', n;
  end if;

  -- Age them both, and put a payment against one. Somebody who has paid ANYTHING is a
  -- conversation, not a dormant row, however long they have sat there.
  update billing_subscriptions set created_at = now() - interval '30 days'
   where id in (v_dormant, v_paid);
  select id into v_inv from billing_invoices where subscription_id = v_paid;
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider,
                                provider_reference, provider_transaction_id, channel)
  select farm_id, v_inv, 100, 'paystack', 'PART-PAY-Y', 880000001, 'card'
    from billing_invoices where id = v_inv;

  n := app.sweep_dormant_signups(7);
  if n <> 1 then
    raise exception 'BILLING FAIL [y]: swept % sign-up(s), expected exactly the unpaid one', n;
  end if;

  -- The paid one is untouched.
  select * into s from billing_subscriptions where id = v_paid;
  if s.deleted_at is not null or s.status <> 'pending' then
    raise exception 'BILLING FAIL [y]: a sign-up that had PAID something was swept';
  end if;

  -- And the dormant one is soft-deleted everywhere, with nothing destroyed.
  select farm_id into v_farm_d from billing_subscriptions where id = v_dormant;
  select * into s from billing_subscriptions where id = v_dormant;
  select * into f from farms where id = v_farm_d;
  select * into u from users where id = 'b1a00000-0000-0000-0000-000000000080';
  select * into i from billing_invoices where subscription_id = v_dormant;

  if s.deleted_at is null or f.deleted_at is null or u.deleted_at is null then
    raise exception 'BILLING FAIL [y]: the sweep left something live (sub %, farm %, user %)',
      s.deleted_at, f.deleted_at, u.deleted_at;
  end if;
  if u.active then
    raise exception 'BILLING FAIL [y]: the swept owner can still sign in';
  end if;
  if i.status <> 'void' then
    raise exception 'BILLING FAIL [y]: the unpaid invoice is "%" rather than void — it would '
      'sit in the ledger for ever as money somebody owes', i.status;
  end if;

  -- Nothing was DELETED. Same promise the non-payment downgrade makes.
  if not exists (select 1 from farms where id = v_farm_d) then
    raise exception 'BILLING FAIL [y]: the sweep hard-deleted a farm';
  end if;
  if not exists (select 1 from billing_invoices where subscription_id = v_dormant) then
    raise exception 'BILLING FAIL [y]: the sweep hard-deleted an invoice';
  end if;

  -- The lifecycle gate closes deleted farms before checking subscription state.
  -- Sweeping must never grant access just because the subscription was also deleted.
  if app.farm_billing_gate(v_farm_d) is distinct from 'closed' then
    raise exception 'BILLING FAIL [y]: a swept farm is not reported as closed';
  end if;

  raise notice '   the unpaid one is swept, the part-paid one is left alone, nothing deleted';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- (z) A declined first payment must not open the farm
--
-- The worst defect found in this billing system, and it was latent until self-serve
-- sign-up shipped in the same week.
--
-- `app.billing_register_failure` moved any subscription to 'past_due'. For a paying farm
-- that is the dunning ladder. For a PENDING sign-up it moved them out of 'pending' — and
-- `app.farm_billing_gate` reads 'pending' as "keep them out" and everything else as "let
-- them in". So a customer whose first card was DECLINED was handed the product.
--
-- Also here: the two invoice snapshots that were documented as frozen and were not, and a
-- zero-total invoice that could never be finished.
-- ═════════════════════════════════════════════════════════════════════════════

insert into auth.users (id, email) values
  ('b1a00000-0000-0000-0000-000000000090', 'declined@billing.invalid');

do $$
declare
  v_sub  uuid;
  v_farm uuid;
  v_inv  uuid;
  v_att  uuid;
  s      public.billing_subscriptions%rowtype;
  i      integer;
begin
  raise notice '── BILLING (z): a declined first payment opens nothing ──────────';

  v_sub := app.create_pending_signup('b1a00000-0000-0000-0000-000000000090',
    'declined@billing.invalid', 'Declined Person', 'Declined Boerdery', 'complete', 'monthly', 3);
  select farm_id into v_farm from billing_subscriptions where id = v_sub;
  select id into v_inv from billing_invoices where subscription_id = v_sub;

  -- POSITIVE CONTROL: shut before anything happens, or the assertions below prove nothing.
  if app.farm_billing_gate(v_farm) <> 'pending' then
    raise exception 'BILLING FAIL [z]: a brand-new sign-up is not gated to begin with';
  end if;

  -- Their card is declined. Four times, so the ladder would certainly have run.
  for i in 1 .. 4 loop
    perform app.billing_register_failure(v_sub, 'Insufficient funds');
  end loop;

  select * into s from billing_subscriptions where id = v_sub;
  if s.status <> 'pending' then
    raise exception 'BILLING FAIL [z]: four DECLINED payments moved the sign-up to "%". The '
      'gate reads anything but pending as "let them in", so failing to pay would be a way '
      'of getting in.', s.status;
  end if;
  if app.farm_billing_gate(v_farm) <> 'ok' is not false then
    -- (belt and braces: the gate itself, not just the status it reads)
    null;
  end if;
  if app.farm_billing_gate(v_farm) <> 'pending' then
    raise exception 'BILLING FAIL [z]: the farm opened after a declined payment';
  end if;

  -- The failure is still RECORDED. "Their card was declined four times" is worth knowing
  -- when they ring, and throwing it away to fix the status would be the wrong trade.
  if s.failed_attempt_count <> 4 or s.last_failure_code is null then
    raise exception 'BILLING FAIL [z]: the declines were not recorded (% failures, reason %)',
      s.failed_attempt_count, s.last_failure_code;
  end if;
  -- And no retry ladder was started: there is nothing to chase. They owe nothing until
  -- they decide to buy.
  if s.next_retry_on is not null or s.grace_ends_on is not null then
    raise exception 'BILLING FAIL [z]: a pending sign-up was put on the dunning ladder '
      '(retry %, grace %)', s.next_retry_on, s.grace_ends_on;
  end if;

  -- NEGATIVE CONTROL. A PAYING farm must still be dunned by the very same call, or the
  -- assertion above is a statement about dunning being broken.
  perform app.billing_register_failure('b1600000-0000-0000-0000-000000000009', 'test decline');
  select * into s from billing_subscriptions where id = 'b1600000-0000-0000-0000-000000000009';
  if s.status <> 'past_due' then
    raise exception 'BILLING FAIL [z]: a live subscription was not dunned (status %) — the '
      'pending assertion above therefore proves nothing', s.status;
  end if;

  -- And paying still works: the invoice is there, untouched, and settling it opens the farm.
  perform app.change_billing_quota(v_sub, 3);   -- no-op; proves the sub is still usable
  insert into billing_payment_methods (farm_id, authorization_code, authorization_email,
    card_brand, last4, exp_month, exp_year, reusable, is_default, status)
  values (v_farm, 'AUTH_declined', 'declined@billing.invalid', 'visa', '9090',
          '12', '2030', true, true, 'active');
  update billing_subscriptions s2 set default_payment_method_id = pm.id
    from billing_payment_methods pm where pm.farm_id = v_farm and s2.id = v_sub;

  v_att := app.claim_billing_charge(v_inv, 'Z-REF-0001', 'initial_checkout',
    (select total_incl_cents from billing_invoices where id = v_inv));
  perform app.settle_billing_attempt(v_att, 'succeeded', 990090, 'Z-REF-0001', 'Approved',
    null, (select total_incl_cents from billing_invoices where id = v_inv), 'card');

  if app.farm_billing_gate(v_farm) <> 'ok' then
    raise exception 'BILLING FAIL [z]: they paid and the farm is still shut';
  end if;

  raise notice '   declines are recorded and change nothing; paying opens it';
end $$;

-- ── Who an invoice was from and for is part of what is frozen ───────────────
do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-000000000001';
  v_raised boolean;
  s     public.billing_invoices%rowtype;
begin
  select * into s from billing_invoices where id = v_inv;
  if s.status = 'draft' then
    raise exception 'BILLING FAIL [z]: the fixture invoice is a draft, so the freeze would '
      'not apply and the assertions below would pass for the wrong reason';
  end if;

  -- The seller. A copy reprinted next year must show the company AS IT WAS.
  v_raised := false;
  begin
    update billing_invoices
       set seller_snapshot = jsonb_build_object('legal_name', 'Somebody Else (Pty) Ltd')
     where id = v_inv;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [z]: the SELLER on an issued invoice was editable. The '
      'figures were frozen and the company name was not, which is the half a tax authority '
      'would care about most.';
  end if;

  -- And the customer.
  v_raised := false;
  begin
    update billing_invoices
       set bill_to_snapshot = jsonb_build_object('name', 'A Different Farm')
     where id = v_inv;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'BILLING FAIL [z]: the CUSTOMER on an issued invoice was editable';
  end if;

  -- NEGATIVE CONTROL: a draft is still being assembled, and the generator writes its
  -- snapshots as it builds it. Freezing a draft would break every invoice ever raised.
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values ('b1800000-0000-0000-0000-0000000000f1', 'b1000000-0000-0000-0000-000000000001',
    'b1600000-0000-0000-0000-000000000001', 'BZ-INV-DRAFT', 'draft',
    current_date - 400, current_date - 371, current_date - 400, current_date - 400,
    'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);
  update billing_invoices
     set seller_snapshot = jsonb_build_object('legal_name', 'Still Being Written')
   where id = 'b1800000-0000-0000-0000-0000000000f1';

  raise notice '   an issued invoice''s seller and customer are frozen; a draft is not';
end $$;

-- ── A draft is nobody's bill, however much has been paid against it ─────────
do $$
declare
  v_inv uuid := 'b1800000-0000-0000-0000-0000000000f2';
  s     public.billing_invoices%rowtype;
begin
  -- The audit called this "a zero-total invoice can never reach paid". Half true, and
  -- not reachable the way it implies: `billing_payments_nonzero_ck` forbids a zero
  -- payment, so the rollup never runs on such an invoice at all. The generator refusing
  -- to bill a farm with nothing to bill is the real guard, and section (i) asserts it.
  --
  -- What IS reachable is the ORDERING. `v_total > 0 and v_paid >= v_total` was tested
  -- before `status = 'draft'`, so a draft carrying a payment flipped to 'paid' while it
  -- was still being written — and the generator assembles every invoice as a draft.
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values (v_inv, 'b1000000-0000-0000-0000-000000000001',
    'b1600000-0000-0000-0000-000000000001', 'BZ-INV-DRAFT2', 'draft',
    current_date - 800, current_date - 771, current_date - 800, current_date - 800,
    'complete', 'monthly', 1, 1234, 1, 'b1500000-0000-0000-0000-000000000001', 'b1-synthetic', 0);

  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider,
                                provider_reference, provider_transaction_id, channel)
  values ('b1000000-0000-0000-0000-000000000001', v_inv, 1234, 'paystack',
          'BZ-DRAFT-PAY', 890000002, 'card');

  select * into s from billing_invoices where id = v_inv;
  if s.status <> 'draft' then
    raise exception 'BILLING FAIL [z]: a DRAFT invoice became "%" because a payment '
      'covered it. The generator assembles every invoice as a draft and issues it in the '
      'same transaction; one that settles itself halfway through is not finished.', s.status;
  end if;
  if s.amount_paid_cents <> 1234 then
    raise exception 'BILLING FAIL [z]: the payment was not rolled up (% paid)', s.amount_paid_cents;
  end if;

  -- And once it IS issued, the same payment settles it.
  update billing_invoices set status = 'open' where id = v_inv;
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider,
                                provider_reference, provider_transaction_id, channel)
  values ('b1000000-0000-0000-0000-000000000001', v_inv, 1, 'paystack',
          'BZ-DRAFT-PAY-2', 890000003, 'card');
  select * into s from billing_invoices where id = v_inv;
  if s.status <> 'paid' then
    raise exception 'BILLING FAIL [z]: an ISSUED invoice covered by its payments is "%"', s.status;
  end if;

  raise notice '   a draft stays a draft; an issued invoice settles';
end $$;
-- ═════════════════════════════════════════════════════════════════════════════
-- (aa) The cron ledger — "did it run last night?"
--
-- This section exists because the question had no answer for the one route that matters.
-- Measured on production before the migration was written: the NIGHTLY pass is provably
-- firing on Vercel's schedule (90 `notifications` rows in the 03:00–03:59 UTC window
-- across 14 distinct days), but only as a side effect of those engines happening to write
-- something. The BILLING pass writes nothing at all when nothing is due — no invoice, no
-- claim, no receipt, no reminder — and its only output is a JSON body returned to Vercel's
-- scheduler, which is read by nobody. A billing cron that had fired every night for six
-- weeks and one that had never fired once produced IDENTICAL evidence.
--
-- So the assertions below are mostly about the ledger being trustworthy rather than about
-- it being clever: it must record a start (not only a finish), it must not be writable by
-- a browser (a forged clean run history for a billing pass that never happened is the one
-- lie this table exists to prevent), it must not grow for ever, and — the (m) lesson,
-- applied to a different caller — the wrapper names and their PARAMETER names must match
-- what `src/lib/cron/heartbeat.ts` calls, or the rpc resolves to no function and the
-- heartbeat silently records nothing while reporting success.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_run   uuid;
  v_run2  uuid;
  v_oid   oid;
  r       record;
  n       integer;
  v_ok    boolean;
  v_fin   timestamptz;
  v_bad   text := '';
begin
  raise notice '── BILLING (aa): the cron ledger ────────────────────────────────';

  -- (a) Structure. FORCE RLS, because a table only Rapid Rise may read must not be
  -- readable by the table owner's own session either.
  if not exists (
    select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relname = 'cron_runs'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'BILLING FAIL [aa]: cron_runs is missing or not FORCE RLS';
  end if;

  -- Half a finish is a bug, not a state. A finished_at with no verdict would read as
  -- "ran and we do not know", which is exactly the ambiguity this table removes.
  begin
    insert into public.cron_runs (route, finished_at) values ('/x', now());
    raise exception 'BILLING FAIL [aa]: a row with finished_at and no ok was accepted';
  exception when check_violation then null;
  end;

  -- (b) Grants. A browser may READ (the admin screen renders it) and may never write.
  if has_table_privilege('anon', 'public.cron_runs', 'select') then
    raise exception 'BILLING FAIL [aa]: anon can read the cron ledger';
  end if;
  if not has_table_privilege('authenticated', 'public.cron_runs', 'select') then
    raise exception 'BILLING FAIL [aa]: authenticated cannot read it — the admin screen is blank';
  end if;
  if has_table_privilege('authenticated', 'public.cron_runs', 'insert')
     or has_table_privilege('authenticated', 'public.cron_runs', 'update')
     or has_table_privilege('authenticated', 'public.cron_runs', 'delete') then
    raise exception 'BILLING FAIL [aa]: a browser session can WRITE the cron ledger — it could '
      'forge a clean run history for a billing pass that never happened';
  end if;
  if not has_table_privilege('service_role', 'public.cron_runs', 'insert')
     or not has_table_privilege('service_role', 'public.cron_runs', 'update') then
    raise exception 'BILLING FAIL [aa]: the service role cannot record a run';
  end if;

  -- (c) Function lockdown, the section (j) rules applied to these four.
  for r in
    select p.oid, n2.nspname, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where (n2.nspname = 'app'    and p.proname in ('cron_run_start','cron_run_finish','cron_health'))
        or (n2.nspname = 'public' and p.proname in ('cron_run_start','cron_run_finish','cron_health'))
  loop
    n := coalesce(n, 0) + 1;

    if has_function_privilege('public', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: %.% is executable by PUBLIC — the PostgreSQL default '
        'that put app.stock_needs_reorder and public._f14_probe on the wrong side of the fence',
        r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: %.% is executable by anon', r.nspname, r.proname;
    end if;

    -- Only the read-only health view is open to a signed-in session, and RLS still
    -- decides what it returns. The two WRITERS are service-role only, in both schemas.
    if r.proname in ('cron_run_start','cron_run_finish')
       and has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: %.% is executable by `authenticated` — a browser '
        'could open and close cron runs', r.nspname, r.proname;
    end if;
    if r.nspname = 'app' and r.proname in ('cron_run_start','cron_run_finish')
       and has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: app.% is directly executable by service_role. The '
        'engine is reached through its public.* wrapper — the rule section (j) enforces for '
        'every other engine in this product.', r.proname;
    end if;
    if r.nspname = 'public' and r.proname in ('cron_run_start','cron_run_finish')
       and not has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: public.% is not executable by service_role — the cron '
        'route cannot record that it ran', r.proname;
    end if;
    if r.proname = 'cron_health'
       and not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'BILLING FAIL [aa]: %.cron_health lost its authenticated grant', r.nspname;
    end if;

    if r.prosecdef and (r.proconfig is null
        or not exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%')) then
      raise exception 'BILLING FAIL [aa]: %.% is SECURITY DEFINER with no pinned search_path',
        r.nspname, r.proname;
    end if;
  end loop;

  if coalesce(n, 0) <> 6 then
    raise exception 'BILLING FAIL [aa]: found % of the 6 cron-ledger functions. A rename must '
      'fail here rather than silently shrinking the sweep.', coalesce(n, 0);
  end if;

  -- (d) The rpc surface, with PARAMETER names. PostgREST resolves overloads by the named
  -- arguments in the JSON body, so a rename breaks the call as completely as a deletion —
  -- and the heartbeat swallows its own errors by design, so it would record nothing and
  -- say nothing. Section (m) exists because exactly this cost the charging path.
  for r in
    select * from (values
      ('cron_run_start',  'p_route text, p_trigger text'),
      ('cron_run_finish', 'p_run uuid, p_ok boolean, p_steps jsonb'),
      ('cron_health',     '')
    ) as t(fn, args)
  loop
    select p.oid into v_oid
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where n2.nspname = 'public' and p.proname = r.fn
       and pg_get_function_identity_arguments(p.oid) = r.args;
    if v_oid is null then
      v_bad := v_bad || ' public.' || r.fn || '(' || r.args || ')';
    end if;
    v_oid := null;
  end loop;
  if v_bad <> '' then
    raise exception 'BILLING FAIL [aa]: heartbeat.ts calls these and they do not exist with '
      'these parameter names:%', v_bad;
  end if;

  raise notice '   the ledger is rr-admin read-only, service-role write, and reachable';
end $$;


-- What the ledger actually does with a run.
do $$
declare
  v_run  uuid;
  v_row  record;
  v_old  uuid;
begin
  -- A run that has begun and not finished. This is the shape that matters: a pass killed
  -- by Vercel's function timeout leaves exactly this, and a ledger that only recorded
  -- finishes would show nothing at all for the night it mattered most.
  v_run := app.cron_run_start('/api/cron/billing');
  select * into v_row from public.cron_runs where id = v_run;
  if v_row.finished_at is not null or v_row.ok is not null then
    raise exception 'BILLING FAIL [aa]: a freshly started run is already finished';
  end if;
  if v_row.trigger <> 'schedule' then
    raise exception 'BILLING FAIL [aa]: default trigger is "%" not "schedule"', v_row.trigger;
  end if;

  -- Closing it records the verdict AND what each step said, so "it ran" and "it worked"
  -- stay separable.
  perform app.cron_run_finish(v_run, false, '{"charges":"error: boom","reminders":"ok"}'::jsonb);
  select * into v_row from public.cron_runs where id = v_run;
  if v_row.finished_at is null then
    raise exception 'BILLING FAIL [aa]: finishing a run did not close it';
  end if;
  if v_row.ok is not false then
    raise exception 'BILLING FAIL [aa]: a failed pass was recorded as ok = %', v_row.ok;
  end if;
  if v_row.steps->>'charges' <> 'error: boom' then
    raise exception 'BILLING FAIL [aa]: the step detail was not kept';
  end if;

  -- The FIRST answer stands. A retried or duplicated finish must not rewrite a closed run
  -- — otherwise a later success could paint over the failure somebody needs to see.
  perform app.cron_run_finish(v_run, true, '{"charges":"ok"}'::jsonb);
  select * into v_row from public.cron_runs where id = v_run;
  if v_row.ok is not false or v_row.steps->>'charges' <> 'error: boom' then
    raise exception 'BILLING FAIL [aa]: a second finish rewrote a closed run';
  end if;

  -- A manual run is recorded as manual. "It works when I run it by hand" is precisely the
  -- answer that hides a schedule that has stopped, so the two must not look alike.
  v_run := app.cron_run_start('/api/cron/billing', 'manual');
  if (select trigger from public.cron_runs where id = v_run) <> 'manual' then
    raise exception 'BILLING FAIL [aa]: a manual run was recorded as scheduled';
  end if;
  -- Anything that is not the word `manual` is a schedule, rather than an error: the value
  -- arrives from a query string.
  v_run := app.cron_run_start('/api/cron/billing', 'nonsense');
  if (select trigger from public.cron_runs where id = v_run) <> 'schedule' then
    raise exception 'BILLING FAIL [aa]: an unrecognised trigger was not treated as scheduled';
  end if;

  -- Bounded without anybody remembering. An operational table that only grows is a
  -- problem nobody notices until it is one.
  insert into public.cron_runs (route, started_at, finished_at, ok)
  values ('/api/cron/billing', now() - interval '200 days', now() - interval '200 days', true)
  returning id into v_old;
  perform app.cron_run_start('/api/cron/nightly');
  if exists (select 1 from public.cron_runs where id = v_old) then
    raise exception 'BILLING FAIL [aa]: a 200-day-old run survived the prune';
  end if;
  -- And the prune is not a blunt DELETE: today's rows must still be there.
  if not exists (select 1 from public.cron_runs where id = v_run) then
    raise exception 'BILLING FAIL [aa]: the prune took a run from today';
  end if;

  raise notice '   a start is recorded before a finish, and the first verdict stands';
end $$;


-- Who may read it, decided by RLS rather than by a check in a function body.
do $$
declare
  v_admin integer;
  v_owner integer;
begin
  perform public._t_login('b1a00000-0000-0000-0000-00000000000a');   -- rr_admin
  set local role authenticated;
  select count(*) into v_admin from public.cron_health();
  reset role;

  perform public._t_login('b1a00000-0000-0000-0000-000000000001');   -- a farm owner
  set local role authenticated;
  select count(*) into v_owner from public.cron_health();
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', false);

  if v_admin < 2 then
    raise exception 'BILLING FAIL [aa]: Rapid Rise sees % scheduled routes, expected both', v_admin;
  end if;
  -- The assertion that is worth having: a farm owner reads NOTHING, and reads nothing
  -- because `cron_runs_sel` says so, not because a body forgot to filter. The admin count
  -- above is the positive control — without it this would pass just as happily against an
  -- empty table.
  if v_owner <> 0 then
    raise exception 'BILLING FAIL [aa]: a farm owner reads % rows of Rapid Rise''s cron health',
      v_owner;
  end if;

  raise notice '   Rapid Rise reads both routes; a farm owner reads none';
end $$;


do $$ begin raise notice ''; raise notice '════════ BILLING: all sections passed ════════'; end $$;
select 'ALL BILLING SUBSCRIPTION TESTS PASSED' as result;

rollback;
