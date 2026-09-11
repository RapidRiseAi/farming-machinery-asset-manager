-- 20260911160000_billing_pending_dunning_and_freeze.sql
-- Three from the audit, and the first one is the worst thing found in this billing system.
--
-- S10 — A DECLINED FIRST PAYMENT OPENED THE FARM
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.billing_register_failure` moves a subscription to 'past_due' on any failure. For a
-- farm that has been paying, that is the dunning ladder working exactly as designed.
--
-- For a PENDING sign-up it was a door. `app.farm_billing_gate` (20260911100000) reads
-- 'pending' as "not paid, keep them out" and anything else as "let them in" — so the
-- moment a new customer's first card was declined, `register_failure` moved them to
-- 'past_due' and the gate opened the farm.
--
-- Fail the payment, get the product. It was latent until self-serve sign-up shipped, and
-- it shipped in the same week.
--
-- A pending sign-up has nothing to dun: no access, nothing owed yet, and an invoice that
-- simply stays open until somebody pays it. The failure is still RECORDED, because the
-- count and the reason are evidence worth having when they ring — but the status does not
-- move, so the gate keeps its answer.
--
-- S9 — THE SNAPSHOTS WERE DOCUMENTED AS FROZEN AND WERE NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- `billing_invoices.seller_snapshot` and `bill_to_snapshot` exist so that a copy of an
-- invoice reprinted next year shows the company and the customer AS THEY WERE — that is
-- the whole reason they are snapshots rather than joins. The freeze trigger protected
-- every figure on the invoice and neither snapshot, so the names, registration numbers and
-- addresses on an issued document were quietly editable.
--
-- Freezing what a thing cost while leaving who it was for editable is the half of a frozen
-- document a tax authority would care about most.
--
-- S12 — A DRAFT INVOICE COULD BE MARKED PAID WHILE IT WAS STILL BEING WRITTEN
-- ─────────────────────────────────────────────────────────────────────────────
-- The audit reported this as "a zero-total invoice can never reach paid", and half of that
-- is true: the rollup required `v_total > 0`. But it is not reachable by the route it
-- implies — `billing_payments_nonzero_ck` forbids a zero payment, so the rollup never runs
-- on such an invoice at all, and nothing the CASE said could have changed that. The real
-- guard against a zero-total invoice is the generator, which refuses to bill a farm with
-- nothing to bill (asserted in section (i)). The `v_paid >= v_total` here is defensive
-- tidiness, not a fix.
--
-- What WAS reachable is the ordering. `v_total > 0 and v_paid >= v_total` was tested BEFORE
-- `status = 'draft'`, so a DRAFT invoice carrying a payment flipped to 'paid' while it was
-- still being assembled. A draft is nobody's bill yet; the generator writes its lines onto
-- one and issues it in the same transaction, and a draft that briefly totals its payments
-- is unfinished, not settled.
--
-- Suite section (z) covers all three, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- S10 — a failed first payment leaves a sign-up exactly where it was
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.billing_register_failure(p_sub uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v public.billing_settings%rowtype;
        v_n integer; v_offset integer;
begin
  select * into v from public.billing_settings where singleton;
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  v_n := s.failed_attempt_count + 1;

  -- S10, and it got considerably worse when `pending` arrived.
  --
  -- This function moves a subscription to 'past_due' on any failure. For a farm that has
  -- been paying, that is the ladder working. For a PENDING sign-up — one whose very first
  -- payment just failed — it moved them out of 'pending', and `app.farm_billing_gate` reads
  -- anything other than 'pending' as "let them in".
  --
  -- So a DECLINED card opened the farm. Not a subtle one: fail the payment, get the
  -- product.
  --
  -- A pending sign-up has nothing to dun. They have no access, they owe nothing yet, and
  -- their invoice simply stays open until they pay it. The failure is still recorded —
  -- the count and the reason are evidence, and "their card was declined four times" is
  -- worth knowing when they ring — but the status does not move.
  if s.status = 'pending' then
    update public.billing_subscriptions
       set failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           updated_at = now()
     where id = p_sub;
    return;
  end if;

  if v_n <= array_length(v.retry_offsets_days, 1) then
    v_offset := v.retry_offsets_days[v_n];
    update public.billing_subscriptions
       set status = 'past_due',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = current_date + v_offset,
           grace_ends_on = null,
           updated_at = now()
     where id = p_sub;
  else
    -- Retries exhausted. Access continues for the grace period — and, since 20260910160000,
    -- so does asking. The card is presented again every `grace_retry_days`, because the
    -- commonest reason one fails here is that the money arrives next week.
    --
    -- `grace_ends_on` is still coalesced, so a farm that fails three grace retries does not
    -- earn itself three extra weeks: the downgrade lands on the day grace began + grace_days.
    update public.billing_subscriptions
       set status = 'grace',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = case when v.grace_retry_days > 0
                                then current_date + v.grace_retry_days
                                else null end,
           grace_ends_on = coalesce(grace_ends_on, current_date + v.grace_days),
           updated_at = now()
     where id = p_sub;
  end if;
end $$;

revoke execute on function app.billing_register_failure(uuid, text) from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- S9 — who an invoice was from and for is part of what is frozen
-- ══════════════════════════════════════════════════════════════════════════════
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
     or new.currency              is distinct from old.currency
     -- S9. Both snapshots are documented as frozen — a copy of an invoice reprinted next
     -- year must show the company and the customer as they were — and neither was in this
     -- list, so both were quietly editable on an issued invoice. Freezing the figures
     -- while leaving the NAMES and ADDRESSES on them editable is the half of a frozen
     -- document that a tax authority would care about most.
     or new.seller_snapshot       is distinct from old.seller_snapshot
     or new.bill_to_snapshot      is distinct from old.bill_to_snapshot then
    raise exception
      'BILLING: invoice % is issued; its pricing snapshot is immutable (status/payment/void may still change)',
      old.invoice_ref using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

revoke execute on function app.billing_freeze_invoice() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- S12 — nothing to collect is a settled invoice
-- ══════════════════════════════════════════════════════════════════════════════
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
                    -- A draft is still being assembled and is nobody's bill yet. Tested
                    -- FIRST, because the generator writes lines onto a draft and a draft
                    -- that briefly totals its payments is not paid, it is unfinished.
                    when status = 'draft' then 'draft'::billing_invoice_status
                    -- S12: this used to read `v_total > 0 and v_paid >= v_total`, so an
                    -- invoice for nothing could never reach 'paid'. It sat open for ever,
                    -- kept appearing as something owed, and no payment could ever close it
                    -- because Paystack will not process a zero charge. Nothing to collect
                    -- is a settled invoice, not an outstanding one.
                    when v_paid >= v_total then 'paid'::billing_invoice_status
                    else 'open'::billing_invoice_status
                  end,
         updated_at = now()
   where id = v_invoice;

  return coalesce(new, old);
end $$;

revoke execute on function app.billing_rollup_invoice_payments() from public, anon, authenticated;
