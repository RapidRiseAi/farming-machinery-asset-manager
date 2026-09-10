-- 20260910180000_billing_plan_change.sql
-- Upgrading charged more and granted nothing. Downgrading charged less and took nothing away.
--
-- THE DEFECT (S3)
-- ─────────────────────────────────────────────────────────────────────────────
-- There are two plans on a farm, and that is deliberate and correct:
--
--   farms.plan                  the EFFECTIVE plan — every entitlement gate resolves
--                               from it, and the dunning downgrade writes it
--   billing_subscriptions.plan  the COMMERCIAL plan — what they bought and are billed for
--
-- They diverge on purpose while a farm is downgraded for non-payment, which is what lets
-- recovery restore the exact prior state instead of inferring it.
--
-- But there were two half-controls and no whole one:
--
--   /admin/farms/[id]  wrote farms.plan and nothing else   → features move, billing does not
--   /admin/billing     wrote billing_subscriptions.plan     → billing moves, features do not
--
-- So a farm upgraded through the billing screen paid Complete money and stayed gated at
-- Professional; one upgraded through the farm screen got Complete features for free; and a
-- downgrade through the billing screen reduced the bill while leaving every feature open.
-- There was also no self-serve path at all — an owner could not change their own plan.
--
-- `adminSetSubscriptionPlan` documented the split as intentional, and its reasoning was
-- right: an admin screen writing both would be the one place able to silently
-- un-downgrade a farm that has not paid. That concern is kept below rather than discarded
-- (see `plan_before_downgrade`), and the answer is a single function that moves both with
-- the rules attached, not two screens each moving one.
--
-- FOUNDER DECISIONS, 2026-09-10
-- ─────────────────────────────────────────────────────────────────────────────
--   UPGRADE   Charge the pro-rata difference NOW; features switch on immediately. The
--             customer gets what they paid for the moment they pay for it.
--   DOWNGRADE Takes effect at period end. They keep what they already paid for, there is
--             no refund and no credit note, and nothing has to be reversed.
--
-- WHAT COUNTS AS WHICH
-- ─────────────────────────────────────────────────────────────────────────────
-- Immediate-and-prorated applies to exactly one shape: the plan RANK goes up and the
-- billing period is unchanged. Everything else is scheduled for period end, including a
-- term change in either direction.
--
-- That is deliberate. A term is a commitment somebody has already paid for: switching a
-- farm mid-year from annual to monthly would need a refund, and switching monthly to
-- annual mid-month would charge for eleven months they have not agreed to yet. Scheduling
-- costs the customer nothing — they simply start the new term when the current one ends.
--
-- THE PRORATION
-- ─────────────────────────────────────────────────────────────────────────────
--     period value = per_vehicle_monthly_incl_cents × vehicles × months_charged
--     delta        = new period value − old period value
--     charged now  = delta × days remaining ÷ days in the period
--
-- Computed per VEHICLE and then multiplied, because that is the figure a customer checks
-- and because `app.billing_derive_invoice_totals` derives the total as
-- `unit_price × asset_count × months_charged` — so a unit price is the only place the
-- rounding can live without the invoice disagreeing with itself.
--
-- "Days remaining" includes today. Somebody upgrading this morning has the whole of today
-- on the new plan.
--
-- TWO CASES THAT DELIBERATELY CHARGE NOTHING
-- ─────────────────────────────────────────────────────────────────────────────
--   * A delta of zero or less. They are getting more for the same money or less; there is
--     nothing to collect and an invoice for R0,00 can never reach `paid` (Paystack will
--     not process a zero charge), so it would sit open for ever.
--   * A delta under Paystack's R1.00 floor. Same trap, and worse: an unpayable OPEN
--     invoice blocks the farm's next real charge through the in-flight machinery. Losing
--     under a rand is not worth jamming somebody's account over.
--
-- Both apply the upgrade and record the reason rather than failing.
--
-- THE SECOND WRITER IS CLOSED
-- ─────────────────────────────────────────────────────────────────────────────
-- Fixing the function is not enough while `/admin/farms/[id]` can still write `farms.plan`
-- straight past it. `app.billing_guard_farm_plan` states the INVARIANT: while a live
-- subscription exists, `farms.plan` may only move to a value billing already agrees with —
--
--   1. billing_subscriptions.plan                  the commercial plan (a plan change)
--   2. billing_settings.downgrade_to_plan          the dunning target
--   3. billing_subscriptions.plan_before_downgrade the restore target
--
-- The first draft used a transaction-local flag the engine set before its own writes, and
-- the suite rejected it on the first run: `app.billing_apply_downgrades` writes
-- `farms.plan` too, legitimately, and knows nothing about a flag added later. So does
-- restore-after-payment. Every future engine function would have had to remember.
--
-- Stating the invariant needs no flag, nothing forgeable, and no change to any existing
-- function. It also removes a failure mode the flag version had built in: a farm whose two
-- plans are ALREADY out of step — which is possible right now, because that is the defect
-- being fixed — would have had restore-after-payment raise and abort the settlement of a
-- real payment.
--
-- This is a CONSISTENCY guard, not a security boundary: an rr_admin can still move the
-- commercial plan first and the effective plan after. What it prevents is the accident —
-- a screen quietly putting the two out of step, which is exactly how this defect shipped.
--
-- A farm with NO live subscription is untouched: that is Weltevrede, and setting a plan on
-- a farm nobody is billing is the normal way to run a demo or a comped account.
--
-- Suite section (t) covers all of it, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- A pro-rata invoice is not a period invoice
-- ══════════════════════════════════════════════════════════════════════════════
-- `billing_invoices_farm_period_uq` is unique on (farm_id, period_start, period_end) and
-- exists so that a double-fired cron, a retry and a manual "raise it now" all produce one
-- bill rather than three. A pro-rata invoice covers "today .. the end of the period they
-- have already paid for", so a farm upgrading TWICE inside one period — Essential to
-- Professional on Monday, Professional to Complete on Tuesday — produced that identical
-- window twice and the second change aborted on a duplicate key, having changed nothing.
--
-- Found by suite section (t) on its first run. The sequence is ordinary, not contrived.
--
-- The constraint's meaning is "one PERIOD invoice per farm per period", and a proration is
-- not a period invoice. So the index narrows to say what it means, and prorations get
-- their own uniqueness — on the plan moved to, because two upgrades in one period are
-- genuinely two different charges, while the same upgrade twice is refused as 'no_change'
-- before it ever reaches an insert.
alter table public.billing_invoices
  add column if not exists kind text not null default 'period';

alter table public.billing_invoices
  drop constraint if exists billing_invoices_kind_ck;
alter table public.billing_invoices
  add constraint billing_invoices_kind_ck check (kind in ('period', 'proration'));

comment on column public.billing_invoices.kind is
  'period = the ordinary bill for a billing period, and the thing '
  'billing_invoices_farm_period_uq protects from being raised twice. proration = the '
  'difference charged when a farm upgrades mid-period (20260910180000).';

drop index if exists billing_invoices_farm_period_uq;
create unique index billing_invoices_farm_period_uq
  on public.billing_invoices (farm_id, period_start, period_end)
  where deleted_at is null and status <> 'void' and kind = 'period';

-- Two upgrades in one period are two charges; the SAME upgrade twice is not. The
-- `for update` on the subscription already serialises a double-click (the second
-- transaction re-reads the committed row and answers 'no_change'), so this is the second
-- lock rather than the only one — the same belt-and-braces as the in-flight attempt index.
create unique index if not exists billing_invoices_proration_uq
  on public.billing_invoices (farm_id, period_start, period_end, plan)
  where deleted_at is null and status <> 'void' and kind = 'proration';


-- ══════════════════════════════════════════════════════════════════════════════
-- What a farm has asked to change to, and when it happens
-- ══════════════════════════════════════════════════════════════════════════════
alter table public.billing_subscriptions
  add column if not exists pending_plan            farm_plan,
  add column if not exists pending_billing_period  billing_period,
  add column if not exists pending_plan_on         date,
  add column if not exists pending_plan_set_at     timestamptz;

alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_pending_plan_ck;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_pending_plan_ck check (
    -- All four together or none of them. A pending plan with no date would never be
    -- applied and would sit on the row telling the customer something untrue.
    (pending_plan is null and pending_billing_period is null
       and pending_plan_on is null and pending_plan_set_at is null)
    or (pending_plan is not null and pending_billing_period is not null
       and pending_plan_on is not null and pending_plan_set_at is not null)
  );

comment on column public.billing_subscriptions.pending_plan is
  'A DOWNGRADE or term change waiting for the period the customer has already paid for to '
  'end. Applied by app.apply_pending_plan_changes, which the nightly pass runs BEFORE the '
  'generator so the next invoice is priced on the plan they are actually moving to.';


-- ══════════════════════════════════════════════════════════════════════════════
-- What an upgrade would cost right now
-- ══════════════════════════════════════════════════════════════════════════════
-- Read-only, and SERVICE-ROLE ONLY. The owner's screen does have to say "R42,00 now,
-- then R267,00 a month" before they press anything — but it says it from the server.
--
-- The first draft granted this to `authenticated` on the reasoning that it reveals
-- nothing an owner cannot already see about their own subscription. Suite section (j)
-- refused it, and (j) was right: this function is SECURITY DEFINER, so RLS never runs
-- for it. A signed-in user from ANY farm could pass another farm's subscription id and
-- read back their vehicle count, what they are paying and their period dates. Every
-- policy would still "pass", because no policy is consulted — the same shape as the
-- `_f14_probe` helper that had to be dropped from production.
--
-- `/billing` is a Server Component and its actions are server actions, so they call this
-- through the service client after establishing who the caller is, exactly as every other
-- billing RPC is called.
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

  -- SCHEDULED: anything that is not a rank increase on the same term.
  if app.plan_rank(p_plan) <= app.plan_rank(s.plan) or p_period <> s.billing_period then
    return query select
      'scheduled',
      coalesce(s.current_period_end + 1, s.next_billing_on, current_date),
      app.billable_asset_count(s.farm_id),
      0, 0, 0::bigint, 0::bigint, 0::bigint,
      v_new.per_vehicle_monthly_incl_cents, v_new.months_charged,
      case when p_period <> s.billing_period
           then 'term change takes effect at period end'
           else 'downgrade takes effect at period end' end;
    return;
  end if;

  -- UPGRADE. Priced against what this farm is ACTUALLY paying, which is not necessarily
  -- the currently active version — see 20260910160000. Charging the difference from a
  -- price they were never on would quietly reprice them through the upgrade.
  select * into v_old from app.billing_price_for_subscription(p_sub);
  v_count := app.billable_asset_count(s.farm_id);

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
      when v_charge < 100 then 'less than R1,00 — below what the provider will process'
      else null
    end;
end $$;
revoke execute on function app.billing_plan_change_quote(uuid, farm_plan, billing_period)
  from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Move both plans, together, with the rules attached
-- ══════════════════════════════════════════════════════════════════════════════
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

  select * into q from app.billing_plan_change_quote(p_sub, p_plan, p_period);

  if q.kind = 'no_change' then
    return jsonb_build_object('applied', 'no_change');
  end if;
  if q.kind = 'unavailable' then
    raise exception 'BILLING: %', q.reason using errcode = 'check_violation';
  end if;

  -- ── SCHEDULED ────────────────────────────────────────────────────────────
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

  -- ── UPGRADE, NOW ─────────────────────────────────────────────────────────
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
    -- immediately above — the invariant is satisfied by the order of these two writes,
    -- which is the point of expressing it that way rather than as a flag.
    update public.farms set plan = p_plan where id = s.farm_id;
  end if;

  -- Nothing to collect: a zero or negative delta, no vehicles, or under the provider's
  -- floor. The upgrade still happens — see this file's header for why an unpayable
  -- invoice is worse than an uncollected rand.
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
    -- they had already paid for. Not the whole period — they have paid for the first
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
    'FleetWise ' || p_plan::text || ' — upgrade, ' || q.days_remaining::text
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


-- ══════════════════════════════════════════════════════════════════════════════
-- Scheduled changes land on their date
-- ══════════════════════════════════════════════════════════════════════════════
-- Runs BEFORE the generator in the nightly pass. A downgrade due today must be applied
-- before today's invoice is priced, or the farm is billed one more period at the plan
-- they left.
create or replace function app.apply_pending_plan_changes() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_new public.billing_price_versions%rowtype;
        v_done integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and pending_plan is not null
       and pending_plan_on <= current_date
       and status <> 'cancelled'
       and ended_on is null
     for update skip locked
  loop
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

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
revoke execute on function app.apply_pending_plan_changes() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- The second writer, closed
-- ══════════════════════════════════════════════════════════════════════════════
-- A CONSISTENCY guard, not a security boundary — see this file's header.
create or replace function app.billing_guard_farm_plan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_down farm_plan;
begin
  if new.plan is not distinct from old.plan then
    return new;
  end if;

  select * into s from public.billing_subscriptions
   where farm_id = new.id and deleted_at is null
     and status <> 'cancelled' and ended_on is null
   limit 1;
  if not found then
    return new;   -- nobody is billing this farm; its plan is not a commercial fact
  end if;

  select downgrade_to_plan into v_down from public.billing_settings where singleton;

  -- The three values billing can already justify. Anything else means the effective plan
  -- and the bill are about to disagree, which is the defect this exists to prevent.
  if new.plan = s.plan
     or new.plan is not distinct from s.plan_before_downgrade
     or new.plan is not distinct from v_down then
    return new;
  end if;

  raise exception
    'BILLING: this farm is billed for % — change the plan through billing so the bill and '
    'the features move together', s.plan
    using errcode = 'check_violation';
end $$;
revoke execute on function app.billing_guard_farm_plan() from public, anon, authenticated;

drop trigger if exists farms_billing_plan_guard on public.farms;
create trigger farms_billing_plan_guard
  before update on public.farms
  for each row execute function app.billing_guard_farm_plan();


-- ══════════════════════════════════════════════════════════════════════════════
-- PostgREST wrappers. `public` is the only schema PostgREST exposes.
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_plan_quote(
  p_sub uuid, p_plan farm_plan, p_period billing_period
) returns table (
  kind text, effective_on date, vehicles integer, days_remaining integer,
  days_in_period integer, old_period_cents bigint, new_period_cents bigint,
  charge_now_cents bigint, new_unit_cents bigint, new_months integer, reason text
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.billing_plan_change_quote(p_sub, p_plan, p_period);
$$;

create or replace function public.billing_change_plan(
  p_sub uuid, p_plan farm_plan, p_period billing_period
) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.change_billing_plan(p_sub, p_plan, p_period);
$$;

create or replace function public.cron_apply_pending_plan_changes() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.apply_pending_plan_changes();
$$;

-- All three are service_role only. The quote included: it is SECURITY DEFINER, so a
-- grant to `authenticated` would let any signed-in user price a change on somebody
-- else's subscription and learn their fleet size and their rate along the way.
do $do$
declare f text;
begin
  foreach f in array array[
    'public.billing_plan_quote(uuid, farm_plan, billing_period)',
    'public.billing_change_plan(uuid, farm_plan, billing_period)',
    'public.cron_apply_pending_plan_changes()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant  execute on function %s to service_role', f);
  end loop;
end $do$;
