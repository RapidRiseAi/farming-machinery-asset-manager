-- Rapid Rise opens a quoted customer (20261105100000): pending, first invoice now, never swept.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_email) values
  ('9e000000-0000-4000-9000-000000000001', 'Quoted Customer', 'essential', 'active', 'quoted@billing.invalid'),
  ('9e000000-0000-4000-9000-000000000002', 'Self Sign-up', 'essential', 'active', 'self@billing.invalid'),
  ('9e000000-0000-4000-9000-000000000003', 'Quoted Old', 'complete', 'active', 'old@billing.invalid');
insert into auth.users (id, email) values
  ('9e100000-0000-4000-9000-000000000009', 'onboard.staff@example.test'),
  ('9e100000-0000-4000-9000-000000000001', 'onboard.owner@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('9e100000-0000-4000-9000-000000000009', null, 'rr_admin', 'Staff', 'onboard.staff@example.test'),
  ('9e100000-0000-4000-9000-000000000001', '9e000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'onboard.owner@example.test');

-- (a) Opened by staff: pending, the slots at least the minimum, the first invoice raised now.
do $$
declare v_sub uuid; s record; i record;
begin
  v_sub := public.billing_admin_open_subscription('9e000000-0000-4000-9000-000000000001', 'professional', 'monthly', 3,
    '9e100000-0000-4000-9000-000000000009');
  select * into s from public.billing_subscriptions where id = v_sub;
  select * into i from public.billing_invoices where subscription_id = v_sub;
  if s.status <> 'pending' or s.asset_quota <> 5 or not s.opened_by_staff or s.trial_ends_on is not null then
    raise exception 'ONBOARD FAIL [a]: subscription is % with % slots, staff %, trial %', s.status, s.asset_quota, s.opened_by_staff, s.trial_ends_on;
  end if;
  if i.status <> 'open' or i.total_incl_cents <> 39500 or i.price_version_label <> 'launch-2026-11' then
    raise exception 'ONBOARD FAIL [a]: first invoice % for %, label %; expected open, 39500 (5 x R79)', i.status, i.total_incl_cents, i.price_version_label;
  end if;
  if (select plan from public.farms where id = '9e000000-0000-4000-9000-000000000001') <> 'professional' then
    raise exception 'ONBOARD FAIL [a]: the farm''s plan did not follow the subscription';
  end if;
  if app.farm_billing_gate('9e000000-0000-4000-9000-000000000001') <> 'pending' then
    raise exception 'ONBOARD FAIL [a]: the gate is %, expected pending (pay before use)', app.farm_billing_gate('9e000000-0000-4000-9000-000000000001');
  end if;
end $$;

-- (b) Refusals: not staff, a second subscription, a plan with no list price.
do $$
declare v_ok boolean;
begin
  v_ok := false;
  begin
    perform public.billing_admin_open_subscription('9e000000-0000-4000-9000-000000000002', 'essential', 'monthly', 5,
      '9e100000-0000-4000-9000-000000000001');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'ONBOARD FAIL [b]: a farm owner opened a subscription as staff'; end if;

  v_ok := false;
  begin
    perform public.billing_admin_open_subscription('9e000000-0000-4000-9000-000000000001', 'essential', 'monthly', 5,
      '9e100000-0000-4000-9000-000000000009');
  exception when unique_violation then v_ok := true; end;
  if not v_ok then raise exception 'ONBOARD FAIL [b]: a second subscription was opened'; end if;

  v_ok := false;
  begin
    perform public.billing_admin_open_subscription('9e000000-0000-4000-9000-000000000002', 'done_for_you', 'monthly', 10,
      '9e100000-0000-4000-9000-000000000009');
  exception when check_violation then v_ok := sqlerrm like '%no list price%'; end;
  if not v_ok then raise exception 'ONBOARD FAIL [b]: Done-For-You was opened at a list price'; end if;
end $$;

-- (c) The dormant sweep removes a stale self sign-up but never a staff-opened customer.
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on, anchor_day, asset_quota, created_at) values
  ('9e600000-0000-4000-9000-000000000002', '9e000000-0000-4000-9000-000000000002', 'essential', 'monthly', 'pending',
   current_date - 10, 1, 5, now() - interval '10 days');
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on, anchor_day, asset_quota, created_at, opened_by_staff) values
  ('9e600000-0000-4000-9000-000000000003', '9e000000-0000-4000-9000-000000000003', 'complete', 'monthly', 'pending',
   current_date - 10, 1, 5, now() - interval '10 days', true);
do $$
begin
  perform app.sweep_dormant_signups(7);
  if (select deleted_at from public.billing_subscriptions where id = '9e600000-0000-4000-9000-000000000002') is null then
    raise exception 'ONBOARD FAIL [c]: the stale self sign-up was not swept (the sweep itself is broken)';
  end if;
  if (select deleted_at from public.billing_subscriptions where id = '9e600000-0000-4000-9000-000000000003') is not null
     or (select deleted_at from public.farms where id = '9e000000-0000-4000-9000-000000000003') is not null then
    raise exception 'ONBOARD FAIL [c]: a staff-opened customer was swept as a dormant sign-up';
  end if;
end $$;

-- (d) The EFT details are readable by a signed-in customer; the wrapper is service-only.
do $$ begin
  if not has_column_privilege('authenticated', 'public.billing_settings', 'eft_instructions', 'SELECT') then
    raise exception 'ONBOARD FAIL [d]: customers cannot read the EFT details on /activate';
  end if;
  if has_function_privilege('authenticated', 'public.billing_admin_open_subscription(uuid,farm_plan,billing_period,integer,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.billing_admin_open_subscription(uuid,farm_plan,billing_period,integer,uuid)', 'EXECUTE') then
    raise exception 'ONBOARD FAIL [d]: a browser role can open subscriptions';
  end if;
end $$;

rollback;
