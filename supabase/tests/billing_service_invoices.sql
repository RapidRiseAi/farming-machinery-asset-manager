-- Once-off service invoices (20261029110000): the sum of their lines, raised only by a
-- named Rapid Rise admin, never charged to a card by the nightly run, never a reason to
-- pause a farm, and payable by a recorded EFT.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('e7000000-0000-0000-0000-000000000001', 'Service Farm', 'complete', 'active', 'monthly', 'svc@billing.invalid', false);
insert into auth.users (id, email) values
  ('e7a00000-0000-0000-0000-000000000001', 'svc.owner@example.invalid'),
  ('e7a00000-0000-0000-0000-000000000009', 'svc.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('e7a00000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'owner', 'Svc Owner', 'svc.owner@example.invalid', true),
  ('e7a00000-0000-0000-0000-000000000009', null, 'rr_admin', 'Svc RR', 'svc.rr@example.invalid', true);
-- An active subscription with a card, so a charge WOULD be taken if the invoice were chargeable.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, current_period_start, current_period_end, next_billing_on)
values ('e7600000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'complete', 'monthly', 'active',
        current_date, current_date + 29, current_date + 30);
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('e7700000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001',
   'AUTH_e7synthetic', 'svc.owner@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
update billing_subscriptions set default_payment_method_id = 'e7700000-0000-0000-0000-000000000001'
 where id = 'e7600000-0000-0000-0000-000000000001';

do $$
declare
  rr constant uuid := 'e7a00000-0000-0000-0000-000000000009';
  v_inv uuid;
  r record;
begin
  -- (a) refusals
  begin
    perform public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001',
      '[{"description":"Training","qty":2,"unit_price_cents":50000}]', null, 'e7a00000-0000-0000-0000-000000000001');
    raise exception 'SERVICE FAIL [a]: a farm owner raised an invoice';
  exception when insufficient_privilege then null; end;
  begin
    perform public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001', '[]', null, rr);
    raise exception 'SERVICE FAIL [a]: an invoice with no lines was raised';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001',
      '[{"description":"Training","qty":0,"unit_price_cents":50000}]', null, rr);
    raise exception 'SERVICE FAIL [a]: a quantity of nothing was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001',
      '[{"description":"Free visit","qty":1,"unit_price_cents":0}]', null, rr);
    raise exception 'SERVICE FAIL [a]: an invoice for nothing was raised';
  exception when invalid_parameter_value then null; end;
  if has_function_privilege('authenticated', 'public.billing_raise_service_invoice(uuid,jsonb,date,uuid)', 'EXECUTE') then
    raise exception 'SERVICE FAIL [a]: a browser session can raise an invoice directly';
  end if;

  -- (b) the invoice is the sum of its lines, with no subscription and no discount
  v_inv := public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001',
    '[{"code":"onboarding","description":"Onboarding and setup","qty":1,"unit_price_cents":150000},
      {"code":"qr_stickers","description":"QR stickers","qty":3,"unit_price_cents":12000}]',
    current_date + 14, rr);
  select * into r from billing_invoices where id = v_inv;
  if r.kind <> 'service' or r.status <> 'open' or r.subscription_id is not null then
    raise exception 'SERVICE FAIL [b]: raised as % / % / sub %', r.kind, r.status, r.subscription_id;
  end if;
  if r.total_incl_cents <> 186000 or r.discount_cents <> 0 then
    raise exception 'SERVICE FAIL [b]: total %, discount %, expected 186000 and 0', r.total_incl_cents, r.discount_cents;
  end if;
  if (select count(*) from billing_invoice_lines where invoice_id = v_inv) <> 2 then
    raise exception 'SERVICE FAIL [b]: the lines were not written';
  end if;

  -- (c) never charged to the card by the nightly run, and never a reason to pause the farm
  update billing_invoices set due_on = current_date - 30 where id = v_inv;
  if exists (select 1 from app.due_billing_charges(100) d where d.invoice_id = v_inv) then
    raise exception 'SERVICE FAIL [c]: the nightly run would charge a service invoice to the card';
  end if;
  if app.farm_overdue_since('e7000000-0000-0000-0000-000000000001') is not null
     or app.farm_billing_gate('e7000000-0000-0000-0000-000000000001') <> 'ok' then
    raise exception 'SERVICE FAIL [c]: an unpaid service invoice would pause the farm';
  end if;

  -- (d) paid by a recorded EFT, without touching the subscription
  perform public.billing_record_manual_payment(v_inv, 186000, 'eft', 'SVC-1', current_date, null, 'p/svc.pdf', rr);
  if (select status from billing_invoices where id = v_inv) <> 'paid' then
    raise exception 'SERVICE FAIL [d]: a service invoice paid in full is not paid';
  end if;
  if (select status from billing_subscriptions where id = 'e7600000-0000-0000-0000-000000000001') <> 'active' then
    raise exception 'SERVICE FAIL [d]: paying a service invoice changed the subscription';
  end if;
end $$;


-- == (e) lines carry the invoice's own VAT rate: none while Rapid Rise is not registered ===
do $$
declare v_inv uuid;
begin
  v_inv := public.billing_raise_service_invoice('e7000000-0000-0000-0000-000000000001',
    '[{"description":"QR stickers","qty":2,"unit_price_cents":11500}]', null, 'e7a00000-0000-0000-0000-000000000009');
  if exists (select 1 from billing_invoice_lines l join billing_invoices i on i.id = l.invoice_id
              where l.invoice_id = v_inv and l.line_vat_cents <> 0 and i.vat_rate_bps = 0) then
    raise exception 'SERVICE FAIL [e]: a line states VAT its invoice does not charge';
  end if;
end $$;

rollback;
