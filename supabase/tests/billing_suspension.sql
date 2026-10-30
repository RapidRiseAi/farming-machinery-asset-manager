-- Seven days' grace, then access stops until the farm pays (20261029090100).
--
-- Farms, each with one subscription and one open invoice unless said otherwise:
--   S1 card farm, invoice due 10 days ago                -> suspended
--   S2 EFT farm (no card), two invoices 10 and 9 days ago -> suspended (no card failure needed)
--   S3 test farm, invoice due 10 days ago                -> ok (billing_exempt)
--   S4 invoice due 5 days ago                            -> ok (inside the grace)
--   S5 invoice due 10 days ago, a card attempt pending   -> ok (a payment in flight)
--   S6 invoice due 10 days ago, refunded                 -> ok (a goodwill refund reopens it)
--   S7 invoice due 10 days ago, access extended          -> ok (Rapid Rise kept it open)
--   S8 Rapid Rise hold (status suspended, no reason)     -> closed
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 'complete', 'monthly', 1111, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000001', 'Suspend Card',     'complete', 'active', 'monthly', 's1@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000002', 'Suspend EFT',      'complete', 'active', 'monthly', 's2@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000003', 'Suspend Test',     'complete', 'active', 'monthly', 's3@billing.invalid', true),
  ('c5000000-0000-0000-0000-000000000004', 'Suspend Grace',    'complete', 'active', 'monthly', 's4@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000005', 'Suspend InFlight', 'complete', 'active', 'monthly', 's5@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000006', 'Suspend Refunded', 'complete', 'active', 'monthly', 's6@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000007', 'Suspend Extended', 'complete', 'active', 'monthly', 's7@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000008', 'Suspend Held',     'complete', 'active', 'monthly', 's8@billing.invalid', false);
-- The migration marks test farms exempt once; a farm created later is marked by hand.
update farms set billing_exempt = true where id = 'c5000000-0000-0000-0000-000000000003';

insert into auth.users (id, email) values
  ('c5a00000-0000-0000-0000-000000000001', 'suspend.owner@example.invalid'),
  ('c5a00000-0000-0000-0000-000000000002', 'suspend.owner2@example.invalid'),
  ('c5a00000-0000-0000-0000-000000000009', 'suspend.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('c5a00000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001', 'owner', 'Suspend Owner', 'suspend.owner@example.invalid', true),
  ('c5a00000-0000-0000-0000-000000000002', 'c5000000-0000-0000-0000-000000000002', 'owner', 'Suspend Owner Two', 'suspend.owner2@example.invalid', true),
  ('c5a00000-0000-0000-0000-000000000009', null, 'rr_admin', 'Suspend RR', 'suspend.rr@example.invalid', true);

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on)
select ('c5600000-0000-0000-0000-00000000000' || n)::uuid, ('c5000000-0000-0000-0000-00000000000' || n)::uuid,
       'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20
  from generate_series(1, 8) n;

insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('c5700000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001',
   'AUTH_c5synthetic', 'suspend.owner@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active'),
  ('c5700000-0000-0000-0000-000000000005', 'c5000000-0000-0000-0000-000000000005',
   'AUTH_c5synthetic5', 'suspend.owner@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
update billing_subscriptions set default_payment_method_id = 'c5700000-0000-0000-0000-000000000001'
 where id = 'c5600000-0000-0000-0000-000000000001';
update billing_subscriptions set default_payment_method_id = 'c5700000-0000-0000-0000-000000000005'
 where id = 'c5600000-0000-0000-0000-000000000005';

-- One open invoice per farm (S2 gets a second below), written draft -> line -> open.
create temp table c5_inv (n int, id uuid, due date) on commit drop;
insert into c5_inv values
  (1, 'c5800000-0000-0000-0000-000000000001', current_date - 10),
  (2, 'c5800000-0000-0000-0000-000000000002', current_date - 10),
  (3, 'c5800000-0000-0000-0000-000000000003', current_date - 10),
  (4, 'c5800000-0000-0000-0000-000000000004', current_date - 5),
  (5, 'c5800000-0000-0000-0000-000000000005', current_date - 10),
  (6, 'c5800000-0000-0000-0000-000000000006', current_date - 10),
  (7, 'c5800000-0000-0000-0000-000000000007', current_date - 10),
  (8, 'c5800000-0000-0000-0000-000000000008', current_date - 10),
  (2, 'c5800000-0000-0000-0000-000000000012', current_date - 9);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
select i.id, ('c5000000-0000-0000-0000-00000000000' || i.n)::uuid, ('c5600000-0000-0000-0000-00000000000' || i.n)::uuid,
       'C5-INV-' || substr(i.id::text, 33), 'draft', i.due, i.due + 29, i.due, i.due,
       'complete', 'monthly', 1, 1111, 1, 'c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 0
  from c5_inv i;
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
select i.id, ('c5000000-0000-0000-0000-00000000000' || i.n)::uuid, 0, 'Fleet Wise complete, 1 asset', 1, 1, 1111, 1111, 1111, 0
  from c5_inv i;
update billing_invoices set status = 'open' where id in (select id from c5_inv);

-- S5: a card attempt still pending. S6: paid and then refunded. S7: extended. S8: held.
insert into billing_payment_attempts (id, farm_id, invoice_id, subscription_id,
  payment_method_id, attempt_ref, kind, status, amount_incl_cents)
values ('c5a10000-0000-0000-0000-000000000005', 'c5000000-0000-0000-0000-000000000005',
  'c5800000-0000-0000-0000-000000000005', 'c5600000-0000-0000-0000-000000000005',
  'c5700000-0000-0000-0000-000000000005', 'C5-REF-PENDING', 'charge_authorization', 'pending', 1111);
insert into billing_payments (id, farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel) values
  ('c5a20000-0000-0000-0000-000000000006', 'c5000000-0000-0000-0000-000000000006', 'c5800000-0000-0000-0000-000000000006', 1111, 'paystack', 'C5-PAID-6', 955000006, 'card'),
  ('c5a20000-0000-0000-0000-000000000016', 'c5000000-0000-0000-0000-000000000006', 'c5800000-0000-0000-0000-000000000006', -1111, 'paystack', 'C5-REFUND-6', 955000016, 'card');
update billing_subscriptions set access_extended_until = current_date + 5, access_extension_reason = 'money on its way'
 where id = 'c5600000-0000-0000-0000-000000000007';
update farms set status = 'suspended' where id = 'c5000000-0000-0000-0000-000000000008';

-- == (a) the gate ======================================================================
do $$
declare
  want text[] := array['suspended', 'suspended', 'ok', 'ok', 'ok', 'ok', 'ok', 'closed'];
  got text; n int;
begin
  for n in 1..8 loop
    got := app.farm_billing_gate(('c5000000-0000-0000-0000-00000000000' || n)::uuid);
    if got is distinct from want[n] then
      raise exception 'SUSPEND FAIL [a]: farm S% gate is %, expected %', n, got, want[n];
    end if;
  end loop;
end $$;

-- == (b) the engine suspends exactly S1 and S2, once, and tells them ===================
do $$
declare v int; v2 int; f record;
begin
  v := app.billing_apply_suspensions();
  if v <> 2 then raise exception 'SUSPEND FAIL [b]: suspended % farms, expected 2', v; end if;
  for f in select id, status, suspended_for from farms where id in
           ('c5000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000002') loop
    if f.status <> 'suspended' or f.suspended_for is distinct from 'billing' then
      raise exception 'SUSPEND FAIL [b]: farm % is % / %', f.id, f.status, f.suspended_for;
    end if;
  end loop;
  if exists (select 1 from billing_subscriptions where id in ('c5600000-0000-0000-0000-000000000001',
             'c5600000-0000-0000-0000-000000000002') and (status <> 'suspended' or suspended_at is null)) then
    raise exception 'SUSPEND FAIL [b]: a subscription was not marked suspended';
  end if;
  if (select status from farms where id = 'c5000000-0000-0000-0000-000000000004') <> 'active' then
    raise exception 'SUSPEND FAIL [b]: a farm inside the grace was suspended';
  end if;
  if not exists (select 1 from notifications where farm_id = 'c5000000-0000-0000-0000-000000000001'
                 and template = 'billing_suspended') then
    raise exception 'SUSPEND FAIL [b]: the owner was not told the farm is suspended';
  end if;
  v2 := app.billing_apply_suspensions();
  if v2 <> 0 then raise exception 'SUSPEND FAIL [b]: a second run suspended % again', v2; end if;
  -- The farm-status lever: a suspended farm is no longer 'trial' or 'active', which is what
  -- the API token, WhatsApp, capture and notification checks read.
  if exists (select 1 from farms where id = 'c5000000-0000-0000-0000-000000000001' and status in ('trial', 'active')) then
    raise exception 'SUSPEND FAIL [b]: the suspended farm still reads as live';
  end if;
end $$;

-- == (c) nothing is invoiced while suspended; the card is still tried weekly ============
do $$
declare before_n int; after_n int; r record;
begin
  update billing_subscriptions set next_billing_on = current_date where id = 'c5600000-0000-0000-0000-000000000001';
  select count(*) into before_n from billing_invoices where farm_id = 'c5000000-0000-0000-0000-000000000001';
  perform app.generate_billing_invoices(null);
  select count(*) into after_n from billing_invoices where farm_id = 'c5000000-0000-0000-0000-000000000001';
  if after_n <> before_n then raise exception 'SUSPEND FAIL [c]: a suspended farm was invoiced'; end if;
  update billing_subscriptions set next_billing_on = current_date + 20 where id = 'c5600000-0000-0000-0000-000000000001';

  if exists (select 1 from app.due_billing_charges(100) d where d.farm_id = 'c5000000-0000-0000-0000-000000000001') then
    raise exception 'SUSPEND FAIL [c]: the card was retried before its weekly date';
  end if;
  update billing_subscriptions set next_retry_on = current_date where id = 'c5600000-0000-0000-0000-000000000001';
  if not exists (select 1 from app.due_billing_charges(100) d where d.farm_id = 'c5000000-0000-0000-0000-000000000001') then
    raise exception 'SUSPEND FAIL [c]: a suspended farm''s card is never tried again';
  end if;
  perform app.billing_register_failure('c5600000-0000-0000-0000-000000000001', 'declined');
  select status, next_retry_on into r from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000001';
  if r.status <> 'suspended' or r.next_retry_on <> current_date + 7 then
    raise exception 'SUSPEND FAIL [c]: a failed weekly retry left % / %', r.status, r.next_retry_on;
  end if;
end $$;

-- == (d) paying one of two overdue invoices does not reopen the farm ===================
do $$
begin
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
  values ('c5000000-0000-0000-0000-000000000002', 'c5800000-0000-0000-0000-000000000002', 1111, 'paystack', 'C5-PAY-2A', 955000002, 'card');
  perform app.billing_restore_after_payment('c5600000-0000-0000-0000-000000000002');
  if (select status from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000002') <> 'suspended'
     or (select status from farms where id = 'c5000000-0000-0000-0000-000000000002') <> 'suspended' then
    raise exception 'SUSPEND FAIL [d]: one of two overdue invoices paid reopened the farm';
  end if;
end $$;

-- == (e) paying what is overdue brings it back, with a fresh period from today ==========
do $$
declare r record; v_next date;
begin
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
  values ('c5000000-0000-0000-0000-000000000002', 'c5800000-0000-0000-0000-000000000012', 1111, 'paystack', 'C5-PAY-2B', 955000012, 'card');
  perform app.billing_restore_after_payment('c5600000-0000-0000-0000-000000000002');
  select * into r from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000002';
  v_next := app.billing_advance_period(current_date, 'monthly', extract(day from current_date)::int);
  if r.status <> 'active' or r.suspended_at is not null then
    raise exception 'SUSPEND FAIL [e]: paid in full but still %', r.status;
  end if;
  if r.current_period_start <> current_date or r.next_billing_on <> v_next or r.current_period_end <> v_next - 1 then
    raise exception 'SUSPEND FAIL [e]: the period was not re-anchored to today (% to %, next %)',
      r.current_period_start, r.current_period_end, r.next_billing_on;
  end if;
  if (select status from farms where id = 'c5000000-0000-0000-0000-000000000002') <> 'active'
     or (select suspended_for from farms where id = 'c5000000-0000-0000-0000-000000000002') is not null then
    raise exception 'SUSPEND FAIL [e]: the farm did not come back';
  end if;
  if app.farm_billing_gate('c5000000-0000-0000-0000-000000000002') <> 'ok' then
    raise exception 'SUSPEND FAIL [e]: the gate still refuses a farm that paid';
  end if;
  if not exists (select 1 from notifications where farm_id = 'c5000000-0000-0000-0000-000000000002'
                 and template = 'billing_resumed') then
    raise exception 'SUSPEND FAIL [e]: the farm was not told it is back';
  end if;
end $$;

-- == (f) only a Rapid Rise admin may extend access, and it lifts the suspension =========
do $$
begin
  begin
    perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000001', current_date + 3,
      'asked nicely', 'c5a00000-0000-0000-0000-000000000001');
    raise exception 'SUSPEND FAIL [f]: a farm owner extended their own access';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000001', current_date + 90,
      'too long', 'c5a00000-0000-0000-0000-000000000009');
    raise exception 'SUSPEND FAIL [f]: an extension of 90 days was accepted';
  exception when invalid_parameter_value then null;
  end;
  perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000001', current_date + 3,
    'EFT on its way, bank confirmed', 'c5a00000-0000-0000-0000-000000000009');
  if app.farm_billing_gate('c5000000-0000-0000-0000-000000000001') <> 'ok' then
    raise exception 'SUSPEND FAIL [f]: an extended farm is still refused';
  end if;
  if (select access_extended_by from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000001')
     is distinct from 'c5a00000-0000-0000-0000-000000000009' then
    raise exception 'SUSPEND FAIL [f]: the extension does not say who gave it';
  end if;
  if has_function_privilege('authenticated', 'public.admin_extend_billing_access(uuid,date,text,uuid)', 'EXECUTE') then
    raise exception 'SUSPEND FAIL [f]: a browser session can call the extension directly';
  end if;
end $$;

-- == (g) an exempt farm is never suspended by the engine, whatever it owes ============
do $$
begin
  perform app.billing_apply_suspensions();
  if (select status from farms where id = 'c5000000-0000-0000-0000-000000000003') <> 'active' then
    raise exception 'SUSPEND FAIL [g]: a test farm was suspended';
  end if;
end $$;


-- == (h) suspended over a small AI invoice, the year already paid: the renewal is NOT moved
--        to today, only on by the days suspended (review of 20261029090100) ================
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000009', 'Suspend Annual', 'complete', 'active', 'annual', 's9@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('c5600000-0000-0000-0000-000000000009', 'c5000000-0000-0000-0000-000000000009', 'complete', 'annual', 'active',
   current_date - 300, current_date + 64, current_date + 65, extract(day from current_date + 65)::int);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('c5800000-0000-0000-0000-000000000009', 'c5000000-0000-0000-0000-000000000009',
  'c5600000-0000-0000-0000-000000000009', 'C5-AI-9', 'draft', 'ai_usage',
  current_date - 40, current_date - 11, current_date - 13, current_date - 13,
  'complete', 'annual', 0, 0, 1, null, 'AI and voice use', 0);
update billing_invoices set ai_usage_ex_vat_cents = 5000 where id = 'c5800000-0000-0000-0000-000000000009';
update billing_invoices set status = 'open' where id = 'c5800000-0000-0000-0000-000000000009';
do $$
declare r record;
begin
  perform app.billing_apply_suspensions();
  if (select status from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000009') <> 'suspended' then
    raise exception 'SUSPEND FAIL [h]: the annual farm was not suspended over its AI invoice';
  end if;
  -- It has been suspended for ten days when it pays.
  update billing_subscriptions set suspended_at = now() - interval '10 days' where id = 'c5600000-0000-0000-0000-000000000009';
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
  values ('c5000000-0000-0000-0000-000000000009', 'c5800000-0000-0000-0000-000000000009',
          (select total_incl_cents from billing_invoices where id = 'c5800000-0000-0000-0000-000000000009'),
          'paystack', 'C5-PAY-9', 955000009, 'card');
  perform app.billing_restore_after_payment('c5600000-0000-0000-0000-000000000009');
  select * into r from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000009';
  if r.status <> 'active' then raise exception 'SUSPEND FAIL [h]: paid the AI invoice but still %', r.status; end if;
  if r.current_period_start <> current_date - 300 or r.current_period_end <> current_date + 74
     or r.next_billing_on <> current_date + 75 or r.anchor_day <> extract(day from current_date + 75)::int then
    raise exception 'SUSPEND FAIL [h]: the paid year was moved (% to %, next %), expected only ten days on',
      r.current_period_start, r.current_period_end, r.next_billing_on;
  end if;
end $$;

-- == (i) an invoice not yet past its grace does not keep a paid farm locked ===============
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000010', 'Suspend Upcoming', 'complete', 'active', 'monthly', 's10@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('c5600000-0000-0000-0000-000000000010', 'c5000000-0000-0000-0000-000000000010', 'complete', 'monthly', 'active',
   current_date - 2, current_date + 27, current_date + 28);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values
  ('c5800000-0000-0000-0000-000000000010', 'c5000000-0000-0000-0000-000000000010', 'c5600000-0000-0000-0000-000000000010',
   'C5-SLOTS-10', 'draft', 'slots', current_date - 20, current_date - 20, current_date - 20, current_date - 10,
   'complete', 'monthly', 1, 1111, 1, 'c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 0),
  ('c5800000-0000-0000-0000-000000000011', 'c5000000-0000-0000-0000-000000000010', 'c5600000-0000-0000-0000-000000000010',
   'C5-PERIOD-10', 'draft', 'period', current_date - 2, current_date + 27, current_date - 2, current_date + 5,
   'complete', 'monthly', 1, 1111, 1, 'c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
select id, 'c5000000-0000-0000-0000-000000000010', 0, 'line', 1, 1, 1111, 1111, 1111, 0
  from billing_invoices where id in ('c5800000-0000-0000-0000-000000000010', 'c5800000-0000-0000-0000-000000000011');
update billing_invoices set status = 'open' where id in ('c5800000-0000-0000-0000-000000000010', 'c5800000-0000-0000-0000-000000000011');
do $$
begin
  perform app.billing_apply_suspensions();
  insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
  values ('c5000000-0000-0000-0000-000000000010', 'c5800000-0000-0000-0000-000000000010', 1111, 'paystack', 'C5-PAY-10', 955000010, 'card');
  perform app.billing_restore_after_payment('c5600000-0000-0000-0000-000000000010');
  if app.farm_billing_gate('c5000000-0000-0000-0000-000000000010') <> 'ok' then
    raise exception 'SUSPEND FAIL [i]: a farm that paid what was overdue stays locked over an invoice due in five days';
  end if;
end $$;

-- == (j) extending access moves the period on, so the suspended weeks are never invoiced ==
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000011', 'Suspend Hospital', 'complete', 'active', 'monthly', 's11@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('c5600000-0000-0000-0000-000000000011', 'c5000000-0000-0000-0000-000000000011', 'complete', 'monthly', 'active',
   current_date - 70, current_date - 41, current_date - 40, extract(day from current_date - 40)::int);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('c5800000-0000-0000-0000-000000000013', 'c5000000-0000-0000-0000-000000000011', 'c5600000-0000-0000-0000-000000000011',
   'C5-PERIOD-11', 'draft', 'period', current_date - 70, current_date - 41, current_date - 70, current_date - 63,
   'complete', 'monthly', 1, 1111, 1, 'c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('c5800000-0000-0000-0000-000000000013', 'c5000000-0000-0000-0000-000000000011', 0, 'line', 1, 1, 1111, 1111, 1111, 0);
update billing_invoices set status = 'open' where id = 'c5800000-0000-0000-0000-000000000013';
do $$
declare before_n int; after_n int; r record;
begin
  perform app.billing_apply_suspensions();
  -- Suspended since day 8 after its due date: 55 days ago.
  update billing_subscriptions set suspended_at = now() - interval '55 days' where id = 'c5600000-0000-0000-0000-000000000011';
  perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000011', current_date + 14,
    'farmer in hospital', 'c5a00000-0000-0000-0000-000000000009');
  select * into r from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000011';
  if r.next_billing_on <> current_date + 15 or r.current_period_end <> current_date + 14 then
    raise exception 'SUSPEND FAIL [j]: the extension did not move the period on by 55 days (end %, next %)', r.current_period_end, r.next_billing_on;
  end if;
  select count(*) into before_n from billing_invoices where farm_id = 'c5000000-0000-0000-0000-000000000011';
  perform app.generate_billing_invoices(null);
  perform app.generate_billing_invoices(null);
  select count(*) into after_n from billing_invoices where farm_id = 'c5000000-0000-0000-0000-000000000011';
  if after_n <> before_n then raise exception 'SUSPEND FAIL [j]: the suspended weeks were invoiced after the extension'; end if;
  if r.anchor_day <> extract(day from current_date + 15)::int then
    raise exception 'SUSPEND FAIL [j]: the anchor did not move with the period (%)', r.anchor_day;
  end if;
  -- The generator ends a period at billing_advance_period(start, period, anchor_day) - 1.
  -- With the anchor moved, the period starting on the moved billing date is a FULL month;
  -- with the old anchor it was cut short and the compensation vanished.
  if app.billing_advance_period(r.next_billing_on, 'monthly', r.anchor_day)
     <> (r.next_billing_on + interval '1 month')::date then
    raise exception 'SUSPEND FAIL [j]: the period from the moved date ends % (anchor %), not a full month later',
      app.billing_advance_period(r.next_billing_on, 'monthly', r.anchor_day), r.anchor_day;
  end if;
end $$;


-- == (k) a same-day extension keeps a month-end anchor; a cancelled farm stays non_renewing
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000012', 'Suspend MonthEnd', 'complete', 'active', 'monthly', 's12@billing.invalid', false),
  ('c5000000-0000-0000-0000-000000000013', 'Suspend Cancelled', 'complete', 'active', 'monthly', 's13@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, suspended_at, cancel_at_period_end) values
  ('c5600000-0000-0000-0000-000000000012', 'c5000000-0000-0000-0000-000000000012', 'complete', 'monthly', 'suspended',
   date '2027-01-31', date '2027-02-27', date '2027-02-28', 31, now(), false),
  ('c5600000-0000-0000-0000-000000000013', 'c5000000-0000-0000-0000-000000000013', 'complete', 'monthly', 'suspended',
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date + 20)::int, now(), true);
update farms set status = 'suspended', suspended_for = 'billing'
 where id in ('c5000000-0000-0000-0000-000000000012', 'c5000000-0000-0000-0000-000000000013');
do $$
begin
  perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000012', current_date + 3, 'bank confirmed', 'c5a00000-0000-0000-0000-000000000009');
  if (select anchor_day from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000012') <> 31 then
    raise exception 'SUSPEND FAIL [k]: a same-day extension moved a month-end anchor to %',
      (select anchor_day from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000012');
  end if;
  perform public.admin_extend_billing_access('c5000000-0000-0000-0000-000000000013', current_date + 3, 'bank confirmed', 'c5a00000-0000-0000-0000-000000000009');
  if (select status from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000013') <> 'non_renewing' then
    raise exception 'SUSPEND FAIL [k]: an extended farm that had cancelled became %',
      (select status from billing_subscriptions where id = 'c5600000-0000-0000-0000-000000000013');
  end if;
end $$;

-- == (l) a pending subscription with only PAID invoices behind it (a reopened farm) is
--        raised an invoice to pay; one with an open invoice is not raised a second ========
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('c5000000-0000-0000-0000-000000000014', 'Suspend Reopened', 'complete', 'active', 'monthly', 's14@billing.invalid', false);
insert into machines (farm_id, name, type, status)
values ('c5000000-0000-0000-0000-000000000014', 'Reopened bakkie', 'bakkie', 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('c5600000-0000-0000-0000-000000000014', 'c5000000-0000-0000-0000-000000000014', 'complete', 'monthly', 'pending',
   null, null, current_date, extract(day from current_date)::int, 1);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('c5800000-0000-0000-0000-000000000014', 'c5000000-0000-0000-0000-000000000014', 'c5600000-0000-0000-0000-000000000014',
  'C5-OLD-14', 'draft', 'period', current_date - 400, current_date - 371, current_date - 400, current_date - 393,
  'complete', 'monthly', 1, 1111, 1, 'c5500000-0000-0000-0000-000000000001', 'c5-synthetic', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('c5800000-0000-0000-0000-000000000014', 'c5000000-0000-0000-0000-000000000014', 0, 'line', 1, 1, 1111, 1111, 1111, 0);
update billing_invoices set status = 'open' where id = 'c5800000-0000-0000-0000-000000000014';
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
values ('c5000000-0000-0000-0000-000000000014', 'c5800000-0000-0000-0000-000000000014', 1111, 'paystack', 'C5-OLD-PAY-14', 955000014, 'card');
do $$
declare n int;
begin
  perform app.generate_billing_invoices('c5600000-0000-0000-0000-000000000014');
  select count(*) into n from billing_invoices
   where subscription_id = 'c5600000-0000-0000-0000-000000000014' and status = 'open' and deleted_at is null;
  if n <> 1 then
    raise exception 'SUSPEND FAIL [l]: a reopened farm with only paid invoices was raised % invoice(s) to pay, expected 1', n;
  end if;
  update billing_subscriptions set next_billing_on = current_date where id = 'c5600000-0000-0000-0000-000000000014';
  perform app.generate_billing_invoices('c5600000-0000-0000-0000-000000000014');
  select count(*) into n from billing_invoices
   where subscription_id = 'c5600000-0000-0000-0000-000000000014' and status = 'open' and deleted_at is null;
  if n <> 1 then
    raise exception 'SUSPEND FAIL [l]: a pending subscription with an open invoice was invoiced again (% open)', n;
  end if;
end $$;

rollback;
