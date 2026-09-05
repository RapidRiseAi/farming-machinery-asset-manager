-- 20260903160000_saas_billing_core.sql
-- FleetWise SaaS subscription billing — the ledger half.
--
-- WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- This is FARMS PAYING RAPID RISE for FleetWise. One direction, one relationship:
-- our customer pays us for software.
--
-- It is NOT, and must never become, the money that moves between a farm and its
-- contractors, workshops or suppliers. That money is `partner_documents` /
-- `partner_payments` (F14/G1–G10) and FleetWise deliberately does not sit in the
-- middle of it — see the dormant PayFast seam in `src/lib/payments/*`, kept inert on
-- purpose. Nothing in this file touches those tables, and nothing in them may ever be
-- reached from here. If a later reader finds themselves joining `billing_invoices` to
-- `partner_documents`, the design has gone wrong.
--
-- Every table here carries the `billing_` prefix for exactly that reason: so the two
-- ledgers cannot be confused at a glance in a query, a backup or a stack trace.
--
-- WHERE SUBSCRIPTION STATE LIVES
-- ─────────────────────────────────────────────────────────────────────────────
-- Here. Not at the provider. Paystack moves money and nothing else: it holds no plan,
-- no price, no period and no entitlement. The reason is not preference — the amount
-- changes with the farm's active vehicle count, so a fixed provider-side "Plan" object
-- would be wrong the moment a farmer sells a tractor. We compute the amount, we raise
-- the invoice, we ask Paystack to charge a stored authorization.
--
-- THE TWO PLANS, AND WHY THERE ARE TWO
-- ─────────────────────────────────────────────────────────────────────────────
-- `farms.plan` is the EFFECTIVE plan. It is what `app.has_entitlement` (0251) and every
-- gated route in the product already resolve from, and this migration does not change
-- that by one character.
--
-- `billing_subscriptions.plan` is the COMMERCIAL plan — what the farm actually bought
-- and is billed for.
--
-- They are normally identical. They diverge in exactly one situation: a farm that has
-- not paid past its grace period is DOWNGRADED by writing a lower value into
-- `farms.plan`, while `billing_subscriptions.plan` keeps the plan they bought. Their
-- data is never touched, nothing is deleted, and the day the payment succeeds the prior
-- plan is copied back and every gate opens again.
--
-- Doing it this way means the downgrade needs no new entitlement code at all: every
-- gated surface, the SQL helper and the TS map keep working unchanged. A later reader
-- may be tempted to "simplify" by collapsing the two columns. Don't — that is the same
-- as losing the record of what the customer is owed on recovery.
--
-- VAT
-- ─────────────────────────────────────────────────────────────────────────────
-- Founder position at time of writing: Rapid Rise is NOT VAT-registered. So the rate is
-- zero, no VAT line appears, and an invoice must NOT be headed "Tax invoice" (VAT Act
-- s20(4) reserves that for a registered vendor). The machinery is nonetheless built in
-- full, because registering later must be a flag flip and must NOT restate a single
-- historical invoice.
--
-- This mirrors, deliberately, the shape already proven for partners in 0401
-- (`workshops.vat_registered` + a trigger forcing the rate to zero), so there is one
-- idea in this codebase about "an issuer who may not charge VAT", not two.
--
-- PRICING IS DELIBERATELY UNSEEDED
-- ─────────────────────────────────────────────────────────────────────────────
-- `docs/FLEETWISE_FOUNDER_DECISIONS.md` #1 says R44/R73/R89/R250. Shipped
-- `src/lib/entitlements.ts` says R39/R69/R99/POA. Both claim to be VAT-inclusive, so
-- only the numbers are in dispute. This migration creates the catalogue and inserts
-- NOTHING into it. With no `active` price version the invoice generator raises no
-- invoice and there is nothing to charge — the safest resting state for an unresolved
-- price. Seeding the confirmed table is one INSERT, later, by decision.


-- ══════════════════════════════════════════════════════════════════════════════
-- Enums
-- ══════════════════════════════════════════════════════════════════════════════

-- The PAYMENT lifecycle. Deliberately separate from `farm_status`
-- (trial/active/suspended/cancelled), which is the ACCOUNT's state and is used all over
-- the product for things that have nothing to do with money. Collapsing them would mean
-- a card decline could suspend an account, and an admin suspending an account would
-- look like a payment failure.
create type billing_subscription_status as enum (
  'trialing',     -- inside the free trial; nothing has been charged
  'active',       -- paid and current
  'past_due',     -- a charge failed; retries are still running
  'grace',        -- retries exhausted; still entitled, on borrowed time
  'downgraded',   -- grace expired; effective plan reduced, data intact
  'non_renewing', -- cancelled, but paid up to period end
  'cancelled'     -- ended
);

create type billing_invoice_status as enum (
  'draft',         -- being assembled; the ONLY state in which anything may be edited
  'open',          -- issued and payable
  'paid',
  'uncollectible', -- given up on; kept, never deleted
  'void'           -- raised in error; kept, never deleted
);

create type billing_attempt_status as enum (
  'pending',    -- reference minted, provider has not yet answered
  'succeeded',
  'failed',
  'abandoned',  -- customer never completed a hosted checkout
  'unknown'     -- the network died mid-request. MUST be reconciled before any retry.
);

create type billing_attempt_kind as enum (
  'initial_checkout',      -- hosted Paystack page, first payment, captures the card
  'charge_authorization',  -- scheduled recurring charge against a stored authorization
  'manual_retry'           -- an admin or owner asked for one
);

create type billing_price_status as enum ('draft', 'active', 'retired');


-- ══════════════════════════════════════════════════════════════════════════════
-- Who is issuing the invoice: Rapid Rise's own selling identity, and the policy
-- ══════════════════════════════════════════════════════════════════════════════
-- A single row. There is exactly one seller in this ledger, and pretending otherwise
-- would invite somebody to "support multiple sellers" and quietly turn this into the
-- marketplace the scope boundary forbids.
--
-- The one-row invariant is enforced by the DATABASE, not by convention: `singleton` is
-- pinned true by a check constraint and carries a unique index, so a second row is a
-- duplicate-key error rather than a bug discovered when two different addresses start
-- appearing on invoices.
--
-- `id` is a uuid, and that is load-bearing rather than habit: the shared `app_audit()`
-- trigger (0008) does `(to_jsonb(new) ->> 'id')::uuid` on every audited table. The
-- obvious cleverness here — a boolean primary key fixed to true — was written first and
-- made every UPDATE to this table fail with `invalid input syntax for type uuid: "true"`,
-- which is to say: the first time anybody edited the dunning policy. Audited tables in
-- this codebase have uuid ids. This one does too.
create table billing_settings (
  id                    uuid primary key default gen_random_uuid(),
  singleton             boolean not null default true,

  legal_name            text not null default 'Rapid Rise AI',
  trading_name          text,
  reg_number            text,

  -- See the VAT note in the header. False today; a flag flip later, and the trigger
  -- below makes sure nothing can issue VAT while it is false.
  vat_registered        boolean not null default false,
  vat_number            text,
  -- The rate to use ONCE registered. Kept editable because SA has moved it before
  -- (14%→15% in 2018) and gazetted a rise in 2025 that was then withdrawn.
  vat_rate_bps          integer not null default 1500,

  billing_address       text,
  billing_email         text,
  support_email         text,

  -- ── Dunning / lifecycle policy. PROPOSED DEFAULTS, ALL awaiting founder sign-off.
  -- They live in the database rather than in code so that changing a policy is a
  -- decision somebody makes and the audit log records, not a deploy nobody reviews.
  trial_days            integer not null default 14,
  -- Days after the first failure on which to retry. Three tries across a fortnight
  -- covers the overwhelmingly common causes (insufficient funds until payday, a card
  -- reissued, the bank's own outage) without becoming harassment.
  retry_offsets_days    integer[] not null default '{3,7,14}',
  -- After the last retry fails, how long they keep full access while we reach them.
  grace_days            integer not null default 7,
  -- Where a farm lands when grace expires. Their data is untouched; the gates close.
  downgrade_to_plan     farm_plan not null default 'essential',
  -- Cancellation takes effect at period end by default: they paid for the period.
  cancel_at_period_end  boolean not null default true,
  -- Annual plans: whether adding vehicles mid-term raises a pro-rata charge. Off until
  -- the founder decides — silently charging for a mid-year purchase is the fastest way
  -- to lose a customer's trust in their bill.
  prorate_annual_additions boolean not null default false,
  -- How many days after issue an invoice is due. Card subscriptions charge on issue, so
  -- this matters only for a farm paying by arrangement.
  payment_terms_days    integer not null default 7,

  updated_by            uuid references users(id),
  updated_at            timestamptz not null default now(),

  constraint billing_settings_singleton_ck check (singleton),
  -- A rate is only meaningful when registered; and a registered vendor needs a number
  -- on the document (VAT Act s20(4)).
  constraint billing_settings_vat_ck check (
    not vat_registered or (vat_number is not null and vat_rate_bps > 0)
  ),
  constraint billing_settings_trial_ck check (trial_days >= 0),
  constraint billing_settings_grace_ck check (grace_days >= 0),
  constraint billing_settings_terms_ck check (payment_terms_days >= 0)
);

insert into billing_settings (singleton) values (true);

-- Exactly one row, enforced. The check pins the column to true, so a unique index on it
-- admits precisely one.
create unique index billing_settings_one_row_uq on billing_settings (singleton);

comment on table billing_settings is
  'Rapid Rise''s own selling identity plus the subscription-billing policy constants '
  '(trial, retry schedule, grace, downgrade target, cancellation timing, proration). '
  'Exactly one row. Policy values are PROPOSED DEFAULTS awaiting founder sign-off.';
comment on column billing_settings.vat_registered is
  'False = FleetWise may not charge VAT. Enforced by app.billing_force_vat_rate on '
  'billing_invoices, mirroring the partner-side guard in 0401 so there is one rule.';


-- ══════════════════════════════════════════════════════════════════════════════
-- The price catalogue — versioned, and immutable once it has been used
-- ══════════════════════════════════════════════════════════════════════════════
-- One row per (version, plan, billing period). A version is a named generation of the
-- price list ("launch-2026"), so "what did we charge in March" is answerable from the
-- invoice alone and does not depend on the catalogue still looking the way it did.
--
-- Prices here are VAT-INCLUSIVE (founder decision #1): the displayed price is the price
-- paid. The ex-VAT subtotal and the VAT amount are DERIVED from it on the invoice,
-- exactly as `exVatCents`/`vatOfInclCents` do in `src/lib/money.ts`.
create table billing_price_versions (
  id                uuid primary key default gen_random_uuid(),
  version_label     text not null,
  plan              farm_plan not null,
  billing_period    billing_period not null,

  -- Per vehicle, per month, VAT-INCLUSIVE, integer cents.
  -- NULL means price on application (a bespoke plan): it can be displayed, and it can
  -- never be auto-invoiced, which is the correct behaviour for a negotiated price.
  per_vehicle_monthly_incl_cents bigint,

  -- Annual pre-pay = two months free, so an annual invoice charges 10 months. Stored
  -- per row rather than assumed, so the offer can change without rewriting history or
  -- hunting for a constant.
  months_charged    integer not null,

  -- The VAT rate this price was set under. Snapshotted onto the invoice so a future
  -- rate change cannot restate a past bill.
  vat_rate_bps      integer not null default 0,

  status            billing_price_status not null default 'draft',
  effective_from    date,
  effective_to      date,
  notes             text,

  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid references users(id),

  constraint billing_price_versions_months_ck check (months_charged between 1 and 12),
  constraint billing_price_versions_amount_ck check (
    per_vehicle_monthly_incl_cents is null or per_vehicle_monthly_incl_cents >= 0
  ),
  constraint billing_price_versions_rate_ck check (vat_rate_bps between 0 and 10000),
  -- A monthly row charges one month; an annual row charges the pre-pay term.
  constraint billing_price_versions_period_months_ck check (
    (billing_period = 'monthly' and months_charged = 1)
    or (billing_period = 'annual' and months_charged between 1 and 12)
  ),
  constraint billing_price_versions_window_ck check (
    effective_to is null or effective_from is null or effective_to >= effective_from
  )
);

-- At most ONE active price per plan+period at a time. This is the constraint that makes
-- "which price applies right now" a question with one answer, rather than a query that
-- happens to return the row you expected.
create unique index billing_price_versions_active_uq
  on billing_price_versions (plan, billing_period)
  where status = 'active' and deleted_at is null;

create unique index billing_price_versions_label_uq
  on billing_price_versions (version_label, plan, billing_period)
  where deleted_at is null;

create index billing_price_versions_status_idx
  on billing_price_versions (status, plan, billing_period) where deleted_at is null;

comment on table billing_price_versions is
  'Versioned per-vehicle-per-month price list, VAT-INCLUSIVE cents. DELIBERATELY EMPTY: '
  'the founder document (R44/R73/R89/R250) and shipped entitlements.ts (R39/R69/R99/POA) '
  'disagree, so no active version exists and therefore nothing can be invoiced or '
  'charged. Seeding the confirmed table is one INSERT.';


-- ══════════════════════════════════════════════════════════════════════════════
-- The subscription
-- ══════════════════════════════════════════════════════════════════════════════
create table billing_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references farms(id) on delete cascade,

  -- The COMMERCIAL plan: what they bought. See the header — this is NOT the plan
  -- entitlements resolve from, and it survives a non-payment downgrade so recovery can
  -- restore exactly what they are owed.
  plan                  farm_plan not null,
  billing_period        billing_period not null default 'monthly',
  status                billing_subscription_status not null default 'trialing',

  -- Which generation of the price list this subscription is held at. A price rise does
  -- not silently reprice an existing customer: moving them is a deliberate write.
  price_version_label   text,

  trial_ends_on         date,
  -- The day of the month charges land on. Held explicitly so it does not drift when a
  -- month is short — a farm anchored on the 31st and billed on 28 February must still
  -- be the 31st in March.
  anchor_day            integer,
  current_period_start  date,
  current_period_end    date,
  next_billing_on       date,

  default_payment_method_id uuid,     -- FK added in the payments migration
  paystack_customer_code    text,     -- provider handle, not a credential

  -- Cancellation. Default is period-end: they paid for the period.
  cancel_at_period_end  boolean not null default false,
  cancellation_reason   text,
  cancelled_at          timestamptz,
  ended_on              date,

  -- Dunning state.
  failed_attempt_count  integer not null default 0,
  last_failure_code     text,
  last_failure_at       timestamptz,
  next_retry_on         date,
  grace_ends_on         date,
  -- What `farms.plan` held before a downgrade, so recovery restores the exact prior
  -- state rather than inferring it from the commercial plan.
  plan_before_downgrade farm_plan,
  downgraded_at         timestamptz,

  created_by            uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid references users(id),

  constraint billing_subscriptions_anchor_ck check (anchor_day is null or anchor_day between 1 and 31),
  constraint billing_subscriptions_period_ck check (
    current_period_end is null or current_period_start is null
    or current_period_end >= current_period_start
  ),
  constraint billing_subscriptions_failed_ck check (failed_attempt_count >= 0)
);

-- One live subscription per farm. A farm with two subscriptions is a farm that gets
-- billed twice, so this is a constraint and not a convention.
create unique index billing_subscriptions_farm_uq
  on billing_subscriptions (farm_id) where deleted_at is null;
create index billing_subscriptions_due_idx
  on billing_subscriptions (next_billing_on)
  where deleted_at is null and status in ('active','past_due','trialing');
create index billing_subscriptions_retry_idx
  on billing_subscriptions (next_retry_on)
  where deleted_at is null and status = 'past_due';
create index billing_subscriptions_grace_idx
  on billing_subscriptions (grace_ends_on) where deleted_at is null and status = 'grace';

comment on column billing_subscriptions.plan is
  'The COMMERCIAL plan the farm bought. `farms.plan` is the EFFECTIVE plan that drives '
  'entitlements. They differ only while a farm is downgraded for non-payment; recovery '
  'restores farms.plan from plan_before_downgrade. Do not collapse these two columns.';


-- ══════════════════════════════════════════════════════════════════════════════
-- What we counted, and when
-- ══════════════════════════════════════════════════════════════════════════════
-- A bill that says "37 vehicles" must be answerable months later, after tractors have
-- been sold and bought. The snapshot is the evidence.
create table billing_asset_snapshots (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null references farms(id) on delete cascade,
  subscription_id uuid references billing_subscriptions(id) on delete set null,
  captured_on     date not null default current_date,
  asset_count     integer not null,
  -- 'nightly' | 'period_close' | 'manual'. Free text rather than an enum because this
  -- is evidence, and evidence that refuses to record an unexpected source is worse than
  -- evidence that records it plainly.
  source          text not null default 'nightly',
  created_at      timestamptz not null default now(),
  constraint billing_asset_snapshots_count_ck check (asset_count >= 0)
);

create unique index billing_asset_snapshots_day_uq
  on billing_asset_snapshots (farm_id, captured_on, source);
create index billing_asset_snapshots_farm_idx
  on billing_asset_snapshots (farm_id, captured_on desc);


-- ══════════════════════════════════════════════════════════════════════════════
-- The invoice — every figure snapshotted, and then frozen
-- ══════════════════════════════════════════════════════════════════════════════
create table billing_invoices (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references farms(id) on delete restrict,
  subscription_id   uuid references billing_subscriptions(id) on delete set null,

  -- Immutable, human-quotable, unique for the life of the system.
  invoice_ref       text not null,
  status            billing_invoice_status not null default 'draft',

  period_start      date not null,
  period_end        date not null,
  issued_on         date,
  due_on            date,

  -- ── The snapshot. Every one of these is copied at issue time and never recomputed. A
  -- price change next year must not be able to restate this bill.
  plan              farm_plan not null,
  billing_period    billing_period not null,
  asset_count       integer not null,
  unit_price_incl_cents bigint not null,       -- per vehicle per month, VAT-inclusive
  months_charged    integer not null,
  price_version_id  uuid references billing_price_versions(id) on delete restrict,
  price_version_label text not null,
  vat_rate_bps      integer not null,
  -- Our VAT number AT ISSUE TIME (null while unregistered), and the rest of the selling
  -- identity, so a later rebrand or registration cannot rewrite a past bill.
  seller_vat_number text,
  seller_snapshot   jsonb not null default '{}'::jsonb,
  -- Who it was billed to, likewise frozen: a farm that moves premises next year must
  -- not silently restate last year's invoice.
  bill_to_snapshot  jsonb not null default '{}'::jsonb,

  -- ── Money. Integer cents, always. VAT-inclusive is the source figure (it is what the
  -- customer agreed to pay); the ex-VAT subtotal and VAT amount are derived from it by
  -- app.ex_vat_cents / app.vat_of_incl_cents, which mirror src/lib/money.ts.
  subtotal_ex_vat_cents bigint not null default 0,
  vat_cents             bigint not null default 0,
  total_incl_cents      bigint not null default 0,
  amount_paid_cents     bigint not null default 0,
  currency              text not null default 'ZAR',

  notes             text,
  voided_reason     text,
  voided_at         timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid references users(id),

  constraint billing_invoices_period_ck check (period_end >= period_start),
  constraint billing_invoices_months_ck check (months_charged between 1 and 12),
  constraint billing_invoices_count_ck check (asset_count >= 0),
  constraint billing_invoices_currency_ck check (currency = 'ZAR'),
  constraint billing_invoices_amounts_ck check (
    subtotal_ex_vat_cents >= 0 and vat_cents >= 0 and total_incl_cents >= 0
  ),
  -- The identity that must hold on every row, checked by the database rather than
  -- trusted from whoever wrote it.
  constraint billing_invoices_split_ck check (
    subtotal_ex_vat_cents + vat_cents = total_incl_cents
  )
);

create unique index billing_invoices_ref_uq on billing_invoices (invoice_ref);
-- One invoice per farm per period. This is the constraint that makes a double-fired
-- cron, a retry and a manual "raise it now" all safe: the second one is a duplicate
-- key, not a second bill.
create unique index billing_invoices_farm_period_uq
  on billing_invoices (farm_id, period_start, period_end)
  where deleted_at is null and status <> 'void';
create index billing_invoices_farm_idx on billing_invoices (farm_id, period_start desc)
  where deleted_at is null;
create index billing_invoices_open_idx on billing_invoices (status, due_on)
  where deleted_at is null and status = 'open';

comment on table billing_invoices is
  'A FleetWise SaaS invoice: a farm being billed by Rapid Rise for software. NOT a '
  'contractor''s invoice to their customer (that is partner_documents). Every pricing '
  'input is snapshotted and frozen at issue by app.billing_freeze_invoice.';


create table billing_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references billing_invoices(id) on delete cascade,
  farm_id           uuid not null references farms(id) on delete cascade,
  sort_order        integer not null default 0,
  description       text not null,
  -- Quantity is the billable vehicle count for the line.
  qty               integer not null default 1,
  months_charged    integer not null default 1,
  unit_price_incl_cents bigint not null default 0,
  line_total_incl_cents bigint not null default 0,
  line_ex_vat_cents     bigint not null default 0,
  line_vat_cents        bigint not null default 0,
  created_at        timestamptz not null default now(),
  constraint billing_invoice_lines_qty_ck check (qty >= 0),
  constraint billing_invoice_lines_split_ck check (
    line_ex_vat_cents + line_vat_cents = line_total_incl_cents
  )
);

create index billing_invoice_lines_parent_idx on billing_invoice_lines (invoice_id, sort_order);


-- ══════════════════════════════════════════════════════════════════════════════
-- VAT arithmetic, mirroring src/lib/money.ts exactly
-- ══════════════════════════════════════════════════════════════════════════════
-- The screen, the invoice row and the charge amount are read by the same person in the
-- same minute. If SQL and TypeScript round differently, all three are useless.
-- `round()` in Postgres on numeric is half-away-from-zero, which is what JavaScript's
-- Math.round does for the non-negative amounts money is made of here.
create or replace function app.ex_vat_cents(p_incl bigint, p_rate_bps integer)
returns bigint language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_rate_bps is null or p_rate_bps <= 0 then p_incl
    else round((p_incl::numeric * 10000) / (10000 + p_rate_bps))::bigint
  end;
$$;

create or replace function app.vat_of_incl_cents(p_incl bigint, p_rate_bps integer)
returns bigint language sql immutable set search_path = public, pg_temp as $$
  select p_incl - app.ex_vat_cents(p_incl, p_rate_bps);
$$;

revoke execute on function app.ex_vat_cents(bigint, integer)      from public, anon;
revoke execute on function app.vat_of_incl_cents(bigint, integer) from public, anon;
grant  execute on function app.ex_vat_cents(bigint, integer)      to authenticated, service_role;
grant  execute on function app.vat_of_incl_cents(bigint, integer) to authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- The VAT guard — a rate we may not charge cannot be written
-- ══════════════════════════════════════════════════════════════════════════════
-- Same reasoning as 0401 on the partner side: a stale form, an import or a bug must not
-- be able to issue VAT on behalf of an unregistered vendor. This runs BEFORE the totals
-- are derived, so the split is computed from the CORRECTED rate — the ordering mistake
-- 0403 had to go back and fix on the partner side, where the guard sorted after the
-- totals trigger and a stale form could still issue VAT.
create or replace function app.billing_force_vat_rate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_registered boolean; v_number text;
begin
  select vat_registered, vat_number into v_registered, v_number
    from public.billing_settings where singleton;
  if not coalesce(v_registered, false) then
    new.vat_rate_bps := 0;
    new.seller_vat_number := null;
  elsif new.seller_vat_number is null then
    new.seller_vat_number := v_number;
  end if;
  return new;
end $$;
revoke execute on function app.billing_force_vat_rate() from public, anon, authenticated;

-- Derive the money from the snapshot, so no caller can write a total that disagrees
-- with the inputs printed beside it.
create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.total_incl_cents      := new.unit_price_incl_cents * new.asset_count * new.months_charged;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Freezing an issued invoice
-- ══════════════════════════════════════════════════════════════════════════════
-- Once an invoice leaves `draft` it is a statement about a period that has been billed.
-- What may still change is what has been PAID against it, and whether it has been
-- voided or written off — nothing about the supply itself.
--
-- The guarantee is not "cannot change"; it is "cannot change without leaving a record".
-- Voiding is allowed and keeps the row and its reason. Deleting is not.
create or replace function app.billing_freeze_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'BILLING: invoice % has been issued and cannot be deleted (void it instead)',
        old.invoice_ref using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'draft' then
    return new;   -- a draft is still being assembled
  end if;

  if new.invoice_ref       is distinct from old.invoice_ref
     or new.farm_id        is distinct from old.farm_id
     or new.period_start   is distinct from old.period_start
     or new.period_end     is distinct from old.period_end
     or new.plan           is distinct from old.plan
     or new.billing_period is distinct from old.billing_period
     or new.asset_count    is distinct from old.asset_count
     or new.unit_price_incl_cents is distinct from old.unit_price_incl_cents
     or new.months_charged is distinct from old.months_charged
     or new.price_version_id      is distinct from old.price_version_id
     or new.price_version_label   is distinct from old.price_version_label
     or new.vat_rate_bps          is distinct from old.vat_rate_bps
     or new.seller_vat_number     is distinct from old.seller_vat_number
     or new.subtotal_ex_vat_cents is distinct from old.subtotal_ex_vat_cents
     or new.vat_cents             is distinct from old.vat_cents
     or new.total_incl_cents      is distinct from old.total_incl_cents
     or new.currency              is distinct from old.currency then
    raise exception
      'BILLING: invoice % is issued; its pricing snapshot is immutable (status/payment/void may still change)',
      old.invoice_ref using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.billing_freeze_invoice() from public, anon, authenticated;

-- A line belongs to the invoice's snapshot, so it freezes with it.
create or replace function app.billing_freeze_invoice_line() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status billing_invoice_status;
begin
  select status into v_status from public.billing_invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status is not null and v_status <> 'draft' then
    raise exception 'BILLING: invoice lines are immutable once the invoice is issued'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function app.billing_freeze_invoice_line() from public, anon, authenticated;

-- Order matters, and BEFORE triggers on the same event fire in NAME order. The `a_`/
-- `b_`/`c_` prefixes make that explicit instead of accidental: VAT guard, then derive
-- the split from the corrected rate, then check nothing frozen moved.
create trigger a_billing_invoices_vat_guard
  before insert or update on billing_invoices
  for each row execute function app.billing_force_vat_rate();

create trigger b_billing_invoices_totals
  before insert or update on billing_invoices
  for each row execute function app.billing_derive_invoice_totals();

create trigger c_billing_invoices_freeze
  before update or delete on billing_invoices
  for each row execute function app.billing_freeze_invoice();

create trigger billing_invoice_lines_freeze
  before insert or update or delete on billing_invoice_lines
  for each row execute function app.billing_freeze_invoice_line();

-- A price row that has been used is history. Retiring it is a status change; changing
-- what it says is a rewrite of every invoice that points at it.
create or replace function app.billing_freeze_price_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.billing_invoices where price_version_id = old.id) then
      raise exception 'BILLING: price version % is referenced by an invoice and cannot be deleted',
        old.version_label using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'draft'
     and (new.per_vehicle_monthly_incl_cents is distinct from old.per_vehicle_monthly_incl_cents
          or new.months_charged is distinct from old.months_charged
          or new.vat_rate_bps   is distinct from old.vat_rate_bps
          or new.plan           is distinct from old.plan
          or new.billing_period is distinct from old.billing_period) then
    raise exception
      'BILLING: price version % is no longer a draft; retire it and add a new version instead',
      old.version_label using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.billing_freeze_price_version() from public, anon, authenticated;

create trigger billing_price_versions_freeze
  before update or delete on billing_price_versions
  for each row execute function app.billing_freeze_price_version();


-- ══════════════════════════════════════════════════════════════════════════════
-- Who may touch billing
-- ══════════════════════════════════════════════════════════════════════════════
-- Owners and Rapid Rise administrators. Not managers, not mechanics, not operators,
-- and emphatically not workshop users — a contractor with an active link to a farm has
-- legitimate access to that farm's VEHICLES (F16 narrows even that) and no business
-- whatsoever seeing what the farm pays Rapid Rise.
--
-- `app.effective_farm_role` is per-selected-farm and already answers rr_admin,
-- multi-site membership and the workshop case correctly (it returns null for a
-- workshop), so the rule is expressed once, here.
create or replace function app.is_farm_billing_admin(p_farm uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role user_role;
begin
  if p_farm is null or auth.uid() is null then
    return false;
  end if;
  v_role := app.effective_farm_role(auth.uid(), p_farm);
  return v_role in ('owner', 'rr_admin');
end $$;
revoke execute on function app.is_farm_billing_admin(uuid) from public, anon;
grant  execute on function app.is_farm_billing_admin(uuid) to authenticated, service_role;

comment on function app.is_farm_billing_admin(uuid) is
  'Billing is the owner''s business and Rapid Rise''s. Managers, mechanics, operators '
  'and workshop users are excluded — a linked contractor must never read what the farm '
  'pays for its software.';


-- ── Farm-scoped billing tables: read for the owner, write for nobody but the server ──
-- Writes are service-role only ON PURPOSE. Every row in these tables is created by the
-- billing engine or by a verified provider event; there is no legitimate browser path
-- that mints an invoice or records a payment, and leaving one open would be the whole
-- attack. Owner-initiated actions (start checkout, cancel, retry) go through server
-- actions and routes that re-check the role and then act as the service role.
--
-- THE REVOKE IS NOT DECORATION. `0102_grants.sql` contains
--
--     alter default privileges in schema public
--       grant select, insert, update, delete on tables to authenticated;
--
-- so EVERY table created in `public` after that migration is born with full CRUD granted
-- to `authenticated`. Writing "we simply do not grant it" is therefore true of the
-- statement and false of the database. Row-level security still refuses the writes (these
-- tables are FORCE RLS with a SELECT policy and nothing else, so an INSERT matches no
-- permissive policy and is denied) — but relying on that alone leaves exactly one lock
-- between a customer and their own invoice ledger, and RLS is the wrong lock for the
-- COLUMN problem on billing_payment_methods next door.
--
-- So: revoke what the default privileges handed out, then grant back precisely what is
-- meant. Two independent locks, which is the same reasoning as the `_perm` policy guards
-- in 20260829130100.
do $do$
declare t text;
begin
  foreach t in array array[
    'billing_subscriptions',
    'billing_asset_snapshots',
    'billing_invoices',
    'billing_invoice_lines'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (app.is_farm_billing_admin(farm_id))', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format(
      'create trigger %1$I_audit after insert or update or delete on public.%1$I '
      'for each row execute function app_audit()', t);
  end loop;
end $do$;

-- The catalogue and the seller identity are not farm-scoped: they are the same for
-- everyone and appear on the customer's own invoice. Readable by any signed-in user
-- (so the pricing page and the billing screen can render), writable only by RR admin.
alter table billing_price_versions enable row level security;
alter table billing_price_versions force  row level security;
create policy billing_price_versions_sel on billing_price_versions
  for select to authenticated using (deleted_at is null);
create policy billing_price_versions_ins on billing_price_versions
  for insert to authenticated with check (app.is_rr_admin());
create policy billing_price_versions_upd on billing_price_versions
  for update to authenticated using (app.is_rr_admin()) with check (app.is_rr_admin());
-- Revoke the 0102 default-privilege CRUD first, then grant back exactly the three the
-- policies above are written for. Without the revoke, DELETE would still be granted.
revoke all on billing_price_versions from authenticated;
grant select, insert, update on billing_price_versions to authenticated;
grant all on billing_price_versions to service_role;
create trigger billing_price_versions_audit
  after insert or update or delete on billing_price_versions
  for each row execute function app_audit();

alter table billing_settings enable row level security;
alter table billing_settings force  row level security;
create policy billing_settings_sel on billing_settings
  for select to authenticated using (true);
create policy billing_settings_upd on billing_settings
  for update to authenticated using (app.is_rr_admin()) with check (app.is_rr_admin());
revoke all on billing_settings from authenticated;
grant select, update on billing_settings to authenticated;
grant all on billing_settings to service_role;
create trigger billing_settings_audit
  after insert or update or delete on billing_settings
  for each row execute function app_audit();
