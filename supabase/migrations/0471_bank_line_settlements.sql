-- 0471_bank_line_settlements.sql
-- G15b — Which bank line settled which thing, said once.
--
-- The confirm button on the reconciliation screen does one of exactly two things: it
-- inserts a `partner_payments` row (money in — and the 0381 rollup trigger then moves the
-- invoice's paid amount and status, which is the whole point of using the existing table
-- rather than writing a total ourselves), or it stamps `partner_expenses.paid_on` (money
-- out). Both of those tables already exist, already have their RLS, their audit trigger and
-- their rollups. Nothing about them changes here except that they gain a back-reference to
-- the bank line that caused the write.
--
-- WHY THE BACK-REFERENCE IS A COLUMN AND NOT A NOTE. Two things need it:
--
--   1. Pressing confirm twice must not take the money twice. This is not a hypothetical:
--      a server action on a phone with a bad signal is exactly the thing people press
--      again, and the second press arrives while the first is still in flight. An
--      application-level "have I already done this?" check cannot decide it — both requests
--      read the same empty answer before either writes. A UNIQUE INDEX can, and does: the
--      second insert fails with 23505 and the action reports it as "already recorded"
--      rather than as an error, because from the partner's point of view it is not one.
--
--   2. Undoing. A partner who confirms the wrong match needs to take it back, and taking
--      it back means finding the exact payment row that confirmation created. Without the
--      link that is a guess based on amount and date, which is precisely the guess that put
--      the wrong match there in the first place.
--
-- The index is PARTIAL on two counts, and both are load-bearing:
--
--   * `bank_line_id is not null`, because the vast majority of payments and expenses have
--     nothing to do with a bank import — one recorded by hand, one captured off a till slip
--     — and they must all be free to carry null.
--   * `deleted_at is null`, because undoing a match SOFT deletes the payment (the audit
--     trail keeps that it was once recorded and then reversed). Without this clause the
--     reversed row would keep the bank line's slot reserved for ever, and a partner who
--     undid a match to fix a date could never confirm that line again. What must be refused
--     is a second LIVE settlement, not the memory of a withdrawn one.

-- ── Money in: the payment a bank line created ────────────────────────────────
alter table partner_payments
  add column bank_line_id uuid references bank_lines(id) on delete set null;

comment on column partner_payments.bank_line_id is
  'The imported bank line this payment was confirmed from (G15), or null when it was '
  'recorded by hand. Unique, so confirming the same line twice cannot bank the money twice.';

create unique index partner_payments_bank_line_uq
  on partner_payments(bank_line_id) where bank_line_id is not null and deleted_at is null;

-- ── Money out: the supplier bill a bank line settled ─────────────────────────
alter table partner_expenses
  add column bank_line_id uuid references bank_lines(id) on delete set null;

comment on column partner_expenses.bank_line_id is
  'The imported bank line that paid this supplier invoice (G15), or null when paid_on was '
  'set by hand. Unique, so one payment out of the bank cannot be claimed by two bills.';

create unique index partner_expenses_bank_line_uq
  on partner_expenses(bank_line_id) where bank_line_id is not null and deleted_at is null;

-- ══════════════════════════════════════════════════════════════════════════════
-- A settlement has to make sense: same workshop, right direction
-- ══════════════════════════════════════════════════════════════════════════════
-- RLS already makes the cross-workshop case unreachable through the app — `bank_lines` is
-- scoped to the caller's own workshop and `partner_payments` to documents their workshop
-- issued — so this trigger is not the tenancy guarantor and is not pretending to be. It is
-- here because a settlement pointing at another business's bank account would be silent,
-- permanent, and invisible in every total it corrupts; the cost of refusing it outright is
-- one lookup per confirmation.
--
-- The direction check is the one that will actually fire in practice. A money-OUT line
-- (negative) confirmed against an INVOICE would record a customer receipt for money that
-- left the account, and the 0381 rollup would dutifully mark the invoice paid. Refusing it
-- at the table means no future caller — a bulk "match everything obvious" action, an import
-- from another system — can introduce it by accident.
create or replace function app_bank_settlement_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_line   record;
  v_target uuid;
begin
  if new.bank_line_id is null then
    return new;
  end if;

  select workshop_id, amount_cents into v_line from bank_lines where id = new.bank_line_id;
  if v_line is null then
    raise exception 'bank line % does not exist', new.bank_line_id;
  end if;

  if tg_table_name = 'partner_payments' then
    select workshop_id into v_target from partner_documents where id = new.document_id;
    if v_target is distinct from v_line.workshop_id then
      raise exception 'a bank line may only settle a document its own workshop issued';
    end if;
    -- A receipt comes from money arriving. Refunds (0422) are negative payments and are
    -- deliberately allowed to come from a negative line — money genuinely going back out.
    if not new.is_refund and v_line.amount_cents <= 0 then
      raise exception 'money leaving the bank cannot be a customer receipt';
    end if;
    if new.is_refund and v_line.amount_cents >= 0 then
      raise exception 'a refund must come from money leaving the bank';
    end if;
  else
    if new.workshop_id is distinct from v_line.workshop_id then
      raise exception 'a bank line may only settle its own workshop''s expenses';
    end if;
    if v_line.amount_cents >= 0 then
      raise exception 'money arriving cannot have paid a supplier';
    end if;
  end if;

  return new;
end $$;

create trigger partner_payments_bank_guard
  before insert or update of bank_line_id on partner_payments
  for each row execute function app_bank_settlement_guard();

create trigger partner_expenses_bank_guard
  before insert or update of bank_line_id on partner_expenses
  for each row execute function app_bank_settlement_guard();

-- Trigger-only, so it stays off the PostgREST RPC surface (the 0205/0211/0311 pattern).
revoke execute on function app_bank_settlement_guard() from anon, authenticated, public;
