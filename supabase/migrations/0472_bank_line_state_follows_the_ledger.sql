-- 0472_bank_line_state_follows_the_ledger.sql
-- G15c — A bank line's state is DERIVED, never typed.
--
-- The obvious way to build this is to have the confirm action write two things: the payment
-- row, and `bank_lines.status = 'matched'` alongside it. That is wrong in a way that only
-- shows up later, and shows up as a partner not believing the screen.
--
-- Everything the settlement rows do afterwards happens somewhere else. A payment gets soft
-- deleted from the document page because it was captured against the wrong invoice. An
-- expense's `paid_on` is cleared because the debit order bounced. A whole invoice is
-- deleted. None of those code paths know that a bank line exists, and none of them should
-- have to — the day someone adds a third way to reverse a payment, they will not remember
-- this table either. If `status` were typed at confirm time, each of those leaves a bank
-- line still saying "matched, done" while the thing it matched has gone, and the
-- reconciliation screen quietly stops listing money that is once again unaccounted for.
-- That is the exact failure the feature exists to prevent, reintroduced by the fix.
--
-- So `status` and the `matched_*` columns are a ROLLUP, on the same principle as
-- `partner_documents.amount_paid_cents` (0381) and `stock_items.on_hand` (0450): one
-- function recomputes them from whatever is actually true right now, and every path that
-- can change what is true calls it. The confirm action writes to the ledger and nothing
-- else — which also means it cannot get the two writes half done.

-- ── Recompute one line from the rows that settle it ──────────────────────────
-- Deliberately reads BOTH sides even though `bank_lines_one_settlement_ck` (0470) forbids
-- a line carrying both. Reading only the side the caller came from would leave the other
-- side's stale id in place when a line moved between them.
create or replace function app.bank_line_resync(p_line uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay record;
  v_exp record;
begin
  if p_line is null then return; end if;

  select p.id, p.document_id into v_pay
    from partner_payments p
   where p.bank_line_id = p_line and p.deleted_at is null
   limit 1;

  -- An expense only counts as settled while it is actually marked paid. Clearing `paid_on`
  -- — a bounced debit order, a payment reversed by the bank — is a real thing a partner
  -- does, and it has to put the bank line back on the unreconciled list.
  select e.id into v_exp
    from partner_expenses e
   where e.bank_line_id = p_line and e.deleted_at is null and e.paid_on is not null
   limit 1;

  update bank_lines l
     set matched_payment_id  = v_pay.id,
         matched_document_id = v_pay.document_id,
         matched_expense_id  = v_exp.id,
         -- When it was FIRST settled. Kept across an unrelated re-sync so the screen can
         -- honestly say "matched on the 3rd" rather than "matched a moment ago" every time
         -- something incidental touches the row.
         matched_at = case
           when v_pay.id is null and v_exp.id is null then null
           else coalesce(l.matched_at, now())
         end,
         status = case
           when v_pay.id is not null or v_exp.id is not null then 'matched'::bank_line_status
           -- A line the partner had explicitly set aside stays set aside. Only a line that
           -- was matched falls back to needing attention.
           when l.status = 'ignored' then 'ignored'::bank_line_status
           else 'unmatched'::bank_line_status
         end,
         updated_at = now()
   where l.id = p_line;
end $$;

-- Not a caller-facing RPC. Nobody should be able to ask the database to restate a bank
-- line's status directly — the only honest way to change it is to change what settles it.
revoke execute on function app.bank_line_resync(uuid) from public, anon, authenticated;
grant  execute on function app.bank_line_resync(uuid) to service_role;

-- ── Every path that can change the answer ────────────────────────────────────
-- `old` and `new` are both re-synced, because moving a settlement from one line to another
-- changes two lines and only re-syncing the destination would leave the source claiming a
-- payment it no longer has.
create or replace function app_bank_line_resync_tg() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' and old.bank_line_id is not null then
    perform app.bank_line_resync(old.bank_line_id);
  end if;
  if tg_op <> 'DELETE' and new.bank_line_id is not null then
    perform app.bank_line_resync(new.bank_line_id);
  end if;
  return null;
end $$;

-- AFTER, and statement-agnostic: the rollup must read the row as it finally landed,
-- including whatever the 0381 payment rollup and the 0430 constraints made of it.
create trigger partner_payments_bank_resync
  after insert or update or delete on partner_payments
  for each row execute function app_bank_line_resync_tg();

create trigger partner_expenses_bank_resync
  after insert or update or delete on partner_expenses
  for each row execute function app_bank_line_resync_tg();

revoke execute on function app_bank_line_resync_tg() from anon, authenticated, public;
