-- 20260910200000_billing_vat_freeze_and_reversal.sql
-- Two ways this ledger mishandles money that has already moved.
--
-- S4 — REGISTERING FOR VAT BREAKS EVERY INVOICE RAISED BEFORE IT
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.billing_force_vat_rate` runs BEFORE INSERT OR UPDATE on billing_invoices. Its
-- second branch stamps the seller's VAT number onto any row that does not have one:
--
--     elsif new.seller_vat_number is null then
--       new.seller_vat_number := v_number;
--
-- On an INSERT that is right. On an UPDATE to an invoice raised BEFORE Rapid Rise
-- registered — every one of which has `seller_vat_number` null by design — it stamps a
-- field that the invoice's frozen pricing snapshot includes. `c_billing_invoices_freeze`
-- then sees `new.seller_vat_number is distinct from old.seller_vat_number` and raises.
--
-- The trigger names carry the ordering (`a_` guard, `b_` totals, `c_` freeze), so the
-- stamp always happens first and the freeze always sees it.
--
-- What that costs, concretely: `app.billing_rollup_invoice_payments` updates the invoice
-- when a payment is recorded. So the FIRST payment against any pre-registration invoice
-- after registering aborts — and it aborts the whole transaction, which is the one that
-- inserted the payment row and settled the attempt. Paystack has the money. FleetWise has
-- nothing, the attempt is still in flight, and (until the S6 fix landing alongside this)
-- nobody sees the error.
--
-- §(h2) already asserts that registering restates no historical invoice. It asserted the
-- VALUES and never that a subsequent write to such an invoice survives, which is the gap.
--
-- The fix says what was always meant: an issued invoice's VAT position is part of its
-- frozen snapshot, so the guard has nothing to do on an update to one. It deliberately
-- does NOT copy old values over new ones — an actual attempt to change the VAT fields on
-- an issued invoice must still reach the freeze and raise, because making tampering loud
-- is that trigger's whole job.
--
-- S — A REVERSAL IS NOT A DECLINE, AND MUST NOT DUN THE CUSTOMER
-- ─────────────────────────────────────────────────────────────────────────────
-- `mapStatus` in the Paystack adapter maps `reversed` to `failed`, deliberately: the money
-- came back, so the safe direction is "do not treat this invoice as paid". That part is
-- right and stays.
--
-- But `app.settle_billing_attempt` reads `failed` as "their card did not work" and calls
-- `app.billing_register_failure`, which starts the farm down the retry ladder towards a
-- downgrade. A reversal is usually OUR refund or a chargeback — the customer's card worked
-- perfectly. Dunning somebody because we sent their money back is both wrong and the kind
-- of thing that gets talked about.
--
-- So `settle_billing_attempt` gains `p_dun`. The invoice treatment is unchanged (unpaid is
-- unpaid); only the dunning ladder is suppressed. The old signature is DROPPED rather than
-- left beside the new one: `create or replace` will not replace a function with a
-- different argument list, and two overloads reachable over PostgREST — which resolves by
-- named arguments — is an ambiguity waiting to pick the wrong one.
--
-- Suite section (u) covers both, mutation-tested.


-- ══════════════════════════════════════════════════════════════════════════════
-- S4 — an issued invoice's VAT position is frozen, so the guard leaves it alone
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function app.billing_force_vat_rate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_registered boolean; v_number text;
begin
  -- An ISSUED invoice is a statement about a period that has been billed, and its VAT
  -- position is part of the snapshot `c_billing_invoices_freeze` protects. There is
  -- nothing here to decide, and stamping anything is what broke payments.
  --
  -- Note what this does NOT do: it does not copy `old` over `new`. A caller genuinely
  -- trying to change the VAT fields on an issued invoice still reaches the freeze and
  -- still raises, which is that trigger's entire purpose.
  if tg_op = 'UPDATE' and old.status is distinct from 'draft' then
    return new;
  end if;

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


-- ══════════════════════════════════════════════════════════════════════════════
-- A reversal settles the attempt without starting the dunning ladder
-- ══════════════════════════════════════════════════════════════════════════════
-- Dropped, not replaced: `create or replace` cannot change an argument list, and leaving
-- both overloads reachable over PostgREST — which resolves by NAMED arguments — is an
-- ambiguity that would eventually pick the wrong one.
drop function if exists public.billing_settle_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text);
drop function if exists app.settle_billing_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text);

create or replace function app.settle_billing_attempt(
  p_attempt          uuid,
  p_status           billing_attempt_status,
  p_transaction_id   bigint default null,
  p_provider_ref     text default null,
  p_gateway_response text default null,
  p_failure_reason   text default null,
  p_paid_cents       bigint default null,
  p_channel          text default null,
  -- False for a REVERSAL: the money came back, so the invoice is not paid, but the
  -- customer's card worked and they must not be walked towards a downgrade for it.
  p_dun              boolean default true
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.billing_payment_attempts%rowtype;
begin
  select * into a from public.billing_payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'BILLING: no such payment attempt %', p_attempt;
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
    -- `on conflict do nothing` on the transaction id is what makes a webhook and a
    -- verify call racing to record the same success harmless: whichever arrives second
    -- writes nothing, and the rollup trigger has already moved the invoice.
    insert into public.billing_payments (
      farm_id, invoice_id, attempt_id, amount_incl_cents,
      provider, provider_reference, provider_transaction_id, channel, paid_at
    ) values (
      a.farm_id, a.invoice_id, a.id, coalesce(p_paid_cents, a.amount_incl_cents),
      a.provider, coalesce(p_provider_ref, a.attempt_ref), p_transaction_id, p_channel, now()
    )
    on conflict do nothing;

    -- Payment clears the dunning state and, if they were downgraded, gives the plan back.
    if a.subscription_id is not null then
      perform app.billing_restore_after_payment(a.subscription_id);
    end if;

    update public.billing_payment_methods
       set last_used_at = now() where id = a.payment_method_id;

  elsif p_status = 'failed' and coalesce(p_dun, true) and a.subscription_id is not null then
    perform app.billing_register_failure(a.subscription_id, p_failure_reason);
  end if;
end $$;
revoke execute on function app.settle_billing_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text, boolean)
  from public, anon, authenticated;

create or replace function public.billing_settle_attempt(
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
language sql security definer set search_path = public, pg_temp as $$
  select app.settle_billing_attempt(p_attempt, p_status, p_transaction_id, p_provider_ref,
                                    p_gateway_response, p_failure_reason, p_paid_cents,
                                    p_channel, p_dun);
$$;
revoke execute on function public.billing_settle_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text, boolean)
  from public, anon, authenticated;
grant  execute on function public.billing_settle_attempt(
  uuid, billing_attempt_status, bigint, text, text, text, bigint, text, boolean)
  to service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- Somebody is told when money goes back, or is being taken back
-- ══════════════════════════════════════════════════════════════════════════════
-- A dispute and a refund were both `outcome: "ignored"`: recorded in
-- `billing_webhook_events` because every signed delivery is, and then nothing.
--
-- For a refund that means the ledger goes on saying an invoice is paid that has been
-- given back. For a DISPUTE it is worse: South Africa gives roughly 48 business hours to
-- respond before Paystack accepts it on our behalf and takes the money out of a payout.
-- A clock nobody can see is a clock that always runs out.
--
-- This does not decide what a refund does to the ledger or to the farm's plan — that is a
-- founder decision and it is not made here. It makes the event visible to the only people
-- who can act on it.
-- Shaped exactly like app.notify_farm (0261) — same columns, same channel, same queue —
-- because the same renderer and the same alert centre read both. The audience is the only
-- difference, and it is the point: a dispute or a refund is Rapid Rise's problem, not the
-- farmer's, so the row is farm-SCOPED (RLS, and the deep link) and rr_admin-ADDRESSED.
--
-- No quiet hours. A dispute has roughly 48 business hours on it and holding the alert
-- until 07:00 spends part of a clock that cannot be paused.
create or replace function app.notify_rr_billing(
  p_farm uuid, p_template text, p_payload jsonb
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sent integer;
begin
  if p_farm is null then
    return 0;   -- notifications.farm_id is NOT NULL; an event we cannot place is not an alert
  end if;

  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued'
  from public.users u
  where u.role = 'rr_admin' and u.active and u.deleted_at is null
    and coalesce(u.notify_inapp, true);

  get diagnostics v_sent = row_count;
  return v_sent;
end $$;
revoke execute on function app.notify_rr_billing(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.billing_notify_rr(
  p_farm uuid, p_template text, p_payload jsonb
) returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.notify_rr_billing(p_farm, p_template, p_payload);
$$;
revoke execute on function public.billing_notify_rr(uuid, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.billing_notify_rr(uuid, text, jsonb) to service_role;
