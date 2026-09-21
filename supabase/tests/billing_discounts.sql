-- Founding Farmer pricing: what a discount does to an invoice, and what it must never do.
--
-- Discounts are derived in `app.billing_derive_invoice_totals` rather than in the three
-- functions that raise invoices, so the assertions here are about the invoice that comes
-- out: the list price still on the document, the discount beside it, a total that cannot go
-- negative, and — once issued — a document that does not restate itself when the deal
-- changes later.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

-- The price comes from whatever version is ACTIVE for complete/monthly — seeded by
-- 20260904120000 — rather than a figure invented here. Every expectation below is derived
-- from it, so this suite cannot start disagreeing with the catalogue.
create temporary table _d_price as
  select per_vehicle_monthly_incl_cents as unit, months_charged as months
    from public.billing_price_versions
   where plan = 'complete' and billing_period = 'monthly' and status = 'active'
   limit 1;
do $$
begin
  if not exists (select 1 from _d_price where unit is not null) then
    raise exception 'DISCOUNT SETUP: no active complete/monthly price to test against';
  end if;
end $$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('d1000000-0000-4000-9000-000000000001', 'Founding farm', 'complete', 'active', 'monthly'),
  ('d1000000-0000-4000-9000-000000000002', 'Small farm', 'complete', 'active', 'monthly'),
  ('d1000000-0000-4000-9000-000000000003', 'Expired deal farm', 'complete', 'active', 'monthly'),
  ('d1000000-0000-4000-9000-000000000004', 'List price farm', 'complete', 'active', 'monthly');

-- Ten vehicles, billed at whatever the active price says a vehicle costs.
insert into public.machines (farm_id, name, type, meter_type, status)
select f.id, 'M' || g::text, 'tractor', 'hours', 'active'
  from public.farms f,
       generate_series(1, 10) g
 where f.id in ('d1000000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000003',
                'd1000000-0000-4000-9000-000000000004');
-- One vehicle, which costs less than the fixed discount below.
insert into public.machines (farm_id, name, type, meter_type, status)
values ('d1000000-0000-4000-9000-000000000002', 'Only one', 'tractor', 'hours', 'active');

insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, next_billing_on,
  discount_percent_bps, discount_fixed_cents, discount_label, discount_until) values
  -- 20% off, for life.
  ('d1600000-0000-4000-9000-000000000001', 'd1000000-0000-4000-9000-000000000001',
   'complete', 'monthly', 'active', current_date, current_date, 2000, null, 'Founding Farmer', null),
  -- R500,00 off a R100,00 invoice: more than the bill.
  ('d1600000-0000-4000-9000-000000000002', 'd1000000-0000-4000-9000-000000000002',
   'complete', 'monthly', 'active', current_date, current_date, null, 50000, 'Oversized deal', null),
  -- A deal that ended yesterday.
  ('d1600000-0000-4000-9000-000000000003', 'd1000000-0000-4000-9000-000000000003',
   'complete', 'monthly', 'active', current_date, current_date, 2000, null, 'Lapsed', current_date - 1),
  -- No deal at all.
  ('d1600000-0000-4000-9000-000000000004', 'd1000000-0000-4000-9000-000000000004',
   'complete', 'monthly', 'active', current_date, current_date, null, null, null, null);

-- ── (a) A percentage comes off, and the list price stays on the document ────
do $$
declare inv public.billing_invoices%rowtype; n integer; v_gross bigint;
begin
  select unit * 10 * months into v_gross from _d_price;
  n := app.generate_billing_invoices('d1600000-0000-4000-9000-000000000001');
  if n <> 1 then raise exception 'DISCOUNT FAIL: the generator made % invoices', n; end if;

  select * into inv from public.billing_invoices
   where subscription_id = 'd1600000-0000-4000-9000-000000000001';

  -- The snapshot is still the LIST price and the real count: a farm that is given 20% is
  -- not a farm on a secret cheaper price, and the invoice has to be able to show both.
  if inv.unit_price_incl_cents <> (select unit from _d_price) or inv.asset_count <> 10 then
    raise exception 'DISCOUNT FAIL: the price snapshot was rewritten (% x %)',
      inv.unit_price_incl_cents, inv.asset_count;
  end if;
  -- 20% of ten vehicles at the list price, and the total is the rest of it.
  if inv.discount_cents <> round(v_gross::numeric * 0.20)::bigint then
    raise exception 'DISCOUNT FAIL: discount was % cents, expected % (gross %)',
      inv.discount_cents, round(v_gross::numeric * 0.20)::bigint, v_gross;
  end if;
  if inv.total_incl_cents <> v_gross - inv.discount_cents then
    raise exception 'DISCOUNT FAIL: total was %, expected %',
      inv.total_incl_cents, v_gross - inv.discount_cents;
  end if;
  if inv.subtotal_ex_vat_cents + inv.vat_cents <> inv.total_incl_cents then
    raise exception 'DISCOUNT FAIL: the VAT split no longer adds up to the total';
  end if;
  -- The customer is told what they were given, by name.
  if coalesce(inv.discount_label, '') <> 'Founding Farmer' then
    raise exception 'DISCOUNT FAIL: the invoice does not name the deal (%)', inv.discount_label;
  end if;
end $$;

-- ── (b) A discount bigger than the bill leaves nothing owing, never less ────
do $$
declare inv public.billing_invoices%rowtype; v_gross bigint;
begin
  select unit * 1 * months into v_gross from _d_price;
  perform app.generate_billing_invoices('d1600000-0000-4000-9000-000000000002');
  select * into inv from public.billing_invoices
   where subscription_id = 'd1600000-0000-4000-9000-000000000002';
  if inv.discount_cents <> v_gross then
    raise exception 'DISCOUNT FAIL: the discount was not clamped to the bill (% of %)',
      inv.discount_cents, v_gross;
  end if;
  if inv.total_incl_cents <> 0 then
    raise exception 'DISCOUNT FAIL: total is % — an invoice must never go negative', inv.total_incl_cents;
  end if;
end $$;

-- ── (c) A deal that has ended is not applied ────────────────────────────────
do $$
declare inv public.billing_invoices%rowtype; v_gross bigint;
begin
  select unit * 10 * months into v_gross from _d_price;
  perform app.generate_billing_invoices('d1600000-0000-4000-9000-000000000003');
  select * into inv from public.billing_invoices
   where subscription_id = 'd1600000-0000-4000-9000-000000000003';
  if inv.discount_cents <> 0 or inv.total_incl_cents <> v_gross then
    raise exception 'DISCOUNT FAIL: an expired deal still took % off (total % of %)',
      inv.discount_cents, inv.total_incl_cents, v_gross;
  end if;
end $$;

-- ── (d) A farm with no deal bills exactly as it did before any of this ──────
do $$
declare inv public.billing_invoices%rowtype; v_gross bigint;
begin
  select unit * 10 * months into v_gross from _d_price;
  perform app.generate_billing_invoices('d1600000-0000-4000-9000-000000000004');
  select * into inv from public.billing_invoices
   where subscription_id = 'd1600000-0000-4000-9000-000000000004';
  if inv.discount_cents <> 0 or inv.total_incl_cents <> v_gross then
    raise exception 'DISCOUNT FAIL: a farm with no discount was billed % (discount %)',
      inv.total_incl_cents, inv.discount_cents;
  end if;
end $$;

-- ── (e) An issued invoice does not restate itself when the deal changes ─────
do $$
declare inv public.billing_invoices%rowtype; v_expect_discount bigint; v_expect_total bigint;
begin
  select discount_cents, total_incl_cents into v_expect_discount, v_expect_total
    from public.billing_invoices where subscription_id = 'd1600000-0000-4000-9000-000000000001';
  -- The deal is withdrawn AFTER the invoice was issued.
  update public.billing_subscriptions
     set discount_percent_bps = null, discount_label = null
   where id = 'd1600000-0000-4000-9000-000000000001';

  -- Something ordinary touches the invoice: a payment is recorded against it.
  update public.billing_invoices
     set amount_paid_cents = 1000
   where subscription_id = 'd1600000-0000-4000-9000-000000000001';

  select * into inv from public.billing_invoices
   where subscription_id = 'd1600000-0000-4000-9000-000000000001';
  if inv.discount_cents <> v_expect_discount or inv.total_incl_cents <> v_expect_total then
    raise exception 'DISCOUNT FAIL: an issued invoice was restated (discount %, total %)',
      inv.discount_cents, inv.total_incl_cents;
  end if;
end $$;

-- ── (f) A promo code is taken once, and only while there is room ────────────
insert into public.billing_promo_codes (code, label, discount_percent_bps, max_uses) values
  ('FOUNDING20', 'Founding Farmer', 2000, 1);

insert into public.farms (id, name, plan, status, billing_period) values
  ('d1000000-0000-4000-9000-000000000005', 'Code farm', 'complete', 'active', 'monthly'),
  ('d1000000-0000-4000-9000-000000000006', 'Late farm', 'complete', 'active', 'monthly');
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status) values
  ('d1600000-0000-4000-9000-000000000005', 'd1000000-0000-4000-9000-000000000005', 'complete', 'monthly', 'pending'),
  ('d1600000-0000-4000-9000-000000000006', 'd1000000-0000-4000-9000-000000000006', 'complete', 'monthly', 'pending');

do $$
declare v jsonb; s public.billing_subscriptions%rowtype;
begin
  -- Lower case, as a farmer would type it off the offer sheet at six in the morning.
  v := app.billing_take_promo_code('d1600000-0000-4000-9000-000000000005', 'founding20');
  if coalesce((v->>'ok')::boolean, false) is not true then
    raise exception 'DISCOUNT FAIL: a valid code was refused (%)', v;
  end if;

  select * into s from public.billing_subscriptions where id = 'd1600000-0000-4000-9000-000000000005';
  if s.discount_percent_bps <> 2000 or s.discount_code <> 'FOUNDING20' then
    raise exception 'DISCOUNT FAIL: the code did not reach the subscription';
  end if;
  -- Copied, not referenced: "locked for life" must not depend on a row somebody edits.
  if coalesce(s.discount_label, '') <> 'Founding Farmer' then
    raise exception 'DISCOUNT FAIL: the deal lost its name';
  end if;

  -- The twentieth place is taken: the twenty-first farm is refused.
  v := app.billing_take_promo_code('d1600000-0000-4000-9000-000000000006', 'FOUNDING20');
  if v->>'error' <> 'used_up' then
    raise exception 'DISCOUNT FAIL: a used-up code was accepted (%)', v;
  end if;

  -- And the same farm cannot stack a second deal on top of its own.
  v := app.billing_take_promo_code('d1600000-0000-4000-9000-000000000005', 'FOUNDING20');
  if v->>'error' <> 'already_discounted' then
    raise exception 'DISCOUNT FAIL: a second discount was stacked (%)', v;
  end if;

  -- An unknown code says only that it is unknown.
  v := app.billing_take_promo_code('d1600000-0000-4000-9000-000000000006', 'NOSUCHCODE');
  if v->>'error' <> 'unknown' then
    raise exception 'DISCOUNT FAIL: an unknown code answered % ', v;
  end if;
end $$;

-- ── (g) Only Rapid Rise's own path may set one ──────────────────────────────
do $$
declare v_denied boolean := false;
begin
  if has_function_privilege('authenticated',
       'public.billing_set_subscription_discount(uuid,integer,bigint,text,date)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.billing_set_subscription_discount(uuid,integer,bigint,text,date)', 'EXECUTE') then
    raise exception 'DISCOUNT FAIL: a browser session may change what a farm pays';
  end if;
  if has_function_privilege('authenticated',
       'public.billing_take_promo_code(uuid,text)', 'EXECUTE') then
    raise exception 'DISCOUNT FAIL: a browser session may take promo codes';
  end if;

  -- A percentage and an amount together is an argument in front of a customer.
  begin
    perform public.billing_set_subscription_discount(
      'd1600000-0000-4000-9000-000000000004', 2000, 5000, 'Both', null);
  exception when others then v_denied := true;
  end;
  if not v_denied then
    raise exception 'DISCOUNT FAIL: a percentage and an amount were accepted together';
  end if;
end $$;

-- ── (h) A code typed at sign-up reaches the FIRST invoice ───────────────────
--
-- The one this feature exists for, and the one that would have shipped broken. A discount
-- is frozen onto an invoice while it is a draft, and `app.create_pending_signup` raises
-- the first invoice inside its own transaction — so a code applied from the sign-up route
-- AFTER that call returns would take effect from the SECOND period, and the farm would pay
-- list price for the exact thing they entered the code for. `p_promo_code` puts it between
-- creating the subscription and invoicing it, which is the only window that works.
insert into auth.users (id, email) values
  ('d1a00000-0000-4000-9000-000000000001', 'promo.signup@billing.invalid'),
  ('d1a00000-0000-4000-9000-000000000002', 'promo.badcode@billing.invalid');

do $$
declare
  v_sub  uuid;
  inv    public.billing_invoices%rowtype;
  s      public.billing_subscriptions%rowtype;
  v_unit bigint;
  v_gross bigint;
  v_failed boolean := false;
  n bigint;
begin
  select unit into v_unit from _d_price;

  -- SIGNUP25 is a fresh code so this section does not depend on what (f) left behind.
  insert into public.billing_promo_codes (code, label, discount_percent_bps, max_uses)
  values ('SIGNUP25', 'Launch offer', 2500, 5);

  v_sub := app.create_pending_signup(
    'd1a00000-0000-4000-9000-000000000001', 'promo.signup@billing.invalid',
    'Promo Owner', 'Promo Boerdery', 'complete', 'monthly', 4, 'signup25');

  select * into s from public.billing_subscriptions where id = v_sub;
  if s.discount_percent_bps <> 2500 or s.discount_code <> 'SIGNUP25' then
    raise exception 'DISCOUNT FAIL [h]: the code did not reach the subscription (% / %)',
      s.discount_percent_bps, s.discount_code;
  end if;
  -- Lower case in, upper case matched: a farmer typing at six in the morning.
  if s.discount_label <> 'Launch offer' then
    raise exception 'DISCOUNT FAIL [h]: the label on the deal is "%"', s.discount_label;
  end if;

  select * into inv from public.billing_invoices where subscription_id = v_sub;
  if inv.id is null then
    raise exception 'DISCOUNT FAIL [h]: the sign-up raised no invoice at all';
  end if;

  v_gross := inv.unit_price_incl_cents * inv.asset_count * inv.months_charged;
  -- THE assertion. The first invoice — the one they are about to pay at checkout — is
  -- discounted, not the second.
  if inv.discount_cents <> round(v_gross::numeric * 2500 / 10000)::bigint then
    raise exception 'DISCOUNT FAIL [h]: the first invoice took off % against a gross of %',
      inv.discount_cents, v_gross;
  end if;
  if inv.total_incl_cents <> v_gross - inv.discount_cents then
    raise exception 'DISCOUNT FAIL [h]: the first invoice totals % on a gross of % less %',
      inv.total_incl_cents, v_gross, inv.discount_cents;
  end if;
  -- The list price is still on the document: what it costs, and what they were given.
  if inv.unit_price_incl_cents <> v_unit then
    raise exception 'DISCOUNT FAIL [h]: the unit price was rewritten to %',
      inv.unit_price_incl_cents;
  end if;

  -- The place on the offer was spent, once.
  select used_count into n from public.billing_promo_codes where code = 'SIGNUP25';
  if n <> 1 then
    raise exception 'DISCOUNT FAIL [h]: the code was used % times by one sign-up', n;
  end if;

  -- A bad code ABORTS the sign-up. Taking somebody's money at list price because the code
  -- they typed was wrong is the version of this they would be entitled to be angry about,
  -- so nothing is written and the route deletes the auth user and says so.
  begin
    perform app.create_pending_signup(
      'd1a00000-0000-4000-9000-000000000002', 'promo.badcode@billing.invalid',
      'Wrong Code', 'Wrong Code Boerdery', 'complete', 'monthly', 4, 'NOSUCHCODE');
  exception when others then
    v_failed := true;
    if sqlerrm not like 'SIGNUP_PROMO:%' then
      raise exception 'DISCOUNT FAIL [h]: a bad code raised "%" — the route matches on the prefix', sqlerrm;
    end if;
  end;
  if not v_failed then
    raise exception 'DISCOUNT FAIL [h]: a sign-up with an unknown code was allowed through';
  end if;

  -- A blank code is not an error: most sign-ups have none.
  v_sub := app.create_pending_signup(
    'd1a00000-0000-4000-9000-000000000002', 'promo.badcode@billing.invalid',
    'No Code', 'No Code Boerdery', 'complete', 'monthly', 4, '   ');
  select * into s from public.billing_subscriptions where id = v_sub;
  if s.discount_percent_bps is not null or s.discount_fixed_cents is not null then
    raise exception 'DISCOUNT FAIL [h]: a blank code produced a discount';
  end if;
end $$;

-- ── (i) The check the sign-up route runs before it creates anything ─────────
do $$
declare v jsonb;
begin
  -- Read-only: it must NOT spend a place on the offer, or a bot trying codes would empty
  -- the Founding Farmer offer without a single account being created.
  v := app.billing_check_promo_code('signup25');
  if (v->>'ok')::boolean is not true then
    raise exception 'DISCOUNT FAIL [i]: a live code checked as % ', v;
  end if;
  if (select used_count from public.billing_promo_codes where code = 'SIGNUP25') <> 1 then
    raise exception 'DISCOUNT FAIL [i]: checking a code spent a place on the offer';
  end if;

  v := app.billing_check_promo_code('NOSUCHCODE');
  if v->>'error' <> 'unknown' then
    raise exception 'DISCOUNT FAIL [i]: an unknown code checked as % ', v;
  end if;
  v := app.billing_check_promo_code('');
  if v->>'error' <> 'missing' then
    raise exception 'DISCOUNT FAIL [i]: a blank code checked as % ', v;
  end if;

  -- Switched off and never existed answer the same, so trying codes teaches nothing.
  update public.billing_promo_codes set active = false where code = 'SIGNUP25';
  v := app.billing_check_promo_code('SIGNUP25');
  if v->>'error' <> 'unknown' then
    raise exception 'DISCOUNT FAIL [i]: a switched-off code answered % ', v;
  end if;
  update public.billing_promo_codes set active = true where code = 'SIGNUP25';

  if has_function_privilege('authenticated', 'public.billing_check_promo_code(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.billing_check_promo_code(text)', 'EXECUTE') then
    raise exception 'DISCOUNT FAIL [i]: a browser session may probe promo codes';
  end if;
end $$;

-- ── (j) The seven-argument sign-up is GONE, not left beside the new one ─────
--
-- PostgREST resolves overloads by argument name. Two arities of this would make every
-- existing call ambiguous, so 20260920160000 drops the old pair rather than adding to it.
do $$
declare n integer;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'billing_create_pending_signup';
  if n <> 1 then
    raise exception 'DISCOUNT FAIL [j]: % versions of billing_create_pending_signup exist', n;
  end if;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname = 'create_pending_signup';
  if n <> 1 then
    raise exception 'DISCOUNT FAIL [j]: % versions of app.create_pending_signup exist', n;
  end if;
end $$;

rollback;
