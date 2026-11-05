-- 20261105100000_staff_onboarding.sql
-- Rapid Rise sets a quoted customer up (launch tracker "Staff onboarding and payment links").
--
-- The website sells by quotation, so the first customers are set up by Rapid Rise, not by
-- the public sign-up form. Until now that took three separate screens and started a TRIAL
-- (start_billing_subscription), while the founder's decision is no trial: pay first. This
-- opens the customer exactly as the sign-up form does: a PENDING subscription holding the
-- slots they agreed (at least the plan minimum) and its first invoice, raised now. The
-- owner is invited by the action; signing in, the gate takes them to /activate to pay by
-- card, or they pay by EFT using the details below and Rapid Rise records the payment.
--
-- * billing_settings.eft_instructions: Rapid Rise's banking details as they should be
--   shown, readable by farm users (it appears on /activate beside the invoice reference).
-- * billing_subscriptions.opened_by_staff: the dormant sign-up sweep skips these. A quoted
--   customer paying on terms is not a dormant sign-up.

alter table public.billing_settings add column if not exists eft_instructions text;
alter table public.billing_settings drop constraint if exists billing_settings_eft_len_ck;
alter table public.billing_settings
  add constraint billing_settings_eft_len_ck check (eft_instructions is null or length(eft_instructions) <= 1000);
grant select (eft_instructions) on public.billing_settings to authenticated;
comment on column public.billing_settings.eft_instructions is
  'Rapid Rise''s EFT banking details as shown to customers on /activate (20261105100000). Null = not offered.';

alter table public.billing_subscriptions add column if not exists opened_by_staff boolean not null default false;
comment on column public.billing_subscriptions.opened_by_staff is
  'Opened by Rapid Rise for a quoted customer (20261105100000); never swept as a dormant sign-up.';

create or replace function app.admin_open_subscription(
  p_farm uuid, p_plan farm_plan, p_period billing_period, p_quota integer, p_by uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_price  public.billing_price_versions%rowtype;
  v_sub    uuid;
  v_quota  integer;
  v_exempt boolean;
begin
  -- Called with the service key after the action's own staff check; the staff member is
  -- named again here, so the row records who opened it and nobody else can.
  if not exists (select 1 from public.users u
                  where u.id = p_by and u.role = 'rr_admin' and u.active and u.deleted_at is null) then
    raise exception 'BILLING: only Rapid Rise staff open a subscription this way' using errcode = '42501';
  end if;
  if not exists (select 1 from public.farms where id = p_farm and deleted_at is null) then
    raise exception 'BILLING: no such farm %', p_farm;
  end if;
  if exists (select 1 from public.billing_subscriptions where farm_id = p_farm and deleted_at is null) then
    raise exception 'BILLING: farm % already has a subscription', p_farm using errcode = 'unique_violation';
  end if;
  if p_quota is null or p_quota < 1 then
    raise exception 'BILLING: choose at least one vehicle slot' using errcode = 'check_violation';
  end if;

  -- Never an invented price: Done-For-You has none (it is quoted), and neither does an
  -- unseeded plan. Those are set up as agreements, not from the price list.
  select * into v_price from app.billing_active_price(p_plan, p_period);
  if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
    raise exception 'BILLING: that plan has no list price to open at' using errcode = 'check_violation';
  end if;
  v_quota := greatest(p_quota, coalesce(v_price.min_billed_slots, 0));

  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on,
    anchor_day, asset_quota, created_by, opened_by_staff
  ) values (
    p_farm, p_plan, p_period, 'pending',
    null, null, current_date,
    extract(day from current_date)::integer, v_quota, p_by, true
  )
  returning id into v_sub;

  -- The effective plan follows the commercial one (the plan guard allows it now that the
  -- subscription names this plan).
  update public.farms
     set plan = p_plan, billing_period = p_period
   where id = p_farm and (plan is distinct from p_plan or billing_period is distinct from p_period);

  -- The first invoice, now. An exempt (test) farm is never invoiced.
  select f.billing_exempt into v_exempt from public.farms f where f.id = p_farm;
  if not coalesce(v_exempt, false) and app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'BILLING: could not raise the first invoice' using errcode = 'check_violation';
  end if;
  return v_sub;
end $$;
revoke execute on function app.admin_open_subscription(uuid, farm_plan, billing_period, integer, uuid) from public, anon, authenticated;

-- PostgREST exposes public only; the same service-role-only wrapper as the other billing calls.
create or replace function public.billing_admin_open_subscription(
  p_farm uuid, p_plan farm_plan, p_period billing_period, p_quota integer, p_by uuid
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.admin_open_subscription(p_farm, p_plan, p_period, p_quota, p_by);
$$;
revoke execute on function public.billing_admin_open_subscription(uuid, farm_plan, billing_period, integer, uuid) from public, anon, authenticated;
grant execute on function public.billing_admin_open_subscription(uuid, farm_plan, billing_period, integer, uuid) to service_role;

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
       -- Never one Rapid Rise opened for a customer (20261105100000): it is a quoted
       -- agreement that may be paid by EFT on terms, not a stranger who walked away from
       -- the sign-up form, and sweeping it deleted the customer's farm and people.
       and not opened_by_staff
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
