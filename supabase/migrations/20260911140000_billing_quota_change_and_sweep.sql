-- 20260911140000_billing_quota_change_and_sweep.sql
-- Buying more vehicle slots, giving some back, and clearing up after the people who
-- started a sign-up and never paid.
--
-- BUYING MORE SLOTS IS AN UPGRADE, AND IS PRICED LIKE ONE
-- ─────────────────────────────────────────────────────────────────────────────
-- 20260910230000 made the quota the thing that is billed, and 20260910230000's ceiling
-- makes it the thing that stops you adding a vehicle. What neither did was let anybody
-- change it. A farm that buys a bakkie in March has exactly two options today: be refused,
-- or ring Rapid Rise.
--
-- The founder's rule for a mid-cycle PLAN upgrade was "charge the pro-rata difference
-- immediately", and buying slots is the same act with a different noun, so it gets the same
-- answer and — deliberately — the same arithmetic. `app.billing_quota_change_quote` is
-- `app.billing_plan_change_quote` with the delta on the COUNT instead of the RATE:
-- inclusive of today, per slot, rounded before it is multiplied so the invoice's own
-- `unit_price × asset_count × months` agrees to the cent.
--
-- GIVING SLOTS BACK WAITS FOR THE PERIOD THEY PAID FOR
-- ─────────────────────────────────────────────────────────────────────────────
-- Same rule as a plan downgrade, same reason: they bought the period. It is scheduled onto
-- `pending_quota` and applied by the pass that already applies pending plans, so there is
-- one place where "a change that was waiting happens" lives.
--
-- And a reduction BELOW what they are using is refused outright. Ten vehicles on file
-- cannot become a seven-slot subscription without deleting three real assets, and nothing
-- in this product deletes a farmer's records to make a billing change work. They are told
-- what to retire first.
--
-- THE SWEEP
-- ─────────────────────────────────────────────────────────────────────────────
-- Self-serve sign-up creates the farm before the money moves, which means an abandoned
-- checkout leaves a farm nobody can log into. That was the right trade — the alternative
-- loses payments — but the rows should not sit there for ever.
--
-- What the sweep does NOT do is delete the `auth.users` row, and that is deliberate. This
-- schema does not own Supabase's auth tables, a hard delete there cascades into
-- `public.users`, and a half-deleted person is a worse outcome than a dormant one. It
-- soft-deletes the farm, the profile and the subscription and VOIDS the invoice — nothing
-- is destroyed, which is the same promise the non-payment downgrade makes.
--
-- The consequence is that the address stays taken, so `signUp` checks for a LIVE profile
-- rather than for an auth user: somebody who abandoned a sign-up weeks ago can start again
-- with the same email and the existing auth user is reused.
--
-- Suite section (y) covers all of it, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- A slot purchase is not a plan change
-- ══════════════════════════════════════════════════════════════════════════════
-- `billing_invoices_proration_uq` is unique on (farm_id, period_start, period_end, plan)
-- for kind='proration', and for a PLAN upgrade that is right: two upgrades in one period
-- move to two different plans, while the same upgrade twice is refused as 'no_change'
-- before it reaches an insert.
--
-- A quota increase does not move the plan. So buying three slots in the morning and one
-- more in the afternoon produces the identical key, and the second purchase aborted on a
-- duplicate key with a raw Postgres error — found by suite section (y) on its first run,
-- exactly as (t) found the plan version of this a day earlier.
--
-- Slot purchases get their own kind. The plan index is untouched and still does its job,
-- and the invoice becomes self-describing: "more vehicles" reads differently on a
-- statement to "plan change".
--
-- The double-click guard is unchanged and does not need an index: `change_billing_quota`
-- takes `for update` on the subscription, and the target quota is ABSOLUTE rather than a
-- delta — a second press asking for the same 8 slots sees 8 and answers 'no_change'. A
-- second press asking for 9 is a different purchase, and allowing it is the whole point.
alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_ck;
alter table public.billing_invoices
  add constraint billing_invoices_kind_ck check (kind in ('period', 'proration', 'slots'));

comment on column public.billing_invoices.kind is
  'period = the ordinary bill for a billing period, and the thing '
  'billing_invoices_farm_period_uq protects from being raised twice. proration = the '
  'difference charged when a farm upgrades its PLAN mid-period (20260910180000). '
  'slots = vehicle slots bought mid-period (20260911140000), which does not move the plan '
  'and so cannot share the plan proration''s uniqueness.';


-- ══════════════════════════════════════════════════════════════════════════════
-- A quota change that is waiting for the period to end
-- ══════════════════════════════════════════════════════════════════════════════
alter table public.billing_subscriptions
  add column if not exists pending_quota      integer,
  add column if not exists pending_quota_on   date,
  add column if not exists pending_quota_set_at timestamptz;

alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_pending_quota_ck;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_pending_quota_ck check (
    (pending_quota is null and pending_quota_on is null and pending_quota_set_at is null)
    or (pending_quota > 0 and pending_quota_on is not null and pending_quota_set_at is not null)
  );

comment on column public.billing_subscriptions.pending_quota is
  'Vehicle slots a farm has asked to GIVE BACK, waiting for the period they already paid '
  'for to end. Buying more happens immediately and is pro-rated; giving back never is. '
  'Applied by app.apply_pending_plan_changes.';


-- ══════════════════════════════════════════════════════════════════════════════
-- What changing the number of slots would do, and cost
-- ══════════════════════════════════════════════════════════════════════════════
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
  -- necessarily the active version — see 20260910160000.
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
      when v_charge < 100 then 'less than R1,00 — below what the provider will process'
      else null
    end;
end $$;
revoke execute on function app.billing_quota_change_quote(uuid, integer)
  from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Change it
-- ══════════════════════════════════════════════════════════════════════════════
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

  select * into q from app.billing_quota_change_quote(p_sub, p_quota);

  if q.kind = 'no_change' then
    return jsonb_build_object('applied', 'no_change');
  end if;
  if q.kind = 'unavailable' then
    raise exception 'BILLING: %', q.reason using errcode = 'check_violation';
  end if;

  -- ── SCHEDULED: fewer vehicles, at period end ─────────────────────────────
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

  -- ── MORE SLOTS, NOW ──────────────────────────────────────────────────────
  update public.billing_subscriptions
     set asset_quota = p_quota,
         -- Asking for more cancels a reduction they had scheduled. Wanting more than the
         -- amount you asked to give up is unambiguous about which you meant.
         pending_quota        = null,
         pending_quota_on     = null,
         pending_quota_set_at = null,
         updated_at           = now()
   where id = p_sub;

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


-- ══════════════════════════════════════════════════════════════════════════════
-- One place where a change that was waiting happens
-- ══════════════════════════════════════════════════════════════════════════════
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

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
revoke execute on function app.apply_pending_plan_changes() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Clearing up after a sign-up nobody finished
-- ══════════════════════════════════════════════════════════════════════════════
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
       -- `billing_subscriptions.id`, NOT `s.id`. `s` is this loop's own record variable and
       -- is unbound while the query that FEEDS the loop is planned, so plpgsql substitutes
       -- NULL, `i.subscription_id = NULL` is never true, and the whole guard silently
       -- passes for everybody. Suite section (y) caught it by sweeping a sign-up that had
       -- paid.
       and not exists (
         select 1 from public.billing_payments p
           join public.billing_invoices i on i.id = p.invoice_id
          where i.subscription_id = billing_subscriptions.id and p.deleted_at is null
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

comment on function app.sweep_dormant_signups(integer) is
  'Soft-deletes farms whose sign-up was never paid for, after p_days. Deliberately does '
  'NOT touch auth.users: this schema does not own Supabase''s auth tables and a hard '
  'delete there cascades into public.users. The address therefore stays taken, which is '
  'why signUp looks for a LIVE profile rather than for an auth user.';

create or replace function public.cron_sweep_dormant_signups() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.sweep_dormant_signups(7);
$$;
revoke execute on function public.cron_sweep_dormant_signups() from public, anon, authenticated;
grant  execute on function public.cron_sweep_dormant_signups() to service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- The wrappers the app calls
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_quota_quote(p_sub uuid, p_quota integer)
returns table (
  kind             text,
  effective_on     date,
  current_quota    integer,
  new_quota        integer,
  in_use           integer,
  days_remaining   integer,
  days_in_period   integer,
  charge_now_cents bigint,
  reason           text
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.billing_quota_change_quote(p_sub, p_quota);
$$;
revoke execute on function public.billing_quota_quote(uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.billing_quota_quote(uuid, integer) to service_role;

create or replace function public.billing_change_quota(p_sub uuid, p_quota integer)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.change_billing_quota(p_sub, p_quota);
$$;
revoke execute on function public.billing_change_quota(uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.billing_change_quota(uuid, integer) to service_role;
