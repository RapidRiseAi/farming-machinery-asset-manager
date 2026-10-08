-- 20261010090000_ai_usage_invoicing.sql
-- AI and voice use on the FleetWise invoice (release B of docs/AI_USAGE.md).
--
-- Since 20261004100000 every paid AI and voice call has been settled into `ai_usage` with
-- what the farm is billed for it, ex VAT, and nothing has ever collected it. This puts it
-- on the invoice, and it is OFF until Rapid Rise sets a date:
--
--   billing_settings.ai_billing_starts_on   null: nothing is billed (the behaviour so far);
--                                            a date: use from that day on is invoiced.
--
-- WHAT IS BILLED, AND WHEN
-- =============================================================================
-- Completed calendar months in Africa/Johannesburg, the month the limit and the owner's
-- page already use, in arrears. A month is never billed while it is still running, so the
-- amount on the invoice is the amount the owner's page showed for that month.
--
--   * A farm's period invoice carries every unbilled completed month. A monthly farm that
--     renews on the 15th pays for September's use on 15 October, beside October's plan.
--   * A farm with no period invoice coming this month (an annual plan, a price on
--     application, a farm in grace or past its plan) gets an AI-only invoice (kind
--     'ai_usage') once its unbilled use reaches billing_settings.ai_min_invoice_cents.
--     Less than that waits for the next month, rather than a card being charged R3,40.
--   * Never before a farm has agreed to be billed: a trial or an unfinished sign-up is
--     not sent an AI-only invoice. Its use goes on its first invoice.
--
-- WHY ON THE HEADER, AND AFTER THE DISCOUNT
-- =============================================================================
-- The total is derived from the header by app.billing_derive_invoice_totals, never from
-- the lines, so a line alone would be shown and never charged. The header carries the
-- ex-VAT amount; the trigger adds VAT at the invoice's own rate (read after the VAT guard,
-- so an unregistered seller adds none) and adds it to the total AFTER the discount. A
-- Founding Farmer discount is a price on the plan, not a share of the provider's bill.
--
-- STAMPED ONCE
-- =============================================================================
-- Rows are stamped with UPDATE ... RETURNING, so what is summed is exactly what was
-- stamped, and app.ai_usage_guard allows a row to be stamped once, ever. A voided invoice
-- keeps its rows: voiding forgives that use rather than moving it onto the next bill.
--
-- Who used it is frozen onto the invoice when it is raised (ai_usage_people), as the
-- seller and the customer are: a reprint next year shows the names as they were billed.

-- == Settings ===================================================================
alter table public.billing_settings
  add column if not exists ai_billing_starts_on date,
  add column if not exists ai_min_invoice_cents bigint not null default 5000;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'billing_settings_ai_min_invoice_ck') then
    alter table public.billing_settings
      add constraint billing_settings_ai_min_invoice_ck
      check (ai_min_invoice_cents between 0 and 10000000);
  end if;
end $$;

comment on column public.billing_settings.ai_billing_starts_on is
  'First day whose AI and voice use is invoiced. NULL: none is (invoicing is off). Use '
  'before this day is never billed, so moving it later forgives the use in between.';
comment on column public.billing_settings.ai_min_invoice_cents is
  'Smallest AI-only invoice, ex VAT. Less waits for the next month. AI use on a period '
  'invoice has no minimum: it rides on a charge that is happening anyway.';

-- == The invoice ================================================================
alter table public.billing_invoices
  add column if not exists ai_usage_ex_vat_cents bigint not null default 0,
  add column if not exists ai_usage_incl_cents bigint not null default 0,
  add column if not exists ai_usage_from date,
  add column if not exists ai_usage_to date,
  add column if not exists ai_usage_people jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'billing_invoices_ai_usage_ck') then
    alter table public.billing_invoices
      add constraint billing_invoices_ai_usage_ck check (
        ai_usage_ex_vat_cents >= 0
        and ai_usage_incl_cents >= ai_usage_ex_vat_cents
        and (ai_usage_from is null) = (ai_usage_to is null)
        and (ai_usage_from is null or ai_usage_from <= ai_usage_to)
      );
  end if;
end $$;

comment on column public.billing_invoices.ai_usage_ex_vat_cents is
  'AI and voice use on this invoice, ex VAT: the sum of the ai_usage rows stamped with it. '
  'Set by app.billing_attach_ai_usage while the invoice is a draft; frozen once issued.';
comment on column public.billing_invoices.ai_usage_incl_cents is
  'Derived: ai_usage_ex_vat_cents plus VAT at this invoice''s rate. Part of the total.';
comment on column public.billing_invoices.ai_usage_people is
  'Who used it, frozen when the invoice was raised: user_id, name, voice_seconds, '
  'ai_requests and billed_cents (ex VAT) per person.';

alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_ck;
alter table public.billing_invoices
  add constraint billing_invoices_kind_ck check (kind in ('period', 'proration', 'slots', 'ai_usage'));

comment on column public.billing_invoices.kind is
  'period = the ordinary bill for a billing period, and the thing '
  'billing_invoices_farm_period_uq protects from being raised twice. proration = the '
  'difference charged when a farm upgrades its PLAN mid-period (20260910180000). '
  'slots = vehicle slots bought mid-period (20260911140000). ai_usage = AI and voice use '
  'billed on its own, for a farm with no period invoice coming (20261010090000).';

-- One AI-only invoice per farm and span of months. A second run on the same night finds
-- the rows already stamped; this covers two runs at the same instant.
create unique index if not exists billing_invoices_ai_usage_uq
  on public.billing_invoices (farm_id, period_start, period_end)
  where deleted_at is null and status <> 'void' and kind = 'ai_usage';

-- == The total ==================================================================
create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged;

  -- Computed while it is a draft; kept verbatim afterwards. An issued invoice is a
  -- statement about a period that has been billed, and a discount that has since changed
  -- or expired must not restate it.
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

  -- AI and voice use (20261010090000), ex VAT on the header because the ledger is ex VAT.
  -- VAT at this invoice's own rate, which the VAT guard has already settled, and added
  -- AFTER the discount: a discount is a price on the plan, not on the provider's bill.
  new.ai_usage_ex_vat_cents := coalesce(new.ai_usage_ex_vat_cents, 0);
  new.ai_usage_incl_cents   := new.ai_usage_ex_vat_cents
    + round(new.ai_usage_ex_vat_cents::numeric * coalesce(new.vat_rate_bps, 0) / 10000)::bigint;

  new.total_incl_cents      := v_gross - new.discount_cents + new.ai_usage_incl_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;

-- == The freeze =================================================================
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
    return new;   -- a draft is still being assembled
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
     -- S9. Both snapshots are documented as frozen, a copy of an invoice reprinted next
     -- year must show the company and the customer as they were, and neither was in this
     -- list, so both were quietly editable on an issued invoice. Freezing the figures
     -- while leaving the NAMES and ADDRESSES on them editable is the half of a frozen
     -- document that a tax authority would care about most.
     -- AI and voice use (20261010090000): what was billed, the months and who used it.
     or new.ai_usage_ex_vat_cents is distinct from old.ai_usage_ex_vat_cents
     or new.ai_usage_incl_cents   is distinct from old.ai_usage_incl_cents
     or new.ai_usage_from         is distinct from old.ai_usage_from
     or new.ai_usage_to           is distinct from old.ai_usage_to
     or new.ai_usage_people       is distinct from old.ai_usage_people
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

-- == What is billable ===========================================================
-- The first moment whose use is invoiced, or NULL while invoicing is off (no date, or a
-- date still to come). Johannesburg's day, like every month in the ledger.
create or replace function app.ai_billing_from() returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when s.ai_billing_starts_on is not null
            and s.ai_billing_starts_on <= (now() at time zone 'Africa/Johannesburg')::date
           then s.ai_billing_starts_on::timestamp at time zone 'Africa/Johannesburg'
         end
    from public.billing_settings s
   where s.singleton
   limit 1
$$;

-- A farm's unbilled use, ex VAT, from the months before p_before_month. The same rows
-- app.billing_attach_ai_usage stamps; 0 while invoicing is off (a NULL start matches none).
create or replace function app.ai_unbilled_cents(p_farm uuid, p_before_month date) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(u.billed_cents), 0)
    from public.ai_usage u
   where u.farm_id = p_farm
     and u.invoice_id is null
     and u.billed_cents > 0
     and u.credential = 'platform'
     and u.occurred_at >= app.ai_billing_from()
     and u.month < p_before_month
$$;

revoke execute on function app.ai_billing_from() from public, anon, authenticated, service_role;
revoke execute on function app.ai_unbilled_cents(uuid, date) from public, anon, authenticated, service_role;

-- == Putting it on an invoice ===================================================
-- Stamps the farm's unbilled use from completed months onto a DRAFT invoice, sets the
-- header and writes a line. Returns the ex-VAT cents added, 0 when there was nothing (or
-- invoicing is off), in which case nothing is touched.
create or replace function app.billing_attach_ai_usage(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  inv      public.billing_invoices%rowtype;
  v_from   timestamptz := app.ai_billing_from();
  v_before date := app.ai_month(now());
  v_ex     numeric;
  v_first  date;
  v_last   date;
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
  if round(app.ai_unbilled_cents(inv.farm_id, v_before)) < 1 then
    return 0;
  end if;

  -- The predicate is app.ai_unbilled_cents', written out because an UPDATE needs it inline.
  with stamped as (
    update public.ai_usage u
       set invoice_id = p_invoice
     where u.farm_id = inv.farm_id
       and u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.occurred_at >= v_from
       and u.month < v_before
    returning u.user_id, u.month, u.feature, u.outcome, u.billed_cents, u.audio_ms, u.audio_fixed_ms
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
         (select min(month) from stamped),
         (select max(month) from stamped),
         (select jsonb_agg(jsonb_build_object(
                   'user_id', p.user_id,
                   'name', coalesce(nullif(btrim(u.name), ''), u.email, ''),
                   'voice_seconds', p.voice_seconds,
                   'ai_requests', p.ai_requests,
                   'billed_cents', round(p.billed, 4))
                 order by p.billed desc, u.name)
            from people p
            left join public.users u on u.id = p.user_id)
    into v_ex, v_first, v_last, v_people;

  if coalesce(v_ex, 0) <= 0 then
    return 0;   -- another invoice stamped them in the meantime
  end if;

  update public.billing_invoices
     set ai_usage_ex_vat_cents = round(v_ex)::bigint,
         ai_usage_from         = v_first,
         ai_usage_to           = (v_last + interval '1 month' - interval '1 day')::date,
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

-- == The period invoice carries it ==============================================
-- 20260911120000's generator, unchanged except for the one call before the invoice is
-- issued (marked AI USE below).
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
       )
       and (p_only is null or id = p_only)
       -- `pending` is here so a brand-new sign-up gets the invoice it is about to pay,
       -- and the clause below is what stops that becoming a monthly habit: a pending
       -- subscription is invoiced ONCE, ever. Without it, every abandoned sign-up would
       -- quietly accumulate an invoice a month for a farm nobody can even log into.
       and status in ('active', 'past_due', 'trialing', 'non_renewing', 'pending')
       and (status <> 'pending' or not exists (
             select 1 from public.billing_invoices i
              where i.subscription_id = billing_subscriptions.id
           ))
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
    v_count := app.billing_billable_units(s.id);
    if v_count <= 0 then
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
      'FleetWise ' || s.plan::text || ', ' || v_count::text || ' vehicle(s)',
      v_count, v_price.months_charged,
      v_price.per_vehicle_monthly_incl_cents,
      i.total,
      app.ex_vat_cents(i.total, i.rate),
      i.total - app.ex_vat_cents(i.total, i.rate)
    from (
      select
        (v_price.per_vehicle_monthly_incl_cents * v_count * v_price.months_charged)::bigint as total,
        -- Read the rate BACK off the invoice: the VAT guard may have forced it to zero,
        -- and a line that disagreed with its own invoice would be the worst of both.
        (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
    ) i;

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

    insert into public.billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, source)
    values (s.farm_id, s.id, current_date, v_count, 'period_close')
    on conflict (farm_id, captured_on, source) do update set asset_count = excluded.asset_count;

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
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_billing_invoices(uuid) from public, anon, authenticated;

-- == An invoice of its own, for a farm no period invoice will reach ==============
create or replace function app.generate_ai_usage_invoices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_set      public.billing_settings%rowtype;
  v_from     timestamptz := app.ai_billing_from();
  v_before   date := app.ai_month(now());
  v_today    date := (now() at time zone 'Africa/Johannesburg')::date;
  v_month_end date := (app.ai_month(now()) + interval '1 month' - interval '1 day')::date;
  r          record;
  s          public.billing_subscriptions%rowtype;
  v_farm     public.farms%rowtype;
  v_invoice  uuid;
  v_made     integer := 0;
begin
  if v_from is null then
    return 0;
  end if;
  select * into v_set from public.billing_settings where singleton;

  for r in
    select u.farm_id, min(u.month) as first_month, max(u.month) as last_month
      from public.ai_usage u
      join public.farms f on f.id = u.farm_id and f.deleted_at is null
     where u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.occurred_at >= v_from
       and u.month < v_before
     group by u.farm_id
    having round(sum(u.billed_cents)) >= greatest(coalesce(v_set.ai_min_invoice_cents, 0), 1)
  loop
    -- The card is charged through the subscription. A farm without one (made by Rapid Rise,
    -- never signed up) has no card and no terms to bill on: its use stays on the ledger,
    -- by farm on /admin/ai, for Rapid Rise to settle by hand.
    select * into s from public.billing_subscriptions
     where farm_id = r.farm_id and deleted_at is null
     order by created_at desc
     limit 1
     for update skip locked;
    continue when not found;

    -- Not yet agreed to be billed: its use goes on its first invoice.
    continue when s.status in ('trialing', 'pending');

    -- A monthly renewal is coming this month and will carry it. The statuses are the
    -- generator's. A renewal date already passed is one the generator did not take (a
    -- price on application, no vehicles), so that farm is billed here instead.
    continue when s.billing_period = 'monthly'
              and s.status in ('active', 'past_due', 'non_renewing')
              and s.next_billing_on is not null
              and s.next_billing_on > v_today
              and s.next_billing_on <= v_month_end;

    -- These months were billed on their own already and a row has since arrived for them
    -- (a hold settled late). It waits for next month's span, rather than taking an invoice
    -- number every night only to lose it to the unique index.
    continue when exists (
      select 1 from public.billing_invoices i
       where i.farm_id = r.farm_id
         and i.kind = 'ai_usage'
         and i.period_start = r.first_month
         and i.period_end = (r.last_month + interval '1 month' - interval '1 day')::date
         and i.deleted_at is null
         and i.status <> 'void'
    );

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
        -- A draft while it is assembled, as the generator does: lines may only be written
        -- to a draft. No vehicles and no unit price: the whole amount is the AI use.
        r.farm_id, s.id, app.next_billing_invoice_ref(), 'draft', 'ai_usage',
        r.first_month, (r.last_month + interval '1 month' - interval '1 day')::date,
        current_date, current_date + coalesce(v_set.payment_terms_days, 0),
        s.plan, s.billing_period, 0,
        0, 1,
        null, 'AI and voice use', v_set.vat_rate_bps,
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

    if app.billing_attach_ai_usage(v_invoice) <= 0 then
      -- Another invoice took the rows between the sum above and the stamp. A draft may be
      -- deleted; an empty invoice must not be issued.
      delete from public.billing_invoices where id = v_invoice;
      continue;
    end if;

    update public.billing_invoices set status = 'open' where id = v_invoice;
    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_ai_usage_invoices() from public, anon, authenticated, service_role;

-- The public wrapper the billing cron calls, after the period invoices and before the
-- charges, so an AI-only invoice is charged the night it is raised.
create or replace function public.cron_generate_ai_usage_invoices() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.generate_ai_usage_invoices();
$$;

revoke execute on function public.cron_generate_ai_usage_invoices() from public, anon, authenticated;
grant  execute on function public.cron_generate_ai_usage_invoices() to service_role;

-- == The renewal notice says so ==================================================
-- 20260918140000's notice, with three changes:
--   * the price is the one the generator will use (app.billing_price_for_subscription,
--     which honours a grandfathered pin), not whichever version is active today;
--   * the discount comes off, as it will on the invoice: a Founding Farmer was being
--     warned of the list price;
--   * while AI use is invoiced, the payload carries it (ai_billed, and ai_cents: the use
--     the invoice would carry if it were raised now, VAT included at the plan's rate), and
--     the message says "plus AI and voice use".
create or replace function app.enqueue_billing_renewal_notices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s        public.billing_subscriptions%rowtype;
  v_set    public.billing_settings%rowtype;
  v_days   integer;
  v_due    date;
  v_units  integer;
  v_price  public.billing_price_versions%rowtype;
  v_amount bigint;
  v_ai_on  boolean := app.ai_billing_from() is not null;
  v_ai     bigint;
  v_rate   integer;
  v_sent   integer := 0;
begin
  select * into v_set from public.billing_settings where singleton limit 1;

  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       -- ACTIVE only. A farm in `past_due` or `grace` is already being told about a
       -- payment that failed; adding "and another one is coming" to that is noise on top
       -- of a problem. `pending` has never paid and `non_renewing` is not renewing.
       and status = 'active'
       and not cancel_at_period_end
  loop
    v_days := case s.billing_period
                when 'annual' then coalesce(v_set.renewal_notice_days_annual, 14)
                else coalesce(v_set.renewal_notice_days_monthly, 3)
              end;
    continue when v_days <= 0;

    v_due := coalesce(s.next_billing_on, s.current_period_end);
    continue when v_due is null;
    -- The window is the single day the notice is due, not "any time before". Anything
    -- wider re-sends every night until the charge lands.
    continue when v_due - v_days <> current_date;

    -- SILENT if there is no price: quoting a figure the generator will not produce would
    -- be worse than saying nothing, this message exists to make the deduction recognisable.
    select * into v_price from app.billing_price_for_subscription(s.id);
    continue when v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null;

    -- `coalesce(quota, counted)`, the same rule app.billing_billable_units applies, so
    -- the warned amount and the invoiced amount agree.
    v_units  := app.billing_billable_units(s.id);
    v_amount := v_price.per_vehicle_monthly_incl_cents::bigint
                  * greatest(v_units, 0) * v_price.months_charged;
    v_amount := v_amount - coalesce(app.billing_discount_cents(s.id, v_amount, v_due), 0);

    v_ai := 0;
    if v_ai_on then
      v_rate := case when v_set.vat_registered then coalesce(v_price.vat_rate_bps, 0) else 0 end;
      v_ai := round(app.ai_unbilled_cents(s.farm_id, date_trunc('month', v_due)::date)
                    * (10000 + v_rate) / 10000)::bigint;
    end if;
    continue when v_amount <= 0 and v_ai <= 0;

    -- One per farm per period. Keyed off the DUE DATE in the payload rather than a time
    -- window, so a re-run, a double-fired schedule and a manual pass all land on the row
    -- that is already there.
    if exists (
      select 1 from public.notifications n
       where n.farm_id = s.farm_id
         and n.template = 'billing_renewal_due'
         and n.payload->>'due_on' = v_due::text
    ) then
      continue;
    end if;

    perform app.notify_farm(
      s.farm_id,
      'billing_renewal_due',
      jsonb_build_object(
        'due_on',         v_due,
        'amount_cents',   greatest(v_amount, 0),
        'plan',           s.plan,
        'billing_period', s.billing_period,
        'units',          v_units,
        'ai_billed',      v_ai_on,
        'ai_cents',       v_ai
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;

revoke execute on function app.enqueue_billing_renewal_notices() from public, anon, authenticated;
