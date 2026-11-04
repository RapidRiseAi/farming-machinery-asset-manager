-- Fifth corrections, from verifying 20261029150000 (redefinitions, each copied from its
-- latest definition and changed only where a comment cites 20261029160000):
-- 1. A trial that cancelled was invoiced a month when the trial ended, never closed, then
--    suspended: the ending rule and the closer read the trial end as the period end.
-- 2. A cancelled-at-period-end farm whose retry was declined (past_due, grace) was never
--    closed: the closer takes it too and clears its dunning.
-- 3. Reopening inside a paid period went pending when any small invoice was open, and
--    "paid" was matched on period_start, which re-anchors move: the latest period invoice
--    decides now, in reopen and in the restore's re-anchor test.
-- 4. The restore's first-payment re-anchor fired again on a re-payment after a reversal.
-- 5. Exempt farms froze their periods and were billed for the exempt months when the flag
--    was cleared: they move on with nothing raised, and their exempt AI use is waived.
-- 6. Keep open was saved for a farm closed from its own row (Rapid Rise hold, ended).
-- 7. A reopened farm that had never paid was swept the same night: the sweep reads
--    reopened_at.
-- 8. The first period after a trial was about 16 days, charged a month: the anchor is the
--    day billing starts.
-- 9. A manual retry said "nothing to pay" for a paused farm and could charge an exempt one.
-- 10. Slot and plan changes raised invoices while paused, and for exempt farms.
-- (app.ai_usage_guard gains one narrow allowance, for the waiver in 5.)

-- When a farm was made exempt, and the AI it used from then waived when the flag is
-- cleared (20261029160000, finding money-5). Waived, not zeroed: billed_cents stays what
-- the use cost so the monthly caps (app.ai_month_spend) still count it; the two billing
-- paths skip waived rows. A farm exempt before this migration counts from its creation.
alter table public.farms add column if not exists billing_exempt_since timestamptz;
update public.farms set billing_exempt_since = created_at
 where billing_exempt and billing_exempt_since is null;
alter table public.ai_usage add column if not exists waived_at timestamptz;
alter table public.billing_subscriptions add column if not exists reopened_at timestamptz;

create or replace function app.farms_billing_exempt_track() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.billing_exempt then
      new.billing_exempt_since := coalesce(new.billing_exempt_since, now());
    end if;
    return new;
  end if;
  if new.billing_exempt and not old.billing_exempt then
    new.billing_exempt_since := coalesce(new.billing_exempt_since, now());
  elsif old.billing_exempt and not new.billing_exempt then
    update public.ai_usage u
       set waived_at = now()
     where u.farm_id = new.id
       and u.invoice_id is null
       and u.waived_at is null
       and u.occurred_at >= coalesce(old.billing_exempt_since, '-infinity'::timestamptz);
    new.billing_exempt_since := null;
  end if;
  return new;
end $$;
revoke execute on function app.farms_billing_exempt_track() from public, anon, authenticated;

drop trigger if exists farms_billing_exempt_track on public.farms;
create trigger farms_billing_exempt_track
  before insert or update of billing_exempt on public.farms
  for each row execute function app.farms_billing_exempt_track();

create or replace function app.ai_usage_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_usage is a money record and is never deleted.' using errcode = '42501';
  end if;
  if old.invoice_id is null and new.invoice_id is not null
     and (to_jsonb(new) - 'invoice_id') = (to_jsonb(old) - 'invoice_id') then
    return new;
  end if;
  -- Waiving use made while a farm was exempt (20261029160000, finding money-5): waived_at
  -- set once, on a row no invoice has taken, and nothing else changed.
  if old.waived_at is null and new.waived_at is not null
     and old.invoice_id is null and new.invoice_id is null
     and (to_jsonb(new) - 'waived_at') = (to_jsonb(old) - 'waived_at') then
    return new;
  end if;
  raise exception 'ai_usage rows cannot be changed once written.' using errcode = '42501';
end $$;
revoke execute on function app.ai_usage_guard() from public, anon, authenticated;

-- "Is the current period paid?" asked of the subscription's LATEST period invoice, not of
-- an invoice whose period_start equals current_period_start (20261029160000, finding
-- money-3): every re-anchor moves current_period_start away from the paid invoice's own
-- period_start, so the equality missed farms that had paid and billed them again.
create or replace function app.billing_latest_period_invoice(p_sub uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id
    from public.billing_invoices i
   where i.subscription_id = p_sub and i.kind = 'period' and i.deleted_at is null
   order by i.period_start desc, i.created_at desc
   limit 1
$$;
revoke execute on function app.billing_latest_period_invoice(uuid) from public, anon, authenticated, service_role;

create or replace function app.billing_latest_period_paid(p_sub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select i.status = 'paid'
      from public.billing_invoices i
     where i.id = app.billing_latest_period_invoice(p_sub)
  ), false)
$$;
revoke execute on function app.billing_latest_period_paid(uuid) from public, anon, authenticated, service_role;

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

create or replace function app.billing_close_cancellations() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_done integer;
begin
  with closed as (
    update public.billing_subscriptions
       set status = 'cancelled', ended_on = current_date,
           failed_attempt_count = 0, next_retry_on = null, grace_ends_on = null,
           updated_at = now()
     where deleted_at is null
       -- A cancelled-at-period-end farm whose retry was declined is past_due or grace with
       -- the flag still set (app.billing_register_failure), and was never closed: kept
       -- working past its period, then suspended rather than closed, its card retried for
       -- a farm that had left (20261029160000, finding money-6). It closes with the rest;
       -- what it owes stays on its open invoice, and reopening presents it.
       and (status = 'non_renewing' or (cancel_at_period_end and status in ('past_due', 'grace')))
       -- A trial that cancelled ends with its trial (finding money-1).
       and coalesce(current_period_end, trial_ends_on) is not null
       and coalesce(current_period_end, trial_ends_on) < current_date
    returning id
  )
  select count(*)::integer into v_done from closed;
  return v_done;
end $$;
revoke execute on function app.billing_close_cancellations() from public, anon, authenticated;

create or replace function app.billing_reopen_subscription(p_farm uuid, p_by uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  s public.billing_subscriptions%rowtype;
  v_open integer;
begin
  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1
   for update;

  if not found then
    raise exception 'BILLING: no subscription to reopen for this farm'
      using errcode = 'check_violation';
  end if;

  if s.status not in ('cancelled', 'downgraded') then
    raise exception 'BILLING: subscription is % and does not need reopening', s.status
      using errcode = 'check_violation';
  end if;

  -- If the unpaid invoice that caused the lapse is still open, that is what they owe and
  -- what `/activate` will present. Raising a second one would bill the same period twice.
  --
  -- Only what is OWED counts (20261029150000): this subscription's open invoices, not a
  -- once-off service invoice, and not refunded (a live negative payment, the predicate
  -- app.farm_overdue_since uses). It was every open invoice of the farm, so an old refunded
  -- one (open again, deliberately not owed) left a reopened farm pending with nothing it
  -- could pay, and an unpaid service invoice stopped the month being raised at all. Read
  -- before the update below, which touches no invoice.
  select count(*)::integer into v_open
    from public.billing_invoices i
   where i.subscription_id = s.id
     and i.status = 'open'
     and i.deleted_at is null
     and i.kind <> 'service'
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     );

  -- STILL INSIDE A PAID PERIOD (20261029150000). A farm that paid for this month, cancelled
  -- at once and reopens before the month is out has already paid for the days left:
  -- clearing the period billed them again from today. Nothing is owed and the period's own
  -- invoice is paid, so it is simply active again until that period ends, and the next
  -- invoice falls on the day after, as if it had never left. Nothing is raised now.
  --
  -- Whatever else is open (20261029160000, finding money-2): requiring nothing else owed sent
  -- a farm with a paid year and a small AI invoice down the pending path, where paying the
  -- small one raised a whole new year. Another owed invoice is an ordinary debt for the
  -- overdue and suspension rules, as it is for any active farm. "Paid" is the latest period
  -- invoice (app.billing_latest_period_paid), since a re-anchor moves current_period_start
  -- off the paid invoice's own period_start (finding money-3).
  if s.current_period_end is not null and s.current_period_end >= current_date
     and app.billing_latest_period_paid(s.id) then
    -- Active without a payment, so the plan a downgrade took is given back here, as
    -- app.billing_restore_after_payment does when a payment makes it active.
    if s.plan_before_downgrade is not null then
      update public.farms set plan = s.plan_before_downgrade where id = s.farm_id;
    end if;
    update public.billing_subscriptions
       set status                = 'active',
           ended_on              = null,
           cancelled_at          = null,
           cancel_at_period_end  = false,
           cancellation_reason   = null,
           next_billing_on       = current_period_end + 1,
           failed_attempt_count  = 0,
           next_retry_on         = null,
           grace_ends_on         = null,
           last_failure_code     = null,
           plan_before_downgrade = null,
           downgraded_at         = null,
           reopened_at           = now(),
           updated_at            = now()
     where id = s.id;
    return s.id;
  end if;

  update public.billing_subscriptions
     set status                = 'pending',
         ended_on              = null,
         cancelled_at          = null,
         cancel_at_period_end  = false,
         cancellation_reason   = null,
         -- Cleared so the generator computes a fresh period rather than reusing the one
         -- the farm lapsed in. It writes both back immediately, because reopening raises
         -- the bill there and then, the same shape a sign-up has, and deliberately not
         -- `app.start_billing_subscription`'s "leave it null until billing begins", which
         -- suits a subscription created ahead of any invoice.
         current_period_start  = null,
         current_period_end    = null,
         next_billing_on       = current_date,
         -- When it came back, for the dormant sweep (20261029160000, finding money-9): keyed
         -- on created_at, a reopened farm that had never paid was "an old sign-up" and was
         -- swept, farm and people deleted, the night it reopened.
         reopened_at           = now(),
         -- And the anchor with it (20261029150000): the generator ends a period on
         -- billing_advance_period(start, period, anchor_day) - 1, so with the lapsed
         -- subscription's anchor the reopen invoice charged a full month for a period cut
         -- short to the old day. A sign-up anchors on the day it starts; so does this.
         anchor_day            = extract(day from current_date)::integer,
         failed_attempt_count  = 0,
         next_retry_on         = null,
         grace_ends_on         = null,
         last_failure_code     = null,
         updated_at            = now()
   where id = s.id;

  if v_open = 0 then
    perform app.generate_billing_invoices(s.id);
  end if;

  return s.id;
end;
$fn$;
revoke execute on function app.billing_reopen_subscription(uuid, uuid) from public, anon, authenticated;
grant  execute on function app.billing_reopen_subscription(uuid, uuid) to service_role;

create or replace function app.billing_restore_after_payment(p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype;
        v_today date := current_date;
        v_next date;
        v_grace integer;
        v_since date;
        v_days integer;
        v_reanchor boolean;
begin
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  -- ENDED. The money is still recorded and the invoice is still marked paid, that all
  -- happened in app.settle_billing_attempt before this was called, and a debt they owed
  -- being settled is correct. What must NOT happen is the subscription coming back:
  -- somebody who cancelled and then had an in-flight charge complete would otherwise
  -- find themselves subscribed again, and billed again next month, having done nothing.
  --
  -- The dunning fields are still cleared, so the row does not sit there claiming a farm
  -- that has left is three payments behind.
  if s.status = 'cancelled' or s.ended_on is not null then
    update public.billing_subscriptions
       set failed_attempt_count = 0,
           next_retry_on = null,
           grace_ends_on = null,
           last_failure_code = null,
           updated_at = now()
     where id = p_sub;
    return;
  end if;

  -- SUSPENDED for non-payment (20261029090100, corrected by 20261029120000).
  --
  -- Comes back only when nothing that counts is still past its grace: the same test
  -- app.farm_billing_gate makes, so the gate and this never disagree (an invoice that is
  -- not yet due, or still inside its seven days, does not keep a farm locked).
  --
  -- How the period moves depends on what the debt was:
  --   * the CURRENT period's own invoice, paid since the suspension (a payment row created
  --     after suspended_at, so a backdated EFT received date cannot fool it): a fresh
  --     period from today, the founder's "paying starts a fresh period from the payment
  --     date", because that period's access is what was withheld;
  --   * anything else (an AI-only, slots or proration invoice, or an older period's), with
  --     the current period already paid: the period end and the next billing date move on
  --     by exactly the days spent suspended. Re-anchoring here handed an annual farm that
  --     owed R50 of AI use most of a year free.
  -- Either way nothing is billed for the weeks without access.
  if s.status = 'suspended' then
    select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
    v_grace := coalesce(v_grace, 7);
    v_since := app.farm_overdue_since(s.farm_id);
    if v_since is not null and (v_since + v_grace) < v_today then
      update public.billing_subscriptions
         set last_failure_code = null, updated_at = now()
       where id = p_sub;
      return;
    end if;

    v_days := greatest(0, v_today - coalesce(s.suspended_at::date, v_today));
    -- The latest period invoice, not one matched on period_start, which a previous
    -- re-anchor moved (20261029160000, finding money-3).
    v_reanchor := s.suspended_at is not null and app.billing_latest_period_paid(p_sub) and exists (
      select 1 from public.billing_payments p
       where p.invoice_id = app.billing_latest_period_invoice(p_sub) and p.deleted_at is null
         and p.amount_incl_cents > 0 and p.created_at >= s.suspended_at
    );

    if v_reanchor then
      v_next := app.billing_advance_period(v_today, s.billing_period, extract(day from v_today)::integer);
      update public.billing_subscriptions
         set anchor_day = extract(day from v_today)::integer,
             current_period_start = v_today,
             current_period_end = v_next - 1,
             next_billing_on = v_next
       where id = p_sub;
    elsif v_days > 0 then
      -- The anchor moves too (20261029130000): the generator ends each period on
      -- billing_advance_period(start, period, anchor_day), so with the old anchor the next
      -- period snapped back to the old date and the compensation vanished.
      update public.billing_subscriptions
         set current_period_end = current_period_end + v_days,
             next_billing_on = next_billing_on + v_days,
             anchor_day = coalesce(extract(day from next_billing_on + v_days)::integer, anchor_day)
       where id = p_sub;
    end if;

    update public.billing_subscriptions
       set status = case
                      when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                      else 'active'::billing_subscription_status
                    end,
           suspended_at = null,
           failed_attempt_count = 0,
           next_retry_on = null,
           grace_ends_on = null,
           last_failure_code = null,
           updated_at = now()
     where id = p_sub;
    update public.farms
       set status = 'active', suspended_for = null
     where id = s.farm_id and status = 'suspended' and suspended_for = 'billing';
    perform app.notify_farm(s.farm_id, 'billing_resumed', '{}'::jsonb);
    return;
  end if;

  -- PENDING, and its period invoice now paid in full (20261029150000): access starts with
  -- the payment, so the period does too, the same re-anchor the suspended branch makes.
  -- The generator wrote the period on the day it raised the invoice; a reopened farm that
  -- paid 61 days later kept those dates, now in the past, and was raised the two months it
  -- sat locked out on the next two nights. A sign-up paying on the day it was invoiced
  -- gets the same dates the generator wrote, since that day is today.
  -- A FIRST payment only (20261029160000, finding money-4): after a bounced EFT and a
  -- re-payment, the same test fired again and gave the days already used a second time.
  -- An invoice with a reversed payment on it has been paid before, so the period stays.
  -- And only with a current period to start again: a reopened farm has none (the reopen
  -- cleared it), so paying its OLD debt is not paying a period, and re-anchoring here gave it
  -- a month nobody invoiced; the branch below starts its first period today instead.
  if s.status = 'pending' and s.current_period_start is not null
     and app.billing_latest_period_paid(p_sub) and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = app.billing_latest_period_invoice(p_sub) and p.deleted_at is not null
     ) then
    v_next := app.billing_advance_period(v_today, s.billing_period, extract(day from v_today)::integer);
    update public.billing_subscriptions
       set anchor_day = extract(day from v_today)::integer,
           current_period_start = v_today,
           current_period_end = v_next - 1,
           next_billing_on = v_next
     where id = p_sub;
  elsif s.status = 'pending' and s.current_period_start is null
        and s.next_billing_on is not null and s.next_billing_on < v_today then
    -- A reopened farm whose old debt was what it paid has no period yet
    -- (app.billing_reopen_subscription raises none while an older invoice is owed): its
    -- first period starts today too, not on the day it pressed reopen (20261029150000).
    update public.billing_subscriptions
       set anchor_day = extract(day from v_today)::integer,
           next_billing_on = v_today
     where id = p_sub;
  end if;

  if s.plan_before_downgrade is not null then
    update public.farms set plan = s.plan_before_downgrade where id = s.farm_id;
  end if;

  update public.billing_subscriptions
     set status = case
                    when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                    else 'active'::billing_subscription_status
                  end,
         failed_attempt_count = 0,
         next_retry_on = null,
         grace_ends_on = null,
         plan_before_downgrade = null,
         downgraded_at = null,
         last_failure_code = null,
         updated_at = now()
   where id = p_sub;
end $$;
revoke execute on function app.billing_restore_after_payment(uuid) from public, anon, authenticated, service_role;

create or replace function app.sweep_dormant_signups(p_days integer default 7)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_done integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and status = 'pending'
       -- From when it came back, for a reopened one (20261029160000, finding money-9).
       and coalesce(reopened_at, created_at) < now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
       -- Never touch one that has taken money. A part-paid sign-up is a conversation,
       -- not a dormant row.
       --
       -- `billing_subscriptions.farm_id`, NOT `s.farm_id` (it was `.id`, and the same trap).
       -- `s` is this loop's own record variable and is unbound while the query that FEEDS
       -- the loop is planned, so plpgsql substitutes NULL, `= NULL` is never true, and the
       -- whole guard silently passes for everybody. Suite section (y) caught it by sweeping
       -- a sign-up that had paid.
       and not exists (
         select 1 from public.billing_payments p
          -- Reversed payments count too (20261029130000). A sign-up whose EFT bounced is
          -- put back to pending by the reversal, and is a conversation with somebody who
          -- tried to pay, not a dormant row: sweeping it voided the debt and deleted the farm.
          --
          -- By FARM, not through this subscription's invoices (20261029150000). A once-off
          -- service invoice has no subscription, so a sign-up that had paid Rapid Rise R5 000
          -- for onboarding while its first month was still open was swept, farm and people
          -- deleted. public.team_invite_existing already asks the question this way.
          where p.farm_id = billing_subscriptions.farm_id
       )
       -- Never an exempt farm (20261029150000): the gate lets it in whatever it owes, so it
       -- is in use, and seven days later this deleted it and its people.
       and not exists (
         select 1 from public.farms f
          where f.id = billing_subscriptions.farm_id and f.billing_exempt
       )
       -- Nor one with money in flight (20261029150000). A sign-up paying by card on day 8
       -- has a pending attempt and no payment row yet; sweeping it voided the invoice the
       -- money then landed on and deleted the farm that had just paid. An unknown attempt
       -- waits for a person, as it does everywhere else. By farm, as above: the attempt
       -- carries the invoice's farm_id (never null), so this covers the subscription's own.
       and not exists (
         select 1 from public.billing_payment_attempts a
          where a.farm_id = billing_subscriptions.farm_id
            and a.status in ('pending', 'unknown')
       )
     for update skip locked
  loop
    -- Void, never delete. The same promise the non-payment downgrade makes: nothing in
    -- this product is destroyed because somebody stopped paying attention.
    update public.billing_invoices
       set status = 'void', updated_at = now()
     where subscription_id = s.id and status in ('draft', 'open');

    update public.billing_subscriptions
       set status = 'cancelled', ended_on = current_date,
           cancellation_reason = 'dormant sign-up swept', cancelled_at = now(),
           deleted_at = now(), updated_at = now()
     where id = s.id;

    update public.users set active = false, deleted_at = now() where farm_id = s.farm_id;
    update public.farms set status = 'cancelled', deleted_at = now() where id = s.farm_id;

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
revoke execute on function app.sweep_dormant_signups(integer) from public, anon, authenticated;

create or replace function app.start_billing_subscription(
  p_farm uuid, p_plan farm_plan, p_period billing_period, p_trial_days integer default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v       public.billing_settings%rowtype;
  v_id    uuid;
  v_trial integer;
  v_end   date;
  v_start date := current_date;
begin
  if p_farm is null then
    raise exception 'BILLING: a subscription needs a farm';
  end if;
  if not exists (select 1 from public.farms where id = p_farm and deleted_at is null) then
    raise exception 'BILLING: no such farm %', p_farm;
  end if;

  select * into v from public.billing_settings where singleton;

  -- One live subscription per farm. `billing_subscriptions_farm_uq` enforces it; this
  -- turns the constraint into a sentence rather than a duplicate-key stack trace.
  if exists (
    select 1 from public.billing_subscriptions where farm_id = p_farm and deleted_at is null
  ) then
    raise exception 'BILLING: farm % already has a subscription', p_farm
      using errcode = 'unique_violation';
  end if;

  v_trial := greatest(coalesce(p_trial_days, v.trial_days, 0), 0);
  v_end   := case when v_trial > 0 then v_start + v_trial else null end;

  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    trial_ends_on, anchor_day, current_period_start, next_billing_on, created_by
  ) values (
    p_farm, p_plan, p_period,
    -- Cast explicitly: a CASE over two bare literals resolves to `text`, and the
    -- insert then fails with "column status is of type billing_subscription_status".
    case when v_end is not null then 'trialing'::billing_subscription_status
         else 'active'::billing_subscription_status end,
    v_end,
    -- Anchored on the day billing starts (20261029160000, finding money-10): the start
    -- day ended the first period after a 14-day trial about 16 days later, charged a month.
    extract(day from coalesce(v_end + 1, v_start))::integer,
    null,
    coalesce(v_end + 1, v_start),
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end $$;
revoke execute on function app.start_billing_subscription(uuid, farm_plan, billing_period, integer)
  from public, anon, authenticated, service_role;

create or replace function app.invoice_chargeable_now(p_invoice uuid)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid, payment_method_id uuid,
  amount_incl_cents bigint, invoice_ref text, attempt_number integer
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.farm_id, i.subscription_id, s.default_payment_method_id,
         i.total_incl_cents - i.amount_paid_cents,
         i.invoice_ref,
         (select count(*)::integer + 1 from public.billing_payment_attempts a
           where a.invoice_id = i.id)
    from public.billing_invoices i
    join public.billing_subscriptions s on s.id = i.subscription_id and s.deleted_at is null
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
     -- Never an exempt farm's card (20261029160000, finding app-4).
     and not fm.billing_exempt
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.id = p_invoice
     and i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     -- A paused farm too (finding app-4): Rapid Rise's "Retry charge" on a farm paused for
     -- twenty days said "nothing to pay". A success runs the restore and brings it back.
     and s.status in ('active', 'past_due', 'grace', 'non_renewing', 'downgraded', 'suspended')
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     -- The same refund exclusion as the nightly list. The owner's "Try again" button must
     -- not be the way round it.
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     );
$$;
revoke execute on function app.invoice_chargeable_now(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.admin_extend_billing_access(p_farm uuid, p_until date, p_reason text, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sub uuid; v_status billing_subscription_status;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin') then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_until is null or p_until < current_date or p_until > current_date + 60 then
    raise exception 'BILLING: extend access by up to 60 days' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'BILLING: say why access is extended' using errcode = '22023';
  end if;
  select id, status into v_sub, v_status from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null order by created_at desc limit 1;
  if v_sub is null then raise exception 'BILLING: no subscription' using errcode = '22023'; end if;
  -- Only where the gate reads it (20261029150000). app.farm_billing_gate answers 'pending'
  -- for a sign-up and 'closed' for an ended subscription before it ever looks at
  -- access_extended_until, so for those the extension was saved, reported as done, and
  -- changed nothing: the farm stayed on /activate or /closed. A sign-up whose money is on
  -- its way is recorded as a payment instead; a closed farm reopens. 'downgraded' is
  -- retired and is not a state a farm can be kept open from either.
  if v_status in ('pending', 'cancelled', 'downgraded') then
    raise exception 'BILLING: only a paused or overdue farm can be kept open' using errcode = '22023';
  end if;
  -- Nor a farm closed from its own row (20261029160000, findings money-7 and app-3):
  -- deleted, ended, or held by Rapid Rise (suspended for anything but billing). The gate
  -- answers 'closed' from the farm row before it reads the extension.
  if exists (
    select 1 from public.farms f
     where f.id = p_farm
       and (f.deleted_at is not null or f.status = 'cancelled'
            or (f.status = 'suspended' and f.suspended_for is distinct from 'billing'))
  ) then
    raise exception 'BILLING: only a paused or overdue farm can be kept open' using errcode = '22023';
  end if;
  -- Lifting a suspension moves the period on by the days it lasted (20261029120000): the
  -- generator skipped the farm while it was suspended, and without this it would catch up
  -- and invoice the weeks it had no access, one period a night.
  update public.billing_subscriptions
     set current_period_end = case when status = 'suspended' and suspended_at is not null
                                   then current_period_end + greatest(0, current_date - suspended_at::date)
                                   else current_period_end end,
         next_billing_on = case when status = 'suspended' and suspended_at is not null
                                then next_billing_on + greatest(0, current_date - suspended_at::date)
                                else next_billing_on end,
         -- With the anchor, or the next period snaps back (20261029130000).
         -- Only when days were spent suspended (20261029140000): a same-day extension of a
         -- month-end anchor (31, with next_billing_on clamped to the 28th) moved the anchor
         -- down to 28 and shortened every month after.
         anchor_day = case when status = 'suspended' and suspended_at is not null and next_billing_on is not null
                                and current_date > suspended_at::date
                           then extract(day from next_billing_on + (current_date - suspended_at::date))::integer
                           else anchor_day end,
         access_extended_until = p_until, access_extended_by = p_by,
         access_extension_reason = left(btrim(p_reason), 500),
         -- A farm that cancelled goes back to non_renewing, as the restore does, or it was
         -- never closed and was invoiced again (20261029140000).
         status = case when status = 'suspended'
                       then case when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                                 else 'active'::billing_subscription_status end
                       else status end,
         suspended_at = case when status = 'suspended' then null else suspended_at end,
         updated_at = now()
   where id = v_sub;
  update public.farms set status = 'active', suspended_for = null
   where id = p_farm and status = 'suspended' and suspended_for = 'billing';
end $$;
revoke execute on function public.admin_extend_billing_access(uuid, date, text, uuid) from public, anon, authenticated;
grant  execute on function public.admin_extend_billing_access(uuid, date, text, uuid) to service_role;

create or replace function app.change_billing_quota(p_sub uuid, p_quota integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s          public.billing_subscriptions%rowtype;
  q          record;
  v_price    public.billing_price_versions%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm     public.farms%rowtype;
  v_ref      text;
  v_invoice  uuid;
begin
  select * into s from public.billing_subscriptions
   where id = p_sub and deleted_at is null for update;
  if not found then
    raise exception 'BILLING: no such subscription %', p_sub;
  end if;
  -- Not while paused (20261029160000, finding gate-3): a farm that cannot use the app
  -- was raised and opened a pro-rata invoice for more slots or a bigger plan.
  if s.status = 'suspended' then
    raise exception 'BILLING: a paused subscription cannot change its slots or plan until it is paid'
      using errcode = '22023';
  end if;

  select * into q from app.billing_quota_change_quote(p_sub, p_quota);

  if q.kind = 'no_change' then
    return jsonb_build_object('applied', 'no_change');
  end if;
  if q.kind = 'unavailable' then
    raise exception 'BILLING: %', q.reason using errcode = 'check_violation';
  end if;

  -- == SCHEDULED: fewer vehicles, at period end =============================
  if q.kind = 'scheduled' then
    update public.billing_subscriptions
       set pending_quota        = p_quota,
           pending_quota_on     = q.effective_on,
           pending_quota_set_at = now(),
           updated_at           = now()
     where id = p_sub;
    return jsonb_build_object('applied', 'scheduled', 'effective_on', q.effective_on,
                              'quota', p_quota, 'reason', q.reason);
  end if;

  -- == MORE SLOTS, NOW ======================================================
  update public.billing_subscriptions
     set asset_quota = p_quota,
         -- Asking for more cancels a reduction they had scheduled. Wanting more than the
         -- amount you asked to give up is unambiguous about which you meant.
         pending_quota        = null,
         pending_quota_on     = null,
         pending_quota_set_at = null,
         updated_at           = now()
   where id = p_sub;

  -- An exempt farm takes the change and is invoiced nothing (finding gate-3).
  if exists (select 1 from public.farms f where f.id = s.farm_id and f.billing_exempt) then
    return jsonb_build_object('applied', 'now', 'quota', p_quota, 'charged_cents', 0,
                              'reason', 'exempt farm: not invoiced');
  end if;
  if q.charge_now_cents is null or q.charge_now_cents < 100 then
    return jsonb_build_object('applied', 'now', 'quota', p_quota, 'charged_cents', 0,
                              'reason', coalesce(q.reason, 'nothing to pro-rate'));
  end if;

  select * into v_price from app.billing_price_for_subscription(p_sub);
  select * into v_settings from public.billing_settings where singleton;
  select * into v_farm from public.farms where id = s.farm_id;
  v_ref := app.next_billing_invoice_ref();

  -- Draft → lines → open, in one transaction: app.billing_freeze_invoice_line refuses a
  -- line on an issued invoice.
  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    s.farm_id, s.id, v_ref, 'draft', 'slots',
    -- What this pro-rata charge covers: today to the end of the period already paid for.
    current_date, s.current_period_end, current_date,
    current_date + coalesce(v_settings.payment_terms_days, 0),
    s.plan, s.billing_period,
    -- The SLOTS ADDED, not the new total: the earlier ones are already paid for.
    (q.new_quota - q.current_quota),
    (q.charge_now_cents / greatest(q.new_quota - q.current_quota, 1))::bigint, 1,
    v_price.id, v_price.version_label, v_price.vat_rate_bps,
    v_settings.vat_number,
    jsonb_build_object(
      'legal_name', v_settings.legal_name, 'trading_name', v_settings.trading_name,
      'reg_number', v_settings.reg_number, 'vat_registered', v_settings.vat_registered,
      'billing_address', v_settings.billing_address, 'billing_email', v_settings.billing_email),
    jsonb_build_object(
      'name', v_farm.name, 'trading_name', v_farm.trading_name, 'reg_number', v_farm.reg_number,
      'vat_number', v_farm.vat_number, 'billing_address', v_farm.billing_address,
      'billing_email', v_farm.billing_email)
  )
  returning id into v_invoice;

  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select v_invoice, s.farm_id, 0,
         (q.new_quota - q.current_quota)::text || ' more vehicle(s) to '
           || to_char(s.current_period_end, 'DD Mon YYYY'),
         (q.new_quota - q.current_quota), 1,
         (q.charge_now_cents / greatest(q.new_quota - q.current_quota, 1))::bigint,
         i.total, app.ex_vat_cents(i.total, i.rate), i.total - app.ex_vat_cents(i.total, i.rate)
    from (select q.charge_now_cents as total,
                 (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate) i;

  update public.billing_invoices set status = 'open' where id = v_invoice;

  return jsonb_build_object('applied', 'now', 'quota', p_quota,
                            'charged_cents', q.charge_now_cents, 'invoice_id', v_invoice);
end $$;
revoke execute on function app.change_billing_quota(uuid, integer)
  from public, anon, authenticated;

create or replace function app.change_billing_plan(
  p_sub uuid, p_plan farm_plan, p_period billing_period
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s         public.billing_subscriptions%rowtype;
  q         record;
  v_new     public.billing_price_versions%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm    public.farms%rowtype;
  v_ref     text;
  v_invoice uuid;
  v_prev    farm_plan;
begin
  select * into s from public.billing_subscriptions
   where id = p_sub and deleted_at is null for update;
  if not found then
    raise exception 'BILLING: no such subscription %', p_sub;
  end if;
  -- Not while paused (20261029160000, finding gate-3): a farm that cannot use the app
  -- was raised and opened a pro-rata invoice for more slots or a bigger plan.
  if s.status = 'suspended' then
    raise exception 'BILLING: a paused subscription cannot change its slots or plan until it is paid'
      using errcode = '22023';
  end if;

  select * into q from app.billing_plan_change_quote(p_sub, p_plan, p_period);

  if q.kind = 'no_change' then
    return jsonb_build_object('applied', 'no_change');
  end if;
  if q.kind = 'unavailable' then
    raise exception 'BILLING: %', q.reason using errcode = 'check_violation';
  end if;

  -- == SCHEDULED ============================================================
  -- Nothing moves today. They keep every feature of the period they paid for, and the
  -- change is recorded so both the customer and the next invoice can see it coming.
  if q.kind = 'scheduled' then
    update public.billing_subscriptions
       set pending_plan           = p_plan,
           pending_billing_period = p_period,
           pending_plan_on        = q.effective_on,
           pending_plan_set_at    = now(),
           updated_at             = now()
     where id = p_sub;
    return jsonb_build_object(
      'applied', 'scheduled', 'effective_on', q.effective_on,
      'plan', p_plan, 'billing_period', p_period, 'reason', q.reason);
  end if;

  -- == UPGRADE, NOW =========================================================
  select * into v_new from app.billing_active_price(p_plan, p_period);

  -- The COMMERCIAL plan, and the price they are now grandfathered onto.
  update public.billing_subscriptions
     set plan                   = p_plan,
         billing_period         = p_period,
         price_version_id       = v_new.id,
         price_version_label    = v_new.version_label,
         -- An upgrade cancels any downgrade they had scheduled; asking for more than the
         -- thing you asked to give up is unambiguous about which you meant.
         pending_plan           = null,
         pending_billing_period = null,
         pending_plan_on        = null,
         pending_plan_set_at    = null,
         updated_at             = now()
   where id = p_sub;

  -- The EFFECTIVE plan. This is the half that was missing, and the half that decides
  -- whether the customer gets anything for their money.
  --
  -- `plan_before_downgrade` is the case `adminSetSubscriptionPlan` was right to worry
  -- about: a farm downgraded for NON-PAYMENT must not be handed its features back by a
  -- plan change. So the upgrade is recorded as what they will be restored TO, and
  -- `farms.plan` stays where the dunning engine put it until they actually pay.
  if s.plan_before_downgrade is not null then
    update public.billing_subscriptions
       set plan_before_downgrade = p_plan where id = p_sub;
  else
    -- Permitted by the guard because `billing_subscriptions.plan` was set to this value
    -- immediately above, the invariant is satisfied by the order of these two writes,
    -- which is the point of expressing it that way rather than as a flag.
    update public.farms set plan = p_plan where id = s.farm_id;
  end if;

  -- Nothing to collect: a zero or negative delta, no vehicles, or under the provider's
  -- floor. The upgrade still happens, see this file's header for why an unpayable
  -- invoice is worse than an uncollected rand.
  -- An exempt farm takes the change and is invoiced nothing (finding gate-3).
  if exists (select 1 from public.farms f where f.id = s.farm_id and f.billing_exempt) then
    return jsonb_build_object(
      'applied', 'now', 'plan', p_plan, 'billing_period', p_period,
      'charged_cents', 0, 'reason', 'exempt farm: not invoiced');
  end if;
  if q.charge_now_cents is null or q.charge_now_cents < 100 then
    return jsonb_build_object(
      'applied', 'now', 'plan', p_plan, 'billing_period', p_period,
      'charged_cents', 0, 'reason', coalesce(q.reason, 'nothing to pro-rate'));
  end if;

  select * into v_settings from public.billing_settings where singleton;
  select * into v_farm from public.farms where id = s.farm_id;
  v_ref := app.next_billing_invoice_ref();

  -- Draft → lines → open, in one transaction. `app.billing_freeze_invoice_line` refuses a
  -- line on an issued invoice, which is what made the generator abort on every invoice
  -- before 20260906120000.
  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count,
    unit_price_incl_cents, months_charged,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    s.farm_id, s.id, v_ref, 'draft', 'proration',
    -- The period this pro-rata charge actually covers: today to the end of the period
    -- they had already paid for. Not the whole period, they have paid for the first
    -- part of it at the old rate.
    current_date, s.current_period_end, current_date,
    current_date + coalesce(v_settings.payment_terms_days, 0),
    p_plan, p_period, q.vehicles,
    round(q.charge_now_cents::numeric / greatest(q.vehicles, 1))::bigint, 1,
    v_new.id, v_new.version_label, v_new.vat_rate_bps,
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

  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select
    v_invoice, s.farm_id, 0,
    'FleetWise ' || p_plan::text || ', upgrade, ' || q.days_remaining::text
      || ' of ' || q.days_in_period::text || ' days, ' || q.vehicles::text || ' vehicle(s)',
    q.vehicles, 1, i.unit, i.total,
    app.ex_vat_cents(i.total, i.rate), i.total - app.ex_vat_cents(i.total, i.rate)
  from (
    select
      inv.unit_price_incl_cents as unit,
      inv.total_incl_cents      as total,
      -- Read the rate BACK off the invoice: the VAT guard may have forced it to zero, and
      -- a line disagreeing with its own invoice is the worst of both.
      inv.vat_rate_bps          as rate
    from public.billing_invoices inv where inv.id = v_invoice
  ) i;

  update public.billing_invoices set status = 'open' where id = v_invoice;

  return jsonb_build_object(
    'applied', 'now', 'plan', p_plan, 'billing_period', p_period,
    'charged_cents', (select total_incl_cents from public.billing_invoices where id = v_invoice),
    'invoice_id', v_invoice, 'invoice_ref', v_ref,
    'days_remaining', q.days_remaining, 'days_in_period', q.days_in_period);
end $$;
revoke execute on function app.change_billing_plan(uuid, farm_plan, billing_period)
  from public, anon, authenticated;

create or replace function app.ai_unbilled_cents(p_farm uuid, p_before timestamptz) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(u.billed_cents), 0)
    from public.ai_usage u
   where u.farm_id = p_farm
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
     where u.farm_id = inv.farm_id
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
begin
  if v_from is null then
    return 0;
  end if;
  select * into v_set from public.billing_settings where singleton;
  v_month_len := extract(day from (date_trunc('month', v_today) + interval '1 month' - interval '1 day'))::integer;

  for r in
    select u.farm_id, min(u.occurred_at) as first_at
      from public.ai_usage u
      join public.farms f on f.id = u.farm_id and f.deleted_at is null
       -- Only a going concern, and never an exempt farm (20261029150000). A farm paused for
       -- billing (or held by Rapid Rise) is invoiced nothing: "nothing is invoiced while
       -- suspended". Its use stays on the ledger for after it comes back:
       -- app.billing_attach_ai_usage puts it on the next period invoice, or, once it has
       -- waited over 35 days, the catch-up below bills it here.
       and f.status in ('trial', 'active')
       and not f.billing_exempt
     where u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.waived_at is null   -- used while exempt (20261029160000, finding money-5)
       and u.occurred_at >= v_from
       and u.occurred_at < v_cutoff
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
    -- SUSPENDED too (20261029150000), read off the subscription as well as the farm row
    -- above, because the two are separate fields and a hand edit of one leaves the other.
    -- An AI-only invoice raised while paused fell overdue in its turn, so a farm that paid
    -- the debt it was paused for stayed locked behind the new one.
    continue when s.status in ('trialing', 'pending', 'suspended');

    -- One invoice carrying AI per farm per day. A period invoice raised this morning took
    -- every row before today; anything left is a hold settled since, and it waits.
    continue when exists (
      select 1 from public.billing_invoices i
       where i.farm_id = r.farm_id
         and i.kind in ('period', 'ai_usage')
         and i.issued_on = current_date
         and i.deleted_at is null
         and i.status <> 'void'
    );

    -- The farm's billing day of the month, clamped to a short month the way
    -- app.billing_advance_period seats a renewal: the anchor, or the day it renews.
    v_day := least(
      coalesce(s.anchor_day,
               extract(day from coalesce(s.next_billing_on, s.current_period_start, s.created_at::date))::integer),
      v_month_len);
    -- Not its day, unless a billing date was missed and the use has waited over 35 days.
    continue when extract(day from v_today)::integer <> v_day
              and r.first_at >= v_cutoff - interval '35 days';

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
        -- to a draft. No vehicles and no unit price: the whole amount is the AI use. The
        -- period is the use's own span, the first day with use to yesterday.
        r.farm_id, s.id, app.next_billing_invoice_ref(), 'draft', 'ai_usage',
        (r.first_at at time zone 'Africa/Johannesburg')::date, v_today - 1,
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
