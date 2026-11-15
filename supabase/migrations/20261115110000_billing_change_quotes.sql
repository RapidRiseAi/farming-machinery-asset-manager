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
