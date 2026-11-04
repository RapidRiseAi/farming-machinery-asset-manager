-- The November 2026 price list (20261104200000): R49 / R79 / R99, a five-slot minimum,
-- Done-For-You quoted, existing agreements unchanged. Every section runs in its own
-- transaction against the REAL list, because the figures are the thing being defended.
-- psql: \set ON_ERROR_STOP on stops at the first failure.
\set ON_ERROR_STOP on
set client_min_messages to warning;

-- == (a) A sign-up buys at least five slots and is invoiced the new price ==============
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into auth.users (id, email) values
  ('e7a00000-0000-4000-9000-000000000001', 'price.a1@billing.invalid'),
  ('e7a00000-0000-4000-9000-000000000002', 'price.a2@billing.invalid'),
  ('e7a00000-0000-4000-9000-000000000003', 'price.a3@billing.invalid');
do $$
declare v_sub uuid; s record; i record; l record;
begin
  -- Three asked for, five bought: the minimum, R245 a month.
  v_sub := app.create_pending_signup('e7a00000-0000-4000-9000-000000000001',
    'price.a1@billing.invalid', 'A One', 'Price Farm One', 'essential', 'monthly', 3);
  select * into s from billing_subscriptions where id = v_sub;
  select * into i from billing_invoices where subscription_id = v_sub;
  select * into l from billing_invoice_lines where invoice_id = i.id;
  if s.asset_quota is distinct from 5 then
    raise exception 'PRICE FAIL [a]: a three-vehicle sign-up holds % slots, expected the minimum 5', s.asset_quota;
  end if;
  if i.total_incl_cents <> 24500 or i.asset_count <> 5 or i.unit_price_incl_cents <> 4900
     or i.months_charged <> 1 or i.price_version_label <> 'launch-2026-11' then
    raise exception 'PRICE FAIL [a]: first invoice is % for % x % over % (%), expected 24500 for 5 x 4900 over 1 (launch-2026-11)',
      i.total_incl_cents, i.asset_count, i.unit_price_incl_cents, i.months_charged, i.price_version_label;
  end if;
  if l.line_total_incl_cents <> 24500 or l.qty <> 5 then
    raise exception 'PRICE FAIL [a]: the line says % x % = %', l.qty, l.unit_price_incl_cents, l.line_total_incl_cents;
  end if;

  -- Seven on Complete annual: R990 a vehicle a year, R6,930.
  v_sub := app.create_pending_signup('e7a00000-0000-4000-9000-000000000002',
    'price.a2@billing.invalid', 'A Two', 'Price Farm Two', 'complete', 'annual', 7);
  select * into s from billing_subscriptions where id = v_sub;
  select * into i from billing_invoices where subscription_id = v_sub;
  if s.asset_quota <> 7 or i.total_incl_cents <> 693000 or i.months_charged <> 10 then
    raise exception 'PRICE FAIL [a]: Complete annual for 7 holds % slots and is invoiced % over % months, expected 7 slots, 693000 over 10',
      s.asset_quota, i.total_incl_cents, i.months_charged;
  end if;

  -- Done-For-You is quoted, never bought online.
  begin
    perform app.create_pending_signup('e7a00000-0000-4000-9000-000000000003',
      'price.a3@billing.invalid', 'A Three', 'Price Farm Three', 'done_for_you', 'monthly', 12);
    raise exception 'PRICE FAIL [a]: Done-For-You could be bought online at a catalogue price';
  exception when check_violation then
    if sqlerrm not like '%not available to buy online%' then raise; end if;
  end;
end $$;
rollback;

-- == (b) A slot change cannot go below the minimum; a grandfathered farm still can ======
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000011', 'New List Farm', 'essential', 'active', 'monthly', 'p11@billing.invalid'),
  ('e7000000-0000-4000-9000-000000000012', 'Launch List Farm', 'essential', 'active', 'monthly', 'p12@billing.invalid');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, price_version_id, price_version_label) values
  ('e7600000-0000-4000-9000-000000000011', 'e7000000-0000-4000-9000-000000000011', 'essential', 'monthly', 'active',
   current_date - 5, current_date + 24, current_date + 25, extract(day from current_date - 5)::int, 5, null, null),
  ('e7600000-0000-4000-9000-000000000012', 'e7000000-0000-4000-9000-000000000012', 'essential', 'monthly', 'active',
   current_date - 5, current_date + 24, current_date + 25, extract(day from current_date - 5)::int, 3,
   (select id from billing_price_versions where version_label = 'launch-2026' and plan = 'essential' and billing_period = 'monthly'),
   'launch-2026');
do $$
declare q record; v jsonb;
begin
  select * into q from app.billing_quota_change_quote('e7600000-0000-4000-9000-000000000011', 4);
  if q.kind <> 'unavailable' or q.reason not like '%minimum on this plan is 5%' then
    raise exception 'PRICE FAIL [b]: four slots on the new list quoted % (%), expected unavailable at the minimum', q.kind, q.reason;
  end if;
  begin
    perform app.change_billing_quota('e7600000-0000-4000-9000-000000000011', 4);
    raise exception 'PRICE FAIL [b]: a slot change below the minimum was applied';
  exception when check_violation then
    if sqlerrm not like '%minimum on this plan is 5%' then raise; end if;
  end;
  if (select asset_quota from billing_subscriptions where id = 'e7600000-0000-4000-9000-000000000011') <> 5 then
    raise exception 'PRICE FAIL [b]: the refused change moved the slots';
  end if;

  -- The launch list has no minimum: its farm may give a slot back, at period end as ever.
  select * into q from app.billing_quota_change_quote('e7600000-0000-4000-9000-000000000012', 2);
  if q.kind <> 'scheduled' then
    raise exception 'PRICE FAIL [b]: a grandfathered farm giving a slot back quoted % (%), expected scheduled', q.kind, q.reason;
  end if;

  -- Adding slots on the launch list pro-rates at the LAUNCH price, not the new one.
  select * into q from app.billing_quota_change_quote('e7600000-0000-4000-9000-000000000012', 4);
  if q.kind <> 'increase_now' or q.charge_now_cents <> round(4400::numeric * q.days_remaining / q.days_in_period) then
    raise exception 'PRICE FAIL [b]: one more launch-list slot quoted % (% cents over % of % days), expected the R44 rate',
      q.kind, q.charge_now_cents, q.days_remaining, q.days_in_period;
  end if;
end $$;
rollback;

-- == (c) Invoices: the launch list unchanged, a counted fleet billed the minimum ========
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000021', 'Grandfathered', 'essential', 'active', 'monthly', 'p21@billing.invalid'),
  ('e7000000-0000-4000-9000-000000000022', 'Counted Small', 'complete', 'active', 'monthly', 'p22@billing.invalid'),
  ('e7000000-0000-4000-9000-000000000023', 'Counted Big', 'complete', 'active', 'monthly', 'p23@billing.invalid');
insert into machines (farm_id, name, type, meter_type, status)
select 'e7000000-0000-4000-9000-000000000022'::uuid, 'Small ' || g, 'tractor', 'hours', 'active' from generate_series(1, 2) g;
insert into machines (farm_id, name, type, meter_type, status)
select 'e7000000-0000-4000-9000-000000000023'::uuid, 'Big ' || g, 'tractor', 'hours', 'active' from generate_series(1, 8) g;
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  next_billing_on, anchor_day, asset_quota, price_version_id, price_version_label) values
  ('e7600000-0000-4000-9000-000000000021', 'e7000000-0000-4000-9000-000000000021', 'essential', 'monthly', 'active',
   current_date, extract(day from current_date)::int, 3,
   (select id from billing_price_versions where version_label = 'launch-2026' and plan = 'essential' and billing_period = 'monthly'),
   'launch-2026'),
  -- No quota: billed on the counted fleet, the shape app.start_billing_subscription writes.
  ('e7600000-0000-4000-9000-000000000022', 'e7000000-0000-4000-9000-000000000022', 'complete', 'monthly', 'active',
   current_date, extract(day from current_date)::int, null, null, null),
  ('e7600000-0000-4000-9000-000000000023', 'e7000000-0000-4000-9000-000000000023', 'complete', 'monthly', 'active',
   current_date, extract(day from current_date)::int, null, null, null);
do $$
declare i record; l record;
begin
  perform app.generate_billing_invoices(null);

  select * into i from billing_invoices where subscription_id = 'e7600000-0000-4000-9000-000000000021';
  if i.total_incl_cents is distinct from 13200 or i.price_version_label <> 'launch-2026' then
    raise exception 'PRICE FAIL [c]: a farm pinned to the launch list was invoiced % (%), expected 13200 (3 x R44, no minimum)',
      i.total_incl_cents, i.price_version_label;
  end if;

  select * into i from billing_invoices where subscription_id = 'e7600000-0000-4000-9000-000000000022';
  select * into l from billing_invoice_lines where invoice_id = i.id;
  if i.total_incl_cents is distinct from 49500 or i.asset_count <> 5 or l.description not like '%(plan minimum)%' then
    raise exception 'PRICE FAIL [c]: two counted vehicles on Complete were invoiced % for % ("%"), expected 49500 for the minimum 5, labelled',
      i.total_incl_cents, i.asset_count, l.description;
  end if;

  select * into i from billing_invoices where subscription_id = 'e7600000-0000-4000-9000-000000000023';
  select * into l from billing_invoice_lines where invoice_id = i.id;
  if i.total_incl_cents is distinct from 79200 or i.asset_count <> 8 or l.description like '%minimum%' then
    raise exception 'PRICE FAIL [c]: eight counted vehicles were invoiced % for % ("%"), expected 79200 for 8, unlabelled',
      i.total_incl_cents, i.asset_count, l.description;
  end if;
end $$;
rollback;

-- == (d) A plan change: slots first below the minimum, then priced on slots ==============
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000031', 'Upgrader', 'essential', 'active', 'monthly', 'p31@billing.invalid');
insert into machines (farm_id, name, type, meter_type, status)
select 'e7000000-0000-4000-9000-000000000031'::uuid, 'U ' || g, 'tractor', 'hours', 'active' from generate_series(1, 2) g;
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, price_version_id, price_version_label) values
  ('e7600000-0000-4000-9000-000000000031', 'e7000000-0000-4000-9000-000000000031', 'essential', 'monthly', 'active',
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int, 3,
   (select id from billing_price_versions where version_label = 'launch-2026' and plan = 'essential' and billing_period = 'monthly'),
   'launch-2026');
do $$
declare q record; v_unit bigint;
begin
  select * into q from app.billing_plan_change_quote('e7600000-0000-4000-9000-000000000031', 'professional', 'monthly');
  if q.kind <> 'unavailable' or q.reason not like '%needs at least 5 vehicle slots%' then
    raise exception 'PRICE FAIL [d]: three launch-list slots moving to Professional quoted % (%), expected slots first', q.kind, q.reason;
  end if;

  -- Six slots, two machines: the upgrade is charged on the six slots that are billed.
  update billing_subscriptions set asset_quota = 6 where id = 'e7600000-0000-4000-9000-000000000031';
  select * into q from app.billing_plan_change_quote('e7600000-0000-4000-9000-000000000031', 'professional', 'monthly');
  v_unit := round((7900 - 4400)::numeric * q.days_remaining / q.days_in_period);
  if q.kind <> 'upgrade_now' or q.vehicles <> 6 or q.charge_now_cents <> v_unit * 6 then
    raise exception 'PRICE FAIL [d]: the upgrade quoted % for % vehicles (% cents), expected upgrade_now on 6 slots (% cents)',
      q.kind, q.vehicles, q.charge_now_cents, v_unit * 6;
  end if;

  -- Done-For-You is not a plan anyone moves to by themselves.
  select * into q from app.billing_plan_change_quote('e7600000-0000-4000-9000-000000000031', 'done_for_you', 'monthly');
  if q.kind <> 'unavailable' then
    raise exception 'PRICE FAIL [d]: a move to Done-For-You quoted %, expected unavailable (it is quoted per customer)', q.kind;
  end if;
end $$;
rollback;

-- == (e) Scheduled changes: a minimum lifts the slots; an unpriced plan is not landed on ===
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000041', 'Scheduled Up', 'essential', 'active', 'monthly', 'p41@billing.invalid'),
  ('e7000000-0000-4000-9000-000000000042', 'Scheduled DFY', 'complete', 'active', 'monthly', 'p42@billing.invalid');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota,
  price_version_id, price_version_label, pending_plan, pending_billing_period, pending_plan_on, pending_plan_set_at) values
  ('e7600000-0000-4000-9000-000000000041', 'e7000000-0000-4000-9000-000000000041', 'essential', 'monthly', 'active',
   current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int, 3,
   (select id from billing_price_versions where version_label = 'launch-2026' and plan = 'essential' and billing_period = 'monthly'),
   'launch-2026', 'essential', 'annual', current_date, now() - interval '10 days'),
  ('e7600000-0000-4000-9000-000000000042', 'e7000000-0000-4000-9000-000000000042', 'complete', 'monthly', 'active',
   current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int, 8,
   null, null, 'done_for_you', 'annual', current_date, now() - interval '10 days');
do $$
declare s record; v_plan text;
begin
  perform app.apply_pending_plan_changes();

  select * into s from billing_subscriptions where id = 'e7600000-0000-4000-9000-000000000041';
  if s.billing_period <> 'annual' or s.price_version_label <> 'launch-2026-11' or s.asset_quota <> 5 then
    raise exception 'PRICE FAIL [e]: a scheduled move onto the new annual list left % on % with % slots, expected annual, launch-2026-11, 5',
      s.billing_period, s.price_version_label, s.asset_quota;
  end if;

  select * into s from billing_subscriptions where id = 'e7600000-0000-4000-9000-000000000042';
  select plan::text into v_plan from farms where id = 'e7000000-0000-4000-9000-000000000042';
  if s.plan <> 'complete' or v_plan <> 'complete' or s.pending_plan is distinct from 'done_for_you' then
    raise exception 'PRICE FAIL [e]: a scheduled move to unpriced Done-For-You landed (subscription %, farm %, pending %)',
      s.plan, v_plan, s.pending_plan;
  end if;
end $$;
rollback;

-- == (f) The renewal notice quotes the minimum the invoice will charge ===================
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000051', 'Notice Farm', 'complete', 'active', 'monthly', 'p51@billing.invalid');
insert into auth.users (id, email) values ('e7a00000-0000-4000-9000-000000000051', 'p51.owner@billing.invalid');
insert into users (id, farm_id, workshop_id, role, name, email, active) values
  ('e7a00000-0000-4000-9000-000000000051', 'e7000000-0000-4000-9000-000000000051', null, 'owner', 'Notice Owner',
   'p51.owner@billing.invalid', true);
insert into machines (farm_id, name, type, meter_type, status) values
  ('e7000000-0000-4000-9000-000000000051', 'Only One', 'tractor', 'hours', 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('e7600000-0000-4000-9000-000000000051', 'e7000000-0000-4000-9000-000000000051', 'complete', 'monthly', 'active',
   current_date - 26, current_date + 2,
   current_date + (select renewal_notice_days_monthly from billing_settings where singleton),
   extract(day from current_date - 26)::int, null);
do $$
declare v_payload jsonb;
begin
  perform app.enqueue_billing_renewal_notices();
  select payload into v_payload from notifications
   where farm_id = 'e7000000-0000-4000-9000-000000000051' and template = 'billing_renewal_due' limit 1;
  if v_payload is null then
    raise exception 'PRICE FAIL [f]: no renewal notice was queued';
  end if;
  if (v_payload->>'units')::int <> 5 or (v_payload->>'amount_cents')::bigint <> 49500 then
    raise exception 'PRICE FAIL [f]: the notice quoted % units for % cents, expected the minimum 5 for 49500', v_payload->>'units', v_payload->>'amount_cents';
  end if;
end $$;
rollback;
