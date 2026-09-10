-- 20260910230000_billing_asset_quota.sql
-- Farms buy a number of vehicle slots. Until now the product counted them instead.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.billable_asset_count` counts machines that are not deleted, retired or sold, and
-- the invoice is that number times the per-vehicle price. So the bill moved on its own:
-- add a bakkie in March and March costs R73 more, with nobody having agreed to it and
-- nothing on any screen having offered the choice.
--
-- The founder's model is a QUOTA — "how many vehicles?" is answered at sign-up, the price
-- is shown against that number, and that number is what is charged. The counted figure
-- does not disappear; it becomes "you are using 7 of 10" and the thing the ceiling is
-- measured against.
--
-- COMPATIBILITY IS THE WHOLE RISK HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- A NULL `asset_quota` means "no quota — bill what you count", which is exactly today's
-- behaviour. Every subscription that exists when this ships has one, so nothing about
-- anybody's bill moves on the night it lands. Same discipline as the price pin in
-- 20260910160000: a change to how money is calculated must not restate anybody silently.
--
-- The ceiling follows the same rule. No quota means no ceiling, so no existing farm
-- suddenly cannot add a vehicle.
--
-- WHERE THE CEILING IS ENFORCED, AND WHY IT IS A TRIGGER
-- ─────────────────────────────────────────────────────────────────────────────
-- docs/SIGNUP_AND_QUOTA_BILLING.md §4 lists three ways a machine is created today —
-- `createMachine`, `importMachines` (CSV) and `syncClientVehicles` (a CONTRACTOR copying
-- their notebook into the farm's fleet). Checking in all three actions has two problems: a
-- fourth path added later silently has no ceiling, and check-then-insert races itself when
-- two tabs add the eleventh vehicle at the same moment.
--
-- So the guarantee is a BEFORE trigger on `machines`. It covers every path that exists and
-- every path anybody adds, it cannot be raced, and it makes the limit a property of the
-- database rather than of whoever remembered to check. The server actions keep a
-- pre-check on top of it, because a trigger gives a correct refusal and a poor sentence —
-- the same two-lock shape this codebase uses for the VAT guard and the freeze.
--
-- CSV import gets all-or-nothing for free: the trigger aborts the transaction, so 50 rows
-- into 10 free slots writes nothing. A partial import that stopped at the limit would
-- leave a farmer believing their fleet was loaded when it was not, which is worse than a
-- clean refusal.
--
-- An UPDATE is covered too, for the one case that is really an addition: bringing a
-- retired or sold machine back into service grows the billable fleet exactly as an insert
-- does.
--
-- Suite section (v) covers all of it, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- The quota
-- ══════════════════════════════════════════════════════════════════════════════
alter table public.billing_subscriptions
  add column if not exists asset_quota integer;
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_quota_ck;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_quota_ck check (asset_quota is null or asset_quota > 0);

comment on column public.billing_subscriptions.asset_quota is
  'Vehicle slots BOUGHT. This is what is invoiced, and the ceiling new vehicles are '
  'checked against. NULL means no quota was ever chosen: the subscription is metered on '
  'app.billable_asset_count and has no ceiling, which is how every subscription created '
  'before 20260910230000 behaves and must keep behaving.';


-- What this subscription is billed for, and what its ceiling is.
create or replace function app.billing_billable_units(p_sub uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(s.asset_quota, app.billable_asset_count(s.farm_id))
    from public.billing_subscriptions s
   where s.id = p_sub and s.deleted_at is null;
$$;
revoke execute on function app.billing_billable_units(uuid) from public, anon, authenticated;
grant  execute on function app.billing_billable_units(uuid) to service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- "You are using 7 of 10" — one answer, for the screen and for the ceiling
-- ══════════════════════════════════════════════════════════════════════════════
-- Deliberately readable by a signed-in user: it is their own farm's allowance, it carries
-- no money and no credential, and the alternative is the screen and the guard computing
-- the same thing separately and eventually disagreeing.
--
-- `enforced` is the field that matters to a caller. False means this farm has no quota, so
-- there is nothing to refuse and `remaining` is meaningless — a caller that treated
-- `remaining <= 0` as "blocked" without reading it would lock out every grandfathered farm.
create or replace function app.farm_vehicle_allowance(p_farm uuid)
returns table (enforced boolean, quota integer, used integer, remaining integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    s.asset_quota is not null,
    s.asset_quota,
    app.billable_asset_count(p_farm),
    case when s.asset_quota is null then null
         else greatest(s.asset_quota - app.billable_asset_count(p_farm), 0) end
  from public.billing_subscriptions s
  where s.farm_id = p_farm and s.deleted_at is null
  union all
  -- No subscription row at all: grandfathered, and every admin-created farm. Not enforced.
  select false, null::integer, app.billable_asset_count(p_farm), null::integer
  where not exists (
    select 1 from public.billing_subscriptions s2
     where s2.farm_id = p_farm and s2.deleted_at is null
  )
  limit 1;
$$;
revoke execute on function app.farm_vehicle_allowance(uuid) from public, anon;
grant  execute on function app.farm_vehicle_allowance(uuid) to authenticated, service_role;

create or replace function public.farm_vehicle_allowance(p_farm uuid)
returns table (enforced boolean, quota integer, used integer, remaining integer)
language sql stable security definer set search_path = public, pg_temp as $$
  -- Answering about a farm you cannot reach would turn this into a fleet-size oracle for
  -- anybody with a farm id, so the wrapper asks the question the caller is entitled to ask.
  select * from app.farm_vehicle_allowance(p_farm) where app.has_farm_access(p_farm);
$$;
revoke execute on function public.farm_vehicle_allowance(uuid) from public, anon;
grant  execute on function public.farm_vehicle_allowance(uuid) to authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- The ceiling itself
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.billing_enforce_vehicle_quota() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_quota integer; v_used integer; v_farm uuid;
begin
  v_farm := new.farm_id;

  -- Only a row that will actually be BILLED counts. Filing a machine that is already
  -- retired or sold, or arriving soft-deleted, adds nothing to the fleet and must not be
  -- refused — app.billable_asset_count excludes exactly these.
  if new.deleted_at is not null or new.status in ('retired', 'sold') then
    return new;
  end if;

  -- On an update, only the transition INTO the billable set is an addition. Editing the
  -- name of a machine on a farm that is already at its ceiling must not fail.
  if tg_op = 'UPDATE'
     and old.farm_id = new.farm_id
     and old.deleted_at is null
     and old.status not in ('retired', 'sold') then
    return new;
  end if;

  select s.asset_quota into v_quota
    from public.billing_subscriptions s
   where s.farm_id = v_farm and s.deleted_at is null
   limit 1;

  -- No quota, no ceiling. Grandfathered farms and admin-created farms live here, and this
  -- is the branch that stops this migration locking anybody out on the day it ships.
  if v_quota is null then
    return new;
  end if;

  v_used := app.billable_asset_count(v_farm);
  if v_used >= v_quota then
    raise exception
      'BILLING: vehicle limit reached — % of % slots are in use', v_used, v_quota
      using errcode = 'check_violation',
            hint = 'Add more slots on the billing screen, or retire a vehicle first.';
  end if;

  return new;
end $$;
revoke execute on function app.billing_enforce_vehicle_quota() from public, anon, authenticated;

-- BEFORE, so nothing is written when it refuses. Named to sort ahead of the existing
-- after-triggers; it has no ordering relationship with them, but a reader looking at
-- \dS machines should meet the refusal before the bookkeeping.
drop trigger if exists a_billing_vehicle_quota on public.machines;
create trigger a_billing_vehicle_quota
  before insert or update on public.machines
  for each row execute function app.billing_enforce_vehicle_quota();


-- ══════════════════════════════════════════════════════════════════════════════
-- The generator, billing the quota. Body extracted from 20260910160000.
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
