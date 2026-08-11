-- 0422_refunds_and_write_offs.sql
-- Two ways a balance goes to zero that the statement could not express.
--
-- Both were found by walking the standard financial-control checklist rather than by
-- reasoning about the model, and both matter for exactly the reason the statement exists:
-- a balance that cannot be cleared correctly stays on the page for ever and the customer
-- stops trusting the page.
--
-- ── 1. A REFUND ──────────────────────────────────────────────────────────────
--
-- A credit note reduces what a customer OWES. But if they had already paid, reducing what
-- they owe leaves them in CREDIT — and the money still has to physically go back. There
-- was no way to record it leaving. The statement would show a credit balance indefinitely
-- for a customer who was refunded in full a year ago.
--
-- A refund is a payment in the opposite direction, so it is a `partner_payments` row with
-- a negative amount rather than a fifth document kind. That keeps the running balance
-- arithmetic exactly as it is (`balance += debit - credit`), and it keeps one answer to
-- "what money moved on this account".
--
-- ── 2. A WRITE-OFF ───────────────────────────────────────────────────────────
--
-- The customer is never going to pay. Today the only ways to clear it are to pretend they
-- paid (a payment that never happened — a lie in the books) or to void the invoice (which
-- says it should never have been issued — also untrue; the work was done). Both corrupt
-- the record, and leaving it corrupts the ageing instead: R40 000 sitting in "60+ days
-- late" for ever, dragging every total that reads from it.
--
-- So it gets its own status. The invoice stays, at its full value, marked for what it is.

-- ── Refunds ──────────────────────────────────────────────────────────────────
alter table partner_payments
  add column is_refund boolean not null default false;

comment on column partner_payments.is_refund is
  'Money going back to the customer rather than coming in. Stored as a NEGATIVE '
  'amount_cents so the statement''s running balance needs no special case.';

-- A refund is negative, a payment is positive, and neither is zero. Stated as a
-- constraint so no code path can write a payment whose sign disagrees with its flag.
alter table partner_payments
  add constraint partner_payments_sign_ck check (
    (is_refund and amount_cents < 0) or (not is_refund and amount_cents > 0)
  );

-- ── Write-offs ───────────────────────────────────────────────────────────────
alter type partner_doc_status add value if not exists 'written_off';
