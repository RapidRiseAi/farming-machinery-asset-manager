-- 0435_payment_provider.sql
-- Where a payment came from, and why the same one cannot land twice.
--
-- A "pay now" link means a payment provider will call us back to say money arrived. Every
-- provider worth using RETRIES that callback — PayFast repeats an ITN until it gets a 200,
-- and will happily send the same one several times if the first response is slow. So the
-- single most important thing about accepting automated payments is not accepting the
-- same one twice.
--
-- The defence is a unique index rather than application logic, because application logic
-- loses a race: two retries arriving together both check "have I seen this?", both see no,
-- and both insert. A unique constraint is decided by the database and cannot be raced.

alter table partner_payments
  add column provider     text,   -- 'payfast', … ; null = recorded by hand
  add column provider_ref text;   -- the provider's own id for this transaction

comment on column partner_payments.provider_ref is
  'The payment provider''s own transaction id. Unique per provider: a retried or replayed '
  'callback cannot credit the same invoice twice.';

-- Partial, because a hand-recorded payment has neither field and there may be any number
-- of those. `nulls not distinct` is deliberately NOT used here: two manual payments must
-- both be allowed.
create unique index partner_payments_provider_ref_uq
  on partner_payments (provider, provider_ref)
  where provider is not null and provider_ref is not null;

-- A provider reference without a provider (or the other way round) is a half-recorded
-- payment, and half-recorded is how a reconciliation goes wrong six months later.
alter table partner_payments
  add constraint partner_payments_provider_ck check (
    (provider is null and provider_ref is null)
    or (provider is not null and provider_ref is not null)
  );
