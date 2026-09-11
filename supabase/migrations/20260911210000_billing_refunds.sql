-- 20260911210000_billing_refunds.sql
-- Money we gave back was not written down anywhere.
--
-- WHAT HAPPENED BEFORE
-- ─────────────────────────────────────────────────────────────────────────────
-- `refund.processed` arrived from Paystack, was recorded as a webhook EVENT, raised an
-- alert to Rapid Rise, and changed nothing else. So the money left our account and the
-- ledger still said the invoice was paid in full. Every figure downstream — what a farm has
-- paid us, what the month collected, the reconciliation against Paystack — was wrong by the
-- amount of every refund ever issued.
--
-- THE TRAP THIS HAD TO AVOID, AND IT IS A BAD ONE
-- ─────────────────────────────────────────────────────────────────────────────
-- `billing_payments` already permits a negative row (`nonzero_ck` forbids zero, not minus),
-- and `app.billing_rollup_invoice_payments` already sums them — so simply inserting the
-- refund makes `amount_paid_cents` fall and the invoice flip from 'paid' back to 'open'.
--
-- Which is correct, and which would have put it straight back on the nightly charging
-- shortlist. Refund a customer at nine in the morning and charge them again at 03:20 the
-- next day, automatically, for the same invoice. That is the single worst thing this
-- system could do to somebody, and it is what "just record the negative" buys on its own.
--
-- So the two halves ship together: the ledger tells the truth, AND both charging shortlists
-- refuse an invoice that carries a refund. Not a flag on the invoice — a refund IS a row in
-- the payments ledger, and deriving the exclusion from that row keeps one source of truth,
-- which is the same reason `status` is a rollup and never typed.
--
-- WHAT IS DELIBERATELY NOT AUTOMATIC
-- ─────────────────────────────────────────────────────────────────────────────
-- The SUBSCRIPTION. Founder decision of 11 September, written up in `docs/BILLING.md` §11b:
-- a refund the customer asked for ends the plan immediately, a refund we issue because
-- something broke leaves them on it. A webhook cannot tell those apart — Paystack says an
-- amount moved and nothing about why — so nothing here touches the subscription, the plan,
-- or the dunning state. The alert to Rapid Rise already exists and remains how a human is
-- brought in.
--
-- RECORDED EVEN WHEN IT LOOKS WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- A refund larger than the payments we hold against that invoice is recorded, not refused.
-- Paystack cannot refund more than was charged, so that case means OUR records are missing
-- a payment — and a ledger that quietly drops the evidence of its own gap is worse than one
-- that shows an impossible number somebody has to explain. The outcome word says so, and
-- the shortlist exclusion means the odd state is inert rather than dangerous.

begin;

-- ── Recording it ─────────────────────────────────────────────────────────────
-- Idempotent on the REFUND's own Paystack reference via `billing_payments_ref_uq`, so a
-- redelivered webhook — and Paystack retries for 72 hours — cannot record it twice. The
-- unique index does that work, not a check somebody could forget, which is the same
-- discipline `billing_payment_attempts_inflight_uq` uses to stop a double charge.
create or replace function app.billing_record_refund(
  p_txn_reference   text,
  p_refund_reference text,
  p_amount_cents    bigint,
  p_at              timestamptz default now()
) returns text
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  a public.billing_payment_attempts%rowtype;
  v_paid bigint;
  v_exceeds boolean := false;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    -- The CALLER passes a positive amount and this function makes it negative. Taking a
    -- signed value would make "refund minus five hundred" mean two opposite things
    -- depending on who wrote the call site.
    return 'bad-amount';
  end if;
  if p_refund_reference is null or btrim(p_refund_reference) = '' then
    -- Without it there is no idempotency key, and a retried delivery would double-count.
    return 'no-refund-reference';
  end if;

  select * into a from public.billing_payment_attempts
   where attempt_ref = p_txn_reference
   order by created_at desc
   limit 1;
  if not found then
    return 'no-attempt';
  end if;

  select coalesce(sum(amount_incl_cents), 0) into v_paid
    from public.billing_payments
   where invoice_id = a.invoice_id and deleted_at is null;
  if p_amount_cents > v_paid then
    v_exceeds := true;
  end if;

  begin
    insert into public.billing_payments (
      farm_id, invoice_id, attempt_id, amount_incl_cents, currency, paid_at,
      provider, provider_reference, channel, note
    ) values (
      a.farm_id, a.invoice_id, a.id, -p_amount_cents, 'ZAR', coalesce(p_at, now()),
      'paystack', p_refund_reference, 'refund',
      'Refund recorded from a Paystack refund.processed event.'
    );
  exception when unique_violation then
    -- `billing_payments_ref_uq`. Paystack retries for 72 hours; this is the ordinary case
    -- of the same refund arriving twice, not an error.
    return 'duplicate';
  end;

  return case when v_exceeds then 'recorded-exceeds-payments' else 'recorded' end;
end;
$fn$;

-- The ENGINE grants to nobody. Everything reaches it through the public wrapper below,
-- which is SECURITY DEFINER — that is the rule suite section (j) enforces, and granting
-- the engine directly to service_role fires it by name.
revoke execute on function app.billing_record_refund(text, text, bigint, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.billing_record_refund(
  p_txn_reference   text,
  p_refund_reference text,
  p_amount_cents    bigint,
  p_at              timestamptz default now()
) returns text
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_record_refund(p_txn_reference, p_refund_reference, p_amount_cents, p_at);
$$;
revoke execute on function public.billing_record_refund(text, text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.billing_record_refund(text, text, bigint, timestamptz)
  to service_role;

-- ── Never charge a refunded invoice again ────────────────────────────────────
-- Both shortlists, because there are two: the nightly one and the manual "Try again". A
-- guard on one of them is not a guard.
-- The DEFAULT is part of the existing signature: dropping it in a `create or replace`
-- fails outright with "cannot remove parameter defaults from existing function", which is
-- Postgres refusing to let a caller that relies on it silently break.
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
    -- S7. A deleted farm is never charged, full stop. A CANCELLED one is not charged
    -- either: cancelling is our own act, and taking money afterwards reads as a mistake
    -- however correct the underlying debt is. A SUSPENDED farm still is — suspension
    -- withholds the service, it does not forgive what is already invoiced.
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and coalesce(i.due_on, i.issued_on, current_date) <= current_date
     -- GRACE IS NOW RETRIED (founder decision, 2026-09-10). Until this, exhausting the
     -- retry ladder set status='grace' with next_retry_on = null, and 'grace' was not in
     -- this list at all — so the stored card was never presented again by anything, and a
     -- farm whose money simply arrived late was downgraded without ever being asked twice.
     --
     -- The two arms are not the same test. For a live subscription a NULL retry date means
     -- "no reason to wait". In grace it means the weekly retry is switched OFF
     -- (grace_retry_days = 0), which must never read as "charge immediately".
     and (
       (s.status in ('active', 'past_due')
          and coalesce(s.next_retry_on, current_date) <= current_date)
       or
       (s.status = 'grace'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
     )
     -- Nothing in flight. A row in `unknown` deliberately blocks this farm entirely
     -- until somebody has reconciled it.
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     -- REFUNDED (20260911210000). A refund makes this invoice unpaid again, which is true
     -- and which would otherwise put it straight back here. Charging somebody the morning
     -- after refunding them is not a recovery, it is the worst thing this system could do.
     -- A human decides what happens next; see docs/BILLING.md §11b.
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;

revoke execute on function app.due_billing_charges(integer)
  from public, anon, authenticated, service_role;

create or replace function app.invoice_chargeable_now(p_invoice uuid)
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
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.id = p_invoice
     and i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and s.status in ('active', 'past_due', 'grace', 'non_renewing', 'downgraded')
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     -- The same refund exclusion as the nightly list. The owner's "Try again" button must
     -- not be the way round it.
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     );
$$;

revoke execute on function app.invoice_chargeable_now(uuid)
  from public, anon, authenticated, service_role;

commit;
