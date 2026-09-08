-- 20260907120000_billing_receipts.sql
-- Telling the customer, exactly once.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- A farm paid R219 and FleetWise sent them nothing. The only receipt they got was
-- Paystack's, which carries the payment reference and the amount and nothing else: not
-- our invoice number, not the period, not "3 vehicles at R73", not the registration
-- number of the company charging them, not the fact that no VAT applies. If they query
-- the charge in six months, that email will not settle it and neither will their bank
-- statement.
--
-- And on the other side: when a renewal FAILS, the farm currently learns about it only
-- if they happen to open /billing. The dunning engine writes an in-app alert, which is
-- worth nothing to a farmer who is not logged in and whose access is about to narrow.
--
-- EXACTLY ONCE, AND WHY IT NEEDS A CLAIM
-- ─────────────────────────────────────────────────────────────────────────────
-- A success is settled from more than one place. The live test proved it: the webhook
-- arrived and the callback verified the same transaction 0.558 seconds apart, both
-- reporting success. billing_payments_txn_uq already stops the money being counted
-- twice; nothing stopped the EMAIL going twice.
--
-- So sending is claimed the same way charging is: the claim IS the write. A conditional
-- UPDATE that stamps the column only where it is still null returns a row to exactly one
-- caller, and the loser sends nothing. No advisory lock, no "check then send" window.
--
-- A failed send releases the claim (stamping receipt_error and clearing the timestamp),
-- so the nightly pass retries it. A receipt nobody received must not look sent.

alter table billing_invoices
  add column if not exists receipt_sent_at timestamptz,
  add column if not exists receipt_error   text;

comment on column billing_invoices.receipt_sent_at is
  'When the customer was emailed their receipt. Claimed by app.claim_billing_receipt, '
  'which is what makes sending exactly-once across the webhook/verify race.';

alter table billing_payment_attempts
  add column if not exists notified_at timestamptz;

comment on column billing_payment_attempts.notified_at is
  'When the farm was emailed about this FAILED attempt. Per attempt, not per week: a '
  'farmer should hear about each retry that did not go through, because each one moves '
  'them closer to losing access.';

-- Paid, and not yet receipted. Ordered oldest first so a backlog drains in the order it
-- was created rather than newest-first.
create index if not exists billing_invoices_receipt_due_idx
  on billing_invoices (created_at)
  where deleted_at is null and status = 'paid' and receipt_sent_at is null;

create index if not exists billing_payment_attempts_notify_due_idx
  on billing_payment_attempts (requested_at)
  where status = 'failed' and notified_at is null;

-- ── Claiming ─────────────────────────────────────────────────────────────────

create or replace function app.claim_billing_receipt(p_invoice uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update public.billing_invoices
     set receipt_sent_at = now(), receipt_error = null
   where id = p_invoice
     and deleted_at is null
     and status = 'paid'
     and receipt_sent_at is null
  returning id into v_id;
  return v_id is not null;
end $$;

comment on function app.claim_billing_receipt(uuid) is
  'True to exactly one caller. Returning false is the normal answer for the loser of the '
  'webhook/verify race and must never be treated as an error.';

-- Hand the claim back when the send failed, so the nightly pass tries again. The error is
-- kept: a bounce nobody can see leaves us believing the customer was told.
create or replace function app.release_billing_receipt(p_invoice uuid, p_error text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.billing_invoices
     set receipt_sent_at = null, receipt_error = left(coalesce(p_error, 'send failed'), 300)
   where id = p_invoice;
$$;

create or replace function app.claim_billing_failure_notice(p_attempt uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update public.billing_payment_attempts
     set notified_at = now()
   where id = p_attempt
     and status = 'failed'
     and notified_at is null
  returning id into v_id;
  return v_id is not null;
end $$;

-- ── What still needs telling ─────────────────────────────────────────────────
--
-- Both resolve the recipient the same way billingContactEmail does in TypeScript: the
-- farm's billing address if it has one, else its owner. So the email goes to the address
-- the charge was made against, not to whichever user happened to trigger the pass.

create or replace function app.billing_receipts_due(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, invoice_ref text, total_incl_cents bigint,
  recipient_email text, farm_name text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.farm_id, i.invoice_ref, i.total_incl_cents,
         coalesce(
           f.billing_email,
           (select u.email from public.users u
             where u.farm_id = i.farm_id and u.role = 'owner' and u.active
               and u.deleted_at is null order by u.created_at limit 1)
         ),
         f.name
    from public.billing_invoices i
    join public.farms f on f.id = i.farm_id
   where i.deleted_at is null
     and i.status = 'paid'
     and i.receipt_sent_at is null
   order by i.created_at
   limit greatest(p_limit, 0);
$$;

create or replace function app.billing_failure_notices_due(p_limit integer default 50)
returns table (
  attempt_id uuid, invoice_id uuid, farm_id uuid, invoice_ref text,
  amount_incl_cents bigint, failure_reason text, recipient_email text, farm_name text,
  next_retry_on date, grace_ends_on date
)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, a.invoice_id, a.farm_id, i.invoice_ref,
         a.amount_incl_cents, coalesce(a.failure_reason, a.gateway_response),
         coalesce(
           f.billing_email,
           (select u.email from public.users u
             where u.farm_id = a.farm_id and u.role = 'owner' and u.active
               and u.deleted_at is null order by u.created_at limit 1)
         ),
         f.name, s.next_retry_on, s.grace_ends_on
    from public.billing_payment_attempts a
    join public.farms f on f.id = a.farm_id
    left join public.billing_invoices i on i.id = a.invoice_id
    left join public.billing_subscriptions s on s.id = a.subscription_id
   where a.status = 'failed'
     and a.notified_at is null
   order by a.requested_at
   limit greatest(p_limit, 0);
$$;

-- ── PostgREST wrappers: service_role alone ───────────────────────────────────

create or replace function public.billing_claim_receipt(p_invoice uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select app.claim_billing_receipt(p_invoice);
$$;

create or replace function public.billing_release_receipt(p_invoice uuid, p_error text default null)
returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.release_billing_receipt(p_invoice, p_error);
$$;

create or replace function public.billing_claim_failure_notice(p_attempt uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select app.claim_billing_failure_notice(p_attempt);
$$;

create or replace function public.billing_receipts_due(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, invoice_ref text, total_incl_cents bigint,
  recipient_email text, farm_name text
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.billing_receipts_due(p_limit);
$$;

create or replace function public.billing_failure_notices_due(p_limit integer default 50)
returns table (
  attempt_id uuid, invoice_id uuid, farm_id uuid, invoice_ref text,
  amount_incl_cents bigint, failure_reason text, recipient_email text, farm_name text,
  next_retry_on date, grace_ends_on date
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.billing_failure_notices_due(p_limit);
$$;

do $do$
declare f text;
begin
  foreach f in array array[
    'public.billing_claim_receipt(uuid)',
    'public.billing_release_receipt(uuid, text)',
    'public.billing_claim_failure_notice(uuid)',
    'public.billing_receipts_due(integer)',
    'public.billing_failure_notices_due(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant  execute on function %s to service_role', f);
  end loop;
end $do$;

-- The engine functions stay owner-only: reached through the wrappers, like every other
-- app.* function in this feature.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.claim_billing_receipt(uuid)',
    'app.release_billing_receipt(uuid, text)',
    'app.claim_billing_failure_notice(uuid)',
    'app.billing_receipts_due(integer)',
    'app.billing_failure_notices_due(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $do$;
