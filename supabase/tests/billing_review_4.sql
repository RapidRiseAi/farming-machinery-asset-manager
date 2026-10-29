-- Fourth billing review fixes (20261029150000). Every section below fails on the schema
-- before that migration; each one is the verified scenario, run end to end.
--
--   (a) a period-end cancellation closes the night its period ends, in the cron's own order:
--       never renewed, cancelled, closed the next day (paid up, and back to non_renewing
--       after Rapid Rise kept it open)
--   (b) the dormant sweep spares a sign-up that paid a service invoice, an exempt farm and
--       a card payment in flight, and still sweeps a dormant one
--   (c) an exempt farm is never invoiced, never on the charge list, never sent AI use
--   (d) nothing is invoiced while suspended; the AI use rides on the next period invoice
--   (e) the first payment of a pending subscription starts its period that day
--   (f) reopening: a full month from today, a paid month kept, and only what is owed
--       (not a refunded or a service invoice) stops a new invoice
--   (g) keeping a farm open is refused where the gate never reads it
--   (h) a claim for more than is owed now is refused
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('f1500000-0000-0000-0000-000000000001', 'f1-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active'),
  ('f1500000-0000-0000-0000-000000000002', 'f1-synthetic-a', 'complete', 'annual', 2000, 12, 0, 'active');

insert into auth.users (id, email) values
  ('f1a00000-0000-0000-0000-000000000099', 'review4.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('f1a00000-0000-0000-0000-000000000099', null, 'rr_admin', 'Review4 RR', 'review4.rr@example.invalid', true);

-- AI use is invoiced from a month ago. Only sections (c) and (d) record any.
update billing_settings set ai_billing_starts_on = current_date - 30 where singleton;

-- An issued period invoice, written draft -> line -> open as the generator does.
create function public._f1_open_invoice(p_id uuid, p_farm uuid, p_sub uuid, p_ref text,
  p_start date, p_end date, p_due date, p_cents bigint default 2000) returns void
language plpgsql as $$
begin
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values (p_id, p_farm, p_sub, p_ref, 'draft', 'period', p_start, p_end, p_start, p_due,
    'complete', 'monthly', 1, p_cents, 1, 'f1500000-0000-0000-0000-000000000001', 'f1-synthetic', 0);
  insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
    months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
  values (p_id, p_farm, 0, 'Fleet Wise complete, 1 asset', 1, 1, p_cents, p_cents, p_cents, 0);
  update billing_invoices set status = 'open' where id = p_id;
end $$;

-- One settled platform AI call, at noon Johannesburg p_days_ago days ago.
create function public._f1_ai_use(p_farm uuid, p_user uuid, p_days_ago integer) returns void
language plpgsql as $$
declare
  v_res uuid;
  v_at timestamptz := (((now() at time zone 'Africa/Johannesburg')::date - p_days_ago) + time '12:00')::timestamp
                      at time zone 'Africa/Johannesburg';
begin
  insert into ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at, created_at)
  values (p_farm, p_user, 'ai_answer', 'platform', 'm', 5000, app.ai_month(v_at), v_at, v_at)
  returning id into v_res;
  insert into ai_usage (farm_id, user_id, occurred_at, month, feature, provider, model, credential,
    measured, usd_zar, margin_bps, outcome, reservation_id, billed_cents, created_at)
  values (p_farm, p_user, v_at, app.ai_month(v_at), 'ai_answer', 'ai_gateway', 'm', 'platform',
    'server', 18, 3000, 'ok', v_res, 5000, v_at);
end $$;


-- == (a) a period-end cancellation closes; it is never renewed (money-1) ================
--   A1 cancelled at period end, everything paid, period ended yesterday
--   A2 the same, but suspended over an unpaid month and then kept open by Rapid Rise,
--      which puts it back to non_renewing (20261029140000)
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000001', 'Review4 Cancelled',          'complete', 'active', 'monthly', 'r4a1@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000002', 'Review4 Cancelled Extended', 'complete', 'active', 'monthly', 'r4a2@billing.invalid', false);
insert into auth.users (id, email) values
  ('f1a00000-0000-0000-0000-000000000001', 'review4.owner1@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('f1a00000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'owner', 'Review4 Owner', 'review4.owner1@example.invalid', true);
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('f1700000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001',
   'AUTH_f1synthetic1', 'review4.owner1@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, cancel_at_period_end, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, default_payment_method_id) values
  ('f1600000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'complete', 'monthly', 'non_renewing',
   true, now() - interval '10 days', current_date - 31, current_date - 1, current_date,
   extract(day from current_date)::int, 1, 'f1700000-0000-0000-0000-000000000001'),
  ('f1600000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002', 'complete', 'monthly', 'non_renewing',
   true, now() - interval '20 days', current_date - 36, current_date - 6, current_date - 5,
   extract(day from current_date - 5)::int, 1, null);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001',
  'f1600000-0000-0000-0000-000000000001', 'R4-A1', current_date - 31, current_date - 1, current_date - 31);
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
values ('f1000000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000001', 2000, 'paystack', 'R4-PAY-A1', 981000001, 'card');
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002',
  'f1600000-0000-0000-0000-000000000002', 'R4-A2', current_date - 36, current_date - 6, current_date - 36);
select app.billing_apply_suspensions();
do $$
declare r record;
begin
  if (select status from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000002') <> 'suspended' then
    raise exception 'REVIEW4 SETUP [a]: A2 was not suspended over its unpaid month';
  end if;
  -- Suspended five days ago; Rapid Rise keeps it open today.
  update billing_subscriptions set suspended_at = now() - interval '5 days' where id = 'f1600000-0000-0000-0000-000000000002';
  perform public.admin_extend_billing_access('f1000000-0000-0000-0000-000000000002', current_date + 10,
    'bank confirmed', 'f1a00000-0000-0000-0000-000000000099');
  select * into r from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000002';
  if r.status <> 'non_renewing' or r.current_period_end <> current_date - 1 or r.next_billing_on <> current_date then
    raise exception 'REVIEW4 SETUP [a]: the extension left A2 % (end %, next %)', r.status, r.current_period_end, r.next_billing_on;
  end if;
end $$;
do $$
declare n int; r record; g text;
begin
  -- The nightly order (src/app/api/cron/billing/route.ts): invoices, AI use, (charges),
  -- suspensions, then cancellations.
  perform app.generate_billing_invoices(null);
  perform app.generate_ai_usage_invoices();
  perform app.billing_apply_suspensions();
  perform app.billing_close_cancellations();
  select count(*) into n from billing_invoices
   where subscription_id in ('f1600000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000002')
     and period_start >= current_date and deleted_at is null;
  if n > 0 then
    raise exception 'REVIEW4 FAIL [a]: farms that cancelled at period end were invoiced % time(s) for the period after they left (now %, %)',
      n, (select status from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000001'),
      (select status from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000002');
  end if;
  for r in select id, status, ended_on from billing_subscriptions
            where id in ('f1600000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000002') loop
    if r.status <> 'cancelled' or r.ended_on is distinct from current_date then
      raise exception 'REVIEW4 FAIL [a]: subscription % is % (ended %), expected cancelled tonight', r.id, r.status, r.ended_on;
    end if;
  end loop;
  if exists (select 1 from app.due_billing_charges(10000) d
              where d.farm_id in ('f1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002')) then
    raise exception 'REVIEW4 FAIL [a]: a farm that cancelled is on the card charge list';
  end if;
  -- The next day (as tomorrow will read it, ended_on is yesterday): closed, so it can reopen.
  update billing_subscriptions set ended_on = current_date - 1
   where id in ('f1600000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000002');
  if app.farm_billing_gate('f1000000-0000-0000-0000-000000000001') <> 'closed'
     or app.farm_billing_gate('f1000000-0000-0000-0000-000000000002') <> 'closed' then
    raise exception 'REVIEW4 FAIL [a]: the day after closing the gate answers %, % (expected closed)',
      app.farm_billing_gate('f1000000-0000-0000-0000-000000000001'),
      app.farm_billing_gate('f1000000-0000-0000-0000-000000000002');
  end if;
  -- And through the public wrapper the layout calls, as the farm's owner.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'f1a00000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, false);
  g := public.farm_billing_gate('f1000000-0000-0000-0000-000000000001');
  perform set_config('request.jwt.claims', '', false);
  if g is distinct from 'closed' then
    raise exception 'REVIEW4 FAIL [a]: public.farm_billing_gate tells the owner %, expected closed', g;
  end if;
end $$;


-- == (b) the dormant sweep (money-2, money-10, money-8) =================================
--   B3 pending sign-up, 10 days old, has paid an onboarding service invoice by EFT
--   B4 pending sign-up, 8 days old, a card checkout in flight
--   B5 pending sign-up, 10 days old, billing_exempt
--   B6 pending sign-up, 10 days old, nothing paid: swept (the positive control)
insert into farms (id, name, plan, status, billing_period, billing_email, is_test, billing_exempt) values
  ('f1000000-0000-0000-0000-000000000003', 'Review4 Sweep Service',  'complete', 'active', 'monthly', 'r4b3@billing.invalid', false, false),
  ('f1000000-0000-0000-0000-000000000004', 'Review4 Sweep InFlight', 'complete', 'active', 'monthly', 'r4b4@billing.invalid', false, false),
  ('f1000000-0000-0000-0000-000000000005', 'Review4 Sweep Exempt',   'complete', 'active', 'monthly', 'r4b5@billing.invalid', false, true),
  ('f1000000-0000-0000-0000-000000000006', 'Review4 Sweep Dormant',  'complete', 'active', 'monthly', 'r4b6@billing.invalid', false, false);
insert into auth.users (id, email) values
  ('f1a00000-0000-0000-0000-000000000003', 'review4.owner3@example.invalid'),
  ('f1a00000-0000-0000-0000-000000000006', 'review4.owner6@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('f1a00000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000003', 'owner', 'Review4 Owner Three', 'review4.owner3@example.invalid', true),
  ('f1a00000-0000-0000-0000-000000000006', 'f1000000-0000-0000-0000-000000000006', 'owner', 'Review4 Owner Six', 'review4.owner6@example.invalid', true);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on, anchor_day, asset_quota, created_at)
select ('f1600000-0000-0000-0000-00000000000' || n)::uuid, ('f1000000-0000-0000-0000-00000000000' || n)::uuid,
       'complete', 'monthly', 'pending', current_date - d, extract(day from current_date - d)::int, 1,
       now() - make_interval(days => d)
  from (values (3, 10), (4, 8), (5, 10), (6, 10)) v(n, d);
select app.generate_billing_invoices('f1600000-0000-0000-0000-000000000003');
select app.generate_billing_invoices('f1600000-0000-0000-0000-000000000004');
select app.generate_billing_invoices('f1600000-0000-0000-0000-000000000006');
do $$
declare v uuid; inv uuid;
begin
  v := public.billing_raise_service_invoice('f1000000-0000-0000-0000-000000000003',
        '[{"description":"Onboarding and setup","qty":1,"unit_price_cents":500000}]'::jsonb, null,
        'f1a00000-0000-0000-0000-000000000099');
  perform public.billing_record_manual_payment(v, 500000, 'eft', 'R4-ONBOARD-3', current_date, null,
        'proofs/r4-onboard.pdf', 'f1a00000-0000-0000-0000-000000000099');
  if (select status from billing_invoices where id = v) <> 'paid' then
    raise exception 'REVIEW4 SETUP [b]: the service invoice is not paid';
  end if;
  select id into inv from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000004' and status = 'open';
  if app.claim_billing_charge(inv, 'R4-CHECKOUT-4', 'initial_checkout', 2000) is null then
    raise exception 'REVIEW4 SETUP [b]: the checkout was not claimed';
  end if;
end $$;
do $$
declare n int;
begin
  n := app.sweep_dormant_signups(7);
  if (select deleted_at from farms where id = 'f1000000-0000-0000-0000-000000000006') is null then
    raise exception 'REVIEW4 FAIL [b]: the dormant sign-up was not swept (swept %), so nothing below is proved', n;
  end if;
  if (select deleted_at from farms where id = 'f1000000-0000-0000-0000-000000000003') is not null
     or (select deleted_at from users where id = 'f1a00000-0000-0000-0000-000000000003') is not null then
    raise exception 'REVIEW4 FAIL [b]: the sweep deleted a sign-up that paid R5 000 for onboarding, and its owner';
  end if;
  if (select deleted_at from farms where id = 'f1000000-0000-0000-0000-000000000004') is not null
     or not exists (select 1 from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000004' and status = 'open') then
    raise exception 'REVIEW4 FAIL [b]: the sweep deleted a sign-up paying by card at that moment (invoice voided under the payment)';
  end if;
  if (select deleted_at from farms where id = 'f1000000-0000-0000-0000-000000000005') is not null then
    raise exception 'REVIEW4 FAIL [b]: the sweep deleted an exempt farm';
  end if;
end $$;


-- == (c) an exempt farm is never asked to pay (money-8) =================================
--   C7 exempt, card on file, renews today, an invoice from before it was marked falls due
--   C8 the same, not exempt (the control)
--   C9 exempt annual farm on its billing day with AI use; C10 the same, not exempt
insert into farms (id, name, plan, status, billing_period, billing_email, is_test, billing_exempt) values
  ('f1000000-0000-0000-0000-000000000007', 'Review4 Exempt Card',    'complete', 'active', 'monthly', 'r4c7@billing.invalid', false, true),
  ('f1000000-0000-0000-0000-000000000008', 'Review4 Paying Card',    'complete', 'active', 'monthly', 'r4c8@billing.invalid', false, false),
  ('f1000000-0000-0000-0000-000000000009', 'Review4 Exempt AI',      'complete', 'active', 'annual',  'r4c9@billing.invalid', false, true),
  ('f1000000-0000-0000-0000-000000000010', 'Review4 Paying AI',      'complete', 'active', 'annual',  'r4c10@billing.invalid', false, false);
insert into auth.users (id, email) values
  ('f1a00000-0000-0000-0000-000000000009', 'review4.owner9@example.invalid'),
  ('f1a00000-0000-0000-0000-000000000010', 'review4.owner10@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('f1a00000-0000-0000-0000-000000000009', 'f1000000-0000-0000-0000-000000000009', 'owner', 'Review4 Owner Nine', 'review4.owner9@example.invalid', true),
  ('f1a00000-0000-0000-0000-000000000010', 'f1000000-0000-0000-0000-000000000010', 'owner', 'Review4 Owner Ten', 'review4.owner10@example.invalid', true);
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('f1700000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000007',
   'AUTH_f1synthetic7', 'review4.owner7@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active'),
  ('f1700000-0000-0000-0000-000000000008', 'f1000000-0000-0000-0000-000000000008',
   'AUTH_f1synthetic8', 'review4.owner8@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, default_payment_method_id) values
  ('f1600000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000007', 'complete', 'monthly', 'active',
   current_date - 30, current_date - 1, current_date, extract(day from current_date)::int, 1, 'f1700000-0000-0000-0000-000000000007'),
  ('f1600000-0000-0000-0000-000000000008', 'f1000000-0000-0000-0000-000000000008', 'complete', 'monthly', 'active',
   current_date - 30, current_date - 1, current_date, extract(day from current_date)::int, 1, 'f1700000-0000-0000-0000-000000000008'),
  ('f1600000-0000-0000-0000-000000000009', 'f1000000-0000-0000-0000-000000000009', 'complete', 'annual', 'active',
   current_date - 100, current_date + 199, current_date + 200,
   extract(day from (now() at time zone 'Africa/Johannesburg')::date)::int, 1, null),
  ('f1600000-0000-0000-0000-000000000010', 'f1000000-0000-0000-0000-000000000010', 'complete', 'annual', 'active',
   current_date - 100, current_date + 199, current_date + 200,
   extract(day from (now() at time zone 'Africa/Johannesburg')::date)::int, 1, null);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000007',
  'f1600000-0000-0000-0000-000000000007', 'R4-C7', current_date - 60, current_date - 31, current_date - 2);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000008', 'f1000000-0000-0000-0000-000000000008',
  'f1600000-0000-0000-0000-000000000008', 'R4-C8', current_date - 60, current_date - 31, current_date - 2);
select public._f1_ai_use('f1000000-0000-0000-0000-000000000009', 'f1a00000-0000-0000-0000-000000000009', 5);
select public._f1_ai_use('f1000000-0000-0000-0000-000000000010', 'f1a00000-0000-0000-0000-000000000010', 5);
do $$
declare made7 int; made8 int; n9 int; n10 int;
begin
  made7 := app.generate_billing_invoices('f1600000-0000-0000-0000-000000000007');
  made8 := app.generate_billing_invoices('f1600000-0000-0000-0000-000000000008');
  if made8 <> 1 then
    raise exception 'REVIEW4 FAIL [c]: the paying twin was invoiced % time(s), expected 1, so nothing below is proved', made8;
  end if;
  if made7 <> 0 then
    raise exception 'REVIEW4 FAIL [c]: an exempt farm was invoiced for its next period';
  end if;
  if not exists (select 1 from app.due_billing_charges(10000) d where d.farm_id = 'f1000000-0000-0000-0000-000000000008') then
    raise exception 'REVIEW4 FAIL [c]: the paying twin is not on the charge list, so nothing below is proved';
  end if;
  if exists (select 1 from app.due_billing_charges(10000) d where d.farm_id = 'f1000000-0000-0000-0000-000000000007') then
    raise exception 'REVIEW4 FAIL [c]: an exempt farm''s card is on the charge list';
  end if;
  perform app.generate_ai_usage_invoices();
  select count(*) into n9 from billing_invoices where farm_id = 'f1000000-0000-0000-0000-000000000009' and kind = 'ai_usage';
  select count(*) into n10 from billing_invoices where farm_id = 'f1000000-0000-0000-0000-000000000010' and kind = 'ai_usage';
  if n10 <> 1 then
    raise exception 'REVIEW4 FAIL [c]: the paying twin got % AI-only invoice(s), expected 1, so nothing below is proved', n10;
  end if;
  if n9 <> 0 then
    raise exception 'REVIEW4 FAIL [c]: an exempt farm was sent % AI-only invoice(s)', n9;
  end if;
end $$;


-- == (d) nothing invoiced while suspended; the use rides on the next period (release-1) =
--   D11 suspended four days ago over its current month, AI use from before the pause, and
--       today is its billing day of the month
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000011', 'Review4 Paused AI', 'complete', 'active', 'monthly', 'r4d11@billing.invalid', false);
insert into auth.users (id, email) values
  ('f1a00000-0000-0000-0000-000000000011', 'review4.owner11@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('f1a00000-0000-0000-0000-000000000011', 'f1000000-0000-0000-0000-000000000011', 'owner', 'Review4 Owner Eleven', 'review4.owner11@example.invalid', true);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, suspended_at) values
  ('f1600000-0000-0000-0000-000000000011', 'f1000000-0000-0000-0000-000000000011', 'complete', 'monthly', 'suspended',
   current_date - 12, current_date + 17, current_date + 18,
   extract(day from (now() at time zone 'Africa/Johannesburg')::date)::int, 1, now() - interval '4 days');
update farms set status = 'suspended', suspended_for = 'billing' where id = 'f1000000-0000-0000-0000-000000000011';
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000011', 'f1000000-0000-0000-0000-000000000011',
  'f1600000-0000-0000-0000-000000000011', 'R4-D11', current_date - 12, current_date + 17, current_date - 12);
select public._f1_ai_use('f1000000-0000-0000-0000-000000000011', 'f1a00000-0000-0000-0000-000000000011', 14);
do $$
declare n int; v_inv uuid; r record;
begin
  if app.farm_billing_gate('f1000000-0000-0000-0000-000000000011') <> 'suspended' then
    raise exception 'REVIEW4 SETUP [d]: D11 is not suspended';
  end if;
  perform app.generate_ai_usage_invoices();
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000011');
  select count(*) into n from billing_invoices
   where farm_id = 'f1000000-0000-0000-0000-000000000011' and id <> 'f1800000-0000-0000-0000-000000000011';
  if n > 0 then
    raise exception 'REVIEW4 FAIL [d]: % invoice(s) raised for a suspended farm (kind %)', n,
      (select string_agg(kind::text, ', ') from billing_invoices
        where farm_id = 'f1000000-0000-0000-0000-000000000011' and id <> 'f1800000-0000-0000-0000-000000000011');
  end if;

  -- It pays its month and comes back. The use is still waiting.
  perform public.billing_record_manual_payment('f1800000-0000-0000-0000-000000000011', 2000, 'eft', 'R4-PAUSED-11',
    current_date, null, 'proofs/r4-11.pdf', 'f1a00000-0000-0000-0000-000000000099');
  if app.farm_billing_gate('f1000000-0000-0000-0000-000000000011') <> 'ok' then
    raise exception 'REVIEW4 SETUP [d]: D11 did not come back after paying';
  end if;
  if exists (select 1 from ai_usage where farm_id = 'f1000000-0000-0000-0000-000000000011' and invoice_id is not null) then
    raise exception 'REVIEW4 FAIL [d]: the use from before the pause was billed before the next period';
  end if;

  -- Its next billing date arrives (brought forward to today): the period invoice carries it.
  update billing_subscriptions
     set current_period_start = current_date - 31, current_period_end = current_date - 1, next_billing_on = current_date
   where id = 'f1600000-0000-0000-0000-000000000011';
  if app.generate_billing_invoices('f1600000-0000-0000-0000-000000000011') <> 1 then
    raise exception 'REVIEW4 FAIL [d]: no period invoice on the billing date after resuming';
  end if;
  select * into r from billing_invoices
   where subscription_id = 'f1600000-0000-0000-0000-000000000011' and kind = 'period' and period_start = current_date;
  if r.id is null or coalesce(r.ai_usage_ex_vat_cents, 0) <> 5000 then
    raise exception 'REVIEW4 FAIL [d]: the first period invoice after resuming carries % cents of AI use, expected 5000',
      r.ai_usage_ex_vat_cents;
  end if;
  if exists (select 1 from ai_usage where farm_id = 'f1000000-0000-0000-0000-000000000011'
              and invoice_id is distinct from r.id) then
    raise exception 'REVIEW4 FAIL [d]: the use from before the pause is not stamped on that invoice';
  end if;
end $$;


-- == (e) the first payment of a pending subscription starts its period (money-3) ========
--   E12 reopened 61 days ago, paid its reopen invoice today (years of paid history, so
--       the sweep never touched it)
--   E13 a sign-up invoiced today, paying today: the same dates as the generator wrote
--   E14 reopened 20 days ago owing an older invoice (so no period was raised), pays it today
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000012', 'Review4 Reopened Late', 'complete', 'active', 'monthly', 'r4e12@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000013', 'Review4 Signup Today',  'complete', 'active', 'monthly', 'r4e13@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000014', 'Review4 Reopened Debt', 'complete', 'active', 'monthly', 'r4e14@billing.invalid', false);
-- What app.billing_reopen_subscription writes, as it wrote it on the day it was pressed.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, created_at) values
  ('f1600000-0000-0000-0000-000000000012', 'f1000000-0000-0000-0000-000000000012', 'complete', 'monthly', 'pending',
   null, null, current_date - 61, extract(day from current_date - 61)::int, 1, now() - interval '400 days'),
  ('f1600000-0000-0000-0000-000000000013', 'f1000000-0000-0000-0000-000000000013', 'complete', 'monthly', 'pending',
   null, null, current_date, extract(day from current_date)::int, 1, now()),
  ('f1600000-0000-0000-0000-000000000014', 'f1000000-0000-0000-0000-000000000014', 'complete', 'monthly', 'pending',
   null, null, current_date - 20, extract(day from current_date - 20)::int, 1, now() - interval '400 days');
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000012', 'f1000000-0000-0000-0000-000000000012',
  'f1600000-0000-0000-0000-000000000012', 'R4-E12-OLD', current_date - 230, current_date - 201, current_date - 230);
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
values ('f1000000-0000-0000-0000-000000000012', 'f1800000-0000-0000-0000-000000000012', 2000, 'paystack', 'R4-PAY-E12-OLD', 981000012, 'card');
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000014', 'f1000000-0000-0000-0000-000000000014',
  'f1600000-0000-0000-0000-000000000014', 'R4-E14-DEBT', current_date - 60, current_date - 31, current_date - 60);
do $$
declare inv uuid; r record; before13 record; v_next date; n_before int; n_after int;
begin
  v_next := app.billing_advance_period(current_date, 'monthly', extract(day from current_date)::int);

  -- E12: the reopen invoice, raised on the reopen day (the generator, run as of then).
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000012');
  select id into inv from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000012' and status = 'open';
  if inv is null or app.farm_billing_gate('f1000000-0000-0000-0000-000000000012') <> 'pending' then
    raise exception 'REVIEW4 SETUP [e]: E12 has no reopen invoice to pay, or is not pending';
  end if;
  perform public.billing_record_manual_payment(inv, 2000, 'eft', 'R4-REOPEN-12', current_date, null,
    'proofs/r4-12.pdf', 'f1a00000-0000-0000-0000-000000000099');
  select * into r from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000012';
  if r.status <> 'active' then raise exception 'REVIEW4 SETUP [e]: E12 paid but is %', r.status; end if;
  select count(*) into n_before from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000012';
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000012');
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000012');
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000012');
  select count(*) into n_after from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000012';
  if n_after <> n_before then
    raise exception 'REVIEW4 FAIL [e]: a reopened farm that paid 61 days late was raised % more invoice(s) for months it was locked out (next billing %)',
      n_after - n_before, r.next_billing_on;
  end if;
  if r.current_period_start <> current_date or r.current_period_end <> v_next - 1 or r.next_billing_on <> v_next
     or r.anchor_day <> extract(day from current_date)::int then
    raise exception 'REVIEW4 FAIL [e]: E12''s period is % to % (next %, anchor %), expected a period from today',
      r.current_period_start, r.current_period_end, r.next_billing_on, r.anchor_day;
  end if;

  -- E13: a sign-up paying on the day it was invoiced keeps the generator's dates.
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000013');
  select * into before13 from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000013';
  select id into inv from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000013' and status = 'open';
  perform public.billing_record_manual_payment(inv, 2000, 'eft', 'R4-SIGNUP-13', current_date, null,
    'proofs/r4-13.pdf', 'f1a00000-0000-0000-0000-000000000099');
  select * into r from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000013';
  if r.status <> 'active' or r.current_period_start is distinct from before13.current_period_start
     or r.current_period_end is distinct from before13.current_period_end
     or r.next_billing_on is distinct from before13.next_billing_on
     or r.anchor_day is distinct from before13.anchor_day then
    raise exception 'REVIEW4 FAIL [e]: a sign-up paying the day it was invoiced moved from % to % (next %) to % to % (next %)',
      before13.current_period_start, before13.current_period_end, before13.next_billing_on,
      r.current_period_start, r.current_period_end, r.next_billing_on;
  end if;

  -- E14: the older debt paid today; the first period starts today, not on the reopen day.
  perform public.billing_record_manual_payment('f1800000-0000-0000-0000-000000000014', 2000, 'eft', 'R4-DEBT-14',
    current_date, null, 'proofs/r4-14.pdf', 'f1a00000-0000-0000-0000-000000000099');
  perform app.generate_billing_invoices('f1600000-0000-0000-0000-000000000014');
  select * into r from billing_invoices
   where subscription_id = 'f1600000-0000-0000-0000-000000000014' and id <> 'f1800000-0000-0000-0000-000000000014';
  if r.id is null or r.period_start <> current_date then
    raise exception 'REVIEW4 FAIL [e]: a reopened farm that paid its old debt today was invoiced from % (expected today)', r.period_start;
  end if;
end $$;


-- == (f) reopening (money-5, money-6, money-7) ==========================================
--   F15 lapsed 60 days ago with an anchor a fortnight away from today's day
--   F16 paid to the middle of next month, cancelled at once yesterday, reopens today
--   F17 lapsed, its one open invoice was refunded (open again, deliberately not owed)
--   F18 pending, its only open invoice refunded, renews today (the generator's own rule)
--   F19 lapsed, owes Rapid Rise a once-off service invoice
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000015', 'Review4 Reopen Anchor',   'complete', 'active', 'monthly', 'r4f15@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000016', 'Review4 Reopen Paid',     'complete', 'active', 'monthly', 'r4f16@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000017', 'Review4 Reopen Refunded', 'complete', 'active', 'monthly', 'r4f17@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000018', 'Review4 Pending Refunded','complete', 'active', 'monthly', 'r4f18@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000019', 'Review4 Reopen Service',  'complete', 'active', 'monthly', 'r4f19@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, ended_on, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('f1600000-0000-0000-0000-000000000015', 'f1000000-0000-0000-0000-000000000015', 'complete', 'monthly', 'cancelled',
   current_date - 60, now() - interval '90 days', current_date - 90, current_date - 61, current_date - 60,
   ((extract(day from current_date)::int + 13) % 28) + 1, 1),
  ('f1600000-0000-0000-0000-000000000016', 'f1000000-0000-0000-0000-000000000016', 'complete', 'monthly', 'cancelled',
   current_date - 1, now() - interval '1 day', current_date - 14, current_date + 15, current_date + 16,
   extract(day from current_date + 16)::int, 1),
  ('f1600000-0000-0000-0000-000000000017', 'f1000000-0000-0000-0000-000000000017', 'complete', 'monthly', 'cancelled',
   current_date - 40, now() - interval '70 days', current_date - 70, current_date - 41, current_date - 40,
   extract(day from current_date - 40)::int, 1),
  ('f1600000-0000-0000-0000-000000000018', 'f1000000-0000-0000-0000-000000000018', 'complete', 'monthly', 'pending',
   null, null, null, null, current_date, extract(day from current_date)::int, 1),
  ('f1600000-0000-0000-0000-000000000019', 'f1000000-0000-0000-0000-000000000019', 'complete', 'monthly', 'cancelled',
   current_date - 40, now() - interval '70 days', current_date - 70, current_date - 41, current_date - 40,
   extract(day from current_date - 40)::int, 1);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000015', 'f1000000-0000-0000-0000-000000000015',
  'f1600000-0000-0000-0000-000000000015', 'R4-F15', current_date - 90, current_date - 61, current_date - 90);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000016', 'f1000000-0000-0000-0000-000000000016',
  'f1600000-0000-0000-0000-000000000016', 'R4-F16', current_date - 14, current_date + 15, current_date - 14);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000017', 'f1000000-0000-0000-0000-000000000017',
  'f1600000-0000-0000-0000-000000000017', 'R4-F17', current_date - 70, current_date - 41, current_date - 70);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000018', 'f1000000-0000-0000-0000-000000000018',
  'f1600000-0000-0000-0000-000000000018', 'R4-F18', current_date - 70, current_date - 41, current_date - 70);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000019', 'f1000000-0000-0000-0000-000000000019',
  'f1600000-0000-0000-0000-000000000019', 'R4-F19', current_date - 70, current_date - 41, current_date - 70);
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel) values
  ('f1000000-0000-0000-0000-000000000015', 'f1800000-0000-0000-0000-000000000015',  2000, 'paystack', 'R4-PAY-F15',    981000015, 'card'),
  ('f1000000-0000-0000-0000-000000000016', 'f1800000-0000-0000-0000-000000000016',  2000, 'paystack', 'R4-PAY-F16',    981000016, 'card'),
  ('f1000000-0000-0000-0000-000000000017', 'f1800000-0000-0000-0000-000000000017',  2000, 'paystack', 'R4-PAY-F17',    981000017, 'card'),
  ('f1000000-0000-0000-0000-000000000017', 'f1800000-0000-0000-0000-000000000017', -2000, 'paystack', 'R4-REFUND-F17', 981000117, 'card'),
  ('f1000000-0000-0000-0000-000000000018', 'f1800000-0000-0000-0000-000000000018',  2000, 'paystack', 'R4-PAY-F18',    981000018, 'card'),
  ('f1000000-0000-0000-0000-000000000018', 'f1800000-0000-0000-0000-000000000018', -2000, 'paystack', 'R4-REFUND-F18', 981000118, 'card'),
  ('f1000000-0000-0000-0000-000000000019', 'f1800000-0000-0000-0000-000000000019',  2000, 'paystack', 'R4-PAY-F19',    981000019, 'card');
select public.billing_raise_service_invoice('f1000000-0000-0000-0000-000000000019',
  '[{"description":"Installation visit","qty":1,"unit_price_cents":150000}]'::jsonb, null,
  'f1a00000-0000-0000-0000-000000000099');
do $$
declare i record; r record; v_next date; n int;
begin
  v_next := app.billing_advance_period(current_date, 'monthly', extract(day from current_date)::int);
  if exists (select 1 from billing_invoices where id in ('f1800000-0000-0000-0000-000000000017', 'f1800000-0000-0000-0000-000000000018')
              and status <> 'open') then
    raise exception 'REVIEW4 SETUP [f]: a refunded invoice is not open again';
  end if;

  -- F15: a full month from today, and the anchor with it.
  perform public.billing_reopen_subscription('f1000000-0000-0000-0000-000000000015', null);
  select * into i from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000015' and status = 'open';
  if i.id is null then raise exception 'REVIEW4 FAIL [f]: reopening raised nothing to pay'; end if;
  if i.period_start <> current_date or i.period_end <> v_next - 1
     or (select anchor_day from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000015')
        <> extract(day from current_date)::int then
    raise exception 'REVIEW4 FAIL [f]: the reopen invoice charges a full month for % to % (anchor %), expected to %',
      i.period_start, i.period_end,
      (select anchor_day from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000015'), v_next - 1;
  end if;

  -- F16: inside the paid month, nothing is billed again and the farm is simply back.
  perform public.billing_reopen_subscription('f1000000-0000-0000-0000-000000000016', null);
  if exists (select 1 from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000016'
              and status = 'open' and deleted_at is null) then
    raise exception 'REVIEW4 FAIL [f]: reopened inside a paid month (paid to %) and invoiced again for %',
      current_date + 15,
      (select string_agg(period_start || '..' || period_end, ', ') from billing_invoices
        where subscription_id = 'f1600000-0000-0000-0000-000000000016' and status = 'open');
  end if;
  select * into r from billing_subscriptions where id = 'f1600000-0000-0000-0000-000000000016';
  if r.status <> 'active' or r.next_billing_on <> current_date + 16 or r.current_period_end <> current_date + 15
     or r.ended_on is not null or r.cancelled_at is not null or r.cancel_at_period_end then
    raise exception 'REVIEW4 FAIL [f]: reopened inside a paid month: % (period to %, next %, ended %)',
      r.status, r.current_period_end, r.next_billing_on, r.ended_on;
  end if;
  if app.farm_billing_gate('f1000000-0000-0000-0000-000000000016') <> 'ok' then
    raise exception 'REVIEW4 FAIL [f]: reopened inside a paid month but the gate answers %',
      app.farm_billing_gate('f1000000-0000-0000-0000-000000000016');
  end if;

  -- F17: the refunded invoice is not what is owed; reopening raises the month to pay.
  perform public.billing_reopen_subscription('f1000000-0000-0000-0000-000000000017', null);
  select count(*) into n
    from billing_invoices bi
   where bi.subscription_id = 'f1600000-0000-0000-0000-000000000017' and bi.status = 'open' and bi.kind <> 'service'
     and bi.deleted_at is null and bi.total_incl_cents > bi.amount_paid_cents and bi.period_start = current_date
     and not exists (select 1 from billing_payments p where p.invoice_id = bi.id and p.deleted_at is null and p.amount_incl_cents < 0);
  if n <> 1 or app.farm_billing_gate('f1000000-0000-0000-0000-000000000017') <> 'pending' then
    raise exception 'REVIEW4 FAIL [f]: a reopened farm with an old refunded invoice has % invoice(s) it can pay (gate %)',
      n, app.farm_billing_gate('f1000000-0000-0000-0000-000000000017');
  end if;

  -- F18: the generator's pending rule ignores a refunded invoice too (checkout's fallback).
  if app.generate_billing_invoices('f1600000-0000-0000-0000-000000000018') <> 1 then
    raise exception 'REVIEW4 FAIL [f]: a pending subscription whose only open invoice was refunded was raised nothing to pay';
  end if;

  -- F19: a once-off service invoice is not the month they owe.
  perform public.billing_reopen_subscription('f1000000-0000-0000-0000-000000000019', null);
  if not exists (select 1 from billing_invoices where subscription_id = 'f1600000-0000-0000-0000-000000000019'
                  and kind = 'period' and status = 'open' and period_start = current_date) then
    raise exception 'REVIEW4 FAIL [f]: a reopened farm owing a service invoice was raised no period to pay';
  end if;
end $$;


-- == (g) keeping a farm open only where the gate reads it (app-8) =======================
--   G20 pending sign-up, G21 cancelled and ended, G22 downgraded, G23 suspended (control)
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000020', 'Review4 Keep Pending',    'complete', 'active', 'monthly', 'r4g20@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000021', 'Review4 Keep Closed',     'complete', 'active', 'monthly', 'r4g21@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000022', 'Review4 Keep Downgraded', 'complete', 'active', 'monthly', 'r4g22@billing.invalid', false),
  ('f1000000-0000-0000-0000-000000000023', 'Review4 Keep Suspended',  'complete', 'active', 'monthly', 'r4g23@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, ended_on, cancelled_at,
  current_period_start, current_period_end, next_billing_on, suspended_at) values
  ('f1600000-0000-0000-0000-000000000020', 'f1000000-0000-0000-0000-000000000020', 'complete', 'monthly', 'pending',
   null, null, null, null, current_date, null),
  ('f1600000-0000-0000-0000-000000000021', 'f1000000-0000-0000-0000-000000000021', 'complete', 'monthly', 'cancelled',
   current_date - 10, now() - interval '40 days', current_date - 40, current_date - 11, null, null),
  ('f1600000-0000-0000-0000-000000000022', 'f1000000-0000-0000-0000-000000000022', 'complete', 'monthly', 'downgraded',
   null, null, current_date - 40, current_date - 11, current_date - 10, null),
  ('f1600000-0000-0000-0000-000000000023', 'f1000000-0000-0000-0000-000000000023', 'complete', 'monthly', 'suspended',
   null, null, current_date - 20, current_date + 9, current_date + 10, now());
update farms set status = 'suspended', suspended_for = 'billing' where id = 'f1000000-0000-0000-0000-000000000023';
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000023', 'f1000000-0000-0000-0000-000000000023',
  'f1600000-0000-0000-0000-000000000023', 'R4-G23', current_date - 20, current_date + 9, current_date - 20);
do $$
declare n int; v_state text; v_msg text;
begin
  for n in 20..22 loop
    begin
      perform public.admin_extend_billing_access(('f1000000-0000-0000-0000-0000000000' || n)::uuid, current_date + 7,
        'money on its way', 'f1a00000-0000-0000-0000-000000000099');
      raise exception 'REVIEW4 FAIL [g]: "access extended" was saved for G% (%), which the gate never reads', n,
        (select status from billing_subscriptions where id = ('f1600000-0000-0000-0000-0000000000' || n)::uuid);
    exception when invalid_parameter_value then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_msg is distinct from 'BILLING: only a paused or overdue farm can be kept open' then
        raise exception 'REVIEW4 FAIL [g]: G% was refused with "%" (%), not the mapped sentence', n, v_msg, v_state;
      end if;
    end;
    if (select access_extended_until from billing_subscriptions where id = ('f1600000-0000-0000-0000-0000000000' || n)::uuid) is not null then
      raise exception 'REVIEW4 FAIL [g]: the refused extension was still written for G%', n;
    end if;
  end loop;
  perform public.admin_extend_billing_access('f1000000-0000-0000-0000-000000000023', current_date + 7,
    'money on its way', 'f1a00000-0000-0000-0000-000000000099');
  if app.farm_billing_gate('f1000000-0000-0000-0000-000000000023') <> 'ok' then
    raise exception 'REVIEW4 FAIL [g]: a suspended farm kept open is still refused';
  end if;
end $$;


-- == (h) never claim more than is owed now (app-11) ======================================
--   H24 a sign-up owing R1 000; Rapid Rise records R500 by EFT between checkout's read and
--       its claim
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f1000000-0000-0000-0000-000000000024', 'Review4 Race', 'complete', 'active', 'monthly', 'r4h24@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on) values
  ('f1600000-0000-0000-0000-000000000024', 'f1000000-0000-0000-0000-000000000024', 'complete', 'monthly', 'pending', current_date);
select public._f1_open_invoice('f1800000-0000-0000-0000-000000000024', 'f1000000-0000-0000-0000-000000000024',
  'f1600000-0000-0000-0000-000000000024', 'R4-H24', current_date, current_date + 29, current_date, 100000);
do $$
declare v_read bigint; v_att uuid; v_msg text;
begin
  select total_incl_cents - amount_paid_cents into v_read from billing_invoices where id = 'f1800000-0000-0000-0000-000000000024';
  perform public.billing_record_manual_payment('f1800000-0000-0000-0000-000000000024', 50000, 'eft', 'R4-RACE-24',
    current_date, null, 'proofs/r4-24.pdf', 'f1a00000-0000-0000-0000-000000000099');
  begin
    v_att := app.claim_billing_charge('f1800000-0000-0000-0000-000000000024', 'R4-RACE-REF', 'initial_checkout', v_read);
    raise exception 'REVIEW4 FAIL [h]: a checkout for % cents was claimed on an invoice that now owes %', v_read,
      (select total_incl_cents - amount_paid_cents from billing_invoices where id = 'f1800000-0000-0000-0000-000000000024');
  exception when invalid_parameter_value then
    get stacked diagnostics v_msg = message_text;
    if v_msg is distinct from 'BILLING: the amount owed has changed' then
      raise exception 'REVIEW4 FAIL [h]: the stale claim was refused with "%", not the mapped sentence', v_msg;
    end if;
  end;
  if exists (select 1 from billing_payment_attempts where invoice_id = 'f1800000-0000-0000-0000-000000000024') then
    raise exception 'REVIEW4 FAIL [h]: the refused claim left an attempt behind';
  end if;
  -- Read again, claim again: what is owed now is claimed.
  v_att := app.claim_billing_charge('f1800000-0000-0000-0000-000000000024', 'R4-RACE-REF-2', 'initial_checkout', 50000);
  if v_att is null or (select amount_incl_cents from billing_payment_attempts where id = v_att) <> 50000 then
    raise exception 'REVIEW4 FAIL [h]: the claim for what is owed now was not taken';
  end if;
end $$;

rollback;
