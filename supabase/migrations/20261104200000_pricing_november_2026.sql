-- 20261104200000_pricing_november_2026.sql
-- The November 2026 price list: R49 / R79 / R99 per vehicle per month, a five-slot
-- minimum, and Done-For-You by quotation only.
--
-- Founder decisions of 29 October 2026 (output/fleetwise-economics-2026-10-29,
-- approved-pricing-and-activation.md), published on the FleetWise website on
-- 4 November 2026. Recorded in docs/FLEETWISE_FOUNDER_DECISIONS.md, addendum of
-- 4 November 2026.
--
-- == What changes for whom =====================================================
-- * NEW agreements: the launch-2026-11 generation. Essential R49, Professional R79,
--   Complete R99 per vehicle per month; annual is ten months for twelve (R490 / R790 /
--   R990 per vehicle per year), exactly as before. Every row carries a minimum of five
--   billed slots: R245 / R395 / R495 a month, R2,450 / R3,950 / R4,950 a year.
-- * EXISTING agreements keep their price. A subscription already holds its price through
--   its pin or its last invoice (app.billing_price_for_subscription); the few that hold
--   neither (a trial that has not been invoiced) are pinned below, BEFORE the launch rows
--   are retired, so nobody's price moves because a new list was published. Exempt farms
--   are not pinned: they have agreed no price, and are billed today's list if the flag is
--   ever cleared. The launch rows carry no minimum, so a grandfathered invoice is unchanged.
-- * DONE-FOR-YOU has no row on the new list. It is remote fleet management quoted per
--   customer (from R170 per vehicle a month, at least R2,500 a month), and a marketing
--   floor is not a price anyone can be auto-invoiced at. With no active price,
--   sign-up refuses it (app.create_pending_signup), a plan change refuses it
--   (app.billing_plan_change_quote) and the invoice run never bills it
--   (app.generate_billing_invoices): exactly the "price on application" path the engine
--   already had. A farm already pinned to the launch R250 row keeps it.
--
-- == The minimum ===============================================================
-- `billing_price_versions.min_billed_slots`, frozen with the other money columns. It is
-- a minimum NUMBER OF SLOTS rather than a minimum amount, which is how the website states
-- it ("five paid assets") and keeps every invoice line `unit price x count x months`:
-- there is no separate "minimum charge" line to reconcile. Sign-up raises the slots to
-- it, a slot change refuses to go below it, a plan change onto it asks for the slots
-- first, and the invoice run bills at least it.
--
-- The minimum is per SUBSCRIPTION, which today is per farm. The website's pooled
-- customer subscription (one minimum across a customer's sites) needs a billing-customer
-- grouping above farms that does not exist yet; until it does, a multi-site customer is
-- quoted and set up by staff.
--
-- == Fixed in passing ==========================================================
-- The plan-upgrade quote counted MACHINES (app.billable_asset_count) while every invoice
-- bills SLOTS (app.billing_billable_units); it predates the quota model and was never
-- moved to it. A farm with ten slots and three machines paid the upgrade on three.
--
-- Prices stay VAT-inclusive and 0% while Rapid Rise is not VAT-registered, as on the
-- launch rows; registering is a new generation, not an edit.

-- == The minimum, on the price row ================================================
alter table public.billing_price_versions
  add column if not exists min_billed_slots integer not null default 0;
alter table public.billing_price_versions
  drop constraint if exists billing_price_versions_min_slots_ck;
alter table public.billing_price_versions
  add constraint billing_price_versions_min_slots_ck check (min_billed_slots between 0 and 1000);
comment on column public.billing_price_versions.min_billed_slots is
  'Fewest vehicle slots a subscription on this price is billed for (20261104200000). '
  '0 = no minimum (the launch-2026 generation). Frozen with the money columns.';

create or replace function app.billing_freeze_price_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.billing_invoices where price_version_id = old.id) then
      raise exception 'BILLING: price version % is referenced by an invoice and cannot be deleted',
        old.version_label using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'draft'
     and (new.per_vehicle_monthly_incl_cents is distinct from old.per_vehicle_monthly_incl_cents
          or new.months_charged is distinct from old.months_charged
          or new.vat_rate_bps   is distinct from old.vat_rate_bps
          or new.plan           is distinct from old.plan
          or new.billing_period is distinct from old.billing_period
          -- The minimum is part of the price (20261104200000): changing it on a used row
          -- would restate what every customer on it agreed to pay.
          or new.min_billed_slots is distinct from old.min_billed_slots) then
    raise exception
      'BILLING: price version % is no longer a draft; retire it and add a new version instead',
      old.version_label using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- == Existing agreements keep their price ============================================
-- Pinned to whatever they would be charged today, before today changes. A subscription
-- with a pin or an invoice already resolves to its own price and is left alone.
do $pin$
declare
  r record;
  v public.billing_price_versions%rowtype;
begin
  for r in
    select s.id
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.price_version_id is null
       and s.status <> 'cancelled'
       and s.ended_on is null
       and not f.billing_exempt
       and not exists (select 1 from public.billing_invoices i
                        where i.subscription_id = s.id and i.deleted_at is null and i.status <> 'void')
  loop
    select * into v from app.billing_price_for_subscription(r.id);
    continue when v.id is null;
    update public.billing_subscriptions
       set price_version_id = v.id, price_version_label = v.version_label, updated_at = now()
     where id = r.id;
  end loop;
end $pin$;

-- == Retire the launch list, publish the November list =================================
update public.billing_price_versions
   set status = 'retired',
       -- Never before its own start (a database built today seeds the launch rows today).
       effective_to = greatest(current_date - 1, coalesce(effective_from, current_date - 1))
 where version_label = 'launch-2026' and status = 'active' and deleted_at is null;

insert into public.billing_price_versions (
  version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, min_billed_slots,
  status, effective_from, notes
) values
  ('launch-2026-11', 'essential',    'monthly', 4900,  1, 0, 5, 'active', current_date,
   'Founder decision 2026-10-29, website 2026-11-04. Minimum 5 slots: R245 a month.'),
  ('launch-2026-11', 'essential',    'annual',  4900, 10, 0, 5, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free. R490 per vehicle a year; minimum R2,450.'),
  ('launch-2026-11', 'professional', 'monthly', 7900,  1, 0, 5, 'active', current_date,
   'Founder decision 2026-10-29, website 2026-11-04. Minimum 5 slots: R395 a month.'),
  ('launch-2026-11', 'professional', 'annual',  7900, 10, 0, 5, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free. R790 per vehicle a year; minimum R3,950.'),
  ('launch-2026-11', 'complete',     'monthly', 9900,  1, 0, 5, 'active', current_date,
   'Founder decision 2026-10-29, website 2026-11-04. Minimum 5 slots: R495 a month.'),
  ('launch-2026-11', 'complete',     'annual',  9900, 10, 0, 5, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free. R990 per vehicle a year; minimum R4,950.');

comment on table public.billing_price_versions is
  'Versioned per-vehicle-per-month price list, VAT-INCLUSIVE cents. launch-2026 '
  '(R44/R73/R89/R250, 2026-09-04) is retired and still prices the agreements pinned to it; '
  'launch-2026-11 (R49/R79/R99, minimum 5 slots, 20261104200000) is the current list. '
  'Done-For-You has no current row: it is quoted. A non-draft row''s money columns are '
  'frozen: reprice by retiring a generation and inserting a new one, never by editing.';

-- == The functions that bill a count ==================================================
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
      'FleetWise ' || s.plan::text || ', ' || v_count::text || ' vehicle(s)'
        || case when v_count > app.billing_billable_units(s.id) then ' (plan minimum)' else '' end,
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
    -- With the plan minimum (20261104200000), exactly as the invoice run applies it.
    v_units  := greatest(app.billing_billable_units(s.id), coalesce(v_price.min_billed_slots, 0));
    v_amount := v_price.per_vehicle_monthly_incl_cents::bigint
                  * greatest(v_units, 0) * v_price.months_charged;
    v_amount := v_amount - coalesce(app.billing_discount_cents(s.id, v_amount, v_due), 0);

    v_ai := 0;
    if v_ai_on then
      v_rate := case when v_set.vat_registered then coalesce(v_price.vat_rate_bps, 0) else 0 end;
      v_ai := round(app.ai_unbilled_cents(s.farm_id, now()) * (10000 + v_rate) / 10000)::bigint;
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

create or replace function app.billing_quota_change_quote(p_sub uuid, p_quota integer)
returns table (
  kind             text,     -- 'increase_now' | 'scheduled' | 'no_change' | 'unavailable'
  effective_on     date,
  current_quota    integer,
  new_quota        integer,
  in_use           integer,
  days_remaining   integer,
  days_in_period   integer,
  charge_now_cents bigint,
  reason           text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s        public.billing_subscriptions%rowtype;
  v_price  public.billing_price_versions%rowtype;
  v_now    integer;
  v_used   integer;
  v_rem    integer;
  v_total  integer;
  v_unit   bigint;
  v_charge bigint;
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    return query select 'unavailable', null::date, null::integer, p_quota, 0, 0, 0, 0::bigint,
                        'no such subscription';
    return;
  end if;

  if p_quota is null or p_quota < 1 then
    return query select 'unavailable', null::date, s.asset_quota, p_quota, 0, 0, 0, 0::bigint,
                        'choose at least one vehicle';
    return;
  end if;

  -- A cancelled or ended subscription is replaced, not edited. Letting a quota change
  -- revive one would reintroduce S5 by another door.
  if s.status = 'cancelled' or s.ended_on is not null then
    return query select 'unavailable', null::date, s.asset_quota, p_quota, 0, 0, 0, 0::bigint,
                        'subscription has ended';
    return;
  end if;

  -- THE PLAN MINIMUM (20261104200000). Fewer slots than the price's minimum would be
  -- billed as the minimum anyway, so a farm would pay for slots it had given back. The
  -- price is the one this farm actually pays: a grandfathered launch price has none.
  select * into v_price from app.billing_price_for_subscription(p_sub);
  if p_quota < coalesce(v_price.min_billed_slots, 0) then
    return query select 'unavailable', null::date, s.asset_quota, p_quota, 0, 0, 0, 0::bigint,
                        format('the minimum on this plan is %s vehicle slots', v_price.min_billed_slots);
    return;
  end if;

  v_used := app.billable_asset_count(s.farm_id);
  v_now  := coalesce(s.asset_quota, v_used);

  if p_quota = v_now then
    return query select 'no_change', null::date, v_now, p_quota, v_used, 0, 0, 0::bigint,
                        'already on this many';
    return;
  end if;

  -- Below what is actually on the farm. Refused, and told what to do about it: nothing
  -- here deletes a farmer's vehicles to make a billing change fit.
  if p_quota < v_used then
    return query select 'unavailable', null::date, v_now, p_quota, v_used, 0, 0, 0::bigint,
                        'retire or sell a vehicle first';
    return;
  end if;

  -- GIVING SLOTS BACK: at period end, like every other downgrade.
  if p_quota < v_now then
    return query select 'scheduled',
      coalesce(s.current_period_end + 1, s.next_billing_on, current_date),
      v_now, p_quota, v_used, 0, 0, 0::bigint,
      'fewer vehicles takes effect at period end';
    return;
  end if;

  -- BUYING MORE. Priced against what this farm is ACTUALLY paying, which is not
  -- necessarily the active version, see 20260910160000.
  select * into v_price from app.billing_price_for_subscription(p_sub);
  if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
    return query select 'unavailable', null::date, v_now, p_quota, v_used, 0, 0, 0::bigint,
                        'no confirmed price for this plan';
    return;
  end if;

  -- Nothing billed yet: nothing has been paid for, so there is nothing to pro-rate.
  if s.current_period_start is null or s.current_period_end is null then
    return query select 'increase_now', current_date, v_now, p_quota, v_used, 0, 0, 0::bigint,
                        'nothing has been billed yet, so nothing is pro-rated';
    return;
  end if;

  v_total := greatest((s.current_period_end - s.current_period_start) + 1, 1);
  -- Inclusive of today, exactly as the plan quote does it: somebody adding a vehicle this
  -- morning has it for the whole of today.
  v_rem   := greatest(least((s.current_period_end - current_date) + 1, v_total), 0);

  -- Per SLOT, rounded here and multiplied after, so the pro-rata invoice's own
  -- `unit_price × asset_count × months` arithmetic agrees to the cent.
  v_unit := round(
    (v_price.per_vehicle_monthly_incl_cents::bigint * v_price.months_charged)::numeric
      * v_rem / v_total
  )::bigint;
  v_charge := greatest(v_unit, 0) * (p_quota - v_now);

  return query select 'increase_now', current_date, v_now, p_quota, v_used, v_rem, v_total,
    v_charge,
    case
      when v_unit <= 0 then 'no charge for the rest of this period'
      when v_charge < 100 then 'less than R1,00, below what the provider will process'
      else null
    end;
end $$;

create or replace function app.create_pending_signup(
  p_user       uuid,     -- already created in auth.users by the caller
  p_email      text,
  p_name       text,     -- the person
  p_farm_name  text,
  p_plan       farm_plan,
  p_period     billing_period,
  p_quota      integer,
  p_promo_code text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm  uuid;
  v_sub   uuid;
  v_price public.billing_price_versions%rowtype;
  v_promo jsonb;
  v_quota integer;
begin
  if p_quota is null or p_quota < 1 then
    raise exception 'SIGNUP: choose at least one vehicle' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_farm_name), '') = '' then
    raise exception 'SIGNUP: the farm needs a name' using errcode = 'check_violation';
  end if;

  -- Never invent a price. A plan with no active price version is either bespoke
  -- (price-on-application) or one nobody has priced yet, and signing somebody up for it
  -- would produce a farm that can never be invoiced and therefore never opened.
  select * into v_price from app.billing_active_price(p_plan, p_period);
  if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
    raise exception 'SIGNUP: that plan is not available to buy online'
      using errcode = 'check_violation';
  end if;

  -- THE PLAN MINIMUM (20261104200000). The sign-up form starts at the minimum and will
  -- not go below it, so a smaller number only arrives from a stale page. The farm gets
  -- the slots it is billed for rather than paying for five and being allowed three; the
  -- first invoice, which they see before paying, states the count.
  v_quota := greatest(p_quota, coalesce(v_price.min_billed_slots, 0));

  insert into public.farms (name, plan, status, billing_period, billing_email)
  values (btrim(p_farm_name), p_plan, 'active', p_period, lower(btrim(p_email)))
  returning id into v_farm;

  insert into public.users (id, farm_id, workshop_id, role, name, email, active)
  values (p_user, v_farm, null, 'owner',
          nullif(btrim(p_name), ''), lower(btrim(p_email)), true);

  -- next_billing_on = today so the generator below picks it up immediately; the period
  -- columns stay NULL so the first BILLED period starts when billing starts, which is the
  -- same rule app.start_billing_subscription follows.
  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on,
    anchor_day, asset_quota, created_by
  ) values (
    v_farm, p_plan, p_period, 'pending',
    null, null, current_date,
    extract(day from current_date)::integer, v_quota, p_user
  )
  returning id into v_sub;

  -- BEFORE the invoice, or it does not reach the invoice. The take is the authoritative
  -- one: it locks the code's row, so two people racing for the twentieth Founding Farmer
  -- place cannot both get it, and the used_count it increments rolls back with everything
  -- else if the rest of this fails.
  --
  -- A bad code ABORTS the sign-up rather than quietly proceeding at list price. Somebody
  -- who typed a code believes they are buying at a different price, and taking their money
  -- at the higher one because the code was wrong is the version of this they would be
  -- entitled to be angry about.
  if coalesce(btrim(p_promo_code), '') <> '' then
    v_promo := app.billing_take_promo_code(v_sub, p_promo_code);
    if not coalesce((v_promo->>'ok')::boolean, false) then
      raise exception 'SIGNUP_PROMO:%', coalesce(v_promo->>'error', 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;

  -- The invoice they are about to pay. Inside the same transaction, so a sign-up either
  -- produces a farm with something to pay or produces nothing at all.
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'SIGNUP: could not raise the first invoice' using errcode = 'check_violation';
  end if;

  return v_sub;
end $$;

create or replace function app.billing_plan_change_quote(
  p_sub uuid, p_plan farm_plan, p_period billing_period
) returns table (
  kind              text,     -- 'upgrade_now' | 'scheduled' | 'no_change' | 'unavailable'
  effective_on      date,
  vehicles          integer,
  days_remaining    integer,
  days_in_period    integer,
  old_period_cents  bigint,
  new_period_cents  bigint,
  charge_now_cents  bigint,
  new_unit_cents    bigint,
  new_months        integer,
  reason            text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s          public.billing_subscriptions%rowtype;
  v_old      public.billing_price_versions%rowtype;
  v_new      public.billing_price_versions%rowtype;
  v_count    integer;
  v_rem      integer;
  v_total    integer;
  v_old_amt  bigint;
  v_new_amt  bigint;
  v_unit     bigint;
  v_charge   bigint;
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    return query select 'unavailable', null::date, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
                        0::bigint, 0, 'no such subscription';
    return;
  end if;

  if s.plan = p_plan and s.billing_period = p_period then
    return query select 'no_change', null::date, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
                        0::bigint, 0, 'already on this plan';
    return;
  end if;

  -- A cancelled or ended subscription is not changed, it is replaced. Letting a plan
  -- change revive one would reintroduce the S5 defect by another door.
  if s.status = 'cancelled' or s.ended_on is not null then
    return query select 'unavailable', null::date, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
                        0::bigint, 0, 'subscription has ended';
    return;
  end if;

  select * into v_new from app.billing_active_price(p_plan, p_period);
  if v_new.id is null or v_new.per_vehicle_monthly_incl_cents is null then
    -- Price-on-application, or a plan nobody has priced. Never guess at a price.
    return query select 'unavailable', null::date, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
                        0::bigint, 0, 'no confirmed price for that plan';
    return;
  end if;

  -- THE PLAN MINIMUM (20261104200000). A farm on fewer slots than the new price's minimum
  -- adds slots first, at the price it pays now, so the upgrade's pro-rata arithmetic stays
  -- one unit price times one count.
  if app.billing_billable_units(p_sub) < coalesce(v_new.min_billed_slots, 0) then
    return query select 'unavailable', null::date, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
                        0::bigint, 0,
                        format('that plan needs at least %s vehicle slots; add slots first',
                               v_new.min_billed_slots);
    return;
  end if;

  -- SCHEDULED: anything that is not a rank increase on the same term.
  if app.plan_rank(p_plan) <= app.plan_rank(s.plan) or p_period <> s.billing_period then
    return query select
      'scheduled',
      coalesce(s.current_period_end + 1, s.next_billing_on, current_date),
      app.billing_billable_units(p_sub),
      0, 0, 0::bigint, 0::bigint, 0::bigint,
      v_new.per_vehicle_monthly_incl_cents, v_new.months_charged,
      case when p_period <> s.billing_period
           then 'term change takes effect at period end'
           else 'downgrade takes effect at period end' end;
    return;
  end if;

  -- UPGRADE. Priced against what this farm is ACTUALLY paying, which is not necessarily
  -- the currently active version, see 20260910160000. Charging the difference from a
  -- price they were never on would quietly reprice them through the upgrade.
  select * into v_old from app.billing_price_for_subscription(p_sub);
  -- The SLOTS BILLED, not the vehicles counted (20261104200000). This was written
  -- before the quota model (20260910230000) and never moved to it: a farm holding ten
  -- slots and running three was charged the upgrade on three, then billed ten at the new
  -- price on its next invoice. Every slot was paid for at the old price, so every slot
  -- moves to the new one.
  v_count := app.billing_billable_units(p_sub);

  -- No period yet (a subscription that has never been billed): nothing has been paid for,
  -- so there is nothing to pro-rate. The change applies now and the first invoice is
  -- simply raised on the new plan.
  if s.current_period_start is null or s.current_period_end is null then
    return query select 'upgrade_now', current_date, v_count, 0, 0,
      0::bigint, 0::bigint, 0::bigint,
      v_new.per_vehicle_monthly_incl_cents, v_new.months_charged,
      'nothing has been billed yet, so nothing is pro-rated';
    return;
  end if;

  v_total := greatest((s.current_period_end - s.current_period_start) + 1, 1);
  -- Inclusive of today: somebody upgrading this morning gets the whole of today.
  v_rem   := greatest(least((s.current_period_end - current_date) + 1, v_total), 0);

  v_old_amt := coalesce(v_old.per_vehicle_monthly_incl_cents, 0)::bigint
                 * coalesce(v_old.months_charged, 1);
  v_new_amt := v_new.per_vehicle_monthly_incl_cents::bigint * v_new.months_charged;

  -- Per VEHICLE, rounded here and multiplied afterwards, so the invoice's own
  -- `unit_price × asset_count × months` arithmetic agrees to the cent.
  v_unit   := round((v_new_amt - v_old_amt)::numeric * v_rem / v_total)::bigint;
  v_charge := greatest(v_unit, 0) * greatest(v_count, 0);

  return query select
    'upgrade_now', current_date, v_count, v_rem, v_total,
    v_old_amt * greatest(v_count, 0), v_new_amt * greatest(v_count, 0),
    v_charge,
    v_new.per_vehicle_monthly_incl_cents, v_new.months_charged,
    case
      when v_count <= 0 then 'no billable vehicles, so nothing to pro-rate'
      when v_unit <= 0  then 'the new plan costs no more for the rest of this period'
      when v_charge < 100 then 'less than R1,00, below what the provider will process'
      else null
    end;
end $$;

create or replace function app.apply_pending_plan_changes() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_new public.billing_price_versions%rowtype;
        v_done integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and (
         (pending_plan is not null and pending_plan_on <= current_date)
         or (pending_quota is not null and pending_quota_on <= current_date)
       )
       and status <> 'cancelled'
       and ended_on is null
     for update skip locked
  loop
    if s.pending_plan is not null and s.pending_plan_on <= current_date then
      select * into v_new from app.billing_active_price(s.pending_plan, s.pending_billing_period);
    end if;
    -- A plan with no current price (Done-For-You since 20261104200000, which is quoted)
    -- is not landed on: the farm would take the plan's features and never be invoiced for
    -- them. The change stays scheduled for staff to set up as a quoted agreement.
    if s.pending_plan is not null and s.pending_plan_on <= current_date
       and v_new.id is not null and v_new.per_vehicle_monthly_incl_cents is not null then

      update public.billing_subscriptions
         set plan                   = s.pending_plan,
             billing_period         = s.pending_billing_period,
             -- A scheduled change lands on TODAY's price for the plan they are moving to.
             -- They are choosing a different product, so there is nothing to grandfather:
             -- the price they were pinned to belongs to the plan they are leaving.
             price_version_id       = v_new.id,
             price_version_label    = coalesce(v_new.version_label, price_version_label),
             pending_plan           = null,
             pending_billing_period = null,
             pending_plan_on        = null,
             pending_plan_set_at    = null,
             updated_at             = now()
       where id = s.id;

      -- The EFFECTIVE plan follows, with the same non-payment exception as an upgrade.
      if s.plan_before_downgrade is not null then
        update public.billing_subscriptions
           set plan_before_downgrade = s.pending_plan where id = s.id;
      else
        update public.farms set plan = s.pending_plan where id = s.farm_id;
      end if;
    end if;

    -- Fewer vehicle slots, now that the period they paid for has ended. Re-checked
    -- against what is on the farm TODAY rather than trusting the number that was
    -- scheduled: a month has passed, and they may well have added vehicles since.
    -- Applying it blind would put the subscription below its own fleet and make the
    -- ceiling refuse a vehicle that is already there.
    if s.pending_quota is not null and s.pending_quota_on <= current_date then
      update public.billing_subscriptions
         set asset_quota = greatest(s.pending_quota, app.billable_asset_count(s.farm_id)),
             pending_quota        = null,
             pending_quota_on     = null,
             pending_quota_set_at = null,
             updated_at           = now()
       where id = s.id;
    end if;

    -- THE PLAN MINIMUM (20261104200000). A scheduled plan or slot change can land a farm
    -- on a price whose minimum is above its slots (a reduction scheduled under the launch
    -- price, a move onto the November list). It is billed the minimum either way, so it
    -- holds the minimum: paying for five and being allowed three is the wrong half.
    update public.billing_subscriptions su
       set asset_quota = (app.billing_price_for_subscription(su.id)).min_billed_slots,
           updated_at  = now()
     where su.id = s.id
       and su.asset_quota is not null
       and su.asset_quota < coalesce((app.billing_price_for_subscription(su.id)).min_billed_slots, 0);

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
