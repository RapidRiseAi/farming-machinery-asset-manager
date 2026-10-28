-- Payments made outside the app: EFT, cash, other (founder decision 4 of 26 October 2026:
-- "allowed, including invoiced payments outside the app"; access starts only once payment
-- has been received).
--
-- Until now the ledger had exactly one writer of money in, app.settle_billing_attempt,
-- reached only from a VERIFIED Paystack answer, so a farm that paid by EFT could not be
-- recorded as paid at all, could not be activated, and once the seven days' grace landed
-- (20261029090100) would be suspended while its money sat in the bank.
--
-- Rapid Rise records such a payment by hand, with every guard a person needs:
--   * only a named Rapid Rise admin (p_by, checked here: the wrapper is service role only,
--     the rr_admin check lives in the action, the discount setter's reasoning);
--   * against an OPEN invoice, for no more than is outstanding, never while a card attempt
--     is pending or unknown on it (the customer may be paying twice);
--   * keyed by the bank reference (provider 'manual', reference 'MAN-<normalised>'), so the
--     existing billing_payments_ref_uq refuses the same transfer recorded twice;
--   * with the proof of payment stored (a private, service-only bucket) and who recorded it.
-- When the invoice is then paid in full, app.billing_restore_after_payment runs, exactly as
-- after a card payment: a pending sign-up becomes active, a suspended farm resumes.
--
-- A bounced or mistaken one is REVERSED by withdrawing that row (deleted_at, with who and
-- why), not by a negative row: a negative row is how a REFUND is written, and the
-- suspension test deliberately ignores refunded invoices, so a bounced EFT written that way
-- would never suspend the farm again. Withdrawn, the invoice simply reopens (the rollup
-- trigger sums live rows) and the grace runs from its due date as before.

alter table public.billing_payments
  add column if not exists recorded_by uuid references public.users(id),
  add column if not exists method text,
  add column if not exists received_on date,
  add column if not exists proof_path text,
  add column if not exists reversal_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_payments_method_ck') then
    alter table public.billing_payments
      add constraint billing_payments_method_ck check (method is null or method in ('card', 'eft', 'cash', 'other'));
  end if;
end
$$;
comment on column public.billing_payments.recorded_by is
  'The Rapid Rise admin who recorded a payment made outside the app (provider manual).';
comment on column public.billing_payments.proof_path is
  'Where the proof of a manual payment is kept (bucket billing-proofs, service role only).';

-- The proofs: bank confirmations and slips. Private, and no policy for signed-in users at
-- all, so only the service role (behind the rr_admin action) reads or writes them.
do $storage$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('billing-proofs', 'billing-proofs', false, 10485760, array['image/*', 'application/pdf'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$storage$;

create or replace function app.billing_record_manual_payment(
  p_invoice uuid,
  p_amount_cents bigint,
  p_method text,
  p_bank_reference text,
  p_received_on date,
  p_note text,
  p_proof_path text,
  p_by uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  i public.billing_invoices%rowtype;
  v_ref text;
  v_id uuid;
  v_outstanding bigint;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin' and u.active) then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_method is null or p_method not in ('eft', 'cash', 'other') then
    raise exception 'BILLING: choose how it was paid' using errcode = '22023';
  end if;
  v_ref := upper(regexp_replace(coalesce(p_bank_reference, ''), '\s+', '', 'g'));
  if v_ref = '' or length(v_ref) > 80 then
    raise exception 'BILLING: the bank reference is needed' using errcode = '22023';
  end if;
  if p_received_on is null or p_received_on > current_date or p_received_on < current_date - 366 then
    raise exception 'BILLING: the date received must be within the last year' using errcode = '22023';
  end if;
  if p_proof_path is null or btrim(p_proof_path) = '' then
    raise exception 'BILLING: attach the proof of payment' using errcode = '22023';
  end if;

  select * into i from public.billing_invoices where id = p_invoice and deleted_at is null for update;
  if not found then raise exception 'BILLING: no such invoice' using errcode = '22023'; end if;
  if i.status <> 'open' then
    raise exception 'BILLING: only an open invoice can be paid' using errcode = '22023';
  end if;
  v_outstanding := i.total_incl_cents - i.amount_paid_cents;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > v_outstanding then
    raise exception 'BILLING: the amount must be more than nothing and no more than is owed' using errcode = '22023';
  end if;
  if exists (select 1 from public.billing_payment_attempts a
              where a.invoice_id = i.id and a.status in ('pending', 'unknown')) then
    raise exception 'BILLING: a card payment is still in flight on this invoice' using errcode = '22023';
  end if;

  begin
    insert into public.billing_payments (
      farm_id, invoice_id, amount_incl_cents, currency, paid_at,
      provider, provider_reference, channel, note,
      recorded_by, method, received_on, proof_path
    ) values (
      i.farm_id, i.id, p_amount_cents, 'ZAR', p_received_on::timestamptz,
      'manual', 'MAN-' || v_ref, p_method, left(nullif(btrim(coalesce(p_note, '')), ''), 500),
      p_by, p_method, p_received_on, p_proof_path
    ) returning id into v_id;
  exception when unique_violation then
    raise exception 'BILLING: that bank reference is already recorded' using errcode = '23505';
  end;

  -- Paid in full now (the rollup trigger has run): the same step a card payment takes.
  if i.subscription_id is not null
     and (select status from public.billing_invoices where id = i.id) = 'paid' then
    perform app.billing_restore_after_payment(i.subscription_id);
  end if;
  return v_id;
end;
$fn$;
revoke execute on function app.billing_record_manual_payment(uuid, bigint, text, text, date, text, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function app.billing_reverse_manual_payment(p_payment uuid, p_reason text, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare p public.billing_payments%rowtype;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin' and u.active) then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'BILLING: say why the payment is reversed' using errcode = '22023';
  end if;
  select * into p from public.billing_payments where id = p_payment for update;
  if not found or p.provider <> 'manual' or p.amount_incl_cents <= 0 then
    raise exception 'BILLING: only a payment recorded by hand can be reversed here' using errcode = '22023';
  end if;
  if p.deleted_at is not null then
    raise exception 'BILLING: that payment is already reversed' using errcode = '22023';
  end if;
  update public.billing_payments
     set deleted_at = now(), deleted_by = p_by, reversal_reason = left(btrim(p_reason), 500)
   where id = p_payment;
end;
$fn$;
revoke execute on function app.billing_reverse_manual_payment(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- The wrappers, service role only (the rr_admin check is in the action; p_by is checked here).
create or replace function public.billing_record_manual_payment(
  p_invoice uuid, p_amount_cents bigint, p_method text, p_bank_reference text,
  p_received_on date, p_note text, p_proof_path text, p_by uuid
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_record_manual_payment(p_invoice, p_amount_cents, p_method, p_bank_reference,
                                           p_received_on, p_note, p_proof_path, p_by);
$$;
revoke execute on function public.billing_record_manual_payment(uuid, bigint, text, text, date, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.billing_record_manual_payment(uuid, bigint, text, text, date, text, text, uuid)
  to service_role;

create or replace function public.billing_reverse_manual_payment(p_payment uuid, p_reason text, p_by uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_reverse_manual_payment(p_payment, p_reason, p_by);
$$;
revoke execute on function public.billing_reverse_manual_payment(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.billing_reverse_manual_payment(uuid, text, uuid) to service_role;
