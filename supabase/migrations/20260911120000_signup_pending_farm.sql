-- 20260911120000_signup_pending_farm.sql
-- The front door: everything a self-serve sign-up writes, in one transaction.
--
-- WHY ONE FUNCTION AND NOT FOUR CALLS
-- ─────────────────────────────────────────────────────────────────────────────
-- A sign-up creates a farm, an owner, a subscription and its first invoice. Done as four
-- round trips from a server action, any failure after the second leaves a farm with no
-- owner, or an owner who cannot be invoiced, and no transaction to roll back — the exact
-- shape docs/SIGNUP_AND_QUOTA_BILLING.md §2 is written to avoid on the money side.
--
-- So it is one SECURITY DEFINER function and one transaction. The only thing that cannot
-- be inside it is the `auth.users` row, because that is Supabase's Auth API rather than a
-- table this schema may write. The caller therefore creates the auth user FIRST and
-- deletes it if this function raises — stated in the action, and the only ordering that
-- leaves no orphan either way.
--
-- THE INVOICE IS RAISED HERE, NOT BY THE NIGHTLY CRON
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.generate_billing_invoices` did not consider `pending` at all, so a new sign-up had
-- nothing to pay and `beginCheckout` would have refused it. Adding `pending` to the status
-- list alone would have been worse than leaving it out: the nightly pass would then raise
-- an invoice a month, for ever, against every abandoned sign-up — farms nobody can log
-- into, quietly accruing paper.
--
-- So the arm is narrow and says so: a pending subscription is invoiced once, ever, and
-- never again while it stays pending. Paying is what moves it to `active`
-- (`app.billing_restore_after_payment`, reached from `settle_billing_attempt`), and from
-- that moment it bills on the ordinary schedule like everybody else.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- It does not decide the price. The quota and the plan come in; the amount comes from
-- `app.billing_price_for_subscription` inside the generator, which is the same path every
-- renewal takes. A sign-up screen quoting one figure while the invoice says another is
-- the failure that makes people stop trusting a bill, so there is exactly one source.
--
-- It does not grant access. The subscription is `pending` and `app.farm_billing_gate`
-- (20260911100000) keeps the farm shut until the money arrives.
--
-- Suite section (x) covers it, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- Everything a sign-up writes, atomically
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.create_pending_signup(
  p_user      uuid,     -- already created in auth.users by the caller
  p_email     text,
  p_name      text,     -- the person
  p_farm_name text,
  p_plan      farm_plan,
  p_period    billing_period,
  p_quota     integer
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm  uuid;
  v_sub   uuid;
  v_price public.billing_price_versions%rowtype;
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
    extract(day from current_date)::integer, p_quota, p_user
  )
  returning id into v_sub;

  -- The invoice they are about to pay. Inside the same transaction, so a sign-up either
  -- produces a farm with something to pay or produces nothing at all.
  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'SIGNUP: could not raise the first invoice' using errcode = 'check_violation';
  end if;

  return v_sub;
end $$;
revoke execute on function app.create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer)
  from public, anon, authenticated;

comment on function app.create_pending_signup(uuid, text, text, text, farm_plan, billing_period, integer) is
  'Self-serve sign-up, in one transaction: farm, owner, pending subscription and the first '
  'invoice. The auth.users row is the caller''s job and must be created FIRST and removed '
  'if this raises. Grants no access — app.farm_billing_gate keeps the farm shut until the '
  'invoice is paid.';

create or replace function public.billing_create_pending_signup(
  p_user      uuid,
  p_email     text,
  p_name      text,
  p_farm_name text,
  p_plan      farm_plan,
  p_period    billing_period,
  p_quota     integer
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.create_pending_signup(p_user, p_email, p_name, p_farm_name,
                                   p_plan, p_period, p_quota);
$$;
-- service_role ONLY. The sign-up route runs with the service key because an anonymous
-- visitor has no database access at all in this product, and a wrapper a browser could
-- call would let anybody mint farms and owners.
revoke execute on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer)
  from public, anon, authenticated;
grant  execute on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer) to service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- The generator, invoicing a pending sign-up exactly once
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
    -- CURRENTLY active version — so activating a new price silently moved every existing
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
