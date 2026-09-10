-- 20260910140000_billing_who_may_be_charged.sql
-- Three defects with one shape: the ledger decides who to charge without ever asking who
-- they are, or whether a person has asked to pay.
--
-- S5 — A PAYMENT RESURRECTED A CANCELLED SUBSCRIPTION
-- ─────────────────────────────────────────────────────────────────────────────
-- `setCancellation({immediate:true})` writes status='cancelled', cancel_at_period_end=false
-- and ended_on=today. `app.billing_restore_after_payment` then read only
-- `cancel_at_period_end` and wrote status='active' for anything else. So a payment landing
-- after an immediate cancellation put the farm straight back on a live subscription — with
-- `ended_on` sitting in the past — and it would be billed again the following month.
--
-- This is not exotic. It is precisely what happens when somebody cancels while a charge is
-- in flight: the reconciler resolves that attempt, settles it `succeeded`, and the restore
-- runs. The whole reason `unknown` exists is that a charge can be in flight for hours.
--
-- S7 — BILLING NEVER LOOKED AT THE FARM
-- ─────────────────────────────────────────────────────────────────────────────
-- Every condition in `app.generate_billing_invoices` and `app.due_billing_charges` is about
-- the SUBSCRIPTION row. `farms.deleted_at` and `farms.status` were read nowhere on the
-- charging path — `farms` was selected only to copy a name onto an invoice snapshot. A
-- soft-deleted farm, or one Rapid Rise had suspended or cancelled, kept being invoiced and
-- kept having its stored card charged.
--
-- S11 — "TRY AGAIN" TOLD A PAYING CUSTOMER NOTHING WAS DUE
-- ─────────────────────────────────────────────────────────────────────────────
-- `retryInvoiceCharge` rebuilds the automatic shortlist and looks for the invoice in it.
-- That shortlist carries `coalesce(next_retry_on, current_date) <= current_date` and
-- `status in ('active','past_due')`. So after a decline the owner's "Try again" button
-- answered "nothing is due" for the whole retry interval — while the invoice was plainly
-- unpaid and the farm was walking down the ladder towards a downgrade.
--
-- Worse, and not in the original finding: once retries are exhausted
-- `app.billing_register_failure` sets status='grace' with next_retry_on=null, and after
-- that `app.billing_apply_downgrades` sets status='downgraded'. NEITHER status is in the
-- shortlist. So from the moment a farm enters grace, the stored card is never presented
-- again — not by the nightly pass, and not by the customer pressing the button. The only
-- way back was to re-enter card details through hosted checkout.
--
-- The retry timer exists to stop the MACHINE hammering a card, which issuers penalise. A
-- person pressing a button is a different act, bounded by their patience rather than by a
-- cron. So the manual path gets its own function with its own conditions, rather than a
-- flag threaded through the automatic one where it could be set by accident.
--
-- What the manual path does NOT relax: the in-flight block. `app.claim_billing_charge` is
-- still the only way to take a charge, and `billing_payment_attempts_inflight_uq` still
-- permits exactly one attempt per invoice. "Just try it again" is the perfect way to
-- charge somebody twice, and it is refused here as firmly as anywhere else.
--
-- NOT CHANGED HERE, and put to the founder instead: whether the NIGHTLY pass should keep
-- trying the card during grace. It currently does not, which leaves money uncollected from
-- customers who are still using the product — but the dunning cadence is founder decision
-- #9 and changing it silently would be the wrong way round.
--
-- Suite section (r) covers all three, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- S7 — a farm that has left is not sold another month
-- ══════════════════════════════════════════════════════════════════════════════
-- The body below is EXTRACTED from 20260910120000 and patched at one anchor, not retyped.

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

    select * into v_price from app.billing_active_price(s.plan, s.billing_period);
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
           price_version_label  = coalesce(price_version_label, v_price.version_label),
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_billing_invoices(uuid) from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- S7 — and a farm that has left is not charged
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
     and s.status in ('active', 'past_due')
     and coalesce(s.next_retry_on, current_date) <= current_date
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
-- S11 — a person asking to pay is not a cron, and is not made to wait
-- ══════════════════════════════════════════════════════════════════════════════
-- Same row shape as app.due_billing_charges, so the worker can hand it to exactly the
-- same code. Three deliberate differences, and nothing else:
--
--   1. No retry window. The timer paces the machine; it must not refuse a human.
--   2. 'grace' and 'non_renewing' are included. A farm in grace pressing "Pay now" is the
--      most valuable button in this product, and a farm that cancelled at period end still
--      owes for the period they are in.
--   3. 'downgraded' is included. Otherwise the recovery the whole downgrade design
--      promises — pay, get your plan back, nothing was ever deleted — has no way to happen
--      with the card already on file.
--
-- Everything else is identical, on purpose. In particular the in-flight exclusion, the
-- reusable-card requirement and the outstanding-amount check are all still here.
create or replace function app.invoice_chargeable_now(p_invoice uuid)
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
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.id = p_invoice
     and i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and s.status in ('active', 'past_due', 'grace', 'non_renewing', 'downgraded')
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     );
$$;
revoke execute on function app.invoice_chargeable_now(uuid) from public, anon, authenticated;

create or replace function public.billing_invoice_chargeable_now(p_invoice uuid)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid,
  payment_method_id uuid, amount_incl_cents bigint, invoice_ref text,
  attempt_number integer
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.invoice_chargeable_now(p_invoice);
$$;
revoke execute on function public.billing_invoice_chargeable_now(uuid)
  from public, anon, authenticated;
grant  execute on function public.billing_invoice_chargeable_now(uuid) to service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- S5 — a payment never brings a cancelled subscription back to life
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.billing_restore_after_payment(p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype;
begin
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  -- ENDED. The money is still recorded and the invoice is still marked paid — that all
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
revoke execute on function app.billing_restore_after_payment(uuid) from public, anon, authenticated;
