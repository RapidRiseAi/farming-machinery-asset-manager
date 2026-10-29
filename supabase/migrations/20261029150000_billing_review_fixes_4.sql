-- Fourth corrections, from verifying 20261029140000 (all redefinitions, each copied from its
-- latest definition and changed only where a comment cites 20261029150000):
-- 1. app.generate_billing_invoices renewed a subscription cancelled at period end on the
--    night the period ended, because the cron raises invoices before it closes
--    cancellations: the close never matched, and the farm was suspended and its card
--    charged for the month after it left. An ending subscription is never renewed now.
-- 2. app.sweep_dormant_signups asked "has it paid?" through this subscription's invoices
--    only, so a sign-up that had paid a service invoice (onboarding) was deleted. It asks by
--    farm now, and never sweeps an exempt farm or one with a card payment in flight.
-- 3. billing_exempt farms ("never asked to pay") were still invoiced, put on the charge
--    list and sent AI-only invoices: the generator, app.due_billing_charges and
--    app.generate_ai_usage_invoices skip them.
-- 4. app.generate_ai_usage_invoices raised AI-only invoices for a suspended farm; nothing is
--    invoiced while paused, and the use waits for the first invoice after it resumes.
-- 5. app.billing_restore_after_payment kept a pending subscription's period as the
--    generator wrote it, so a reopened farm that paid late was raised every month it sat
--    locked out; the first payment of a pending subscription starts the period that day.
-- 6. app.billing_reopen_subscription kept the old anchor (a full month charged for a period
--    cut short), billed again the days of a month already paid, and counted every open
--    invoice of the farm (a refunded one left nothing to pay). The generator's pending rule
--    ignores refunded invoices the same way.
-- 7. public.admin_extend_billing_access saved an extension the gate never reads (pending,
--    cancelled); it refuses those now.
-- 8. app.claim_billing_charge took any amount; it refuses more than is owed under its lock.

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
            -- Exempt farms are never asked to pay (20261029150000): only the gate and the
            -- suspension engine read the flag, so an exempt farm was still invoiced every
            -- period and its card put on the charge list once the invoice fell due.
            and not f.billing_exempt
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
       and not (cancel_at_period_end and current_period_end is not null
                and next_billing_on > current_period_end)
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

create or replace function app.due_billing_charges(p_limit integer default 50)
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
    -- S7. A deleted farm is never charged, full stop. A CANCELLED one is not charged
    -- either: cancelling is our own act, and taking money afterwards reads as a mistake
    -- however correct the underlying debt is. A SUSPENDED farm still is, suspension
    -- withholds the service, it does not forgive what is already invoiced.
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
     -- Nor an EXEMPT farm (20261029150000): "never asked to pay" has to hold at the card
     -- too, not only at the gate, for an invoice raised before the farm was marked.
     and not fm.billing_exempt
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and coalesce(i.due_on, i.issued_on, current_date) <= current_date
     -- GRACE IS NOW RETRIED (founder decision, 2026-09-10). Until this, exhausting the
     -- retry ladder set status='grace' with next_retry_on = null, and 'grace' was not in
     -- this list at all, so the stored card was never presented again by anything, and a
     -- farm whose money simply arrived late was downgraded without ever being asked twice.
     --
     -- The two arms are not the same test. For a live subscription a NULL retry date means
     -- "no reason to wait". In grace it means the weekly retry is switched OFF
     -- (grace_retry_days = 0), which must never read as "charge immediately".
     and (
       (s.status in ('active', 'past_due')
          and coalesce(s.next_retry_on, current_date) <= current_date)
       or
       (s.status = 'grace'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
       or
       -- SUSPENDED (20261029090100): access has stopped, the debt has not. The stored card
       -- is still presented weekly (app.billing_register_failure sets the date and stops
       -- after four weeks), so a farm whose money arrives late comes back by itself.
       (s.status = 'suspended'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
     )
     -- Nothing in flight. A row in `unknown` deliberately blocks this farm entirely
     -- until somebody has reconciled it.
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     -- REFUNDED (20260911210000). A refund makes this invoice unpaid again, which is true
     -- and which would otherwise put it straight back here. Charging somebody the morning
     -- after refunding them is not a recovery, it is the worst thing this system could do.
     -- A human decides what happens next; see docs/BILLING.md §11b.
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;

revoke execute on function app.due_billing_charges(integer)
  from public, anon, authenticated, service_role;

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

create or replace function app.sweep_dormant_signups(p_days integer default 7)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_done integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and status = 'pending'
       and created_at < now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
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
    v_reanchor := s.suspended_at is not null and exists (
      select 1 from public.billing_invoices i
       where i.subscription_id = p_sub and i.kind = 'period' and i.deleted_at is null
         and i.status = 'paid' and i.period_start = s.current_period_start
         and exists (select 1 from public.billing_payments p
                      where p.invoice_id = i.id and p.deleted_at is null
                        and p.amount_incl_cents > 0 and p.created_at >= s.suspended_at)
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
  if s.status = 'pending' and exists (
       select 1 from public.billing_invoices i
        where i.subscription_id = p_sub and i.kind = 'period' and i.deleted_at is null
          and i.status = 'paid' and i.period_start = s.current_period_start
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
  if v_open = 0
     and s.current_period_end is not null and s.current_period_end >= current_date
     and exists (
       select 1 from public.billing_invoices i
        where i.subscription_id = s.id and i.kind = 'period' and i.deleted_at is null
          and i.status = 'paid' and i.period_start = s.current_period_start
     ) then
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

create or replace function app.claim_billing_charge(
  p_invoice uuid, p_ref text, p_kind billing_attempt_kind, p_amount bigint
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_farm uuid; v_sub uuid; v_pm uuid; v_n integer; v_owed bigint;
begin
  select i.farm_id, i.subscription_id, s.default_payment_method_id,
         i.total_incl_cents - i.amount_paid_cents
    into v_farm, v_sub, v_pm, v_owed
    from public.billing_invoices i
    left join public.billing_subscriptions s on s.id = i.subscription_id
   where i.id = p_invoice and i.deleted_at is null
   for update of i;

  if v_farm is null then
    return null;
  end if;

  -- Never more than is owed NOW (20261029150000), read under the row lock above. Checkout
  -- reads the outstanding and claims a moment later; an EFT recorded by hand in between
  -- (app.billing_record_manual_payment takes the same lock) left the claim at the old
  -- amount, and the customer was sent to Paystack to pay what had already arrived. The
  -- caller reads the invoice again.
  if p_amount > v_owed then
    raise exception 'BILLING: the amount owed has changed' using errcode = '22023';
  end if;

  select count(*)::integer + 1 into v_n
    from public.billing_payment_attempts where invoice_id = p_invoice;

  begin
    insert into public.billing_payment_attempts (
      farm_id, invoice_id, subscription_id, payment_method_id,
      attempt_ref, kind, status, attempt_number, amount_incl_cents
    ) values (
      v_farm, p_invoice, v_sub, v_pm,
      p_ref, p_kind, 'pending', v_n, p_amount
    ) returning id into v_id;
  exception when unique_violation then
    -- Either another worker is mid-charge on this invoice, or this exact reference has
    -- been used. Both mean: not ours.
    return null;
  end;

  return v_id;
end $$;
revoke execute on function app.claim_billing_charge(uuid, text, billing_attempt_kind, bigint)
  from public, anon, authenticated;
