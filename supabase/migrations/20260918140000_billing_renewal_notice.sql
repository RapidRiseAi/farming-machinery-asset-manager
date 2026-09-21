-- 20260918140000_billing_renewal_notice.sql
-- Telling a farm BEFORE the money comes off, not only after it fails to.
--
-- `app.enqueue_billing_reminders` fires on `past_due`, `grace` and `downgraded`. Every one
-- of those is a message about something that has already gone wrong. Nothing in this
-- product has ever said "R2 500 comes off your card on Friday", the first a customer
-- hears about a renewal is the receipt, or the decline.
--
-- WHY THIS MATTERS MORE ON THIS PRODUCT THAN MOST
-- =============================================================================
-- Annual is ten months' list price charged in one go. A Done-For-You farm with twenty
-- vehicles is R50 000 leaving a bank account with no warning. A farmer who has forgotten
-- the renewal date reads that as a fraudulent deduction, and the path from there is a
-- chargeback and a dispute we then have 48 business hours to answer, the most expensive
-- possible outcome of a payment that was entirely legitimate.
--
-- The Consumer Protection Act §14 also expects notice before a fixed-term agreement
-- renews, for consumers and small juristic persons. This is not the whole of §14
-- compliance and is not offered as legal advice, but a product that renews annually and
-- gives no advance notice at all is on the wrong side of the question.
--
-- WHEN
-- =============================================================================
-- Monthly: 3 days. Enough to move money across, not so far ahead that it is forgotten.
-- Annual:  14 days. A larger amount deserves a fortnight, and it is the notice somebody
--          needs in order to cancel before being charged rather than after.
--
-- The two windows live in `billing_settings` alongside the other nine dunning values, so
-- changing one stays a decision somebody makes and the audit log records.
--
-- WHAT IT DOES NOT DO
-- =============================================================================
-- It does not charge, hold, schedule or alter anything. It queues one in-app notification
-- per farm per period, and the existing delivery layer takes it from there. A farm that
-- has cancelled, lapsed, or has no price is silent, being reminded of a renewal that is
-- not going to happen is worse than saying nothing.

alter table public.billing_settings
  add column if not exists renewal_notice_days_monthly smallint not null default 3,
  add column if not exists renewal_notice_days_annual  smallint not null default 14;

alter table public.billing_settings
  drop constraint if exists billing_settings_renewal_notice_ck;
alter table public.billing_settings
  add constraint billing_settings_renewal_notice_ck check (
    renewal_notice_days_monthly between 0 and 30
    and renewal_notice_days_annual between 0 and 90
  );

comment on column public.billing_settings.renewal_notice_days_monthly is
  'How many days before a MONTHLY renewal the farm is told. 0 disables the notice.';
comment on column public.billing_settings.renewal_notice_days_annual is
  'How many days before an ANNUAL renewal the farm is told. Longer than monthly because '
  'the amount is ten months of list price in one deduction.';

-- ══════════════════════════════════════════════════════════════════════════════
-- Queue them
-- ══════════════════════════════════════════════════════════════════════════════
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

    -- Priced from the same catalogue the invoice will be raised from, and SILENT if there
    -- is no active price. Quoting a figure here that the generator will not produce would
    -- be worse than saying nothing at all, this message exists to make the deduction
    -- recognisable, so a wrong number defeats its whole purpose.
    select * into v_price
      from public.billing_price_versions p
     where p.plan = s.plan and p.billing_period = s.billing_period and p.status = 'active'
       and (p.effective_from is null or p.effective_from <= current_date)
       and (p.effective_to   is null or p.effective_to   >= current_date)
     limit 1;
    continue when not found or v_price.per_vehicle_monthly_incl_cents is null;

    -- `coalesce(quota, counted)`, the same rule app.billing_billable_units applies, so
    -- the warned amount and the invoiced amount agree.
    v_units  := app.billing_billable_units(s.id);
    v_amount := v_price.per_vehicle_monthly_incl_cents::bigint
                  * greatest(v_units, 0) * v_price.months_charged;
    continue when v_amount <= 0;

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
        'due_on',        v_due,
        'amount_cents',  v_amount,
        'plan',          s.plan,
        'billing_period', s.billing_period,
        'units',         v_units
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;

-- Revoked from everyone, and deliberately NOT granted to service_role either. Every engine
-- function in `app` is reached through its `public.cron_*` wrapper, which is SECURITY
-- DEFINER and therefore runs as the owner, so the wrapper does not need the caller to
-- hold EXECUTE on what it calls. Suite section (j) enforces this and caught a direct grant
-- here on the first run.
revoke execute on function app.enqueue_billing_renewal_notices() from public, anon, authenticated;

-- The public wrapper the cron route calls. PostgREST exposes `public` only.
create or replace function public.cron_enqueue_billing_renewal_notices() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.enqueue_billing_renewal_notices();
$$;

revoke execute on function public.cron_enqueue_billing_renewal_notices()
  from public, anon, authenticated;
grant  execute on function public.cron_enqueue_billing_renewal_notices() to service_role;
