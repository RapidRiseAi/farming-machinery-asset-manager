\set ON_ERROR_STOP on
-- Payment integrity (BRIEF section 15; R-083, R-096; scenario 10): one invoice per customer,
-- period and kind of charge; settling an attempt is safe against duplicate, out-of-order,
-- pending, declined, abandoned and late answers; a payment never counts twice. The webhook's
-- own checks (signature, amount, currency, farm, invoice, reference) are tested in
-- src/lib/billing/webhook.test.ts and worker.test.ts; this is what the database guarantees
-- whichever path settles.
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
create or replace function pg_temp.invoice(p_ref text, p_kind text, p_start date, p_end date) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind, period_start, period_end,
    issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values ('a2100000-0000-4000-9000-000000000001', 'a2160000-0000-4000-9000-000000000001', p_ref, 'draft', p_kind,
          p_start, p_end, current_date, current_date, 'essential', 'monthly', 5, 4900, 1, 'launch-2026-11-eq', 0)
  returning id into v;
  update public.billing_invoices set status = 'open' where id = v;
  return v;
end $$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('a2100000-0000-4000-9000-000000000001', 'Integrity yard', 'essential', 'active', 'monthly');
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('a2160000-0000-4000-9000-000000000001', 'a2100000-0000-4000-9000-000000000001', 'essential', 'monthly', 'active', 5,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int);

-- == One invoice per customer, period and kind ===================================================
do $t$
declare v text;
begin
  perform pg_temp.invoice('FW-INT-P1', 'period', current_date - 10, current_date + 19);
  v := pg_temp.try(format('select pg_temp.invoice(%L, %L, %L::date, %L::date)', 'FW-INT-P2', 'period',
                          current_date - 10, current_date + 19));
  if v not like '%billing_invoices_farm_period_uq%' then
    raise exception 'INTEGRITY FAIL [uq]: a second period invoice for the same customer and period: %', v;
  end if;
  perform pg_temp.invoice('FW-INT-A1', 'ai_usage', date_trunc('month', current_date)::date - 30, date_trunc('month', current_date)::date - 1);
  v := pg_temp.try(format('select pg_temp.invoice(%L, %L, %L::date, %L::date)', 'FW-INT-A2', 'ai_usage',
                          date_trunc('month', current_date)::date - 30, date_trunc('month', current_date)::date - 1));
  if v not like '%billing_invoices_ai_usage_uq%' then
    raise exception 'INTEGRITY FAIL [uq]: a second AI-only invoice for the same customer and period: %', v;
  end if;
  -- A different kind for the same period is a different charge, and is allowed.
  perform pg_temp.invoice('FW-INT-A3', 'ai_usage', current_date - 10, current_date + 19);
end $t$;

-- == Settling an attempt, whatever order the answers come in =====================================
do $t$
declare
  v_inv uuid := (select id from public.billing_invoices where invoice_ref = 'FW-INT-P1');
  a uuid;
  b uuid;
  c uuid;
begin
  -- Pending: nothing paid, nothing dunned, nothing else may be claimed meanwhile.
  a := app.claim_billing_charge(v_inv, 'FWB-INT-1', 'initial_checkout', 24500);
  perform app.settle_billing_attempt(a, 'pending', null, null, null, null, null, null, true);
  if (select status from public.billing_invoices where id = v_inv) <> 'open'
     or app.claim_billing_charge(v_inv, 'FWB-INT-1b', 'manual_retry', 24500) is not null then
    raise exception 'INTEGRITY FAIL [10]: a pending payment was treated as settled, or a second charge was claimed beside it';
  end if;

  -- Abandoned (the person left the checkout): nothing paid, no dunning, the invoice is free again.
  perform app.settle_billing_attempt(a, 'abandoned', null, null, null, 'left the page', null, null, true);
  if (select failed_attempt_count from public.billing_subscriptions where id = 'a2160000-0000-4000-9000-000000000001') <> 0 then
    raise exception 'INTEGRITY FAIL [10]: an abandoned checkout started the dunning ladder';
  end if;

  -- Declined, and the same decline reported twice (the webhook and the reconcile): dunned once.
  b := app.claim_billing_charge(v_inv, 'FWB-INT-2', 'charge_authorization', 24500);
  perform app.settle_billing_attempt(b, 'failed', null, null, 'Declined', 'Declined', null, null, true);
  perform app.settle_billing_attempt(b, 'failed', null, null, 'Declined', 'Declined', null, null, true);
  if (select failed_attempt_count from public.billing_subscriptions where id = 'a2160000-0000-4000-9000-000000000001') <> 1 then
    raise exception 'INTEGRITY FAIL [10]: a repeated decline walked the ladder twice';
  end if;

  -- The bank's success arrives after all (delayed success): the money is recorded, once.
  perform app.settle_billing_attempt(b, 'succeeded', 88001, 'FWB-INT-2', 'Approved', null, 24500, 'card', true);
  perform app.settle_billing_attempt(b, 'succeeded', 88001, 'FWB-INT-2', 'Approved', null, 24500, 'card', true);
  if (select count(*) from public.billing_payments where attempt_id = b) <> 1
     or (select status from public.billing_invoices where id = v_inv) <> 'paid'
     or (select status from public.billing_subscriptions where id = 'a2160000-0000-4000-9000-000000000001') <> 'active' then
    raise exception 'INTEGRITY FAIL [10]: a delayed success was lost, counted twice, or left the account dunned';
  end if;

  -- An out-of-order failure or pending after the success changes nothing.
  perform app.settle_billing_attempt(b, 'failed', null, null, 'late', 'late', null, null, true);
  perform app.settle_billing_attempt(b, 'unknown', null, null, null, null, null, null, true);
  if (select status from public.billing_payment_attempts where id = b) <> 'succeeded'
     or (select status from public.billing_invoices where id = v_inv) <> 'paid'
     or (select failed_attempt_count from public.billing_subscriptions where id = 'a2160000-0000-4000-9000-000000000001') <> 0 then
    raise exception 'INTEGRITY FAIL [10]: a late failure undid a payment or dunned a paid account';
  end if;

  -- The same Paystack transaction cannot credit a second invoice.
  c := app.claim_billing_charge((select id from public.billing_invoices where invoice_ref = 'FW-INT-A1'), 'FWB-INT-3',
                                'manual_retry', 24500);
  if pg_temp.try(format('select app.settle_billing_attempt(%L, ''succeeded'', 88001, ''FWB-INT-2'', ''Approved'', null, 24500, ''card'', true)', c)) = 'ok'
     and exists (select 1 from public.billing_payments where attempt_id = c) then
    raise exception 'INTEGRITY FAIL [10]: one provider transaction paid two invoices';
  end if;
end $t$;

rollback;
