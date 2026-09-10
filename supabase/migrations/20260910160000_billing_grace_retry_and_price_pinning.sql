-- 20260910160000_billing_grace_retry_and_price_pinning.sql
-- Two founder decisions taken on 2026-09-10, and the code that had quietly assumed the
-- opposite of both.
--
-- 1. GRACE IS RETRIED, WEEKLY
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.billing_register_failure` set next_retry_on = null when the retry ladder ran out,
-- and `app.due_billing_charges` only ever looked at 'active' and 'past_due'. So from the
-- moment a farm entered grace, nothing presented the card again — not that night, not the
-- next week, not ever. The farm sat out its grace days in silence and was downgraded.
--
-- The commonest reason a card fails on a South African farm is that the money arrives
-- next week. A card that failed on the 1st very often works on the 25th. Weekly is the
-- cadence: often enough to catch payday, gentle enough that a card network does not read
-- it as the retry-storm pattern issuers penalise.
--
-- `grace_retry_days` joins the other nine values in the single audited `billing_settings`
-- row, so changing it is a decision somebody makes and the audit log records. Setting it
-- to 0 restores the old behaviour exactly, and that is why the grace arm of the shortlist
-- tests `next_retry_on is not null` rather than coalescing: in grace, a null date means
-- the retry is switched off, and must never read as "charge now".
--
-- Grace is NOT extended by a retry. `grace_ends_on` is still coalesced onto whatever was
-- set when grace began, so the downgrade lands on the day it always would have.
--
-- 2. A PRICE RISE DOES NOT REPRICE EXISTING CUSTOMERS
-- ─────────────────────────────────────────────────────────────────────────────
-- The generator resolved its price with `app.billing_active_price(plan, period)` — the
-- version that is active TODAY. `billing_price_versions_active_uq` permits exactly one
-- active row per (plan, period), so activating a new price necessarily retires the old
-- one, and every existing farm's next invoice would have been raised at the new figure.
-- Silently: no notice, no email, no decision recorded anywhere. A farmer's debit order
-- would simply go up.
--
-- `billing_subscriptions.price_version_label` was already being written and read by
-- nothing, which is the shape of a half-built intention. This finishes it with an id.
--
-- Founder decision: a farm keeps the price it signed up at until somebody deliberately
-- moves it. So:
--
--   * the first invoice PINS the version onto the subscription, and a farm that predates
--     this migration is read from its own most recent invoice instead — so nobody is
--     grandfathered onto a price they were never charged, and no backfill can go stale;
--   * every later invoice uses the pinned version, active or retired — a retired price
--     is exactly what a grandfathered customer is still paying, so status is not
--     consulted for a pin;
--   * the pin is ignored when it no longer fits, which is only when the farm has changed
--     plan or billing period, and the current active version is used and re-pinned;
--   * a farm is deliberately moved by SETTING `price_version_id` to the new version —
--     naming it, so the change is a decision with a value attached rather than an
--     absence. CLEARING it does not reprice anybody: their own invoices still say what
--     they have been paying, which is the point of fallback 2.
--
-- The UI for that deliberate move belongs with the plan-change work, not here. What this
-- migration buys on its own is protective and needs no UI at all: a price rise can now be
-- published without silently repricing anybody.
--
-- Suite section (s) covers both, mutation-tested.

alter table public.billing_settings
  add column if not exists grace_retry_days integer not null default 7;
alter table public.billing_settings
  drop constraint if exists billing_settings_grace_retry_ck;
alter table public.billing_settings
  add constraint billing_settings_grace_retry_ck check (grace_retry_days >= 0);

comment on column public.billing_settings.grace_retry_days is
  'Days between card retries while a subscription is in GRACE. 0 switches grace retries '
  'off entirely, restoring the pre-2026-09-10 behaviour. Grace itself is not extended by '
  'a retry: grace_ends_on is set once, when grace begins.';

alter table public.billing_subscriptions
  add column if not exists price_version_id uuid references public.billing_price_versions (id);

comment on column public.billing_subscriptions.price_version_id is
  'The price version this farm is GRANDFATHERED onto. Pinned by the first invoice and '
  'honoured by every later one even after that version is retired — a retired price is '
  'what a grandfathered customer is still paying. Ignored when it no longer matches the '
  'subscription plan/period (i.e. after a plan change). Clear it to move the farm onto '
  'current pricing deliberately.';


-- ══════════════════════════════════════════════════════════════════════════════
-- The price this subscription is entitled to be charged
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns the same composite as app.billing_active_price, so every caller is unchanged.
create or replace function app.billing_price_for_subscription(p_sub uuid)
returns billing_price_versions
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(pinned.v, invoiced.v, active.v)
    from (select 1) one
    -- 1. The explicit pin, written by the first invoice this subscription ever raised.
    left join lateral (
      select pv as v from public.billing_price_versions pv
       join public.billing_subscriptions s on s.id = p_sub
      where pv.id = s.price_version_id
        and pv.deleted_at is null
        -- The ONE thing that invalidates a pin: the farm is no longer on that plan or that
        -- term. A pinned professional/monthly price is simply wrong for a farm that has
        -- moved to complete/annual, and silently charging it would be worse than repricing.
        --
        -- Note what is NOT tested here: pv.status. A grandfathered customer is by
        -- definition still on a version that has since been retired.
        and pv.plan = s.plan
        and pv.billing_period = s.billing_period
      limit 1
    ) pinned on true
    -- 2. What they have ACTUALLY been paying. Every farm that existed before this
    --    migration has a null pin, and pinning them at their next invoice would grandfather
    --    them onto whatever is active THEN — so a price rise published tomorrow would still
    --    reach every existing customer exactly once, which is the whole thing this is meant
    --    to prevent. Their real price is already recorded, on their own last invoice.
    --
    --    This also means no data backfill is needed, and none can go stale: the answer is
    --    derived from the ledger rather than copied out of it.
    left join lateral (
      select pv as v
        from public.billing_invoices i
        join public.billing_price_versions pv on pv.id = i.price_version_id
        join public.billing_subscriptions s on s.id = p_sub
       where i.subscription_id = p_sub
         and i.deleted_at is null
         and i.status <> 'void'
         and pv.deleted_at is null
         and pv.plan = s.plan
         and pv.billing_period = s.billing_period
       order by i.period_start desc, i.created_at desc
       limit 1
    ) invoiced on true
    -- 3. A genuinely new customer pays today's price.
    left join lateral (
      select app.billing_active_price(s.plan, s.billing_period) as v
        from public.billing_subscriptions s where s.id = p_sub
    ) active on true;
$$;
revoke execute on function app.billing_price_for_subscription(uuid) from public, anon;
grant  execute on function app.billing_price_for_subscription(uuid) to authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- The generator, using the pinned price. Body extracted from 20260910140000.
-- ══════════════════════════════════════════════════════════════════════════════
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
       and status in ('active', 'past_due', 'trialing', 'non_renewing')
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
    -- CURRENTLY active version — so activating a new price silently moved every existing
    -- customer onto it at their next invoice, with no notice and no decision. Founder
    -- decision: a farm keeps the price it signed up at until somebody deliberately moves
    -- it. app.billing_price_for_subscription honours the pin and falls back to the active
    -- version when there is none, or when the pin no longer fits the plan they are on.
    select * into v_price from app.billing_price_for_subscription(s.id);
    if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
      continue;   -- no confirmed price, or price-on-application: never auto-bill
    end if;

    v_count := app.billable_asset_count(s.farm_id);
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
        -- An invoice is a draft while it is being assembled — that is what the word
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
      'FleetWise ' || s.plan::text || ' — ' || v_count::text || ' vehicle(s)',
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


-- ══════════════════════════════════════════════════════════════════════════════
-- The shortlist, now admitting a farm in grace on the day its retry falls due
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.due_billing_charges(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid,
  payment_method_id uuid, amount_incl_cents bigint, invoice_ref text,
  attempt_number integer
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
    -- however correct the underlying debt is. A SUSPENDED farm still is — suspension
    -- withholds the service, it does not forgive what is already invoiced.
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
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
     -- this list at all — so the stored card was never presented again by anything, and a
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
     )
     -- Nothing in flight. A row in `unknown` deliberately blocks this farm entirely
     -- until somebody has reconciled it.
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;

revoke execute on function app.due_billing_charges(integer) from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Exhausting the ladder arms the weekly grace retry instead of stopping for good
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.billing_register_failure(p_sub uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v public.billing_settings%rowtype;
        v_n integer; v_offset integer;
begin
  select * into v from public.billing_settings where singleton;
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  v_n := s.failed_attempt_count + 1;

  if v_n <= array_length(v.retry_offsets_days, 1) then
    v_offset := v.retry_offsets_days[v_n];
    update public.billing_subscriptions
       set status = 'past_due',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = current_date + v_offset,
           grace_ends_on = null,
           updated_at = now()
     where id = p_sub;
  else
    -- Retries exhausted. Access continues for the grace period — and, since 20260910160000,
    -- so does asking. The card is presented again every `grace_retry_days`, because the
    -- commonest reason one fails here is that the money arrives next week.
    --
    -- `grace_ends_on` is still coalesced, so a farm that fails three grace retries does not
    -- earn itself three extra weeks: the downgrade lands on the day grace began + grace_days.
    update public.billing_subscriptions
       set status = 'grace',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = case when v.grace_retry_days > 0
                                then current_date + v.grace_retry_days
                                else null end,
           grace_ends_on = coalesce(grace_ends_on, current_date + v.grace_days),
           updated_at = now()
     where id = p_sub;
  end if;
end $$;
revoke execute on function app.billing_register_failure(uuid, text) from public, anon, authenticated;
