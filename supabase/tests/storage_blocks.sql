\set ON_ERROR_STOP on
-- Paid 10 GB storage blocks on the bill (20261118120100). BRIEF section 23:
--   12  annual software with storage charged monthly: the first month on the annual invoice, the
--       next on a usage invoice the day its month starts, once;
--   26  blocks bought by hand only through an accepted, PAID quote; R49 a block a month pro rata
--       for the rest of the storage month; fewer blocks only from the next month and never below
--       what is stored; buying more cancels a scheduled reduction; nothing in the grace;
--   and the usage invoice: one per customer per day, the use of a pooled site invoiced on the
--   billing site, storage charges stamped once, the old storage meter no longer a bill.
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
-- Pays an invoice the way a card payment does: claim, then settle as succeeded.
create or replace function pg_temp.pay(p_invoice uuid, p_ref text) returns uuid language plpgsql as $$
declare v_attempt uuid; v_owed bigint;
begin
  select total_incl_cents - amount_paid_cents into v_owed from public.billing_invoices where id = p_invoice;
  v_attempt := app.claim_billing_charge(p_invoice, p_ref, 'manual_retry', v_owed);
  perform app.settle_billing_attempt(v_attempt, 'succeeded', (floor(random() * 1e9))::bigint, p_ref, 'Approved', null, v_owed, 'card', true);
  return v_attempt;
end $$;

-- == Fixtures ===============================================================================
-- M  monthly Complete, half way through a 30-day period (15 days left, today included)
-- Y  annual Essential, its storage month starting today
-- R  monthly Essential renewing today          L  monthly Complete in its grace
-- P  Main depot (monthly Essential) and Q its North depot, billed through it
insert into public.farms (id, name, plan, status, billing_period) values
  ('5b000000-0000-4000-9000-00000000000a', 'Storage yard',  'complete',  'active', 'monthly'),
  ('5b000000-0000-4000-9000-00000000000b', 'Annual yard',   'essential', 'active', 'annual'),
  ('5b000000-0000-4000-9000-00000000000c', 'Renewing yard', 'essential', 'active', 'monthly'),
  ('5b000000-0000-4000-9000-00000000000d', 'Late yard',     'complete',  'active', 'monthly'),
  ('5b000000-0000-4000-9000-00000000000e', 'Main depot',    'essential', 'active', 'monthly'),
  ('5b000000-0000-4000-9000-00000000000f', 'North depot',   'essential', 'active', 'monthly');
update public.farms set billed_through = '5b000000-0000-4000-9000-00000000000e'
 where id = '5b000000-0000-4000-9000-00000000000f';
insert into auth.users (id, email)
select ('5b100000-0000-4000-9000-00000000000' || n)::uuid, 'blocks' || n || '@storage.test' from generate_series(1, 6) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('5b100000-0000-4000-9000-000000000001', '5b000000-0000-4000-9000-00000000000a', 'owner',   'Owner M', 'blocks1@storage.test', true),
  ('5b100000-0000-4000-9000-000000000002', '5b000000-0000-4000-9000-00000000000a', 'manager', 'Manager M', 'blocks2@storage.test', true),
  ('5b100000-0000-4000-9000-000000000003', '5b000000-0000-4000-9000-00000000000b', 'owner',   'Owner Y', 'blocks3@storage.test', true),
  ('5b100000-0000-4000-9000-000000000004', '5b000000-0000-4000-9000-00000000000d', 'owner',   'Owner L', 'blocks4@storage.test', true),
  ('5b100000-0000-4000-9000-000000000005', '5b000000-0000-4000-9000-00000000000e', 'owner',   'Owner P', 'blocks5@storage.test', true),
  ('5b100000-0000-4000-9000-000000000006', '5b000000-0000-4000-9000-00000000000f', 'operator', 'Driver Q', 'blocks6@storage.test', true);
do $fx$
declare v_today date := app.billing_today();
begin
  insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
    current_period_start, current_period_end, next_billing_on, anchor_day) values
    ('5b600000-0000-4000-9000-00000000000a', '5b000000-0000-4000-9000-00000000000a', 'complete', 'monthly', 'active', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('5b600000-0000-4000-9000-00000000000b', '5b000000-0000-4000-9000-00000000000b', 'essential', 'annual', 'active', 5, 0,
     (v_today - interval '1 month')::date, (v_today - interval '1 month' + interval '1 year')::date - 1,
     (v_today - interval '1 month' + interval '1 year')::date, extract(day from v_today)::int),
    ('5b600000-0000-4000-9000-00000000000c', '5b000000-0000-4000-9000-00000000000c', 'essential', 'monthly', 'active', 5, 0,
     current_date - 30, current_date - 1, current_date, extract(day from current_date)::int),
    ('5b600000-0000-4000-9000-00000000000d', '5b000000-0000-4000-9000-00000000000d', 'complete', 'monthly', 'past_due', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int),
    ('5b600000-0000-4000-9000-00000000000e', '5b000000-0000-4000-9000-00000000000e', 'essential', 'monthly', 'active', 5, 0,
     v_today - 15, v_today + 14, v_today + 15, extract(day from v_today - 15)::int);
end $fx$;
insert into public.billing_payment_methods (id, farm_id, authorization_code, authorization_email,
  card_brand, last4, exp_month, exp_year, reusable, is_default, status) values
  ('5b700000-0000-4000-9000-00000000000a', '5b000000-0000-4000-9000-00000000000a',
   'AUTH_' || 'blockssynthetic', 'blocks1@storage.test', 'visa', '4242', '12', '2030', true, true, 'active');
update public.billing_subscriptions set default_payment_method_id = '5b700000-0000-4000-9000-00000000000a'
 where id = '5b600000-0000-4000-9000-00000000000a';
insert into public.machines (id, farm_id, name, type) values
  ('5b200000-0000-4000-9000-00000000000a', '5b000000-0000-4000-9000-00000000000a', 'Yard truck', 'truck');

-- == 26: buying a block by hand =============================================================
do $t$
declare
  v jsonb; r jsonb; q public.billing_change_quotes; i public.billing_invoices; v_msg text;
begin
  -- Only the owner (or Rapid Rise) may price a purchase.
  v_msg := pg_temp.try($s$select app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 1, '5b100000-0000-4000-9000-000000000002')$s$);
  if v_msg <> 'forbidden' then raise exception 'BLOCKS FAIL [26]: a manager priced a block: %', v_msg; end if;

  -- One block for 15 of 30 days: R24.50.
  v := app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 1, '5b100000-0000-4000-9000-000000000001');
  if v ->> 'kind' <> 'now' or (v #>> '{money,charge_now_cents}')::bigint <> 2450
     or (v #>> '{money,next_renewal_cents}')::bigint <> 4900 or (v #>> '{period,days_remaining}')::int <> 15 then
    raise exception 'BLOCKS FAIL [26]: one block for half a month is not R24.50: %', v;
  end if;
  select * into q from public.billing_change_quotes where id = (v ->> 'quote_id')::uuid;
  if q.change <> 'storage' or q.from_storage_blocks <> 0 or q.to_storage_blocks <> 1 or q.status <> 'quoted' then
    raise exception 'BLOCKS FAIL [26]: the quote was not kept: %', to_jsonb(q);
  end if;
  -- Accepting other amounts than the ones shown is refused.
  v_msg := pg_temp.try(format($s$select app.billing_accept_quote(%L, '5b100000-0000-4000-9000-000000000001', 2000, 0, 4900)$s$, q.id));
  if v_msg <> 'quote-changed' then raise exception 'BLOCKS FAIL [26]: other amounts were accepted: %', v_msg; end if;

  r := app.billing_accept_quote(q.id, '5b100000-0000-4000-9000-000000000001', 2450, 0, 4900);
  if r ->> 'applied' <> 'awaiting_payment' then raise exception 'BLOCKS FAIL [26]: a block did not wait for payment: %', r; end if;
  select * into i from public.billing_invoices where id = (r ->> 'invoice_id')::uuid;
  if i.kind <> 'change' or i.total_incl_cents <> 2450 or i.status <> 'open'
     or not exists (select 1 from public.billing_invoice_lines l where l.invoice_id = i.id and l.description like '%1 more 10 GB storage block%') then
    raise exception 'BLOCKS FAIL [26]: the change invoice is wrong: %', to_jsonb(i);
  end if;
  -- Not paid: no block, no more room.
  if (select storage_blocks from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000a') <> 0
     or app.storage_quota_bytes('5b000000-0000-4000-9000-00000000000a') <> 2000000000 then
    raise exception 'BLOCKS FAIL [26]: the block came before the payment';
  end if;
  perform pg_temp.pay(i.id, 'FWB-TEST-BLOCK-1');
  if (select storage_blocks from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000a') <> 1
     or app.storage_quota_bytes('5b000000-0000-4000-9000-00000000000a') <> 12000000000
     or (select status from public.billing_change_quotes where id = q.id) <> 'applied' then
    raise exception 'BLOCKS FAIL [26]: paying did not add the block';
  end if;
  -- The renewal date is untouched.
  if (select current_period_end from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000a') <> app.billing_today() + 14 then
    raise exception 'BLOCKS FAIL [26]: buying a block moved the renewal';
  end if;
end $t$;

-- A price whose basis moved is refused rather than charged.
do $t$
declare v jsonb; v_msg text;
begin
  v := app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 2, '5b100000-0000-4000-9000-000000000001');
  update public.billing_subscriptions set storage_blocks = 2 where id = '5b600000-0000-4000-9000-00000000000a';
  v_msg := pg_temp.try(format($s$select app.billing_accept_quote(%L, '5b100000-0000-4000-9000-000000000001', 2450, 0, 9800)$s$, v ->> 'quote_id'));
  if v_msg <> 'quote-changed' then raise exception 'BLOCKS FAIL [26]: a stale block price was accepted: %', v_msg; end if;
  update public.billing_subscriptions set storage_blocks = 1 where id = '5b600000-0000-4000-9000-00000000000a';
end $t$;

-- Nothing that costs money in the grace.
do $t$
declare v jsonb;
begin
  v := app.storage_change_state('5b600000-0000-4000-9000-00000000000d', 1, app.billing_today());
  if v ->> 'kind' <> 'unavailable' or v ->> 'reason' <> 'billing-grace-no-extras' then
    raise exception 'BLOCKS FAIL [26]: a block was offered in the grace: %', v;
  end if;
end $t$;

-- == 26: giving blocks back =================================================================
do $t$
declare v jsonb; r jsonb; v_q uuid; s public.billing_subscriptions;
begin
  update public.billing_subscriptions set storage_blocks = 2 where id = '5b600000-0000-4000-9000-00000000000a';
  -- 12 GB stored: two blocks (22 GB) down to one (12 GB) fits only just; down to none does not.
  insert into public.upload_intents (farm_id, user_id, target_kind, target_id, label, bucket, object_path,
    media_class, purpose, declared_mime, declared_bytes, reserved_bytes, counts_against_quota,
    actual_mime, actual_bytes, status, request_id, expires_at, finalised_at)
  values ('5b000000-0000-4000-9000-00000000000a', '5b100000-0000-4000-9000-000000000001', 'machine',
    '5b200000-0000-4000-9000-00000000000a', 'photo', 'machine-photos', '5b000000-0000-4000-9000-00000000000a/x/photo-big.jpg',
    'photo', 'attachment', 'image/jpeg', 11000000000, 11000000000, true, 'image/jpeg', 11000000000, 'finalised',
    gen_random_uuid(), now() + interval '1 hour', now());
  v := app.storage_change_state('5b600000-0000-4000-9000-00000000000a', 0, app.billing_today());
  if v ->> 'kind' <> 'unavailable' or v ->> 'reason' <> 'storage-reduction-over-usage' then
    raise exception 'BLOCKS FAIL [26]: a reduction below what is stored was offered: %', v;
  end if;
  v := app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 1, '5b100000-0000-4000-9000-000000000001');
  if v ->> 'kind' <> 'renewal' or (v ->> 'effective_on')::date <> app.billing_today() + 15
     or (v #>> '{money,charge_now_cents}')::bigint <> 0 or (v #>> '{money,next_renewal_cents}')::bigint <> 4900 then
    raise exception 'BLOCKS FAIL [26]: a reduction is not from the next storage month: %', v;
  end if;
  v_q := (v ->> 'quote_id')::uuid;
  r := app.billing_accept_quote(v_q, '5b100000-0000-4000-9000-000000000001', 0, 0, 4900);
  select * into s from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000a';
  if r ->> 'applied' <> 'scheduled' or s.storage_blocks <> 2 or s.pending_storage_blocks <> 1
     or s.pending_storage_blocks_on <> app.billing_today() + 15 then
    raise exception 'BLOCKS FAIL [26]: the reduction was not scheduled, or applied now: % %', r, to_jsonb(s);
  end if;
  -- Cancelling it puts things back.
  perform app.billing_cancel_quote(v_q, '5b100000-0000-4000-9000-000000000001');
  if (select pending_storage_blocks from public.billing_subscriptions where id = s.id) is not null then
    raise exception 'BLOCKS FAIL [26]: cancelling the reduction left it pending';
  end if;
  -- Scheduled again, then overtaken by buying a third block.
  v := app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 1, '5b100000-0000-4000-9000-000000000001');
  perform app.billing_accept_quote((v ->> 'quote_id')::uuid, '5b100000-0000-4000-9000-000000000001', 0, 0, 4900);
  v := app.billing_quote_storage('5b600000-0000-4000-9000-00000000000a', 3, '5b100000-0000-4000-9000-000000000001');
  if (v #>> '{money,charge_now_cents}')::bigint <> 2450 or (v #>> '{money,current_renewal_cents}')::bigint <> 4900
     or (v #>> '{money,next_renewal_cents}')::bigint <> 14700 then
    raise exception 'BLOCKS FAIL [26]: the third block is priced wrongly: %', v;
  end if;
  r := app.billing_accept_quote((v ->> 'quote_id')::uuid, '5b100000-0000-4000-9000-000000000001', 2450, 0, 14700);
  perform pg_temp.pay((r ->> 'invoice_id')::uuid, 'FWB-TEST-BLOCK-3');
  select * into s from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000a';
  if s.storage_blocks <> 3 or s.pending_storage_blocks is not null
     or exists (select 1 from public.billing_change_quotes where subscription_id = s.id and change = 'storage' and status = 'scheduled') then
    raise exception 'BLOCKS FAIL [26]: buying more did not cancel the scheduled reduction: %', to_jsonb(s);
  end if;
end $t$;

-- == The month's blocks on the period invoice ==============================================
-- Renewing today with two blocks, one reduction to one scheduled for today, and an automatic
-- block's part not yet invoiced.
do $t$
declare i public.billing_invoices; v_n integer;
begin
  update public.billing_subscriptions
     set storage_blocks = 2, pending_storage_blocks = 1, pending_storage_blocks_on = current_date
   where id = '5b600000-0000-4000-9000-00000000000c';
  insert into public.storage_charges (farm_id, subscription_id, kind, blocks, unit_incl_cents, period_start, period_end,
                                      days_charged, days_in_period, amount_incl_cents)
  values ('5b000000-0000-4000-9000-00000000000c', '5b600000-0000-4000-9000-00000000000c', 'auto_block', 1, 4900,
          current_date - 10, current_date - 1, 10, 30, 1633);
  v_n := app.generate_billing_invoices('5b600000-0000-4000-9000-00000000000c');
  select * into i from public.billing_invoices where subscription_id = '5b600000-0000-4000-9000-00000000000c' and kind = 'period';
  if v_n <> 1 or i.storage_incl_cents <> 4900 + 1633 or i.storage_blocks <> 1
     or i.total_incl_cents <> 24500 + 4900 + 1633 then
    raise exception 'BLOCKS FAIL [26]: the period invoice''s storage is wrong (reduction first, then one block and the part): %',
      to_jsonb(i);
  end if;
  if (select count(*) from public.billing_invoice_lines where invoice_id = i.id and sort_order = 5) <> 2
     or (select count(*) from public.storage_charges where invoice_id = i.id) <> 2
     or exists (select 1 from public.storage_charges where subscription_id = '5b600000-0000-4000-9000-00000000000c' and invoice_id is null) then
    raise exception 'BLOCKS FAIL [26]: the storage charges were not stamped once';
  end if;
  if (select storage_blocks from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000c') <> 1
     or (select pending_storage_blocks from public.billing_subscriptions where id = '5b600000-0000-4000-9000-00000000000c') is not null then
    raise exception 'BLOCKS FAIL [26]: the scheduled reduction did not land at the renewal';
  end if;
  -- The issued invoice's storage is frozen.
  if pg_temp.try(format('update public.billing_invoices set storage_incl_cents = 1 where id = %L', i.id)) = 'ok' then
    raise exception 'BLOCKS FAIL [26]: an issued invoice''s storage changed';
  end if;
  -- A second run raises nothing and bills the month again nowhere.
  if app.generate_billing_invoices('5b600000-0000-4000-9000-00000000000c') <> 0
     or (select count(*) from public.storage_charges where subscription_id = '5b600000-0000-4000-9000-00000000000c' and kind = 'monthly') <> 1 then
    raise exception 'BLOCKS FAIL [26]: a second run billed the storage month again';
  end if;
end $t$;

-- == 12: annual software, storage monthly ===================================================
do $t$
declare i public.billing_invoices; v_n integer;
begin
  update public.billing_subscriptions set storage_blocks = 1 where id = '5b600000-0000-4000-9000-00000000000b';
  -- Its storage month starts today: the usage run raises R49 for it, with no AI use at all.
  v_n := app.generate_ai_usage_invoices();
  select * into i from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000b' and kind = 'ai_usage';
  if v_n < 1 or i.id is null or i.total_incl_cents <> 4900 or i.storage_incl_cents <> 4900 or i.status <> 'open'
     or i.period_start <> app.billing_today() then
    raise exception 'BLOCKS FAIL [12]: the annual subscriber''s monthly storage invoice is wrong: %', to_jsonb(i);
  end if;
  -- Run again the same day: nothing more.
  perform app.generate_ai_usage_invoices();
  if (select count(*) from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000b') <> 1
     or (select count(*) from public.storage_charges where subscription_id = '5b600000-0000-4000-9000-00000000000b') <> 1 then
    raise exception 'BLOCKS FAIL [12]: the storage month was invoiced twice';
  end if;
  -- One usage invoice per customer per day, held by the database too.
  if pg_temp.try(format($s$insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind,
        period_start, period_end, issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents,
        months_charged, price_version_label, vat_rate_bps)
      values (%L, %L, 'FWB-DUP-USAGE', 'draft', 'ai_usage', current_date - 40, current_date - 35, %L, %L,
              'essential', 'annual', 0, 0, 1, 'dup', 0)$s$,
      '5b000000-0000-4000-9000-00000000000b', '5b600000-0000-4000-9000-00000000000b', i.issued_on, i.issued_on)) not like '%billing_invoices_usage_day_uq%' then
    raise exception 'BLOCKS FAIL [12]: a second usage invoice on one day was allowed';
  end if;
  -- The renewal notice and the annual price are untouched: storage is a separate monthly charge.
  if exists (select 1 from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000b' and kind = 'period') then
    raise exception 'BLOCKS FAIL [12]: storage raised a period invoice';
  end if;
end $t$;

-- An annual renewal carries its first storage month only, and a month already charged (here by
-- the usage run this morning) is never charged again.
insert into public.farms (id, name, plan, status, billing_period) values
  ('5b000000-0000-4000-9000-000000000010', 'Annual renewing', 'essential', 'active', 'annual');
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
  storage_blocks, current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('5b600000-0000-4000-9000-000000000010', '5b000000-0000-4000-9000-000000000010', 'essential', 'annual', 'active', 5, 0,
   1, current_date - 365, current_date - 1, current_date, extract(day from current_date)::int);
do $t$
declare i public.billing_invoices; v_price bigint;
begin
  update public.billing_subscriptions
     set current_period_start = current_date - 365, current_period_end = current_date - 1, next_billing_on = current_date
   where id = '5b600000-0000-4000-9000-00000000000b';
  perform app.generate_billing_invoices('5b600000-0000-4000-9000-00000000000b');
  select * into i from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000b' and kind = 'period';
  if i.storage_incl_cents <> 0 or (select count(*) from public.storage_charges where subscription_id = '5b600000-0000-4000-9000-00000000000b') <> 1 then
    raise exception 'BLOCKS FAIL [12]: a storage month already invoiced was charged again: %', to_jsonb(i);
  end if;

  perform app.generate_billing_invoices('5b600000-0000-4000-9000-000000000010');
  select * into i from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-000000000010' and kind = 'period';
  select (app.billing_price_for_subscription('5b600000-0000-4000-9000-000000000010')).period_price_incl_cents into v_price;
  if i.storage_incl_cents <> 4900 or i.total_incl_cents <> v_price * 5 + 4900
     or not exists (select 1 from public.storage_charges c where c.invoice_id = i.id and c.kind = 'monthly'
                     and c.period_start = current_date and c.period_end < current_date + 32) then
    raise exception 'BLOCKS FAIL [12]: the annual invoice did not carry exactly one month of storage: % (price %)', to_jsonb(i), v_price;
  end if;
end $t$;

-- == A pooled site's use is invoiced on the billing site ===================================
do $t$
declare v_res uuid; i public.billing_invoices;
begin
  update public.billing_settings set ai_billing_starts_on = current_date - 60 where singleton;
  insert into public.ai_reservations (id, farm_id, user_id, feature, credential, model, estimate_cents, month, settled_at)
  values (gen_random_uuid(), '5b000000-0000-4000-9000-00000000000f', '5b100000-0000-4000-9000-000000000006',
          'ai_answer', 'platform', 'openai/gpt-4.1-mini', 6000, app.ai_month(now() - interval '2 days'), now())
  returning id into v_res;
  insert into public.ai_usage (farm_id, user_id, occurred_at, month, feature, provider, model, credential, measured,
    provider_cost_usd, usd_zar, margin_bps, billed_cents, outcome, reservation_id)
  values ('5b000000-0000-4000-9000-00000000000f', '5b100000-0000-4000-9000-000000000006', now() - interval '2 days',
          app.ai_month(now() - interval '2 days'), 'ai_answer', 'ai_gateway', 'openai/gpt-4.1-mini', 'platform', 'server',
          2.5, 18, 3000, 5850, 'ok', v_res);
  -- Its day: the billing site's anchor.
  update public.billing_subscriptions set anchor_day = extract(day from app.billing_today())::int
   where id = '5b600000-0000-4000-9000-00000000000e';
  perform app.generate_ai_usage_invoices();
  select * into i from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000e' and kind = 'ai_usage';
  if i.id is null or i.ai_usage_ex_vat_cents <> 5850 then
    raise exception 'BLOCKS FAIL [usage]: the North depot''s AI use was not invoiced on the main depot: %', to_jsonb(i);
  end if;
  if exists (select 1 from public.billing_invoices where farm_id = '5b000000-0000-4000-9000-00000000000f') then
    raise exception 'BLOCKS FAIL [usage]: a pooled site got an invoice of its own';
  end if;
end $t$;

-- == The old storage meter is a measurement, never a bill ===================================
do $t$
declare r record;
begin
  insert into public.storage_usage_snapshots (farm_id, measured_on, root_farm_id, tracked_bytes, untracked_bytes)
  values ('5b000000-0000-4000-9000-00000000000a', date_trunc('month', current_date)::date, '5b000000-0000-4000-9000-00000000000a', 7, 5);
  select * into r from public.usage_for_month(current_date) u where u.farm_id = '5b000000-0000-4000-9000-00000000000a';
  if r.storage_bytes <> 12 then
    raise exception 'BLOCKS FAIL [meter]: the month''s storage is not the measured one: %', r.storage_bytes;
  end if;
  -- A month with no measurement says nothing, rather than today's storage.
  if exists (select 1 from public.usage_for_month((current_date - interval '3 months')::date) u
              where u.farm_id = '5b000000-0000-4000-9000-00000000000a' and u.storage_bytes > 0) then
    raise exception 'BLOCKS FAIL [meter]: a past month was reconstructed from today';
  end if;
end $t$;

rollback;
