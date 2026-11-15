-- 20261115110000_billing_change_quotes.sql
-- Changing what a customer pays for, mid-period: a priced quote, accepted, then paid, and only
-- then more capacity or a bigger plan (BRIEF section 15; decisions 25 and 27; scenarios 6, 7,
-- 8 and 10).
--
-- == What was wrong with the old path ========================================================
-- app.change_billing_quota and app.change_billing_plan RAISED THE CAPACITY FIRST and opened a
-- pro-rata invoice for the card run to collect later; a declined card then walked the whole
-- subscription into the dunning ladder for an extra it never paid for. A cheaper upgrade (a
-- Professional customer with fifteen pieces of equipment moving to Complete, R545 to R495)
-- charged nothing and credited nothing, and the plan quote priced full spaces only.
--
-- == The new path ============================================================================
--   1. QUOTE (app.billing_quote_change): the target package (plan, period, full spaces, extra
--      equipment spaces) is priced against the basis it starts from, and stored with that basis,
--      the charge today, any credit, the next renewal total and an expiry (30 minutes, or the
--      next midnight in South Africa, whichever is first, so no price spans a day boundary).
--   2. ACCEPT (app.billing_accept_quote): under the subscription lock, the quote is priced again
--      and must match what was shown (the amounts the person accepted are passed back); a quote
--      whose basis moved is refused 'quote-changed' and one past its time 'quote-expired', so an
--      expired or stale price is never charged. The acceptance (who, when, the amounts) is kept.
--   3. NOW or AT RENEWAL. More spaces and a higher plan on the same term are 'now'; fewer full
--      spaces, a lower plan, a change of term and a move to the current price list are
--      'renewal', written to the existing pending_* columns that app.apply_pending_plan_changes
--      lands before the renewal invoice, with the quote kept as the record. A pending change is
--      cancelled with app.billing_cancel_quote and edited by quoting again (the new one
--      supersedes it on acceptance).
--   4. PAY. A 'now' change with a charge raises a 'change' invoice for exactly the accepted
--      charge. Capacity rises only when that invoice is PAID, by a trigger on billing_payments,
--      so every way of paying (card, hosted checkout, a payment recorded by hand, credit) takes
--      the same step. Money that arrives when the change can no longer be made (the period
--      rolled over, the invoice was voided at expiry) becomes account credit, never lost and
--      never refunded unasked.
--   5. CREDIT. A 'now' change that lowers the price (the R545 to R495 upgrade) credits the
--      unused difference to billing_account_credits. Never a negative payment, never a refund.
--      Credit is spent as a payment with provider 'credit' on the next invoice (a period invoice
--      as it is issued, or a change invoice as it is raised).
--
-- == Pricing =================================================================================
-- A package is F full spaces (at least the price's minimum) and an equipment capacity (the
-- plan's included equipment plus the extra spaces paid for this period). Its value for a
-- period is app.billing_renewal_cents(price, F, capacity), the A1 sum. For the days left to the
-- renewal (inclusive of today, as before), an addition costs
--   added full x round(space price x days left / days in period)
-- + added equipment x round(equipment price x days left / days in period)
-- and an upgrade costs (or credits) round((new value - old value) x days left / days in period),
-- the equipment capacity carried across (extra on the new plan = capacity - its allowance).
-- Under R1 is not charged (the provider will not take it), as before.
--
-- == What a change invoice is not ===========================================================
-- It never counts towards a pause (app.farm_overdue_since counts period, proration, slots and
-- AI invoices only), the nightly card run never presents it (app.due_billing_charges), and a
-- declined charge on it never starts the dunning ladder (app.settle_billing_attempt). It is
-- paid when the owner pays it, or voided at the end of its payment window.
--
-- == Safe on live data =======================================================================
-- Two new tables, a new invoice kind, a new payment method value and replaced functions with
-- the same signatures. No subscription, price, invoice or capacity changes. The old
-- billing_change_quota / billing_change_plan wrappers keep working for the build that is live
-- until the new one deploys, and are left unused by it.

-- == Today, in South Africa ==================================================================
-- Supabase runs in UTC; between 00:00 and 02:00 SAST current_date is still yesterday. Every
-- date this migration decides is decided in South Africa.
create or replace function app.billing_today() returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone 'Africa/Johannesburg')::date;
$$;
revoke all on function app.billing_today() from public, anon;
grant execute on function app.billing_today() to authenticated, service_role;
comment on function app.billing_today() is
  'Today in South Africa (Africa/Johannesburg), the date every billing lifecycle rule is decided '
  'on (20261115110000).';

-- The date an instant falls on in South Africa.
create or replace function app.billing_date_of(p_at timestamptz) returns date
language sql stable set search_path = public, pg_temp as $$
  select (p_at at time zone 'Africa/Johannesburg')::date;
$$;
revoke all on function app.billing_date_of(timestamptz) from public, anon;
grant execute on function app.billing_date_of(timestamptz) to authenticated, service_role;

-- The instant a South African day ends (its next midnight).
create or replace function app.billing_day_ends_at(p_day date) returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select ((p_day + 1)::timestamp at time zone 'Africa/Johannesburg');
$$;
revoke all on function app.billing_day_ends_at(date) from public, anon;
grant execute on function app.billing_day_ends_at(date) to authenticated, service_role;

-- A share of a period price for the days left, rounded to the cent.
create or replace function app.billing_prorate_cents(p_period_cents bigint, p_remaining integer, p_total integer)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_period_cents is null then null
    when coalesce(p_total, 0) <= 0 or coalesce(p_remaining, 0) <= 0 then 0::bigint
    else round(p_period_cents::numeric * least(p_remaining, p_total) / p_total)::bigint
  end;
$$;
revoke all on function app.billing_prorate_cents(bigint, integer, integer) from public, anon;
grant execute on function app.billing_prorate_cents(bigint, integer, integer) to authenticated, service_role;

-- == A payment that is late ==================================================================
-- An owed invoice past its due date, or a renewal the card declined (the ladder's past_due and
-- grace). From the first day of that, a business is in its grace: ordinary records go on, but
-- no new paid extras (decision 41). A payment in flight or a refunded invoice does not count,
-- exactly as for the pause (app.farm_overdue_since).
create or replace function app.farm_payment_late(p_farm uuid, p_today date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.farm_overdue_since(app.billing_root(p_farm)) < p_today, false)
      or exists (select 1 from public.billing_subscriptions s
                  where s.id = app.billing_subscription_for(p_farm)
                    and s.status in ('past_due', 'grace'));
$$;
revoke all on function app.farm_payment_late(uuid, date) from public, anon, authenticated, service_role;
comment on function app.farm_payment_late(uuid, date) is
  'True when the business has an owed invoice past its due date (South African date) or a '
  'declined renewal: the seven days of grace have begun (20261115110000).';

-- Who may change what a business pays for: its owner (home site or an owner membership) or
-- Rapid Rise. The server action checks this first; the engine checks it again, so a wrong
-- caller id passed by a bug cannot buy capacity on somebody else's account.
create or replace function app.billing_actor_may_change(p_farm uuid, p_by uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_by is not null and exists (
    select 1 from public.users u
     where u.id = p_by and u.active and u.deleted_at is null
       and (u.role = 'rr_admin'
            or (u.role = 'owner' and u.farm_id = p_farm)
            or exists (select 1 from public.user_farm_memberships m
                        where m.user_id = u.id and m.farm_id = p_farm and m.role = 'owner'
                          and m.active and m.deleted_at is null)));
$$;
revoke all on function app.billing_actor_may_change(uuid, uuid) from public, anon, authenticated, service_role;

-- == A change invoice, and a credit spent as a payment =======================================
alter table public.billing_invoices drop constraint if exists billing_invoices_kind_ck;
alter table public.billing_invoices
  add constraint billing_invoices_kind_ck
  check (kind in ('period', 'proration', 'slots', 'ai_usage', 'service', 'change'));
comment on column public.billing_invoices.kind is
  'period = the bill for a billing period (billing_invoices_farm_period_uq: one per period); '
  'proration and slots = the old mid-period charges; ai_usage; service = once-off services; '
  'change = an accepted mid-period change (20261115110000), the sum of its line, paid before '
  'the change is made, never counted towards a pause and never charged by the nightly run.';

alter table public.billing_payments drop constraint if exists billing_payments_method_ck;
alter table public.billing_payments
  add constraint billing_payments_method_ck
  check (method is null or method in ('card', 'eft', 'cash', 'other', 'credit'));

-- == The quote ==============================================================================
create table if not exists public.billing_change_quotes (
  id                     uuid primary key default gen_random_uuid(),
  -- The billing site (the main site of a pooled customer): the subscription's own farm.
  farm_id                uuid not null references public.farms(id),
  subscription_id        uuid not null references public.billing_subscriptions(id),
  change                 text not null check (change in ('capacity', 'plan')),
  mode                   text not null check (mode in ('now', 'renewal')),
  status                 text not null default 'quoted'
                           check (status in ('quoted', 'awaiting_payment', 'scheduled', 'applied',
                                             'credited', 'cancelled', 'expired', 'superseded')),
  -- The basis it was priced on.
  from_plan              public.farm_plan not null,
  from_period            public.billing_period not null,
  from_price_version_id  uuid references public.billing_price_versions(id),
  from_full              integer check (from_full is null or from_full >= 0),
  from_equipment_extra   integer not null check (from_equipment_extra >= 0),
  full_in_use            integer not null check (full_in_use >= 0),
  equipment_in_use       integer not null check (equipment_in_use >= 0),
  period_start           date,
  period_end             date,
  -- What it changes to.
  to_plan                public.farm_plan not null,
  to_period              public.billing_period not null,
  to_price_version_id    uuid references public.billing_price_versions(id),
  to_full                integer check (to_full is null or to_full >= 0),
  to_equipment_extra     integer not null check (to_equipment_extra >= 0),
  -- The money, as shown and accepted.
  days_remaining         integer not null default 0 check (days_remaining >= 0),
  days_in_period         integer not null default 0 check (days_in_period >= 0),
  charge_now_cents       bigint not null default 0 check (charge_now_cents >= 0),
  credit_now_cents       bigint not null default 0 check (credit_now_cents >= 0),
  current_renewal_cents  bigint,
  next_renewal_cents     bigint,
  effective_on           date not null,
  priced_on              date not null,
  expires_at             timestamptz not null,
  payment_due_by         timestamptz,
  invoice_id             uuid references public.billing_invoices(id),
  detail                 jsonb not null default '{}'::jsonb,
  created_by             uuid references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  accepted_by            uuid references public.users(id) on delete set null,
  accepted_at            timestamptz,
  acceptance             jsonb,
  applied_at             timestamptz,
  closed_at              timestamptz,
  closed_by              uuid references public.users(id) on delete set null,
  close_reason           text check (close_reason is null or length(close_reason) <= 300),
  updated_at             timestamptz not null default now(),
  constraint billing_change_quotes_money_ck check (not (charge_now_cents > 0 and credit_now_cents > 0)),
  -- Nothing is scheduled, awaiting payment, made or credited without an acceptance on record.
  constraint billing_change_quotes_accept_ck check (
    status in ('quoted', 'expired', 'superseded', 'cancelled') or accepted_at is not null)
);
create unique index if not exists billing_change_quotes_invoice_uq
  on public.billing_change_quotes (invoice_id) where invoice_id is not null;
-- One change waiting for its payment per subscription: a second one could be priced on a
-- basis the first is about to change.
create unique index if not exists billing_change_quotes_awaiting_uq
  on public.billing_change_quotes (subscription_id) where status = 'awaiting_payment';
create index if not exists billing_change_quotes_sub_idx
  on public.billing_change_quotes (subscription_id, created_at desc);
create index if not exists billing_change_quotes_open_idx
  on public.billing_change_quotes (expires_at) where status in ('quoted', 'awaiting_payment');
comment on table public.billing_change_quotes is
  'Every priced mid-period change: its basis, target, charge, credit, next renewal, expiry, who '
  'accepted it and what happened (20261115110000). Written only by the app.billing_*_quote '
  'functions; the owner and Rapid Rise read it.';

alter table public.billing_change_quotes enable row level security;
alter table public.billing_change_quotes force row level security;
drop policy if exists billing_change_quotes_sel on public.billing_change_quotes;
create policy billing_change_quotes_sel on public.billing_change_quotes
  for select to authenticated using ((select app.is_farm_billing_admin(farm_id)));
revoke all on public.billing_change_quotes from public, anon, authenticated;
grant select on public.billing_change_quotes to authenticated;
grant all on public.billing_change_quotes to service_role;
drop trigger if exists billing_change_quotes_audit on public.billing_change_quotes;
create trigger billing_change_quotes_audit after insert or update or delete on public.billing_change_quotes
  for each row execute function public.app_audit();

-- == Account credit ==========================================================================
-- Append-only: granted (positive), applied to an invoice (negative), restored when an invoice
-- it was spent on is voided (positive). The balance is the sum. One grant per quote and one
-- row per payment and entry, so a retried webhook, a second trigger run or a double press can
-- never credit twice.
create table if not exists public.billing_account_credits (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.farms(id),
  subscription_id  uuid not null references public.billing_subscriptions(id),
  entry            text not null check (entry in ('granted', 'applied', 'restored')),
  source           text not null check (source in ('plan_change', 'unapplied_payment', 'voided_invoice', 'invoice')),
  amount_cents     bigint not null,
  quote_id         uuid references public.billing_change_quotes(id),
  payment_id       uuid references public.billing_payments(id),
  invoice_id       uuid references public.billing_invoices(id),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint billing_account_credits_sign_ck check (
    (entry in ('granted', 'restored') and amount_cents > 0) or (entry = 'applied' and amount_cents < 0))
);
create unique index if not exists billing_account_credits_quote_uq
  on public.billing_account_credits (quote_id) where entry = 'granted' and quote_id is not null;
create unique index if not exists billing_account_credits_payment_uq
  on public.billing_account_credits (payment_id, entry) where payment_id is not null;
create index if not exists billing_account_credits_sub_idx
  on public.billing_account_credits (subscription_id, created_at);
comment on table public.billing_account_credits is
  'Account credit (20261115110000): the unused difference of an upgrade that lowered the price, '
  'or money that arrived for a change that could no longer be made. Spent on the next invoice as '
  'a payment with provider credit. Never a negative payment and never a refund.';

create or replace function app.billing_credits_append_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'BILLING: account credit is append-only; write a new entry instead'
    using errcode = 'check_violation';
end $$;
revoke all on function app.billing_credits_append_only() from public, anon, authenticated;
drop trigger if exists billing_account_credits_append_only on public.billing_account_credits;
create trigger billing_account_credits_append_only before update or delete on public.billing_account_credits
  for each row execute function app.billing_credits_append_only();

alter table public.billing_account_credits enable row level security;
alter table public.billing_account_credits force row level security;
drop policy if exists billing_account_credits_sel on public.billing_account_credits;
create policy billing_account_credits_sel on public.billing_account_credits
  for select to authenticated using ((select app.is_farm_billing_admin(farm_id)));
revoke all on public.billing_account_credits from public, anon, authenticated;
grant select on public.billing_account_credits to authenticated;
grant all on public.billing_account_credits to service_role;
drop trigger if exists billing_account_credits_audit on public.billing_account_credits;
create trigger billing_account_credits_audit after insert or update or delete on public.billing_account_credits
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('billing_change_quotes',   'rapid_rise', 'billing: the owner only'),
  ('billing_account_credits', 'rapid_rise', 'billing: the owner only')
on conflict (table_name) do nothing;

-- Paying: a stopped business still sees what it accepted and what it is owed.
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('billing_change_quotes',   'open', 'paying: a change the owner accepted and its payment'),
  ('billing_account_credits', 'open', 'paying: credit the account holds')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('billing_change_quotes');
select app.pay_gate_apply('billing_account_credits');

create or replace function app.billing_credit_balance(p_sub uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(c.amount_cents), 0)::bigint
    from public.billing_account_credits c where c.subscription_id = p_sub;
$$;
revoke all on function app.billing_credit_balance(uuid) from public, anon, authenticated, service_role;

-- == Pricing a change =========================================================================
-- What a change would do and cost, priced on today's basis. Reads only. p_full and
-- p_equipment_extra are the TARGET full spaces and extra equipment spaces of a capacity change
-- (null keeps the present number); a different plan or period, or p_current_list (move the
-- agreement to today's price list at the same plan), makes it a plan change at the present
-- quantities. kind: now | renewal | no_change | unavailable (with a reason slug).
create or replace function app.billing_change_state(
  p_sub uuid, p_plan public.farm_plan, p_period public.billing_period,
  p_full integer, p_equipment_extra integer, p_current_list boolean, p_today date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s           public.billing_subscriptions%rowtype;
  v_old       public.billing_price_versions%rowtype;
  v_new       public.billing_price_versions%rowtype;
  v_sched     public.billing_price_versions%rowtype;
  v_today     date := coalesce(p_today, app.billing_today());
  v_kind      text;
  v_reason    text;
  v_change    text;
  v_exempt    boolean;
  v_metered   boolean;
  v_full_in   integer;
  v_eq_in     integer;
  v_full_now  integer;
  v_extra_now integer;
  v_inc_old   integer := 0;
  v_cap_now   integer;
  v_to_plan   public.farm_plan;
  v_to_period public.billing_period;
  v_to_full   integer;
  v_to_extra  integer;
  v_inc_new   integer := 0;
  v_rem       integer := 0;
  v_total     integer := 0;
  v_unit_full bigint := 0;
  v_unit_eq   bigint := 0;
  v_charge    bigint := 0;
  v_credit    bigint := 0;
  v_old_val   bigint;
  v_new_val   bigint;
  v_diff      bigint;
  v_balance   bigint := 0;
  v_payable   bigint;
  v_waived    bigint := 0;
  v_effective date;
  v_cur_ren   bigint;
  v_next_ren  bigint;
  v_full_next integer;
  v_eq_next   integer;
  v_max       integer := app.self_service_max_full_spaces();
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    return jsonb_build_object('kind', 'unavailable', 'reason', 'billing-no-subscription');
  end if;
  select f.billing_exempt into v_exempt from public.farms f where f.id = s.farm_id;
  v_exempt := coalesce(v_exempt, false);

  select * into v_old from app.billing_price_for_subscription(p_sub);
  v_metered   := s.asset_quota is null;
  v_full_in   := app.billable_asset_count(s.farm_id);
  v_eq_in     := app.billable_equipment_count(s.farm_id);
  v_full_now  := coalesce(s.asset_quota, v_full_in);
  if v_old.id is not null and v_old.equipment_period_incl_cents is not null then
    v_inc_old := coalesce(v_old.equipment_included, 0);
  end if;
  -- What equipment capacity this period has: the allowance plus the extra paid for. A
  -- metered subscription has no ceiling, so it is what is in use.
  v_extra_now := case when v_metered then greatest(v_eq_in - v_inc_old, 0) else s.equipment_extra_quota end;
  v_cap_now   := v_inc_old + v_extra_now;

  v_to_plan   := coalesce(p_plan, s.plan);
  v_to_period := coalesce(p_period, s.billing_period);
  v_change := case when v_to_plan <> s.plan or v_to_period <> s.billing_period or coalesce(p_current_list, false)
                   then 'plan' else 'capacity' end;

  if s.current_period_start is not null and s.current_period_end is not null then
    v_total := greatest((s.current_period_end - s.current_period_start) + 1, 1);
    -- Inclusive of today: somebody adding a space this morning has it for all of today.
    v_rem   := greatest(least((s.current_period_end - v_today) + 1, v_total), 0);
  end if;
  v_effective := coalesce(s.current_period_end + 1, s.next_billing_on, v_today);

  -- == Who may change at all ==
  if s.status = 'cancelled' or s.ended_on is not null then
    v_reason := 'billing-subscription-ended';
  elsif s.status = 'pending' then
    v_reason := 'billing-change-pending';
  elsif s.status = 'suspended' then
    v_reason := 'billing-change-paused';
  elsif v_old.id is null or app.billing_space_period_cents(v_old) is null then
    v_reason := 'billing-plan-unpriced';
  end if;

  if v_change = 'capacity' then
    v_new      := v_old;
    v_inc_new  := v_inc_old;
    v_to_full  := coalesce(p_full, s.asset_quota);
    v_to_extra := coalesce(p_equipment_extra, s.equipment_extra_quota);
    if v_reason is not null then
      null;
    elsif v_metered then
      -- No quota: nothing to buy, the renewal bills what is counted.
      v_reason := 'billing-change-metered';
    elsif v_to_full is null or v_to_full < 1 or v_to_full > 100000 or v_to_extra < 0 or v_to_extra > 100000 then
      v_reason := 'billing-quantity-invalid';
    elsif v_to_extra <> v_extra_now and v_old.equipment_period_incl_cents is null then
      v_reason := 'equipment-not-in-agreement';
    elsif v_to_full < coalesce(v_old.min_billed_slots, 0) then
      v_reason := 'billing-slots-minimum';
    elsif v_to_full < v_full_in then
      -- Nothing here deletes a vehicle to make a billing change fit.
      v_reason := 'billing-quota-below-fleet';
    elsif v_to_extra < v_extra_now then
      -- Extra equipment is charged by what is in use at the renewal: retire equipment instead.
      v_reason := 'billing-equipment-not-reducible';
    elsif v_to_full > v_max and v_full_now <= v_max then
      -- Above the self-service line (decision 39): a capacity check and a quote.
      v_reason := 'billing-capacity-quote';
    elsif v_to_full = v_full_now and v_to_extra = v_extra_now then
      v_kind := 'no_change';
    elsif v_to_full < v_full_now and v_to_extra > v_extra_now then
      v_reason := 'billing-change-mixed';
    elsif v_to_full < v_full_now then
      v_kind := 'renewal';
    else
      v_kind := 'now';
      v_unit_full := app.billing_prorate_cents(app.billing_space_period_cents(v_old), v_rem, v_total);
      v_unit_eq   := app.billing_prorate_cents(coalesce(v_old.equipment_period_incl_cents, 0), v_rem, v_total);
      v_charge := greatest(v_to_full - v_full_now, 0)::bigint * v_unit_full
                + greatest(v_to_extra - v_extra_now, 0)::bigint * v_unit_eq;
      v_effective := v_today;
    end if;
  else
    select * into v_new from app.billing_active_price(v_to_plan, v_to_period);
    v_to_full := s.asset_quota;
    if v_new.id is not null and v_new.equipment_period_incl_cents is not null then
      v_inc_new := coalesce(v_new.equipment_included, 0);
    end if;
    -- The equipment capacity is carried across: what the new allowance does not cover is extra.
    v_to_extra := greatest(v_cap_now - v_inc_new, 0);
    if v_reason is not null then
      null;
    elsif v_new.id is null or v_new.per_vehicle_monthly_incl_cents is null or app.billing_space_period_cents(v_new) is null then
      v_reason := 'billing-plan-unpriced';
    elsif v_full_now < coalesce(v_new.min_billed_slots, 0) then
      v_reason := 'billing-plan-needs-slots';
    elsif v_new.equipment_period_incl_cents is null and v_eq_in > 0 then
      v_reason := 'equipment-not-in-agreement';
    elsif v_to_plan = s.plan and v_to_period = s.billing_period and v_new.id = v_old.id then
      v_kind := 'no_change';
    elsif app.plan_rank(v_to_plan) > app.plan_rank(s.plan) and v_to_period = s.billing_period then
      v_kind := 'now';
      v_effective := v_today;
      -- The whole package, equipment allowance included: the old value against the new for
      -- the days left. A lower total is a credit (decision 25).
      v_old_val := app.billing_renewal_cents(v_old, v_full_now, v_cap_now);
      v_new_val := app.billing_renewal_cents(v_new, v_full_now, v_cap_now);
      if v_rem > 0 and v_old_val is not null and v_new_val is not null then
        v_diff   := round((v_new_val - v_old_val)::numeric * v_rem / v_total)::bigint;
        v_charge := greatest(v_diff, 0);
        v_credit := greatest(-v_diff, 0);
      end if;
    else
      -- A lower plan, a change of term, or the current list at the same plan: at renewal.
      v_kind := 'renewal';
    end if;
  end if;

  if v_reason is not null then
    v_kind := 'unavailable';
  end if;

  -- In the seven days of grace nothing new that costs money is sold (decision 41).
  if v_kind = 'now' and v_charge > 0 and app.farm_payment_late(s.farm_id, v_today) then
    v_kind := 'unavailable';
    v_reason := 'billing-grace-no-extras';
  end if;

  -- An exempt business is never charged and never credited.
  if v_exempt then
    v_charge := 0;
    v_credit := 0;
  end if;

  -- Credit the account already holds pays first; what is left under R1 is not charged, as
  -- before, because the provider will not take it.
  v_balance := app.billing_credit_balance(p_sub);
  if v_kind = 'now' and v_charge > 0 then
    v_payable := v_charge - least(v_charge, greatest(v_balance, 0));
    if v_payable > 0 and v_payable < 100 then
      v_waived := v_payable;
      v_charge := v_charge - v_payable;
    end if;
  end if;

  -- == The renewal, as scheduled now and after this change ==
  if s.pending_plan is not null then
    select * into v_sched from app.billing_active_price(s.pending_plan, s.pending_billing_period);
  else
    v_sched := v_old;
  end if;
  v_full_next := coalesce(s.pending_quota, v_full_now);
  v_cur_ren := app.billing_renewal_cents(v_sched, v_full_next, v_eq_in);
  if v_change = 'capacity' then
    v_eq_next := case when v_to_extra > v_extra_now then greatest(v_eq_in, v_inc_old + v_to_extra) else v_eq_in end;
    v_next_ren := app.billing_renewal_cents(v_sched, coalesce(v_to_full, v_full_next), v_eq_next);
  else
    v_next_ren := app.billing_renewal_cents(v_new, coalesce(s.pending_quota, v_full_now), v_eq_in);
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'reason', v_reason,
    'change', v_change,
    'subscription_id', s.id,
    'farm_id', s.farm_id,
    'status', s.status,
    'exempt', v_exempt,
    'metered', v_metered,
    'today', v_today,
    'effective_on', v_effective,
    'from', jsonb_build_object(
      'plan', s.plan, 'period', s.billing_period,
      'price_version_id', v_old.id, 'price_version', v_old.version_label,
      'full', s.asset_quota, 'equipment_extra', s.equipment_extra_quota,
      'equipment_included', v_inc_old, 'equipment_capacity', v_cap_now,
      'space_period_cents', app.billing_space_period_cents(v_old),
      'equipment_period_cents', v_old.equipment_period_incl_cents),
    'to', jsonb_build_object(
      'plan', v_to_plan, 'period', v_to_period,
      'price_version_id', v_new.id, 'price_version', v_new.version_label,
      'full', v_to_full, 'equipment_extra', v_to_extra,
      'equipment_included', v_inc_new, 'equipment_capacity', v_inc_new + coalesce(v_to_extra, 0),
      'space_period_cents', app.billing_space_period_cents(v_new),
      'equipment_period_cents', v_new.equipment_period_incl_cents),
    'in_use', jsonb_build_object('full', v_full_in, 'equipment', v_eq_in),
    'period', jsonb_build_object(
      'start', s.current_period_start, 'end', s.current_period_end,
      'renewal_on', coalesce(s.current_period_end + 1, s.next_billing_on),
      'days_remaining', v_rem, 'days_in_period', v_total),
    'pending', jsonb_build_object(
      'plan', s.pending_plan, 'period', s.pending_billing_period, 'plan_on', s.pending_plan_on,
      'full', s.pending_quota, 'full_on', s.pending_quota_on),
    'money', jsonb_build_object(
      'charge_now_cents', v_charge,
      'credit_now_cents', v_credit,
      'waived_cents', v_waived,
      'unit_full_cents', v_unit_full,
      'unit_equipment_cents', v_unit_eq,
      'credit_balance_cents', v_balance,
      'pay_now_cents', greatest(v_charge - least(v_charge, greatest(v_balance, 0)), 0),
      'current_renewal_cents', v_cur_ren,
      'next_renewal_cents', v_next_ren));
end $$;
revoke all on function app.billing_change_state(uuid, public.farm_plan, public.billing_period, integer, integer, boolean, date)
  from public, anon, authenticated, service_role;
-- == Quoting =================================================================================
-- Prices the change and keeps it, with its basis, for the person to accept. A quote not yet
-- accepted is superseded by the next one, so only one price is ever live.
create or replace function app.billing_quote_change(
  p_sub uuid, p_plan public.farm_plan, p_period public.billing_period,
  p_full integer, p_equipment_extra integer, p_current_list boolean, p_by uuid,
  p_today date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s         public.billing_subscriptions%rowtype;
  v         jsonb;
  v_today   date := coalesce(p_today, app.billing_today());
  v_id      uuid;
  v_expires timestamptz;
begin
  select * into s from public.billing_subscriptions where id = p_sub and deleted_at is null;
  if not found then
    raise exception 'billing-no-subscription' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(s.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v := app.billing_change_state(p_sub, p_plan, p_period, p_full, p_equipment_extra, p_current_list, v_today);
  if v ->> 'kind' not in ('now', 'renewal') then
    return v;
  end if;

  update public.billing_change_quotes
     set status = 'superseded', closed_at = now(), close_reason = 'a newer quote', updated_at = now()
   where subscription_id = p_sub and status = 'quoted';

  -- Thirty minutes, and never past midnight in South Africa: a price for the days left is a
  -- price for today.
  v_expires := least(now() + interval '30 minutes', app.billing_day_ends_at(v_today));

  insert into public.billing_change_quotes (
    farm_id, subscription_id, change, mode, status,
    from_plan, from_period, from_price_version_id, from_full, from_equipment_extra,
    full_in_use, equipment_in_use, period_start, period_end,
    to_plan, to_period, to_price_version_id, to_full, to_equipment_extra,
    days_remaining, days_in_period, charge_now_cents, credit_now_cents,
    current_renewal_cents, next_renewal_cents, effective_on, priced_on, expires_at,
    detail, created_by
  ) values (
    s.farm_id, s.id, v ->> 'change', v ->> 'kind', 'quoted',
    s.plan, s.billing_period, nullif(v #>> '{from,price_version_id}', '')::uuid, s.asset_quota, s.equipment_extra_quota,
    (v #>> '{in_use,full}')::integer, (v #>> '{in_use,equipment}')::integer,
    s.current_period_start, s.current_period_end,
    (v #>> '{to,plan}')::public.farm_plan, (v #>> '{to,period}')::public.billing_period,
    nullif(v #>> '{to,price_version_id}', '')::uuid,
    nullif(v #>> '{to,full}', '')::integer, (v #>> '{to,equipment_extra}')::integer,
    (v #>> '{period,days_remaining}')::integer, (v #>> '{period,days_in_period}')::integer,
    (v #>> '{money,charge_now_cents}')::bigint, (v #>> '{money,credit_now_cents}')::bigint,
    nullif(v #>> '{money,current_renewal_cents}', '')::bigint, nullif(v #>> '{money,next_renewal_cents}', '')::bigint,
    (v ->> 'effective_on')::date, v_today, v_expires,
    v || jsonb_build_object('input', jsonb_build_object(
      'plan', p_plan, 'period', p_period, 'full', p_full, 'equipment_extra', p_equipment_extra,
      'current_list', coalesce(p_current_list, false))),
    p_by
  ) returning id into v_id;

  return v || jsonb_build_object('quote_id', v_id, 'expires_at', v_expires);
end $$;
revoke all on function app.billing_quote_change(uuid, public.farm_plan, public.billing_period, integer, integer, boolean, uuid, date)
  from public, anon, authenticated, service_role;

-- == Making a change =========================================================================
-- Internal. Makes an accepted 'now' change, once, if what it was priced on still holds; answers
-- 'applied', 'stale' (the basis moved: the period rolled over, the plan or quantities changed)
-- or 'closed'. Never raises for a basis that moved, because it runs inside a payment.
create or replace function app.billing_apply_change(p_quote uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.billing_change_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
  v_label text;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then return 'closed'; end if;
  if q.status = 'applied' then return 'applied'; end if;
  if q.status not in ('quoted', 'awaiting_payment') or q.accepted_at is null or q.mode <> 'now' then
    return 'closed';
  end if;

  select * into s from public.billing_subscriptions where id = q.subscription_id for update;
  if not found or s.deleted_at is not null or s.ended_on is not null
     or s.status in ('cancelled', 'pending', 'suspended')
     or s.plan <> q.from_plan or s.billing_period <> q.from_period
     or s.asset_quota is distinct from q.from_full
     or s.equipment_extra_quota <> q.from_equipment_extra
     or s.current_period_end is distinct from q.period_end
     or (app.billing_price_for_subscription(s.id)).id is distinct from q.from_price_version_id then
    return 'stale';
  end if;

  if q.change = 'capacity' then
    update public.billing_subscriptions
       set asset_quota = q.to_full,
           equipment_extra_quota = q.to_equipment_extra,
           -- More than the number you asked to give back is unambiguous about which you meant.
           pending_quota = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota end,
           pending_quota_on = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota_on end,
           pending_quota_set_at = case when q.to_full > coalesce(s.asset_quota, 0) then null else pending_quota_set_at end,
           updated_at = now()
     where id = s.id;
    if q.to_full > coalesce(s.asset_quota, 0) then
      update public.billing_change_quotes
         set status = 'superseded', closed_at = now(), close_reason = 'more spaces were bought', updated_at = now()
       where subscription_id = s.id and status = 'scheduled' and change = 'capacity';
    end if;
  else
    select version_label into v_label from public.billing_price_versions where id = q.to_price_version_id;
    update public.billing_subscriptions
       set plan = q.to_plan,
           billing_period = q.to_period,
           price_version_id = q.to_price_version_id,
           price_version_label = coalesce(v_label, price_version_label),
           equipment_extra_quota = q.to_equipment_extra,
           -- An upgrade cancels a downgrade that was waiting.
           pending_plan = null, pending_billing_period = null, pending_plan_on = null, pending_plan_set_at = null,
           updated_at = now()
     where id = s.id;
    -- The effective plan, with the non-payment exception the old path kept.
    if s.plan_before_downgrade is not null then
      update public.billing_subscriptions set plan_before_downgrade = q.to_plan where id = s.id;
    else
      update public.farms set plan = q.to_plan where id = s.farm_id;
      -- One plan across a customer's sites (decision 22).
      update public.farms set plan = q.to_plan where billed_through = s.farm_id and deleted_at is null;
    end if;
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'a higher plan was taken', updated_at = now()
     where subscription_id = s.id and status = 'scheduled' and change = 'plan';
  end if;

  update public.billing_change_quotes
     set status = 'applied', applied_at = now(), updated_at = now()
   where id = q.id;
  return 'applied';
end $$;
revoke all on function app.billing_apply_change(uuid) from public, anon, authenticated, service_role;

-- == Spending credit =========================================================================
-- Pays what it can of an open invoice from the account's credit, as a payment with provider
-- 'credit', under the subscription lock so two invoices cannot spend the same rand. Not a
-- service invoice (once-off, paid its own way) and never while a card payment is in flight.
create or replace function app.billing_apply_credit(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i       public.billing_invoices%rowtype;
  v_bal   bigint;
  v_amt   bigint;
  v_pay   uuid;
begin
  select * into i from public.billing_invoices where id = p_invoice and deleted_at is null for update;
  if not found or i.status <> 'open' or i.subscription_id is null or i.kind = 'service' then
    return 0;
  end if;
  if exists (select 1 from public.billing_payment_attempts a
              where a.invoice_id = i.id and a.status in ('pending', 'unknown')) then
    return 0;
  end if;
  perform 1 from public.billing_subscriptions where id = i.subscription_id for update;
  v_bal := app.billing_credit_balance(i.subscription_id);
  v_amt := least(v_bal, i.total_incl_cents - i.amount_paid_cents);
  if v_amt is null or v_amt <= 0 then
    return 0;
  end if;

  insert into public.billing_payments (
    farm_id, invoice_id, amount_incl_cents, currency, paid_at,
    provider, provider_reference, channel, method, note
  ) values (
    i.farm_id, i.id, v_amt, 'ZAR', now(),
    'credit', 'CR-' || replace(gen_random_uuid()::text, '-', ''), 'credit', 'credit', 'account credit'
  ) returning id into v_pay;
  insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, payment_id, invoice_id, note)
  values (i.farm_id, i.subscription_id, 'applied', 'invoice', -v_amt, v_pay, i.id, 'spent on ' || i.invoice_ref);

  -- Paid in full by credit: the step every payment takes.
  if (select status from public.billing_invoices where id = i.id) = 'paid' then
    perform app.billing_restore_after_payment(i.subscription_id);
  end if;
  return v_amt;
end $$;
revoke all on function app.billing_apply_credit(uuid) from public, anon, authenticated, service_role;

-- A period invoice spends the credit as it is issued.
create or replace function app.billing_invoice_spend_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.subscription_id is not null and app.billing_credit_balance(new.subscription_id) > 0 then
    perform app.billing_apply_credit(new.id);
  end if;
  return null;
end $$;
revoke all on function app.billing_invoice_spend_credit() from public, anon, authenticated;
drop trigger if exists billing_invoices_spend_credit on public.billing_invoices;
create trigger billing_invoices_spend_credit
  after update of status on public.billing_invoices
  for each row
  when (old.status = 'draft' and new.status = 'open' and new.kind in ('period', 'ai_usage'))
  execute function app.billing_invoice_spend_credit();

-- == The change invoice ======================================================================
-- Exactly the accepted charge, one line saying what it buys, due today. Lines first, then
-- issued, so app.billing_freeze_invoice_line is satisfied and the total is the line.
create or replace function app.billing_raise_change_invoice(p_quote uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q          public.billing_change_quotes%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm     public.farms%rowtype;
  v_price    public.billing_price_versions%rowtype;
  v_invoice  uuid;
  v_desc     text;
  v_today    date := app.billing_today();
begin
  select * into q from public.billing_change_quotes where id = p_quote;
  select * into v_settings from public.billing_settings where singleton;
  select * into v_farm from public.farms where id = q.farm_id;
  select * into v_price from public.billing_price_versions where id = coalesce(q.to_price_version_id, q.from_price_version_id);

  v_desc := case
    when q.change = 'capacity' then
      'FLEETWISE '
      || case when q.to_full > coalesce(q.from_full, 0) then (q.to_full - coalesce(q.from_full, 0))::text || ' more full space(s)' else '' end
      || case when q.to_full > coalesce(q.from_full, 0) and q.to_equipment_extra > q.from_equipment_extra then ' and ' else '' end
      || case when q.to_equipment_extra > q.from_equipment_extra
              then (q.to_equipment_extra - q.from_equipment_extra)::text || ' more equipment space(s)' else '' end
    else
      'FLEETWISE ' || q.from_plan::text || ' to ' || q.to_plan::text
      || ', ' || coalesce(q.from_full, q.full_in_use)::text || ' full space(s)'
    end
    || ', ' || q.days_remaining::text || ' of ' || q.days_in_period::text || ' days to '
    || to_char(coalesce(q.period_end, v_today), 'DD Mon YYYY');

  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
    equipment_active, equipment_included, equipment_count, equipment_unit_incl_cents,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    q.farm_id, q.subscription_id, app.next_billing_invoice_ref(), 'draft', 'change',
    v_today, greatest(coalesce(q.period_end, v_today), v_today), v_today, v_today,
    q.to_plan, q.to_period,
    greatest(coalesce(q.to_full, 0) - coalesce(q.from_full, 0), 0), 0, 1,
    q.equipment_in_use, coalesce((q.detail #>> '{to,equipment_included}')::integer, 0),
    greatest(q.to_equipment_extra - q.from_equipment_extra, 0), 0,
    v_price.id, coalesce(v_price.version_label, 'Change'), coalesce(v_price.vat_rate_bps, 0),
    v_settings.vat_number,
    jsonb_build_object(
      'legal_name', v_settings.legal_name, 'trading_name', v_settings.trading_name,
      'reg_number', v_settings.reg_number, 'vat_registered', v_settings.vat_registered,
      'billing_address', v_settings.billing_address, 'billing_email', v_settings.billing_email),
    jsonb_build_object(
      'name', v_farm.name, 'trading_name', v_farm.trading_name, 'reg_number', v_farm.reg_number,
      'vat_number', v_farm.vat_number, 'billing_address', v_farm.billing_address,
      'billing_email', v_farm.billing_email)
  ) returning id into v_invoice;

  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select v_invoice, q.farm_id, 0, left(v_desc, 200), 1, 1, q.charge_now_cents, q.charge_now_cents,
         app.ex_vat_cents(q.charge_now_cents, inv.vat_rate_bps),
         q.charge_now_cents - app.ex_vat_cents(q.charge_now_cents, inv.vat_rate_bps)
    from public.billing_invoices inv where inv.id = v_invoice;

  update public.billing_invoices set status = 'open' where id = v_invoice;
  return v_invoice;
end $$;
revoke all on function app.billing_raise_change_invoice(uuid) from public, anon, authenticated, service_role;

-- == Accepting ===============================================================================
-- The person accepts the amounts they were shown (passed back, so a changed price is refused
-- rather than charged). Priced again under the subscription lock: a basis that moved since the
-- quote (another change, an asset added or retired, the period rolled over) is 'quote-changed',
-- and a quote past its time is 'quote-expired'. A repeated press answers as the first did.
create or replace function app.billing_accept_quote(
  p_quote uuid, p_by uuid, p_charge_cents bigint, p_credit_cents bigint, p_next_renewal_cents bigint,
  p_today date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q         public.billing_change_quotes%rowtype;
  s         public.billing_subscriptions%rowtype;
  v         jsonb;
  v_in      jsonb;
  v_today   date := coalesce(p_today, app.billing_today());
  v_invoice uuid;
  v_result  text;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then
    raise exception 'quote-not-found' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(q.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The same lock every capacity add takes, before anything is counted.
  select * into s from public.billing_subscriptions where id = q.subscription_id for update;

  if q.status in ('awaiting_payment', 'scheduled', 'applied', 'credited') and q.accepted_by is not distinct from p_by then
    return jsonb_build_object(
      'applied', case q.status when 'scheduled' then 'scheduled' when 'awaiting_payment' then 'awaiting_payment' else 'now' end,
      'quote_id', q.id, 'invoice_id', q.invoice_id, 'effective_on', q.effective_on,
      'charge_cents', q.charge_now_cents, 'credit_cents', q.credit_now_cents, 'repeat', true);
  end if;
  if q.status <> 'quoted' then
    raise exception 'quote-not-open' using errcode = '22023';
  end if;
  if now() >= q.expires_at then
    raise exception 'quote-expired' using errcode = '22023',
      hint = 'Prices are for today and last 30 minutes; ask for a new price.';
  end if;
  if p_charge_cents is distinct from q.charge_now_cents
     or p_credit_cents is distinct from q.credit_now_cents
     or p_next_renewal_cents is distinct from q.next_renewal_cents then
    raise exception 'quote-changed' using errcode = '22023',
      hint = 'The amounts accepted are not the ones this quote states.';
  end if;

  v_in := q.detail -> 'input';
  v := app.billing_change_state(q.subscription_id,
         nullif(v_in ->> 'plan', '')::public.farm_plan, nullif(v_in ->> 'period', '')::public.billing_period,
         nullif(v_in ->> 'full', '')::integer, nullif(v_in ->> 'equipment_extra', '')::integer,
         coalesce((v_in ->> 'current_list')::boolean, false), v_today);
  if v ->> 'kind' is distinct from q.mode
     or (v #>> '{money,charge_now_cents}')::bigint is distinct from q.charge_now_cents
     or (v #>> '{money,credit_now_cents}')::bigint is distinct from q.credit_now_cents
     or nullif(v #>> '{money,next_renewal_cents}', '')::bigint is distinct from q.next_renewal_cents
     or s.asset_quota is distinct from q.from_full
     or s.equipment_extra_quota <> q.from_equipment_extra
     or s.plan <> q.from_plan or s.billing_period <> q.from_period
     or s.current_period_end is distinct from q.period_end then
    raise exception 'quote-changed' using errcode = '22023',
      hint = coalesce(v ->> 'reason', 'The quantities or the period changed since this price; ask for a new one.');
  end if;
  if q.mode = 'now' and exists (select 1 from public.billing_change_quotes o
                                  where o.subscription_id = q.subscription_id and o.status = 'awaiting_payment') then
    raise exception 'quote-awaiting-payment' using errcode = '22023',
      hint = 'Pay or cancel the change already waiting for its payment first.';
  end if;

  update public.billing_change_quotes
     set accepted_by = p_by, accepted_at = now(), updated_at = now(),
         acceptance = jsonb_build_object(
           'charge_cents', p_charge_cents, 'credit_cents', p_credit_cents,
           'next_renewal_cents', p_next_renewal_cents, 'on', v_today, 'at', now())
   where id = q.id;

  -- == At renewal: recorded, and nothing moves today ==
  if q.mode = 'renewal' then
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'replaced by a newer change', updated_at = now()
     where subscription_id = q.subscription_id and status = 'scheduled' and change = q.change and id <> q.id;
    if q.change = 'plan' then
      update public.billing_subscriptions
         set pending_plan = q.to_plan, pending_billing_period = q.to_period,
             pending_plan_on = q.effective_on, pending_plan_set_at = now(), updated_at = now()
       where id = q.subscription_id;
    else
      update public.billing_subscriptions
         set pending_quota = q.to_full, pending_quota_on = q.effective_on,
             pending_quota_set_at = now(), updated_at = now()
       where id = q.subscription_id;
    end if;
    update public.billing_change_quotes set status = 'scheduled', updated_at = now() where id = q.id;
    return jsonb_build_object('applied', 'scheduled', 'quote_id', q.id, 'effective_on', q.effective_on,
                              'next_renewal_cents', q.next_renewal_cents);
  end if;

  -- == Now, with nothing to pay: made at once, any credit kept ==
  if q.charge_now_cents = 0 then
    v_result := app.billing_apply_change(q.id);
    if v_result <> 'applied' then
      raise exception 'quote-changed' using errcode = '22023';
    end if;
    if q.credit_now_cents > 0 then
      insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, quote_id, note, created_by)
      values (q.farm_id, q.subscription_id, 'granted', 'plan_change', q.credit_now_cents, q.id,
              'unused difference, ' || q.from_plan::text || ' to ' || q.to_plan::text, p_by);
    end if;
    return jsonb_build_object('applied', 'now', 'quote_id', q.id, 'charge_cents', 0,
                              'credit_cents', q.credit_now_cents);
  end if;

  -- == Now, paid first: the invoice, credit spent on it, then the payment makes the change ==
  v_invoice := app.billing_raise_change_invoice(q.id);
  update public.billing_change_quotes
     set status = 'awaiting_payment', invoice_id = v_invoice,
         payment_due_by = least(now() + interval '24 hours',
                                app.billing_day_ends_at(greatest(coalesce(q.period_end, v_today), v_today))),
         updated_at = now()
   where id = q.id;
  perform app.billing_apply_credit(v_invoice);

  select * into q from public.billing_change_quotes where id = q.id;
  return jsonb_build_object(
    'applied', case when q.status = 'applied' then 'now' else 'awaiting_payment' end,
    'quote_id', q.id, 'invoice_id', v_invoice, 'charge_cents', q.charge_now_cents,
    'outstanding_cents', (select total_incl_cents - amount_paid_cents from public.billing_invoices where id = v_invoice));
end $$;
revoke all on function app.billing_accept_quote(uuid, uuid, bigint, bigint, bigint, date)
  from public, anon, authenticated, service_role;
-- == A payment on a change invoice ===========================================================
-- After the rollup (trigger names sort, 'rollup' before 'z_change'), so the invoice already
-- says whether it is paid. Paid in full: the change is made. Paid but no longer makeable, or
-- money for a voided change invoice (a payment that settled after the window closed): credit.
create or replace function app.billing_settle_change_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.billing_invoices%rowtype;
  q public.billing_change_quotes%rowtype;
  v text;
begin
  if new.invoice_id is null or new.deleted_at is not null or new.amount_incl_cents <= 0 then
    return null;
  end if;
  select * into i from public.billing_invoices where id = new.invoice_id;
  if not found or i.kind <> 'change' then
    return null;
  end if;
  select * into q from public.billing_change_quotes where invoice_id = i.id for update;
  if not found then
    return null;
  end if;

  if i.status = 'paid' then
    v := app.billing_apply_change(q.id);
    if v <> 'applied' then
      insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, quote_id, invoice_id, note)
      values (i.farm_id, i.subscription_id, 'granted', 'unapplied_payment', i.amount_paid_cents, q.id, i.id,
              'paid for a change that could no longer be made (' || v || ')')
      on conflict do nothing;
      update public.billing_change_quotes
         set status = 'credited', closed_at = now(), updated_at = now(),
             close_reason = 'paid after the change could no longer be made; the payment is account credit'
       where id = q.id and status in ('quoted', 'awaiting_payment', 'expired', 'cancelled');
    end if;
  elsif i.status in ('void', 'uncollectible') and new.provider <> 'credit' then
    insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, quote_id, payment_id, invoice_id, note)
    values (i.farm_id, i.subscription_id, 'granted', 'voided_invoice', new.amount_incl_cents, null, new.id, i.id,
            'paid after ' || i.invoice_ref || ' was closed')
    on conflict do nothing;
  end if;
  return null;
end $$;
revoke all on function app.billing_settle_change_payment() from public, anon, authenticated;
drop trigger if exists billing_payments_z_change on public.billing_payments;
create trigger billing_payments_z_change
  after insert on public.billing_payments
  for each row execute function app.billing_settle_change_payment();

-- == Closing an unpaid change invoice ========================================================
-- Voided, never left for anything to charge; credit spent on it comes back, and any other
-- money already on it becomes credit.
create or replace function app.billing_void_change_invoice(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.billing_invoices%rowtype;
  p record;
begin
  select * into i from public.billing_invoices where id = p_invoice for update;
  if not found or i.kind <> 'change' or i.status not in ('draft', 'open') then
    return;
  end if;
  for p in select * from public.billing_payments
            where invoice_id = i.id and deleted_at is null and amount_incl_cents > 0 loop
    if p.provider = 'credit' then
      insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, payment_id, invoice_id, note)
      values (i.farm_id, i.subscription_id, 'restored', 'voided_invoice', p.amount_incl_cents, p.id, i.id,
              'credit given back: ' || i.invoice_ref || ' closed unpaid')
      on conflict do nothing;
      update public.billing_payments
         set deleted_at = now(), reversal_reason = 'the change was not paid; the credit is back on the account'
       where id = p.id;
    else
      insert into public.billing_account_credits (farm_id, subscription_id, entry, source, amount_cents, payment_id, invoice_id, note)
      values (i.farm_id, i.subscription_id, 'granted', 'voided_invoice', p.amount_incl_cents, p.id, i.id,
              'part payment of ' || i.invoice_ref || ', closed unpaid')
      on conflict do nothing;
    end if;
  end loop;
  update public.billing_invoices
     set status = 'void', voided_at = now(), voided_reason = left(coalesce(p_reason, 'change not paid'), 300)
   where id = i.id;
end $$;
revoke all on function app.billing_void_change_invoice(uuid, text) from public, anon, authenticated, service_role;

-- == Cancelling a quote or a pending change =================================================
create or replace function app.billing_cancel_quote(p_quote uuid, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.billing_change_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
begin
  select * into q from public.billing_change_quotes where id = p_quote for update;
  if not found then
    raise exception 'quote-not-found' using errcode = '22023';
  end if;
  if not app.billing_actor_may_change(q.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.billing_subscriptions where id = q.subscription_id for update;

  if q.status = 'awaiting_payment' then
    if exists (select 1 from public.billing_payment_attempts a
                where a.invoice_id = q.invoice_id and a.status in ('pending', 'unknown')) then
      raise exception 'billing-in-flight' using errcode = '22023',
        hint = 'A payment for this change is still being processed.';
    end if;
    perform app.billing_void_change_invoice(q.invoice_id, 'cancelled by the customer before payment');
  elsif q.status = 'scheduled' then
    if q.change = 'plan' and s.pending_plan is not distinct from q.to_plan
       and s.pending_billing_period is not distinct from q.to_period then
      update public.billing_subscriptions
         set pending_plan = null, pending_billing_period = null, pending_plan_on = null,
             pending_plan_set_at = null, updated_at = now()
       where id = s.id;
    elsif q.change = 'capacity' and s.pending_quota is not distinct from q.to_full then
      update public.billing_subscriptions
         set pending_quota = null, pending_quota_on = null, pending_quota_set_at = null, updated_at = now()
       where id = s.id;
    end if;
  elsif q.status <> 'quoted' then
    raise exception 'quote-not-open' using errcode = '22023';
  end if;

  update public.billing_change_quotes
     set status = 'cancelled', closed_at = now(), closed_by = p_by,
         close_reason = 'cancelled by the customer', updated_at = now()
   where id = q.id;
  return jsonb_build_object('cancelled', true, 'quote_id', q.id, 'was', q.status);
end $$;
revoke all on function app.billing_cancel_quote(uuid, uuid) from public, anon, authenticated, service_role;

-- == Expiry, run by the billing cron =========================================================
create or replace function app.billing_expire_quotes() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_n integer := 0;
  v_rows integer;
begin
  update public.billing_change_quotes
     set status = 'expired', closed_at = now(), close_reason = 'not accepted in time', updated_at = now()
   where status = 'quoted' and expires_at <= now();
  get diagnostics v_rows = row_count;
  v_n := v_n + v_rows;

  for r in
    select q.id, q.invoice_id
      from public.billing_change_quotes q
     where q.status = 'awaiting_payment' and q.payment_due_by <= now()
       and not exists (select 1 from public.billing_payment_attempts a
                        where a.invoice_id = q.invoice_id and a.status in ('pending', 'unknown'))
     for update of q skip locked
  loop
    perform app.billing_void_change_invoice(r.invoice_id, 'not paid in time');
    update public.billing_change_quotes
       set status = 'expired', closed_at = now(), close_reason = 'not paid in time', updated_at = now()
     where id = r.id and status = 'awaiting_payment';
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function app.billing_expire_quotes() from public, anon, authenticated, service_role;

-- == The engine, restated where a change invoice must be treated differently ==================
-- Totals: a change invoice is the sum of its line, like a service invoice (otherwise A1's
-- 20261114090300 body unchanged).
create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged
             + coalesce(new.equipment_unit_incl_cents, 0) * coalesce(new.equipment_count, 0);

  -- A service invoice (20261029110000) and a change invoice (20261115110000) are the sum of
  -- their lines. A change was priced and accepted as one amount: no discount, no AI use.
  if new.kind in ('service', 'change') then
    new.discount_cents := 0;
    new.ai_usage_ex_vat_cents := 0;
    new.ai_usage_incl_cents := 0;
    new.total_incl_cents := coalesce(
      (select sum(l.line_total_incl_cents) from public.billing_invoice_lines l where l.invoice_id = new.id), 0);
    new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
    new.vat_cents := new.total_incl_cents - new.subtotal_ex_vat_cents;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' or new.status = 'draft' then
    v_discount := coalesce(
      app.billing_discount_cents(new.subscription_id, v_gross, new.period_start), 0);
    new.discount_cents := least(v_discount, v_gross);
    if new.discount_cents > 0 and new.discount_label is null then
      new.discount_label := (
        select coalesce(s.discount_label, s.discount_code)
          from public.billing_subscriptions s where s.id = new.subscription_id);
    end if;
  else
    new.discount_cents := least(coalesce(new.discount_cents, 0), v_gross);
  end if;

  new.ai_usage_ex_vat_cents := coalesce(new.ai_usage_ex_vat_cents, 0);
  new.ai_usage_incl_cents   := new.ai_usage_ex_vat_cents
    + round(new.ai_usage_ex_vat_cents::numeric * coalesce(new.vat_rate_bps, 0) / 10000)::bigint;

  new.total_incl_cents      := v_gross - new.discount_cents + new.ai_usage_incl_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;

-- The nightly card run never presents a change invoice: it is paid when the owner pays it
-- (20261029150000 body otherwise unchanged).
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
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
     and not fm.billing_exempt
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.deleted_at is null
     and i.status = 'open'
     and i.kind <> 'change'
     and i.total_incl_cents > i.amount_paid_cents
     and coalesce(i.due_on, i.issued_on, current_date) <= current_date
     and (
       (s.status in ('active', 'past_due')
          and coalesce(s.next_retry_on, current_date) <= current_date)
       or
       (s.status = 'grace'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
       or
       (s.status = 'suspended'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
     )
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;
revoke execute on function app.due_billing_charges(integer)
  from public, anon, authenticated, service_role;

-- Settling an attempt (20260910200000 body), with three rules added:
--   * A SUCCEEDED attempt is final. A late or out-of-order 'failed', 'abandoned', 'pending' or
--     'unknown' (a charge.failed delivered after the charge.success, a reconcile racing the
--     webhook) changes nothing. Money that came back is a refund, recorded by its own event.
--   * A failure starts the dunning ladder once, on the move into 'failed', never again for a
--     repeated failure report, and never for a change invoice: a declined extra is simply not
--     bought, the subscription stays as it was.
--   * A delayed success after a failure or an abandonment is still money received: recorded.
create or replace function app.settle_billing_attempt(
  p_attempt          uuid,
  p_status           billing_attempt_status,
  p_transaction_id   bigint default null,
  p_provider_ref     text default null,
  p_gateway_response text default null,
  p_failure_reason   text default null,
  p_paid_cents       bigint default null,
  p_channel          text default null,
  p_dun              boolean default true
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.billing_payment_attempts%rowtype;
  v_change boolean;
begin
  select * into a from public.billing_payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'BILLING: no such payment attempt %', p_attempt;
  end if;

  if a.status = 'succeeded' and p_status <> 'succeeded' then
    return;
  end if;

  update public.billing_payment_attempts
     set status = p_status,
         provider_transaction_id = coalesce(p_transaction_id, provider_transaction_id),
         provider_reference      = coalesce(p_provider_ref, provider_reference, attempt_ref),
         gateway_response        = coalesce(p_gateway_response, gateway_response),
         failure_reason          = coalesce(p_failure_reason, failure_reason),
         resolved_at             = case when p_status in ('succeeded','failed','abandoned')
                                        then now() else resolved_at end,
         updated_at              = now()
   where id = p_attempt;

  if p_status = 'succeeded' then
    insert into public.billing_payments (
      farm_id, invoice_id, attempt_id, amount_incl_cents,
      provider, provider_reference, provider_transaction_id, channel, paid_at
    ) values (
      a.farm_id, a.invoice_id, a.id, coalesce(p_paid_cents, a.amount_incl_cents),
      a.provider, coalesce(p_provider_ref, a.attempt_ref), p_transaction_id, p_channel, now()
    )
    on conflict do nothing;

    if a.subscription_id is not null then
      perform app.billing_restore_after_payment(a.subscription_id);
    end if;

    update public.billing_payment_methods
       set last_used_at = now() where id = a.payment_method_id;

  elsif p_status = 'failed' and a.status <> 'failed' and coalesce(p_dun, true) and a.subscription_id is not null then
    select exists (select 1 from public.billing_invoices i where i.id = a.invoice_id and i.kind = 'change')
      into v_change;
    if not v_change then
      perform app.billing_register_failure(a.subscription_id, p_failure_reason);
    end if;
  end if;
end $$;
revoke execute on function app.settle_billing_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text, boolean)
  from public, anon, authenticated;