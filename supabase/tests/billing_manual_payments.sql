-- Payments made outside the app (20261029100000): recorded by a named Rapid Rise admin,
-- with proof, never twice, never more than is owed; a sign-up activates and a suspended
-- farm resumes only when the invoice is paid in full; a reversal reopens the invoice.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d6500000-0000-0000-0000-000000000001', 'd6-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d6000000-0000-0000-0000-000000000001', 'Manual Signup',    'complete', 'active', 'monthly', 'm1@billing.invalid', false),
  ('d6000000-0000-0000-0000-000000000002', 'Manual Suspended', 'complete', 'active', 'monthly', 'm2@billing.invalid', false),
  ('d6000000-0000-0000-0000-000000000003', 'Manual InFlight',  'complete', 'active', 'monthly', 'm3@billing.invalid', false);

insert into auth.users (id, email) values
  ('d6a00000-0000-0000-0000-000000000001', 'manual.owner@example.invalid'),
  ('d6a00000-0000-0000-0000-000000000009', 'manual.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d6a00000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 'owner', 'Manual Owner', 'manual.owner@example.invalid', true),
  ('d6a00000-0000-0000-0000-000000000009', null, 'rr_admin', 'Manual RR', 'manual.rr@example.invalid', true);

insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on) values
  ('d6600000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 'complete', 'monthly', 'pending', null, null, null),
  ('d6600000-0000-0000-0000-000000000002', 'd6000000-0000-0000-0000-000000000002', 'complete', 'monthly', 'active', current_date - 10, current_date + 19, current_date + 20),
  ('d6600000-0000-0000-0000-000000000003', 'd6000000-0000-0000-0000-000000000003', 'complete', 'monthly', 'active', current_date, current_date + 29, current_date + 30);

create temp table d6_inv (n int, id uuid, due date) on commit drop;
insert into d6_inv values
  (1, 'd6800000-0000-0000-0000-000000000001', current_date),
  (2, 'd6800000-0000-0000-0000-000000000002', current_date - 10),
  (3, 'd6800000-0000-0000-0000-000000000003', current_date);
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
select i.id, ('d6000000-0000-0000-0000-00000000000' || i.n)::uuid, ('d6600000-0000-0000-0000-00000000000' || i.n)::uuid,
       'D6-INV-' || i.n, 'draft', i.due, i.due + 29, i.due, i.due,
       'complete', 'monthly', 1, 2000, 1, 'd6500000-0000-0000-0000-000000000001', 'd6-synthetic', 0
  from d6_inv i;
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
select i.id, ('d6000000-0000-0000-0000-00000000000' || i.n)::uuid, 0, 'Fleet Wise complete, 1 asset', 1, 1, 2000, 2000, 2000, 0
  from d6_inv i;
update billing_invoices set status = 'open' where id in (select id from d6_inv);

-- M2 is suspended for the overdue invoice; M3 has a card attempt in flight.
select app.billing_apply_suspensions();
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('d6700000-0000-0000-0000-000000000003', 'd6000000-0000-0000-0000-000000000003',
   'AUTH_d6synthetic', 'manual.owner@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_payment_attempts (id, farm_id, invoice_id, subscription_id,
  payment_method_id, attempt_ref, kind, status, amount_incl_cents)
values ('d6a10000-0000-0000-0000-000000000003', 'd6000000-0000-0000-0000-000000000003',
  'd6800000-0000-0000-0000-000000000003', 'd6600000-0000-0000-0000-000000000003',
  'd6700000-0000-0000-0000-000000000003', 'D6-REF-PENDING', 'charge_authorization', 'pending', 2000);

-- == (a) the refusals ==================================================================
do $$
declare
  rr constant uuid := 'd6a00000-0000-0000-0000-000000000009';
  owner constant uuid := 'd6a00000-0000-0000-0000-000000000001';
  inv1 constant uuid := 'd6800000-0000-0000-0000-000000000001';
begin
  begin
    perform public.billing_record_manual_payment(inv1, 2000, 'eft', 'FW-123', current_date, null, 'p/x.pdf', owner);
    raise exception 'MANUAL FAIL [a]: a farm owner recorded their own payment';
  exception when insufficient_privilege then null; end;
  begin
    perform public.billing_record_manual_payment(inv1, 2001, 'eft', 'FW-123', current_date, null, 'p/x.pdf', rr);
    raise exception 'MANUAL FAIL [a]: more than is owed was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_record_manual_payment(inv1, 2000, 'eft', '  ', current_date, null, 'p/x.pdf', rr);
    raise exception 'MANUAL FAIL [a]: no bank reference was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_record_manual_payment(inv1, 2000, 'eft', 'FW-123', current_date + 1, null, 'p/x.pdf', rr);
    raise exception 'MANUAL FAIL [a]: a payment received tomorrow was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_record_manual_payment(inv1, 2000, 'eft', 'FW-123', current_date, null, null, rr);
    raise exception 'MANUAL FAIL [a]: a payment with no proof was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000003', 2000, 'eft', 'FW-999', current_date, null, 'p/x.pdf', rr);
    raise exception 'MANUAL FAIL [a]: a manual payment over a card attempt in flight was accepted';
  exception when invalid_parameter_value then null; end;
  if has_function_privilege('authenticated', 'public.billing_record_manual_payment(uuid,bigint,text,text,date,text,text,uuid)', 'EXECUTE') then
    raise exception 'MANUAL FAIL [a]: a browser session can record a payment directly';
  end if;
end $$;

-- == (b) a sign-up activates only when the invoice is paid in full ======================
do $$
declare rr constant uuid := 'd6a00000-0000-0000-0000-000000000009';
begin
  perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000001', 500, 'eft', 'fw 123', current_date, 'part', 'p/a.pdf', rr);
  if (select status from billing_subscriptions where id = 'd6600000-0000-0000-0000-000000000001') <> 'pending' then
    raise exception 'MANUAL FAIL [b]: a part payment activated the sign-up';
  end if;
  begin
    perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000001', 100, 'eft', 'FW123', current_date, null, 'p/b.pdf', rr);
    raise exception 'MANUAL FAIL [b]: the same bank reference was recorded twice';
  exception when unique_violation then null; end;
  perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000001', 1500, 'eft', 'FW-124', current_date, 'rest', 'p/c.pdf', rr);
  if (select status from billing_invoices where id = 'd6800000-0000-0000-0000-000000000001') <> 'paid' then
    raise exception 'MANUAL FAIL [b]: paid in full but the invoice is not paid';
  end if;
  if (select status from billing_subscriptions where id = 'd6600000-0000-0000-0000-000000000001') <> 'active' then
    raise exception 'MANUAL FAIL [b]: paid in full but the sign-up is not active';
  end if;
  if (select recorded_by from billing_payments where provider_reference = 'MAN-FW-124') is distinct from rr then
    raise exception 'MANUAL FAIL [b]: the payment does not say who recorded it';
  end if;
end $$;

-- == (c) a suspended farm resumes when its EFT is recorded ==============================
do $$
begin
  if app.farm_billing_gate('d6000000-0000-0000-0000-000000000002') <> 'suspended' then
    raise exception 'MANUAL FAIL [c]: the overdue farm is not suspended to begin with';
  end if;
  perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000002', 2000, 'eft', 'M2-EFT', current_date, null, 'p/d.pdf', 'd6a00000-0000-0000-0000-000000000009');
  if app.farm_billing_gate('d6000000-0000-0000-0000-000000000002') <> 'ok' then
    raise exception 'MANUAL FAIL [c]: the farm did not resume on its recorded EFT';
  end if;
end $$;

-- == (d) a reversal reopens the invoice, and the reference can be recorded again ========
do $$
declare v_pay uuid; v_card uuid;
begin
  select id into v_pay from billing_payments where provider_reference = 'MAN-M2-EFT';
  begin
    perform public.billing_reverse_manual_payment(v_pay, '', 'd6a00000-0000-0000-0000-000000000009');
    raise exception 'MANUAL FAIL [d]: a reversal with no reason was accepted';
  exception when invalid_parameter_value then null; end;
  perform public.billing_reverse_manual_payment(v_pay, 'the EFT bounced', 'd6a00000-0000-0000-0000-000000000009');
  if (select status from billing_invoices where id = 'd6800000-0000-0000-0000-000000000002') <> 'open' then
    raise exception 'MANUAL FAIL [d]: a reversed payment left the invoice paid';
  end if;
  -- Not written as a refund: the overdue invoice counts again, so the farm is suspended again.
  if app.farm_overdue_since('d6000000-0000-0000-0000-000000000002') is null then
    raise exception 'MANUAL FAIL [d]: a bounced EFT no longer counts as overdue';
  end if;
  begin
    perform public.billing_reverse_manual_payment(v_pay, 'again', 'd6a00000-0000-0000-0000-000000000009');
    raise exception 'MANUAL FAIL [d]: a payment was reversed twice';
  exception when invalid_parameter_value then null; end;
  perform public.billing_record_manual_payment('d6800000-0000-0000-0000-000000000002', 2000, 'eft', 'M2-EFT', current_date, 'cleared now', 'p/e.pdf', 'd6a00000-0000-0000-0000-000000000009');
end $$;

rollback;
