-- 20260903160100_saas_billing_payments.sql
-- FleetWise SaaS subscription billing — the money-movement half.
--
-- Stored cards, charge attempts, payments received, and the durable record of every
-- webhook Paystack has sent us.
--
-- THE ONE THING THIS FILE IS REALLY ABOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- A Paystack `authorization_code` is not a reference. It is a CHARGING CREDENTIAL:
-- whoever holds it, together with our secret key, can take money from that customer's
-- card. It belongs in the same mental category as a password, and it must never reach
-- a browser, a log line, an error report or a support screenshot.
--
-- RLS cannot help here, because RLS filters ROWS and this is a COLUMN. What does the
-- job is a column-level grant: `authenticated` is granted SELECT on the display
-- columns and on nothing else, so the privilege system — not a convention, and not a
-- careful `select` list somebody might later widen to `*` — is what stops it being
-- read. `has_column_privilege()` makes that machine-checkable, and the isolation suite
-- checks it.
--
-- A consequence worth stating plainly: `select=*` against this table from a browser
-- session ERRORS rather than returning a partial row. That is the correct trade. An
-- error is a bug report; a silently-omitted column is a leak nobody notices.
--
-- Card data itself never comes near us. Paystack's hosted checkout collects it; we
-- receive a masked summary (brand, last four, expiry, bank) and the authorization
-- code. There is no column here that could hold a PAN or a CVV, deliberately.


-- ══════════════════════════════════════════════════════════════════════════════
-- Composite-FK anchors, so a payment cannot point at another farm's invoice
-- ══════════════════════════════════════════════════════════════════════════════
-- The house tenancy pattern (CLAUDE.md: "every business table carries farm_id,
-- enforced by composite FKs"). Without these, `farm_id` on a payment row would be a
-- claim; with them it is checked by the database.
create unique index billing_invoices_id_farm_uq on billing_invoices (id, farm_id);
create unique index billing_subscriptions_id_farm_uq on billing_subscriptions (id, farm_id);


-- ══════════════════════════════════════════════════════════════════════════════
-- A stored card
-- ══════════════════════════════════════════════════════════════════════════════
create table billing_payment_methods (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references farms(id) on delete cascade,
  provider              text not null default 'paystack',

  -- ── The sensitive half. Never granted to `authenticated`; see the header.
  --
  -- Paystack will only charge an authorization when it is presented with the SAME
  -- email the authorization was created against. Storing the email beside the code is
  -- therefore not duplication of `users.email` — it is part of the credential, and it
  -- must not follow a user who later changes their address.
  authorization_code    text,
  authorization_email   text,

  -- ── The display half. Everything a person needs to recognise their own card.
  card_brand            text,      -- visa | mastercard | …
  last4                 text,
  exp_month             text,
  exp_year              text,
  card_type             text,      -- credit | debit
  bank                  text,
  country_code          text,
  bin                   text,      -- issuer BIN. Not a PAN: six digits identifying the bank.
  signature             text,      -- Paystack's own fingerprint, for spotting the same card twice

  -- Paystack marks an authorization reusable only when it may be charged again. A
  -- one-off authorization (some 3DS flows, some cards) comes back `reusable: false`,
  -- and storing one as if it were a subscription card produces a farm that appears set
  -- up and then fails every renewal. We refuse those at the door, and this column is
  -- the record of that decision.
  reusable              boolean not null default false,

  paystack_customer_code text,
  paystack_customer_id   bigint,

  is_default            boolean not null default false,
  status                text not null default 'active',   -- active | inactive | removed
  last_used_at          timestamptz,
  removed_at            timestamptz,

  created_by            uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid references users(id),

  constraint billing_payment_methods_status_ck
    check (status in ('active','inactive','removed')),
  -- A stored authorization is only ever created from a VERIFIED transaction, and only
  -- when Paystack said it may be reused. This makes that a database rule rather than a
  -- branch in one route that a second route might forget.
  constraint billing_payment_methods_reusable_ck
    check (authorization_code is null or reusable),
  constraint billing_payment_methods_email_ck
    check (authorization_code is null or authorization_email is not null)
);

create unique index billing_payment_methods_id_farm_uq
  on billing_payment_methods (id, farm_id);
-- One default card per farm.
create unique index billing_payment_methods_default_uq
  on billing_payment_methods (farm_id)
  where is_default and deleted_at is null and status = 'active';
-- The same card added twice for the same farm is the same card.
create unique index billing_payment_methods_signature_uq
  on billing_payment_methods (farm_id, provider, signature)
  where signature is not null and deleted_at is null;
create index billing_payment_methods_farm_idx
  on billing_payment_methods (farm_id, status) where deleted_at is null;

comment on column billing_payment_methods.authorization_code is
  'PAYSTACK CHARGING CREDENTIAL. Not granted to `authenticated` at the column level; '
  'server-only, never logged, never returned to a browser. Treat as a password.';

alter table billing_subscriptions
  add constraint billing_subscriptions_default_pm_fk
  foreign key (default_payment_method_id, farm_id)
  references billing_payment_methods (id, farm_id) on delete set null;


-- ══════════════════════════════════════════════════════════════════════════════
-- Every attempt to take money, successful or not
-- ══════════════════════════════════════════════════════════════════════════════
-- The reference is minted HERE, in our database, BEFORE Paystack is contacted. That
-- ordering is the whole safety property of this table.
--
-- If the HTTP request to Paystack times out we do not know whether the customer was
-- charged. What we do know is the reference we would have used — so the recovery is to
-- ask Paystack about that exact reference (`transaction/verify`) rather than to try
-- again and risk taking the money twice. A row in `unknown` status is a standing
-- instruction to reconcile before doing anything else, and the charging worker refuses
-- to start a new attempt for an invoice that has one.
create table billing_payment_attempts (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references farms(id) on delete cascade,
  invoice_id        uuid,
  subscription_id   uuid,
  payment_method_id uuid,

  -- OUR reference, unique for all time, generated before the provider is called.
  attempt_ref       text not null,
  kind              billing_attempt_kind not null,
  status            billing_attempt_status not null default 'pending',
  attempt_number    integer not null default 1,

  amount_incl_cents bigint not null,
  currency          text not null default 'ZAR',

  provider              text not null default 'paystack',
  provider_reference    text,     -- what Paystack echoes back (normally == attempt_ref)
  provider_transaction_id bigint,
  -- Where the hosted checkout sent the customer. Not a credential, but not printed in
  -- logs either: it is a single-use payment URL.
  authorization_url     text,
  access_code           text,

  gateway_response  text,     -- Paystack's own words, e.g. "Insufficient funds"
  failure_reason    text,     -- ours, mapped to something a farmer can act on

  requested_at      timestamptz not null default now(),
  resolved_at       timestamptz,
  reconciled_at     timestamptz,
  -- Free-form notes from a reconciliation pass. Evidence, so it is never overwritten
  -- by the engine; only appended to.
  reconcile_note    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint billing_payment_attempts_amount_ck check (amount_incl_cents >= 0),
  constraint billing_payment_attempts_currency_ck check (currency = 'ZAR'),
  constraint billing_payment_attempts_number_ck check (attempt_number >= 1),
  constraint billing_payment_attempts_invoice_fk
    foreign key (invoice_id, farm_id) references billing_invoices (id, farm_id) on delete cascade,
  constraint billing_payment_attempts_sub_fk
    foreign key (subscription_id, farm_id) references billing_subscriptions (id, farm_id) on delete set null,
  constraint billing_payment_attempts_pm_fk
    foreign key (payment_method_id, farm_id) references billing_payment_methods (id, farm_id) on delete set null
);

create unique index billing_payment_attempts_ref_uq on billing_payment_attempts (attempt_ref);
create unique index billing_payment_attempts_txn_uq
  on billing_payment_attempts (provider, provider_transaction_id)
  where provider_transaction_id is not null;
-- At most ONE attempt in flight per invoice. Two workers racing to charge the same
-- invoice is the failure that takes money twice, and this index makes the second one
-- lose on a duplicate key rather than on hoping the first finished.
create unique index billing_payment_attempts_inflight_uq
  on billing_payment_attempts (invoice_id)
  where status in ('pending','unknown') and invoice_id is not null;
create index billing_payment_attempts_farm_idx
  on billing_payment_attempts (farm_id, requested_at desc);
create index billing_payment_attempts_unresolved_idx
  on billing_payment_attempts (status, requested_at)
  where status in ('pending','unknown');

comment on table billing_payment_attempts is
  'Immutable evidence of every charge attempt. The reference is minted before Paystack '
  'is contacted, so a lost HTTP response is reconciled by verifying that reference — '
  'never by charging again. Status `unknown` blocks all further attempts on the invoice.';


-- ══════════════════════════════════════════════════════════════════════════════
-- Money actually received
-- ══════════════════════════════════════════════════════════════════════════════
-- A refund or reversal is a NEGATIVE row, the same shape the partner ledger uses
-- (0422). A payment is never edited into a refund: both events happened, and both stay.
create table billing_payments (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references farms(id) on delete cascade,
  invoice_id        uuid,
  attempt_id        uuid references billing_payment_attempts(id) on delete set null,

  amount_incl_cents bigint not null,           -- negative = refund / reversal
  currency          text not null default 'ZAR',
  paid_at           timestamptz not null default now(),

  provider          text not null default 'paystack',
  provider_reference      text,
  provider_transaction_id bigint,
  channel           text,      -- card | bank | …
  note              text,

  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid references users(id),

  constraint billing_payments_currency_ck check (currency = 'ZAR'),
  constraint billing_payments_nonzero_ck check (amount_incl_cents <> 0),
  constraint billing_payments_invoice_fk
    foreign key (invoice_id, farm_id) references billing_invoices (id, farm_id) on delete cascade
);

-- A retried webhook delivery cannot credit the same transaction twice. This is a
-- database constraint and not a check in the route, because the route is exactly the
-- thing being delivered to more than once.
create unique index billing_payments_txn_uq
  on billing_payments (provider, provider_transaction_id)
  where provider_transaction_id is not null and deleted_at is null;
create unique index billing_payments_ref_uq
  on billing_payments (provider, provider_reference)
  where provider_reference is not null and deleted_at is null;
create index billing_payments_invoice_idx on billing_payments (invoice_id, paid_at)
  where deleted_at is null;
create index billing_payments_farm_idx on billing_payments (farm_id, paid_at desc)
  where deleted_at is null;


-- ══════════════════════════════════════════════════════════════════════════════
-- Every webhook Paystack has sent us
-- ══════════════════════════════════════════════════════════════════════════════
-- Persisted BEFORE it is acted on, and keyed so a redelivery is recognised. Paystack
-- redelivers on any non-2xx and sometimes simply redelivers; out-of-order arrival is
-- normal (a `charge.success` can land after the `transaction/verify` that already
-- recorded it).
--
-- There is no top-level event id in a Paystack webhook, so the key is computed by the
-- route from what is actually stable: the event name plus the transaction id, falling
-- back to a hash of the raw body. Storing it explicitly rather than deriving it in SQL
-- keeps the rule in one place — the route that holds the raw bytes.
--
-- NOT readable by any browser role, at all. A payload contains the customer's email
-- and the full authorization object. The admin screens read attempts and payments,
-- which are the same story with the credential taken out.
create table billing_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'paystack',
  dedupe_key        text not null,
  event_type        text not null,

  -- False is possible only for a rejected delivery we chose to record; the route
  -- verifies the signature BEFORE parsing, and refuses anything unsigned.
  signature_verified boolean not null default false,

  payload           jsonb,
  -- Resolved during processing where the event names a farm we recognise.
  farm_id           uuid references farms(id) on delete set null,
  invoice_id        uuid references billing_invoices(id) on delete set null,
  attempt_id        uuid references billing_payment_attempts(id) on delete set null,

  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  processing_error  text,
  -- How many times this exact event has been delivered. Useful evidence, and it makes
  -- a redelivery storm visible rather than silent.
  delivery_count    integer not null default 1
);

create unique index billing_webhook_events_dedupe_uq
  on billing_webhook_events (provider, dedupe_key);
create index billing_webhook_events_unprocessed_idx
  on billing_webhook_events (received_at) where processed_at is null;
create index billing_webhook_events_type_idx
  on billing_webhook_events (event_type, received_at desc);

comment on table billing_webhook_events is
  'Durable, idempotent record of provider webhooks. service_role ONLY — a payload holds '
  'the customer email and the full authorization object. Admin screens read '
  'billing_payment_attempts instead, which is the same story without the credential.';


-- ══════════════════════════════════════════════════════════════════════════════
-- Payments roll up onto the invoice. Nobody types a balance.
-- ══════════════════════════════════════════════════════════════════════════════
-- Same discipline as the partner ledger (0381): `amount_paid_cents` and the paid/open
-- status are DERIVED from the payment rows, so a refund recorded later moves the
-- invoice back automatically and there is exactly one path to a balance.
create or replace function app.billing_rollup_invoice_payments() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_invoice uuid; v_paid bigint; v_total bigint; v_status billing_invoice_status;
begin
  v_invoice := coalesce(new.invoice_id, old.invoice_id);
  if v_invoice is null then
    return coalesce(new, old);
  end if;

  select coalesce(sum(amount_incl_cents), 0) into v_paid
    from public.billing_payments
   where invoice_id = v_invoice and deleted_at is null;

  select total_incl_cents, status into v_total, v_status
    from public.billing_invoices where id = v_invoice;

  -- A void or written-off invoice keeps its status: a payment arriving against one is
  -- an event for a human to look at, not a reason to quietly reopen it.
  if v_status in ('void', 'uncollectible') then
    update public.billing_invoices
       set amount_paid_cents = v_paid, updated_at = now()
     where id = v_invoice;
    return coalesce(new, old);
  end if;

  update public.billing_invoices
     set amount_paid_cents = v_paid,
         status = case
                    when v_total > 0 and v_paid >= v_total then 'paid'::billing_invoice_status
                    when status = 'draft' then 'draft'::billing_invoice_status
                    else 'open'::billing_invoice_status
                  end,
         updated_at = now()
   where id = v_invoice;

  return coalesce(new, old);
end $$;
revoke execute on function app.billing_rollup_invoice_payments() from public, anon, authenticated;

create trigger billing_payments_rollup
  after insert or update or delete on billing_payments
  for each row execute function app.billing_rollup_invoice_payments();


-- ══════════════════════════════════════════════════════════════════════════════
-- RLS and grants
-- ══════════════════════════════════════════════════════════════════════════════

-- Attempts and payments: the owner may read their own history; nobody writes from a
-- browser. Both are evidence, and evidence a customer can edit is not evidence.
do $do$
declare t text;
begin
  foreach t in array array['billing_payment_attempts', 'billing_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (app.is_farm_billing_admin(farm_id))', t);
    -- See the long note in the core migration: 0102 set ALTER DEFAULT PRIVILEGES granting
    -- `authenticated` full CRUD on every future table in `public`, so not granting is not
    -- the same as not granted.
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format(
      'create trigger %1$I_audit after insert or update or delete on public.%1$I '
      'for each row execute function app_audit()', t);
  end loop;
end $do$;

-- ── The stored card: row scoping by RLS, COLUMN scoping by grant ──────────────
alter table billing_payment_methods enable row level security;
alter table billing_payment_methods force  row level security;
create policy billing_payment_methods_sel on billing_payment_methods
  for select to authenticated
  using (app.is_farm_billing_admin(farm_id) and deleted_at is null);

-- THE REVOKE IS THE WHOLE THING. `0102_grants.sql` runs
--
--     alter default privileges in schema public
--       grant select, insert, update, delete on tables to authenticated;
--
-- which means this table was born with `authenticated` holding SELECT on EVERY column,
-- including the authorization code. Enumerating a column grant without revoking first is
-- purely additive and buys nothing: measured before this line existed,
-- `has_column_privilege('authenticated', 'billing_payment_methods', 'authorization_code',
-- 'SELECT')` returned TRUE.
--
-- RLS does not save this one. RLS filters ROWS; the owner is legitimately entitled to
-- their own row, and the leak is a COLUMN of it.
revoke all on billing_payment_methods from authenticated;

-- Now grant back, column by column. `authorization_code` and `authorization_email` are
-- absent, so a column added to this table later defaults to INVISIBLE to the browser —
-- the right way round for a table holding a charging credential.
grant select (
  id, farm_id, provider,
  card_brand, last4, exp_month, exp_year, card_type, bank, country_code, bin,
  reusable, is_default, status, last_used_at, removed_at,
  created_at, updated_at
) on billing_payment_methods to authenticated;
grant all on billing_payment_methods to service_role;
create trigger billing_payment_methods_audit
  after insert or update or delete on billing_payment_methods
  for each row execute function app_audit();

-- ── Webhook events: service_role only. No policy for `authenticated` at all, and no
-- grant either, so this is a default-deny with nothing to misread.
alter table billing_webhook_events enable row level security;
alter table billing_webhook_events force  row level security;
-- No policy for `authenticated`, AND no grant. The default privileges from 0102 handed
-- this table full CRUD to every signed-in user the moment it was created, so the revoke is
-- what actually makes it service-role only.
revoke all on billing_webhook_events from authenticated;
grant all on billing_webhook_events to service_role;

-- Nothing anywhere in the billing schema is reachable by `anon`. Stated explicitly
-- rather than relying on the absence of a grant, because the property is load-bearing
-- and the isolation suite asserts it.
do $do$
declare t text;
begin
  foreach t in array array[
    'billing_settings','billing_price_versions','billing_subscriptions',
    'billing_asset_snapshots','billing_invoices','billing_invoice_lines',
    'billing_payment_methods','billing_payment_attempts','billing_payments',
    'billing_webhook_events'
  ] loop
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $do$;
