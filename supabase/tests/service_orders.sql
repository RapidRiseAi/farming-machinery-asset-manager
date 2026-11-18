\set ON_ERROR_STOP on
-- Done-For-You agreements, the activation catalogue as orders, and the work and review record
-- (20261120100000). BRIEF section 18 and scenario 43: optional orders priced by the agreed rules
-- (per-asset minimums, hourly work, on-site training from R3,500 plus travel), no stacking of
-- clean import and document capture for the same work, QR kits never orderable until a
-- supplier quote is recorded and the item is marked ready, acceptance before any invoice, one
-- invoice for exactly the accepted amount; a managed-service agreement with explicit prices, the
-- floors, owner acceptance of the total, landing at the renewal through the ordinary invoice run,
-- the plan-change guard, ending at renewal; legacy quotes untouched; who reads what.
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

create or replace function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;

-- == Fixtures ===================================================================================
insert into public.farms (id, name, plan, status, billing_period) values
  ('a4500000-0000-4000-9000-000000000001', 'Managed yard',  'complete',  'active', 'monthly'),
  ('a4500000-0000-4000-9000-000000000002', 'Other yard',    'essential', 'active', 'monthly'),
  ('a4500000-0000-4000-9000-000000000003', 'Late yard',     'essential', 'active', 'monthly'),
  ('a4500000-0000-4000-9000-000000000004', 'Depot',         'complete',  'active', 'monthly');
update public.farms set billed_through = 'a4500000-0000-4000-9000-000000000001'
 where id = 'a4500000-0000-4000-9000-000000000004';
update public.farms set is_test = true where id = 'a4500000-0000-4000-9000-000000000002';

insert into auth.users (id, email)
select ('a4510000-0000-4000-9000-00000000000' || n)::uuid, 'svc' || n || '@service.test' from generate_series(1, 7) n;
insert into public.users (id, farm_id, role, name, email, active, is_test) values
  ('a4510000-0000-4000-9000-000000000001', 'a4500000-0000-4000-9000-000000000001', 'owner',    'Owner',        'svc1@service.test', true, false),
  ('a4510000-0000-4000-9000-000000000002', 'a4500000-0000-4000-9000-000000000001', 'manager',  'Manager',      'svc2@service.test', true, false),
  ('a4510000-0000-4000-9000-000000000003', 'a4500000-0000-4000-9000-000000000002', 'owner',    'Other owner',  'svc3@service.test', true, true),
  ('a4510000-0000-4000-9000-000000000004', 'a4500000-0000-4000-9000-000000000003', 'owner',    'Late owner',   'svc4@service.test', true, false),
  ('a4510000-0000-4000-9000-000000000005', null,                                   'rr_admin', 'Rapid Rise',   'svc5@service.test', true, false),
  ('a4510000-0000-4000-9000-000000000006', null,                                   'rr_admin', 'Test admin',   'svc6@service.test', true, true);

insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('a4560000-0000-4000-9000-000000000001', 'a4500000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', 20, 0,
   current_date - 20, current_date + 9, current_date + 10, extract(day from current_date - 20)::int),
  ('a4560000-0000-4000-9000-000000000002', 'a4500000-0000-4000-9000-000000000002', 'essential', 'monthly', 'active', 5, 0,
   current_date - 20, current_date + 9, current_date + 10, extract(day from current_date - 20)::int),
  ('a4560000-0000-4000-9000-000000000003', 'a4500000-0000-4000-9000-000000000003', 'essential', 'monthly', 'past_due', 5, 0,
   current_date - 20, current_date + 9, current_date + 10, extract(day from current_date - 20)::int);

-- Twenty full assets and eight pieces of equipment: what the managed quote below assumes.
insert into public.machines (id, farm_id, name, type, public_token)
select ('a4520000-0000-4000-9000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'a4500000-0000-4000-9000-000000000001',
       'Truck ' || n, 'truck', gen_random_uuid()
  from generate_series(1, 20) n;
insert into public.machines (id, farm_id, name, type, profile, public_token)
select ('a4530000-0000-4000-9000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'a4500000-0000-4000-9000-000000000001',
       'Pump ' || n, 'pump_generator', 'equipment', gen_random_uuid()
  from generate_series(1, 8) n;

-- == [1] The catalogue's arithmetic =============================================================
do $t$
begin
  if app.service_order_price('clean_setup', 3, null, 0) <> 75000 then raise exception '[1] clean setup minimum R750 not applied'; end if;
  if app.service_order_price('clean_setup', 12, null, 0) <> 180000 then raise exception '[1] clean setup 12 assets is not R1,800'; end if;
  if app.service_order_price('document_capture', 4, null, 0) <> 150000 then raise exception '[1] capture minimum R1,500 not applied'; end if;
  if app.service_order_price('document_capture', 6, null, 0) <> 180000 then raise exception '[1] capture 6 assets is not R1,800'; end if;
  if app.service_order_price('historical_work', 1.5, null, 0) <> 75000 then raise exception '[1] 1.5 hours is not R750'; end if;
  if app.service_order_price('remote_training', 2, null, 0) <> 100000 then raise exception '[1] two hours of training is not R1,000'; end if;
  if app.service_order_price('onsite_training', 1, 350000, 80000) <> 430000 then raise exception '[1] on-site R3,500 plus R800 travel is not R4,300'; end if;
  if pg_temp.try($s$select app.service_order_price('onsite_training', 1, 349999, 0)$s$) <> 'service-below-minimum' then
    raise exception '[1] on-site training below R3,500 was priced';
  end if;
  if pg_temp.try($s$select app.service_order_price('historical_work', 1.3, null, 0)$s$) <> 'service-invalid' then
    raise exception '[1] an hour that is not a quarter hour was priced';
  end if;
  if pg_temp.try($s$select app.service_order_price('clean_setup', 2.5, null, 0)$s$) <> 'service-below-minimum' then
    raise exception '[1] half an asset was priced';
  end if;
  if pg_temp.try($s$select app.service_order_price('clean_setup', 5, null, 1000)$s$) <> 'service-invalid' then
    raise exception '[1] travel was added to a per-asset service';
  end if;
  if pg_temp.try($s$select app.service_order_price('installation', 1, 100000, 0)$s$) <> 'service-not-orderable' then
    raise exception '[1] a per-case code was orderable';
  end if;
  -- No QR kit tariff until a supplier quote is recorded and Rapid Rise marks it ready.
  if pg_temp.try($s$select app.service_order_price('qr_kits', 10, null, 0)$s$) <> 'service-not-ready' then
    raise exception '[1] QR kits were priced before they were ready';
  end if;
  if pg_temp.try($s$update public.billing_service_catalogue set ready = true where code = 'qr_kits'$s$) = 'ok' then
    raise exception '[1] QR kits were marked ready without a supplier quote';
  end if;
  if (select count(*) from public.billing_service_catalogue
       where code in ('onboarding', 'training', 'qr_stickers') and active) <> 0 then
    raise exception '[1] a superseded per-case code is still offered';
  end if;
  if not (select active from public.billing_service_catalogue where code = 'installation') then
    raise exception '[1] the installation code was switched off';
  end if;
end $t$;

-- == [2] Orders: offered by Rapid Rise, accepted by the owner, invoiced once =======================
do $t$
declare
  v_order uuid;
  v_again uuid;
  v_invoice uuid;
  v_total bigint;
begin
  -- A test account is never Rapid Rise.
  if pg_temp.try($s$select public.service_order_offer('a4510000-0000-4000-9000-000000000006',
       'a4500000-0000-4000-9000-000000000001', gen_random_uuid(), 'clean_setup', 12, null, 0,
       'Import the fleet list', 'Remote, within ten working days', null, 'initial fleet', null, app.billing_today() + 14)$s$) <> 'forbidden' then
    raise exception '[2] a test admin offered an order';
  end if;
  v_order := public.service_order_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
    'a4540000-0000-4000-9000-000000000001', 'clean_setup', 12, null, 0,
    'Import the fleet list', 'Remote, within ten working days', null, 'initial fleet', null, app.billing_today() + 14);
  v_again := public.service_order_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
    'a4540000-0000-4000-9000-000000000001', 'clean_setup', 12, null, 0,
    'Import the fleet list', 'Remote, within ten working days', null, 'initial fleet', null, app.billing_today() + 14);
  if v_again <> v_order then raise exception '[2] a repeated offer made a second order'; end if;
  if (select amount_incl_cents from public.service_orders where id = v_order) <> 180000 then
    raise exception '[2] the order does not carry the rule amount';
  end if;
  if (select vat_rate_bps from public.service_orders where id = v_order) <> 0 then
    raise exception '[2] VAT was added while the seller is not registered';
  end if;

  -- Not stacked: the same work under document capture, or the same assets.
  if pg_temp.try($s$select public.service_order_offer('a4510000-0000-4000-9000-000000000005',
       'a4500000-0000-4000-9000-000000000001', gen_random_uuid(), 'document_capture', 12, null, 0,
       'Capture from photos', 'Remote', null, ' Initial Fleet ', null, app.billing_today() + 14)$s$) <> 'service-overlap' then
    raise exception '[2] document capture was stacked on the clean import of the same work';
  end if;
  perform public.service_order_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
    'a4540000-0000-4000-9000-000000000002', 'document_capture', 2, null, 0, 'Two old trucks from their papers', 'Remote', null,
    'old trucks', array['a4520000-0000-4000-9000-000000000001'::uuid, 'a4520000-0000-4000-9000-000000000002'::uuid],
    app.billing_today() + 14);
  if pg_temp.try($s$select public.service_order_offer('a4510000-0000-4000-9000-000000000005',
       'a4500000-0000-4000-9000-000000000001', gen_random_uuid(), 'clean_setup', 1, null, 0,
       'One truck', 'Remote', null, 'another name', array['a4520000-0000-4000-9000-000000000002'::uuid], app.billing_today() + 14)$s$) <> 'service-overlap' then
    raise exception '[2] the same asset was set up twice under two names';
  end if;
  -- Training is not setup work: no overlap rule.
  perform public.service_order_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
    'a4540000-0000-4000-9000-000000000003', 'onsite_training', 1, 350000, 80000, 'Workshop team, four hours',
    'At the main yard; travel R800 agreed', null, null, null, app.billing_today() + 14);

  -- Acceptance: the owner only, at the amount shown.
  if pg_temp.try(format($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000002', %L, 180000)$s$, v_order)) <> 'forbidden' then
    raise exception '[2] a manager accepted an order';
  end if;
  if pg_temp.try(format($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000003', %L, 180000)$s$, v_order)) <> 'forbidden' then
    raise exception '[2] another business''s owner accepted an order';
  end if;
  if pg_temp.try(format($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000001', %L, 170000)$s$, v_order)) <> 'service-changed' then
    raise exception '[2] an order was accepted at an amount the owner was not shown';
  end if;
  if pg_temp.try(format($s$select public.service_order_invoice('a4510000-0000-4000-9000-000000000005', %L, null)$s$, v_order)) <> 'service-not-accepted' then
    raise exception '[2] an order was invoiced before it was accepted';
  end if;
  -- A changed tax setting is a new offer, never a silent re-price.
  update public.billing_settings set vat_registered = true, vat_rate_bps = 1500, vat_number = '4000000000' where singleton;
  if pg_temp.try(format($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000001', %L, 180000)$s$, v_order)) <> 'service-changed' then
    raise exception '[2] an order priced without VAT was accepted after the seller registered';
  end if;
  update public.billing_settings set vat_registered = false, vat_rate_bps = 0, vat_number = null where singleton;

  perform public.service_order_accept('a4510000-0000-4000-9000-000000000001', v_order, 180000);
  if public.service_order_accept('a4510000-0000-4000-9000-000000000001', v_order, 180000) <> v_order then
    raise exception '[2] a repeated acceptance failed';
  end if;
  v_invoice := public.service_order_invoice('a4510000-0000-4000-9000-000000000005', v_order, null);
  if public.service_order_invoice('a4510000-0000-4000-9000-000000000005', v_order, null) <> v_invoice then
    raise exception '[2] a second invoice was raised for one order';
  end if;
  select total_incl_cents into v_total from public.billing_invoices where id = v_invoice and kind = 'service' and subscription_id is null;
  if v_total is distinct from 180000 then raise exception '[2] the invoice is not exactly the accepted amount (%)', v_total; end if;
  if (select status from public.service_orders where id = v_order) <> 'invoiced' then raise exception '[2] the order was not marked invoiced'; end if;

  -- Expired offers.
  update public.service_orders set expires_on = app.billing_today() - 1 where request_id = 'a4540000-0000-4000-9000-000000000003';
  if pg_temp.try($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000001',
       (select id from public.service_orders where request_id = 'a4540000-0000-4000-9000-000000000003'), 430000)$s$) <> 'service-expired' then
    raise exception '[2] an expired offer was accepted';
  end if;
end $t$;

-- == [3] No new paid work in the grace ===========================================================
do $t$
declare v_order uuid;
begin
  v_order := public.service_order_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000003',
    gen_random_uuid(), 'remote_training', 1, null, 0, 'One hour', 'Video call', null, null, null, app.billing_today() + 7);
  if pg_temp.try(format($s$select public.service_order_accept('a4510000-0000-4000-9000-000000000004', %L, 50000)$s$, v_order)) <> 'billing-grace-no-extras' then
    raise exception '[3] a business with a declined renewal took on paid work';
  end if;
end $t$;

-- == [4] A managed agreement: floors and the explicit total =========================================
do $t$
declare v_quote uuid;
begin
  -- Below R170 a space a month.
  if pg_temp.try($s$select public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
       gen_random_uuid(), 'Q-1', 'monthly', 16999, 15, 5, 17000, 20, 8, 'Plan maintenance', '10 hours a month',
       'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', null, null, 12,
       app.billing_today(), app.billing_today() + 14)$s$) <> 'service-below-minimum' then
    raise exception '[4] a space below R170 a month was offered';
  end if;
  -- Under the R2,500 customer minimum (14 x R170 = R2,380).
  if pg_temp.try($s$select public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
       gen_random_uuid(), 'Q-1', 'monthly', 17000, 14, 5, 17000, 20, 8, 'Plan maintenance', '10 hours a month',
       'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', null, null, 12,
       app.billing_today(), app.billing_today() + 14)$s$) <> 'service-below-minimum' then
    raise exception '[4] an agreement under the R2,500 minimum was offered';
  end if;
  -- Equipment is human work too: never the R15 software rate.
  if pg_temp.try($s$select public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
       gen_random_uuid(), 'Q-1', 'monthly', 17000, 15, 5, 1500, 20, 8, 'Plan maintenance', '10 hours a month',
       'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', null, null, 12,
       app.billing_today(), app.billing_today() + 14)$s$) <> 'service-below-minimum' then
    raise exception '[4] equipment was priced at the software rate in a managed quote';
  end if;
  -- Annual: twelve months of the floor, never ten.
  if pg_temp.try($s$select public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
       gen_random_uuid(), 'Q-1', 'annual', 170000, 15, 5, 204000, 20, 8, 'Plan maintenance', '10 hours a month',
       'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', null, null, 12,
       app.billing_today(), app.billing_today() + 14)$s$) <> 'service-below-minimum' then
    raise exception '[4] an annual space at ten months of R170 was offered';
  end if;
  -- A site billed through another is not the customer.
  if pg_temp.try($s$select public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000004',
       gen_random_uuid(), 'Q-1', 'monthly', 17000, 15, 5, 17000, 20, 8, 'Plan maintenance', '10 hours a month',
       'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', null, null, 12,
       app.billing_today(), app.billing_today() + 14)$s$) <> 'service-billing-site' then
    raise exception '[4] an agreement was offered to a site billed through another';
  end if;

  v_quote := public.dfy_offer('a4510000-0000-4000-9000-000000000005', 'a4500000-0000-4000-9000-000000000001',
    'a4550000-0000-4000-9000-000000000001', 'Q-1', 'monthly', 17000, 15, 5, 17000, 20, 8,
    'Plan maintenance, chase workshops, monitor costs', '10 hours a month',
    'Monthly review and cost report', 'Fleet coordinator', 'Site visits and supplier costs', 'Twenty trucks, eight pumps', null, 12,
    app.billing_today(), app.billing_today() + 14);
  -- 20 x R170 + (8 - 5) x R170 = R3,910, the A1 sum on the agreement's prices.
  if (select recurring_incl_cents from public.done_for_you_quotes where id = v_quote) <> 391000 then
    raise exception '[4] the recurring total is not the renewal sum at the assumed quantities';
  end if;
  if (select effective_until from public.done_for_you_quotes where id = v_quote) <> (app.billing_today() + interval '12 months' - interval '1 day')::date then
    raise exception '[4] a twelve-month term does not end the day before its anniversary';
  end if;
  if (select status from public.done_for_you_quotes where id = v_quote) <> 'offered'
     or (select accepted_on from public.done_for_you_quotes where id = v_quote) is not null then
    raise exception '[4] an offer was recorded as accepted';
  end if;
  -- Nothing about the subscription moved on the offer.
  if (select plan::text || price_version_id::text from public.billing_subscriptions where id = 'a4560000-0000-4000-9000-000000000001') is not null then
    raise exception '[4] the offer changed the subscription';
  end if;
end $t$;

-- == [5] Acceptance, then the renewal ==============================================================
do $t$
declare
  v_quote uuid := (select id from public.done_for_you_quotes where request_id = 'a4550000-0000-4000-9000-000000000001');
  v_price public.billing_price_versions%rowtype;
  v_invoice public.billing_invoices%rowtype;
begin
  if pg_temp.try(format($s$select public.dfy_accept('a4510000-0000-4000-9000-000000000002', %L, 391000)$s$, v_quote)) <> 'forbidden' then
    raise exception '[5] a manager accepted a managed agreement';
  end if;
  if pg_temp.try(format($s$select public.dfy_accept('a4510000-0000-4000-9000-000000000001', %L, 390000)$s$, v_quote)) <> 'service-changed' then
    raise exception '[5] an agreement was accepted at a total the owner was not shown';
  end if;
  perform public.dfy_accept('a4510000-0000-4000-9000-000000000001', v_quote, 391000);
  if (select status || accepted_by::text from public.done_for_you_quotes where id = v_quote) <> 'accepted' || 'a4510000-0000-4000-9000-000000000001' then
    raise exception '[5] the acceptance was not recorded';
  end if;

  -- Not before the renewal.
  perform app.dfy_apply_due();
  if (select status from public.done_for_you_quotes where id = v_quote) <> 'accepted'
     or (select plan from public.billing_subscriptions where id = 'a4560000-0000-4000-9000-000000000001') <> 'complete' then
    raise exception '[5] an agreement landed in the middle of a paid period';
  end if;

  -- The renewal comes round (the invoice run's own clock).
  update public.done_for_you_quotes
     set effective_from = current_date, effective_until = (current_date + interval '12 months' - interval '1 day')::date
   where id = v_quote;
  update public.billing_subscriptions
     set current_period_start = current_date - 30, current_period_end = current_date - 1, next_billing_on = current_date
   where id = 'a4560000-0000-4000-9000-000000000001';
  if app.dfy_apply_due() <> 1 then raise exception '[5] the agreement did not land at the renewal'; end if;
  if app.dfy_apply_due() <> 0 then raise exception '[5] the apply was not repeat-safe'; end if;

  select p.* into v_price from public.billing_price_versions p
    join public.billing_subscriptions s on s.price_version_id = p.id
   where s.id = 'a4560000-0000-4000-9000-000000000001' and s.plan = 'done_for_you';
  if v_price.id is null or v_price.status <> 'retired' or v_price.months_charged <> 1
     or v_price.period_price_incl_cents <> 17000 or v_price.equipment_included <> 5 or v_price.min_billed_slots <> 15 then
    raise exception '[5] the agreement''s price row is not the accepted explicit price';
  end if;
  if app.billing_renewal_cents(v_price, 20, 8) <> 391000 then
    raise exception '[5] the engine''s sum on the agreement differs from the accepted total';
  end if;
  if pg_temp.try(format($s$update public.billing_price_versions set period_price_incl_cents = 1, per_vehicle_monthly_incl_cents = 1 where id = %L$s$, v_price.id)) = 'ok' then
    raise exception '[5] the agreement''s price could be edited after acceptance';
  end if;
  if (select plan from public.farms where id = 'a4500000-0000-4000-9000-000000000004') <> 'done_for_you' then
    raise exception '[5] a site billed through the customer did not follow its plan';
  end if;

  -- The ordinary invoice run bills exactly the accepted total.
  perform app.generate_billing_invoices('a4560000-0000-4000-9000-000000000001');
  select * into v_invoice from public.billing_invoices
   where subscription_id = 'a4560000-0000-4000-9000-000000000001' and kind = 'period' order by created_at desc limit 1;
  if v_invoice.total_incl_cents is distinct from 391000 or v_invoice.plan <> 'done_for_you' then
    raise exception '[5] the renewal invoice is % on %, not the accepted R3,910', v_invoice.total_incl_cents, v_invoice.plan;
  end if;
end $t$;

-- == [6] While the term runs, no plan change through /billing; ending at the renewal ================
do $t$
declare
  v_quote uuid := (select id from public.done_for_you_quotes where request_id = 'a4550000-0000-4000-9000-000000000001');
  v_sql text := $s$insert into public.billing_change_quotes (farm_id, subscription_id, change, mode, from_plan, from_period,
      from_equipment_extra, full_in_use, equipment_in_use, to_plan, to_period, to_equipment_extra, effective_on, priced_on, expires_at)
    values ('a4500000-0000-4000-9000-000000000001', 'a4560000-0000-4000-9000-000000000001', '%s', 'renewal', 'done_for_you',
      'monthly', 0, 20, 8, '%s', 'monthly', 0, current_date, current_date, now() + interval '30 minutes')$s$;
begin
  if pg_temp.try(format(v_sql, 'plan', 'complete')) <> 'service-agreement-term' then
    raise exception '[6] a plan change was quoted during a managed agreement''s term';
  end if;
  if pg_temp.try(format(v_sql, 'capacity', 'done_for_you')) <> 'ok' then
    raise exception '[6] buying more spaces on the agreement was refused';
  end if;

  if pg_temp.try(format($s$select public.dfy_end('a4510000-0000-4000-9000-000000000005', %L, 'done_for_you', null)$s$, v_quote)) <> 'service-invalid' then
    raise exception '[6] an agreement was "ended" onto done_for_you';
  end if;
  perform public.dfy_end('a4510000-0000-4000-9000-000000000005', v_quote, 'complete', 'customer asked');
  if (select pending_plan from public.billing_subscriptions where id = 'a4560000-0000-4000-9000-000000000001') <> 'complete' then
    raise exception '[6] ending did not schedule the next plan';
  end if;
  -- The renewal on which it ends.
  update public.billing_subscriptions set pending_plan_on = current_date where id = 'a4560000-0000-4000-9000-000000000001';
  update public.done_for_you_quotes set ends_on = current_date where id = v_quote;
  perform app.apply_pending_plan_changes();
  perform app.dfy_apply_due();
  if (select status from public.done_for_you_quotes where id = v_quote) <> 'ended'
     or (select plan from public.billing_subscriptions where id = 'a4560000-0000-4000-9000-000000000001') <> 'complete' then
    raise exception '[6] the agreement did not end with the plan change at renewal';
  end if;
end $t$;

-- == [7] Old agreements and who reads what =========================================================
do $t$
declare v_legacy uuid;
begin
  v_legacy := public.billing_record_dfy_quote('a4500000-0000-4000-9000-000000000003', 'OLD-1', 17000, 15, 'monthly',
    current_date, null, 'a4510000-0000-4000-9000-000000000005');
  if (select status from public.done_for_you_quotes where id = v_legacy) <> 'legacy' then
    raise exception '[7] a quote from the old path is not marked legacy';
  end if;
  -- Work and a review on the ended agreement; work on an order that was never accepted is refused.
  perform public.service_log('a4510000-0000-4000-9000-000000000005', 'a4570000-0000-4000-9000-000000000001',
    (select id from public.done_for_you_quotes where request_id = 'a4550000-0000-4000-9000-000000000001'), null,
    'work', 'workshop_follow_up', 'a4520000-0000-4000-9000-000000000003', 45, app.billing_today(), 'Chased the gearbox quote', null, null);
  perform public.service_log('a4510000-0000-4000-9000-000000000005', 'a4570000-0000-4000-9000-000000000001',
    (select id from public.done_for_you_quotes where request_id = 'a4550000-0000-4000-9000-000000000001'), null,
    'work', 'workshop_follow_up', 'a4520000-0000-4000-9000-000000000003', 45, app.billing_today(), 'Chased the gearbox quote', null, null);
  perform public.service_log('a4510000-0000-4000-9000-000000000005', 'a4570000-0000-4000-9000-000000000002',
    (select id from public.done_for_you_quotes where request_id = 'a4550000-0000-4000-9000-000000000001'), null,
    'review', null, null, 0, app.billing_today(), 'November review', 'Costs on track; two services due', app.billing_today() + 30);
  if (select count(*) from public.service_work_entries where farm_id = 'a4500000-0000-4000-9000-000000000001') <> 2 then
    raise exception '[7] a repeated work entry was recorded twice';
  end if;
  if pg_temp.try($s$select public.service_log('a4510000-0000-4000-9000-000000000005', gen_random_uuid(), null,
       (select id from public.service_orders where request_id = 'a4540000-0000-4000-9000-000000000002'),
       'work', 'setup', null, 30, app.billing_today(), 'Started', null, null)$s$) <> 'service-not-accepted' then
    raise exception '[7] work was logged on an order nobody accepted';
  end if;
end $t$;

select pg_temp.as_user('a4510000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.done_for_you_quotes) <> 1 then raise exception '[7] the owner does not read exactly their agreement'; end if;
  if (select count(*) from public.service_orders) <> 3 then raise exception '[7] the owner does not read their orders'; end if;
  if (select count(*) from public.service_work_entries) <> 1
     or exists (select 1 from public.service_work_entries where kind = 'work') then
    raise exception '[7] the owner reads Rapid Rise''s time record, or not the review';
  end if;
end $t$;
reset role;
select pg_temp.as_user('a4510000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.done_for_you_quotes) + (select count(*) from public.service_orders)
     + (select count(*) from public.service_work_entries) <> 0 then
    raise exception '[7] a manager reads what the business pays Rapid Rise';
  end if;
end $t$;
reset role;
select pg_temp.as_user('a4510000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.done_for_you_quotes) <> 0 then raise exception '[7] an owner reads a legacy quote (it was Rapid Rise''s only)'; end if;
end $t$;
reset role;
select pg_temp.as_user('a4510000-0000-4000-9000-000000000005', 'aal2');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.service_work_entries where farm_id = 'a4500000-0000-4000-9000-000000000001') <> 2 then
    raise exception '[7] Rapid Rise does not read its own time record';
  end if;
end $t$;
reset role;

-- == [8] Expiry and grants ==========================================================================
do $t$
declare f text;
begin
  update public.service_orders set expires_on = app.billing_today() - 1 where request_id = 'a4540000-0000-4000-9000-000000000002';
  perform app.dfy_apply_due();
  if (select status from public.service_orders where request_id = 'a4540000-0000-4000-9000-000000000002') <> 'expired' then
    raise exception '[8] an offer past its date did not expire';
  end if;
  foreach f in array array['public.dfy_offer', 'public.dfy_accept', 'public.dfy_cancel', 'public.dfy_end',
                           'public.service_order_offer', 'public.service_order_accept', 'public.service_order_invoice',
                           'public.service_order_close', 'public.service_log', 'public.cron_apply_service_agreements'] loop
    if exists (select 1 from pg_proc p where p.proname = split_part(f, '.', 2) and p.pronamespace = 'public'::regnamespace
                 and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                      or not has_function_privilege('service_role', p.oid, 'EXECUTE'))) then
      raise exception '[8] % is reachable by a session, or not by the service role', f;
    end if;
  end loop;
end $t$;

rollback;
\echo 'service_orders.sql: all assertions passed'
