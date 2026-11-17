-- 20261118120100_storage_blocks_billing.sql
-- Paid 10 GB storage blocks on the bill (BRIEF section 11; decisions 15, 34 and 36; scenarios 12
-- and 26), and the old cost-plus storage meter retired.
--
-- == Buying and giving back blocks: A2's quotes ==============================================
-- A block bought by hand is a stored quote like any other mid-period change (20261115110000):
-- change 'storage', priced for the days left in the current storage month (R49 a block a month,
-- billing_settings), accepted with the amounts shown, and raised ONLY when its change invoice is
-- paid (the same payment trigger, credit spent first, under R1 not charged, voided at expiry).
-- Fewer blocks take effect at the start of the next storage month (pending_storage_blocks) and
-- are refused while what is stored would not fit in the smaller allowance: nothing is deleted
-- to make a reduction fit (decision 34). Buying more cancels a scheduled reduction. Paid extras
-- are refused in the grace (app.farm_paid_extras_allowed).
--
-- == The monthly charge ======================================================================
-- Storage is charged monthly whatever the software term (BRIEF section 11: no invented annual
-- storage discount). The storage month is the billing period for a monthly subscription and a
-- month stepped from the period start for an annual one (app.storage_month). Each month's block
-- charge is one storage_charges row per subscription and month (unique), so a retried run cannot
-- bill it twice, and each row is stamped onto exactly one invoice:
--   * a monthly subscription: on its period invoice, for the period it opens;
--   * an annual subscription: the first month on the annual period invoice, every later month on
--     the usage invoice (kind ai_usage, now "usage": AI, voice, WhatsApp and storage) raised the
--     day the month starts. Storage never waits for the R50 AI-only minimum.
-- An automatic block's pro-rata part (20261118120000) rides on whichever of those comes next.
--
-- == What is retired =========================================================================
-- usage_for_month priced "what each business stores now" at Rapid Rise's cost per GB plus the
-- markup, with no allowance and no blocks, and /admin/usage could raise that as an invoice: the
-- reviewed mismatch (BRIEF section 11). It now reports the measured storage of the month (from
-- storage_usage_snapshots) for Rapid Rise's own cost view and the app no longer raises storage or
-- message invoices from it. There are no transfer (download) charges at all (decision 36).
--
-- == Usage invoices, once per customer per day ==============================================
-- A usage invoice is raised for the billing site, carrying the AI, voice and WhatsApp use of
-- every site billed through it (until now a pooled site's use waited on the ledger forever,
-- since only the billing site has a subscription). One per customer per South African day, now
-- also a unique index; every ledger row and storage charge is stamped once.
--
-- == Safe on live data =======================================================================
-- Two invoice columns with zero defaults, two quote columns, a widened check, an index that only
-- forbids what the generator already never does, and replaced functions with the same
-- signatures. No subscription holds a block yet, so no invoice changes amount.

-- == The invoice ============================================================================
alter table public.billing_invoices add column if not exists storage_incl_cents bigint not null default 0;
alter table public.billing_invoices add column if not exists storage_blocks integer not null default 0;
alter table public.billing_invoices drop constraint if exists billing_invoices_storage_ck;
alter table public.billing_invoices add constraint billing_invoices_storage_ck
  check (storage_incl_cents >= 0 and storage_blocks >= 0);
comment on column public.billing_invoices.storage_incl_cents is
  'Storage block charges on this invoice (20261118120100): the month''s blocks and any automatic '
  'block''s pro-rata part, the sum of its storage_charges rows. Never discounted.';

alter table public.billing_change_quotes drop constraint if exists billing_change_quotes_change_check;
alter table public.billing_change_quotes add constraint billing_change_quotes_change_check
  check (change in ('capacity', 'plan', 'storage'));
alter table public.billing_change_quotes add column if not exists from_storage_blocks integer;
alter table public.billing_change_quotes add column if not exists to_storage_blocks integer;
alter table public.billing_change_quotes drop constraint if exists billing_change_quotes_storage_ck;
alter table public.billing_change_quotes add constraint billing_change_quotes_storage_ck check (
  change <> 'storage'
  or (from_storage_blocks between 0 and 1000 and to_storage_blocks between 0 and 1000
      and from_storage_blocks <> to_storage_blocks));

-- One usage invoice per customer per South African day (the generator already checks it).
create unique index if not exists billing_invoices_usage_day_uq
  on public.billing_invoices (farm_id, issued_on)
  where deleted_at is null and status <> 'void' and kind = 'ai_usage';

create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged
             + coalesce(new.equipment_unit_incl_cents, 0) * coalesce(new.equipment_count, 0);

  -- A service invoice (20261029110000) and a change invoice (20261115110000) are the sum of
  -- their lines. A change was priced and accepted as one amount: no discount, no AI use.
  if new.kind in ('service', 'change') then
    new.discount_cents := 0;
    new.ai_usage_ex_vat_cents := 0;
    new.ai_usage_incl_cents := 0;
    new.storage_incl_cents := 0;
    new.total_incl_cents := coalesce(
      (select sum(l.line_total_incl_cents) from public.billing_invoice_lines l where l.invoice_id = new.id), 0);
    new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
    new.vat_cents := new.total_incl_cents - new.subtotal_ex_vat_cents;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' or new.status = 'draft' then
    v_discount := coalesce(
      app.billing_discount_cents(new.subscription_id, v_gross, new.period_start), 0);
    new.discount_cents := least(v_discount, v_gross);
    if new.discount_cents > 0 and new.discount_label is null then
      new.discount_label := (
        select coalesce(s.discount_label, s.discount_code)
          from public.billing_subscriptions s where s.id = new.subscription_id);
    end if;
  else
    new.discount_cents := least(coalesce(new.discount_cents, 0), v_gross);
  end if;

  new.ai_usage_ex_vat_cents := coalesce(new.ai_usage_ex_vat_cents, 0);
  new.ai_usage_incl_cents   := new.ai_usage_ex_vat_cents
    + round(new.ai_usage_ex_vat_cents::numeric * coalesce(new.vat_rate_bps, 0) / 10000)::bigint;
  -- Storage blocks (20261118120100): a price including VAT like the plan's, never discounted.
  new.storage_incl_cents    := coalesce(new.storage_incl_cents, 0);

  new.total_incl_cents      := v_gross - new.discount_cents + new.ai_usage_incl_cents + new.storage_incl_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;


-- 20261114090300's freeze, plus the storage columns (20261118120100).
create or replace function app.billing_freeze_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'BILLING: invoice % has been issued and cannot be deleted (void it instead)',
        old.invoice_ref using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'draft' then
    return new;
  end if;

  if new.invoice_ref       is distinct from old.invoice_ref
     or new.farm_id        is distinct from old.farm_id
     or new.period_start   is distinct from old.period_start
     or new.period_end     is distinct from old.period_end
     or new.plan           is distinct from old.plan
     or new.billing_period is distinct from old.billing_period
     or new.asset_count    is distinct from old.asset_count
     or new.unit_price_incl_cents is distinct from old.unit_price_incl_cents
     or new.months_charged is distinct from old.months_charged
     or new.price_version_id      is distinct from old.price_version_id
     or new.price_version_label   is distinct from old.price_version_label
     or new.vat_rate_bps          is distinct from old.vat_rate_bps
     or new.seller_vat_number     is distinct from old.seller_vat_number
     or new.subtotal_ex_vat_cents is distinct from old.subtotal_ex_vat_cents
     or new.vat_cents             is distinct from old.vat_cents
     or new.total_incl_cents      is distinct from old.total_incl_cents
     or new.currency              is distinct from old.currency
     or new.ai_usage_ex_vat_cents is distinct from old.ai_usage_ex_vat_cents
     or new.ai_usage_incl_cents   is distinct from old.ai_usage_incl_cents
     or new.ai_usage_from         is distinct from old.ai_usage_from
     or new.ai_usage_to           is distinct from old.ai_usage_to
     or new.ai_usage_people       is distinct from old.ai_usage_people
     -- Support equipment on the invoice (20261114090300).
     or new.equipment_active          is distinct from old.equipment_active
     or new.equipment_included        is distinct from old.equipment_included
     or new.equipment_count           is distinct from old.equipment_count
     or new.equipment_unit_incl_cents is distinct from old.equipment_unit_incl_cents
     -- Storage blocks on the invoice (20261118120100).
     or new.storage_incl_cents        is distinct from old.storage_incl_cents
     or new.storage_blocks            is distinct from old.storage_blocks
     or new.seller_snapshot       is distinct from old.seller_snapshot
     or new.bill_to_snapshot      is distinct from old.bill_to_snapshot then
    raise exception
      'BILLING: invoice % is issued; its pricing snapshot is immutable (status/payment/void may still change)',
      old.invoice_ref using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.billing_freeze_invoice() from public, anon, authenticated;

-- == One customer's sites ====================================================================
-- The billing site and every site billed through it: the storage pool, the usage invoice and
-- (20261118120200) the assistance budget all use this one answer.
create or replace function app.customer_site_ids(p_farm uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select app.storage_pool_farm_ids(p_farm);
$$;
revoke all on function app.customer_site_ids(uuid) from public, anon, authenticated, service_role;

-- == Pricing a change of blocks ==============================================================
-- What buying or giving back blocks would do and cost today. Reads only. kind: now | renewal |
-- no_change | unavailable (with a reason slug), in the shape of app.billing_change_state.
create or replace function app.storage_change_state(p_sub uuid, p_blocks integer, p_today date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s          public.billing_subscriptions%rowtype;
  v_today    date := coalesce(p_today, app.billing_today());
  v_exempt   boolean;
  v_price    bigint;
  v_start    date;
  v_end      date;
  v_total    integer;
  v_rem      integer;
  v_kind     text;
  v_reason   text;
  v_charge   bigint := 0;
  v_balance  bigint := 0;
  v_payable  bigint;
  v_waived   bigint := 0;
  v_effective date;
  v_allow    jsonb;
  v_used     bigint;
  v_room     bigint;
  v_next     integer;
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    return jsonb_build_object('kind', 'unavailable', 'reason', 'billing-no-subscription');
  end if;
  select coalesce(f.billing_exempt, false) into v_exempt from public.farms f where f.id = s.farm_id;
  select storage_block_monthly_incl_cents into v_price from public.billing_settings where singleton limit 1;
  v_price := coalesce(v_price, 4900);
  select m.month_start, m.month_end into v_start, v_end from app.storage_month(s.id, v_today) m;
  v_total := (v_end - v_start) + 1;
  -- Inclusive of today, as for every other addition.
  v_rem := greatest(least((v_end - v_today) + 1, v_total), 0);
  v_effective := v_end + 1;

  if s.status = 'cancelled' or s.ended_on is not null then
    v_reason := 'billing-subscription-ended';
  elsif s.status = 'pending' then
    v_reason := 'billing-change-pending';
  elsif s.status = 'suspended' then
    v_reason := 'billing-change-paused';
  elsif p_blocks is null or p_blocks < 0 or p_blocks > 1000 then
    v_reason := 'billing-quantity-invalid';
  elsif p_blocks = s.storage_blocks then
    v_kind := 'no_change';
  elsif p_blocks > s.storage_blocks then
    v_kind := 'now';
    v_effective := v_today;
    v_charge := (p_blocks - s.storage_blocks)::bigint * app.billing_prorate_cents(v_price, v_rem, v_total);
  else
    -- Fewer blocks, from the next storage month, and never below what is stored: nothing is
    -- deleted to make a reduction fit (decision 34).
    v_allow := app.storage_allowance(s.farm_id);
    v_used := app.storage_pool_usage(app.customer_site_ids(s.farm_id), null);
    v_room := coalesce((v_allow ->> 'override_bytes')::bigint,
                       (v_allow #>> '{next,included_bytes}')::bigint + p_blocks::bigint * app.storage_block_bytes());
    if v_used > v_room then
      v_reason := 'storage-reduction-over-usage';
    else
      v_kind := 'renewal';
    end if;
  end if;
  if v_reason is not null then
    v_kind := 'unavailable';
  end if;

  -- Nothing new that costs money in the grace (decision 41).
  if v_kind = 'now' and v_charge > 0 and not app.farm_paid_extras_allowed(s.farm_id, v_today) then
    v_kind := 'unavailable';
    v_reason := 'billing-grace-no-extras';
  end if;
  if v_exempt then
    v_charge := 0;
  end if;
  v_balance := app.billing_credit_balance(p_sub);
  if v_kind = 'now' and v_charge > 0 then
    v_payable := v_charge - least(v_charge, greatest(v_balance, 0));
    if v_payable > 0 and v_payable < 100 then
      v_waived := v_payable;
      v_charge := v_charge - v_payable;
    end if;
  end if;
  v_next := case when v_kind in ('now', 'renewal') then p_blocks else coalesce(s.pending_storage_blocks, s.storage_blocks) end;

  return jsonb_build_object(
    'kind', v_kind,
    'reason', v_reason,
    'change', 'storage',
    'subscription_id', s.id,
    'farm_id', s.farm_id,
    'status', s.status,
    'exempt', v_exempt,
    'today', v_today,
    'effective_on', v_effective,
    'from', jsonb_build_object('blocks', s.storage_blocks, 'plan', s.plan, 'period', s.billing_period),
    'to', jsonb_build_object('blocks', p_blocks),
    'block_bytes', app.storage_block_bytes(),
    'block_monthly_cents', v_price,
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'renewal_on', v_end + 1,
                                 'days_remaining', v_rem, 'days_in_period', v_total),
    'pending', jsonb_build_object('blocks', s.pending_storage_blocks, 'blocks_on', s.pending_storage_blocks_on),
    'money', jsonb_build_object(
      'charge_now_cents', v_charge,
      'credit_now_cents', 0,
      'waived_cents', v_waived,
      'unit_block_cents', app.billing_prorate_cents(v_price, v_rem, v_total),
      'credit_balance_cents', v_balance,
      'pay_now_cents', greatest(v_charge - least(v_charge, greatest(v_balance, 0)), 0),
      'current_renewal_cents', coalesce(s.pending_storage_blocks, s.storage_blocks)::bigint * v_price,
      'next_renewal_cents', v_next::bigint * v_price));
end $$;
revoke all on function app.storage_change_state(uuid, integer, date) from public, anon, authenticated, service_role;

-- Prices a change of blocks and keeps it for the owner to accept, superseding any unaccepted
-- quote (one live price per subscription, as app.billing_quote_change).
create or replace function app.billing_quote_storage(p_sub uuid, p_blocks integer, p_by uuid, p_today date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s         public.billing_subscriptions%rowtype;
  v         jsonb;
  v_today   date := coalesce(p_today, app.billing_today());
  v_id      uuid;
  v_expires timestamptz;
  v_price   uuid;
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    raise exception 'billing-no-subscription' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(s.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v := app.storage_change_state(p_sub, p_blocks, v_today);
  if v ->> 'kind' not in ('now', 'renewal') then
    return v;
  end if;

  update public.billing_change_quotes
     set status = 'superseded', closed_at = now(), close_reason = 'a newer quote', updated_at = now()
   where subscription_id = p_sub and status = 'quoted';

  v_expires := least(now() + interval '30 minutes', app.billing_day_ends_at(v_today));
  v_price := (app.billing_price_for_subscription(s.id)).id;
  insert into public.billing_change_quotes (
    farm_id, subscription_id, change, mode, status,
    from_plan, from_period, from_price_version_id, from_full, from_equipment_extra,
    full_in_use, equipment_in_use, period_start, period_end,
    to_plan, to_period, to_price_version_id, to_full, to_equipment_extra,
    from_storage_blocks, to_storage_blocks,
    days_remaining, days_in_period, charge_now_cents, credit_now_cents,
    current_renewal_cents, next_renewal_cents, effective_on, priced_on, expires_at,
    detail, created_by
  ) values (
    s.farm_id, s.id, 'storage', v ->> 'kind', 'quoted',
    s.plan, s.billing_period, v_price, s.asset_quota, s.equipment_extra_quota,
    app.billable_asset_count(s.farm_id), app.billable_equipment_count(s.farm_id),
    (v #>> '{period,start}')::date, (v #>> '{period,end}')::date,
    s.plan, s.billing_period, v_price, s.asset_quota, s.equipment_extra_quota,
    s.storage_blocks, p_blocks,
    (v #>> '{period,days_remaining}')::integer, (v #>> '{period,days_in_period}')::integer,
    (v #>> '{money,charge_now_cents}')::bigint, 0,
    (v #>> '{money,current_renewal_cents}')::bigint, (v #>> '{money,next_renewal_cents}')::bigint,
    (v ->> 'effective_on')::date, v_today, v_expires,
    v || jsonb_build_object('input', jsonb_build_object('storage_blocks', p_blocks)),
    p_by
  ) returning id into v_id;
  return v || jsonb_build_object('quote_id', v_id, 'expires_at', v_expires);
end $$;
revoke all on function app.billing_quote_storage(uuid, integer, uuid, date) from public, anon, authenticated, service_role;

-- The service-role surface (the actor is passed and checked again inside, as for A2's quotes).
create or replace function public.storage_change_preview(p_sub uuid, p_blocks integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select app.storage_change_state(p_sub, p_blocks, app.billing_today());
$$;
revoke all on function public.storage_change_preview(uuid, integer) from public, anon, authenticated;
grant execute on function public.storage_change_preview(uuid, integer) to service_role;

create or replace function public.billing_quote_storage(p_sub uuid, p_blocks integer, p_by uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app.billing_quote_storage(p_sub, p_blocks, p_by, null);
$$;
revoke all on function public.billing_quote_storage(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.billing_quote_storage(uuid, integer, uuid) to service_role;

-- == The month's blocks on an invoice ========================================================
-- On a draft invoice: a reduction scheduled for this storage month lands first, then the month's
-- block charge is written (once per subscription and month), then every storage charge not yet
-- invoiced is stamped onto this invoice, a line each, and the header carries their sum.
create or replace function app.billing_attach_storage(p_invoice uuid, p_month_start date, p_month_end date)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  inv     public.billing_invoices%rowtype;
  s       public.billing_subscriptions%rowtype;
  v_price bigint;
  v_days  integer;
  v_total bigint;
begin
  select * into inv from public.billing_invoices where id = p_invoice for update;
  if not found or inv.status <> 'draft' then
    raise exception 'BILLING: storage can only be added to an invoice that is still a draft'
      using errcode = 'check_violation';
  end if;
  if inv.subscription_id is null then
    return 0;
  end if;
  select * into s from public.billing_subscriptions where id = inv.subscription_id for update;

  if p_month_start is not null and s.pending_storage_blocks is not null
     and s.pending_storage_blocks_on <= p_month_start then
    update public.billing_subscriptions
       set storage_blocks = pending_storage_blocks, pending_storage_blocks = null,
           pending_storage_blocks_on = null, updated_at = now()
     where id = s.id
     returning * into s;
    update public.billing_change_quotes
       set status = 'applied', applied_at = now(), updated_at = now()
     where subscription_id = s.id and status = 'scheduled' and change = 'storage';
  end if;

  if s.storage_blocks > 0 and p_month_start is not null and p_month_end >= p_month_start then
    select storage_block_monthly_incl_cents into v_price from public.billing_settings where singleton limit 1;
    v_price := coalesce(v_price, 4900);
    v_days := (p_month_end - p_month_start) + 1;
    insert into public.storage_charges (farm_id, subscription_id, kind, blocks, unit_incl_cents,
                                        period_start, period_end, days_charged, days_in_period,
                                        amount_incl_cents, note)
    values (s.farm_id, s.id, 'monthly', s.storage_blocks, v_price, p_month_start, p_month_end,
            v_days, v_days, s.storage_blocks::bigint * v_price, 'storage blocks for the month')
    on conflict (subscription_id, period_start) where kind = 'monthly' do nothing;
  end if;

  update public.storage_charges set invoice_id = p_invoice
   where subscription_id = s.id and invoice_id is null;
  select coalesce(sum(c.amount_incl_cents), 0) into v_total
    from public.storage_charges c where c.invoice_id = p_invoice;
  if v_total <= 0 and not exists (select 1 from public.storage_charges c where c.invoice_id = p_invoice) then
    return 0;
  end if;

  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select inv.id, inv.farm_id, 5,
         left(case c.kind
           when 'monthly' then 'FLEETWISE storage, ' || c.blocks::text || ' x 10 GB block(s), '
                               || to_char(c.period_start, 'DD Mon') || ' to ' || to_char(c.period_end, 'DD Mon YYYY')
           else 'FLEETWISE storage block(s) added automatically, ' || c.blocks::text || ' x 10 GB, '
                || c.days_charged::text || ' of ' || c.days_in_period::text || ' days from '
                || to_char(c.period_start, 'DD Mon YYYY') end, 200),
         c.blocks, 1, c.unit_incl_cents, c.amount_incl_cents,
         app.ex_vat_cents(c.amount_incl_cents, inv.vat_rate_bps),
         c.amount_incl_cents - app.ex_vat_cents(c.amount_incl_cents, inv.vat_rate_bps)
    from public.storage_charges c
   where c.invoice_id = p_invoice
   order by c.period_start, c.created_at;

  update public.billing_invoices
     set storage_incl_cents = v_total, storage_blocks = s.storage_blocks
   where id = p_invoice;
  return v_total;
end $$;
revoke all on function app.billing_attach_storage(uuid, date, date) from public, anon, authenticated, service_role;

-- == The old meter, for Rapid Rise's own cost view only ======================================
-- Messages sent in the month (counted as before) and what each site stored that month, from the
-- nightly measure (its latest day in the month), never "what it stores now" for a past month.
create or replace function public.usage_for_month(p_month date)
returns table (farm_id uuid, whatsapp_sent bigint, storage_bytes bigint)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_from timestamptz := date_trunc('month', p_month::timestamp) at time zone 'Africa/Johannesburg';
  v_to   timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Africa/Johannesburg';
  v_d0   date := date_trunc('month', p_month::timestamp)::date;
  v_d1   date := (date_trunc('month', p_month::timestamp) + interval '1 month')::date;
begin
  return query
  with sent as (
    select n.farm_id, count(*)::bigint c
      from public.whatsapp_notification_delivery d
      join public.notifications n on n.id = d.notification_id
     where d.state = 'sent' and d.created_at >= v_from and d.created_at < v_to and n.farm_id is not null
     group by n.farm_id
  ),
  stored as (
    select distinct on (s.farm_id) s.farm_id, (s.tracked_bytes + s.untracked_bytes)::bigint as b
      from public.storage_usage_snapshots s
     where s.measured_on >= v_d0 and s.measured_on < v_d1
     order by s.farm_id, s.measured_on desc
  )
  select f.id, coalesce(sent.c, 0), coalesce(stored.b, 0)
    from public.farms f
    left join sent on sent.farm_id = f.id
    left join stored on stored.farm_id = f.id
   where f.deleted_at is null
     and (sent.c is not null or stored.b is not null);
end $$;
revoke all on function public.usage_for_month(date) from public, anon, authenticated;
grant execute on function public.usage_for_month(date) to service_role;
comment on table public.usage_rates is
  'What Rapid Rise pays for a WhatsApp message and a GB stored a month, and its markup: Rapid '
  'Rise''s own cost view (20261107150000). Since 20261118120100 nothing is charged from it: '
  'storage is the pooled allowance and R49 blocks, and paid WhatsApp is on the usage ledger.';


-- == A2's change functions, with storage =====================================================
-- 20261115110000's bodies; the storage branches are the only change.
create or replace function app.billing_apply_change(p_quote uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.billing_change_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
  v_label text;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then return 'closed'; end if;
  if q.status = 'applied' then return 'applied'; end if;
  if q.status not in ('quoted', 'awaiting_payment') or q.accepted_at is null or q.mode <> 'now' then
    return 'closed';
  end if;

  -- Storage blocks (20261118120100): priced on the blocks held and the storage month, so those
  -- are its basis. More blocks overtake a reduction that was waiting.
  if q.change = 'storage' then
    select * into s from public.billing_subscriptions where id = q.subscription_id for update;
    if not found or s.deleted_at is not null or s.ended_on is not null
       or s.status in ('cancelled', 'pending', 'suspended')
       or s.storage_blocks is distinct from q.from_storage_blocks
       or (select m.month_start from app.storage_month(s.id, app.billing_today()) m) is distinct from q.period_start then
      return 'stale';
    end if;
    update public.billing_subscriptions
       set storage_blocks = q.to_storage_blocks,
           pending_storage_blocks = null, pending_storage_blocks_on = null,
           updated_at = now()
     where id = s.id;
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'more storage was bought', updated_at = now()
     where subscription_id = s.id and status = 'scheduled' and change = 'storage';
    update public.billing_change_quotes
       set status = 'applied', applied_at = now(), updated_at = now()
     where id = q.id;
    return 'applied';
  end if;

  select * into s from public.billing_subscriptions where id = q.subscription_id for update;
  if not found or s.deleted_at is not null or s.ended_on is not null
     or s.status in ('cancelled', 'pending', 'suspended')
     or s.plan <> q.from_plan or s.billing_period <> q.from_period
     or s.asset_quota is distinct from q.from_full
     or s.equipment_extra_quota <> q.from_equipment_extra
     or s.current_period_end is distinct from q.period_end
     or (app.billing_price_for_subscription(s.id)).id is distinct from q.from_price_version_id then
    return 'stale';
  end if;

  if q.change = 'capacity' then
    update public.billing_subscriptions
       set asset_quota = q.to_full,
           equipment_extra_quota = q.to_equipment_extra,
           -- More than the number you asked to give back is unambiguous about which you meant.
           pending_quota = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota end,
           pending_quota_on = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota_on end,
           pending_quota_set_at = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota_set_at end,
           updated_at = now()
     where id = s.id;
    if q.to_full > coalesce(s.asset_quota, 0) then
      update public.billing_change_quotes
         set status = 'superseded', closed_at = now(), close_reason = 'more spaces were bought', updated_at = now()
       where subscription_id = s.id and status = 'scheduled' and change = 'capacity';
    end if;
  else
    select version_label into v_label from public.billing_price_versions where id = q.to_price_version_id;
    update public.billing_subscriptions
       set plan = q.to_plan,
           billing_period = q.to_period,
           price_version_id = q.to_price_version_id,
           price_version_label = coalesce(v_label, price_version_label),
           equipment_extra_quota = q.to_equipment_extra,
           -- An upgrade cancels a downgrade that was waiting.
           pending_plan = null, pending_billing_period = null, pending_plan_on = null, pending_plan_set_at = null,
           updated_at = now()
     where id = s.id;
    -- The effective plan, with the non-payment exception the old path kept.
    if s.plan_before_downgrade is not null then
      update public.billing_subscriptions set plan_before_downgrade = q.to_plan where id = s.id;
    else
      update public.farms set plan = q.to_plan where id = s.farm_id;
      -- One plan across a customer's sites (decision 22).
      update public.farms set plan = q.to_plan where billed_through = s.farm_id and deleted_at is null;
    end if;
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'a higher plan was taken', updated_at = now()
     where subscription_id = s.id and status = 'scheduled' and change = 'plan';
  end if;

  update public.billing_change_quotes
     set status = 'applied', applied_at = now(), updated_at = now()
   where id = q.id;
  return 'applied';
end $$;
revoke all on function app.billing_apply_change(uuid) from public, anon, authenticated, service_role;
create or replace function app.billing_raise_change_invoice(p_quote uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q          public.billing_change_quotes%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm     public.farms%rowtype;
  v_price    public.billing_price_versions%rowtype;
  v_invoice  uuid;
  v_desc     text;
  v_today    date := app.billing_today();
begin
  select * into q from public.billing_change_quotes where id = p_quote;
  select * into v_settings from public.billing_settings where singleton;
  select * into v_farm from public.farms where id = q.farm_id;
  select * into v_price from public.billing_price_versions where id = coalesce(q.to_price_version_id, q.from_price_version_id);

  v_desc := case
    when q.change = 'capacity' then
      'FLEETWISE '
      || case when q.to_full > coalesce(q.from_full, 0) then (q.to_full - coalesce(q.from_full, 0))::text || ' more full space(s)' else '' end
      || case when q.to_full > coalesce(q.from_full, 0) and q.to_equipment_extra > q.from_equipment_extra then ' and ' else '' end
      || case when q.to_equipment_extra > q.from_equipment_extra
              then (q.to_equipment_extra - q.from_equipment_extra)::text || ' more equipment space(s)' else '' end
    when q.change = 'storage' then
      'FLEETWISE ' || (q.to_storage_blocks - q.from_storage_blocks)::text || ' more 10 GB storage block(s)'
    else
      'FLEETWISE ' || q.from_plan::text || ' to ' || q.to_plan::text
      || ', ' || coalesce(q.from_full, q.full_in_use)::text || ' full space(s)'
    end
    || ', ' || q.days_remaining::text || ' of ' || q.days_in_period::text || ' days to '
    || to_char(coalesce(q.period_end, v_today), 'DD Mon YYYY');

  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
    equipment_active, equipment_included, equipment_count, equipment_unit_incl_cents,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    q.farm_id, q.subscription_id, app.next_billing_invoice_ref(), 'draft', 'change',
    v_today, greatest(coalesce(q.period_end, v_today), v_today), v_today, v_today,
    q.to_plan, q.to_period,
    greatest(coalesce(q.to_full, 0) - coalesce(q.from_full, 0), 0), 0, 1,
    q.equipment_in_use, coalesce((q.detail #>> '{to,equipment_included}')::integer, 0),
    greatest(q.to_equipment_extra - q.from_equipment_extra, 0), 0,
    v_price.id, coalesce(v_price.version_label, 'Change'), coalesce(v_price.vat_rate_bps, 0),
    v_settings.vat_number,
    jsonb_build_object(
      'legal_name', v_settings.legal_name, 'trading_name', v_settings.trading_name,
      'reg_number', v_settings.reg_number, 'vat_registered', v_settings.vat_registered,
      'billing_address', v_settings.billing_address, 'billing_email', v_settings.billing_email),
    jsonb_build_object(
      'name', v_farm.name, 'trading_name', v_farm.trading_name, 'reg_number', v_farm.reg_number,
      'vat_number', v_farm.vat_number, 'billing_address', v_farm.billing_address,
      'billing_email', v_farm.billing_email)
  ) returning id into v_invoice;

  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select v_invoice, q.farm_id, 0, left(v_desc, 200), 1, 1, q.charge_now_cents, q.charge_now_cents,
         app.ex_vat_cents(q.charge_now_cents, inv.vat_rate_bps),
         q.charge_now_cents - app.ex_vat_cents(q.charge_now_cents, inv.vat_rate_bps)
    from public.billing_invoices inv where inv.id = v_invoice;

  update public.billing_invoices set status = 'open' where id = v_invoice;
  return v_invoice;
end $$;
revoke all on function app.billing_raise_change_invoice(uuid) from public, anon, authenticated, service_role;
create or replace function app.billing_accept_quote(
  p_quote uuid, p_by uuid, p_charge_cents bigint, p_credit_cents bigint, p_next_renewal_cents bigint,
  p_today date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q         public.billing_change_quotes%rowtype;
  s         public.billing_subscriptions%rowtype;
  v         jsonb;
  v_in      jsonb;
  v_today   date := coalesce(p_today, app.billing_today());
  v_invoice uuid;
  v_result  text;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then
    raise exception 'quote-not-found' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(q.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The same lock every capacity add takes, before anything is counted.
  select * into s from public.billing_subscriptions where id = q.subscription_id for update;

  if q.status in ('awaiting_payment', 'scheduled', 'applied', 'credited') and q.accepted_by is not distinct from p_by then
    return jsonb_build_object(
      'applied', case q.status when 'scheduled' then 'scheduled' when 'awaiting_payment' then 'awaiting_payment' else 'now' end,
      'quote_id', q.id, 'invoice_id', q.invoice_id, 'effective_on', q.effective_on,
      'charge_cents', q.charge_now_cents, 'credit_cents', q.credit_now_cents, 'repeat', true);
  end if;
  if q.status <> 'quoted' then
    raise exception 'quote-not-open' using errcode = '22023';
  end if;
  if now() >= q.expires_at then
    raise exception 'quote-expired' using errcode = '22023',
      hint = 'Prices are for today and last 30 minutes; ask for a new price.';
  end if;
  if p_charge_cents is distinct from q.charge_now_cents
     or p_credit_cents is distinct from q.credit_now_cents
     or p_next_renewal_cents is distinct from q.next_renewal_cents then
    raise exception 'quote-changed' using errcode = '22023',
      hint = 'The amounts accepted are not the ones this quote states.';
  end if;

  v_in := q.detail -> 'input';
  if q.change = 'storage' then
    -- Storage blocks (20261118120100): priced again on the blocks held and the storage month.
    v := app.storage_change_state(q.subscription_id, nullif(v_in ->> 'storage_blocks', '')::integer, v_today);
    if v ->> 'kind' is distinct from q.mode
       or (v #>> '{money,charge_now_cents}')::bigint is distinct from q.charge_now_cents
       or nullif(v #>> '{money,next_renewal_cents}', '')::bigint is distinct from q.next_renewal_cents
       or s.storage_blocks is distinct from q.from_storage_blocks
       or (v #>> '{period,start}')::date is distinct from q.period_start then
      raise exception 'quote-changed' using errcode = '22023',
        hint = coalesce(v ->> 'reason', 'The blocks or the storage month changed since this price; ask for a new one.');
    end if;
  else
    v := app.billing_change_state(q.subscription_id,
           nullif(v_in ->> 'plan', '')::public.farm_plan, nullif(v_in ->> 'period', '')::public.billing_period,
           nullif(v_in ->> 'full', '')::integer, nullif(v_in ->> 'equipment_extra', '')::integer,
           coalesce((v_in ->> 'current_list')::boolean, false), v_today);
    if v ->> 'kind' is distinct from q.mode
       or (v #>> '{money,charge_now_cents}')::bigint is distinct from q.charge_now_cents
       or (v #>> '{money,credit_now_cents}')::bigint is distinct from q.credit_now_cents
       or nullif(v #>> '{money,next_renewal_cents}', '')::bigint is distinct from q.next_renewal_cents
       or s.asset_quota is distinct from q.from_full
       or s.equipment_extra_quota <> q.from_equipment_extra
       or s.plan <> q.from_plan or s.billing_period <> q.from_period
       or s.current_period_end is distinct from q.period_end then
      raise exception 'quote-changed' using errcode = '22023',
        hint = coalesce(v ->> 'reason', 'The quantities or the period changed since this price; ask for a new one.');
    end if;
  end if;
  if q.mode = 'now' and exists (select 1 from public.billing_change_quotes o
                                  where o.subscription_id = q.subscription_id and o.status = 'awaiting_payment') then
    raise exception 'quote-awaiting-payment' using errcode = '22023',
      hint = 'Pay or cancel the change already waiting for its payment first.';
  end if;

  update public.billing_change_quotes
     set accepted_by = p_by, accepted_at = now(), updated_at = now(),
         acceptance = jsonb_build_object(
           'charge_cents', p_charge_cents, 'credit_cents', p_credit_cents,
           'next_renewal_cents', p_next_renewal_cents, 'on', v_today, 'at', now())
   where id = q.id;

  -- == At renewal: recorded, and nothing moves today ==
  if q.mode = 'renewal' then
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'replaced by a newer change', updated_at = now()
     where subscription_id = q.subscription_id and status = 'scheduled' and change = q.change and id <> q.id;
    if q.change = 'plan' then
      update public.billing_subscriptions
         set pending_plan = q.to_plan, pending_billing_period = q.to_period,
             pending_plan_on = q.effective_on, pending_plan_set_at = now(), updated_at = now()
       where id = q.subscription_id;
    elsif q.change = 'storage' then
      update public.billing_subscriptions
         set pending_storage_blocks = q.to_storage_blocks, pending_storage_blocks_on = q.effective_on,
             updated_at = now()
       where id = q.subscription_id;
    else
      update public.billing_subscriptions
         set pending_quota = q.to_full, pending_quota_on = q.effective_on,
             pending_quota_set_at = now(), updated_at = now()
       where id = q.subscription_id;
    end if;
    update public.billing_change_quotes set status = 'scheduled', updated_at = now() where id = q.id;
    return jsonb_build_object('applied', 'scheduled', 'quote_id', q.id, 'effective_on', q.effective_on,
                              'next_renewal_cents', q.next_renewal_cents);
  end if;

  -- == Now, with nothing to pay: made at once, any credit kept ==
  if q.charge_now_cents = 0 then
    v_result := app.billing_apply_change(q.id);
    if v_result <> 'applied' then
      raise exception 'quote-changed' using errcode = '22023';
    end if;
    if q.credit_now_cents > 0 then
      insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, quote_id, note, created_by)
      values (q.farm_id, q.subscription_id, 'granted', 'plan_change', q.credit_now_cents, q.id,
              'unused difference, ' || q.from_plan::text || ' to ' || q.to_plan::text, p_by);
    end if;
    return jsonb_build_object('applied', 'now', 'quote_id', q.id, 'charge_cents', 0,
                              'credit_cents', q.credit_now_cents);
  end if;

  -- == Now, paid first: the invoice, credit spent on it, then the payment makes the change ==
  v_invoice := app.billing_raise_change_invoice(q.id);
  update public.billing_change_quotes
     set status = 'awaiting_payment', invoice_id = v_invoice,
         payment_due_by = least(now() + interval '24 hours',
                                app.billing_day_ends_at(greatest(coalesce(q.period_end, v_today), v_today))),
         updated_at = now()
   where id = q.id;
  perform app.billing_apply_credit(v_invoice);

  select * into q from public.billing_change_quotes where id = q.id;
  return jsonb_build_object(
    'applied', case when q.status = 'applied' then 'now' else 'awaiting_payment' end,
    'quote_id', q.id, 'invoice_id', v_invoice, 'charge_cents', q.charge_now_cents,
    'outstanding_cents', (select total_incl_cents - amount_paid_cents from public.billing_invoices where id = v_invoice));
end $$;
revoke all on function app.billing_accept_quote(uuid, uuid, bigint, bigint, bigint, date)
  from public, anon, authenticated, service_role;
create or replace function app.billing_cancel_quote(p_quote uuid, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.billing_change_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then
    raise exception 'quote-not-found' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(q.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.billing_subscriptions where id = q.subscription_id for update;

  if q.status = 'awaiting_payment' then
    if exists (select 1 from public.billing_payment_attempts a
                where a.invoice_id = q.invoice_id and a.status in ('pending', 'unknown')) then
      raise exception 'billing-in-flight' using errcode = '22023',
        hint = 'A payment for this change is still being processed.';
    end if;
    perform app.billing_void_change_invoice(q.invoice_id, 'cancelled by the customer before payment');
  elsif q.status = 'scheduled' then
    if q.change = 'plan' and s.pending_plan is not distinct from q.to_plan
       and s.pending_billing_period is not distinct from q.to_period then
      update public.billing_subscriptions
         set pending_plan = null, pending_billing_period = null, pending_plan_on = null,
             pending_plan_set_at = null, updated_at = now()
       where id = s.id;
    elsif q.change = 'storage' and s.pending_storage_blocks is not distinct from q.to_storage_blocks then
      update public.billing_subscriptions
         set pending_storage_blocks = null, pending_storage_blocks_on = null, updated_at = now()
       where id = s.id;
    elsif q.change = 'capacity' and s.pending_quota is not distinct from q.to_full then
      update public.billing_subscriptions
         set pending_quota = null, pending_quota_on = null, pending_quota_set_at = null, updated_at = now()
       where id = s.id;
    end if;
  elsif q.status <> 'quoted' then
    raise exception 'quote-not-open' using errcode = '22023';
  end if;

  update public.billing_change_quotes
     set status = 'cancelled', closed_at = now(), closed_by = p_by,
         close_reason = 'cancelled by the customer', updated_at = now()
   where id = q.id;
  return jsonb_build_object('cancelled', true, 'quote_id', q.id, 'was', q.status);
end $$;
revoke all on function app.billing_cancel_quote(uuid, uuid) from public, anon, authenticated, service_role;

-- == The invoice run, with the month's storage blocks =========================================
-- 20261114090300's run; the storage call before the AI use is the only change.
create or replace function app.generate_billing_invoices(p_only uuid default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s          public.billing_subscriptions%rowtype;
  v_price    public.billing_price_versions%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm     public.farms%rowtype;
  v_count    integer;
  v_ref      text;
  v_invoice  uuid;
  v_made     integer := 0;
  v_pstart   date;
  v_pend     date;
  v_exempt   boolean;
  v_space    bigint;
  v_eq_active   integer;
  v_eq_included integer;
  v_eq_extra    integer;
begin
  select * into v_settings from public.billing_settings where singleton;

  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       -- S7. Nothing here ever looked at the FARM. A farm that had been soft-deleted, or
       -- suspended, or cancelled by Rapid Rise, went on being invoiced every month and
       -- charged against its stored card, because every condition in this query is about
       -- the SUBSCRIPTION row. Selling another month to somebody who has left is the one
       -- billing mistake a customer will certainly notice and certainly tell people about.
       --
       -- 'trial' and 'active' are the states in which a farm is a going concern. A
       -- SUSPENDED farm stops being sold anything new here but stays chargeable in
       -- app.due_billing_charges, because they still owe for the months they had.
       and exists (
         select 1 from public.farms f
          where f.id = billing_subscriptions.farm_id
            and f.deleted_at is null
            and f.status in ('trial', 'active')
            -- Exempt farms stay in this loop (20261029160000, finding money-5) and take the
            -- no-invoice path below: left out of it altogether (20261029150000) their
            -- periods froze, and the night the flag was cleared the run caught up one
            -- invoice a night for every month they had been exempt.
       )
       and (p_only is null or id = p_only)
       -- `pending` is here so a brand-new sign-up gets the invoice it is about to pay,
       -- and the clause below is what stops that becoming a monthly habit: a pending
       -- subscription is invoiced ONCE, ever. Without it, every abandoned sign-up would
       -- quietly accumulate an invoice a month for a farm nobody can even log into.
       and status in ('active', 'past_due', 'trialing', 'non_renewing', 'pending')
       -- No live UNPAID invoice (20261029140000), not "no invoice ever": a farm that paid
       -- for years, cancelled and reopened is pending with only paid invoices behind it, and
       -- was raised nothing to pay, so it could not come back at all. An abandoned sign-up
       -- still keeps its one open invoice, so it is still invoiced once.
       and (status <> 'pending' or not exists (
             select 1 from public.billing_invoices i
              where i.subscription_id = billing_subscriptions.id
                and i.deleted_at is null and i.status in ('draft', 'open')
                -- A REFUNDED invoice is open again but deliberately not owed
                -- (20261029150000), the predicate app.farm_overdue_since uses: counting it
                -- left a reopened farm pending with nothing it could pay.
                and not exists (
                  select 1 from public.billing_payments p
                   where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
                )
           ))
       -- Never renew a subscription that is ENDING (20261029150000). The nightly cron raises
       -- invoices before it closes cancellations, so on the night a period-end cancellation
       -- fell due this raised the next period and moved the end a month on, the close never
       -- matched, and seven days later the farm was suspended and its stored card charged
       -- for the month after it left. Left alone here, app.billing_close_cancellations
       -- closes it the same night.
       -- A trial that cancelled has no period yet, so its trial end is its period end
       -- (20261029160000, finding money-1): keyed on current_period_end alone, the night
       -- the trial ended raised a month, wrote a period, and the close never matched.
       and not (cancel_at_period_end and coalesce(current_period_end, trial_ends_on) is not null
                and next_billing_on > coalesce(current_period_end, trial_ends_on))
       and next_billing_on is not null
       and next_billing_on <= current_date
     order by next_billing_on
     -- Two workers must not both raise this farm's invoice. The one that loses the lock
     -- simply skips the row rather than waiting for a transaction it has no interest in.
     for update skip locked
  loop
    -- Still in the trial: nothing is owed yet.
    if s.status = 'trialing' and s.trial_ends_on is not null and s.trial_ends_on >= current_date then
      continue;
    end if;

    -- S8. Was app.billing_active_price(s.plan, s.billing_period), which resolves the
    -- CURRENTLY active version, so activating a new price silently moved every existing
    -- customer onto it at their next invoice, with no notice and no decision. Founder
    -- decision: a farm keeps the price it signed up at until somebody deliberately moves
    -- it. app.billing_price_for_subscription honours the pin and falls back to the active
    -- version when there is none, or when the pin no longer fits the plan they are on.
    -- An EXEMPT farm (20261029160000, finding money-5) moves on a period with nothing
    -- raised, so its dates keep pace while it is exempt and clearing the flag bills only
    -- from then on. Its AI use from the exempt time is waived when the flag is cleared
    -- (app.farms_billing_exempt_track).
    select f.billing_exempt into v_exempt from public.farms f where f.id = s.farm_id;
    if v_exempt then
      v_pstart := coalesce(s.current_period_end + 1, s.next_billing_on);
      v_pend   := app.billing_advance_period(v_pstart, s.billing_period, s.anchor_day) - 1;
      update public.billing_subscriptions
         set current_period_start = v_pstart,
             current_period_end   = v_pend,
             next_billing_on      = v_pend + 1,
             status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
             updated_at = now()
       where id = s.id;
      continue;
    end if;

    select * into v_price from app.billing_price_for_subscription(s.id);
    if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
      continue;   -- no confirmed price, or price-on-application: never auto-bill
    end if;

    -- THE QUOTA, or the count when there is no quota.
    --
    -- Until now this was purely metered: count the machines, bill that many. Add a bakkie
    -- in March and March's invoice is R73 bigger, and nobody ever chose anything. Under
    -- the quota model the farm BUYS a number of slots at sign-up and that is what is
    -- billed, so the amount is fixed until they change it.
    --
    -- A NULL quota keeps the old behaviour exactly, and that is not an accident: every
    -- subscription that existed before this migration has one, and repricing them all on
    -- the night it shipped would be the same class of mistake as the price rise S8 fixed.
    --
    -- THE PLAN MINIMUM (20261104200000). A price row may carry a minimum number of billed
    -- slots (five on the November 2026 list, none on the launch list), and a farm billed
    -- below it is billed the minimum. Slot changes and sign-ups already keep the quota at
    -- or above it, so this only reaches a farm billed on its counted fleet (no quota),
    -- which the admin start path creates. Older generations carry 0, so a grandfathered
    -- farm's invoice is exactly what it was.
    v_count := greatest(app.billing_billable_units(s.id), coalesce(v_price.min_billed_slots, 0));

    -- SUPPORT EQUIPMENT (20261114090300). What is in use at renewal, less the plan's
    -- included equipment; retired and sold equipment drop off here, at the renewal, never in
    -- the middle of a period. A first invoice (pending) bills what was bought at sign-up when
    -- that is more. An agreement without equipment terms has none to bill. The extra paid for
    -- the new period becomes the subscription's equipment capacity.
    v_space       := app.billing_space_period_cents(v_price);
    v_eq_active   := app.billable_equipment_count(s.farm_id);
    v_eq_included := coalesce(v_price.equipment_included, 0);
    v_eq_extra    := greatest(v_eq_active - v_eq_included, 0);
    if s.status = 'pending' then
      v_eq_extra := greatest(v_eq_extra, coalesce(s.equipment_extra_quota, 0));
    end if;
    if v_price.equipment_period_incl_cents is null then
      v_eq_extra := 0;
    end if;

    if v_count <= 0 and v_eq_extra <= 0 then
      -- Nothing to bill for. Move the date on so we do not reconsider it every night.
      update public.billing_subscriptions
         set next_billing_on = app.billing_advance_period(coalesce(next_billing_on, current_date), billing_period, anchor_day),
             updated_at = now()
       where id = s.id;
      continue;
    end if;

    -- THE FIX (see this file's header). Was:
    --   coalesce(s.current_period_start, s.next_billing_on)
    -- which recomputed the period this function had itself just written, so the second
    -- billing date produced the SAME period, lost to billing_invoices_farm_period_uq,
    -- and `continue`d without advancing next_billing_on. Every farm billed once, ever.
    v_pstart := coalesce(s.current_period_end + 1, s.next_billing_on);
    v_pend   := app.billing_advance_period(v_pstart, s.billing_period, s.anchor_day) - 1;

    select * into v_farm from public.farms where id = s.farm_id;

    v_ref := app.next_billing_invoice_ref();

    begin
      insert into public.billing_invoices (
        farm_id, subscription_id, invoice_ref, status,
        period_start, period_end, issued_on, due_on,
        plan, billing_period, asset_count,
        unit_price_incl_cents, months_charged,
        equipment_active, equipment_included, equipment_count, equipment_unit_incl_cents,
        price_version_id, price_version_label, vat_rate_bps,
        seller_vat_number, seller_snapshot, bill_to_snapshot
      ) values (
        -- DRAFT, deliberately, and not 'open'.
        --
        -- An invoice is a draft while it is being assembled, that is what the word
        -- means, and `app.billing_freeze_invoice_line` enforces it: no line may be
        -- written to an invoice that has already been issued. Creating this row as
        -- 'open' and then adding its own lines made the generator raise
        -- "invoice lines are immutable once the invoice is issued" on EVERY invoice.
        -- It is issued a few statements below, once it is complete.
        s.farm_id, s.id, v_ref, 'draft',
        v_pstart, v_pend, current_date, current_date + coalesce(v_settings.payment_terms_days, 0),
        s.plan, s.billing_period, v_count,
        v_price.per_vehicle_monthly_incl_cents, v_price.months_charged,
        v_eq_active, v_eq_included, v_eq_extra, coalesce(v_price.equipment_period_incl_cents, 0),
        v_price.id, v_price.version_label, v_price.vat_rate_bps,
        v_settings.vat_number,
        jsonb_build_object(
          'legal_name', v_settings.legal_name,
          'trading_name', v_settings.trading_name,
          'reg_number', v_settings.reg_number,
          'vat_registered', v_settings.vat_registered,
          'billing_address', v_settings.billing_address,
          'billing_email', v_settings.billing_email
        ),
        jsonb_build_object(
          'name', v_farm.name,
          'trading_name', v_farm.trading_name,
          'reg_number', v_farm.reg_number,
          'vat_number', v_farm.vat_number,
          'billing_address', v_farm.billing_address,
          'billing_email', v_farm.billing_email
        )
      )
      returning id into v_invoice;
    exception when unique_violation then
      -- Another worker got there first, or this period was already billed. Correct
      -- outcome either way: there is exactly one invoice, and it is not ours to make.
      continue;
    end;

    insert into public.billing_invoice_lines (
      invoice_id, farm_id, sort_order, description, qty, months_charged,
      unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
    )
    select
      v_invoice, s.farm_id, 0,
      'FleetWise ' || s.plan::text || ', ' || v_count::text || ' vehicle(s)'
        || case when v_count > app.billing_billable_units(s.id) then ' (plan minimum)' else '' end,
      v_count, v_price.months_charged,
      v_price.per_vehicle_monthly_incl_cents,
      i.total,
      app.ex_vat_cents(i.total, i.rate),
      i.total - app.ex_vat_cents(i.total, i.rate)
    from (
      select
        -- The explicit price for the period (equal to unit x months by the price row's check).
        (v_space * v_count)::bigint as total,
        -- Read the rate BACK off the invoice: the VAT guard may have forced it to zero,
        -- and a line that disagreed with its own invoice would be the worst of both.
        (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
    ) i;

    if v_eq_extra > 0 then
      insert into public.billing_invoice_lines (
        invoice_id, farm_id, sort_order, description, qty, months_charged,
        unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
      )
      select
        v_invoice, s.farm_id, 1,
        'FleetWise support equipment, ' || v_eq_extra::text || ' beyond the ' || v_eq_included::text || ' included',
        v_eq_extra, 1,
        v_price.equipment_period_incl_cents,
        e.total,
        app.ex_vat_cents(e.total, e.rate),
        e.total - app.ex_vat_cents(e.total, e.rate)
      from (
        select (v_price.equipment_period_incl_cents * v_eq_extra)::bigint as total,
               (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
      ) e;
    end if;

    -- STORAGE BLOCKS (20261118120100). The storage month this period opens: the whole period for a
    -- monthly subscription, its first month for an annual one (the later months go on the usage
    -- invoice). A reduction scheduled for it lands first; then the month's block charge and any
    -- automatic block not yet invoiced go on this invoice.
    perform app.billing_attach_storage(v_invoice, v_pstart,
      case when s.billing_period = 'monthly' then v_pend
           else least(app.billing_advance_period(v_pstart, 'monthly',
                        coalesce(s.anchor_day, extract(day from v_pstart)::integer)) - 1, v_pend) end);

    -- AI USE (20261010090000). Every unbilled completed month of AI and voice use rides
    -- on the period invoice, while it is still a draft. Nothing at all while invoicing is
    -- off; on a proration or a slot purchase, never (those are not raised here).
    perform app.billing_attach_ai_usage(v_invoice);

    -- ISSUE IT. The lines are written, the totals are derived, and from this moment the
    -- pricing snapshot is frozen: `app.billing_freeze_invoice` refuses any further change
    -- to what was supplied or what it cost, while still permitting payment, void and
    -- write-off. Assembling as a draft and issuing in one transaction means nobody ever
    -- sees a half-built invoice.
    update public.billing_invoices set status = 'open' where id = v_invoice;

    insert into public.billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, equipment_count, source)
    values (s.farm_id, s.id, current_date, v_count, v_eq_active, 'period_close')
    on conflict (farm_id, captured_on, source) do update set asset_count = excluded.asset_count, equipment_count = excluded.equipment_count;

    update public.billing_subscriptions
       set current_period_start = v_pstart,
           current_period_end   = v_pend,
           next_billing_on      = v_pend + 1,
           -- Record what was actually charged, rather than coalescing onto whatever was
           -- recorded first. With the pin above, the value is stable across renewals by
           -- construction; when a plan change makes the pin unusable the fallback is
           -- written here, so the row never claims a price it did not bill.
           price_version_id     = v_price.id,
           price_version_label  = v_price.version_label,
           equipment_extra_quota = v_eq_extra,
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

-- == AI, voice and WhatsApp use of every site of the customer =================================
-- 20261029160000's bodies; the customer's sites instead of the billing site alone.
create or replace function app.ai_unbilled_cents(p_farm uuid, p_before timestamptz) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(u.billed_cents), 0)
    from public.ai_usage u
   where u.farm_id = any (app.customer_site_ids(p_farm))
     and u.invoice_id is null
     and u.billed_cents > 0
     and u.credential = 'platform'
     and u.waived_at is null   -- used while exempt (20261029160000, finding money-5)
     and u.occurred_at >= app.ai_billing_from()
     and u.occurred_at < p_before
$$;
revoke execute on function app.ai_unbilled_cents(uuid, timestamptz) from public, anon, authenticated, service_role;
create or replace function app.billing_attach_ai_usage(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  inv      public.billing_invoices%rowtype;
  v_from   timestamptz := app.ai_billing_from();
  v_cutoff timestamptz := app.ai_billing_cutoff();
  v_ex     numeric;
  v_first  date;
  v_people jsonb;
begin
  select * into inv from public.billing_invoices where id = p_invoice for update;
  if not found or inv.status <> 'draft' then
    raise exception 'BILLING: AI use can only be added to an invoice that is still a draft'
      using errcode = 'check_violation';
  end if;
  if v_from is null then
    return 0;
  end if;
  -- Under half a cent stays on the ledger for next time rather than being stamped onto an
  -- invoice as nothing.
  if round(app.ai_unbilled_cents(inv.farm_id, v_cutoff)) < 1 then
    return 0;
  end if;

  -- The predicate is app.ai_unbilled_cents', written out because an UPDATE needs it inline.
  with stamped as (
    update public.ai_usage u
       set invoice_id = p_invoice
     where u.farm_id = any (app.customer_site_ids(inv.farm_id))
       and u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.waived_at is null   -- used while exempt (20261029160000, finding money-5)
       and u.occurred_at >= v_from
       and u.occurred_at < v_cutoff
    returning u.user_id, u.occurred_at, u.feature, u.outcome, u.billed_cents, u.audio_ms, u.audio_fixed_ms
  ), people as (
    -- The owner's page counts the same way (public.ai_farm_usage): voice in seconds of
    -- audio, AI help in requests that answered.
    select s.user_id,
           sum(s.billed_cents) as billed,
           sum(case when s.feature = 'voice'
                    then coalesce(s.audio_ms, 0) + coalesce(s.audio_fixed_ms, 0) else 0 end) / 1000
             as voice_seconds,
           count(*) filter (where s.feature <> 'voice' and s.outcome in ('ok', 'fallback'))
             as ai_requests
      from stamped s
     group by s.user_id
  )
  select (select coalesce(sum(billed_cents), 0) from stamped),
         (select min((occurred_at at time zone 'Africa/Johannesburg')::date) from stamped),
         (select jsonb_agg(jsonb_build_object(
                   'user_id', p.user_id,
                   'name', coalesce(nullif(btrim(u.name), ''), u.email, ''),
                   'voice_seconds', p.voice_seconds,
                   'ai_requests', p.ai_requests,
                   'billed_cents', round(p.billed, 4))
                 order by p.billed desc, u.name)
            from people p
            left join public.users u on u.id = p.user_id)
    into v_ex, v_first, v_people;

  if coalesce(v_ex, 0) <= 0 then
    return 0;   -- another invoice stamped them in the meantime
  end if;

  -- The span is the first day with use to yesterday: what the farm reads as "the use since
  -- the last bill".
  update public.billing_invoices
     set ai_usage_ex_vat_cents = round(v_ex)::bigint,
         ai_usage_from         = v_first,
         ai_usage_to           = ((v_cutoff at time zone 'Africa/Johannesburg')::date - 1),
         ai_usage_people       = coalesce(v_people, '[]'::jsonb)
   where id = p_invoice;

  -- Shown on the statement; the money is on the header (the derive trigger has just added
  -- VAT to it), so the line copies the header rather than doing its own arithmetic.
  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select i.id, i.farm_id, 10,
         'AI and voice use, ' || to_char(i.ai_usage_from, 'YYYY-MM-DD')
           || ' to ' || to_char(i.ai_usage_to, 'YYYY-MM-DD'),
         1, 1,
         i.ai_usage_incl_cents, i.ai_usage_incl_cents, i.ai_usage_ex_vat_cents,
         i.ai_usage_incl_cents - i.ai_usage_ex_vat_cents
    from public.billing_invoices i
   where i.id = p_invoice;

  return round(v_ex)::bigint;
end $$;
revoke execute on function app.billing_attach_ai_usage(uuid) from public, anon, authenticated, service_role;

-- == The usage invoice: AI, voice, WhatsApp and storage ======================================
-- 20261029160000's AI-only run, now raised for the BILLING SITE with the use of every site billed
-- through it, and also on the day an annual subscription's storage month is due (its blocks for
-- the month, or an automatic block's part, not yet charged). AI alone still waits for its
-- billing day and the minimum; storage does not. Everything else is unchanged: a going concern
-- only, never exempt, never a trial, a pending sign-up or a suspended account, one usage invoice
-- per customer per day (now also an index).
create or replace function app.generate_ai_usage_invoices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_set       public.billing_settings%rowtype;
  v_from      timestamptz := app.ai_billing_from();
  v_cutoff    timestamptz := app.ai_billing_cutoff();
  v_today     date := (now() at time zone 'Africa/Johannesburg')::date;
  v_month_len integer;
  v_day       integer;
  r           record;
  s           public.billing_subscriptions%rowtype;
  v_farm      public.farms%rowtype;
  v_invoice   uuid;
  v_made      integer := 0;
  v_mstart    date;
  v_mend      date;
  v_ai        bigint;
  v_storage   bigint;
begin
  select * into v_set from public.billing_settings where singleton;
  v_month_len := extract(day from (date_trunc('month', v_today) + interval '1 month' - interval '1 day'))::integer;

  for r in
    with ai as (
      select app.billing_root(u.farm_id) as farm_id, min(u.occurred_at) as first_at, round(sum(u.billed_cents)) as cents
        from public.ai_usage u
       where v_from is not null
         and u.invoice_id is null
         and u.billed_cents > 0
         and u.credential = 'platform'
         and u.waived_at is null   -- used while exempt (20261029160000, finding money-5)
         and u.occurred_at >= v_from
         and u.occurred_at < v_cutoff
       group by 1
    ), st as (
      -- Not a monthly subscription (its period invoice carries storage): blocks held or a
      -- reduction due, with this storage month not yet charged, or a storage charge not invoiced.
      select s2.farm_id
        from public.billing_subscriptions s2
       where s2.deleted_at is null
         and s2.billing_period <> 'monthly'
         and s2.status in ('active', 'past_due', 'non_renewing')
         and (((s2.storage_blocks > 0 or s2.pending_storage_blocks is not null)
               and not exists (select 1 from public.storage_charges c
                                where c.subscription_id = s2.id and c.kind = 'monthly'
                                  and c.period_start = (select m.month_start from app.storage_month(s2.id, v_today) m)))
              or exists (select 1 from public.storage_charges c
                          where c.subscription_id = s2.id and c.invoice_id is null))
    )
    select coalesce(ai.farm_id, st.farm_id) as farm_id, ai.first_at, coalesce(ai.cents, 0) as ai_cents,
           st.farm_id is not null as storage_due
      from ai full join st on st.farm_id = ai.farm_id
      join public.farms f on f.id = coalesce(ai.farm_id, st.farm_id)
       -- Only a going concern, and never an exempt farm (20261029150000). A farm paused for
       -- billing (or held by Rapid Rise) is invoiced nothing; its use stays on the ledger.
       and f.deleted_at is null
       and f.status in ('trial', 'active')
       and not f.billing_exempt
  loop
    -- AI alone waits for the minimum; storage never waits.
    continue when not r.storage_due and r.ai_cents < greatest(coalesce(v_set.ai_min_invoice_cents, 0), 1);

    select * into s from public.billing_subscriptions
     where farm_id = r.farm_id and deleted_at is null
     order by created_at desc
     limit 1
     for update skip locked;
    continue when not found;
    continue when s.status in ('trialing', 'pending', 'suspended');

    -- One usage invoice per customer per day, and none on the day a period invoice was raised
    -- (that one took the use before today and the storage of the month it opens).
    continue when exists (
      select 1 from public.billing_invoices i
       where i.farm_id = r.farm_id
         and i.kind in ('period', 'ai_usage')
         and i.issued_on = current_date
         and i.deleted_at is null
         and i.status <> 'void'
    );

    if not r.storage_due then
      -- AI alone: the billing day of the month (clamped to a short month), unless a billing date
      -- was missed and the use has waited over 35 days.
      v_day := least(
        coalesce(s.anchor_day,
                 extract(day from coalesce(s.next_billing_on, s.current_period_start, s.created_at::date))::integer),
        v_month_len);
      continue when extract(day from v_today)::integer <> v_day
                and r.first_at >= v_cutoff - interval '35 days';
    end if;

    select m.month_start, m.month_end into v_mstart, v_mend from app.storage_month(s.id, v_today) m;
    select * into v_farm from public.farms where id = r.farm_id;

    begin
      insert into public.billing_invoices (
        farm_id, subscription_id, invoice_ref, status, kind,
        period_start, period_end, issued_on, due_on,
        plan, billing_period, asset_count,
        unit_price_incl_cents, months_charged,
        price_version_id, price_version_label, vat_rate_bps,
        seller_vat_number, seller_snapshot, bill_to_snapshot
      ) values (
        r.farm_id, s.id, app.next_billing_invoice_ref(), 'draft', 'ai_usage',
        least(coalesce((r.first_at at time zone 'Africa/Johannesburg')::date, v_today),
              case when r.storage_due then v_mstart else v_today end),
        greatest(v_today - 1, case when r.storage_due then v_mend else v_today - 1 end),
        current_date, current_date + coalesce(v_set.payment_terms_days, 0),
        s.plan, s.billing_period, 0,
        0, 1,
        null, case when r.storage_due then 'Usage and storage' else 'AI and voice use' end, v_set.vat_rate_bps,
        v_set.vat_number,
        jsonb_build_object(
          'legal_name', v_set.legal_name,
          'trading_name', v_set.trading_name,
          'reg_number', v_set.reg_number,
          'vat_registered', v_set.vat_registered,
          'billing_address', v_set.billing_address,
          'billing_email', v_set.billing_email
        ),
        jsonb_build_object(
          'name', v_farm.name,
          'trading_name', v_farm.trading_name,
          'reg_number', v_farm.reg_number,
          'vat_number', v_farm.vat_number,
          'billing_address', v_farm.billing_address,
          'billing_email', v_farm.billing_email
        )
      )
      returning id into v_invoice;
    exception when unique_violation then
      continue;   -- raised already, by a run at the same instant
    end;

    v_ai := app.billing_attach_ai_usage(v_invoice);
    v_storage := case when r.storage_due then app.billing_attach_storage(v_invoice, v_mstart, v_mend) else 0 end;
    if coalesce(v_ai, 0) <= 0 and coalesce(v_storage, 0) <= 0
       and not exists (select 1 from public.storage_charges c where c.invoice_id = v_invoice) then
      -- Another invoice took the rows in the meantime, or a reduction left nothing to charge.
      -- A draft may be deleted; an empty invoice must not be issued.
      delete from public.billing_invoice_lines where invoice_id = v_invoice;
      delete from public.billing_invoices where id = v_invoice;
      continue;
    end if;

    update public.billing_invoices set status = 'open' where id = v_invoice;
    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;
revoke execute on function app.generate_ai_usage_invoices() from public, anon, authenticated, service_role;

