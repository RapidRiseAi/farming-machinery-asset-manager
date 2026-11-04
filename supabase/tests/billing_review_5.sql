-- Fifth billing review (20261029160000). Each section is one of the verifiers' proof
-- tests, run in its own transaction: it raised on 20261029150000 and must pass now.
-- psql: \set ON_ERROR_STOP on stops at the first failure.
\set ON_ERROR_STOP on
set client_min_messages to warning;

-- == money-1: a trial that cancels is closed when the trial ends, never invoiced or suspended (mig_trial_cancel.sql) ====
-- LENS mig: a farm that cancels (period end) during its trial. The new ending rule only
-- skips a subscription whose current_period_end is set; a trial has none, so the
-- generator raises a month after the trial, the close never matches, and the farm is
-- later suspended. Expected: no invoice, cancelled the night the trial ends, gate closed.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000001', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000001', 'Lens Trial Cancel', 'complete', 'active', 'monthly', 'd4t1@billing.invalid', false);

-- What app.start_billing_subscription wrote 15 days ago with the default 14-day trial
-- (status trialing, trial_ends_on = start + 14, period null, next_billing_on = trial end + 1),
-- then what setCancellation (period end) writes over it: non_renewing, cancel_at_period_end.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, trial_ends_on,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota,
  cancel_at_period_end, cancelled_at, created_at) values
  ('d4600000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 'complete', 'monthly',
   'non_renewing', current_date - 1, null, null, current_date, extract(day from current_date - 15)::int, 1,
   true, now() - interval '5 days', now() - interval '15 days');

do $$
declare n int; r record; g_after text; g_later text; v_inv record;
begin
  -- The nightly order (route.ts): plan changes, invoices, AI, (charges), suspensions, close.
  perform app.generate_billing_invoices(null);
  perform app.generate_ai_usage_invoices();
  perform app.billing_apply_suspensions();
  perform app.billing_close_cancellations();

  select count(*) into n from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000001';
  select * into r from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000001';
  select * into v_inv from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000001' limit 1;
  g_after := app.farm_billing_gate('d4000000-0000-0000-0000-000000000001');

  -- Eight days after that invoice falls due (as the nightly pass will see it then).
  update billing_invoices set due_on = current_date - 8 where subscription_id = 'd4600000-0000-0000-0000-000000000001';
  perform app.billing_apply_suspensions();
  perform app.billing_close_cancellations();
  g_later := app.farm_billing_gate('d4000000-0000-0000-0000-000000000001');

  if n > 0 or r.status <> 'cancelled' then
    raise exception 'REVIEW5 FAIL [money-1 trial-cancel]: a farm that cancelled during its trial was invoiced % time(s) (R%, period % to %) the night the trial ended; subscription now % (period end %, ended %), gate %; eight days after the due date the gate is % and the subscription %',
      n, v_inv.total_incl_cents / 100.0, v_inv.period_start, v_inv.period_end, r.status, r.current_period_end, r.ended_on,
      g_after, g_later, (select status from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000001');
  end if;
end $$;

rollback;

-- == money-6: a cancelled farm whose retry was declined still closes at its period end (mig_pastdue_cancel.sql) ====
-- LENS mig: a period-end cancellation whose owner presses "Try again" (retryPayment ->
-- app.invoice_chargeable_now, which admits non_renewing) and is declined. The failed
-- settle runs app.billing_register_failure, which writes status 'past_due' and leaves
-- cancel_at_period_end true. The new ending rule never renews it, and
-- app.billing_close_cancellations closes only status = 'non_renewing', so the night its
-- period ends nothing happens: it is never closed, the gate never says 'closed', and after
-- the grace it is suspended (not closed) with its card on the weekly retry list.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000071', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000071', 'Lens Declined Leaver', 'complete', 'active', 'monthly', 'd4pd@billing.invalid', false);
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('d4700000-0000-0000-0000-000000000071', 'd4000000-0000-0000-0000-000000000071',
   'AUTH_d4synthetic71', 'lens4.owner71@example.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, cancel_at_period_end, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, default_payment_method_id) values
  ('d4600000-0000-0000-0000-000000000071', 'd4000000-0000-0000-0000-000000000071', 'complete', 'monthly', 'non_renewing',
   true, now() - interval '3 days', current_date - 29, current_date - 1, current_date,
   extract(day from current_date)::int, 1, 'd4700000-0000-0000-0000-000000000071');
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('d4800000-0000-0000-0000-000000000071', 'd4000000-0000-0000-0000-000000000071', 'd4600000-0000-0000-0000-000000000071',
  'D4-PD', 'draft', 'period', current_date - 29, current_date - 1, current_date - 3, current_date - 3,
  'complete', 'monthly', 1, 2000, 1, 'd4500000-0000-0000-0000-000000000071', 'd4-synthetic', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('d4800000-0000-0000-0000-000000000071', 'd4000000-0000-0000-0000-000000000071', 0, 'month', 1, 1, 2000, 2000, 2000, 0);
update billing_invoices set status = 'open' where id = 'd4800000-0000-0000-0000-000000000071';

do $$
declare v_att uuid; s0 text; s1 text; s2 text; g1 text; g2 text; on_list boolean;
begin
  if not exists (select 1 from app.invoice_chargeable_now('d4800000-0000-0000-0000-000000000071')) then
    raise exception 'LENS SETUP: a non_renewing farm''s invoice is not chargeable by Try again';
  end if;
  -- Try again, declined (what retryInvoiceCharge -> settleChargeResult does).
  v_att := app.claim_billing_charge('d4800000-0000-0000-0000-000000000071', 'D4-PD-REF', 'manual_retry', 2000);
  perform app.settle_billing_attempt(v_att, 'failed', null, 'D4-PD-REF', 'Declined', 'Declined', null, 'card', true);
  select status into s0 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000071';

  -- The night its period ended (current_period_end yesterday), in the cron's order.
  perform app.generate_billing_invoices(null);
  perform app.billing_apply_suspensions();
  perform app.billing_close_cancellations();
  select status into s1 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000071';
  g1 := app.farm_billing_gate('d4000000-0000-0000-0000-000000000071');

  -- Eight days after the due date.
  update billing_invoices set due_on = current_date - 8 where id = 'd4800000-0000-0000-0000-000000000071';
  perform app.billing_apply_suspensions();
  perform app.billing_close_cancellations();
  select status into s2 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000071';
  g2 := app.farm_billing_gate('d4000000-0000-0000-0000-000000000071');
  update billing_subscriptions set next_retry_on = current_date where id = 'd4600000-0000-0000-0000-000000000071';
  on_list := exists (select 1 from app.due_billing_charges(1000) d where d.farm_id = 'd4000000-0000-0000-0000-000000000071');

  if s1 <> 'cancelled' then
    raise exception 'REVIEW5 FAIL [money-6 pastdue-cancel]: after the declined Try again the subscription is % (cancel_at_period_end still true); the night its period ended it stayed % (gate %), not cancelled; after the grace it is % (gate %, never closed) and its card is on the weekly charge list: %',
      s0, s1, g1, s2, g2, on_list;
  end if;
end $$;
rollback;

-- == money-2: reopening inside a paid year keeps it, whatever small invoice is open (mig_reopen_small_open.sql) ====
-- LENS mig: the reopen's paid-period branch needs v_open = 0. An annual farm that paid its
-- year, has a small AI-only invoice open (not yet overdue), cancels at once and reopens
-- inside the paid year takes the pending path: the period is cleared, it pays the R50, the
-- restore makes it active with next_billing_on today, and the generator bills a whole new
-- year from today on top of the year already paid.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000021', 'd4-synthetic-a', 'complete', 'annual', 2000, 12, 0, 'active');
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000098', 'lens4b.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000098', null, 'rr_admin', 'Lens4b RR', 'lens4b.rr@example.invalid', true);

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000021', 'Lens Annual Reopen', 'complete', 'active', 'annual', 'd4c@billing.invalid', false);
-- Paid for day -90 .. day +274; cancelled at once yesterday.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, ended_on, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, created_at) values
  ('d4600000-0000-0000-0000-000000000021', 'd4000000-0000-0000-0000-000000000021', 'complete', 'annual', 'cancelled',
   current_date - 1, now() - interval '1 day', current_date - 90, current_date + 274, current_date + 275,
   extract(day from current_date + 275)::int, 1, now() - interval '100 days');
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('d4800000-0000-0000-0000-000000000021', 'd4000000-0000-0000-0000-000000000021', 'd4600000-0000-0000-0000-000000000021',
  'D4-YEAR', 'draft', 'period', current_date - 90, current_date + 274, current_date - 90, current_date - 90,
  'complete', 'annual', 1, 2000, 12, 'd4500000-0000-0000-0000-000000000021', 'd4-synthetic-a', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('d4800000-0000-0000-0000-000000000021', 'd4000000-0000-0000-0000-000000000021', 0, 'year', 1, 12, 2000, 24000, 24000, 0);
update billing_invoices set status = 'open' where id = 'd4800000-0000-0000-0000-000000000021';
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, provider, provider_reference, provider_transaction_id, channel)
values ('d4000000-0000-0000-0000-000000000021', 'd4800000-0000-0000-0000-000000000021', 24000, 'paystack', 'D4-PAY-YEAR', 984000021, 'card');
-- An AI-only invoice raised three days ago, R50, inside its terms.
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('d4800000-0000-0000-0000-000000000022', 'd4000000-0000-0000-0000-000000000021', 'd4600000-0000-0000-0000-000000000021',
  'D4-AI', 'draft', 'ai_usage', current_date - 33, current_date - 4, current_date - 3, current_date - 3,
  'complete', 'annual', 0, 0, 1, null, 'AI and voice use', 0);
update billing_invoices set ai_usage_ex_vat_cents = 5000 where id = 'd4800000-0000-0000-0000-000000000022';
update billing_invoices set status = 'open' where id = 'd4800000-0000-0000-0000-000000000022';

do $$
declare r record; n int; v_new record; g_before text;
begin
  if (select status from billing_invoices where id = 'd4800000-0000-0000-0000-000000000021') <> 'paid'
     or (select total_incl_cents from billing_invoices where id = 'd4800000-0000-0000-0000-000000000022') <= 0 then
    raise exception 'LENS SETUP: year not paid or AI invoice empty';
  end if;
  g_before := app.farm_billing_gate('d4000000-0000-0000-0000-000000000021');

  perform public.billing_reopen_subscription('d4000000-0000-0000-0000-000000000021', null);
  -- /activate shows the R50; Rapid Rise records the EFT.
  perform public.billing_record_manual_payment('d4800000-0000-0000-0000-000000000022',
    (select total_incl_cents from billing_invoices where id = 'd4800000-0000-0000-0000-000000000022'),
    'eft', 'D4-AI-EFT', current_date, null, 'proofs/d4ai.pdf', 'd4a00000-0000-0000-0000-000000000098');
  -- Tonight's run.
  perform app.generate_billing_invoices(null);
  select * into r from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000021';
  select * into v_new from billing_invoices
   where subscription_id = 'd4600000-0000-0000-0000-000000000021' and kind = 'period'
     and id <> 'd4800000-0000-0000-0000-000000000021';
  if v_new.id is not null then
    raise exception 'REVIEW5 FAIL [money-2 reopen-small-open]: gate was %; a farm that paid its year to % (R240) and reopened the day after cancelling, owing only a R% AI invoice, paid that and was invoiced a NEW year R% for % to % (subscription %, period % to %)',
      g_before, current_date + 274,
      (select total_incl_cents / 100.0 from billing_invoices where id = 'd4800000-0000-0000-0000-000000000022'),
      v_new.total_incl_cents / 100.0, v_new.period_start, v_new.period_end, r.status, r.current_period_start, r.current_period_end;
  end if;
end $$;

rollback;

-- == money-3: a paid period is recognised after a re-anchor moved its start (mig_reopen_eft_signup.sql) ====
-- LENS mig: the pending re-anchor (restore) moves current_period_start to the payment day
-- but leaves the invoice's period_start where the generator wrote it. The reopen's new
-- paid-period branch keys on i.period_start = s.current_period_start, so a sign-up that
-- paid its first invoice on a later day than it was raised (every EFT that is not same-day)
-- and then cancels at once and reopens inside that month is billed the paid days again.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000011', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000099', 'lens4.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000099', null, 'rr_admin', 'Lens4 RR', 'lens4.rr@example.invalid', true);

create function public._d4_open_invoice(p_id uuid, p_farm uuid, p_sub uuid, p_ref text,
  p_start date, p_end date, p_due date, p_cents bigint default 2000) returns void
language plpgsql as $$
begin
  insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
  values (p_id, p_farm, p_sub, p_ref, 'draft', 'period', p_start, p_end, p_start, p_due,
    'complete', 'monthly', 1, p_cents, 1, 'd4500000-0000-0000-0000-000000000011', 'd4-synthetic', 0);
  insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
    months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
  values (p_id, p_farm, 0, 'Fleet Wise complete, 1 asset', 1, 1, p_cents, p_cents, p_cents, 0);
  update billing_invoices set status = 'open' where id = p_id;
end $$;

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000011', 'Lens EFT Signup A', 'complete', 'active', 'monthly', 'd4a@billing.invalid', false),
  ('d4000000-0000-0000-0000-000000000012', 'Lens EFT Signup B', 'complete', 'active', 'monthly', 'd4b@billing.invalid', false);

-- (A) The restore really produces the mismatch: a sign-up invoiced two days ago pays today.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on, anchor_day, asset_quota, created_at)
values ('d4600000-0000-0000-0000-000000000011', 'd4000000-0000-0000-0000-000000000011', 'complete', 'monthly', 'pending',
        current_date - 2, extract(day from current_date - 2)::int, 1, now() - interval '2 days');
select app.generate_billing_invoices('d4600000-0000-0000-0000-000000000011');

-- (B) The state the same story leaves a week on: invoiced day -9, EFT recorded day -7
--     (re-anchored to day -7), cancelled at once yesterday, reopening today.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, ended_on, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, created_at) values
  ('d4600000-0000-0000-0000-000000000012', 'd4000000-0000-0000-0000-000000000012', 'complete', 'monthly', 'cancelled',
   current_date - 1, now() - interval '1 day',
   current_date - 7,
   app.billing_advance_period(current_date - 7, 'monthly', extract(day from current_date - 7)::int) - 1,
   app.billing_advance_period(current_date - 7, 'monthly', extract(day from current_date - 7)::int),
   extract(day from current_date - 7)::int, 1, now() - interval '9 days');
select public._d4_open_invoice('d4800000-0000-0000-0000-000000000012', 'd4000000-0000-0000-0000-000000000012',
  'd4600000-0000-0000-0000-000000000012', 'D4-B', current_date - 9,
  app.billing_advance_period(current_date - 9, 'monthly', extract(day from current_date - 9)::int) - 1, current_date - 9);
insert into billing_payments (farm_id, invoice_id, amount_incl_cents, currency, paid_at, provider, provider_reference,
  channel, recorded_by, method, received_on, proof_path, created_at)
values ('d4000000-0000-0000-0000-000000000012', 'd4800000-0000-0000-0000-000000000012', 2000, 'ZAR', now() - interval '7 days',
  'manual', 'MAN-D4B', 'eft', 'd4a00000-0000-0000-0000-000000000099', 'eft', current_date - 7, 'proofs/d4b.pdf', now() - interval '7 days');

do $$
declare inv record; s record; n int; r record; g text;
begin
  select * into inv from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000011';
  perform public.billing_record_manual_payment(inv.id, 2000, 'eft', 'D4-A-EFT', current_date, null,
    'proofs/d4a.pdf', 'd4a00000-0000-0000-0000-000000000099');
  select * into s from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000011';
  if s.status <> 'active' or s.current_period_start <> current_date or inv.period_start <> current_date - 2 then
    raise exception 'LENS SETUP: (A) expected the restore to re-anchor to today away from the invoice''s % (got % %)',
      inv.period_start, s.status, s.current_period_start;
  end if;

  if (select status from billing_invoices where id = 'd4800000-0000-0000-0000-000000000012') <> 'paid'
     or app.farm_billing_gate('d4000000-0000-0000-0000-000000000012') <> 'closed' then
    raise exception 'LENS SETUP: (B) not a closed farm with a paid month';
  end if;

  perform public.billing_reopen_subscription('d4000000-0000-0000-0000-000000000012', null);
  select * into r from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000012';
  select count(*) into n from billing_invoices
   where subscription_id = 'd4600000-0000-0000-0000-000000000012' and status = 'open' and deleted_at is null;
  g := app.farm_billing_gate('d4000000-0000-0000-0000-000000000012');
  if r.status <> 'active' or n > 0 then
    raise exception 'REVIEW5 FAIL [money-3 reopen-after-eft]: (A) the restore set current_period_start % while the paid invoice says %; (B) a farm paid to % (invoice period % to %, period after the re-anchor % to %) cancelled yesterday and reopened today is % (gate %) with % new invoice(s) for % to %',
      s.current_period_start, inv.period_start,
      app.billing_advance_period(current_date - 7, 'monthly', extract(day from current_date - 7)::int) - 1,
      current_date - 9, app.billing_advance_period(current_date - 9, 'monthly', extract(day from current_date - 9)::int) - 1,
      current_date - 7, app.billing_advance_period(current_date - 7, 'monthly', extract(day from current_date - 7)::int) - 1,
      r.status, g, n,
      (select min(period_start) from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000012' and status = 'open'),
      (select min(period_end) from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000012' and status = 'open');
  end if;
end $$;

rollback;

-- == money-4: a re-payment after a bounced EFT keeps the period it had (mig_repay_reanchor.sql) ====
-- LENS mig: the new pending re-anchor also fires on a RE-payment. A sign-up's EFT is
-- recorded on its invoice day, the farm uses 20 days, the EFT bounces (reversal, back to
-- pending), and the farm pays again: the restore treats it as a first payment and starts a
-- fresh month from today, so one month's money buys 20 + 30 days. Before 20261029150000 the
-- period stayed day -20 .. day +10.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000041', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000097', 'lens4c.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000097', null, 'rr_admin', 'Lens4c RR', 'lens4c.rr@example.invalid', true);

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000041', 'Lens Bounce Repay', 'complete', 'active', 'monthly', 'd4r@billing.invalid', false);
-- Invoiced and paid by EFT on day -20 (the restore's re-anchor wrote the same dates).
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, created_at) values
  ('d4600000-0000-0000-0000-000000000041', 'd4000000-0000-0000-0000-000000000041', 'complete', 'monthly', 'active',
   current_date - 20,
   app.billing_advance_period(current_date - 20, 'monthly', extract(day from current_date - 20)::int) - 1,
   app.billing_advance_period(current_date - 20, 'monthly', extract(day from current_date - 20)::int),
   extract(day from current_date - 20)::int, 1, now() - interval '20 days');
insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
values ('d4800000-0000-0000-0000-000000000041', 'd4000000-0000-0000-0000-000000000041', 'd4600000-0000-0000-0000-000000000041',
  'D4-R', 'draft', 'period', current_date - 20,
  app.billing_advance_period(current_date - 20, 'monthly', extract(day from current_date - 20)::int) - 1,
  current_date - 20, current_date - 20, 'complete', 'monthly', 1, 2000, 1, 'd4500000-0000-0000-0000-000000000041', 'd4-synthetic', 0);
insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
  months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
values ('d4800000-0000-0000-0000-000000000041', 'd4000000-0000-0000-0000-000000000041', 0, 'month', 1, 1, 2000, 2000, 2000, 0);
update billing_invoices set status = 'open' where id = 'd4800000-0000-0000-0000-000000000041';
insert into billing_payments (id, farm_id, invoice_id, amount_incl_cents, currency, paid_at, provider, provider_reference,
  channel, recorded_by, method, received_on, proof_path, created_at)
values ('d4900000-0000-0000-0000-000000000041', 'd4000000-0000-0000-0000-000000000041', 'd4800000-0000-0000-0000-000000000041',
  2000, 'ZAR', now() - interval '20 days', 'manual', 'MAN-D4R1', 'eft', 'd4a00000-0000-0000-0000-000000000097', 'eft',
  current_date - 20, 'proofs/d4r1.pdf', now() - interval '20 days');

do $$
declare r0 record; r1 record; r2 record;
begin
  select * into r0 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000041';
  perform public.billing_reverse_manual_payment('d4900000-0000-0000-0000-000000000041', 'EFT bounced',
    'd4a00000-0000-0000-0000-000000000097');
  select * into r1 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000041';
  if r1.status <> 'pending' then raise exception 'LENS SETUP: reversal did not return to pending (%)', r1.status; end if;
  perform public.billing_record_manual_payment('d4800000-0000-0000-0000-000000000041', 2000, 'eft', 'D4R2', current_date, null,
    'proofs/d4r2.pdf', 'd4a00000-0000-0000-0000-000000000097');
  select * into r2 from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000041';
  if r2.current_period_end <> r0.current_period_end then
    raise exception 'REVIEW5 FAIL [money-4 repay-reanchor]: the period paid by the bounced EFT was % to % (used for 20 days); after the bounce and ONE re-payment today it is % to % (next %, status %): % days of access given again for the same R20',
      r0.current_period_start, r0.current_period_end, r2.current_period_start, r2.current_period_end, r2.next_billing_on,
      r2.status, r2.current_period_end - r0.current_period_end;
  end if;
end $$;

rollback;

-- == money-5: clearing the exempt flag bills nothing for the exempt time, AI included (mig_unexempt_catchup.sql) ====
-- LENS mig: the generator now leaves an exempt farm out of its query altogether, so its
-- next_billing_on is never moved on while it is exempt. The day the flag is cleared (a
-- Rapid Rise demo or test farm moved to the real side), the generator catches up one period
-- a night for every month it was exempt, and the first of those invoices carries every
-- AI call made while exempt. "Never asked to pay" turns into "asked later, for all of it".
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000031', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
update billing_settings set ai_billing_starts_on = current_date - 120 where singleton;

insert into farms (id, name, plan, status, billing_period, billing_email, is_test, billing_exempt) values
  ('d4000000-0000-0000-0000-000000000031', 'Lens Exempt Then Real', 'complete', 'active', 'monthly', 'd4e@billing.invalid', false, true);
update farms set billing_exempt_since = now() - interval '91 days' where id = 'd4000000-0000-0000-0000-000000000031';
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000031', 'lens4.owner31@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000031', 'd4000000-0000-0000-0000-000000000031', 'owner', 'Lens Owner', 'lens4.owner31@example.invalid', true);
-- Its last billed period ended 91 days ago; it has been exempt since.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('d4600000-0000-0000-0000-000000000031', 'd4000000-0000-0000-0000-000000000031', 'complete', 'monthly', 'active',
   current_date - 120, current_date - 91, current_date - 90, extract(day from current_date - 90)::int, 1);

-- AI used while exempt, 40 days ago.
do $$
declare v_res uuid;
        v_at timestamptz := (((now() at time zone 'Africa/Johannesburg')::date - 40) + time '12:00')::timestamp
                            at time zone 'Africa/Johannesburg';
begin
  insert into ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at, created_at)
  values ('d4000000-0000-0000-0000-000000000031', 'd4a00000-0000-0000-0000-000000000031', 'ai_answer', 'platform', 'm', 5000,
          app.ai_month(v_at), v_at, v_at)
  returning id into v_res;
  insert into ai_usage (farm_id, user_id, occurred_at, month, feature, provider, model, credential,
    measured, usd_zar, margin_bps, outcome, reservation_id, billed_cents, created_at)
  values ('d4000000-0000-0000-0000-000000000031', 'd4a00000-0000-0000-0000-000000000031', v_at, app.ai_month(v_at),
    'ai_answer', 'ai_gateway', 'm', 'platform', 'server', 18, 3000, 'ok', v_res, 5000, v_at);
end $$;

do $$
declare n_exempt int; n int; periods text; ai numeric;
begin
  -- While exempt: three nights, nothing (correct).
  n_exempt := app.generate_billing_invoices(null) + app.generate_billing_invoices(null) + app.generate_billing_invoices(null);
  -- The farm becomes a paying customer today. Four nights of the cron.
  update farms set billing_exempt = false where id = 'd4000000-0000-0000-0000-000000000031';
  perform app.generate_billing_invoices(null);
  perform app.generate_billing_invoices(null);
  perform app.generate_billing_invoices(null);
  perform app.generate_billing_invoices(null);
  select count(*), string_agg(period_start || '..' || period_end, ', ' order by period_start),
         sum(coalesce(ai_usage_ex_vat_cents, 0))
    into n, periods, ai
    from billing_invoices where farm_id = 'd4000000-0000-0000-0000-000000000031';
  if n > 1 or ai > 0 then
    raise exception 'REVIEW5 FAIL [money-5 unexempt-catchup]: exempt nights raised %; once the flag was cleared, four nights raised % invoices (%) for months the farm was exempt, carrying % cents of AI use made while exempt',
      n_exempt, n, periods, ai;
  end if;
end $$;

rollback;

-- == money-7: keep open is refused for a farm on a Rapid Rise hold (mig_extend_hold.sql) ====
-- LENS mig: admin_extend_billing_access now refuses where the gate never reads the
-- extension (pending, cancelled, downgraded), but a farm on a Rapid Rise hold
-- (farms.status suspended with suspended_for null, or cancelled) is answered 'closed' by the
-- gate from the farm row before the extension is read. The extension is still saved.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000096', 'lens4d.rr@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000096', null, 'rr_admin', 'Lens4d RR', 'lens4d.rr@example.invalid', true);
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000051', 'Lens Held', 'complete', 'suspended', 'monthly', 'd4h@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('d4600000-0000-0000-0000-000000000051', 'd4000000-0000-0000-0000-000000000051', 'complete', 'monthly', 'active',
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date + 20)::int, 1);
do $$
declare g text;
begin
  begin
    perform public.admin_extend_billing_access('d4000000-0000-0000-0000-000000000051', current_date + 7,
      'money on its way', 'd4a00000-0000-0000-0000-000000000096');
  exception when sqlstate '22023' then
    null;  -- refused, as it must be
  end;
  g := app.farm_billing_gate('d4000000-0000-0000-0000-000000000051');
  if (select access_extended_until from billing_subscriptions
       where id = 'd4600000-0000-0000-0000-000000000051') is not null then
    raise exception 'REVIEW5 FAIL [money-7 extend-hold]: "access extended" saved (until %) for a farm on a Rapid Rise hold, gate still %',
      (select access_extended_until from billing_subscriptions where id = 'd4600000-0000-0000-0000-000000000051'), g;
  end if;
end $$;
rollback;

-- == money-9: a reopened farm is not swept as an old sign-up (mig_reopen_swept.sql) ====
-- LENS mig: the sweep's guards (20261029150000) are payments by farm, exempt, and attempts
-- in flight. They do not recognise a REOPENED subscription. A farm that never paid (a trial
-- farm that cancelled) and reopens is pending with an old created_at and no payment, so the
-- same night's sweep (the cron's last step) voids its new invoice and soft-deletes the farm
-- and every user on it, with zero days to pay instead of seven.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000081', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000081', 'Lens Trial Reopen', 'complete', 'active', 'monthly', 'd4rs@billing.invalid', false);
insert into auth.users (id, email) values ('d4a00000-0000-0000-0000-000000000081', 'lens4.owner81@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('d4a00000-0000-0000-0000-000000000081', 'd4000000-0000-0000-0000-000000000081', 'owner', 'Lens Owner 81', 'lens4.owner81@example.invalid', true);
-- Started by Rapid Rise 20 days ago with a 14-day trial; cancelled at once two days ago.
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, trial_ends_on, ended_on, cancelled_at,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, created_at) values
  ('d4600000-0000-0000-0000-000000000081', 'd4000000-0000-0000-0000-000000000081', 'complete', 'monthly', 'cancelled',
   current_date - 6, current_date - 2, now() - interval '2 days', null, null, current_date - 5,
   extract(day from current_date - 20)::int, 1, now() - interval '20 days');
do $$
declare g0 text; g1 text; n int;
begin
  g0 := app.farm_billing_gate('d4000000-0000-0000-0000-000000000081');
  perform public.billing_reopen_subscription('d4000000-0000-0000-0000-000000000081', 'd4a00000-0000-0000-0000-000000000081');
  g1 := app.farm_billing_gate('d4000000-0000-0000-0000-000000000081');
  -- That night's cron, last step.
  n := app.sweep_dormant_signups(7);
  if (select deleted_at from farms where id = 'd4000000-0000-0000-0000-000000000081') is not null then
    raise exception 'REVIEW5 FAIL [money-9 reopen-swept]: gate % -> reopened (gate %, invoice % raised today) -> that night the sweep (%) voided it and deleted the farm and its owner (owner deleted %)',
      g0, g1, (select invoice_ref || ' ' || status from billing_invoices where subscription_id = 'd4600000-0000-0000-0000-000000000081'),
      n, (select deleted_at is not null from users where id = 'd4a00000-0000-0000-0000-000000000081');
  end if;
end $$;
rollback;

-- == money-10: the first period after a trial is a full month (mig_trial_anchor.sql) ====
-- LENS mig: app.start_billing_subscription anchors on the START day, not the day billing
-- starts. With a 14-day trial the generator's first period then ends at the next anchor,
-- 16 days later, and is charged a full month (the money-5 reopen bug, for trials).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);
update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('d4500000-0000-0000-0000-000000000091', 'd4-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('d4000000-0000-0000-0000-000000000091', 'Lens Trial Anchor', 'complete', 'active', 'monthly', 'd4ta@billing.invalid', false);
do $$
declare v_sub uuid; i record;
begin
  -- Exactly what app.start_billing_subscription writes, run 15 days ago with a 14-day trial.
  v_sub := app.start_billing_subscription('d4000000-0000-0000-0000-000000000091', 'complete', 'monthly', 14);
  update billing_subscriptions
     set trial_ends_on = trial_ends_on - 15, next_billing_on = next_billing_on - 15,
         anchor_day = extract(day from current_date - 15)::int, asset_quota = 1
   where id = v_sub;
  perform app.generate_billing_invoices(v_sub);
  select * into i from billing_invoices where subscription_id = v_sub;
  if i.period_end - i.period_start + 1 < 28 then
    raise exception 'REVIEW5 FAIL [money-10 trial-anchor]: the first invoice after a 14-day trial covers % to % (% days) and charges R% (a full month)',
      i.period_start, i.period_end, i.period_end - i.period_start + 1, i.total_incl_cents / 100.0;
  end if;
end $$;
rollback;

-- == app-4: a manual retry can charge a paused farm and never an exempt one (app_retry_suspended.sql) ====
-- LENS app (round 4) [retry]: the one-invoice retry (adminRetryCharge, the owner's "Try
-- again") goes through app.invoice_chargeable_now, which was never taught the new states:
--   R1 a SUSPENDED farm with a card and an overdue invoice: no row, so the console's
--      "Retry charge R20,00" (retryOffer offers it for any status) answers
--      billing-nothing-due, "There is nothing to pay right now".
--   R2 an EXEMPT farm ("never asked to pay ... never charged", 20261029150000): still a row,
--      so a manual retry charges its card.
begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('c4520000-0000-0000-0000-000000000001', 'c4c-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test, billing_exempt) values
  ('c4200000-0000-0000-0000-000000000001', 'Lens4 Retry Paused', 'complete', 'active', 'monthly', 'c4c1@billing.invalid', false, false),
  ('c4200000-0000-0000-0000-000000000002', 'Lens4 Retry Exempt', 'complete', 'active', 'monthly', 'c4c2@billing.invalid', false, false);
insert into billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('c4720000-0000-0000-0000-000000000001', 'c4200000-0000-0000-0000-000000000001',
   'AUTH_c4synthetic1', 'c4c1@billing.invalid', 'visa', '4242', '12', '2030', true, true, 'active'),
  ('c4720000-0000-0000-0000-000000000002', 'c4200000-0000-0000-0000-000000000002',
   'AUTH_c4synthetic2', 'c4c2@billing.invalid', 'visa', '4242', '12', '2030', true, true, 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status, next_billing_on,
  current_period_start, current_period_end, anchor_day, default_payment_method_id) values
  ('c4620000-0000-0000-0000-000000000001', 'c4200000-0000-0000-0000-000000000001', 'complete', 'monthly', 'active',
   current_date + 10, current_date - 20, current_date + 9, extract(day from current_date + 10)::int, 'c4720000-0000-0000-0000-000000000001'),
  ('c4620000-0000-0000-0000-000000000002', 'c4200000-0000-0000-0000-000000000002', 'complete', 'monthly', 'active',
   current_date + 10, current_date - 20, current_date + 9, extract(day from current_date + 10)::int, 'c4720000-0000-0000-0000-000000000002');

do $$
declare n int;
begin
  for n in 1..2 loop
    insert into billing_invoices (id, farm_id, subscription_id, invoice_ref, status, kind,
      period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
      unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps)
    values (('c4820000-0000-0000-0000-00000000000' || n)::uuid, ('c4200000-0000-0000-0000-00000000000' || n)::uuid,
      ('c4620000-0000-0000-0000-00000000000' || n)::uuid, 'L4-R' || n, 'draft', 'period',
      current_date - 20, current_date + 9, current_date - 20, current_date - 20,
      'complete', 'monthly', 1, 2000, 1, 'c4520000-0000-0000-0000-000000000001', 'c4c-synthetic', 0);
    insert into billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
      months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
    values (('c4820000-0000-0000-0000-00000000000' || n)::uuid, ('c4200000-0000-0000-0000-00000000000' || n)::uuid,
      0, 'Fleet Wise complete, 1 asset', 1, 1, 2000, 2000, 2000, 0);
    update billing_invoices set status = 'open' where id = ('c4820000-0000-0000-0000-00000000000' || n)::uuid;
  end loop;
end $$;

-- R1 is paused by the nightly engine; R2 is marked exempt by Rapid Rise.
update farms set billing_exempt = true where id = 'c4200000-0000-0000-0000-000000000002';
select app.billing_apply_suspensions();

do $$
declare r1 int; r2 int; fails text := '';
begin
  if (select status from billing_subscriptions where id = 'c4620000-0000-0000-0000-000000000001') <> 'suspended' then
    raise exception 'LENS SETUP [retry]: R1 not suspended';
  end if;
  select count(*) into r1 from public.billing_invoice_chargeable_now('c4820000-0000-0000-0000-000000000001');
  select count(*) into r2 from public.billing_invoice_chargeable_now('c4820000-0000-0000-0000-000000000002');
  if r1 = 0 then
    fails := fails || ' [R1: paused farm with a card owing R20 for 20 days: chargeable_now has no row, so Retry charge says "There is nothing to pay right now"]';
  end if;
  if r2 > 0 then
    fails := fails || ' [R2: exempt farm: chargeable_now returns its invoice, so a manual retry charges the card of a farm "never asked to pay"]';
  end if;
  if fails <> '' then raise exception 'REVIEW5 FAIL [app-4 retry]:%', fails; end if;
end $$;

rollback;

-- == gate-3: a paused farm cannot buy slots while paused (gate_sql_quota_suspended.sql) ====
-- LENS gate: billing/actions.ts is OPEN_ON_PURPOSE ("paying, the card, and the cancel
-- rules"), but it also holds changeVehicleSlots, which reaches app.change_billing_quota.
-- On a SUSPENDED subscription that raises and opens a pro-rata invoice, i.e. something is
-- invoiced while suspended, which BILLING.md section 11 says never happens.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('a4c50000-0000-0000-0000-000000000001', 'gl-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('a4c00000-0000-0000-0000-000000000002', 'Gate Lens Quota', 'complete', 'active', 'monthly', 'gl2@billing.invalid', false);
insert into auth.users (id, email) values
  ('a4ca0000-0000-0000-0000-000000000002', 'gatelens.owner2@example.invalid');
insert into users (id, farm_id, role, name, email, active) values
  ('a4ca0000-0000-0000-0000-000000000002', 'a4c00000-0000-0000-0000-000000000002', 'owner', 'Gate Lens Owner2', 'gatelens.owner2@example.invalid', true);
insert into machines (farm_id, name, type, meter_type, status) values
  ('a4c00000-0000-0000-0000-000000000002', 'Quota tractor', 'tractor', 'hours', 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, suspended_at) values
  ('a4c60000-0000-0000-0000-000000000002', 'a4c00000-0000-0000-0000-000000000002', 'complete', 'monthly', 'suspended',
   current_date - 5, current_date + 24, current_date + 25, extract(day from current_date - 5)::int, 1, now() - interval '1 day');
update farms set status = 'suspended', suspended_for = 'billing' where id = 'a4c00000-0000-0000-0000-000000000002';

do $$
declare r jsonb; n int; g text;
begin
  g := app.farm_billing_gate('a4c00000-0000-0000-0000-000000000002');
  if g is distinct from 'suspended' then raise exception 'QUOTA SETUP: gate %', g; end if;
  begin
    r := app.change_billing_quota('a4c60000-0000-0000-0000-000000000002', 3);
  exception when others then
    raise notice 'change_billing_quota refused: % %', sqlstate, sqlerrm;
    return;
  end;
  select count(*) into n from billing_invoices
   where farm_id = 'a4c00000-0000-0000-0000-000000000002' and status = 'open' and deleted_at is null;
  if n > 0 then
    raise exception 'REVIEW5 FAIL [gate-3 quota-while-suspended]: a suspended farm (gate %) took more slots (%), and % open invoice(s) were raised while suspended',
      g, r, n;
  end if;
  raise notice 'quota change on suspended: % (no invoice)', r;
end $$;
rollback;

-- == gate-3: an exempt farm's slot change raises no invoice (gate_sql_quota_exempt.sql) ====
-- LENS gate/docs: BILLING.md section 11 (this round) says "an exempt farm is never
-- invoiced". changeVehicleSlots (billing/actions.ts, OPEN_ON_PURPOSE) -> app.change_billing_quota
-- raises and opens a pro-rata invoice for an exempt farm all the same.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('a4c50000-0000-0000-0000-000000000001', 'gl-synthetic', 'complete', 'monthly', 2000, 1, 0, 'active');

insert into farms (id, name, plan, status, billing_period, billing_email, is_test, billing_exempt) values
  ('a4c00000-0000-0000-0000-000000000003', 'Gate Lens Exempt', 'complete', 'active', 'monthly', 'gl3@billing.invalid', false, true);
insert into machines (farm_id, name, type, meter_type, status) values
  ('a4c00000-0000-0000-0000-000000000003', 'Exempt tractor', 'tractor', 'hours', 'active');
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota) values
  ('a4c60000-0000-0000-0000-000000000003', 'a4c00000-0000-0000-0000-000000000003', 'complete', 'monthly', 'active',
   current_date - 5, current_date + 24, current_date + 25, extract(day from current_date - 5)::int, 1);
do $$
declare r jsonb; n int;
begin
  r := app.change_billing_quota('a4c60000-0000-0000-0000-000000000003', 3);
  select count(*) into n from billing_invoices
   where farm_id = 'a4c00000-0000-0000-0000-000000000003' and status = 'open' and deleted_at is null;
  if n > 0 then
    raise exception 'REVIEW5 FAIL [gate-3 quota-exempt]: an exempt farm took more slots (%) and % open invoice(s) were raised', r, n;
  end if;
end $$;
rollback;

-- == gate-3: a paused farm cannot change plan while paused ==========================
begin;
update billing_price_versions set status = 'retired' where status = 'active';
insert into billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('f5500000-0000-0000-0000-000000000001', 'f5-synthetic-c', 'complete', 'monthly', 2000, 1, 0, 'active'),
  ('f5500000-0000-0000-0000-000000000002', 'f5-synthetic-e', 'essential', 'monthly', 1000, 1, 0, 'active');
insert into farms (id, name, plan, status, billing_period, billing_email, is_test) values
  ('f5000000-0000-0000-0000-000000000001', 'Review5 Paused Plan', 'essential', 'active', 'monthly', 'f51@billing.invalid', false);
insert into billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, anchor_day, asset_quota, suspended_at) values
  ('f5600000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'essential', 'monthly', 'suspended',
   current_date - 20, current_date + 9, current_date + 10, extract(day from current_date + 10)::int, 1, now() - interval '3 days');
update farms set status = 'suspended', suspended_for = 'billing' where id = 'f5000000-0000-0000-0000-000000000001';
do $$
declare v_msg text; n int;
begin
  begin
    perform app.change_billing_plan('f5600000-0000-0000-0000-000000000001', 'complete', 'monthly');
    raise exception 'REVIEW5 FAIL [gate-3]: a paused subscription changed plan';
  exception when sqlstate '22023' then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'BILLING: a paused subscription cannot change its slots or plan until it is paid' then
      raise exception 'REVIEW5 FAIL [gate-3]: refused with the wrong words: %', v_msg;
    end if;
  end;
  select count(*) into n from billing_invoices where farm_id = 'f5000000-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'REVIEW5 FAIL [gate-3]: % invoice(s) raised for a paused plan change', n; end if;
end $$;
rollback;
